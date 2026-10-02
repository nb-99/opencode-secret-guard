import * as os from "node:os";
import * as path from "node:path";
import { findRepoRoot, HELM_SECRET_FILENAME_PATTERN, isGitIgnored, isPossiblyGitIgnored, possibleIgnoreVerdicts, primeIgnoreCache, trackedHelmSecretTemplate } from "./gitignore.ts";
import { hasAliasLookup, inspectPath, isExistingDirectory, isInside, realpath, type PathEvidence } from "./paths.ts";
import { matchPathPattern, mayBeInside } from "./path-pattern.ts";
import type { GuardConfig } from "./policy.ts";
import { cacheDirectory } from "./profile.ts";
import { mayBeTamperProtected, tamperTargets } from "./tamper.ts";
import { validExemptRoots } from "./exemptions.ts";

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
  return classifyEvidence(inspectPath(path.resolve(target)), config, operation);
}

function classifyEvidence(
  inspected: PathEvidence,
  config: GuardConfig,
  operation: FileOperation = "read",
  exemptRoots = validExemptRoots(config),
  aliasIgnore?: Map<string, boolean>,
): "allow" | "deny" {
  const canonical = inspected.canonical;
  const aliasLookup = hasAliasLookup(inspected);
  const possible = (patterns: string[]) => patterns.some((pattern) => matchPathPattern(pattern, inspected).mayMatch);
  const certain = (patterns: string[]) => patterns.some((pattern) => matchPathPattern(pattern, inspected).mustMatch);

  if (mayBeInside(inspected, realpath(cacheDirectory()))) return "deny";
  if (operation === "write") {
    const targets = tamperTargets({
      repoRoot: findRepoRoot(canonical),
      pathEnvironment: process.env.PATH,
      home: os.homedir(),
    });
    if (mayBeTamperProtected(inspected, targets)) return "deny";
  }
  // A root exemption names a real directory, not a folded text prefix. A missing
  // root cannot grant a capability whose lookup identity has not been established.
  if (exemptRoots.some((root) => isInside(canonical, root))) return "allow";
  if (config.denyRoots.some((root) => mayBeInside(inspected, realpath(root)))) return "deny";
  if (config.secretPatterns.includes(HELM_SECRET_FILENAME_PATTERN) &&
    !aliasLookup &&
    possible([HELM_SECRET_FILENAME_PATTERN]) &&
    !possible(config.secretPatterns.filter((pattern) => pattern !== HELM_SECRET_FILENAME_PATTERN)) &&
    trackedHelmSecretTemplate(config.tools.git, canonical)) return "allow";
  if (certain(config.secretExceptions)) return "allow";
  if (possible(config.secretPatterns)) return "deny";
  // An ignored *directory* stays listable, matching the profile: enumeration
  // reveals names, and names are not the secret. Its files stay denied.
  const ignored = aliasLookup
    ? aliasIgnore?.get(canonical) ?? isPossiblyGitIgnored(config.tools.git, canonical)
    : isGitIgnored(config.tools.git, canonical, config.artifactAllowlist);
  if (ignored) {
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
  const evidence = targets.map((target) => {
    try {
      return inspectPath(path.resolve(target));
    } catch {
      return null;
    }
  });

  const valid = evidence.filter((target): target is PathEvidence => target !== null);
  let aliasIgnore: Map<string, boolean> | undefined;
  let exemptions: string[];
  try {
    exemptions = validExemptRoots(config);
  } catch {
    return new Map(targets.map((target) => [target, "deny"]));
  }
  try {
    primeIgnoreCache(config.tools.git, valid.filter((target) => !hasAliasLookup(target))
      .map((target) => target.canonical), config.artifactAllowlist);
    aliasIgnore = possibleIgnoreVerdicts(config.tools.git, valid.filter(hasAliasLookup)
      .map((target) => target.canonical));
  } catch {
    // Fall through: classifyPath asks git per path.
  }

  const verdicts = new Map<string, "allow" | "deny">();
  targets.forEach((target, index) => {
    try {
      if (evidence[index] === null) throw new Error("Path normalization failed");
      verdicts.set(target, classifyEvidence(evidence[index]!, config, "read", exemptions, aliasIgnore));
    } catch {
      verdicts.set(target, "deny");
    }
  });
  return verdicts;
}
