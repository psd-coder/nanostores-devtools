import type { BindingIdentifier, Expression, Program } from "oxc-parser";
import { version as viteVersion } from "vite";
import { describe, expect, it } from "vitest";

import { loadParser, type ParserImports } from "./parser.ts";

const viteMajor = Number.parseInt(viteVersion, 10);

const GENERIC_CALL = `const $c = atom<number>(0);\n`;

const TYPESCRIPT_SOURCE = [
  `interface Options {`,
  `  start: number;`,
  `}`,
  `const options = { start: 0 } satisfies Options;`,
  `const $c: Store<number> = atom<number>(options.start);`,
  ``,
].join("\n");

/** The emoji is two UTF-16 units and four UTF-8 bytes, so a byte offset would miss the call. */
const EMOJI_SOURCE = `const label = "🍎🍏";\nconst $c = atom(0);\n`;

const NESTED_FUNCTIONS = [
  `function outer() {`,
  `  const middle = function () {`,
  `    return () => atom(0);`,
  `  };`,
  `  return middle;`,
  `}`,
  ``,
].join("\n");

describe("loadParser", () => {
  const parserExports = { parseSync: () => undefined, Visitor: class {} };

  function importsWith(overrides: Partial<ParserImports>): ParserImports {
    return {
      vite: () => Promise.resolve({}),
      "oxc-parser": () => Promise.resolve(parserExports),
      ...overrides,
    };
  }

  it("takes the parser vite re-exports when there is one", async () => {
    const parser = await loadParser(importsWith({ vite: () => Promise.resolve(parserExports) }));

    expect(parser.source).toBe("vite");
  });

  it("falls back to oxc-parser when vite re-exports no parser", async () => {
    const parser = await loadParser(importsWith({}));

    expect(parser.source).toBe("oxc-parser");
  });

  it("names the package to install when oxc-parser is missing", async () => {
    const imports = importsWith({
      "oxc-parser": () => Promise.reject(new Error("Cannot find package 'oxc-parser'")),
    });

    await expect(loadParser(imports)).rejects.toThrow(/install .*oxc-parser/i);
  });

  it("keeps the resolution error as the cause", async () => {
    const resolution = new Error("Cannot find package 'oxc-parser'");
    const imports = importsWith({ "oxc-parser": () => Promise.reject(resolution) });

    await expect(loadParser(imports)).rejects.toThrow(
      expect.objectContaining({ cause: resolution }),
    );
  });
});

describe("the parser it loads", () => {
  it("comes from vite on 8 and later, and from oxc-parser on 6 and 7", async () => {
    const parser = await loadParser();

    expect(parser.source).toBe(viteMajor >= 8 ? "vite" : "oxc-parser");
  });

  it("parses a type annotation, an interface, satisfies and a generic call", async () => {
    const { parseSync } = await loadParser();
    const result = parseSync("stores.ts", TYPESCRIPT_SOURCE);
    const store = declarationOf(result.program, "$c");

    expect(result.errors).toEqual([]);
    expect(result.program.body.map((statement) => statement.type)).toContain(
      "TSInterfaceDeclaration",
    );
    expect(declarationOf(result.program, "options").init.type).toBe("TSSatisfiesExpression");
    expect(store.id.typeAnnotation?.type).toBe("TSTypeAnnotation");
    expect(store.init.type).toBe("CallExpression");
  });

  it("gives UTF-16 offsets that slice the source directly", async () => {
    const { parseSync } = await loadParser();
    const { init } = declarationOf(parseSync("stores.ts", EMOJI_SOURCE).program, "$c");

    expect(EMOJI_SOURCE.slice(init.start, init.end)).toBe("atom(0)");
  });

  it("visits every function shape on the way in and on the way out", async () => {
    const { parseSync, Visitor } = await loadParser();
    const seen: string[] = [];
    const record = (event: string) => () => {
      seen.push(event);
    };

    new Visitor({
      FunctionDeclaration: record("enter FunctionDeclaration"),
      "FunctionDeclaration:exit": record("exit FunctionDeclaration"),
      FunctionExpression: record("enter FunctionExpression"),
      "FunctionExpression:exit": record("exit FunctionExpression"),
      ArrowFunctionExpression: record("enter ArrowFunctionExpression"),
      "ArrowFunctionExpression:exit": record("exit ArrowFunctionExpression"),
    }).visit(parseSync("stores.ts", NESTED_FUNCTIONS).program);

    expect(seen).toEqual([
      "enter FunctionDeclaration",
      "enter FunctionExpression",
      "enter ArrowFunctionExpression",
      "exit ArrowFunctionExpression",
      "exit FunctionExpression",
      "exit FunctionDeclaration",
    ]);
  });
});

/**
 * Kept so nobody drops the optional dependency by reaching for the parser Vite 6 and 7 already
 * ship. It is Rollup's, it reads JavaScript only, and a generic call is valid JavaScript, so it
 * returns a wrong AST instead of an error.
 */
describe.runIf(viteMajor < 8)("the parseAst that Vite 6 and 7 ship", () => {
  it("reads a generic call as a BinaryExpression", async () => {
    const { parseAst } = await import("vite");

    expect(declarationOf(parseAst(GENERIC_CALL), "$c").init.type).toBe("BinaryExpression");
  });
});

function declarationOf(
  program: Program,
  name: string,
): { id: BindingIdentifier; init: Expression } {
  for (const statement of program.body) {
    if (statement.type !== "VariableDeclaration") {
      continue;
    }

    for (const declaration of statement.declarations) {
      if (
        declaration.id.type === "Identifier" &&
        declaration.id.name === name &&
        declaration.init
      ) {
        return { id: declaration.id, init: declaration.init };
      }
    }
  }

  throw new Error(`${name} is not declared with an initializer`);
}
