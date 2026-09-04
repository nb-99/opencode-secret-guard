import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { GuardConfig } from "./policy.ts";
import { FILE_PATH_ARGS, FILE_TOOLS, classifyPath, filterSearchOutput } from "./predicate.ts";
import { validatePlatform, validateShell } from "./shell.ts";
import { createCleanupTool } from "./cleanup.ts";

/** This module's own directory: <package>/lib when installed. */
export const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export function createHooks(guardConfig: GuardConfig, moduleDirectory = MODULE_DIRECTORY) {
  const searchArgs = new Map<string, Record<string, unknown>>();
  validatePlatform(guardConfig);
  let shellValidated = false;

  return {
    ...(guardConfig.cleanupRoot ? {
      tool: { cleanup_temp: createCleanupTool(guardConfig, () => shellValidated) },
    } : {}),
    config: async (config: { shell?: unknown }) => {
      shellValidated = false;
      if (guardConfig.mode === "files-only") {
        // Loud, once, on the channel a user actually sees. A weaker boundary
        // that announces itself is defensible; one that does not is not.
        process.stderr.write(
          'secret-guard: running in "files-only" mode — file tools are guarded, ' +
            "the bash tool is NOT. Any command can read any secret.\n",
        );
        return;
      }
      validateShell(config.shell, moduleDirectory);
      shellValidated = true;
    },

    "tool.execute.before": async (
      input: { tool: any; callID?: unknown },
      output: { args: any },
    ) => {
      const tool = String(input?.tool ?? "").toLowerCase();
      const args = output?.args;
      if (!args || typeof args !== "object") return;
      const record = args as Record<string, unknown>;

      if (!FILE_TOOLS.has(tool)) return;
      if ((tool === "glob" || tool === "grep") && typeof input.callID === "string") {
        searchArgs.set(input.callID, record);
      }

      for (const key of FILE_PATH_ARGS) {
        const value = record[key];
        if (typeof value !== "string" || !value) continue;
        if (classifyPath(value, guardConfig) === "deny") {
          throw new Error(
            `secret-guard: access to ${value} is blocked because it matches a secret or ignored path.`,
          );
        }
      }
    },

    "tool.execute.after": async (
      input: { tool: any; callID?: unknown; args?: Record<string, unknown> },
      output: { output?: unknown },
    ) => {
      const tool = String(input?.tool ?? "").toLowerCase();
      if (tool !== "glob" && tool !== "grep") return;
      if (typeof output?.output !== "string") return;

      const callID = typeof input.callID === "string" ? input.callID : "";
      const args = searchArgs.get(callID) ?? input.args ?? {};
      searchArgs.delete(callID);
      output.output = filterSearchOutput(tool, output.output, args, guardConfig);
    },
  };
}
