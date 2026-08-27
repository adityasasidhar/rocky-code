import { bold, colorDiff, cyan, dim, gray, red, yellow } from "../tui/ansi.ts";
import type { Answer, AskFn, PermissionRequest } from "./engine.ts";

const MAX_PREVIEW_LINES = 40;

/** Everything the user needs to decide, and nothing they have to go look up. */
export function renderRequest(request: PermissionRequest): string {
  const lines: string[] = ["", yellow(`${bold("Permission required")} · ${request.tool.name}`)];

  if (request.command !== undefined) {
    lines.push("", indent(bold(request.command)));
  } else {
    lines.push("", indent(bold(request.title)));
  }

  // A preview that just repeats the headline (bash's preview is the command
  // itself) would print the same thing twice; only show what adds information.
  const headline = request.command ?? request.title;
  if (request.preview && request.preview.trim() !== headline.trim()) {
    const preview = request.preview.split("\n");
    const shown = preview.slice(0, MAX_PREVIEW_LINES);
    lines.push("", indent(colorDiff(shown.join("\n"))));
    if (preview.length > MAX_PREVIEW_LINES) {
      lines.push(indent(gray(`… ${preview.length - MAX_PREVIEW_LINES} more lines`)));
    }
  }

  if (request.onceOnly) {
    lines.push("", `  ${cyan("y")} yes, once     ${cyan("n")} no`, "");
  } else {
    const always = request.command
      ? request.suggestion
        ? `always allow ${bold(request.suggestion)} this session`
        : "always allow this tool this session"
      : `always allow ${bold(request.tool.name)} this session`;
    lines.push(
      "",
      `  ${cyan("y")} yes, once     ${cyan("n")} no     ${cyan("a")} ${always}`,
      `  ${cyan("p")} always, and save it to .rocky/settings.json`,
      "",
    );
  }
  return lines.join("\n");
}

const indent = (s: string, pad = "    ") =>
  s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");

/**
 * Read a single keypress. Falls back to line-reading when raw mode is
 * unavailable (some terminals, some CI shells).
 */
async function readKey(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: stdin, output: process.stderr });
    const answer = await rl.question("");
    rl.close();
    return (answer.trim()[0] ?? "n").toLowerCase();
  }

  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string>((resolve) => {
      const onData = (buf: Buffer) => {
        stdin.off("data", onData);
        const key = buf.toString("utf8");
        // Ctrl-C and Esc both mean "no".
        if (key === "\x03" || key === "\x1b") resolve("n"); // Ctrl-C, Esc
        else resolve(key.trim().toLowerCase() || "n");
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

/** Interactive prompt against a TTY. */
export function ttyAsk(out: NodeJS.WriteStream = process.stdout): AskFn {
  return async (request) => {
    out.write(`${renderRequest(request)}\n`);
    for (;;) {
      out.write(`${cyan("›")} `);
      const key = await readKey();
      out.write(`${key}\n`);
      const answer = interpret(key);
      if (request.onceOnly && answer && answer.kind !== "once" && answer.kind !== "no") {
        out.write(dim("  this action requires y or n\n"));
        continue;
      }
      if (answer) return answer;
      out.write(dim(request.onceOnly ? "  press y or n\n" : "  press y, n, a, or p\n"));
    }
  };
}

export function interpret(key: string): Answer | undefined {
  switch (key) {
    case "y":
      return { kind: "once" };
    // Enter, Esc, and Ctrl-C all arrive here as "n": the safe default is no.
    case "n":
    case "q":
      return { kind: "no" };
    case "a":
      return { kind: "session" };
    case "p":
      return { kind: "persist" };
    default:
      return undefined;
  }
}

/**
 * Ask through the footer UI's permission dialog. The dialog vanishes once
 * answered, so the decision is echoed into scrollback — transcripts keep what
 * dialogs cannot.
 */
export function footerAsk(store: {
  askPermission: (request: PermissionRequest) => Promise<Answer>;
}): AskFn {
  return async (request) => {
    const answer = await store.askPermission(request);
    const label =
      answer.kind === "once"
        ? "allowed once"
        : answer.kind === "session"
          ? "allowed for this session"
          : answer.kind === "persist"
            ? "allowed and saved"
            : "denied";
    console.log(
      `${yellow("Permission")} ${bold(request.tool.name)} ${dim(
        `(${request.command ?? request.title})`,
      )} → ${label}`,
    );
    return answer;
  };
}

/**
 * There is no one to ask. Refusing is the only safe answer, and the message has
 * to tell the operator exactly how to make the call succeed next time.
 */
export function nonInteractiveAsk(): AskFn {
  return async (request) => {
    const fix = request.suggestion
      ? `add "${request.suggestion}" to \`allow\` in .rocky/config.json`
      : request.command
        ? "add an `allow` rule to .rocky/config.json"
        : `add "${request.tool.name}" to \`allowTools\` in .rocky/settings.json`;

    return {
      kind: "no",
      reason:
        `no terminal available to ask for permission. ` +
        `Re-run with --yolo, use --permission-mode auto-edit, or ${fix}.`,
    };
  };
}

/** Print a denial the same way in both modes. */
export const formatDenial = (name: string, reason: string): string =>
  `${red("✗")} ${bold(name)} ${dim(reason)}`;
