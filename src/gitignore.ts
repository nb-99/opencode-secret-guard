import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { realpath } from "./paths.ts";

/**
 * Bounds the directory walk of ignored trees. Beyond this many directories the
 * remaining ones stay un-enumerable rather than letting one pathological cache
 * directory dominate profile size and generation time.
 */
export const IGNORED_DIRECTORY_LIMIT = 4096;

export interface GitignoreRules {
  repoRoot: string | null;
  subpaths: string[];
  literals: string[];
  directories: string[];
}

/**
 * Collects the directories below an ignored tree, breadth first so the shallow
 * ones — the ones a tree walker reaches first — survive the limit.
 *
 * `isDirectory()` is false for symlinks, which keeps the walk inside the tree
 * and makes cycles impossible. Allowlisted names are skipped because the
 * artefact rule already re-allows their whole subtree.
 */
export function collectDirectories(root: string, allowed: Set<string>, limit: number): string[] {
  const found: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0 && found.length < limit) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || allowed.has(entry.name)) continue;
      const child = path.join(current, entry.name);
      found.push(child);
      queue.push(child);
      if (found.length >= limit) break;
    }
  }
  return found;
}

/**
 * Enumerates ignored entries using git itself, so gitignore semantics are exact
 * and there is no glob-to-regex translation to get wrong. `--directory`
 * collapses fully ignored directories to a single entry.
 */
export function gitignoreRules(
  repoRoot: string,
  artifactAllowlist: string[],
  directoryLimit: number = IGNORED_DIRECTORY_LIMIT,
): GitignoreRules {
  const rules: GitignoreRules = { repoRoot, subpaths: [], literals: [], directories: [] };
  const allowed = new Set(artifactAllowlist);

  const trackedResult = spawnSync("git", ["-C", repoRoot, "ls-files", "-s", "-z"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (trackedResult.status !== 0) return rules;
  const tracked = new Set(
    trackedResult.stdout
      .split("\0")
      .filter(Boolean)
      .flatMap((entry) => {
        const match = /^(\d+) [0-9a-f]+ \d+\t(.*)$/s.exec(entry);
        if (!match || match[1] === "120000") return [];
        return [path.join(repoRoot, match[2]!)];
      }),
  );

  const result = spawnSync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"],
    { encoding: "utf8", timeout: 5000 },
  );
  if (result.status !== 0 || !result.stdout) return rules;

  for (const entry of result.stdout.split("\0")) {
    if (!entry) continue;

    const isDirectory = entry.endsWith("/");
    const relative = isDirectory ? entry.slice(0, -1) : entry;
    if (!relative) continue;

    // Build artefacts stay readable; secret patterns still apply inside them.
    if (relative.split("/").some((part) => allowed.has(part))) continue;

    const absolute = realpath(path.join(repoRoot, relative));
    // An ignored symlink can resolve to a tracked file or directory. Denying
    // the canonical target would make tracked project data unreadable.
    if (tracked.has(absolute)) continue;
    if (isDirectory) {
      rules.subpaths.push(absolute);
      rules.directories.push(
        ...collectDirectories(
          absolute,
          allowed,
          Math.max(0, directoryLimit - rules.directories.length),
        ),
      );
    } else rules.literals.push(absolute);
  }
  return rules;
}

export const repoRootCache = new Map<string, string | null>();

/**
 * Walks up for a `.git` entry instead of spawning `git rev-parse`, which costs
 * ~11 ms — prohibitive when `glob`/`grep` results are classified one by one.
 *
 * A worktree or submodule stores `.git` as a *file*, so both kinds count.
 * `GIT_DIR`/`GIT_WORK_TREE` overrides and a `safe.directory` refusal are
 * ignored; both make this find a repository where `rev-parse` would not, which
 * classifies more paths, never fewer.
 */
export function findRepoRoot(from: string): string | null {
  const start = fs.existsSync(from) && fs.statSync(from).isDirectory() ? from : path.dirname(from);
  const cached = repoRootCache.get(start);
  if (cached !== undefined) return cached;

  let root: string | null = null;
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) {
      root = realpath(current);
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  repoRootCache.set(start, root);
  return root;
}

export const ignoreCache = new Map<string, boolean>();

/**
 * Paths that cannot be ignored without asking git: outside a repository, or
 * carrying an allowlisted component. Returns null when git must decide.
 */
export function ignoreVerdictWithoutGit(
  target: string,
  artifactAllowlist: string[],
): { root: string } | boolean {
  const root = findRepoRoot(target);
  if (!root) return false;

  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..")) return false;
  if (relative.split("/").some((part) => artifactAllowlist.includes(part))) return false;

  const cached = ignoreCache.get(target);
  if (cached !== undefined) return cached;
  return { root };
}

/**
 * Asks git about many paths at once. `glob`/`grep` classify every result, and
 * one `git check-ignore` per result costs ~11 ms — a hundred hits used to add
 * more than a second to a single tool call. `-z` makes both the input and the
 * output NUL-separated; exit status 1 means "nothing was ignored", not failure.
 */
export function primeIgnoreCache(targets: string[], artifactAllowlist: string[]): void {
  const byRoot = new Map<string, string[]>();
  for (const target of targets) {
    const verdict = ignoreVerdictWithoutGit(target, artifactAllowlist);
    if (typeof verdict === "boolean") continue;
    const pending = byRoot.get(verdict.root);
    if (pending) pending.push(target);
    else byRoot.set(verdict.root, [target]);
  }

  for (const [root, paths] of byRoot) {
    const result = spawnSync("git", ["-C", root, "check-ignore", "-z", "--stdin", "--"], {
      encoding: "utf8",
      input: paths.join("\0"),
      timeout: 5000,
    });
    // status 128 is a real error; leave those paths unclassified so the
    // per-path fallback can decide rather than silently reporting "allowed".
    if (result.status !== 0 && result.status !== 1) continue;

    const ignored = new Set((result.stdout ?? "").split("\0").filter(Boolean));
    for (const target of paths) ignoreCache.set(target, ignored.has(target));
  }
}

export function isGitIgnored(target: string, artifactAllowlist: string[]): boolean {
  const verdict = ignoreVerdictWithoutGit(target, artifactAllowlist);
  if (typeof verdict === "boolean") return verdict;

  const result = spawnSync("git", ["-C", verdict.root, "check-ignore", "-q", "--", target], {
    timeout: 5000,
  });
  const ignored = result.status === 0;
  ignoreCache.set(target, ignored);
  return ignored;
}

