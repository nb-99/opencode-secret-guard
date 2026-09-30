/**
 * The version-independent verdict on a tool call. The V1 and V2 adapters only
 * translate their host's event shape into `checkToolCall`'s arguments, so the
 * policy has one implementation and a new host cannot drift from it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { findSecretPrinting } from "./command-policy.ts";
import type { GuardConfig } from "./policy.ts";
import { classifyPath, resolveTarget } from "./predicate.ts";
import type { FileOperation } from "./predicate.ts";
import { refusalMessage } from "./shell.ts";

/** Written to stderr by each adapter that starts in `files-only` mode. */
export const FILES_ONLY_WARNING =
  'secret-guard: running in "files-only" mode — file tools are guarded, ' +
  "shell commands are NOT. Any command can read any secret.\n";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The directory the host runs tools in, which relative tool paths are relative
 * to; undefined when the host gave none. The plugin still starts in that case,
 * because a plugin that fails to load guards no file tool at all. What it loses
 * is relative paths: `resolveTarget` refuses them, and so does every search
 * result, since neither can be classified without knowing where they point.
 */
export function hostDirectory(value: unknown): string | undefined {
  if (typeof value === "string" && path.isAbsolute(value)) return value;
  process.stderr.write(
    "secret-guard: OpenCode did not provide an absolute project directory, " +
      "so relative paths and search results will be refused.\n",
  );
  return undefined;
}

/** Argument names under which the file tools of either version take a path. */
const FILE_PATH_ARGS = ["filePath", "path", "file"] as const;

/** V1 names the patch tool `apply_patch`; V2 names it `patch`. */
const PATCH_TOOLS = new Set(["patch", "apply_patch"]);

/**
 * Tools whose path argument is optional: a search defaults to the working
 * directory, and V1's `lsp` has operations that need no file.
 */
const OPTIONAL_PATH_TOOLS = new Set(["list", "glob", "grep", "lsp"]);

/**
 * V2's browser tools that open a server-local file outside the sandbox:
 * `files.upload` and `files.drop` hand the bytes of every entry in `paths` to a
 * web page, where `browser.evaluate` can read them back, and `preview` shows
 * `path` to the user. V2 names a namespaced tool with its dots replaced by `_`.
 */
const BROWSER_FILE_TOOLS = new Set(["browser_files_upload", "browser_files_drop", "browser_preview"]);

const FILE_TOOLS = new Set(["read", "write", "edit", ...OPTIONAL_PATH_TOOLS, ...PATCH_TOOLS, ...BROWSER_FILE_TOOLS]);

/** Whether `checkToolCall` inspects this tool's arguments at all. */
export function guardsTool(tool: unknown): boolean {
  const name = String(tool ?? "").toLowerCase();
  return name === "bash" || name === "shell" || FILE_TOOLS.has(name);
}

/**
 * The refusal every guarded tool gets when the plugin could not start. Both
 * hosts load past a plugin that throws during startup, so rethrowing would
 * leave the file tools unguarded; refusing them instead makes a broken policy
 * visible at the first tool call.
 */
export function startupFailure(error: unknown): string {
  const reason = (error instanceof Error ? error.message : String(error)).replace(/^secret-guard: /, "");
  const message = `secret-guard: file and shell tools are refused because the guard could not start: ${reason}`;
  process.stderr.write(`${message}\n`);
  return message;
}

/** Tools whose path argument names something they will change. */
const WRITE_TOOLS = new Set(["write", "edit", ...PATCH_TOOLS]);

const PATCH_HEADERS = ["*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:"];

/**
 * Every path a patch names, from its `Add File`, `Update File`, `Delete File`
 * and `Move to` headers. Both hosts' parsers split on `\n` and take the header
 * text with `trim()`, so a path may hold any other character, including line
 * separators that a regex `.` would not match. Every line is tested rather than
 * only those the parsers would accept as headers, so this set can only be
 * larger than what a patch really touches, and never miss a path it writes.
 */
