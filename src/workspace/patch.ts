import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceSnapshot } from "./snapshot.ts";
import { currentFileHash } from "./snapshot.ts";

export interface PatchSummary {
  files: string[];
  additions: number;
  deletions: number;
}

export interface ApplyPatchResult extends PatchSummary {
  checkpointId: string;
  applied: true;
}

interface Checkpoint {
  id: string;
  createdAt: string;
  files: string[];
  absent: string[];
  postHashes: Record<string, string | null>;
}

export class WorkspacePatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePatchError";
  }
}

function safePatchPath(raw: string): string | undefined {
  const value = raw.split("\t", 1)[0] ?? "";
  if (value === "/dev/null") return undefined;
  if (value.startsWith('"') || value.includes("\0") || value.includes("\\")) {
    throw new WorkspacePatchError(`quoted, backslash, or NUL-containing patch paths are not supported: ${value}`);
  }
  const withoutPrefix = value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
  const path = normalize(withoutPrefix).split(sep).join("/");
  if (
    !path ||
    path === "." ||
    isAbsolute(withoutPrefix) ||
    /^[A-Za-z]:/.test(withoutPrefix) ||
    path === ".." ||
    path.startsWith("../")
  ) {
    throw new WorkspacePatchError(`unsafe patch path: ${value}`);
  }
  const first = path.split("/", 1)[0]?.toLowerCase();
  if (first === ".git" || first === ".rocky") {
    throw new WorkspacePatchError(`patch cannot modify Rocky or Git control data: ${value}`);
  }
  return path;
}

export function inspectPatch(patch: string): PatchSummary {
  if (patch.includes("GIT binary patch") || /^(?:Binary files|literal \d+|delta \d+)/m.test(patch)) {
    throw new WorkspacePatchError("binary patches are not supported in this release");
  }
  if (/^(?:new file mode|old mode|new mode) 120000$/m.test(patch)) {
    throw new WorkspacePatchError("patches that create or modify symlinks are not supported");
  }
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const path = safePatchPath(line.slice(4));
      if (path) files.add(path);
    } else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  if (files.size === 0) throw new WorkspacePatchError("patch does not contain any file changes");
  return { files: [...files].sort(), additions, deletions };
}

function assertNoSymlinkEscape(rootInput: string, path: string): void {
  const root = resolve(rootInput);
  const parts = path.split("/");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new WorkspacePatchError(`patch path crosses a symlink: ${path}`);
    }
  }
  const target = resolve(root, path);
  if (!target.startsWith(`${root}${sep}`)) throw new WorkspacePatchError(`patch path escapes workspace: ${path}`);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new WorkspacePatchError(`patch target is a symlink: ${path}`);
  }
}

function runGitApply(root: string, patchPath: string, check: boolean): void {
  const args = ["git", "-C", root, "apply", "--whitespace=nowarn"];
  if (check) args.push("--check");
  args.push(patchPath);
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const action = check ? "validation" : "application";
    throw new WorkspacePatchError(`patch ${action} failed: ${result.stderr.toString().trim()}`);
  }
}

function checkpointDir(root: string, id: string): string {
  return join(root, ".rocky", "checkpoints", id);
}

function saveCheckpoint(root: string, id: string, files: readonly string[]): Checkpoint {
  const dir = checkpointDir(root, id);
  mkdirSync(join(dir, "files"), { recursive: true });
  const absent: string[] = [];
  for (const path of files) {
    const source = join(root, path);
    if (!existsSync(source)) {
      absent.push(path);
      continue;
    }
    const destination = join(dir, "files", path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  const metadata: Checkpoint = {
    id,
    createdAt: new Date().toISOString(),
    files: [...files],
    absent,
    postHashes: {},
  };
  writeFileSync(join(dir, "checkpoint.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

function writeCheckpoint(root: string, checkpoint: Checkpoint): void {
  writeFileSync(
    join(checkpointDir(root, checkpoint.id), "checkpoint.json"),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
  );
  const latest = join(root, ".rocky", "checkpoints", "latest");
  writeFileSync(latest, `${checkpoint.id}\n`);
}

function assertSnapshotFresh(root: string, snapshot: WorkspaceSnapshot, files: readonly string[]): void {
  for (const path of files) {
    const expected = snapshot.manifest[path];
    const actual = currentFileHash(root, path);
    if (expected !== actual) {
      throw new WorkspacePatchError(
        `workspace changed since snapshot for ${path}; expected ${expected ?? "absent"}, found ${actual ?? "absent"}`,
      );
    }
  }
}

export function applyWorkspacePatch(
  rootInput: string,
  snapshot: WorkspaceSnapshot,
  patch: string,
  authorized = false,
): ApplyPatchResult {
  if (!authorized) throw new WorkspacePatchError("human approval is required before applying a workspace patch");
  const root = resolve(rootInput);
  if (resolve(snapshot.root) !== root) throw new WorkspacePatchError("snapshot belongs to a different workspace");
  const summary = inspectPatch(patch);
  for (const path of summary.files) assertNoSymlinkEscape(root, path);
  assertSnapshotFresh(root, snapshot, summary.files);

  const tempDir = join(root, ".rocky", "tmp");
  mkdirSync(tempDir, { recursive: true });
  const patchPath = join(tempDir, `${randomUUID()}.patch`);
  writeFileSync(patchPath, patch, "utf8");
  try {
    runGitApply(root, patchPath, true);
    const checkpoint = saveCheckpoint(root, randomUUID(), summary.files);
    try {
      runGitApply(root, patchPath, false);
    } catch (error) {
      rmSync(checkpointDir(root, checkpoint.id), { recursive: true, force: true });
      throw error;
    }
    for (const path of summary.files) checkpoint.postHashes[path] = currentFileHash(root, path) ?? null;
    writeCheckpoint(root, checkpoint);
    return { ...summary, checkpointId: checkpoint.id, applied: true };
  } finally {
    rmSync(patchPath, { force: true });
  }
}

function readCheckpoint(root: string, id?: string): Checkpoint {
  const selected = id ?? readFileSync(join(root, ".rocky", "checkpoints", "latest"), "utf8").trim();
  if (!/^[0-9a-f-]{36}$/i.test(selected)) throw new WorkspacePatchError("invalid checkpoint id");
  const path = join(checkpointDir(root, selected), "checkpoint.json");
  if (!existsSync(path)) throw new WorkspacePatchError(`checkpoint not found: ${selected}`);
  return JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
}

export function undoWorkspacePatch(rootInput: string, authorized = false, id?: string): Checkpoint {
  if (!authorized) throw new WorkspacePatchError("human approval is required before undoing a workspace patch");
  const root = resolve(rootInput);
  const checkpoint = readCheckpoint(root, id);
  for (const path of checkpoint.files) {
    const expected = checkpoint.postHashes[path] ?? undefined;
    const actual = currentFileHash(root, path);
    if (expected !== actual) {
      throw new WorkspacePatchError(`cannot undo ${path}: it changed after the patch was applied`);
    }
  }
  for (const path of checkpoint.files) {
    const target = join(root, path);
    if (checkpoint.absent.includes(path)) {
      if (existsSync(target)) unlinkSync(target);
      continue;
    }
    const source = join(checkpointDir(root, checkpoint.id), "files", path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  return checkpoint;
}

export function patchDigest(patch: string): string {
  return createHash("sha256").update(patch).digest("hex");
}
