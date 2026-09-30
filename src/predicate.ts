import * as os from "node:os";
import * as path from "node:path";
import { findRepoRoot, HELM_SECRET_FILENAME_PATTERN, isGitIgnored, primeIgnoreCache, trackedHelmSecretTemplate } from "./gitignore.ts";
import { isExistingDirectory, isInside, matchesAny, realpath } from "./paths.ts";
import type { GuardConfig } from "./policy.ts";
import { cacheDirectory } from "./profile.ts";
import { isTamperProtected, tamperTargets } from "./tamper.ts";

export type FileOperation = "read" | "write";

/**
 * Resolves a path argument the way the tools do: `~` expands to the home
 * directory, and a relative path is relative to the tool's working directory,
 * not to this process's. OpenCode V2 expands `~` itself, so leaving it literal
 * here would classify `<cwd>/~/.ssh/id_rsa` and allow the real file.
 *
 * Without a working directory a relative path has no meaning, and guessing one
 * would classify a different file from the one the tool opens, so it throws.
 */
export function resolveTarget(value: string, baseDirectory: string | undefined): string {
  const expanded = value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
  if (baseDirectory === undefined) {
    if (!path.isAbsolute(expanded)) {
      throw new Error(`secret-guard: cannot resolve the relative path ${value} because OpenCode gave no project directory.`);
    }
    return path.resolve(expanded);
  }
  return path.resolve(baseDirectory, expanded);
}

/**
 * Mirrors the profile's rule ordering so the two layers agree:
 * guard-protected paths (writes) > exempt roots > deny roots > tracked Helm
 * templates (unless another secret pattern matches) > exceptions > secret
 * patterns > artefact allowlist > gitignore.
 */
export function classifyPath(
  target: string,
  config: GuardConfig,
  operation: FileOperation = "read",
): "allow" | "deny" {
  const canonical = realpath(path.resolve(target));

  if (isInside(canonical, realpath(cacheDirectory()))) return "deny";
  if (operation === "write") {
    const targets = tamperTargets({
      repoRoot: findRepoRoot(canonical),
      pathEnvironment: process.env.PATH,
      home: os.homedir(),
    });
    if (isTamperProtected(canonical, targets)) return "deny";
  }
  if (config.exemptRoots.some((root) => isInside(canonical, realpath(root)))) return "allow";
  if (config.denyRoots.some((root) => isInside(canonical, realpath(root)))) return "deny";
  if (config.secretPatterns.includes(HELM_SECRET_FILENAME_PATTERN) &&
    matchesAny(canonical, [HELM_SECRET_FILENAME_PATTERN]) &&
    !matchesAny(canonical, config.secretPatterns.filter((pattern) => pattern !== HELM_SECRET_FILENAME_PATTERN)) &&
    trackedHelmSecretTemplate(config.tools.git, canonical)) return "allow";
  if (matchesAny(canonical, config.secretExceptions)) return "allow";
  if (matchesAny(canonical, config.secretPatterns)) return "deny";
  // An ignored *directory* stays listable, matching the profile: enumeration
  // reveals names, and names are not the secret. Its files stay denied.
  if (isGitIgnored(config.tools.git, canonical, config.artifactAllowlist)) {
    return isExistingDirectory(canonical) ? "allow" : "deny";
  }
  return "allow";
}

/**
 * Classifies many paths at once. The verdicts are exactly those of calling
 * `classifyPath` on each path; only the number of git subprocesses differs.
 * A path that is classifiable but outside every rule keeps the layer's default,
 * allow. A path whose classification *fails* is denied, as the before-call check
 * refuses the same call: an error must not turn a result into a disclosure.
 */
export function classifyPaths(
  targets: string[],
  config: GuardConfig,
): Map<string, "allow" | "deny"> {
  const canonical = targets.map((target) => realpath(path.resolve(target)));

  try {
    primeIgnoreCache(config.tools.git, canonical, config.artifactAllowlist);
  } catch {
    // Fall through: classifyPath asks git per path.
  }

  const verdicts = new Map<string, "allow" | "deny">();
  targets.forEach((target, index) => {
    try {
      verdicts.set(target, classifyPath(canonical[index]!, config));
    } catch {
      verdicts.set(target, "deny");
    }
  });
  return verdicts;
}
