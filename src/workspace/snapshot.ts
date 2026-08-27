import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname, join, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const EXCLUDED_DIRS = new Set([
  ".git",
  ".rocky",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  ".turbo",
  ".cache",
]);
const SECRET_BASENAMES = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|ppk))$/i;

export interface SnapshotOptions {
  maxBytes?: number;
  secretPatterns?: readonly string[];
  persist?: boolean;
}

export interface WorkspaceSnapshot {
  id: string;
  root: string;
  createdAt: string;
  files: string[];
  totalBytes: number;
  manifest: Record<string, string>;
  archive: Uint8Array;
  archivePath?: string;
  manifestPath?: string;
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

function normalizeRelative(root: string, path: string): string {
  const normalized = relative(root, resolve(root, path)).split(sep).join("/");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("\0")) {
    throw new SnapshotError(`unsafe snapshot path: ${path}`);
  }
  return normalized;
}

function wildcardMatches(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("\0", ".*");
  return new RegExp(`^(?:${escaped})$`, "i").test(path);
}

export function snapshotExclusion(path: string, secretPatterns: readonly string[] = []): string | undefined {
  const parts = path.split("/");
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return "generated or internal directory";
  const base = parts.at(-1) ?? "";
  if (SECRET_BASENAMES.test(base)) return "credential-like filename";
  if (secretPatterns.some((pattern) => wildcardMatches(path, pattern))) return "configured secret pattern";
  return undefined;
}

function walk(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const path = normalizeRelative(root, absolute);
    if (snapshotExclusion(path)) continue;
    if (entry.isDirectory()) files.push(...walk(root, absolute));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function gitFiles(root: string): string[] | undefined {
  const probe = Bun.spawnSync(["git", "-C", root, "rev-parse", "--is-inside-work-tree"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (probe.exitCode !== 0) return undefined;
  const listed = Bun.spawnSync(
    ["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (listed.exitCode !== 0) {
    throw new SnapshotError(`git ls-files failed: ${listed.stderr.toString().trim()}`);
  }
  return listed.stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((path) => normalizeRelative(root, path));
}

function writeOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0") + "\0";
  header.set(Buffer.from(text, "ascii"), offset);
}

function tarHeader(path: string, size: number, mode: number): Uint8Array {
  let nameText = path;
  let prefixText = "";
  if (Buffer.byteLength(nameText) > 100) {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) throw new SnapshotError(`snapshot path is too long for archive: ${path}`);
    prefixText = path.slice(0, slash);
    nameText = path.slice(slash + 1);
  }
  const name = Buffer.from(nameText, "utf8");
  const prefix = Buffer.from(prefixText, "utf8");
  if (name.length > 100 || prefix.length > 155) {
    throw new SnapshotError(`snapshot path is too long for archive: ${path}`);
  }
  const header = new Uint8Array(512);
  header.set(name, 0);
  writeOctal(header, 100, 8, mode & 0o777);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.set(Buffer.from("ustar\0", "ascii"), 257);
  header.set(Buffer.from("00", "ascii"), 263);
  header.set(prefix, 345);
  writeOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
  return header;
}

function buildTar(root: string, files: readonly string[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let bytes = 1024;
  for (const path of files) {
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    if (!stat.isFile()) continue;
    const data = readFileSync(absolute);
    const padding = (512 - (data.length % 512)) % 512;
    chunks.push(tarHeader(path, data.length, stat.mode), data, new Uint8Array(padding));
    bytes += 512 + data.length + padding;
  }
  chunks.push(new Uint8Array(1024));
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
}

export function createWorkspaceSnapshot(rootInput: string, options: SnapshotOptions = {}): WorkspaceSnapshot {
  const root = resolve(rootInput);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const secretPatterns = options.secretPatterns ?? [];
  const candidates = gitFiles(root) ?? walk(root);
  const files = [...new Set(candidates)]
    .filter((path) => snapshotExclusion(path, secretPatterns) === undefined)
    .filter((path) => {
      try {
        return lstatSync(join(root, path)).isFile();
      } catch {
        return false;
      }
    })
    .sort();

  const manifest: Record<string, string> = {};
  let totalBytes = 0;
  for (const path of files) {
    const data = readFileSync(join(root, path));
    totalBytes += data.length;
    if (totalBytes > maxBytes) {
      throw new SnapshotError(
        `workspace snapshot is ${(totalBytes / 1024 / 1024).toFixed(1)} MiB; limit is ${(maxBytes / 1024 / 1024).toFixed(1)} MiB`,
      );
    }
    manifest[path] = sha256(data);
  }

  const createdAt = new Date().toISOString();
  const id = sha256(JSON.stringify({ manifest, totalBytes })).slice(0, 24);
  const archive = gzipSync(buildTar(root, files), { level: 9 });
  const snapshot: WorkspaceSnapshot = { id, root, createdAt, files, totalBytes, manifest, archive };

  if (options.persist !== false) {
    const dir = join(root, ".rocky", "snapshots");
    mkdirSync(dir, { recursive: true });
    const archivePath = join(dir, `${id}.tar.gz`);
    const manifestPath = join(dir, `${id}.json`);
    writeFileSync(archivePath, archive);
    writeFileSync(manifestPath, `${JSON.stringify({ id, root, createdAt, files, totalBytes, manifest }, null, 2)}\n`);
    snapshot.archivePath = archivePath;
    snapshot.manifestPath = manifestPath;
  }
  return snapshot;
}

function readTarString(block: Uint8Array, start: number, length: number): string {
  return Buffer.from(block.subarray(start, start + length)).toString("utf8").replace(/\0.*$/s, "");
}

export function extractSnapshot(archive: Uint8Array, destinationInput: string): string[] {
  const destination = resolve(destinationInput);
  mkdirSync(destination, { recursive: true });
  const tar = gunzipSync(archive);
  const extracted: string[] = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = readTarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const safe = normalizeRelative(destination, path);
    const absolute = resolve(destination, safe);
    if (!absolute.startsWith(`${destination}${sep}`)) throw new SnapshotError(`archive path escapes destination: ${path}`);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new SnapshotError(`truncated snapshot entry: ${path}`);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, tar.subarray(dataStart, dataEnd));
    extracted.push(safe);
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return extracted;
}

export function loadSnapshot(rootInput: string, id: string): WorkspaceSnapshot {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new SnapshotError("invalid snapshot id");
  const root = resolve(rootInput);
  const dir = join(root, ".rocky", "snapshots");
  const manifestPath = join(dir, `${id}.json`);
  const archivePath = join(dir, `${id}.tar.gz`);
  if (!existsSync(manifestPath) || !existsSync(archivePath)) throw new SnapshotError(`snapshot not found: ${id}`);
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Omit<WorkspaceSnapshot, "archive">;
  return { ...parsed, root, archive: readFileSync(archivePath), archivePath, manifestPath };
}

export function currentFileHash(root: string, path: string): string | undefined {
  const absolute = join(root, path);
  return existsSync(absolute) ? sha256(readFileSync(absolute)) : undefined;
}
