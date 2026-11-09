import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exemptRootContaining, pinExemptRoots } from "./exemptions.ts";
import { supportsAliasPattern } from "./path-pattern.ts";

/**
 * Policy file format understood by this build. The writer declares it and the
 * reader refuses anything else, so a newer policy paired with an older plugin
 * fails by name instead of silently ignoring fields it does not know.
 */
export const SUPPORTED_CONFIG_VERSION = 7;

/** Older formats that still load, with defaults for the fields they predate. */
export const ACCEPTED_CONFIG_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];

/** Overrides the policy location; otherwise the XDG default path is used. */
export const CONFIG_ENVIRONMENT = "OPENCODE_SECRET_GUARD_CONFIG";

/**
 * Fixed path for the git the guard itself spawns, unless the policy names one.
 * Spawning `git` by name would resolve through PATH, and PATH commonly holds
 * user-writable directories a sandboxed command can plant a binary in.
 */
export const DEFAULT_GIT = "/usr/bin/git";

export interface RelaxationGroup {
  binaries: string[];
  allowPaths: string[];
  /** Variable names (regexes) this group's binaries may keep despite the scrub. */
  allowEnvironment: string[];
}

export interface GuardTools {
  git: string;
}

/**
 * An invocation whose purpose is to print a credential. `binary` is matched
 * against the segment's program name; every `args` entry is a regex that some
 * shell word of the segment must match in full. An empty `args` matches any
 * invocation of the binary.
 */
export interface SecretPrintingCommand {
  binary: string;
  args: string[];
}

export interface GuardConfig {
  configVersion: number;
  mode: GuardMode;
  cleanupRoot: string | null;
  tools: GuardTools;
  secretPatterns: string[];
  secretExceptions: string[];
  artifactAllowlist: string[];
  relaxationGroups: Record<string, RelaxationGroup>;
  secretPrintingCommands: SecretPrintingCommand[];
  denyRoots: string[];
  exemptRoots: string[];
  /** Trees no command or file tool may write, such as an OpenCode installation. */
  writeProtectedRoots: string[];
  secretEnvironment: string[];
  secretEnvironmentPatterns: string[];
  cacheTtlMs: number;
  permissionReview: PermissionReviewSettings;
}

/**
 * Optional approval-only review of V2 permission prompts; see
 * permission-review.ts. "observe" reviews and reports but leaves every prompt;
 * "auto" may turn an eligible prompt into a one-time allow. The backend is
 * fixed per configuration; see review-backends.ts.
 */
export type PermissionReviewMode = "off" | "observe" | "auto";

export const PERMISSION_REVIEW_MODES: readonly PermissionReviewMode[] = ["off", "observe", "auto"];

/** `jev` is TypeSafe's System One through OpenCode Zen; the default. */
export type PermissionReviewBackend = "jev" | "opencode" | "endpoint";

export const PERMISSION_REVIEW_BACKENDS: readonly PermissionReviewBackend[] = ["jev", "opencode", "endpoint"];

/**
 * How a backend asks its model. "decisions" asks a decision model for one
 * probability per question. "text" asks a chat model to write the answers
 * object itself. "systemone" posts the System One request that Jev takes.
 */
export type OpencodeReviewApi = "decisions" | "text";
export type EndpointReviewApi = "systemone" | "decisions" | "text";
export type ReviewApi = OpencodeReviewApi | EndpointReviewApi;

/**
 * Which review toasts the terminal shows. "all" shows every phase. "attention"
 * shows only completed reviews that need the user; the sidebar shows the rest.
 */
export type ReviewToasts = "all" | "attention";

export const REVIEW_TOASTS: readonly ReviewToasts[] = ["all", "attention"];

export const OPENCODE_REVIEW_APIS: readonly OpencodeReviewApi[] = ["decisions", "text"];
export const ENDPOINT_REVIEW_APIS: readonly EndpointReviewApi[] = ["systemone", "decisions", "text"];

export interface OpencodeReviewSettings {
  /** A model OpenCode can reach, as `provider/model` with an optional `#variant`. */
  model: string;
  /** "decisions" by default; "text" for a chat model. */
  api: OpencodeReviewApi;
  deadlineMs: number;
}

