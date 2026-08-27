/**
 * A deliberately small syntax highlighter.
 *
 * This is a lexer, not a parser: it walks a line left to right and classifies
 * runs of characters. That ordering is the whole point — a naive "replace every
 * keyword with a coloured keyword" pass paints the `for` inside `"format"`, and
 * paints keywords inside comments. Scanning left to right means a string or a
 * comment consumes its own contents before any keyword can match inside it.
 *
 * Highlighting is per line, so the streaming renderer can paint a fenced block
 * as it arrives rather than waiting for the closing fence. Constructs that span
 * lines (block comments, template literals, Python docstrings) are carried
 * across in `ScanState.pending`.
 */

import { getCurrentTheme, themeColorToAnsi, themeColorReset } from "./theme.ts";

export type TokenKind =
  | "keyword"
  | "type"
  | "literal"
  | "string"
  | "number"
  | "comment"
  | "func"
  | "variable"
  | "punct"
  | "plain";

export type Token = { kind: TokenKind; text: string };

/** A construct that may run past the end of the line. */
type Pending = { close: string; kind: TokenKind };
type ScanState = { pending: Pending | undefined };

type Block = { open: string; close: string; kind: TokenKind };

type Spec = {
  keywords: readonly string[];
  types?: readonly string[];
  literals?: readonly string[];
  lineComment: readonly string[];
  /** Checked before `quotes`, so `"""` wins over `"`. */
  blocks?: readonly Block[];
  quotes: readonly string[];
  /** `$` in shell. An identifier starting with this is a variable. */
  varPrefix?: string;
  /** JSON: a string immediately before `:` is a key, not a value. */
  keyedStrings?: boolean;
};

const JS: Spec = {
  keywords: [
    "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
    "debugger", "default", "delete", "do", "else", "enum", "export", "extends",
    "finally", "for", "from", "function", "get", "if", "implements", "import", "in",
    "instanceof", "interface", "keyof", "let", "new", "of", "private", "protected",
    "public", "readonly", "return", "satisfies", "set", "static", "super", "switch",
    "this", "throw", "try", "type", "typeof", "var", "void", "while", "yield",
  ],
  types: [
    "any", "bigint", "boolean", "never", "number", "object", "string", "symbol",
    "unknown", "Array", "Map", "Set", "Promise", "Record", "Partial",
  ],
  literals: ["true", "false", "null", "undefined", "NaN", "Infinity"],
  lineComment: ["//"],
  blocks: [
    { open: "/*", close: "*/", kind: "comment" },
    { open: "`", close: "`", kind: "string" },
  ],
  quotes: ['"', "'"],
};

const PYTHON: Spec = {
  keywords: [
    "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
    "del", "elif", "else", "except", "finally", "for", "from", "global", "if",
    "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
    "return", "try", "while", "with", "yield", "match", "case",
  ],
  types: ["int", "str", "float", "bool", "bytes", "list", "dict", "set", "tuple", "self"],
  literals: ["True", "False", "None"],
  lineComment: ["#"],
  blocks: [
    { open: '"""', close: '"""', kind: "string" },
    { open: "'''", close: "'''", kind: "string" },
  ],
  quotes: ['"', "'"],
};

const BASH: Spec = {
  keywords: [
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
    "case", "esac", "function", "in", "return", "local", "export", "source",
    "set", "shift", "trap", "exit",
  ],
  literals: [],
  lineComment: ["#"],
  quotes: ['"', "'"],
  varPrefix: "$",
};

const JSON_SPEC: Spec = {
  keywords: [],
  literals: ["true", "false", "null"],
  lineComment: [],
  quotes: ['"'],
  keyedStrings: true,
};

const GO: Spec = {
  keywords: [
    "break", "case", "chan", "const", "continue", "default", "defer", "else",
    "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
    "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
  ],
  types: [
    "bool", "byte", "complex64", "complex128", "error", "float32", "float64",
    "int", "int8", "int16", "int32", "int64", "rune", "string", "uint", "uintptr",
  ],
  literals: ["true", "false", "nil", "iota"],
  lineComment: ["//"],
  blocks: [
    { open: "/*", close: "*/", kind: "comment" },
    { open: "`", close: "`", kind: "string" },
  ],
  quotes: ['"', "'"],
};

const RUST: Spec = {
  keywords: [
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else",
    "enum", "extern", "fn", "for", "if", "impl", "in", "let", "loop", "match",
    "mod", "move", "mut", "pub", "ref", "return", "self", "static", "struct",
    "super", "trait", "type", "unsafe", "use", "where", "while",
  ],
  types: [
    "bool", "char", "f32", "f64", "i8", "i16", "i32", "i64", "isize", "str",
    "u8", "u16", "u32", "u64", "usize", "String", "Vec", "Option", "Result", "Self",
  ],
  literals: ["true", "false", "None", "Some", "Ok", "Err"],
  lineComment: ["//"],
  blocks: [{ open: "/*", close: "*/", kind: "comment" }],
  quotes: ['"', "'"],
};

const SPECS: Record<string, Spec> = {
  js: JS, jsx: JS, mjs: JS, cjs: JS, javascript: JS,
  ts: JS, tsx: JS, typescript: JS,
  py: PYTHON, python: PYTHON,
  sh: BASH, bash: BASH, zsh: BASH, shell: BASH, console: BASH,
  json: JSON_SPEC, jsonc: JSON_SPEC,
  go: GO, golang: GO,
  rs: RUST, rust: RUST,
};

