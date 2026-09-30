import * as path from "node:path";
import { createCleanupTool } from "./cleanup.ts";
import { checkToolCall, FILES_ONLY_WARNING, guardsTool, isRecord } from "./guard.ts";
import type { GuardConfig } from "./policy.ts";
import { classifyPaths } from "./predicate.ts";
import { requireWrapperFile, validatePlatform, validateShell } from "./shell.ts";

const GREP_SUMMARY = /^Found (\d+) matches( \(more matches available\))?$/;
const GREP_TRUNCATION = "(Results truncated. Consider using a more specific path or pattern.)";
const GLOB_TRUNCATION = /^\(Results are truncated: showing first (\d+) results\. Consider using a more specific path or pattern\.\)$/;
const globTruncation = (count: number) =>
  `(Results are truncated: showing first ${count} results. Consider using a more specific path or pattern.)`;

type SearchGroup = { path: string; lines: string[] };

function unrecognised(): never {
  throw new Error("the search result format was not recognised");
}

/** V1 retains ripgrep's line endings, so blank lines do not end a file group. */
function grepGroups(lines: string[]): { groups: SearchGroup[]; truncated: boolean } {
  const summary = GREP_SUMMARY.exec(lines[0] ?? "");
  if (!summary || !Number.isSafeInteger(Number(summary[1]))) unrecognised();
  const groups: SearchGroup[] = [];
  const truncated = summary[2] !== undefined;
  let current: SearchGroup | undefined;
  let ended = false;
  let count = 0;
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    if (ended) unrecognised();
    if (line === GREP_TRUNCATION) {
      ended = true;
    } else if (/^  Line [1-9]\d*: /.test(line)) {
      if (!current) unrecognised();
      current.lines.push(line);
      count++;
    } else if (line.endsWith(":") && line.length > 1) {
      if (current?.lines.length === 0) unrecognised();
      current = { path: line.slice(0, -1), lines: [] };
      groups.push(current);
    } else {
      unrecognised();
    }
  }
  // Empty groups and forged match lines can otherwise hide newlines in a path.
  if (!count || current?.lines.length === 0 || count !== Number(summary[1]) || ended !== truncated) unrecognised();
  return { groups, truncated };
}

/** Parse V1's text before classifying paths; relative results use V1's literal ~. */
export function filterSearchOutput(
  tool: "glob" | "grep",
  output: string,
  args: Record<string, unknown>,
  config: GuardConfig,
  baseDirectory: string | undefined,
): { output: string; count: number; truncated: boolean } {
  if (baseDirectory === undefined) throw new Error("OpenCode gave no project directory");
  if (output === "No files found" || output === "") return { output: "No files found", count: 0, truncated: false };
  const searchRoot = path.resolve(baseDirectory, typeof args.path === "string" && args.path ? args.path : ".");
  const lines = output.split("\n");
  let groups: SearchGroup[];
  let truncated: boolean;
  if (tool === "grep") {
    ({ groups, truncated } = grepGroups(lines));
  } else {
    const paths = lines.filter((line) => line !== "");
    const trailer = GLOB_TRUNCATION.exec(paths.at(-1) ?? "");
    truncated = trailer !== null;
    if (trailer) {
      paths.pop();
      if (Number(trailer[1]) !== paths.length) unrecognised();
    }
    groups = paths.map((file) => ({ path: file, lines: [] }));
  }
  const targets = groups.map((group) => path.resolve(searchRoot, group.path));
  const verdicts = classifyPaths([...new Set(targets)], config);
  const kept = groups.filter((_, index) => verdicts.get(targets[index]!) === "allow");
  const count = tool === "glob" ? kept.length : kept.reduce((sum, group) => sum + group.lines.length, 0);
  if (!count) return { output: "No files found", count: 0, truncated: false };
  const body = tool === "glob"
    ? kept.map((group) => group.path).join("\n")
    : `Found ${count} matches${truncated ? " (more matches available)" : ""}\n` +
      kept.map((group) => [`${group.path}:`, ...group.lines].join("\n")).join("\n\n");
  const trailer = tool === "glob" ? globTruncation(count) : GREP_TRUNCATION;
  return { output: body + (truncated ? `\n\n${trailer}` : ""), count, truncated };
}

/**
 * The hooks OpenCode V1 gets when the guard could not start: every guarded
 * tool call, `bash` included, is refused with `message`.
 */
export function createRefusingV1Hooks(message: string) {
  return {
    "tool.execute.before": async (input: { tool: unknown }) => {
      if (guardsTool(input?.tool)) throw new Error(message);
    },
  };
}

/**
 * The hooks OpenCode V1 calls, for the plugin's `server()` entry point.
 * `directory` is the project directory V1 passes in, which relative tool paths
 * are relative to; undefined when V1 gave none.
 */
export function createV1Hooks(guardConfig: GuardConfig, moduleDirectory: string, directory: string | undefined) {
  validatePlatform(guardConfig);
  let shellError: unknown = new Error("secret-guard: the shell has not been validated.");

  return {
    ...(guardConfig.cleanupRoot ? {
      tool: { cleanup_temp: createCleanupTool(guardConfig, () => shellError === undefined) },
    } : {}),
    config: async (config: { shell?: unknown }) => {
      if (guardConfig.mode === "files-only") {
        process.stderr.write(FILES_ONLY_WARNING);
        return;
      }
      try {
        validateShell(config.shell, moduleDirectory);
        shellError = undefined;
      } catch (error) {
        shellError = error;
        throw error;
      }
    },

    "tool.execute.before": async (
      input: { tool: unknown },
      output: { args: unknown },
    ) => {
      const tool = String(input?.tool ?? "").toLowerCase();
      // V1 logs and ignores config-hook errors, so enforce the check at use.
      if (guardConfig.mode === "shell+files" && tool === "bash") {
        if (shellError !== undefined) throw shellError;
        requireWrapperFile(moduleDirectory);
      }
      checkToolCall(tool, output?.args, guardConfig, directory);
    },

    "tool.execute.after": async (
      input: { tool: unknown; args?: unknown },
      output: { output?: unknown; metadata?: unknown },
    ) => {
      const tool = String(input?.tool ?? "").toLowerCase();
      if (tool !== "glob" && tool !== "grep") return;
      try {
        if (typeof output.output !== "string" || !isRecord(input.args)) unrecognised();
        const filtered = filterSearchOutput(tool, output.output, input.args, guardConfig, directory);
        output.output = filtered.output;
        output.metadata = {
          ...(isRecord(output.metadata) ? output.metadata : {}),
          [tool === "glob" ? "count" : "matches"]: filtered.count,
          truncated: filtered.truncated,
        };
      } catch (error) {
        output.output = `secret-guard: search results withheld because ${error instanceof Error ? error.message : String(error)}.`;
        output.metadata = {};
      }
    },
  };
}
