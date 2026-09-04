import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Policy file format understood by this build. The writer declares it and the
 * reader refuses anything else, so a newer policy paired with an older plugin
 * fails by name instead of silently ignoring fields it does not know.
 */
export const SUPPORTED_CONFIG_VERSION = 2;

/** Overrides the policy location; otherwise the XDG default path is used. */
export const CONFIG_ENVIRONMENT = "OPENCODE_SECRET_GUARD_CONFIG";

export interface RelaxationGroup {
  binaries: string[];
  allowPaths: string[];
}

export interface GuardConfig {
  configVersion: number;
  mode: GuardMode;
  cleanupRoot: string | null;
  secretPatterns: string[];
  secretExceptions: string[];
  artifactAllowlist: string[];
  relaxationGroups: Record<string, RelaxationGroup>;
  denyRoots: string[];
  exemptRoots: string[];
  secretEnvironment: string[];
  cacheTtlMs: number;
}

/**
 * "shell+files" is the real boundary: the kernel enforces it, so it covers
 * variable expansion, interpreters and anything else a command can reach for.
 * It needs sandbox-exec and therefore macOS.
 *
 * "files-only" drops the shell layer and keeps the path predicate, which is
 * portable. It is genuinely weaker — the bash tool becomes unguarded, and any
 * command can read anything the user can — so it must be asked for explicitly
 * and is announced at startup. Falling back to it automatically would be the
 * worst option available: the guard would look installed while guarding much
 * less than the reader assumes.
 */
export type GuardMode = "shell+files" | "files-only";

export const GUARD_MODES: readonly GuardMode[] = ["shell+files", "files-only"];

/**
 * Where the policy lives. The environment variable exists for tests and for
 * hosts that place the file elsewhere; the default path is what an installer
 * writes, so the plugin needs no build-time substitution and no environment
 * plumbing into the OpenCode process.
 */
export function configPath(): string {
  const override = process.env[CONFIG_ENVIRONMENT];
  if (override) return override;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "secret-guard.json");
}

export function configError(source: string, message: string): Error {
  return new Error(`secret-guard: ${source}: ${message}`);
}

export function requireStringArray(value: unknown, key: string, source: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw configError(source, `"${key}" must be an array of strings`);
  }
  return value as string[];
}

/**
 * Patterns are compiled here rather than at first use because matchesAny treats
 * an uncompilable pattern as "no match": an invalid deny pattern would silently
 * stop guarding instead of failing. Only the JavaScript engine can be checked —
 * SBPL has its own — so the profile layer still depends on patterns staying in
 * the common subset, which is what the suffix/component anchoring convention
 * keeps them in.
 */
export function requireRegexArray(value: unknown, key: string, source: string): string[] {
  const patterns = requireStringArray(value, key, source);
  for (const pattern of patterns) {
    try {
      new RegExp(pattern);
    } catch {
      throw configError(source, `"${key}" contains an invalid regular expression: ${pattern}`);
    }
  }
  return patterns;
}

/** Expands a leading "~" so a published policy need not name a real home. */
export function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

export function requireRoots(value: unknown, key: string, source: string, home: string): string[] {
  const roots = requireStringArray(value, key, source).map((entry) => expandHome(entry, home));
  for (const root of roots) {
    if (!path.isAbsolute(root)) {
      throw configError(source, `"${key}" entry must be an absolute path or start with "~": ${root}`);
    }
  }
  return roots;
}

export function requireRelaxationGroups(
  value: unknown,
  source: string,
): Record<string, RelaxationGroup> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError(source, '"relaxationGroups" must be an object');
  }

  const groups: Record<string, RelaxationGroup> = {};
  for (const [name, group] of Object.entries(value as Record<string, unknown>)) {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      throw configError(source, `relaxation group "${name}" must be an object`);
    }
    const record = group as Record<string, unknown>;
    const key = `relaxationGroups.${name}`;
    const allowPaths = requireStringArray(record.allowPaths, `${key}.allowPaths`, source);

    // buildProfile joins these onto $HOME, and path.join would quietly turn an
    // absolute "/etc/x" into "$HOME/etc/x" — a rule that grants nothing and
    // looks like it grants something.
    for (const entry of allowPaths) {
      if (path.isAbsolute(entry) || entry.startsWith("~")) {
        throw configError(source, `"${key}.allowPaths" entry must be relative to $HOME: ${entry}`);
      }
    }

    groups[name] = {
      binaries: requireStringArray(record.binaries, `${key}.binaries`, source),
      allowPaths,
    };
  }
  return groups;
}

