import { describe, expect, test } from "bun:test";
import { banner, tildify, type BannerInfo } from "../../src/tui/banner.ts";
import { stripAnsi } from "../../src/tui/ansi.ts";

const info = (over: Partial<BannerInfo> = {}): BannerInfo => ({
  version: "0.1.0",
  model: "nemotron-3-nano:30b-cloud",
  provider: "ollama",
  mode: "ask",
  cwd: "/home/arctic/projects/rocky_code",
  columns: 80,
  home: "/home/arctic",
  ...over,
});

describe("tildify", () => {
  test("replaces the home prefix", () => {
    expect(tildify("/home/a/x", "/home/a")).toBe("~/x");
    expect(tildify("/home/a", "/home/a")).toBe("~");
  });

  test("does not touch lookalike prefixes or foreign paths", () => {
    // `/home/ab` starts with the *string* `/home/a`, but is a different dir.
    expect(tildify("/home/ab/x", "/home/a")).toBe("/home/ab/x");
    expect(tildify("/etc/hosts", "/home/a")).toBe("/etc/hosts");
  });
});

describe("the welcome box", () => {
  test("every row is the same visible width, so the frame is a frame", () => {
    const rows = banner(info()).split("\n");
    const widths = rows.map((r) => [...stripAnsi(r)].length);
    expect(new Set(widths).size).toBe(1);
  });

  test("is framed top and bottom", () => {
    const rows = banner(info()).split("\n").map(stripAnsi);
    expect(rows[0]).toMatch(/^╭─+╮$/);
    expect(rows.at(-1)).toMatch(/^╰─+╯$/);
    for (const row of rows.slice(1, -1)) {
      expect(row.startsWith("│")).toBe(true);
      expect(row.endsWith("│")).toBe(true);
    }
  });

  test("says who is running, on what, from where", () => {
    const text = stripAnsi(banner(info()));
    expect(text).toContain("rocky v0.1.0");
    expect(text).toContain("nemotron-3-nano:30b-cloud · ollama");
    expect(text).toContain("ask · ~/projects/rocky_code");
    expect(text).toContain("/help");
  });

  test("the mascot has no eyes and five legs — Eridians hear, not see", () => {
    const text = stripAnsi(banner(info()));
    expect(text).toContain("╱╱ ┃ ╲╲");
    expect(text).toContain("♫");
  });

  test("never exceeds the terminal width", () => {
    const long = info({
      cwd: "/home/arctic/projects/some/exceedingly/deeply/nested/working/directory",
      columns: 60,
    });
    for (const row of banner(long).split("\n")) {
      expect([...stripAnsi(row)].length).toBeLessThanOrEqual(60);
    }
  });

  test("a line that cannot fit is truncated with an ellipsis, frame intact", () => {
    const out = banner(
      info({ model: "an-extremely-verbosely-named-model:900b-ultra-cloud", columns: 50 }),
    );
    const rows = out.split("\n").map((r) => [...stripAnsi(r)].length);
    expect(new Set(rows).size).toBe(1);
    expect(stripAnsi(out)).toContain("…");
  });

  test("a terminal too narrow for the box gets a plain line, not a broken frame", () => {
    const out = stripAnsi(banner(info({ columns: 30 })));
    expect(out).not.toContain("╭");
    expect(out).toContain("rocky");
    expect(out).toContain("~/projects/rocky_code");
  });

  test("zero columns means unknown, not narrow — a pty can report 0", () => {
    // Found live: script(1) under a non-terminal parent gives a 0×0 pty, and
    // the banner degraded to the fallback line for no reason.
    expect(stripAnsi(banner(info({ columns: 0 })))).toContain("╭");
  });
});
