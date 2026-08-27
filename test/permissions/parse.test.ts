import { describe, expect, test } from "bun:test";
import { basename, expandFlags, parseCommand } from "../../src/permissions/parse.ts";

const tokensOf = (cmd: string) => parseCommand(cmd).segments.map((s) => s.tokens);

describe("parseCommand — tokenizing", () => {
  test("splits on whitespace", () => {
    expect(tokensOf("git status")).toEqual([["git", "status"]]);
  });

  test("collapses runs of whitespace", () => {
    expect(tokensOf("rm    -rf   /tmp")).toEqual([["rm", "-rf", "/tmp"]]);
  });

  test("single quotes protect their contents", () => {
    expect(tokensOf("echo 'a b c'")).toEqual([["echo", "a b c"]]);
  });

  test("double quotes protect their contents and honour escapes", () => {
    expect(tokensOf('echo "a \\"b\\" c"')).toEqual([["echo", 'a "b" c']]);
  });

  test("backslash escapes a space", () => {
    expect(tokensOf("cat my\\ file.txt")).toEqual([["cat", "my file.txt"]]);
  });

  test("line continuations are not tokens", () => {
    expect(tokensOf("bun \\\n test")).toEqual([["bun", "test"]]);
  });
});

describe("parseCommand — splitting", () => {
  test.each([
    ["a && b", 2],
    ["a || b", 2],
    ["a ; b", 2],
    ["a | b", 2],
    ["a & b", 2],
    ["a\nb", 2],
    ["a && b && c", 3],
  ])("%s yields %i segments", (cmd, count) => {
    expect(parseCommand(cmd).segments).toHaveLength(count);
  });

  test("an operator inside quotes is not a separator", () => {
    // The single most important case: this must be ONE echo, not a chained rm.
    expect(tokensOf('echo "rm -rf /"')).toEqual([["echo", "rm -rf /"]]);
    expect(tokensOf("echo 'a && b'")).toEqual([["echo", "a && b"]]);
  });

  test("each segment keeps its own raw text for display", () => {
    const { segments } = parseCommand("bun test && rm -rf /");
    expect(segments[0]!.raw).toBe("bun test");
    expect(segments[1]!.raw).toBe("rm -rf /");
  });

  test("empty segments are dropped", () => {
    expect(parseCommand("a ;; b").segments).toHaveLength(2);
    expect(parseCommand("   ").segments).toHaveLength(0);
  });
});

describe("parseCommand — redirections", () => {
  test("2>&1 is a descriptor dup, not a background operator", () => {
    // Regression: `&` inside 2>&1 used to split the command in two.
    const { segments } = parseCommand("bun run verify.ts 2>&1");
    expect(segments).toHaveLength(1);
    expect(segments[0]!.tokens).toEqual(["bun", "run", "verify.ts"]);
    expect(segments[0]!.redirectsOutput).toBe(false);
  });

  test.each(["cmd >&2", "cmd 2>&1", "cmd 1>&2"])("%s does not write a file", (cmd) => {
    expect(parseCommand(cmd).segments[0]!.redirectsOutput).toBe(false);
  });

  test.each(["cmd > out", "cmd >> out", "cmd &> out", "cmd 2> err"])(
    "%s writes a file",
    (cmd) => {
      expect(parseCommand(cmd).segments[0]!.redirectsOutput).toBe(true);
    },
  );

  test("input redirection does not count as writing", () => {
    expect(parseCommand("cat < in.txt").segments[0]!.redirectsOutput).toBe(false);
    expect(parseCommand("cat <<< text").segments[0]!.redirectsOutput).toBe(false);
  });

  test("the redirection operator is not an argument token", () => {
    expect(parseCommand("bun test > out.txt").segments[0]!.tokens).toEqual([
      "bun",
      "test",
      "out.txt",
    ]);
  });

  test("a redirect attaches only to its own segment", () => {
    const { segments } = parseCommand("bun test > out.txt && git status");
    expect(segments[0]!.redirectsOutput).toBe(true);
    expect(segments[1]!.redirectsOutput).toBe(false);
  });

  test("a quoted angle bracket is not a redirection", () => {
    const { segments } = parseCommand('echo "a > b"');
    expect(segments[0]!.tokens).toEqual(["echo", "a > b"]);
    expect(segments[0]!.redirectsOutput).toBe(false);
  });

  test("&& is still an operator, not a redirect", () => {
    expect(parseCommand("a && b").segments).toHaveLength(2);
  });

  test("a lone & still backgrounds", () => {
    expect(parseCommand("a & b").segments).toHaveLength(2);
  });
});

describe("parseCommand — dynamic detection", () => {
  test.each([
    "echo $(whoami)",
    "echo `whoami`",
    "diff <(a) <(b)",
    "eval 'rm -rf /'",
    "exec sh",
    "source ./x.sh",
  ])("%s is dynamic", (cmd) => {
    expect(parseCommand(cmd).dynamic).toBe(true);
  });

  test("plain commands are not dynamic", () => {
    expect(parseCommand("bun test && git status").dynamic).toBe(false);
  });

  test("dynamic marks only the offending segment", () => {
    const { segments } = parseCommand("bun test && echo $(id)");
    expect(segments[0]!.dynamic).toBe(false);
    expect(segments[1]!.dynamic).toBe(true);
  });

  test("a plain variable reference is not treated as dynamic", () => {
    expect(parseCommand("echo $HOME").dynamic).toBe(false);
  });
});

describe("expandFlags", () => {
  test("separates positionals from flags", () => {
    const { positionals, flags } = expandFlags(["status", "--short", "-v"]);
    expect(positionals).toEqual(["status"]);
    expect([...flags].sort()).toEqual(["--short", "-v"]);
  });

  test("bundled short flags decompose, and the bundle itself is not kept", () => {
    const { flags } = expandFlags(["-rf"]);
    expect([...flags].sort()).toEqual(["-f", "-r"]);
    expect(flags.has("-rf")).toBe(false);
  });

  test("-rf and -r -f produce the same flag set", () => {
    expect([...expandFlags(["-rf"]).flags].sort()).toEqual(
      [...expandFlags(["-r", "-f"]).flags].sort(),
    );
  });

  test("long flags drop their value", () => {
    expect(expandFlags(["--depth=1"]).flags.has("--depth")).toBe(true);
  });

  test("a bare -- separator is ignored", () => {
    expect(expandFlags(["--", "file"]).positionals).toEqual(["file"]);
  });

  test("a lone dash is a positional, not a flag", () => {
    expect(expandFlags(["-"]).positionals).toEqual(["-"]);
  });
});

describe("basename", () => {
  test("strips directories so /bin/rm matches rm", () => {
    expect(basename("/bin/rm")).toBe("rm");
    expect(basename("rm")).toBe("rm");
    expect(basename("/usr/local/bin/bun")).toBe("bun");
  });
});