/**
 * Environment names are passed to the shell wrapper one per line, so a name
 * carrying a newline would let a policy inject an argument into the scrub list.
 * Restricting them to the portable form keeps that protocol unambiguous.
 */
export function requireEnvironmentNames(value: unknown, key: string, source: string): string[] {
  const names = requireStringArray(value, key, source);
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw configError(source, `"${key}" contains an invalid variable name: ${name}`);
    }
  }
  return names;
}

export function validateConfig(raw: unknown, source: string, home: string): GuardConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw configError(source, "policy must be a JSON object");
  }
  const record = raw as Record<string, unknown>;

  if (record.configVersion !== 1 && record.configVersion !== SUPPORTED_CONFIG_VERSION) {
    throw configError(
      source,
      `unsupported configVersion ${JSON.stringify(record.configVersion)}, this build requires ${SUPPORTED_CONFIG_VERSION}`,
    );
  }

  if (
    typeof record.cacheTtlMs !== "number" ||
    !Number.isFinite(record.cacheTtlMs) ||
    record.cacheTtlMs < 0
  ) {
    throw configError(source, '"cacheTtlMs" must be a non-negative finite number');
  }

  // Defaulting to the strong mode means an older policy that predates this
  // field keeps its full boundary rather than silently weakening.
  const mode = record.mode === undefined ? "shell+files" : record.mode;
  if (!GUARD_MODES.includes(mode as GuardMode)) {
    throw configError(
      source,
      `"mode" must be one of ${GUARD_MODES.join(", ")}, not ${JSON.stringify(record.mode)}`,
    );
  }

  let cleanupRoot: string | null = null;
  if (record.cleanupRoot != null) {
    if (typeof record.cleanupRoot !== "string" || !record.cleanupRoot.trim() || /[\0\r\n]/.test(record.cleanupRoot)) {
      throw configError(source, '"cleanupRoot" must be an absolute directory or null');
    }
    cleanupRoot = expandHome(record.cleanupRoot, home);
  }
  if (cleanupRoot !== null) {
    if (record.configVersion !== SUPPORTED_CONFIG_VERSION) {
      throw configError(source, '"cleanupRoot" requires configVersion 2');
    }
    if (!path.isAbsolute(cleanupRoot) || path.resolve(cleanupRoot) === path.parse(cleanupRoot).root) {
      throw configError(source, '"cleanupRoot" must be an absolute directory below the filesystem root');
    }
    if (mode !== "shell+files") {
      throw configError(source, '"cleanupRoot" requires mode "shell+files"');
    }
  }

  return {
    configVersion: SUPPORTED_CONFIG_VERSION,
    mode: mode as GuardMode,
    cleanupRoot,
    secretPatterns: requireRegexArray(record.secretPatterns, "secretPatterns", source),
    secretExceptions: requireRegexArray(record.secretExceptions, "secretExceptions", source),
    artifactAllowlist: requireStringArray(record.artifactAllowlist, "artifactAllowlist", source),
    relaxationGroups: requireRelaxationGroups(record.relaxationGroups, source),
    denyRoots: requireRoots(record.denyRoots, "denyRoots", source, home),
    exemptRoots: requireRoots(record.exemptRoots, "exemptRoots", source, home),
    secretEnvironment: requireEnvironmentNames(
      record.secretEnvironment,
      "secretEnvironment",
      source,
    ),
    cacheTtlMs: record.cacheTtlMs,
  };
}

export function loadConfig(source = configPath(), home = os.homedir()): GuardConfig {
  let text: string;
  try {
    text = fs.readFileSync(source, "utf8");
  } catch {
    throw new Error(
      `secret-guard: cannot read the policy at ${source}. Install one there or set ${CONFIG_ENVIRONMENT}.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw configError(source, `invalid JSON: ${message}`);
  }

  return validateConfig(raw, source, home);
}