export function patchPaths(patchText: string): string[] {
  return patchText.split("\n").flatMap((line) => {
    const header = line.trim();
    const prefix = PATCH_HEADERS.find((candidate) => header.startsWith(candidate));
    const target = prefix ? header.slice(prefix.length).trim() : "";
    return target ? [target] : [];
  });
}

/** How V2's `read` compares names when it looks for a file the model misspelled. */
export const canonicalName = (name: string) =>
  name
    .normalize("NFC")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/[\u2018\u2019]/g, "'");

/**
 * The files V2's `read` may open instead of `target` when `target` does not
 * exist: the siblings whose canonical name equals the requested one. V2
 * authorizes only the substitute, so the guard must classify it as well or a
 * misspelled name would reach a secret the correct one cannot.
 */
function readSubstitutes(target: string): string[] {
  if (fs.existsSync(target)) return [];
  const directory = path.dirname(target);
  const wanted = canonicalName(path.basename(target));
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => canonicalName(name) === wanted)
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

/**
 * Every file a tool might open for a path argument. V2 expands a leading `~`
 * and V1 leaves it literal, so a path starting with `~` names two files and
 * both are classified; the guard cannot tell which host it runs under. A `read`
 * of a missing name also names the sibling V2 would substitute.
 */
function candidateTargets(name: string, value: string, base: string | undefined): string[] {
  const target = resolveTarget(value, base);
  const literal = base !== undefined && value.startsWith("~") ? [path.resolve(base, value)] : [];
  const substitutes = name === "read" ? readSubstitutes(target) : [];
  return [target, ...literal, ...substitutes];
}

/**
 * Throws when the call must not run. Relative paths resolve against
 * `baseDirectory`, the working directory the host runs the tool in; without
 * one they are refused.
 *
 * A file tool whose arguments carry no readable path is refused, not allowed:
 * the tool would reject such a call itself, so refusing costs nothing, while a
 * host that renamed an argument would otherwise leave every file tool unguarded
 * without any sign of it.
 */
export function checkToolCall(
  tool: unknown,
  args: unknown,
  config: GuardConfig,
  baseDirectory: string | undefined,
): void {
  const name = String(tool ?? "").toLowerCase();

  // The configured shell refuses these too; rejecting here as well gives a
  // clear error before anything runs, and covers files-only mode.
  if ((name === "bash" || name === "shell") && isRecord(args) && typeof args.command === "string") {
    const refusal = findSecretPrinting(args.command, config.secretPrintingCommands);
    if (refusal) throw new Error(`secret-guard: ${refusalMessage(refusal)}`);
    return;
  }

  if (!FILE_TOOLS.has(name)) return;
  if (!isRecord(args)) {
    throw new Error(`secret-guard: ${name} was called with arguments the guard cannot read.`);
  }

  const operation: FileOperation = WRITE_TOOLS.has(name) ? "write" : "read";
  const patched = PATCH_TOOLS.has(name) && typeof args.patchText === "string" ? patchPaths(args.patchText) : [];
  const listed = Array.isArray(args.paths) ? args.paths : [];
  const named = [...FILE_PATH_ARGS.map((key) => args[key]), ...patched, ...listed].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
  if (named.length === 0 && !OPTIONAL_PATH_TOOLS.has(name)) {
    throw new Error(`secret-guard: ${name} named no path the guard can read.`);
  }

  for (const value of named) {
    const denied = candidateTargets(name, value, baseDirectory).some(
      (candidate) => classifyPath(candidate, config, operation) === "deny",
    );
    if (denied) {
      const why = operation === "write"
        ? "it matches a secret or ignored path, or is part of the guard OpenCode runs"
        : "it matches a secret or ignored path";
      throw new Error(`secret-guard: ${operation} access to ${value} is blocked because ${why}.`);
    }
  }
}
