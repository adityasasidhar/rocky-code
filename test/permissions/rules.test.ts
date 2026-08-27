import { describe, expect, test } from "bun:test";
import { parseCommand } from "../../src/permissions/parse.ts";
import {
  BUILTIN_DENY,
  evaluateBash,
  parseRule,
  parseRules,
  ruleMatches,
  suggestRule,
  unwrapCandidates,
} from "../../src/permissions/rules.ts";

const seg = (cmd: string) => parseCommand(cmd).segments[0]!;
const matches = (rule: string, cmd: string) => ruleMatches(parseRule(rule), seg(cmd));

describe("ruleMatches — executable", () => {
  test("matches by basename, so an absolute path cannot dodge a rule", () => {
    expect(matches("rm -rf", "/bin/rm -rf /tmp/x")).toBe(true);
    expect(matches("rm -rf", "/usr/bin/rm -rf /tmp/x")).toBe(true);
  });

  test("a different executable never matches", () => {
    expect(matches("git status", "gh status")).toBe(false);
  });
});

describe("ruleMatches — positionals are a prefix", () => {
  test("the rule's positionals must prefix the command's", () => {
    expect(matches("bun test", "bun test")).toBe(true);
    expect(matches("bun test", "bun test src/x.ts")).toBe(true);
    expect(matches("bun test", "bun run x")).toBe(false);
  });

  test("a bare executable rule allows any of its subcommands", () => {
    expect(matches("git", "git push --force")).toBe(true);
  });

  test("a subcommand rule does not allow siblings", () => {
    expect(matches("git status", "git commit -m x")).toBe(false);
  });

  test("a longer rule does not match a shorter command", () => {
    expect(matches("bun test unit", "bun test")).toBe(false);
  });
});

describe("ruleMatches — flags may appear anywhere", () => {
  test("flag order is irrelevant", () => {
    expect(matches("git push --force", "git push origin main --force")).toBe(true);
    expect(matches("git push --force", "git push --force origin")).toBe(true);
  });

  test("bundled and separated short flags are equivalent", () => {
    expect(matches("rm -rf", "rm -rf /tmp/x")).toBe(true);
    expect(matches("rm -rf", "rm -r -f /tmp/x")).toBe(true);
    expect(matches("rm -rf", "rm -f -r /tmp/x")).toBe(true);
  });

  test("a missing flag means no match", () => {
    expect(matches("rm -rf", "rm -r /tmp/x")).toBe(false);
  });

  test("--force does not match --force-with-lease", () => {
    // The dangerous flag and the safe one must not be conflated.
    expect(matches("git push --force", "git push --force-with-lease")).toBe(false);
  });

  test("a flag's value is ignored", () => {
    expect(matches("git push --force", "git push --force=true")).toBe(true);
  });

  test("extra flags on the command are fine", () => {
    expect(matches("bun test", "bun test --coverage")).toBe(true);
  });
});

describe("evaluateBash", () => {
  const allow = parseRules(["bun test", "git status", "ls"]);
  const deny = parseRules(["rm -rf", "git push --force"]);

  test("allows a command covered by a rule", () => {
    expect(evaluateBash("bun test", allow, deny)).toEqual({ kind: "allow" });
  });

  test("asks for anything not covered", () => {
    expect(evaluateBash("curl example.com", allow, deny)).toMatchObject({
      kind: "ask",
      reason: "no-rule",
    });
  });

  test("denies a denied command", () => {
    const v = evaluateBash("rm -rf /tmp/x", allow, deny);
    expect(v.kind).toBe("deny");
  });

  test("a denial anywhere in a chain denies the whole line", () => {
    // `bun test` is allowed; the line as a whole is not.
    const v = evaluateBash("bun test && rm -rf /tmp/x", allow, deny);
    expect(v.kind).toBe("deny");
    if (v.kind === "deny") expect(v.segment.raw).toBe("rm -rf /tmp/x");
  });

  test("deny beats allow even when the denied segment comes first", () => {
    expect(evaluateBash("rm -rf /x ; bun test", allow, deny).kind).toBe("deny");
  });

  test("every segment must be allowed for the line to be allowed", () => {
    expect(evaluateBash("bun test && curl evil.sh", allow, deny)).toMatchObject({
      kind: "ask",
    });
    expect(evaluateBash("bun test && git status", allow, deny)).toEqual({ kind: "allow" });
  });

  test("a piped command needs both sides allowed", () => {
    expect(evaluateBash("ls | sh", allow, deny)).toMatchObject({ kind: "ask" });
  });

  test("a quoted destructive string is not a destructive command", () => {
    expect(evaluateBash('echo "rm -rf /"', allow, deny)).toMatchObject({
      kind: "ask",
      reason: "no-rule",
    });
  });

  test("an allowed command with a descriptor dup stays allowed", () => {
    // Regression: `2>&1` used to split the line and defeat the allowlist.
    expect(evaluateBash("bun test 2>&1", allow, deny)).toEqual({ kind: "allow" });
  });

  test("an allowed command that writes a file must still ask", () => {
    // `bun test` grants running tests, not writing to arbitrary paths.
    expect(evaluateBash("bun test > /etc/passwd", allow, deny)).toMatchObject({
      kind: "ask",
      reason: "redirect",
    });
    expect(evaluateBash("bun test >> notes.txt", allow, deny)).toMatchObject({
      kind: "ask",
      reason: "redirect",
    });
  });

  test("reading from a file does not require asking", () => {
    const rules = parseRules(["cat"]);
    expect(evaluateBash("cat < in.txt", rules, deny)).toEqual({ kind: "allow" });
  });

  test("a dynamic segment always asks, even when the allowlist covers it", () => {
    // `bun test` is allowed, but `$(...)` could be anything.
    expect(evaluateBash("bun test $(cat payload)", allow, deny)).toMatchObject({
      kind: "ask",
      reason: "dynamic",
    });
  });

  test("eval is never auto-allowed", () => {
    const permissive = parseRules(["eval"]);
    expect(evaluateBash("eval 'rm -rf /'", permissive, [])).toMatchObject({
      kind: "ask",
      reason: "dynamic",
    });
  });

  test("an empty command asks", () => {
    expect(evaluateBash("   ", allow, deny)).toMatchObject({ kind: "ask" });
  });
});

