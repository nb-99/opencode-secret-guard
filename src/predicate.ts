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

// ---------------------------------------------------------------------------
// Profile cache
// ---------------------------------------------------------------------------

export function resultPath(raw: string, searchRoot: string): string | null {
  const candidate = raw.trim();
  if (!candidate || /^Line \d+:/.test(candidate)) return null;
  return path.isAbsolute(candidate) ? candidate : path.resolve(searchRoot, candidate);
}

/** Grep's first line, `Found N matches`, sits directly above the first file group. */
const GREP_SUMMARY = /^Found \d+ matches[^\n]*\n/;

/**
 * Grep groups hits as `<path>:\nLine …`, often using a relative path. Filtering
 * individual lines cannot work: the secret appears on the `Line …` line while
 * the path sits above it. Filter whole groups instead, resolving relative
 * headers against the requested search root.
 *
 * The summary line is set aside first: no blank line separates it from the
 * first group, so left in place it would be read as that group's path and the
 * group would never be classified.
 */
export function filterSearchOutput(
  tool: string,
  output: string,
  args: Record<string, unknown>,
  config: GuardConfig,
  baseDirectory: string | undefined,
): string {
  const requested = typeof args.path === "string" && args.path ? args.path : ".";
  const searchRoot = resolveTarget(requested, baseDirectory);
  const isGlob = tool === "glob";

  const summary = isGlob ? "" : GREP_SUMMARY.exec(output)?.[0] ?? "";
  const body = output.slice(summary.length);
  const chunks = isGlob ? body.split("\n") : body.split(/\n{2,}/);
  const targets = chunks.map((chunk) => {
    const header = isGlob ? chunk : (chunk.split("\n", 1)[0]?.replace(/:$/, "") ?? "");
    return resultPath(header, searchRoot);
  });

  const verdicts = classifyPaths(
    targets.filter((target): target is string => target !== null),
    config,
  );

  return summary + chunks
    .filter((_, index) => {
      const target = targets[index];
      if (!target) return true;
      return verdicts.get(target) !== "deny";
    })
    .join(isGlob ? "\n" : "\n\n");
}