export interface EndpointReviewSettings {
  /** A base URL ending before the API path: HTTPS, or HTTP on a loopback host. */
  baseURL: string;
  model: string;
  /** A file that holds the key, or null when the server needs none. Never the key itself. */
  apiKeyFile: string | null;
  deadlineMs: number;
  /** "text" (`/chat/completions`) by default; "decisions" for `/decisions`; "systemone" for `/systemone`. */
  api: EndpointReviewApi;
}

export interface PermissionReviewSettings {
  mode: PermissionReviewMode;
  /** Opt-in copy of every review request and response body; see review-log.ts. */
  logPayloads: boolean;
  /**
   * t in (0.5, 1]: the positive answers must reach t and the negative ones
   * stay at or below 1 - t. Applies to the model's yes-probabilities, which
   * are not calibrated confidence.
   */
  confidenceThreshold: number;
  backend: PermissionReviewBackend;
  toasts: ReviewToasts;
  /** Required when `backend` is "opencode", and rejected otherwise. */
  opencode?: OpencodeReviewSettings;
  /** Required when `backend` is "endpoint", and rejected otherwise. */
  endpoint?: EndpointReviewSettings;
}

export const DEFAULT_PERMISSION_REVIEW: Readonly<PermissionReviewSettings> = {
  mode: "off",
  logPayloads: false,
  confidenceThreshold: 0.9,
  backend: "jev",
  toasts: "all",
};

const PERMISSION_REVIEW_KEYS = ["mode", "logPayloads", "confidenceThreshold", "backend", "toasts", "opencode", "endpoint"];
const OPENCODE_DEFAULT_DEADLINE_MS = 10_000;
const ENDPOINT_DEFAULT_DEADLINE_MS = 20_000;
const MAX_DEADLINE_MS = 30_000;
const OPENCODE_MODEL = /^[^/\s#]+\/[^/\s#]+(#[^/\s#]+)?$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * "shell+files" is the real boundary: the kernel enforces it, so it covers
 * variable expansion, interpreters and anything else a command can reach for.
 * It needs sandbox-exec and therefore macOS.
 *
 * "files-only" drops the shell layer and keeps the path predicate, which is
 * portable. It is genuinely weaker — the shell tool becomes unguarded, and any
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
  return path.join(opencodeConfigDirectory(), "secret-guard.json");
}

/** OpenCode's global configuration directory, resolved as OpenCode does. */
export function opencodeConfigDirectory(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "opencode");
}

/** OpenCode's cache, where npm plugins are installed at startup. */
export function opencodeCacheDirectory(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "opencode");
}

/** OpenCode's data directory; `bin/` below it holds tools it installs. */
export function opencodeDataDirectory(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "opencode");
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

/**
 * Expands a leading "$TMPDIR" to the process's temporary directory. OpenCode
 * derives its own scratch directory from the same value, so the root follows
 * macOS's per-user TMPDIR instead of naming one host's randomized path.
 */
export function expandTemporary(value: string, temporary: string): string {
  if (value === "$TMPDIR") return path.resolve(temporary);
  if (value.startsWith("$TMPDIR/")) return path.join(temporary, value.slice("$TMPDIR/".length));
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
      allowEnvironment: record.allowEnvironment === undefined
        ? []
        : requireRegexArray(record.allowEnvironment, `${key}.allowEnvironment`, source),
    };
  }
  return groups;
}

export function requireTools(value: unknown, source: string): GuardTools {
  if (value === undefined) return { git: DEFAULT_GIT };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError(source, '"tools" must be an object');
  }
  const record = value as Record<string, unknown>;
  const git = record.git === undefined ? DEFAULT_GIT : record.git;
  if (typeof git !== "string" || !path.isAbsolute(git)) {
    throw configError(source, '"tools.git" must be an absolute path');
  }
  return { git };
}

export function requireSecretPrintingCommands(value: unknown, source: string): SecretPrintingCommand[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw configError(source, '"secretPrintingCommands" must be an array');
  return value.map((entry, index) => {
    const key = `secretPrintingCommands[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw configError(source, `${key} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.binary !== "string" || !record.binary || record.binary.includes("/")) {
      throw configError(source, `${key}.binary must be a program name without a slash`);
    }
    return { binary: record.binary, args: requireRegexArray(record.args, `${key}.args`, source) };
  });
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

