import { MagicString, type SourceMap } from "magic-string";
import type {
  ArrayExpression,
  AssignmentTargetMaybeDefault,
  BindingPattern,
  CallExpression,
  Comment,
  ExportNamedDeclaration,
  Expression,
  ImportDeclaration,
  ModuleExportName,
  NewExpression,
  PropertyKey as NodePropertyKey,
  Program,
  VisitorObject,
} from "oxc-parser";

import type { StoreType } from "../stores/registry.ts";
import type { Parser } from "./parser.ts";
import type { PackageStoreTypes } from "./store-types.ts";
import type { CreationSite } from "../runtime.ts";

export type TransformInput = {
  code: string;
  /** The module's own key, and the unit a hot reload clears. Never an absolute path. */
  moduleKey: string;
  home: string;
  /** Whether the file is somebody else's. Handed in, because no path spelling settles it. */
  external: boolean;
  maxStoresPerSite: number;
  adoptFactories: boolean;
  /** The kind a known package's export returns, which an adoption site carries instead of none. */
  storeTypes: PackageStoreTypes;
  parser: Parser;
  /** The module id the injected import reads the runtime from. */
  runtimeModule: string;
  /**
   * The whole hot-reload line, written by the adapter and handed the statement that clears this
   * module's stores. Each bundler spells its own hot handle, injects it per module, and offers a
   * different hook, so no single line and no shared runtime can cover them all. The alternative was
   * to hand the handle over as one expression and let the runtime branch on it; that buys one shape
   * for every adapter, but it only works once a second bundler's handle is known to do the job, and
   * it costs an argument in a public signature. It takes the clear statement and returns the line,
   * rather than being a finished string, so the scope name stays the transform's own. Return one
   * line: the header takes one line, so every original line keeps its place in the source map.
   */
  hotReload: (clear: string) => string;
};

export type StoreTransform =
  | { changed: true; code: string; map: SourceMap; warnings: readonly string[] }
  | { changed: false; warnings: readonly string[] };

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
 * A name frame carries what a store born under it is called; a function frame ends that reach.
 * `self` is whether `this` here is still the class a field initializer runs for.
 */
type Frame = { fn: boolean; name: string | null; self: boolean };

/**
 * One call the transform wraps, the runtime function it hands the call to, and whether it hands
 * over `this` as well.
 */
type Injection = {
  start: number;
  end: number;
  call: "store" | "adopt";
  site: CreationSite;
  self: boolean;
};

/**
 * One top-level initializer a creation frame is opened around: where it starts and ends, the name
 * of the function it calls, if that is an identifier at all, and the binding the frame closes on.
 */
type FramedInit = { start: number; end: number; callee: string | null; site: CreationSite };

/**
 * One name the file brings in: the module it came from, and the export it reads there. A default
 * binding reads no export a map of export names can be written for.
 */
type ImportedName = { module: string; exported: string | null };

/** An object property, a class field and a method all name what sits under them the same way. */
type Keyed = { key: NodePropertyKey; computed: boolean };

/**
 * A value as it is written, which `bared` looks through. A property holds an expression, but the
 * same node type stands in a destructuring pattern, where what it holds is a pattern instead.
 */
type Written = Expression | BindingPattern | AssignmentTargetMaybeDefault;

/** A key that also holds a value, so the value's own offset can carry the key's name. */
type Valued = Keyed & { value: Written | null };

/** One statement standing at the top level of a module body, taken off the program that holds it. */
type TopLevel = Program["body"][number];

/** Where one statement of the module body starts and ends, for the comment that stands over it. */
type Span = { start: number; end: number };

/**
 * A range a throttle comment settles, and what the comment said: the rate in milliseconds it named,
 * `true` for a bare mark, which the store holds to the default rate, or `false` for the comment
 * that keeps the store out of the automatic catch.
 */
type Mark = Span & { throttle: number | boolean };

/**
 * The comment that holds a store to one row a second, written on its own line above the store. It
 * takes a rate of its own, `// @nanostores-devtools:throttle 100`, and the rest of the line is captured so a
 * comment that names no readable rate still marks its store.
 */
const THROTTLE_COMMENT = /^@nanostores-devtools:throttle(?:\s+([^]*))?$/;

