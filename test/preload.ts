/**
 * Point every Rocky-owned path at a scratch home for the whole suite.
 *
 * `loadConfig` reads `~/.config/rocky/config.json` unconditionally — that is
 * the product's behaviour and it is correct — so without this a developer who
 * has actually used Rocky runs the suite against their own registry and watches
 * `loadConfig` tests fail with their own `activeProvider`. CI has no config, so
 * the failure only ever appears locally, which is the worst place for it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["ROCKY_HOME"] ??= mkdtempSync(join(tmpdir(), "rocky-home-"));
