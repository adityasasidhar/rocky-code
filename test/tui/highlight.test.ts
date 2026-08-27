import { describe, expect, test } from "bun:test";
import {
  createHighlighter,
  supportedLanguages,
  type Token,
  type TokenKind,
} from "../../src/tui/highlight.ts";

/** Highlight one line and return its tokens. */
const lex = (lang: string, src: string): Token[] => {
  const h = createHighlighter(lang);
  if (!h) throw new Error(`no highlighter for ${lang}`);
  return h.line(src);
};

/** The kind assigned to the first token whose text is exactly `text`. */
const kindOf = (tokens: Token[], text: string): TokenKind | undefined =>
  tokens.find((t) => t.text === text)?.kind;

/** Tokens of a given kind, in order. */
const ofKind = (tokens: Token[], kind: TokenKind): string[] =>
  tokens.filter((t) => t.kind === kind).map((t) => t.text);

/** A highlighter's output must always reassemble into the input, exactly. */
const roundTrips = (tokens: Token[], src: string): boolean =>
  tokens.map((t) => t.text).join("") === src;

describe("createHighlighter", () => {
  test("knows the languages a coding agent actually emits", () => {
    for (const lang of ["ts", "tsx", "js", "python", "bash", "json", "go", "rust"]) {
      expect(createHighlighter(lang)).toBeDefined();
    }
  });

  test("is case- and space-insensitive about the fence label", () => {
    expect(createHighlighter("  TypeScript ")).toBeDefined();
  });

  test("returns undefined for an unknown language rather than throwing", () => {
    // The renderer relies on this to fall back to unstyled code.
    expect(createHighlighter("brainfuck")).toBeUndefined();
    expect(createHighlighter("")).toBeUndefined();
  });

  test("supportedLanguages is non-empty and sorted", () => {
    const langs = supportedLanguages();
    expect(langs.length).toBeGreaterThan(0);
    expect(langs).toEqual([...langs].sort());
  });
});

describe("lexing order — the bugs a regex-replace highlighter has", () => {
  test("a keyword inside a string is not a keyword", () => {
    const tokens = lex("ts", 'const s = "for while if";');
    expect(kindOf(tokens, "const")).toBe("keyword");
    expect(ofKind(tokens, "string")).toEqual(['"for while if"']);
    expect(ofKind(tokens, "keyword")).toEqual(["const"]);
  });

  test("a keyword inside a comment is not a keyword", () => {
    const tokens = lex("ts", "x = 1; // return if else");
    expect(ofKind(tokens, "keyword")).toEqual([]);
    expect(ofKind(tokens, "comment")).toEqual(["// return if else"]);
  });

  test("a keyword embedded in an identifier is not a keyword", () => {
    // The classic: `format` contains `for`, `constant` contains `const`.
    const tokens = lex("ts", "format(constant)");
    expect(ofKind(tokens, "keyword")).toEqual([]);
    expect(kindOf(tokens, "format")).toBe("func");
    expect(kindOf(tokens, "constant")).toBe("plain");
  });

  test("a comment marker inside a string does not start a comment", () => {
    const tokens = lex("ts", 'const url = "https://x.dev"; // real');
    expect(ofKind(tokens, "string")).toEqual(['"https://x.dev"']);
    expect(ofKind(tokens, "comment")).toEqual(["// real"]);
  });

  test("a quote inside a comment does not open a string", () => {
    const tokens = lex("ts", "// it's fine");
    expect(ofKind(tokens, "comment")).toEqual(["// it's fine"]);
    expect(ofKind(tokens, "string")).toEqual([]);
  });
});

describe("tokens", () => {
  test("classifies keywords, types, literals, numbers, and calls", () => {
    const tokens = lex("ts", "const n: number = parseInt(0x1f);");
    expect(kindOf(tokens, "const")).toBe("keyword");
    expect(kindOf(tokens, "number")).toBe("type");
    expect(kindOf(tokens, "parseInt")).toBe("func");
    expect(kindOf(tokens, "0x1f")).toBe("number");
  });

  test("literals beat types beat calls", () => {
    const tokens = lex("ts", "if (x === null) return true;");
    expect(kindOf(tokens, "null")).toBe("literal");
    expect(kindOf(tokens, "true")).toBe("literal");
    // `if` is a keyword even though it is followed by `(`.
    expect(kindOf(tokens, "if")).toBe("keyword");
  });

  test("a call is a call across whitespace", () => {
    expect(kindOf(lex("ts", "foo ()"), "foo")).toBe("func");
  });

  test("numbers with separators, floats, and exponents", () => {
    for (const n of ["1_000", "3.14", "1e-9", "0b1010", "0o777"]) {
      expect(kindOf(lex("ts", `x = ${n}`), n)).toBe("number");
    }
  });

  test("escaped quotes do not end a string early", () => {
    const tokens = lex("ts", 'const s = "a\\"b"; const t = 1;');
    expect(ofKind(tokens, "string")).toEqual(['"a\\"b"']);
    expect(ofKind(tokens, "keyword")).toEqual(["const", "const"]);
  });

  test("an unterminated string swallows the rest of the line but not the next", () => {
    const h = createHighlighter("ts")!;
    expect(ofKind(h.line('const s = "oops'), "string")).toEqual(['"oops']);
    // A single-quote string does not span lines: the next line starts clean.
    expect(ofKind(h.line("const t = 1;"), "keyword")).toEqual(["const"]);
  });
});