/**
 * The other one: this store writes fast on purpose, so the write rate never takes it over. It reads
 * nothing after the name, and whatever a developer wrote there leaves the store spared all the
 * same, the way an unreadable rate still marks one.
 */
const NO_THROTTLE_COMMENT = /^@nanostores-devtools:no-throttle(?:\s+[^]*)?$/;

/**
 * The third one: every store the statement below makes stays out of the devtools, so the statement
 * comes back exactly as it was written. It reads nothing after the name either.
 */
const IGNORE_COMMENT = /^@nanostores-devtools:ignore(?:\s+[^]*)?$/;

/** Every devtools comment the plugin reads, for the developer who wrote one it does not. */
const DEVTOOLS_COMMENTS = [
  "@nanostores-devtools:ignore",
  "@nanostores-devtools:throttle",
  "@nanostores-devtools:no-throttle",
] as const;

/**
 * How far a devtools comment's name reaches, so the rate a throttle names stays out of it. It
 * matches the namespace and everything written onto it, so a colon typed as a hyphen is still read
 * as ours and warned about, rather than passing as prose.
 */
const COMMENT_NAME = /^@nanostores-devtools\S*/;

export function transformStores(input: TransformInput): StoreTransform {
  const warnings = new Set<string>();
  const parsed = input.parser.parseSync(input.moduleKey, input.code);

  if (parsed.errors.length > 0) {
    return { changed: false, warnings: [] };
  }

  const creators = new Map<string, StoreType>();
  /** Every name this file imported, keyed by the name it wrote, which is what a callee reads as. */
  const imports = new Map<string, ImportedName>();
  const wraps: Injection[] = [];
  const adopts: Injection[] = [];
  const stack: Frame[] = [];
  /**
   * Where a named binding's value starts, past every wrapper around it, and the name it is bound
   * to. An array element has no key of its own, so it is named where the array itself is named.
   */
  const namedValues = new Map<number, string | null>();
  const open: number[] = [];
  const lines = lineStarts(input.code);
  /** The module's top-level bindings, in source order, for the scan the runtime walks at load. */
  const bound: string[] = [];
  /** Which of them the developer exported, which is the name the app knows a store by. */
  const exported = new Set<string>();
  const initializers: FramedInit[] = [];
  /** How many unassigned stores a binding's initializer has already held, keyed by the binding. */
  const unassigned = new Map<string, number>();
  /** Where an `await` stands, which drops the frame around it once the walk has been through. */
  const awaits: number[] = [];
  /** The statements a throttle comment stands over, so every site inside one carries the flag. */
  const throttled: Mark[] = [];
  /** The statements an ignore comment stands over, which the transform leaves as they were. */
  const ignored: Span[] = [];

  /** Whether this offset stands inside a statement the developer kept out of the devtools. */
  function isIgnored(start: number): boolean {
    return ignored.some((span) => start >= span.start && start < span.end);
  }

  function currentName(): string | null {
    const top = stack.at(-1);

    return top === undefined || top.fn ? null : top.name;
  }

  function currentFn(): string | null {
    return stack.findLast((frame) => frame.fn)?.name ?? null;
  }

  /** A field initializer's `this` reaches through everything but a function of its own. */
  function currentSelf(): boolean {
    return stack.at(-1)?.self ?? false;
  }

  function pushName(name: string | null, self = currentSelf()): void {
    stack.push({ fn: false, name, self });
  }

  /** A function of its own binds `this` again, which only an arrow leaves alone. */
  function pushFn(name: string | null, self = false): void {
    stack.push({ fn: true, name: name ?? currentName(), self });
  }

  function pop(): void {
    stack.pop();
  }

  /**
   * `nanostores` itself gives a call a type and a wrap. Every import is written down beside that,
   * because a name the file brought in is both what the package map reads a kind off and the one
   * name a call nobody named can be adopted under.
   */
  function readImport(node: ImportDeclaration): void {
    if (node.importKind === "type") {
      return;
    }

    if (node.source.value === "nanostores") {
      readCreatorImport(node);
    }

    for (const [local, from] of importedNames(node)) {
      imports.set(local, from);
    }
  }

  /** The kind a call's callee makes, where the file imported it and the map names that export. */
  function packagedType(callee: string | undefined): StoreType | undefined {
    const from = callee === undefined ? undefined : imports.get(callee);

    return from === undefined
      ? undefined
      : typeOf(input.storeTypes.get(from.module), from.exported);
  }

  function readCreatorImport(node: ImportDeclaration): void {
    if (node.specifiers.some((specifier) => specifier.type === "ImportNamespaceSpecifier")) {
      warnings.add(
        `"${input.moduleKey}" imports nanostores as a namespace, so the plugin cannot tell ` +
          `what its stores are. Import atom, map, deepMap, computed or batched by name instead.`,
      );
    }

    for (const [local, from] of importedNames(node)) {
      const type = typeOf(CREATORS, from.exported);

      if (type !== undefined) {
        creators.set(local, type);
      }
    }
  }

  /**
   * An array something named holds its members under an index, and `$totals[0]` is then a name the
   * developer can type and get that store back. An array standing in an argument is nobody's value:
   * `merged([eventAtom(a), eventAtom(b)])` hands the whole array over and keeps the atom it built,
   * so an index off the binding would point at a member `$pointerEnd` does not have. Those members
   * fall through to `callName`, which numbers them as unassigned instead.
   */
  function readArray(node: ArrayExpression): void {
    if (!namedValues.has(node.start)) {
      return;
    }

    const base = namedValues.get(node.start) ?? null;

    node.elements.forEach((element, index) => {
      if (element !== null && element.type !== "SpreadElement") {
        namedValues.set(bared(element).start, base === null ? null : `${base}[${index}]`);
      }
    });
  }

  /**
   * The name a store this call makes is known by, or `null` where nothing reaches it.
   *
   * A binding, a property, or an index of an array one of those holds names the call outright. Every
   * other call is written inside somebody's initializer and bound to nothing, so it has no name of
   * its own: it takes the binding's, plus a number saying which one it is in source order.
   *
   * That number is what keeps two of them apart. A label is the home, the name, the file, the line
   * and the site's own count, and `combine(atom(1), atom(2))` gave both atoms every one of those,
   * so the second quietly took the first one's place in the registry.
   *
   * Counted here rather than at the visit, so it runs 1, 2, 3 with no gaps: a call that books no
   * store never asks.
   */
  function callName(start: number): string | null {
    if (namedValues.has(start)) {
      return namedValues.get(start) ?? null;
    }

    const base = currentName();

    if (base === null) {
      return null;
    }

    const next = (unassigned.get(base) ?? 0) + 1;

    unassigned.set(base, next);

    return `${base} unassigned ${next}`;
  }

  /**
   * The comment marks the statement, so a factory call it stands over marks every store that call
   * makes. That is the same reach the statement itself has, and the name a mark is read back under.
   */
  function siteAt(start: number, name: string | null, type: StoreType): CreationSite {
    const site: CreationSite = { name, fn: currentFn(), line: lineOf(lines, start), type };

    const span = throttled.find((held) => start >= held.start && start < held.end);

    if (span !== undefined) {
      site.throttle = span.throttle;
    }

    return site;
  }

  function readCall(node: CallExpression): void {
    /** Ignored: no wrapper of any kind reaches a store this statement makes. */
    if (isIgnored(node.start)) {
      return;
    }

    /**
     * A store made inside an instrumented one is a temporary that the callback rebuilds on every
     * run, so it is the one thing callee matching finds and refuses, and adoption follows it.
     */
    if (open.length > 0) {
      return;
    }

    const callee = node.callee.type === "Identifier" ? node.callee.name : undefined;
    const type = callee === undefined ? undefined : creators.get(callee);

    if (type !== undefined) {
      open.push(node.start);
      wraps.push({
        start: node.start,
        end: node.end,
        call: "store",
        site: siteAt(node.start, callName(node.start), type),
        self: currentSelf(),
      });

      return;
    }

    if (!input.adoptFactories) {
      return;
    }

    const name = callName(node.start);
    const kind = packagedType(callee);

    /**
     * The name is the whole gate: a codebase that never writes the `$` prefix makes stores all the
     * same, and a call standing in an argument is adopted as much as one bound straight to a name.
     * What it hands back is the developer's either way, and the name it carries says where they
     * wrote it. `adopt` hands a value that is no store straight back, so a call that builds
     * anything else costs one wrapper and nothing more.
     *
     * A call the package map knows carries that package's kind rather than none. It stays an
     * adoption all the same: the map says what a store is, never where one is, and the runtime
     * keeps a kind the store already carries over the one the map offers.
     */
    if (name !== null) {
      adopt(node, name, kind);

      return;
    }

    /**
     * A store made where it is used rather than where it is declared: `useStore(userStore(id))`
     * inside a component binds nothing, is nobody's property, and the function around it ends the
     * reach of every name. The call that made it is the only name left, so the store takes that
     * one, and the runtime numbers the stores of one site apart.
     *
     * Only a callee the file imported, which is also where that name comes from. A callee the file
     * declares itself is a helper of its own, and a member call names no import either. Without
     * that limit every call in every function body would carry a wrapper.
     */
    if (callee !== undefined && imports.has(callee)) {
      adopt(node, callee, kind);
    }
  }

  function adopt(node: CallExpression, name: string, kind: StoreType | undefined): void {
    adopts.push({
      start: node.start,
      end: node.end,
      call: "adopt",
      site: siteAt(node.start, name, kind ?? "unknown"),
      self: false,
    });
  }

  /**
   * A declaration standing in the module body, which is the only place a top-level binding is
   * made. An ambient one is skipped: `declare const $a: Atom` is a normal declarator in the AST
   * but binds nothing once the types are stripped, so listing it would throw a `ReferenceError`
   * and take the module down. A destructured binding needs no case of its own, because its `id`
   * is not an `Identifier`.
   */
  function readBindings(statement: TopLevel): void {
    const exportedHere = statement.type === "ExportNamedDeclaration";
    const declared = exportedHere ? statement.declaration : statement;

    if (exportedHere) {
      readExportList(statement);
    }

    if (declared?.type !== "VariableDeclaration" || declared.declare === true) {
      return;
    }

    for (const declarator of declared.declarations) {
      if (declarator.id.type !== "Identifier") {
        continue;
      }

      bound.push(declarator.id.name);

      if (exportedHere) {
        exported.add(declarator.id.name);
      }

      if (declarator.init !== null) {
        readFrame(declarator.id.name, declarator.init);
      }
    }
  }

  /**
   * `export { $value }`, which exports a binding declared above it rather than declaring one. A
   * re-export names nothing this module binds, and a type export binds nothing at all once the
   * types are stripped.
   */
  function readExportList(statement: ExportNamedDeclaration): void {
    if (statement.source !== null || statement.exportKind === "type") {
      return;
    }

    for (const specifier of statement.specifiers) {
      if (specifier.exportKind !== "type") {
        exported.add(exportName(specifier.local));
      }
    }
  }

  /**
   * A frame is opened around a top-level initializer that calls something, `new Thing()` included.
   * Whether the call is a plain creator is settled after the walk, because an import may stand
   * below the binding that uses it.
   */
  function readFrame(name: string, init: Expression): void {
    const call = calledIn(init);

    if (call === undefined) {
      return;
    }

    initializers.push({
      start: init.start,
      end: init.end,
      callee:
        call.type === "CallExpression" && call.callee.type === "Identifier"
          ? call.callee.name
          : null,
      site: siteAt(init.start, name, "unknown"),
    });
  }

  for (const comment of parsed.comments) {
    const written = unknownComment(comment);

    if (written !== undefined) {
      warnings.add(
        `"${input.moduleKey}" line ${lineOf(lines, comment.start)} holds "${written}", which is ` +
          `no devtools comment the plugin knows. The ones it reads are ${DEVTOOLS_COMMENTS.join(", ")}.`,
      );
    }
  }

  /**
   * Every import is a top-level statement, and reading them all first frees the walk of order. The
   * module's own bindings come out of the same pass, because they stand at the same level.
   */
  const ignores = parsed.comments.filter(isIgnoreComment).map(spanOf);
  const rates = parsed.comments.flatMap(readThrottleComment);
  let previousEnd = 0;

  for (const statement of parsed.program.body) {
    const span = { start: statement.start, end: statement.end };
    /** A comment with no statement between it and this one stands over this one. */
    const stands = (held: Span): boolean =>
      held.start >= previousEnd && held.end <= statement.start;
    /** Ignore beats throttle over one statement: a store nobody draws has no rate. */
    const ignoredHere = ignores.some(stands);

    if (ignoredHere) {
      ignored.push(span);
    } else {
      const above = rates.filter(stands);
      /**
       * Both comments over one statement: the mark wins, because it asks for a rate that the other
       * one has nothing to say about, while all the other one asks for is to be left alone.
       */
      const mark = above.find((held) => held.throttle !== false) ?? above[0];

      if (mark !== undefined) {
        throttled.push({ ...span, throttle: mark.throttle });
      }
    }

    previousEnd = statement.end;

    /**
     * An import makes no store, so a mark over one has nothing to keep out. Reading it all the
     * same leaves the rest of the file instrumented, which is what the developer asked for.
     */
    if (statement.type === "ImportDeclaration") {
      readImport(statement);
    } else if (!ignoredHere) {
      readBindings(statement);
    }
  }

  function pushKey(node: Keyed): void {
    pushName(keyName(node.key, node.computed));
  }

  function pushValued(node: Valued, self = currentSelf()): void {
    const name = keyName(node.key, node.computed);

    pushName(name, self);

    if (node.value !== null) {
      namedValues.set(bared(node.value).start, name);
    }
  }

  function pushDeclared(node: { id: { name: string } | null }): void {
    pushFn(node.id?.name ?? null);
  }

  new input.parser.Visitor({
    ArrayExpression: readArray,
    AwaitExpression(node) {
      awaits.push(node.start);
    },
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
        namedValues.set(bared(node.init).start, name);
      }
    },
    "VariableDeclarator:exit": pop,
    Property: pushValued,
    "Property:exit": pop,
    /**
     * A field initializer runs with `this` bound to the new instance, and a static one with `this`
     * bound to the class, so a store made in either can be handed what holds it. A computed key is
     * left out, key and value alike: the key runs in the scope around the class, where `this` is
     * something else or nothing at all, and the field it names is no name the tree can draw.
     */
    PropertyDefinition(node) {
      pushValued(node, !node.computed);
    },
    "PropertyDefinition:exit": pop,
    MethodDefinition: pushKey,
    "MethodDefinition:exit": pop,
    FunctionDeclaration: pushDeclared,
    "FunctionDeclaration:exit": pop,
    FunctionExpression: pushDeclared,
    "FunctionExpression:exit": pop,
    ArrowFunctionExpression() {
      pushFn(null, currentSelf());
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
   * edit that took the last store out still has to clear what the run before it registered. A
   * top-level binding is enough on its own: what it holds may be a store another file made, and
   * only the scan at the end of this body places it. A file that binds nothing at the top level
   * gives the scan nothing, so it is left exactly as it was written.
   */
  if (creators.size === 0 && adopted.length === 0 && bound.length === 0) {
    return { changed: false, warnings: [...warnings] };
  }

  /**
   * A plain creator needs no frame: it makes the one store the wrap around it already names. A
   * frame around an `await` is dropped instead, because one must close in the same tick or it
   * catches every store made anywhere until it does, and the `await` beneath a frame is only known
   * once the walk has been through it.
   */
  const framed = initializers.filter(
    (init) =>
      (init.callee === null || !creators.has(init.callee)) &&
      !awaits.some((at) => at >= init.start && at < init.end),
  );

  const edited = new MagicString(input.code);

  for (const injection of [...wraps, ...adopted]) {
    const owner = injection.self ? ", this" : "";

    edited.prependRight(injection.start, `${SCOPE}.${injection.call}(`);
    edited.appendLeft(injection.end, `, ${JSON.stringify(injection.site)}${owner})`);
  }

  /** Last, so a frame sharing an initializer's bounds with an adopt call stands outside it. */
  for (const init of framed) {
    edited.prependRight(init.start, `${SCOPE}.end((${SCOPE}.begin(), `);
    edited.appendLeft(init.end, `), ${JSON.stringify(init.site)})`);
  }

  edited.prepend(header(input));

  /**
   * On its own line after the module's own body, so every original line keeps its place and a
   * file whose last line is a comment still ends that comment before this call.
   */
  if (bound.length > 0) {
    const listed = bound.map((name) => binding(name, exported.has(name)));

    edited.append(`\n${SCOPE}.own([${listed.join(", ")}]);\n`);
  }

  return {
    changed: true,
    code: edited.toString(),
    map: edited.generateMap({ source: input.moduleKey, includeContent: true, hires: true }),
    warnings: [...warnings],
  };
}

/** The name as it is written in the source, beside the value it holds at the end of the body. */
function binding(name: string, exported: boolean): string {
  return `[${JSON.stringify(name)}, ${name}, ${exported}]`;
}

/**
 * One line, so every original line keeps its place in the map. It sits at the top of the module
 * body rather than behind a hot-reload hook, because a bundler runs its dispose hook only for the
 * module that accepted the update, and a store file imported by an accepting module never sees it.
 */
function header(input: TransformInput): string {
  const args = [
    JSON.stringify(input.moduleKey),
    JSON.stringify(input.home),
    input.maxStoresPerSite,
    input.external,
  ].join(", ");

  return (
    `import { fileScope as ${FACTORY} } from ${JSON.stringify(input.runtimeModule)}; ` +
    `const ${SCOPE} = ${FACTORY}(${args}); ${SCOPE}.clear(); ` +
    `${input.hotReload(`${SCOPE}.clear();`)}\n`
  );
}

/**
 * The call an initializer holds, or nothing when it holds none. A TypeScript-only expression is
 * looked through first: `pipe(...) as Draft` is a `TSAsExpression`, so a test on the node type
 * alone sees no call at all, and parentheses hide one the same way.
 */
function calledIn(node: Expression): CallExpression | NewExpression | undefined {
  const bare = bared(node);

  return bare.type === "CallExpression" || bare.type === "NewExpression" ? bare : undefined;
}

function bared(node: Written): Written {
  switch (node.type) {
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSInstantiationExpression":
    case "ParenthesizedExpression":
      return bared(node.expression);
    default:
      return node;
  }
}

/**
 * Every value a declaration brings in, as the binding it makes and where that name came from. A
 * namespace binding is left out: it says nothing about which export a later call means, and every
 * call through it is a member call.
 */
function importedNames(node: ImportDeclaration): [string, ImportedName][] {
  const module = node.source.value;

  return node.specifiers.flatMap((specifier): [string, ImportedName][] => {
    if (specifier.type === "ImportDefaultSpecifier") {
      return [[specifier.local.name, { module, exported: null }]];
    }

    return specifier.type === "ImportSpecifier" && specifier.importKind !== "type"
      ? [[specifier.local.name, { module, exported: exportName(specifier.imported) }]]
      : [];
  });
}

/** What a map of export names says one import makes, where the import names an export at all. */
function typeOf(
  types: ReadonlyMap<string, StoreType> | undefined,
  exported: string | null,
): StoreType | undefined {
  return types === undefined || exported === null ? undefined : types.get(exported);
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

/**
 * A comment that starts with the name marks its statement whatever follows it, so a rate nobody
 * can read as a positive count of milliseconds costs the developer the rate, never the mark.
 */
function readThrottleComment(comment: Comment): Mark[] {
  const text = comment.value.trim();
  const span = spanOf(comment);

  if (NO_THROTTLE_COMMENT.test(text)) {
    return [{ ...span, throttle: false }];
  }

  const match = THROTTLE_COMMENT.exec(text);

  if (match === null) {
    return [];
  }

  const rate = Number(match[1]);

  return [{ ...span, throttle: Number.isFinite(rate) && rate > 0 ? rate : true }];
}

/**
 * The `@nanostores-devtools` name a comment opens with, when it names none the plugin reads. A typo is read
 * as prose, so the store below stays drawn while the developer reads their file as if it were
 * Ignored.
 */
function unknownComment(comment: Comment): string | undefined {
  const [written] = COMMENT_NAME.exec(comment.value.trim()) ?? [];

  if (written === undefined || DEVTOOLS_COMMENTS.some((known) => known === written)) {
    return undefined;
  }

  return written;
}

function isIgnoreComment(comment: Comment): boolean {
  return IGNORE_COMMENT.test(comment.value.trim());
}

function spanOf(node: Span): Span {
  return { start: node.start, end: node.end };
}