export const supportedLanguages = (): string[] => Object.keys(SPECS).sort();

const NUMBER = /^(0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
const WS = /^[ \t]+/;

/**
 * A per-fence, stateful highlighter. Feed it one line at a time; it remembers
 * whether it is inside a block comment or a multi-line string.
 *
 * Returns `undefined` for a language it does not know, which the caller should
 * treat as "print this code unstyled" rather than as an error.
 */
export function createHighlighter(lang: string): Highlighter | undefined {
  const spec = SPECS[lang.toLowerCase().trim()];
  return spec ? new Highlighter(spec) : undefined;
}

export class Highlighter {
  private readonly state: ScanState = { pending: undefined };

  constructor(private readonly spec: Spec) {}

  line(src: string): Token[] {
    const tokens = scan(src, this.spec, this.state);
    return this.spec.keyedStrings ? markJsonKeys(tokens) : tokens;
  }
}

function scan(src: string, spec: Spec, state: ScanState): Token[] {
  const out: Token[] = [];
  const push = (kind: TokenKind, text: string): void => {
    if (text) out.push({ kind, text });
  };

  let i = 0;

  // Finish whatever ran off the end of the previous line.
  if (state.pending) {
    const { close, kind } = state.pending;
    const end = src.indexOf(close);
    if (end === -1) {
      push(kind, src);
      return out;
    }
    push(kind, src.slice(0, end + close.length));
    i = end + close.length;
    state.pending = undefined;
  }

  while (i < src.length) {
    const rest = src.slice(i);

    const ws = WS.exec(rest);
    if (ws) {
      push("plain", ws[0]);
      i += ws[0].length;
      continue;
    }

    if (spec.lineComment.some((c) => rest.startsWith(c))) {
      push("comment", rest);
      break;
    }

    const block = spec.blocks?.find((b) => rest.startsWith(b.open));
    if (block) {
      const end = rest.indexOf(block.close, block.open.length);
      if (end === -1) {
        push(block.kind, rest);
        state.pending = { close: block.close, kind: block.kind };
        break;
      }
      const text = rest.slice(0, end + block.close.length);
      push(block.kind, text);
      i += text.length;
      continue;
    }

    const quote = spec.quotes.find((q) => rest.startsWith(q));
    if (quote) {
      const text = readString(rest, quote);
      push("string", text);
      i += text.length;
      continue;
    }

    if (spec.varPrefix && rest.startsWith(spec.varPrefix)) {
      const name = IDENT.exec(rest.slice(spec.varPrefix.length));
      const braced = rest.startsWith(`${spec.varPrefix}{`)
        ? /^\$\{[^}]*\}?/.exec(rest)
        : null;
      const text = braced?.[0] ?? (name ? spec.varPrefix + name[0] : spec.varPrefix);
      push(text.length > spec.varPrefix.length ? "variable" : "punct", text);
      i += text.length;
      continue;
    }

    const num = NUMBER.exec(rest);
    if (num) {
      push("number", num[0]);
      i += num[0].length;
      continue;
    }

    const id = IDENT.exec(rest);
    if (id) {
      const word = id[0];
      i += word.length;
      push(classify(word, spec, src.slice(i)), word);
      continue;
    }

    push("punct", rest[0]!);
    i += 1;
  }

  return out;
}

function classify(word: string, spec: Spec, after: string): TokenKind {
  if (spec.keywords.includes(word)) return "keyword";
  if (spec.literals?.includes(word)) return "literal";
  if (spec.types?.includes(word)) return "type";
  // A name immediately applied is a call. `if (x)` never reaches here because
  // `if` matched as a keyword first.
  if (/^\s*\(/.test(after)) return "func";
  return "plain";
}

/** Consume a quoted string, honouring backslash escapes, stopping at EOL. */
function readString(src: string, quote: string): string {
  let i = quote.length;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (src.startsWith(quote, i)) return src.slice(0, i + quote.length);
    i += 1;
  }
  return src; // unterminated: the rest of the line is the string
}

/** In JSON a string followed by `:` is a key. Re-label it after the fact. */
function markJsonKeys(tokens: Token[]): Token[] {
  return tokens.map((tok, idx) => {
    if (tok.kind !== "string") return tok;
    const next = tokens.slice(idx + 1).find((t) => t.text.trim() !== "");
    return next?.text === ":" ? { kind: "type", text: tok.text } : tok;
  });
}

/**
 * Render highlighted tokens as a string with theme-aware ANSI colors.
 */
export function renderTokens(tokens: Token[]): string {
  const theme = getCurrentTheme();
  const syntaxMap: Record<TokenKind, string> = {
    keyword: theme.syntax.keyword,
    type: theme.syntax.type,
    literal: theme.syntax.constant,
    string: theme.syntax.string,
    number: theme.syntax.number,
    comment: theme.syntax.comment,
    func: theme.syntax.function,
    variable: theme.syntax.variable,
    punct: theme.syntax.punctuation,
    plain: "",
  };

  return tokens
    .map((tok) => {
      const color = syntaxMap[tok.kind];
      if (!color) return tok.text;
      return `${themeColorToAnsi(color)}${tok.text}${themeColorReset()}`;
    })
    .join("");
}
