import type { ParseResult, ParserOptions, Program, VisitorObject } from "oxc-parser";

/** Tried in this order: a parser vite already ships costs the user nothing. */
const PARSER_SOURCES = ["vite", "oxc-parser"] as const;

/** Which package the parser came from. Both ship oxc, so the AST is the same either way. */
export type ParserSource = (typeof PARSER_SOURCES)[number];

export type ParseSync = (
  filename: string,
  sourceText: string,
  options?: ParserOptions | null,
) => ParseResult;

export type AstVisitor = {
  visit: (program: Program) => void;
};

export type VisitorConstructor = new (visitor: VisitorObject) => AstVisitor;

export type ParserExports = {
  parseSync: ParseSync;
  Visitor: VisitorConstructor;
};

export type Parser = ParserExports & {
  source: ParserSource;
};

export type ParserImports = Record<ParserSource, () => Promise<unknown>>;

const MISSING_PARSER =
  "nanostores-devtools: discovery needs a TypeScript-aware parser and found none. Install " +
  "oxc-parser as a dev dependency: npm install --save-dev oxc-parser (or the pnpm or yarn " +
  "equivalent). Only Vite 8 and later ship one to borrow, so webpack, Rspack and Vite 6 and 7 " +
  "all need it installed.";

const defaultImports: ParserImports = {
  vite: () => import("vite"),
  "oxc-parser": () => import("oxc-parser"),
};

/**
 * The pick reads the exports rather than the Vite version, because a Vite that stopped
 * re-exporting them has to be handled the same way as a Vite too old to have them.
 */
export async function loadParser(imports: ParserImports = defaultImports): Promise<Parser> {
  let cause: unknown;

  for (const source of PARSER_SOURCES) {
    try {
      const exports = await readParser(imports[source]);

      if (exports) {
        return { source, ...exports };
      }
    } catch (error) {
      cause = error;
    }
  }

  throw new Error(MISSING_PARSER, { cause });
}

async function readParser(load: () => Promise<unknown>): Promise<ParserExports | undefined> {
  const module = await load();

  if (!hasParser(module)) {
    return undefined;
  }

  return { parseSync: module.parseSync, Visitor: module.Visitor };
}

function hasParser(module: unknown): module is ParserExports {
  return (
    typeof module === "object" &&
    module !== null &&
    "parseSync" in module &&
    typeof module.parseSync === "function" &&
    "Visitor" in module &&
    typeof module.Visitor === "function"
  );
}
