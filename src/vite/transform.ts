import { MagicString, type SourceMap } from "magic-string";
import type {
  ArrayExpression,
  CallExpression,
  ImportDeclaration,
  ModuleExportName,
  PropertyKey as NodePropertyKey,
  VisitorObject,
} from "oxc-parser";

import type { StoreType } from "../registry.ts";
import type { Parser } from "./parser.ts";
import type { CreationSite } from "./runtime.ts";

export type TransformInput = {
  code: string;
  /** The module's own key, and the unit a hot reload clears. Never an absolute path. */
  moduleKey: string;
  home: string;
  maxStoresPerSite: number;
  parser: Parser;
};

export type StoreTransform =
  | { changed: true; code: string; map: SourceMap; warnings: readonly string[] }
  | { changed: false; warnings: readonly string[] };

const RUNTIME_MODULE = "nanostores-devtools/vite/runtime";
const SCOPE = "__nsdt";
const FACTORY = "__nsdtFileScope";

/** The calls that make a store, and the type each one gives. */
const CREATORS: ReadonlyMap<string, StoreType> = new Map<string, StoreType>([
  ["atom", "atom"],
  ["map", "map"],
  ["deepMap", "deepMap"],
  ["computed", "computed"],
  ["batched", "batched"],
]);

/**
 * A file that binds nothing from `"nanostores"` can make no store through callee matching, and
 * this is what keeps the commonest file in an app (a component that only reads stores) unparsed.
 */
const IMPORTS_NANOSTORES = /from\s*["']nanostores["']/;

/** A name frame carries what a store born under it is called; a function frame ends that reach. */
type Frame = { fn: boolean; name: string | null };

type Wrap = { start: number; end: number; site: CreationSite };

/** An object property, a class field and a method all name what sits under them the same way. */
type Keyed = { key: NodePropertyKey; computed: boolean };

export function transformStores(input: TransformInput): StoreTransform {
  const warnings = new Set<string>();

  if (!IMPORTS_NANOSTORES.test(input.code)) {
    return { changed: false, warnings: [] };
  }

  const parsed = input.parser.parseSync(input.moduleKey, input.code);

  if (parsed.errors.length > 0) {
    return { changed: false, warnings: [] };
  }

  const creators = new Map<string, StoreType>();
  const wraps: Wrap[] = [];
  const stack: Frame[] = [];
  /** An array has no key, so each element's name is worked out where the array itself is named. */
  const elementNames = new Map<number, string | null>();
  const open: number[] = [];
  const lines = lineStarts(input.code);

  function currentName(): string | null {
    const top = stack.at(-1);

    return top === undefined || top.fn ? null : top.name;
  }

  function currentFn(): string | null {
    return stack.findLast((frame) => frame.fn)?.name ?? null;
  }

  function pushName(name: string | null): void {
    stack.push({ fn: false, name });
  }

  function pushFn(name: string | null): void {
    stack.push({ fn: true, name: name ?? currentName() });
  }

  function pop(): void {
    stack.pop();
  }

  function nameAt(start: number): string | null {
    return elementNames.has(start) ? (elementNames.get(start) ?? null) : currentName();
  }

  function readImport(node: ImportDeclaration): void {
    if (node.source.value !== "nanostores" || node.importKind === "type") {
      return;
    }

    for (const specifier of node.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") {
        warnings.add(
          `"${input.moduleKey}" imports nanostores as a namespace, so its stores stay out of ` +
            `the panel. Import atom, map, deepMap, computed or batched by name instead.`,
        );
        continue;
      }

      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") {
        continue;
      }

      const type = CREATORS.get(exportName(specifier.imported));

      if (type !== undefined) {
        creators.set(specifier.local.name, type);
      }
    }
  }

  function readArray(node: ArrayExpression): void {
    const base = nameAt(node.start);

    node.elements.forEach((element, index) => {
      if (element !== null && element.type !== "SpreadElement") {
        elementNames.set(element.start, base === null ? null : `${base}[${index}]`);
      }
    });
  }

  function readCall(node: CallExpression): void {
    const type = node.callee.type === "Identifier" ? creators.get(node.callee.name) : undefined;

    /**
     * A store made inside an instrumented one is a temporary that the callback rebuilds on every
     * run, so it is the one thing callee matching finds and refuses.
     */
    if (type === undefined || open.length > 0) {
      return;
    }

    open.push(node.start);
    wraps.push({
      start: node.start,
      end: node.end,
      site: { name: nameAt(node.start), fn: currentFn(), line: lineOf(lines, node.start), type },
    });
  }

  /** Every import is a top-level statement, and reading them all first frees the walk of order. */
  for (const statement of parsed.program.body) {
    if (statement.type === "ImportDeclaration") {
      readImport(statement);
    }
  }

  function pushKey(node: Keyed): void {
    pushName(keyName(node.key, node.computed));
  }

  function pushDeclared(node: { id: { name: string } | null }): void {
    pushFn(node.id?.name ?? null);
  }

  new input.parser.Visitor({
    ArrayExpression: readArray,
    CallExpression: readCall,
    "CallExpression:exit"(node) {
      if (open.at(-1) === node.start) {
        open.pop();
      }
    },
    VariableDeclarator(node) {
      pushName(node.id.type === "Identifier" ? node.id.name : null);
    },
    "VariableDeclarator:exit": pop,
    Property: pushKey,
    "Property:exit": pop,
    PropertyDefinition: pushKey,
    "PropertyDefinition:exit": pop,
    MethodDefinition: pushKey,
    "MethodDefinition:exit": pop,
    FunctionDeclaration: pushDeclared,
    "FunctionDeclaration:exit": pop,
    FunctionExpression: pushDeclared,
    "FunctionExpression:exit": pop,
    ArrowFunctionExpression() {
      pushFn(null);
    },
    "ArrowFunctionExpression:exit": pop,
  } satisfies VisitorObject).visit(parsed.program);

  /**
   * A file that binds a creator is instrumented even when it makes no store today, because an
   * edit that took the last store out still has to clear what the run before it registered.
   */
  if (creators.size === 0) {
    return { changed: false, warnings: [...warnings] };
  }

  const edited = new MagicString(input.code);

  for (const wrap of wraps) {
    edited.prependRight(wrap.start, `${SCOPE}.store(`);
    edited.appendLeft(wrap.end, `, ${JSON.stringify(wrap.site)})`);
  }

  edited.prepend(header(input));

  return {
    changed: true,
    code: edited.toString(),
    map: edited.generateMap({ source: input.moduleKey, includeContent: true, hires: true }),
    warnings: [...warnings],
  };
}

