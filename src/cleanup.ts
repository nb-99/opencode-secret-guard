import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { findRepoRoot, gitignoreRules } from "./gitignore.ts";
import { inspectScratchRoot, sameScratchRoot, scratchDescendant, type ScratchRoot } from "./scratch-paths.ts";
import type { GuardConfig } from "./policy.ts";
import type { SandboxBackend } from "./sandbox.ts";
import { selectBackend } from "./sandbox.ts";
import { scrubbedEnvironment } from "./shell.ts";
import { tamperTargets } from "./tamper.ts";

const argsSchema = z.object({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(64),
}).strict();
const { $schema: _, ...inputJsonSchema } = z.toJSONSchema(argsSchema);
/** The arguments as JSON Schema, which V2 tool definitions take. */
export const CLEANUP_INPUT_SCHEMA: Readonly<Record<string, unknown>> = inputJsonSchema;
const MAX_ENTRIES = 4096;

export type CleanupContext = {
  abort: AbortSignal;
  ask(input: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }): Promise<void>;
};

export type CleanupPlan = ScratchRoot & {
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
  const scratch = inspectScratchRoot(root);
  const targets = paths.map((relative) => scratchDescendant(scratch.root, relative));

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
    ...scratch,
    targets: [...new Set(targets)],
    entries,
    // OpenCode matches these strings, not realpaths; retain the configured /tmp alias.
    permissionPaths: [...new Set([
      ...paths.map((relative) => path.join(root, relative)),
      ...entries.map((entry) => path.join(root, path.relative(scratch.root, entry))),
    ])].sort(),
  };
}

/** The sandbox command that may delete exactly the plan's entries; `/bin/rm` and its operands follow it. */
export function cleanupCommand(config: GuardConfig, plan: CleanupPlan, backend: SandboxBackend): string[] {
  const repoRoot = findRepoRoot(plan.root);
  const home = os.homedir();
  return backend.deletionCommand({
    config,
    home,
    gitignore: repoRoot
      ? gitignoreRules(config.tools.git, repoRoot, config.artifactAllowlist)
      : { repoRoot: null, subpaths: [], literals: [], directories: [], helmSecretTemplates: [] },
    tamper: tamperTargets({
      repoRoot,
      pathEnvironment: process.env.PATH,
      home,
      writeProtectedRoots: config.writeProtectedRoots,
    }),
    entries: plan.entries,
    root: plan.root,
  });
}

function runCleanup(sandbox: string[], targets: string[], config: GuardConfig, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const env = { ...process.env };
  for (const name of scrubbedEnvironment(config, null, env)) delete env[name];

  return new Promise((resolve, reject) => {
    const child = spawn(sandbox[0]!, [...sandbox.slice(1), "/bin/rm", "-rf", "--", ...targets], {
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
      const backend = selectBackend(config)!;
      context.abort.throwIfAborted();

      const plan = prepareCleanup(config.cleanupRoot, paths);
      const sandbox = cleanupCommand(config, plan, backend);
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
        !sameScratchRoot(current, plan) ||
        JSON.stringify(current.targets) !== JSON.stringify(plan.targets) ||
        JSON.stringify(current.entries) !== JSON.stringify(plan.entries)
      ) {
        fail("cleanup targets changed during approval; retry with the current paths");
      }
      if (plan.entries.length > 0) await runCleanup(sandbox, plan.targets, config, context.abort);
      return `Cleanup completed for ${paths.length} requested temporary path(s), including any already absent.`;
    },
  };
}
