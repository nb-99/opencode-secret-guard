import * as fs from "node:fs";
import * as path from "node:path";
import { inspectPath } from "./paths.ts";
import { mayBeInside } from "./path-pattern.ts";
import type { GuardConfig } from "./policy.ts";

type ExemptConfig = Pick<GuardConfig, "exemptRoots">;

// Timestamps are not generation IDs: fallback birthtime may change with directory
// edits. dev/ino/type checks still leave inode-reuse and check/use race limitations.
interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly type: bigint;
}

interface RootPin {
  readonly declared: string;
  readonly canonical: string;
  readonly declaredIdentity: Identity | null;
  readonly directoryIdentity: Identity | null;
}

interface RootSnapshot {
  readonly roots: readonly RootPin[];
  readonly canonical: readonly string[];
}

// Policy objects carry no serializable capability state. A snapshot belongs to
// this exact object and is never replaced, including when its roots were missing.
const snapshots = new WeakMap<ExemptConfig, RootSnapshot>();

function identity(stats: fs.BigIntStats): Identity {
  return { dev: stats.dev, ino: stats.ino, type: stats.mode & 0o170000n };
}

function sameIdentity(stats: fs.BigIntStats, pinned: Identity): boolean {
  return stats.dev === pinned.dev && stats.ino === pinned.ino &&
    (stats.mode & 0o170000n) === pinned.type;
}

/** Pins once at policy validation. Trusted, directly constructed configs pin at first use. */
export function pinExemptRoots(config: ExemptConfig): readonly string[] {
  const existing = snapshots.get(config);
  if (existing) return existing.canonical;

  const roots = config.exemptRoots.map((root): RootPin => {
    // Match inspectPath's lexical normalization. A trailing slash must not make
    // lstat follow an explicitly declared symlink instead of pinning its entry.
    const declared = path.resolve(root);
    const canonical = inspectPath(declared).canonical;
    try {
      const entry = fs.lstatSync(declared, { bigint: true });
      const directory = fs.statSync(declared, { bigint: true });
      const target = fs.lstatSync(canonical, { bigint: true });
      if (directory.isDirectory() && target.isDirectory() && sameIdentity(target, identity(directory))) {
        return { declared, canonical, declaredIdentity: identity(entry), directoryIdentity: identity(directory) };
      }
    } catch {
      // A missing or unreadable root cannot acquire a grant after policy load.
    }
    return { declared, canonical, declaredIdentity: null, directoryIdentity: null };
  });
  const canonical = Object.freeze(roots.map((root) => root.canonical));
  snapshots.set(config, { roots, canonical });
  return canonical;
}

/** Checks live metadata, not a cached allow verdict. No file bodies are opened. */
export function validExemptRoots(config: ExemptConfig): string[] {
  pinExemptRoots(config);
  const valid: string[] = [];
  for (const pin of snapshots.get(config)!.roots) {
    if (!pin.declaredIdentity || !pin.directoryIdentity) continue;
    try {
      // Both names must still identify the pinned directory. Ancestor symlinks
      // may exist, but retargeting them cannot move the grant to another inode.
      // Canonical spelling was established at load; no helper runs here.
      const entry = fs.lstatSync(pin.declared, { bigint: true });
      const directory = fs.statSync(pin.declared, { bigint: true });
      const target = fs.lstatSync(pin.canonical, { bigint: true });
      if (sameIdentity(entry, pin.declaredIdentity) && directory.isDirectory() && target.isDirectory() &&
        sameIdentity(directory, pin.directoryIdentity) && sameIdentity(target, pin.directoryIdentity)) {
        valid.push(pin.canonical);
      }
    } catch {
      // Losing lookup or identity evidence removes the capability.
    }
  }
  return valid;
}

/** Reject containment of either a guarded namespace entry or its resolved body. */
export function exemptRootContaining(config: ExemptConfig, guardedRoot: string): string | undefined {
  pinExemptRoots(config);
  const pins = snapshots.get(config)!.roots;
  if (pins.length === 0) return;
  const declared = path.resolve(guardedRoot);
  const inspectAncestors = (origin: string): { canonical: string; containing?: string } => {
    let canonical: string | undefined;
    for (let current = origin; ; current = path.dirname(current)) {
      try {
        const stats = fs.statSync(current, { bigint: true });
        canonical ??= path.join(fs.realpathSync(current), path.relative(current, origin));
        const containing = stats.isDirectory() && pins.find((pin) =>
          pin.directoryIdentity && sameIdentity(stats, pin.directoryIdentity));
        if (containing) return { canonical, containing: containing.declared };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) throw error;
      }
      if (path.dirname(current) === current) break;
    }
    if (canonical === undefined) {
      throw new Error(`secret-guard: cannot establish filesystem ancestry for guarded path ${origin}.`);
    }
    return { canonical };
  };
  // Check the declared namespace first, then its resolved body, without
  // extending an array while traversing it. Missing suffixes resolve strictly.
  const lexical = inspectAncestors(declared);
  if (lexical.containing) return lexical.containing;
  if (lexical.canonical !== declared) {
    const body = inspectAncestors(lexical.canonical);
    if (body.containing) return body.containing;
  }
  // Missing exemptions grant nothing to file tools, but the unchanged kernel
  // profile names future paths. Only these unpinned roots use conservative case.
  const evidence = { canonical: lexical.canonical, insensitive: lexical.canonical.split("").map((c) => /[a-z]/i.test(c)), knownPrefixLength: 0 };
  return pins.find((pin) => !pin.directoryIdentity && mayBeInside(evidence, pin.canonical))?.declared;
}
