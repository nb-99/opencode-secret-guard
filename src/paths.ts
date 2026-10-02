import * as fs from "node:fs";
import * as path from "node:path";
import * as lookup from "./lookup.ts";

export interface PathEvidence {
  canonical: string;
  /** ASCII case alternatives, indexed by UTF-16 offset in canonical. */
  insensitive: boolean[];
  knownPrefixLength: number;
}

export function hasUnknownLookup(target: PathEvidence): boolean {
  return target.knownPrefixLength < target.canonical.length;
}

export function hasAliasLookup(target: PathEvidence): boolean {
  return hasUnknownLookup(target) || target.insensitive.some(Boolean);
}

function missingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function sameEntry(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** realpath on DrvFS can retain the caller's case, even for an existing alias. */
function diskSpelling(target: string, modes: lookup.LookupMode[]): string {
  const root = path.parse(target).root;
  let current = root;
  const names = target.slice(root.length).split(path.sep).filter(Boolean);
  for (const [index, name] of names.entries()) {
    const entry = path.join(current, name);
    if (modes[index] === "sensitive") {
      current = entry;
      continue;
    }
    const stored = fs.readdirSync(current);
    // Two exact case-distinct hardlinks may have the same inode. Their names
    // remain distinct; inode equality alone must not conflate them.
    if (stored.includes(name)) {
      current = entry;
      continue;
    }
    const identity = fs.lstatSync(entry, { bigint: true });
    // Do not stat unrelated siblings: a case alias must also have a compatible
    // name. Ambiguous or unsupported Unicode mappings still fail closed.
    const candidates = stored.filter((candidate) =>
      (candidate.toLowerCase() === name.toLowerCase() || candidate.toUpperCase() === name.toUpperCase()) &&
      sameEntry(identity, fs.lstatSync(path.join(current, candidate), { bigint: true })));
    if (candidates.length !== 1) {
      throw new Error(`secret-guard: cannot establish the on-disk spelling of ${entry}.`);
    }
    current = path.join(current, candidates[0]!);
  }
  return current;
}

function resolveExisting(target: string): { resolved: string; missing: string[] } {
  let existing = path.resolve(target);
  const missing: string[] = [];
  let resolved: string;
  for (;;) {
    try {
      resolved = fs.realpathSync(existing);
      break;
    } catch (error) {
      if (!missingPath(error)) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  return { resolved, missing };
}

export function inspectPath(target: string, readModes: lookup.ReadDirectoryModes = lookup.readDirectoryModes): PathEvidence {
  const { resolved, missing } = resolveExisting(target);
  return inspectResolved(resolved, missing, readModes(resolved));
}

/** Resolve independently, then read directory metadata in bounded helper batches. */
export function inspectPaths(
  targets: string[],
  readModes = lookup.readDirectoryModesBatch,
): Array<PathEvidence | null> {
  const resolutions = targets.map((target) => {
    try { return resolveExisting(target); } catch { return null; }
  });
  let modes: lookup.LookupMode[][];
  try {
    modes = readModes(resolutions.filter((target) => target !== null).map((target) => target.resolved));
  } catch {
    return targets.map(() => null);
  }
  let index = 0;
  return resolutions.map((target) => {
    if (!target) return null;
    const row = modes[index++] ?? [];
    try { return inspectResolved(target.resolved, target.missing, row); } catch { return null; }
  });
}

function inspectResolved(resolved: string, missing: string[], modes: lookup.LookupMode[]): PathEvidence {
  // Keep normalization outside the missing-path catch. A proven alias whose
  // directory cannot be inspected must fail closed, not regain caller case.
  const canonical = path.join(diskSpelling(resolved, modes), ...missing);
  const insensitive = Array<boolean>(canonical.length).fill(false);
  let knownPrefixLength = canonical.length;
  const root = path.parse(canonical).root;
  let offset = root.length;
  for (const [index, name] of canonical.slice(root.length).split(path.sep).filter(Boolean).entries()) {
    // The first missing child inherits its existing parent's mode. Its own
    // directory and any deeper missing directory have no metadata yet.
    const mode = modes[index] ?? "unknown";
    if (mode === "unknown" || (mode === "insensitive" && /[^\x00-\x7f]/.test(name))) {
      knownPrefixLength = Math.min(knownPrefixLength, offset);
    }
    if (mode !== "sensitive") {
      for (let character = 0; character < name.length; character++) {
        insensitive[offset + character] = /^[a-z]$/i.test(name[character]!);
      }
    }
    offset += name.length + path.sep.length;
  }
  return { canonical, insensitive, knownPrefixLength };
}

export function realpath(target: string): string {
  try {
    const { resolved, missing } = resolveExisting(target);
    return path.join(resolved, ...missing);
  } catch {
    // Plain resolution also serves PATH/profile discovery. Unreadable entries
    // must not disable unrelated writes; inspectPath remains fail-closed.
    try {
      return path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
    } catch {
      return path.resolve(target);
    }
  }
}

export function matchesAny(target: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(target);
    } catch {
      return false;
    }
  });
}

export function isInside(target: string, root: string): boolean {
  const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
  return target === normalized || target.startsWith(normalized + "/");
}

export function isExistingDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
