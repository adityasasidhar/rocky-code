import type { WorkerKind } from "../config/schema.ts";
import type { AdapterInvocation, WorkerAdapter, WorkerEvent } from "./types.ts";

const at = (): string => new Date().toISOString();

function event(type: WorkerEvent["type"], text?: string, rawType?: string, tool?: string): WorkerEvent {
  return {
    type,
    at: at(),
    ...(text ? { text } : {}),
    ...(rawType ? { rawType } : {}),
    ...(tool ? { tool } : {}),
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = object(value);
  for (const key of ["text", "message", "content", "output", "summary", "result"]) {
    const candidate = record?.[key];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function parseJson(line: string): Record<string, unknown> | undefined {
  try {
    return object(JSON.parse(line));
  } catch {
    return undefined;
  }
}

const codex: WorkerAdapter = {
  kind: "codex",
  invocation(profile, prompt): AdapterInvocation {
    return {
      command: [
        "codex",
        "exec",
        "--json",
        "--ephemeral",
        // The worker already runs inside Rocky's hardened, disposable Docker
        // boundary. A second bubblewrap sandbox cannot create namespaces under
        // no-new-privileges and would prevent all workspace mutations.
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        ...(profile.model ? ["--model", profile.model] : []),
        prompt,
      ],
      // The worker root filesystem is read-only, while /tmp is writable and
      // already exists in every container. Codex creates its state directory.
      env: { CODEX_HOME: "/tmp" },
    };
  },
  parseLine(line) {
    const value = parseJson(line);
    if (!value) return line.trim() ? event("message", line, "plain-text-fallback") : undefined;
    const type = String(value["type"] ?? value["event"] ?? "event");
    const item = object(value["item"]);
    const itemType = String(item?.["type"] ?? "");
    const text = textOf(item) ?? textOf(value);
    if (/reason|thinking/i.test(type) || /reason/i.test(itemType)) return event("thinking", text, type);
    if (/command|tool/i.test(type) || /command|tool/i.test(itemType)) {
      return event("tool", text, type, String(item?.["name"] ?? value["name"] ?? itemType));
    }
    if (/fail|error/i.test(type)) return event("failed", text, type);
    if (/complete|turn\.completed|result/i.test(type)) return event("completed", text, type);
    return text ? event("message", text, type) : undefined;
  },
};

const claude: WorkerAdapter = {
  kind: "claude",
  invocation(profile, prompt): AdapterInvocation {
    return {
      command: [
        "claude",
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        ...(profile.model ? ["--model", profile.model] : []),
        prompt,
      ],
      env: { CLAUDE_CONFIG_DIR: "/tmp/claude" },
    };
  },
  parseLine(line) {
    const value = parseJson(line);
    if (!value) return line.trim() ? event("message", line, "plain-text-fallback") : undefined;
    const type = String(value["type"] ?? "event");
    const subtype = String(value["subtype"] ?? "");
    const message = object(value["message"]);
    const text = textOf(value) ?? textOf(message);
    if (type === "system" && subtype === "init") return event("started", text, `${type}.${subtype}`);
    if (/tool/i.test(type) || /tool/i.test(subtype)) return event("tool", text, type, subtype || type);
    if (type === "result") return event(value["is_error"] ? "failed" : "completed", text, type);
    if (/error/i.test(type)) return event("failed", text, type);
    return text ? event("message", text, type) : undefined;
  },
};

const opencode: WorkerAdapter = {
  kind: "opencode",
  invocation(profile, prompt): AdapterInvocation {
    return {
      command: [
        "opencode",
        "run",
        "--format",
        "json",
        ...(profile.model ? ["--model", profile.model] : []),
        prompt,
      ],
      env: { XDG_CONFIG_HOME: "/tmp/opencode-config", XDG_DATA_HOME: "/tmp/opencode-data" },
    };
  },
  parseLine(line) {
    const value = parseJson(line);
    if (!value) return line.trim() ? event("message", line, "plain-text-fallback") : undefined;
    const type = String(value["type"] ?? value["event"] ?? "event");
    const text = textOf(value) ?? textOf(value["part"]);
    if (/tool|command/i.test(type)) return event("tool", text, type, String(value["name"] ?? type));
    if (/error|fail/i.test(type)) return event("failed", text, type);
    if (/complete|finish|result/i.test(type)) return event("completed", text, type);
    return text ? event("message", text, type) : undefined;
  },
};

const fixture: WorkerAdapter = {
  kind: "fixture",
  invocation(_profile, prompt): AdapterInvocation {
    return { command: ["sh", "-lc", prompt], env: {} };
  },
  parseLine(line) {
    return line.trim() ? event("message", line, "fixture") : undefined;
  },
};

const adapters: Record<WorkerKind, WorkerAdapter> = { codex, claude, opencode, fixture };

export function adapterFor(kind: WorkerKind): WorkerAdapter {
  return adapters[kind];
}

export function parseWorkerStream(kind: WorkerKind, input: string): WorkerEvent[] {
  const adapter = adapterFor(kind);
  return input
    .split(/\r?\n/)
    .map((line) => adapter.parseLine(line))
    .filter((value): value is WorkerEvent => value !== undefined);
}
