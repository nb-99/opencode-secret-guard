import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isInside, realpath } from "./paths.ts";
import type { GuardConfig } from "./policy.ts";
import { configPath, opencodeCacheDirectory, opencodeConfigDirectory, opencodeDataDirectory } from "./policy.ts";

/**
 * Paths that must survive any command unchanged, because changing them
 * disables the guard for every command that follows.
 *
 * Everything OpenCode loads and runs at its next start is one such path: its
 * configuration (which names the shell and the plugins), its plugin and tool
 * directories, the `package.json` that makes it run `bun install`, and the
 * cache that install populates. So is this policy, and so is this package.
 * User-writable PATH directories are the same hole one hop removed — the
 * unsandboxed resolver, OpenCode and its formatters spawn programs by name,
 * and a `git` planted in `/opt/homebrew/bin` runs with no profile at all.
 *
 * Reads are never affected. `literals` are single files (or a directory node
 * that must not be renamed); `subpaths` are whole trees.
 */
export interface TamperTargets {
  literals: string[];
  subpaths: string[];
}

/** This package's root: <package>/lib/tamper.ts → <package>. */
export const PACKAGE_DIRECTORY = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const CONFIG_FILES = ["opencode.json", "opencode.jsonc", "package.json", "bun.lock", "bun.lockb"];
const CODE_DIRECTORIES = ["plugin", "plugins", "tool", "tools", "node_modules"];

/**
 * PATH entries a command could plant a binary in: those the current user can
 * write, or that do not exist yet and so could be created. Entries inside the
 * repository are the project's own (`node_modules/.bin`, direnv shims) and
 * stay writable; a project cannot be protected from itself.
 */
export function writablePathDirectories(pathEnvironment: string | undefined, repoRoot: string | null): string[] {
  const found = new Set<string>();
  for (const entry of (pathEnvironment ?? "").split(":")) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const canonical = realpath(entry);
    if (repoRoot && isInside(canonical, repoRoot)) continue;
    let writable: boolean;
    try {
      fs.accessSync(canonical, fs.constants.W_OK);
      writable = fs.statSync(canonical).isDirectory();
    } catch (error) {
      writable = error instanceof Error && "code" in error && error.code === "ENOENT";
    }
    if (writable) found.add(canonical);
  }
  return [...found].sort();
}

export function tamperTargets(options: {
  repoRoot: string | null;
  pathEnvironment: string | undefined;
  policyPath?: string;
  packageDirectory?: string;
}): TamperTargets {
  const configDirectory = realpath(opencodeConfigDirectory());
  const policy = options.policyPath ?? configPath();
  const literals = new Set<string>([
    realpath(policy),
    configDirectory,
    ...CONFIG_FILES.map((name) => path.join(configDirectory, name)),
  ]);
  const subpaths = new Set<string>([
    ...CODE_DIRECTORIES.map((name) => path.join(configDirectory, name)),
    realpath(opencodeCacheDirectory()),
    realpath(path.join(opencodeDataDirectory(), "bin")),
    realpath(options.packageDirectory ?? PACKAGE_DIRECTORY),
    ...writablePathDirectories(options.pathEnvironment, options.repoRoot),
  ]);

  if (options.repoRoot) {
    const project = path.join(options.repoRoot, ".opencode");
    literals.add(path.join(options.repoRoot, "opencode.json"));
    literals.add(path.join(options.repoRoot, "opencode.jsonc"));
    for (const name of CONFIG_FILES) literals.add(path.join(project, name));
    for (const name of CODE_DIRECTORIES) subpaths.add(path.join(project, name));
  }

  return { literals: [...literals].sort(), subpaths: [...subpaths].sort() };
}

export function isTamperProtected(canonical: string, targets: TamperTargets): boolean {
  return (
    targets.literals.includes(canonical) ||
    targets.subpaths.some((root) => isInside(canonical, root))
  );
}

/**
 * Directory nodes whose *name* carries a protection, and the ancestors that
 * name leads through. Path rules match the path at the time of the operation:
 * `mv ~/.kube ~/k2` leaves `~/k2/config` under a name no rule matches, and
 * `mv ~/.config ~/c2` does the same to `~/.config/gcloud`. Files are already
 * covered — rename checks file-write* on the source, which the pattern deny
 * includes — but a trailing-slash pattern never matches the directory itself.
 *
 * Ancestors stop below `$HOME`, which the user cannot rename anyway, and are
 * only collected for paths under it.
 */
export function protectedNodes(config: GuardConfig, home: string): { regexes: string[]; literals: string[] } {
  const regexes = config.secretPatterns
    .filter((pattern) => pattern.endsWith("/"))
    .map((pattern) => `${pattern.slice(0, -1)}$`);

  const literals = new Set<string>();
  const canonicalHome = realpath(home);
  const roots = [
    ...config.denyRoots,
    ...Object.values(config.relaxationGroups).flatMap((group) =>
      group.allowPaths.map((relative) => path.join(home, relative)),
    ),
  ].map(realpath);

  for (const root of roots) {
    literals.add(root);
    if (!isInside(root, canonicalHome)) continue;
    let current = path.dirname(root);
    while (current !== canonicalHome && current !== path.dirname(current)) {
      literals.add(current);
      current = path.dirname(current);
    }
  }
  return { regexes, literals: [...literals].sort() };
}
