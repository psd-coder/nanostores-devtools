import { MagicString, type SourceMap } from "magic-string";
import type {
  ArrayExpression,
  CallExpression,
  ImportDeclaration,
  ModuleExportName,
  PropertyKey as NodePropertyKey,
  Program,
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
  /** Whether the file is somebody else's. Handed in, because no path spelling settles it. */
  external: boolean;
  maxStoresPerSite: number;
  adoptFactories: boolean;
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

/**
 * A `$`-prefixed name bound to something, which is what adoption needs and the only reason to
 * parse a file that imports no creator. `=>` and `==` are left out, so an arrow parameter and a
 * comparison cost no parse. The colon is in, because a type annotation sits between the name
 * and the `=`.
 */
const BINDS_DOLLAR_NAME = /\$[\w$]*\s*(?::|=(?![=>]))/;

/** A name frame carries what a store born under it is called; a function frame ends that reach. */
type Frame = { fn: boolean; name: string | null };

/** One call the transform wraps, and the runtime function it hands the call to. */
type Injection = { start: number; end: number; call: "store" | "adopt"; site: CreationSite };

/** An object property, a class field and a method all name what sits under them the same way. */
type Keyed = { key: NodePropertyKey; computed: boolean };

/** A key that also holds a value, so the value's own offset can carry the key's name. */
type Valued = Keyed & { value: { start: number } | null };

/** One statement standing at the top level of a module body, taken off the program that holds it. */
type TopLevel = Program["body"][number];

export function transformStores(input: TransformInput): StoreTransform {
  const warnings = new Set<string>();

  if (!IMPORTS_NANOSTORES.test(input.code) && !mayAdopt(input)) {
    return { changed: false, warnings: [] };
  }

  const parsed = input.parser.parseSync(input.moduleKey, input.code);

  if (parsed.errors.length > 0) {
    return { changed: false, warnings: [] };
  }

  const creators = new Map<string, StoreType>();
  const wraps: Injection[] = [];
  const adopts: Injection[] = [];
  const stack: Frame[] = [];
  /**
   * Where a named binding's value starts, and the name it is bound to. An array element has no
   * key of its own, so it is named where the array itself is named.
   */
  const namedValues = new Map<number, string | null>();
  const open: number[] = [];
  const lines = lineStarts(input.code);
  /** The module's top-level bindings, in source order, for the scan the runtime walks at load. */
  const bound: string[] = [];

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
    return namedValues.has(start) ? (namedValues.get(start) ?? null) : currentName();
  }

  function readImport(node: ImportDeclaration): void {
    if (node.source.value !== "nanostores" || node.importKind === "type") {
      return;
    }

    for (const specifier of node.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") {
        warnings.add(
          `"${input.moduleKey}" imports nanostores as a namespace, so the plugin cannot tell ` +
            `what its stores are. Import atom, map, deepMap, computed or batched by name instead.`,
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
        namedValues.set(element.start, base === null ? null : `${base}[${index}]`);
      }
    });
  }

  function siteAt(start: number, name: string | null, type: StoreType): CreationSite {
    return { name, fn: currentFn(), line: lineOf(lines, start), type };
  }

  function readCall(node: CallExpression): void {
    /**
     * A store made inside an instrumented one is a temporary that the callback rebuilds on every
     * run, so it is the one thing callee matching finds and refuses, and adoption follows it.
     */
    if (open.length > 0) {
      return;
    }

    const type = node.callee.type === "Identifier" ? creators.get(node.callee.name) : undefined;

    if (type !== undefined) {
      open.push(node.start);
      wraps.push({
        start: node.start,
        end: node.end,
        call: "store",
        site: siteAt(node.start, nameAt(node.start), type),
      });

      return;
    }

    const name = namedValues.get(node.start);

    /**
     * Only a call bound straight to a name, so a call standing in an argument is left alone: the
     * name around it belongs to whatever the outer call returns.
     */
    if (input.adoptFactories && name !== undefined && name !== null && name.startsWith("$")) {
      adopts.push({
        start: node.start,
        end: node.end,
        call: "adopt",
        site: siteAt(node.start, name, "unknown"),
      });
    }
  }

  /**
   * A declaration standing in the module body, which is the only place a top-level binding is
   * made. An ambient one is skipped: `declare const $a: Atom` is a normal declarator in the AST
   * but binds nothing once the types are stripped, so listing it would throw a `ReferenceError`
   * and take the module down. A destructured binding needs no case of its own, because its `id`
   * is not an `Identifier`.
   */
  function readBindings(statement: TopLevel): void {
    const declared =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;

    if (declared?.type !== "VariableDeclaration" || declared.declare === true) {
      return;
    }

    for (const declarator of declared.declarations) {
      if (declarator.id.type === "Identifier") {
        bound.push(declarator.id.name);
      }
    }
  }

  /**
   * Every import is a top-level statement, and reading them all first frees the walk of order. The
   * module's own bindings come out of the same pass, because they stand at the same level.
   */
  for (const statement of parsed.program.body) {
    if (statement.type === "ImportDeclaration") {
      readImport(statement);
    } else {
      readBindings(statement);
    }
  }

  function pushKey(node: Keyed): void {
    pushName(keyName(node.key, node.computed));
  }

  function pushValued(node: Valued): void {
    const name = keyName(node.key, node.computed);

    pushName(name);

    if (node.value !== null) {
      namedValues.set(node.value.start, name);
    }
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
      const name = node.id.type === "Identifier" ? node.id.name : null;

      pushName(name);

      if (node.init !== null) {
        namedValues.set(node.init.start, name);
      }
    },
    "VariableDeclarator:exit": pop,
    Property: pushValued,
    "Property:exit": pop,
    PropertyDefinition: pushValued,
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
   * Callee matching runs first and keeps the type, so adoption drops a name it already took. A
   * wrap under some other name inside the same call is a store handed to that call, not the store
   * the call returns, and both belong in the tree.
   */
  const adopted = adopts.filter(
    (adopt) =>
      !wraps.some(
        (wrap) =>
          wrap.site.name === adopt.site.name && wrap.start >= adopt.start && wrap.end <= adopt.end,
      ),
  );

  /**
   * A file that binds a creator is instrumented even when it makes no store today, because an
   * edit that took the last store out still has to clear what the run before it registered.
   */
  if (creators.size === 0 && adopted.length === 0) {
    return { changed: false, warnings: [...warnings] };
  }

  const edited = new MagicString(input.code);

  for (const injection of [...wraps, ...adopted]) {
    edited.prependRight(injection.start, `${SCOPE}.${injection.call}(`);
    edited.appendLeft(injection.end, `, ${JSON.stringify(injection.site)})`);
  }

  edited.prepend(header(input));

  /**
   * On its own line after the module's own body, so every original line keeps its place and a
   * file whose last line is a comment still ends that comment before this call.
   */
  if (bound.length > 0) {
    edited.append(`\n${SCOPE}.own([${bound.map(binding).join(", ")}]);\n`);
  }

  return {
    changed: true,
    code: edited.toString(),
    map: edited.generateMap({ source: input.moduleKey, includeContent: true, hires: true }),
    warnings: [...warnings],
  };
}

/** The name as it is written in the source, beside the value it holds at the end of the body. */
function binding(name: string): string {
  return `[${JSON.stringify(name)}, ${name}]`;
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
    input.external,
  ].join(", ");

  return (
    `import { fileScope as ${FACTORY} } from ${JSON.stringify(RUNTIME_MODULE)}; ` +
    `const ${SCOPE} = ${FACTORY}(${args}); ${SCOPE}.clear(); ` +
    `if (import.meta.hot) import.meta.hot.prune(() => { ${SCOPE}.clear(); });\n`
  );
}

/** The second half of the pre-parse test: a file importing no creator can still be adopted from. */
function mayAdopt(input: TransformInput): boolean {
  return input.adoptFactories && BINDS_DOLLAR_NAME.test(input.code);
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
