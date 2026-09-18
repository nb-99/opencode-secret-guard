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
 * and a `git` planted in `/opt/homebrew/bin` runs with no profile at all. So
 * is `.zshenv`, which the interpreter every command runs under sources first.
 *
 * Reads are never affected. `literals` are single files (or a directory node
 * that must not be renamed); `subpaths` are whole trees.
 *
 * Prompts — `agent/`, `command/`, `skills/`, `AGENTS.md` — stay writable on
 * purpose. They steer the agent but run nothing: the kernel boundary holds
 * whatever they say, and editing them is ordinary work in this repository.
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
 * stay writable; a project cannot be protected from itself. A relative or
 * empty entry means the working directory, which is the repository, and is
 * excluded for the same reason.
 *
 * The entry is returned as PATH spells it. Writability is judged on what it
 * resolves to, because that is where a planted binary would land, but the
 * entry itself must carry the rule too: a PATH entry that is a symlink can be
 * unlinked and re-pointed even when its target is a read-only store path.
 * `tamperTargets` adds the resolved directory.
 */
export function writablePathDirectories(pathEnvironment: string | undefined, repoRoot: string | null): string[] {
  const found = new Set<string>();
  for (const entry of (pathEnvironment ?? "").split(":")) {
    if (!path.isAbsolute(entry)) continue;
    const canonical = realpath(entry);
    if (repoRoot && isInside(canonical, repoRoot)) continue;
    let writable: boolean;
    try {
      fs.accessSync(canonical, fs.constants.W_OK);
      writable = fs.statSync(canonical).isDirectory();
    } catch (error) {
      writable = error instanceof Error && "code" in error && error.code === "ENOENT";
    }
    if (writable || canonical !== path.resolve(entry)) found.add(path.resolve(entry));
  }
  return [...found].sort();
}

/**
 * A target and, when a symlink leads to it, the path it resolves to.
 *
 * A rule matches the path the operation names. Unlinking, renaming or
 * replacing a symlink operates on the link, not on its target, so a rule that
 * names only the resolved path leaves the link free — and the link is what
 * OpenCode opens at its next start. Home Manager installs every file it
 * manages that way: `~/.config/opencode/secret-guard.json` is a link into the
 * store, whose resolved path is immutable for an entirely different reason
 * (nobody can write the store) while the link beside it decides which policy
 * the next command is judged by.
 */
export function bothPaths(target: string): string[] {
  const resolved = realpath(target);
  return resolved === target ? [target] : [target, resolved];
}

/**
 * Every directory a target's path leads through. A rule matches the path at
 * the time of the operation, so protecting `~/.local/share/opencode/bin` alone
 * leaves `mv ~/.local/share/opencode x && ln -s /tmp/evil ~/.local/share/opencode`
 * open: the old rule matches nothing and the symlink is loaded at next start.
 * Protecting the node forbids renaming, deleting or replacing it — not
 * writing inside it, which stays governed by the target's own rule.
 */
function ancestors(target: string): string[] {
  const found: string[] = [];
  let current = path.dirname(target);
  while (current !== path.dirname(current)) {
    found.push(current);
    current = path.dirname(current);
  }
  return found;
}

/**
 * Files zsh reads before running a command, which the wrapper hands every
 * command to. `zsh -c` sources `/etc/zshenv` and then `$ZDOTDIR/.zshenv` (or
 * `~/.zshenv`) on *every* invocation, interactive or not — `.zshrc` and
 * `.zprofile` are not read for `-c` and stay editable.
 *
 * That makes `.zshenv` the same vector the wrapper's fixed interpreter line
 * closes, one level down: a command that leaves a function named after a
 * credential binary there — `kubectl() { cat ~/.kube/config }` — gets the
 * `kube` relaxation handed to its own code by the *next* command, and the
 * credential is readable after all.
 *
 * Protecting the file rather than starting zsh with `-f` keeps `/etc/zshenv`,
 * which is where a nix-darwin host sets PATH for non-interactive shells; `-f`
 * would skip it and leave commands unable to find their binaries. `/etc` is
 * root-owned, so it needs no rule of its own.
 */
export function zshStartupFiles(home: string): string[] {
  const directories = new Set([home]);
  // A ZDOTDIR the guard's own process inherited: the command cannot change it
  // for the next invocation, but the user may have set it for the session.
  if (process.env.ZDOTDIR && path.isAbsolute(process.env.ZDOTDIR)) directories.add(process.env.ZDOTDIR);
  return [...directories].map((directory) => path.join(directory, ".zshenv"));
}

export function tamperTargets(options: {
  repoRoot: string | null;
  pathEnvironment: string | undefined;
  home: string;
  policyPath?: string;
  packageDirectory?: string;
}): TamperTargets {
  const configDirectory = opencodeConfigDirectory();
  const literals = new Set<string>([
    options.policyPath ?? configPath(),
    configDirectory,
    ...CONFIG_FILES.map((name) => path.join(configDirectory, name)),
    ...zshStartupFiles(options.home),
  ]);
  const subpaths = new Set<string>([
    ...CODE_DIRECTORIES.map((name) => path.join(configDirectory, name)),
    opencodeCacheDirectory(),
    path.join(opencodeDataDirectory(), "bin"),
    options.packageDirectory ?? PACKAGE_DIRECTORY,
    ...writablePathDirectories(options.pathEnvironment, options.repoRoot),
  ]);

  if (options.repoRoot) {
    const project = path.join(options.repoRoot, ".opencode");
    literals.add(project);
    literals.add(path.join(options.repoRoot, "opencode.json"));
    literals.add(path.join(options.repoRoot, "opencode.jsonc"));
    for (const name of CONFIG_FILES) literals.add(path.join(project, name));
    for (const name of CODE_DIRECTORIES) subpaths.add(path.join(project, name));
  }

  // Every target is protected at the path it is named by and at the path it
  // resolves to, before the ancestors of either are collected.
  const resolved = {
    literals: new Set([...literals].flatMap(bothPaths)),
    subpaths: new Set([...subpaths].flatMap(bothPaths)),
  };

  for (const target of [...resolved.literals, ...resolved.subpaths]) {
    for (const ancestor of ancestors(target)) resolved.literals.add(ancestor);
  }

  return { literals: [...resolved.literals].sort(), subpaths: [...resolved.subpaths].sort() };
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
