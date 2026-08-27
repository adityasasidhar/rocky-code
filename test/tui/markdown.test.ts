import { describe, expect, test } from "bun:test";
import {
  MarkdownStream,
  plainTheme,
  type MarkdownTheme,
} from "../../src/tui/markdown.ts";

/** A theme that emits visible tags instead of escape codes, so tests can read. */
const tagTheme: MarkdownTheme = {
  heading: (level) => ({ on: `<h${level}>`, off: `</h${level}>` }),
  bold: { on: "<b>", off: "</b>" },
  italic: { on: "<i>", off: "</i>" },
  code: { on: "<c>", off: "</c>" },
  quote: { on: "<q>", off: "</q>" },
  bullet: "•",
  rule: (w) => `<hr:${w}>`,
  token: (kind, text) => (kind === "plain" || kind === "punct" ? text : `<${kind}>${text}</${kind}>`),
  codeIndent: "  ",
};

type Harness = { md: MarkdownStream; out: () => string };

const harness = (theme: MarkdownTheme = plainTheme, width = 8): Harness => {
  let buf = "";
  const md = new MarkdownStream((s) => (buf += s), theme, width);
  return { md, out: () => buf };
};

/** Render `src` by pushing it in slices of `chunk` characters, then flushing. */
function render(src: string, theme: MarkdownTheme = plainTheme, chunk = Infinity): string {
  const { md, out } = harness(theme);
  if (chunk === Infinity) {
    md.push(src);
  } else {
    for (let i = 0; i < src.length; i += chunk) md.push(src.slice(i, i + chunk));
  }
  md.flush();
  return out();
}

describe("block constructs", () => {
  test("headings drop their hashes and take a line style", () => {
    expect(render("# Title\n")).toBe("Title\n");
    expect(render("### Deep\n")).toBe("Deep\n");
    expect(render("# Title\n", tagTheme)).toBe("<h1>Title</h1>\n");
    expect(render("###### Six\n", tagTheme)).toBe("<h6>Six</h6>\n");
  });

  test("a hash without a space is not a heading", () => {
    expect(render("#hashtag\n")).toBe("#hashtag\n");
    expect(render("####### seven\n")).toBe("####### seven\n");
  });

  test("bullets, preserving indentation", () => {
    expect(render("- one\n")).toBe("• one\n");
    expect(render("* two\n")).toBe("• two\n");
    expect(render("+ three\n")).toBe("• three\n");
    expect(render("  - nested\n")).toBe("  • nested\n");
  });

  test("ordered lists keep their own numbering", () => {
    expect(render("1. first\n")).toBe("1. first\n");
    expect(render("42. answer\n")).toBe("42. answer\n");
    // Not a list: a decimal number.
    expect(render("1.5 kg\n")).toBe("1.5 kg\n");
  });

  test("blockquotes get a gutter and swallow one space", () => {
    expect(render("> quoted\n")).toBe("│ quoted\n");
    expect(render(">tight\n")).toBe("│ tight\n");
    expect(render("> quoted\n", tagTheme)).toBe("<q>│ quoted</q>\n");
  });

  test("horizontal rules span the configured width", () => {
    expect(render("---\n", tagTheme)).toBe("<hr:8>\n");
    expect(render("***\n", tagTheme)).toBe("<hr:8>\n");
    expect(render("___\n", tagTheme)).toBe("<hr:8>\n");
    expect(render("-----\n", tagTheme)).toBe("<hr:8>\n");
  });

  test("two dashes are text, three are a rule", () => {
    expect(render("--\n")).toBe("--\n");
    expect(render("-- x\n")).toBe("-- x\n");
  });

  test("blank lines survive", () => {
    expect(render("a\n\nb\n")).toBe("a\n\nb\n");
  });
});

describe("inline constructs", () => {
  test("bold and italic", () => {
    expect(render("**bold**\n", tagTheme)).toBe("<b>bold</b>\n");
    expect(render("*em*\n", tagTheme)).toBe("<i>em</i>\n");
    expect(render("a **b** c\n", tagTheme)).toBe("a <b>b</b> c\n");
  });

  test("inline code, inside which nothing is markup", () => {
    expect(render("`x*y`\n", tagTheme)).toBe("<c>x*y</c>\n");
    expect(render("use `--flag`\n", tagTheme)).toBe("use <c>--flag</c>\n");
  });

  test("code spans nest inside bold", () => {
    expect(render("**a `b` c**\n", tagTheme)).toBe("<b>a <c>b</c> c</b>\n");
  });

  test("an asterisk followed by a space is arithmetic, not emphasis", () => {
    expect(render("2 * 3 = 6\n", tagTheme)).toBe("2 * 3 = 6\n");
  });

  test("underscores are never emphasis, so identifiers survive", () => {
    // This is the whole reason `_` is unsupported.
    expect(render("call snake_case_name now\n", tagTheme)).toBe(
      "call snake_case_name now\n",
    );
    expect(render("__dunder__\n", tagTheme)).toBe("__dunder__\n");
  });

  test("backslash escapes the next character", () => {
    expect(render("\\*not em\\*\n", tagTheme)).toBe("*not em*\n");
    expect(render("\\`not code\\`\n", tagTheme)).toBe("`not code`\n");
  });

  test("links render literally, URL intact", () => {
    expect(render("see [docs](https://x.dev/a_b)\n", tagTheme)).toBe(
      "see [docs](https://x.dev/a_b)\n",
    );
  });
});

