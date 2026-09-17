import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { GitignoreRules } from "./gitignore.ts";
import { findRepoRoot, gitignoreRules } from "./gitignore.ts";
import { realpath } from "./paths.ts";
import type { GuardConfig } from "./policy.ts";
import type { TamperTargets } from "./tamper.ts";
import { protectedNodes, tamperTargets } from "./tamper.ts";

export const PROFILE_VERSION = 8;

/** Quotes a literal path for SBPL. Backslashes are escaped. */
export function sbplString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Escapes a literal path for embedding in a regex. */
export function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Quotes a regex for SBPL's #"..." literal. Backslashes must pass through
 * untouched — escaping them turns "/\.env$" into "/\\.env$", which matches a
 * literal backslash and silently disables the rule.
 */
export function sbplRegex(value: string): string {
  return `#"${value.replace(/"/g, '\\"')}"`;
}

export function buildProfile(options: {
  config: GuardConfig;
  home: string;
  group: string | null;
  gitignore: GitignoreRules;
  tamper: TamperTargets;
}): string {
  const { config, home, group, gitignore, tamper } = options;
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
  ];

  // The gitignore layer denies reads only. Writing to ignored paths is normal
  // (caches, build output, logs) and blocking it would break ordinary tooling.
  //
  // Ignored directories are expressed as a "everything below this prefix"
  // regex rather than (subpath ...) so the directory inode stays readable and
  // tree walkers such as `find` do not error on the ignored directory itself.
  // Its sub-directories are re-allowed one by one in step 3, because `readdir`
  // is a file-read-data operation on the directory and would otherwise match
  // this prefix. Filenames are not the secret; their contents are.
  const ignoreTargets: string[] = [];
  if (gitignore.subpaths.length > 0) {
    const prefixes = gitignore.subpaths
      .map((p) => sbplRegex(`^${regexEscape(p)}/`))
      .join(" ");
    ignoreTargets.push(`(regex ${prefixes})`);
  }
  ignoreTargets.push(...gitignore.literals.map((p) => `(literal ${sbplString(p)})`));
  if (ignoreTargets.length > 0) {
    lines.push("", ";; 1. .gitignore — enumerated via git, reads only");
    lines.push(`(deny file-read-data ${ignoreTargets.join(" ")})`);
  }

  if (gitignore.repoRoot && config.artifactAllowlist.length > 0) {
    const root = regexEscape(gitignore.repoRoot);
    const regexes = config.artifactAllowlist
      .map((part) => sbplRegex(`^${root}/(.*/)?${regexEscape(part)}(/|$)`))
      .join(" ");
    lines.push("", ";; 2. artefact allowlist — overrides collapsed ignored parents");
    lines.push(`(allow file-read-data (regex ${regexes}))`);
  }

  if (gitignore.directories.length > 0) {
    const targets = gitignore.directories.map((p) => `(literal ${sbplString(p)})`);
    // Enumerating a directory is a file-read-data operation on the directory
    // itself, so the prefix deny above also blocks `readdir` on every
    // sub-directory of an ignored tree — which makes tree walkers such as
    // eslint fail with EPERM. Re-allowing the directory paths restores
    // enumeration; file contents keep matching the prefix deny, since a file
    // path is never equal to one of these literals.
    lines.push("", ";; 3. directories inside ignored trees stay enumerable");
    lines.push(`(allow file-read-data ${targets.join(" ")})`);
  }

  if (config.secretPatterns.length > 0) {
    const regexes = config.secretPatterns.map(sbplRegex).join(" ");
    // Reapply secrets after the artefact allowlist, so node_modules/pkg/.env
    // remains unreadable even when Git collapsed an ignored parent directory.
    lines.push("", ";; 4. secret patterns — matched against canonicalized paths");
    lines.push(`(deny file-read-data file-write* (regex ${regexes}))`);
  }

  // A rename is checked against the source path, so a file under a protected
  // name cannot be moved out. The directory carrying that name can, unless its
  // node — and the ancestors the name leads through — is unwritable too. Emitted
  // before the relaxation so a group may still rename its own directory.
  const nodes = protectedNodes(config, home);
  if (nodes.regexes.length > 0 || nodes.literals.length > 0) {
    const targets = [
      ...(nodes.regexes.length > 0 ? [`(regex ${nodes.regexes.map(sbplRegex).join(" ")})`] : []),
      ...nodes.literals.map((p) => `(literal ${sbplString(p)})`),
    ];
    lines.push("", ";; 4b. protected directory nodes and their ancestors cannot be renamed");
    lines.push(`(deny file-write* ${targets.join(" ")})`);
  }

  const relaxation = group ? config.relaxationGroups[group] : undefined;
  if (relaxation) {
    const targets = relaxation.allowPaths.map((p) =>
      `(subpath ${sbplString(realpath(path.join(home, p)))})`,
    );
    lines.push("", `;; 5. relaxation for the "${group}" group`);
    lines.push(`(allow file-read-data file-write* ${targets.join(" ")})`);
  }

  if (config.secretExceptions.length > 0) {
    const regexes = config.secretExceptions.map(sbplRegex).join(" ");
    lines.push("", ";; 6. exceptions — last matching rule wins");
    lines.push(`(allow file-read-data file-write* (regex ${regexes}))`);
  }

  if (config.denyRoots.length > 0) {
    const targets = config.denyRoots.map((p) => `(subpath ${sbplString(realpath(p))})`);
    lines.push("", ";; 7. never relaxed, never excepted");
    lines.push(`(deny file-read-data file-write* ${targets.join(" ")})`);
  }

  if (config.exemptRoots.length > 0) {
    const targets = config.exemptRoots.map((p) => `(subpath ${sbplString(realpath(p))})`);
    lines.push("", ";; 8. fully exempt, overrides everything above");
    lines.push(`(allow file-read-data file-write* ${targets.join(" ")})`);
  }

  lines.push("", ";; 9. generated guard profiles are never writable by commands");
  lines.push(
    `(deny file-write* (subpath ${sbplString(realpath(cacheDirectory()))}))`,
  );

  // Last, after the exemptions: nothing in the policy may open these up. One
  // write here would disable the guard for every later command.
  const tamperTargetsSbpl = [
    ...tamper.literals.map((p) => `(literal ${sbplString(p)})`),
    ...tamper.subpaths.map((p) => `(subpath ${sbplString(p)})`),
  ];
  if (tamperTargetsSbpl.length > 0) {
    lines.push("", ";; 10. what OpenCode loads at its next start stays as the user left it");
    lines.push(`(deny file-write* ${tamperTargetsSbpl.join(" ")})`);
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Path predicate (file tools)
// ---------------------------------------------------------------------------

export function cacheDirectory(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "opencode-secret-guard");
}

export function profilePath(options: {
  config: GuardConfig;
  home: string;
  cwd: string;
  group: string | null;
  directory?: string;
}): string {
  const { config, home, cwd, group } = options;
  const directory = options.directory ?? cacheDirectory();
  const repoRoot = findRepoRoot(cwd);
  // PATH differs between invocations (direnv, per-project shells), and the
  // writable entries become deny rules, so they are part of the identity.
  const tamper = tamperTargets({ repoRoot, pathEnvironment: process.env.PATH });

  const key = createHash("sha256")
    .update(JSON.stringify({ version: PROFILE_VERSION, repoRoot, group, home, config, tamper }))
    .digest("hex")
    .slice(0, 32);
  const target = path.join(directory, `${key}.sb`);

  try {
    const stats = fs.statSync(target);
    if (Date.now() - stats.mtimeMs < config.cacheTtlMs) return target;
  } catch {
    // Not cached yet.
  }

  const gitignore = repoRoot
    ? gitignoreRules(config.tools.git, repoRoot, config.artifactAllowlist)
    : { repoRoot: null, subpaths: [], literals: [], directories: [] };
  const profile = buildProfile({ config, home, group, gitignore, tamper });

  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, profile, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

