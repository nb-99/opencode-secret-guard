import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { findRepoRoot, gitignoreRules } from "./gitignore.ts";
import { isInside } from "./paths.ts";
import type { GuardConfig } from "./policy.ts";
import { buildProfile, sbplString } from "./profile.ts";
import { SANDBOX_EXEC, validatePlatform } from "./shell.ts";

const argsSchema = z.object({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(64),
}).strict();
const MAX_ENTRIES = 4096;
const MAX_PROFILE_BYTES = 128 * 1024;

type CleanupContext = {
  abort: AbortSignal;
  ask(input: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }): Promise<void>;
};

export type CleanupPlan = {
  root: string;
  device: number;
  inode: number;
  targets: string[];
  entries: string[];
  permissionPaths: string[];
};

function fail(message: string): never {
  throw new Error(`secret-guard: cleanup_temp: ${message}`);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Resolve existing ancestors strictly; never traverse an operand symlink. */
export function prepareCleanup(root: string, paths: string[]): CleanupPlan {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail("cleanupRoot must be an existing directory, not a symlink");
  }
  const canonicalRoot = fs.realpathSync(root);
  if (canonicalRoot === path.parse(canonicalRoot).root) fail("refusing filesystem root");

  const targets = paths.map((relative) => {
    const parts = relative.split("/");
    if (
      path.isAbsolute(relative) ||
      /[\0\r\n\\]/.test(relative) ||
      parts.some((part) => !part || part === "." || part === "..")
    ) {
      fail(`expected a relative descendant path, got ${JSON.stringify(relative)}`);
    }

    let current = canonicalRoot;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]!);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (!missing(error)) throw error;
        // The existing ancestor is known; missing descendants are safe no-ops.
        current = path.join(current, ...parts.slice(i + 1));
        break;
      }
      if (stat.isSymbolicLink()) fail(`symlink operand or ancestor: ${relative}`);
      if (i < parts.length - 1 && !stat.isDirectory()) fail(`not a directory: ${relative}`);
      if (fs.realpathSync(current) !== current || !isInside(current, canonicalRoot)) {
        fail(`target changed during validation: ${relative}`);
      }
    }
    if (current === canonicalRoot || !isInside(current, canonicalRoot)) fail("target escapes cleanupRoot");
    return current;
  });

  const inventory = new Set<string>();
  const pending = [...targets];
  while (pending.length > 0) {
    const target = pending.pop()!;
    if (inventory.has(target)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    inventory.add(target);
    if (inventory.size > MAX_ENTRIES) fail(`request exceeds ${MAX_ENTRIES} entries; select a smaller subtree`);
    if (!stat.isDirectory()) continue;
    if (fs.realpathSync(target) !== target) fail("directory changed during enumeration");
    const directory = fs.opendirSync(target);
    try {
      let entry: fs.Dirent | null;
      while ((entry = directory.readSync()) !== null) {
        if (/[\0\r\n\\]/.test(entry.name)) fail("unsupported filename in cleanup subtree");
        pending.push(path.join(target, entry.name));
        if (pending.length + inventory.size > MAX_ENTRIES) {
          fail(`request exceeds ${MAX_ENTRIES} entries; select a smaller subtree`);
        }
      }
    } finally {
      directory.closeSync();
    }
    if (fs.realpathSync(target) !== target) fail("directory changed during enumeration");
  }
  const entries = [...inventory].sort();

  return {
    root: canonicalRoot,
    device: rootStat.dev,
    inode: rootStat.ino,
    targets: [...new Set(targets)],
    entries,
    // OpenCode matches these strings, not realpaths; retain the configured /tmp alias.
    permissionPaths: [...new Set([
      ...paths.map((relative) => path.join(root, relative)),
      ...entries.map((entry) => path.join(root, path.relative(canonicalRoot, entry))),
    ])].sort(),
  };
}

