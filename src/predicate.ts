import * as path from "node:path";
import { isGitIgnored, primeIgnoreCache } from "./gitignore.ts";
import { isExistingDirectory, isInside, matchesAny, realpath } from "./paths.ts";
import type { GuardConfig } from "./policy.ts";
import { cacheDirectory } from "./profile.ts";

export const FILE_PATH_ARGS = ["filePath", "path", "file"] as const;

export const FILE_TOOLS = new Set(["read", "write", "edit", "patch", "list", "glob", "grep"]);

/**
 * Mirrors the profile's rule ordering so the two layers agree:
 * exempt roots > deny roots > exceptions > secret patterns > artefact
 * allowlist > gitignore.
 */
export function classifyPath(target: string, config: GuardConfig): "allow" | "deny" {
  const canonical = realpath(path.resolve(target));

  if (isInside(canonical, realpath(cacheDirectory()))) return "deny";
  if (config.exemptRoots.some((root) => isInside(canonical, realpath(root)))) return "allow";
  if (config.denyRoots.some((root) => isInside(canonical, realpath(root)))) return "deny";
  if (matchesAny(canonical, config.secretExceptions)) return "allow";
  if (matchesAny(canonical, config.secretPatterns)) return "deny";
  // An ignored *directory* stays listable, matching the profile: enumeration
  // reveals names, and names are not the secret. Its files stay denied.
  if (isGitIgnored(canonical, config.artifactAllowlist)) {
    return isExistingDirectory(canonical) ? "allow" : "deny";
  }
  return "allow";
}

/**
 * Classifies many paths at once. The verdicts are exactly those of calling
 * `classifyPath` on each path; only the number of git subprocesses differs.
 * Anything that cannot be classified keeps the layer's default — allow — rather
 * than silently dropping a result.
 */
export function classifyPaths(
  targets: string[],
  config: GuardConfig,
): Map<string, "allow" | "deny"> {
  const canonical = targets.map((target) => realpath(path.resolve(target)));

  try {
    primeIgnoreCache(canonical, config.artifactAllowlist);
  } catch {
    // Fall through: classifyPath asks git per path.
  }

  const verdicts = new Map<string, "allow" | "deny">();
  targets.forEach((target, index) => {
    try {
      verdicts.set(target, classifyPath(canonical[index]!, config));
    } catch {
      verdicts.set(target, "allow");
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

/**
 * Grep groups hits as `<path>:\nLine …`, often using a relative path. Filtering
 * individual lines cannot work: the secret appears on the `Line …` line while
 * the path sits above it. Filter whole groups instead, resolving relative
 * headers against the requested search root.
 */
export function filterSearchOutput(
  tool: string,
  output: string,
  args: Record<string, unknown>,
  config: GuardConfig,
): string {
  const requested = typeof args.path === "string" && args.path ? args.path : ".";
  const searchRoot = path.resolve(requested);
  const isGlob = tool === "glob";

  const chunks = isGlob ? output.split("\n") : output.split(/\n{2,}/);
  const targets = chunks.map((chunk) => {
    const header = isGlob ? chunk : (chunk.split("\n", 1)[0]?.replace(/:$/, "") ?? "");
    return resultPath(header, searchRoot);
  });

  const verdicts = classifyPaths(
    targets.filter((target): target is string => target !== null),
    config,
  );

  return chunks
    .filter((_, index) => {
      const target = targets[index];
      if (!target) return true;
      return verdicts.get(target) !== "deny";
    })
    .join(isGlob ? "\n" : "\n\n");
}