/**
 * One line, so every original line keeps its place in the map. It sits at the top of the module
 * body rather than behind an HMR hook, because Vite runs `dispose` only for the module that
 * accepted the update, and a store file imported by an accepting module never sees it.
 */
function header(input: TransformInput): string {
  const args = [
    JSON.stringify(input.moduleKey),
    JSON.stringify(input.home),
    input.maxStoresPerSite,
  ].join(", ");

  return (
    `import { fileScope as ${FACTORY} } from ${JSON.stringify(RUNTIME_MODULE)}; ` +
    `const ${SCOPE} = ${FACTORY}(${args}); ${SCOPE}.clear(); ` +
    `if (import.meta.hot) import.meta.hot.prune(() => { ${SCOPE}.clear(); });\n`
  );
}

function exportName(name: ModuleExportName): string {
  return "name" in name ? name.name : String(name.value);
}

function keyName(key: NodePropertyKey, computed: boolean): string | null {
  if (computed) {
    return null;
  }

  if (key.type === "Identifier") {
    return key.name;
  }

  if (key.type === "PrivateIdentifier") {
    return `#${key.name}`;
  }

  return key.type === "Literal" ? String(key.value) : null;
}

function lineStarts(code: string): number[] {
  const starts = [0];
  let index = code.indexOf("\n");

  while (index !== -1) {
    starts.push(index + 1);
    index = code.indexOf("\n", index + 1);
  }

  return starts;
}

function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if ((starts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low + 1;
}