export function cleanupProfile(config: GuardConfig, plan: CleanupPlan): string {
  const repoRoot = findRepoRoot(plan.root);
  const profile = buildProfile({
    config,
    home: os.homedir(),
    group: null,
    gitignore: repoRoot
      ? gitignoreRules(repoRoot, config.artifactAllowlist)
      : { repoRoot: null, subpaths: [], literals: [], directories: [] },
  });
  const targets = plan.entries.map((target) => `(literal ${sbplString(target)})`).join(" ");
  const confined = profile +
    "\n;; Cleanup only narrows the base policy; secrets and the cache remain protected.\n" +
    (targets ? `(deny file-write* (require-not (require-any ${targets})))\n` : "(deny file-write*)\n") +
    `(deny file-write* (literal ${sbplString(plan.root)}))\n` +
    "(deny file-write-data file-write-create)\n";
  if (Buffer.byteLength(confined) > MAX_PROFILE_BYTES) fail("cleanup profile is too large; select a smaller subtree");
  return confined;
}

function runCleanup(profile: string, targets: string[], config: GuardConfig, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const env = { ...process.env };
  for (const name of config.secretEnvironment) delete env[name];

  return new Promise((resolve, reject) => {
    const child = spawn(SANDBOX_EXEC, ["-p", profile, "/bin/rm", "-rf", "--", ...targets], {
      env,
      signal,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let workerError: Error | undefined;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.on("error", (error) => { workerError = error; });
    child.on("close", (code, killedBy) => {
      if (code === 0 && !workerError) resolve();
      else reject(new Error(
        `secret-guard: cleanup_temp failed (${killedBy ?? code}); cleanup may be partial. ${stderr.trim()}`,
        { cause: workerError },
      ));
    });
  });
}

export function createCleanupTool(config: GuardConfig, shellValidated: () => boolean) {
  return {
    description: "Delete specific temporary files or task subdirectories beneath the configured cleanup root. " +
      "Paths are relative to that root; no shell syntax, root deletion, traversal, or operand symlinks. " +
      "Requires edit permission and kernel confinement. Secret files stay protected; failures may be partial.",
    args: argsSchema.shape,
    async execute(input: unknown, context: CleanupContext): Promise<string> {
      const { paths } = argsSchema.parse(input);
      if (!shellValidated()) fail("the configured guard shell has not been validated");
      if (config.mode !== "shell+files" || !config.cleanupRoot) fail("guarded cleanup is disabled");
      validatePlatform(config);
      context.abort.throwIfAborted();

      const plan = prepareCleanup(config.cleanupRoot, paths);
      const profile = cleanupProfile(config, plan);
      const preview = plan.entries.length > 0
        ? plan.entries.map((entry) => `-DELETE ${path.join(config.cleanupRoot!, path.relative(plan.root, entry))}`)
        : ["-No existing targets; no files will be deleted."];
      await context.ask({
        permission: "edit",
        patterns: plan.permissionPaths,
        always: [],
        metadata: {
          operation: "cleanup_temp",
          filepath: config.cleanupRoot,
          diff: `--- cleanup manifest (paths only)\n+++ /dev/null\n@@ -1,${preview.length} +0,0 @@\n${preview.join("\n")}\n`,
        },
      });
      context.abort.throwIfAborted();

      const current = prepareCleanup(config.cleanupRoot, paths);
      if (
        current.root !== plan.root ||
        current.device !== plan.device ||
        current.inode !== plan.inode ||
        JSON.stringify(current.targets) !== JSON.stringify(plan.targets) ||
        JSON.stringify(current.entries) !== JSON.stringify(plan.entries)
      ) {
        fail("cleanup targets changed during approval; retry with the current paths");
      }
      if (plan.entries.length > 0) await runCleanup(profile, plan.targets, config, context.abort);
      return `Cleanup completed for ${paths.length} requested temporary path(s), including any already absent.`;
    },
  };
}