export function requirePermissionReview(
  value: unknown,
  configVersion: number,
  source: string,
  home: string,
): PermissionReviewSettings {
  // Policies older than version 5 predate the reviewer, so it stays off.
  if (value === undefined) return { ...DEFAULT_PERMISSION_REVIEW };
  if (configVersion < 5) throw configError(source, '"permissionReview" requires configVersion 5 or later');
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError(source, '"permissionReview" must be an object');
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !PERMISSION_REVIEW_KEYS.includes(key));
  if (unknown.length > 0) {
    throw configError(source, `"permissionReview" has unknown keys: ${unknown.join(", ")}`);
  }
  const mode = record.mode === undefined ? DEFAULT_PERMISSION_REVIEW.mode : record.mode;
  if (!PERMISSION_REVIEW_MODES.includes(mode as PermissionReviewMode)) {
    throw configError(
      source,
      `"permissionReview.mode" must be one of ${PERMISSION_REVIEW_MODES.join(", ")}, not ${JSON.stringify(record.mode)}`,
    );
  }
  const logPayloads = record.logPayloads === undefined ? DEFAULT_PERMISSION_REVIEW.logPayloads : record.logPayloads;
  if (typeof logPayloads !== "boolean") {
    throw configError(source, `"permissionReview.logPayloads" must be true or false, not ${JSON.stringify(logPayloads)}`);
  }
  const confidenceThreshold = record.confidenceThreshold === undefined ? DEFAULT_PERMISSION_REVIEW.confidenceThreshold : record.confidenceThreshold;
  // 0.5 would approve an answer the model is undecided about.
  if (typeof confidenceThreshold !== "number" || !Number.isFinite(confidenceThreshold) || confidenceThreshold <= 0.5 || confidenceThreshold > 1) {
    throw configError(
      source,
      `"permissionReview.confidenceThreshold" must be a number above 0.5 and at most 1, not ${JSON.stringify(confidenceThreshold)}`,
    );
  }
  const backend = record.backend === undefined ? DEFAULT_PERMISSION_REVIEW.backend : record.backend;
  if (!PERMISSION_REVIEW_BACKENDS.includes(backend as PermissionReviewBackend)) {
    throw configError(
      source,
      `"permissionReview.backend" must be one of ${PERMISSION_REVIEW_BACKENDS.join(", ")}, not ${JSON.stringify(record.backend)}`,
    );
  }
  if (record.toasts !== undefined && configVersion < 7) {
    throw configError(source, '"permissionReview.toasts" requires configVersion 7 or later');
  }
  const toasts = record.toasts === undefined ? DEFAULT_PERMISSION_REVIEW.toasts : record.toasts;
  if (!REVIEW_TOASTS.includes(toasts as ReviewToasts)) {
    throw configError(
      source,
      `"permissionReview.toasts" must be one of ${REVIEW_TOASTS.join(", ")}, not ${JSON.stringify(record.toasts)}`,
    );
  }
  // A block for a backend that does not run is an error, so a stale block cannot look active.
  if (backend !== "opencode" && record.opencode !== undefined) {
    throw configError(source, '"permissionReview.opencode" requires backend "opencode"');
  }
  if (backend !== "endpoint" && record.endpoint !== undefined) {
    throw configError(source, '"permissionReview.endpoint" requires backend "endpoint"');
  }
  const settings = {
    mode: mode as PermissionReviewMode,
    logPayloads,
    confidenceThreshold,
    backend: backend as PermissionReviewBackend,
    toasts: toasts as ReviewToasts,
  };
  if (backend === "opencode") return { ...settings, opencode: requireOpencodeReview(record.opencode, configVersion, source) };
  if (backend === "endpoint") return { ...settings, endpoint: requireEndpointReview(record.endpoint, configVersion, source, home) };
  return settings;
}