describe("unclosed constructs never leak past the line", () => {
  test.each([
    ["**bold", "<b>bold</b>\n"],
    ["*em", "<i>em</i>\n"],
    ["`code", "<c>code</c>\n"],
    ["# head", "<h1>head</h1>\n"],
    ["> quote", "<q>│ quote</q>\n"],
  ])("%p closes at end of line", (src, expected) => {
    expect(render(`${src}\n`, tagTheme)).toBe(expected);
    // ...and the same holds when the stream just ends, with no newline.
    expect(render(src, tagTheme)).toBe(expected);
  });

  test("a trailing lone asterisk is emitted literally", () => {
    expect(render("done *\n", tagTheme)).toBe("done *\n");
    expect(render("done *", tagTheme)).toBe("done *\n");
  });

  test("a trailing backslash is emitted literally", () => {
    expect(render("path\\", tagTheme)).toBe("path\\\n");
  });

  test("bold state does not carry into the next line", () => {
    expect(render("**a\nb\n", tagTheme)).toBe("<b>a</b>\nb\n");
  });
});

describe("fenced code", () => {
  test("strips the fence, indents, and highlights", () => {
    expect(render("```ts\nconst x = 1;\n```\n", tagTheme)).toBe(
      "  <keyword>const</keyword> x = <number>1</number>;\n",
    );
  });

  test("an unknown language renders unstyled rather than failing", () => {
    expect(render("```brainfuck\n+++.\n```\n", tagTheme)).toBe("  +++.\n");
  });

  test("a fence with no language renders unstyled", () => {
    expect(render("```\nplain text\n```\n", plainTheme)).toBe("  plain text\n");
  });

  test("markdown syntax inside a fence is not markdown", () => {
    expect(render("```\n# not a heading\n- not a bullet\n```\n", plainTheme)).toBe(
      "  # not a heading\n  - not a bullet\n",
    );
  });

  test("prose resumes after the closing fence", () => {
    expect(render("```\nx\n```\n**after**\n", tagTheme)).toBe("  x\n<b>after</b>\n");
  });

  test("an unterminated fence still emits the code it received", () => {
    expect(render("```\nline one\nline two", plainTheme)).toBe("  line one\n  line two\n");
  });

  test("a closing fence with no trailing newline closes, and is not code", () => {
    // Models routinely end a message on ``` with nothing after it. Found live:
    // flush() was printing the closing fence as a line of source.
    expect(render("```ts\nconst x = 1;\n```", plainTheme)).toBe("  const x = 1;\n");
    expect(render("```\nx\n```", plainTheme)).toBe("  x\n");
  });

  test("an indented closing fence still closes", () => {
    expect(render("```\nx\n  ```", plainTheme)).toBe("  x\n");
  });

  test("highlighter state is per fence, not per stream", () => {
    // The first fence leaves an open block comment; the second must not inherit it.
    const out = render("```ts\n/* open\n```\n```ts\nconst x = 1;\n```\n", tagTheme);
    expect(out).toContain("<keyword>const</keyword>");
  });
});

describe("streaming behaviour", () => {
  test("prose is written before its line ends — no line buffering", () => {
    const { md, out } = harness();
    md.push("Hello wor");
    // If this renderer buffered lines, `out()` would still be empty here.
    expect(out()).toBe("Hello wor");
  });

  test("a structural line commits after at most a few characters", () => {
    const { md, out } = harness(tagTheme);
    md.push("#");
    expect(out()).toBe(""); // still ambiguous: `#` or `## `?
    md.push(" ");
    expect(out()).toBe("<h1>"); // decided, and the style is already open
    md.push("Hi");
    expect(out()).toBe("<h1>Hi");
  });

  test("bold streams live rather than waiting for the closing marker", () => {
    const { md, out } = harness(tagTheme);
    md.push("**strea");
    expect(out()).toBe("<b>strea");
  });

  test("code fences buffer by line, because half a token cannot be lexed", () => {
    const { md, out } = harness(tagTheme);
    md.push("```ts\nconst");
    expect(out()).toBe("");
    md.push("\n");
    expect(out()).toBe("  <keyword>const</keyword>\n");
  });

  test("flush is idempotent", () => {
    const { md, out } = harness();
    md.push("x");
    md.flush();
    md.flush();
    expect(out()).toBe("x\n");
  });

  test("flushing an empty stream writes nothing", () => {
    const { md, out } = harness();
    md.flush();
    expect(out()).toBe("");
  });
});

describe("chunk invariance", () => {
  const corpus = [
    "# Title\n\nSome **bold** and *em* and `code`.\n",
    "- a\n- b\n  - c\n\n1. one\n2. two\n",
    "> quoted **text**\n\n---\n\nafter\n",
    "```ts\nconst x: number = 1; // note\n```\n",
    "```python\ndef f():\n    \"\"\"doc\n    still doc\"\"\"\n    return None\n```\n",
    "mixed `a*b` then **c `d` e** end\n",
    "snake_case and 2 * 3 and \\*escaped\\*\n",
    "no trailing newline",
    "**unclosed and ```\nfence\n",
    "",
    "\n\n\n",
    "emoji 😀 **bold 😀**\n",
  ];

  // Chunking is decided by the network, not by us: a delta may split any
  // construct at any character. Output must not depend on where the cuts fall.
  for (const chunk of [1, 2, 3, 5, 7]) {
    test.each(corpus)(`chunk=${chunk} matches whole-string render: %p`, (src) => {
      expect(render(src, tagTheme, chunk)).toBe(render(src, tagTheme));
    });
  }
});

describe("plain text fidelity", () => {
  // With no styling, the output is the markdown with its markers removed.
  test.each([
    ["**bold**\n", "bold\n"],
    ["*em*\n", "em\n"],
    ["`code`\n", "code\n"],
    ["# H\n", "H\n"],
    ["- x\n", "• x\n"],
    ["> q\n", "│ q\n"],
    ["plain\n", "plain\n"],
  ])("%p renders as %p", (src, expected) => {
    expect(render(src, plainTheme)).toBe(expected);
  });
});
