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

/**
 * Runs the git named by the policy. Resolving `git` through PATH would let a
 * sandboxed command plant a binary in a user-writable PATH directory that the
 * unsandboxed resolver then executes. A missing binary fails by name: the
 * gitignore layer treats "git said nothing" as "nothing is ignored", so a
 * silent spawn failure would quietly shrink the boundary.
 */
export function runGit(
  git: string,
  args: string[],
  options: { input?: string } = {},
): { status: number | null; stdout: string } {
  const result = spawnSync(git, args, { encoding: "utf8", timeout: 5000, ...options });
  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    throw new Error(`secret-guard: "tools.git" names ${git}, which does not exist.`);
  }
  if (result.error) throw new Error(`secret-guard: could not run git: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? "" };
}

export interface GitignoreRules {
  repoRoot: string | null;
  subpaths: string[];
  literals: string[];
  directories: string[];
  helmSecretTemplates: string[];
}

// The filename rule in policy/default.json that this chart-specific exception overrides.
export const HELM_SECRET_FILENAME_PATTERN = "/secret\\.(json|ya?ml|txt|env|toml)$";

/** A tracked, regular Helm template, under the chart that owns templates/. */
export function isHelmSecretTemplate(repoRoot: string, relative: string): boolean {
  const parts = relative.split("/");
  const index = parts.lastIndexOf("templates");
  if (index < 0 || index === parts.length - 1 || !/^secret\.ya?ml$/.test(parts.at(-1)!)) return false;
  return fs.existsSync(path.join(repoRoot, ...parts.slice(0, index), "Chart.yaml"));
}

/** Git's index is the authority for whether a template is source, not a local secret. */
export function trackedHelmSecretTemplate(git: string, target: string): boolean {
  const repoRoot = findRepoRoot(target);
  if (!repoRoot) return false;
  const relative = path.relative(repoRoot, target);
  if (!isHelmSecretTemplate(repoRoot, relative)) return false;
  if (realpath(target) !== target) return false;
  const result = runGit(git, ["-C", repoRoot, "ls-files", "-s", "-z", "--", relative]);
  const entry = /^(100[0-9]{3}) [0-9a-f]+ \d+\t([^\0]+)\0/.exec(result.stdout);
  if (result.status !== 0 || !entry || entry[2] !== relative) return false;
  const ignored = runGit(git, ["-C", repoRoot, "check-ignore", "--no-index", "-q", "--", relative]);
  return ignored.status === 1;
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
  git: string,
  repoRoot: string,
  artifactAllowlist: string[],
  directoryLimit: number = IGNORED_DIRECTORY_LIMIT,
): GitignoreRules {
  const rules: GitignoreRules = { repoRoot, subpaths: [], literals: [], directories: [], helmSecretTemplates: [] };
  const allowed = new Set(artifactAllowlist);

  const trackedResult = runGit(git, ["-C", repoRoot, "ls-files", "-s", "-z"]);
  if (trackedResult.status !== 0) return rules;
  const tracked = new Set<string>();
  for (const entry of trackedResult.stdout.split("\0")) {
    const match = /^(\d+) [0-9a-f]+ \d+\t(.*)$/s.exec(entry);
    if (!match || match[1] === "120000") continue;
    const absolute = path.join(repoRoot, match[2]!);
    tracked.add(absolute);
    if (match[1]!.startsWith("100") && isHelmSecretTemplate(repoRoot, match[2]!) && realpath(absolute) === absolute) {
      rules.helmSecretTemplates.push(absolute);
    }
  }
  if (rules.helmSecretTemplates.length > 0) {
    const ignored = runGit(git, ["-C", repoRoot, "check-ignore", "--no-index", "-z", "--stdin"], {
      input: rules.helmSecretTemplates.map((p) => path.relative(repoRoot, p)).join("\0") + "\0",
    });
    if (ignored.status !== 0 && ignored.status !== 1) rules.helmSecretTemplates = [];
    else {
      const excluded = new Set(ignored.stdout.split("\0"));
      rules.helmSecretTemplates = rules.helmSecretTemplates.filter((p) => !excluded.has(path.relative(repoRoot, p)));
    }
  }

  const result = runGit(git, [
    "-C", repoRoot, "ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory",
  ]);
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
export function primeIgnoreCache(git: string, targets: string[], artifactAllowlist: string[]): void {
  const byRoot = new Map<string, string[]>();
  for (const target of targets) {
    const verdict = ignoreVerdictWithoutGit(target, artifactAllowlist);
    if (typeof verdict === "boolean") continue;
    const pending = byRoot.get(verdict.root);
    if (pending) pending.push(target);
    else byRoot.set(verdict.root, [target]);
  }

  for (const [root, paths] of byRoot) {
    const result = runGit(git, ["-C", root, "check-ignore", "-z", "--stdin", "--"], {
      input: paths.join("\0"),
    });
    // status 128 is a real error; leave those paths unclassified so the
    // per-path fallback can decide rather than silently reporting "allowed".
    if (result.status !== 0 && result.status !== 1) continue;

    const ignored = new Set(result.stdout.split("\0").filter(Boolean));
    for (const target of paths) ignoreCache.set(target, ignored.has(target));
  }
}

export function isGitIgnored(git: string, target: string, artifactAllowlist: string[]): boolean {
  const verdict = ignoreVerdictWithoutGit(target, artifactAllowlist);
  if (typeof verdict === "boolean") return verdict;

  const result = runGit(git, ["-C", verdict.root, "check-ignore", "-q", "--", target]);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`secret-guard: git check-ignore failed with ${result.status === null ? "no exit status" : `exit status ${result.status}`}.`);
  }
  const ignored = result.status === 0;
  ignoreCache.set(target, ignored);
  return ignored;
}

/** Case-folded negations are not proof that every lookup spelling is allowed. */
export function isPossiblyGitIgnored(git: string, target: string): boolean {
  return possibleIgnoreVerdicts(git, [target]).get(target)!;
}

/** One Git invocation per repository; verdicts live only for this classification. */
export function possibleIgnoreVerdicts(git: string, targets: string[]): Map<string, boolean> {
  const verdicts = new Map(targets.map((target) => [target, false]));
  const byRoot = new Map<string, string[]>();
  for (const target of targets) {
    const root = findRepoRoot(target);
    if (!root) continue;
    const paths = byRoot.get(root) ?? [];
    paths.push(target);
    byRoot.set(root, paths);
  }
  // Any rule hit, including a negation, is conservatively protected here. Git
  // supplies the glob grammar; the guard does not reimplement it or cache grants.
  for (const [root, paths] of byRoot) {
    const result = runGit(git, ["-C", root, "-c", "core.ignorecase=true", "check-ignore", "-v", "-z", "--stdin"], {
      input: paths.join("\0") + "\0",
    });
    if (result.status !== 0 && result.status !== 1) {
      throw new Error("secret-guard: cannot establish case-alias gitignore protection.");
    }
    const fields = result.stdout.split("\0");
    if (fields.at(-1) !== "" || (fields.length - 1) % 4 !== 0) {
      throw new Error("secret-guard: invalid case-alias gitignore response.");
    }
    for (let index = 3; index < fields.length - 1; index += 4) {
      const target = fields[index]!;
      if (!verdicts.has(target)) throw new Error("secret-guard: gitignore returned an unexpected path.");
      verdicts.set(target, true);
    }
  }
  return verdicts;
}