/** Rejects keys this format does not know, and keys added after the policy's own version. */
function requireBlockKeys(record: Record<string, unknown>, key: string, fields: Record<string, number>, configVersion: number, source: string) {
  const unknown = Object.keys(record).filter((name) => !Object.hasOwn(fields, name));
  if (unknown.length > 0) throw configError(source, `"${key}" has unknown keys: ${unknown.join(", ")}`);
  for (const [name, since] of Object.entries(fields)) {
    if (record[name] !== undefined && configVersion < since) {
      throw configError(source, `"${key}.${name}" requires configVersion ${since} or later`);
    }
  }
}

function requireApi<Api extends ReviewApi>(value: unknown, key: string, allowed: readonly Api[], fallback: Api, source: string): Api {
  const api = value === undefined ? fallback : value;
  if (!allowed.includes(api as Api)) {
    throw configError(source, `"${key}.api" must be one of ${allowed.join(", ")}, not ${JSON.stringify(value)}`);
  }
  return api as Api;
}

function requireDeadline(value: unknown, key: string, fallback: number, source: string): number {
  const deadlineMs = value === undefined ? fallback : value;
  if (typeof deadlineMs !== "number" || !Number.isInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_DEADLINE_MS) {
    throw configError(source, `"${key}.deadlineMs" must be a whole number from 1 to ${MAX_DEADLINE_MS}, not ${JSON.stringify(deadlineMs)}`);
  }
  return deadlineMs;
}

function requireOpencodeReview(value: unknown, configVersion: number, source: string): OpencodeReviewSettings {
  const key = "permissionReview.opencode";
  if (!value || typeof value !== "object" || Array.isArray(value)) throw configError(source, `"${key}" must be an object`);
  const record = value as Record<string, unknown>;
  requireBlockKeys(record, key, { model: 5, api: 6, deadlineMs: 6 }, configVersion, source);
  if (typeof record.model !== "string" || !OPENCODE_MODEL.test(record.model)) {
    throw configError(
      source,
      `"${key}.model" must be "provider/model" with an optional "#variant", not ${JSON.stringify(record.model)}`,
    );
  }
  return {
    model: record.model,
    api: requireApi(record.api, key, OPENCODE_REVIEW_APIS, "decisions", source),
    deadlineMs: requireDeadline(record.deadlineMs, key, OPENCODE_DEFAULT_DEADLINE_MS, source),
  };
}

function requireEndpointReview(value: unknown, configVersion: number, source: string, home: string): EndpointReviewSettings {
  const key = "permissionReview.endpoint";
  if (!value || typeof value !== "object" || Array.isArray(value)) throw configError(source, `"${key}" must be an object`);
  const record = value as Record<string, unknown>;
  requireBlockKeys(record, key, { baseURL: 5, model: 5, apiKeyFile: 5, deadlineMs: 5, api: 6 }, configVersion, source);
  if (typeof record.baseURL !== "string" || !validEndpointURL(record.baseURL)) {
    throw configError(
      source,
      `"${key}.baseURL" must be an HTTPS URL, or an HTTP URL on localhost, 127.0.0.1 or [::1], without credentials`,
    );
  }
  if (typeof record.model !== "string" || !record.model.trim()) {
    throw configError(source, `"${key}.model" must be a non-empty string`);
  }
  let apiKeyFile: string | null = null;
  if (record.apiKeyFile !== undefined && record.apiKeyFile !== null) {
    if (typeof record.apiKeyFile !== "string" || !record.apiKeyFile.trim()) {
      throw configError(source, `"${key}.apiKeyFile" must be a path or null`);
    }
    apiKeyFile = expandHome(record.apiKeyFile, home);
    if (!path.isAbsolute(apiKeyFile)) throw configError(source, `"${key}.apiKeyFile" must be an absolute path or start with "~"`);
  }
  return {
    baseURL: record.baseURL,
    model: record.model,
    apiKeyFile,
    deadlineMs: requireDeadline(record.deadlineMs, key, ENDPOINT_DEFAULT_DEADLINE_MS, source),
    api: requireApi(record.api, key, ENDPOINT_REVIEW_APIS, "text", source),
  };
}

