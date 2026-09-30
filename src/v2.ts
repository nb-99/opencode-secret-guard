/**
 * The OpenCode V2 adapter: translates V2's hook events into the policy in
 * guard.ts and rewrites glob and grep results.
 *
 * A hook that throws rejects the call: V2 turns the throw into a defect, so the
 * tool does not run. `execute.after` has no failure channel at all, so its hook
 * must not throw; it withholds the result instead.
 */
import * as path from "node:path";
import { checkToolCall, FILES_ONLY_WARNING, guardsTool, hostDirectory, isRecord } from "./guard.ts";
import type { GuardConfig } from "./policy.ts";
import { classifyPaths } from "./predicate.ts";
import { validatePlatform, validateShell } from "./shell.ts";

type MaybePromise = void | Promise<void>;

interface ToolBefore {
  tool: string;
  input: unknown;
}

interface ToolAfter {
  tool: string;
  status: string;
  result?: { output?: unknown; content?: unknown; metadata?: unknown };
}

/**
 * The slice of V2's plugin context this adapter uses. Typed structurally for
 * the reason src/index.ts gives; the shapes were read from `@opencode/plugin`
 * 2.0.16 and every field is checked where it enters.
 */
export interface V2Context {
  readonly location: { readonly directory: string };
  readonly shell: {
    hook(name: "create.before", callback: (event: { shell?: unknown }) => MaybePromise): Promise<unknown>;
  };
  readonly tool: {
    hook(name: "execute.before", callback: (event: ToolBefore) => MaybePromise): Promise<unknown>;
    hook(name: "execute.after", callback: (event: ToolAfter) => MaybePromise): Promise<unknown>;
  };
}

/** Where the missing V2 permission prompt is tracked. */
const CLEANUP_ISSUE = "https://github.com/nb-99/opencode-secret-guard/issues/16";

const UNRECOGNISED = "secret-guard: search results withheld because their format was not recognised.";
const UNCHECKED = "secret-guard: search results withheld because they could not be checked.";
const NO_DIRECTORY = "secret-guard: search results withheld because OpenCode gave no project directory.";

type Entry = { path: string; type?: unknown };
type Match = { entry: Entry; line: number; text: string };

const isEntry = (value: unknown): value is Entry => isRecord(value) && typeof value.path === "string";

const isMatch = (value: unknown): value is Match =>
  isRecord(value) && isEntry(value.entry) && typeof value.line === "number" && typeof value.text === "string";

const truncation = (shown: number) =>
  ["", `(Results are truncated: showing first ${shown} results. Consider using a more specific path or pattern.)`];

/** The text the model reads for a glob, as V2's own tool formats it. */
function globContent(entries: Entry[], base: string, truncated: boolean): string {
  const lines = entries.length === 0 ? ["No files found"] : entries.map((entry) => path.resolve(base, entry.path));
  return [...lines, ...(truncated ? truncation(entries.length) : [])].join("\n");
}

/** The text the model reads for a grep, as V2's own tool formats it. */
function grepContent(matches: Match[], base: string, truncated: boolean): string {
  const lines = matches.length === 0 ? ["No matches found"] : [`Found ${matches.length} matches`];
  let current = "";
  for (const match of matches) {
    const file = path.resolve(base, match.entry.path);
    if (current !== file) {
      if (current) lines.push("");
      current = file;
      lines.push(`${file}:`);
    }
    lines.push(`  Line ${match.line}: ${match.text}`);
  }
  return [...lines, ...(truncated ? truncation(matches.length) : [])].join("\n");
}

/**
 * Removes every result whose file is denied from both the structured output and
 * the text built from it. The text is rebuilt from the surviving entries rather
 * than parsed, so a path spelled with a newline or a colon cannot confuse the
 * filter. Returns null when the result is not the shape this adapter knows.
 */
function filterSearchResult(
  tool: "glob" | "grep",
  result: NonNullable<ToolAfter["result"]>,
  config: GuardConfig,
  base: string,
): { output: unknown[]; content: string; metadata: Record<string, unknown> } | null {
  const output = result.output;
  if (!Array.isArray(output)) return null;
  const metadata = isRecord(result.metadata) ? result.metadata : {};
  const truncated = metadata.truncated === true;

  const fileOf = (item: unknown) => (tool === "glob" ? (item as Entry).path : (item as Match).entry.path);
  if (!output.every(tool === "glob" ? isEntry : isMatch)) return null;

  const targets = output.map((item) => path.resolve(base, fileOf(item)));
  const verdicts = classifyPaths([...new Set(targets)], config);
  const kept = output.filter((_, index) => verdicts.get(targets[index]!) !== "deny");

  return tool === "glob"
    ? {
        output: kept,
        content: globContent(kept as Entry[], base, truncated),
        metadata: { ...metadata, count: kept.length },
      }
    : {
        output: kept,
        content: grepContent(kept as Match[], base, truncated),
        metadata: { ...metadata, matches: kept.length },
      };
}

/**
 * Registers the guard on OpenCode V2. The shell check runs on every shell the
 * host creates, because V2 resolves the configured shell afresh and falls back
 * to the platform shell when that path is not a file.
 */
export async function setupV2(ctx: V2Context, guardConfig: GuardConfig, moduleDirectory: string): Promise<void> {
  validatePlatform(guardConfig);
  const base = hostDirectory(ctx.location?.directory);

  if (guardConfig.mode === "files-only") {
    process.stderr.write(FILES_ONLY_WARNING);
  } else {
    await ctx.shell.hook("create.before", (event) => validateShell(event.shell, moduleDirectory));
  }

  await ctx.tool.hook("execute.before", (event) => checkToolCall(event.tool, event.input, guardConfig, base));

  await ctx.tool.hook("execute.after", (event) => {
    const tool = String(event.tool ?? "").toLowerCase();
    if (tool !== "glob" && tool !== "grep") return;
    // Whatever `status` says, a result that is present gets filtered: a host
    // that renamed the success status must not switch the filter off. Only a
    // failed call with no result at all has nothing to filter.
    if (event.result === undefined && event.status !== "completed") return;
    if (base === undefined) {
      event.result = { content: NO_DIRECTORY };
      return;
    }
    try {
      const filtered = isRecord(event.result) ? filterSearchResult(tool, event.result, guardConfig, base) : null;
      event.result = filtered ?? { content: UNRECOGNISED };
    } catch (error) {
      // Withholding is the safe answer, but say why: a git or filesystem failure
      // would otherwise look like every search returning nothing useful.
      process.stderr.write(
        `secret-guard: could not check ${tool} results: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      event.result = { content: UNCHECKED };
    }
  });

  if (guardConfig.cleanupRoot) {
    process.stderr.write(`secret-guard: cleanup_temp is not available on OpenCode V2 (${CLEANUP_ISSUE}).\n`);
  }
}

/**
 * Refuses every shell and guarded tool call with `message`. The tools come
 * first, so a failure to register the shell hook cannot leave them unguarded.
 */
export async function setupRefusingV2(ctx: V2Context, message: string): Promise<void> {
  const refuse = () => {
    throw new Error(message);
  };
  await ctx.tool.hook("execute.before", (event) => {
    if (guardsTool(event.tool)) refuse();
  });
  try {
    await ctx.shell.hook("create.before", refuse);
  } catch (error) {
    process.stderr.write(`secret-guard: could not refuse shells: ${error instanceof Error ? error.message : error}\n`);
  }
}