describe("constructs that span lines", () => {
  test("a block comment carries across lines and then releases", () => {
    const h = createHighlighter("ts")!;
    expect(ofKind(h.line("/* start"), "comment")).toEqual(["/* start"]);
    expect(ofKind(h.line("still const"), "comment")).toEqual(["still const"]);
    expect(ofKind(h.line("end */ const x = 1"), "comment")).toEqual(["end */"]);
    // Released: the code after the close is lexed normally.
    expect(kindOf(h.line("const x = 1"), "const")).toBe("keyword");
  });

  test("a one-line block comment does not leak into the next line", () => {
    const h = createHighlighter("ts")!;
    expect(ofKind(h.line("/* hi */ const x = 1"), "comment")).toEqual(["/* hi */"]);
    expect(kindOf(h.line("const y = 2"), "const")).toBe("keyword");
  });

  test("a template literal spans lines", () => {
    const h = createHighlighter("ts")!;
    expect(ofKind(h.line("const s = `line one"), "string")).toEqual(["`line one"]);
    expect(ofKind(h.line("const inside"), "string")).toEqual(["const inside"]);
    expect(ofKind(h.line("done`;"), "string")).toEqual(["done`"]);
  });

  test("a python docstring spans lines and wins over a single quote", () => {
    const h = createHighlighter("python")!;
    expect(ofKind(h.line('def f():  """doc'), "string")).toEqual(['"""doc']);
    expect(ofKind(h.line("import os"), "string")).toEqual(["import os"]);
    expect(ofKind(h.line('"""'), "string")).toEqual(['"""']);
    expect(kindOf(h.line("import os"), "import")).toBe("keyword");
  });

  test("each fence gets its own state", () => {
    const a = createHighlighter("ts")!;
    a.line("/* leaking");
    const b = createHighlighter("ts")!;
    expect(kindOf(b.line("const x = 1"), "const")).toBe("keyword");
  });
});

describe("per-language behaviour", () => {
  test("python", () => {
    const tokens = lex("python", "def greet(name: str) -> None:  # hi");
    expect(kindOf(tokens, "def")).toBe("keyword");
    expect(kindOf(tokens, "str")).toBe("type");
    expect(kindOf(tokens, "None")).toBe("literal");
    expect(ofKind(tokens, "comment")).toEqual(["# hi"]);
  });

  test("python treats # inside a string as text", () => {
    expect(ofKind(lex("python", 'x = "#1"'), "comment")).toEqual([]);
  });

  test("bash variables", () => {
    const tokens = lex("bash", 'for f in $HOME ${X}; do echo "$f"; done');
    expect(kindOf(tokens, "for")).toBe("keyword");
    expect(kindOf(tokens, "done")).toBe("keyword");
    expect(ofKind(tokens, "variable")).toEqual(["$HOME", "${X}"]);
  });

  test("a bare $ is punctuation, not a variable", () => {
    expect(ofKind(lex("bash", "echo $"), "variable")).toEqual([]);
  });

  test("json keys are distinguished from string values", () => {
    const tokens = lex("json", '{"name": "rocky", "fast": true}');
    expect(ofKind(tokens, "type")).toEqual(['"name"', '"fast"']);
    expect(ofKind(tokens, "string")).toEqual(['"rocky"']);
    expect(kindOf(tokens, "true")).toBe("literal");
  });

  test("go and rust", () => {
    expect(kindOf(lex("go", "func main() {}"), "func")).toBe("keyword");
    expect(kindOf(lex("go", "var x error = nil"), "nil")).toBe("literal");
    expect(kindOf(lex("rust", "fn main() -> Result<()> {}"), "fn")).toBe("keyword");
    expect(kindOf(lex("rust", "let v: Vec<u8> = vec![];"), "Vec")).toBe("type");
  });
});

describe("the round-trip invariant", () => {
  const samples: [string, string][] = [
    ["ts", 'const x = "a\\"b"; // note'],
    ["ts", "  \tindented(1_000)"],
    ["ts", "/* unterminated"],
    ["python", 'def f(): return {"k": 1}  # x'],
    ["bash", 'echo "${HOME}/x" | grep -q $y'],
    ["json", '{"a": [1, 2.5, null]}'],
    ["go", "s := `raw ${not}`"],
    ["rust", "let s = 'c';"],
    ["ts", ""],
    ["ts", "   "],
    ["ts", "😀 const"],
  ];

  test.each(samples)("%s: %p reassembles exactly", (lang, src) => {
    // Losing or duplicating a character would silently corrupt code on screen.
    expect(roundTrips(lex(lang, src), src)).toBe(true);
  });

  test("holds for every line of a multi-line block comment", () => {
    const h = createHighlighter("ts")!;
    for (const line of ["/* a", "b", "c */ d"]) {
      expect(h.line(line).map((t) => t.text).join("")).toBe(line);
    }
  });

  test("a line of only punctuation still round-trips", () => {
    expect(roundTrips(lex("ts", "})];"), "})];")).toBe(true);
  });
});