function validEndpointURL(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

export function validateConfig(
  raw: unknown,
  source: string,
  home: string,
  temporary = os.tmpdir(),
): GuardConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw configError(source, "policy must be a JSON object");
  }
  const record = raw as Record<string, unknown>;

  if (
    typeof record.configVersion !== "number" ||
    !ACCEPTED_CONFIG_VERSIONS.includes(record.configVersion)
  ) {
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
    cleanupRoot = expandTemporary(expandHome(record.cleanupRoot, home), temporary);
  }
  if (cleanupRoot !== null) {
    if (record.configVersion < 2) {
      throw configError(source, '"cleanupRoot" requires configVersion 2 or later');
    }
    if (!path.isAbsolute(cleanupRoot) || path.resolve(cleanupRoot) === path.parse(cleanupRoot).root) {
      throw configError(source, '"cleanupRoot" must be an absolute directory below the filesystem root');
    }
    if (mode !== "shell+files") {
      throw configError(source, '"cleanupRoot" requires mode "shell+files"');
    }
  }

  const permissionReview = requirePermissionReview(record.permissionReview, record.configVersion, source, home);
  const relaxationGroups = requireRelaxationGroups(record.relaxationGroups, source);
  const denyRoots = requireRoots(record.denyRoots, "denyRoots", source, home);
  const exemptRoots = requireRoots(record.exemptRoots, "exemptRoots", source, home);
  const writeProtectedRoots = record.writeProtectedRoots === undefined
    ? []
    : requireRoots(record.writeProtectedRoots, "writeProtectedRoots", source, home);
  // An older guard would not know the field. Its version gate refuses the
  // policy instead, but only if the policy declares the version that added it.
  if (writeProtectedRoots.length > 0 && record.configVersion < 4) {
    throw configError(source, '"writeProtectedRoots" requires configVersion 4 or later');
  }
  const config: GuardConfig = {
    configVersion: SUPPORTED_CONFIG_VERSION,
    mode: mode as GuardMode,
    cleanupRoot,
    tools: requireTools(record.tools, source),
    secretPatterns: requireRegexArray(record.secretPatterns, "secretPatterns", source),
    secretExceptions: requireRegexArray(record.secretExceptions, "secretExceptions", source),
    artifactAllowlist: requireStringArray(record.artifactAllowlist, "artifactAllowlist", source),
    relaxationGroups,
    secretPrintingCommands: requireSecretPrintingCommands(record.secretPrintingCommands, source),
    denyRoots,
    exemptRoots,
    writeProtectedRoots,
    secretEnvironment: requireEnvironmentNames(
      record.secretEnvironment,
      "secretEnvironment",
      source,
    ),
    secretEnvironmentPatterns: record.secretEnvironmentPatterns === undefined
      ? []
      : requireRegexArray(record.secretEnvironmentPatterns, "secretEnvironmentPatterns", source),
    cacheTtlMs: record.cacheTtlMs,
    permissionReview,
  };

  // An exemption above a guarded root would reopen renaming that guarded root.
  // Pin once, then compare ancestor identities without helper processes.
  const guardedRoots = pinExemptRoots(config).length === 0 ? [] : [
    ...denyRoots,
    ...Object.values(relaxationGroups).flatMap((group) => group.allowPaths.map((relative) => path.join(home, relative))),
  ];
  for (const guarded of guardedRoots) {
    const containing = exemptRootContaining(config, guarded);
    if (containing) {
      throw configError(source, `"exemptRoots" entry ${containing} contains the guarded path ${guarded}; an exempt root must lie inside a guarded one, not around it`);
    }
  }
  return config;
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

/** Valid JavaScript syntax need not fit the bounded filesystem-alias grammar. */
export function aliasPatternDiagnostics(config: Pick<GuardConfig, "secretPatterns" | "secretExceptions">): string[] {
  const messages: string[] = [];
  for (const key of ["secretPatterns", "secretExceptions"] as const) {
    for (const pattern of new Set(config[key])) {
      if (supportsAliasPattern(pattern)) continue;
      const consequence = key === "secretPatterns"
        ? "it is treated as a possible denial for every path and may deny all non-exempt workspace files"
        : "it cannot grant a naming exception";
      messages.push(`"${key}" pattern ${JSON.stringify(pattern)} is unsupported by the bounded alias matcher; ` +
        `on case-insensitive or unknown filesystem paths ${consequence}. Known-sensitive paths retain JavaScript regex behavior.`);
    }
  }
  return messages;
}
