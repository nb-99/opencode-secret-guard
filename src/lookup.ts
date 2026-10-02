import * as childProcess from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type LookupMode = "sensitive" | "insensitive" | "unknown";
export type ReadDirectoryModes = (target: string) => LookupMode[];

// Keep the input bounds in sync with native/path-lookup.c. Path bytes include
// the NUL terminator. The output limit covers the worst-case component count.
const maxPathBytes = 4096;
const maxBatchPaths = 256;
const maxBatchBytes = 64 * 1024;
const maxOutputBytes = 1024 * 1024;
// Fixed package-relative location, never PATH or user configuration. A source
// checkout without the bundled helper deliberately reports unknown metadata.
const helper = fileURLToPath(new URL("../bin/path-lookup", import.meta.url));

function modeCount(target: string): number {
  // Bound fallback allocation even for an oversized hostile input. Missing
  // metadata slots are unknown to callers, never evidence of sensitive lookup.
  let count = 1;
  let component = false;
  for (const letter of target) {
    if (letter === path.sep) component = false;
    else if (!component) {
      if (++count === maxPathBytes) break;
      component = true;
    }
  }
  return count;
}

function validTarget(target: string): boolean {
  return path.isAbsolute(target) && !target.includes("\0") &&
    Buffer.byteLength(target, "utf8") + 1 <= maxPathBytes &&
    Buffer.from(target, "utf8").toString("utf8") === target;
}

function validatedModes(value: unknown, count: number): LookupMode[] {
  if (!Array.isArray(value) || value.length !== count ||
    value.some((mode) => mode !== "sensitive" && mode !== "insensitive" && mode !== "unknown")) {
    return Array(count).fill("unknown");
  }
  return value as LookupMode[];
}

/** One synchronous helper process per bounded chunk, with no metadata cache.
 * Results retain input order. Invalid paths and failed chunks are unknown;
 * malformed rows invalidate only that path, not independently valid rows.
 */
export function readDirectoryModesBatch(targets: string[]): LookupMode[][] {
  const results = targets.map((target) => Array<LookupMode>(modeCount(target)).fill("unknown"));
  let indices: number[] = [];
  let bytes = 0;
  const flush = () => {
    if (!indices.length) return;
    try {
      const result = childProcess.spawnSync(helper, ["--batch"], {
        input: indices.map((index) => targets[index] + "\0").join(""),
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: maxOutputBytes,
        stdio: ["pipe", "pipe", "ignore"],
      });
      if (!result.error && result.status === 0) {
        const rows: unknown = JSON.parse(result.stdout);
        if (Array.isArray(rows) && rows.length === indices.length) {
          for (let row = 0; row < indices.length; row++) {
            const index = indices[row]!;
            results[index] = validatedModes(rows[row], results[index]!.length);
          }
        }
      }
    } catch {
      // Spawn and protocol failures preserve the unknown fallback for this chunk.
    }
    indices = [];
    bytes = 0;
  };
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    if (!validTarget(target)) continue;
    const size = Buffer.byteLength(target, "utf8") + 1;
    if (indices.length === maxBatchPaths || bytes + size > maxBatchBytes) flush();
    indices.push(index);
    bytes += size;
  }
  flush();
  return results;
}

/** Root first, then each component, including the target if it is a directory.
 * A non-directory target has an unknown final slot. No file contents are read.
 */
export function readDirectoryModes(target: string): LookupMode[] {
  const count = modeCount(target);
  const unknown = (): LookupMode[] => Array(count).fill("unknown");
  if (!validTarget(target)) return unknown();
  try {
    const result = childProcess.spawnSync(helper, [target], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) return unknown();
    return validatedModes(JSON.parse(result.stdout), count);
  } catch {
    return unknown();
  }
}