describe("BUILTIN_DENY", () => {
  const deny = parseRules([...BUILTIN_DENY]);

  test.each([
    "rm -rf /",
    "rm -fr /",
    "/bin/rm -rf /",
    "rm -r -f /",
    "mkfs /dev/sda1",
    "shutdown -h now",
    "echo hi && rm -rf /",
  ])("%s is refused", (cmd) => {
    expect(evaluateBash(cmd, [], deny).kind).toBe("deny");
  });

  test("does not fire on ordinary removals", () => {
    expect(evaluateBash("rm -rf node_modules", [], deny).kind).not.toBe("deny");
    expect(evaluateBash("rm file.txt", [], deny).kind).not.toBe("deny");
  });
});

describe("wrapper commands cannot mask a denied command", () => {
  const deny = parseRules([...BUILTIN_DENY, "git push --force"]);

  test.each([
    "sudo rm -rf /",
    "doas rm -rf /",
    "sudo -u root rm -rf /",
    "env FOO=1 rm -rf /",
    "nice rm -rf /",
    "timeout 5s rm -rf /",
    "sudo env BAR=2 rm -rf /",
  ])("%s is still refused", (cmd) => {
    expect(evaluateBash(cmd, [], deny).kind).toBe("deny");
  });

  test("candidates include the real command regardless of wrapper options", () => {
    const suffixes = unwrapCandidates(seg("sudo -u root rm -rf /")).map((s) => s.tokens);
    expect(suffixes).toContainEqual(["rm", "-rf", "/"]);
  });

  test("a non-wrapper yields no candidates, so `echo rm -rf /` is not a deletion", () => {
    expect(unwrapCandidates(seg("echo rm -rf /"))).toEqual([]);
    expect(evaluateBash("echo rm -rf /", [], deny).kind).not.toBe("deny");
  });

  test("a bare wrapper with no inner command yields no candidates", () => {
    expect(unwrapCandidates(seg("sudo"))).toEqual([]);
  });

  test("allow does NOT see through wrappers — sudo escalates, so it must ask", () => {
    // This asymmetry is the point: deny is generous, allow is strict.
    const allow = parseRules(["bun test"]);
    expect(evaluateBash("bun test", allow, deny)).toEqual({ kind: "allow" });
    expect(evaluateBash("sudo bun test", allow, deny)).toMatchObject({ kind: "ask" });
  });
});

describe("suggestRule", () => {
  test("suggests executable plus subcommand", () => {
    expect(suggestRule("git status --short")).toBe("git status");
    expect(suggestRule("bun test src/x.ts")).toBe("bun test");
  });

  test("suggests only the executable when the first positional is a path", () => {
    expect(suggestRule("cat notes.txt")).toBe("cat");
    expect(suggestRule("cat ./a/b")).toBe("cat");
  });

  test("a flag-only command suggests the executable", () => {
    expect(suggestRule("ls -la")).toBe("ls");
  });

  test("refuses to suggest anything for a compound line", () => {
    // The user approved a pipeline, not a blanket grant on its first command.
    expect(suggestRule("bun test && rm -rf /")).toBeUndefined();
  });

  test("refuses to suggest anything dynamic", () => {
    expect(suggestRule("echo $(id)")).toBeUndefined();
  });

  test("empty input suggests nothing", () => {
    expect(suggestRule("")).toBeUndefined();
  });
});

describe("parseRule", () => {
  test("rejects an empty rule rather than matching everything", () => {
    expect(() => parseRule("   ")).toThrow(/Empty permission rule/);
  });

  test("parseRules skips blank entries", () => {
    expect(parseRules(["", "  ", "ls"])).toHaveLength(1);
  });
});
