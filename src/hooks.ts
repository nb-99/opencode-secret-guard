import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findSecretPrinting } from "./command-policy.ts";
import type { GuardConfig } from "./policy.ts";
import { FILE_PATH_ARGS, FILE_TOOLS, WRITE_TOOLS, classifyPath, filterSearchOutput } from "./predicate.ts";
import { refusalMessage, validatePlatform, validateShell } from "./shell.ts";
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

      // The configured shell refuses these too; rejecting here as well gives a
      // clear error before anything runs, and covers files-only mode.
      if ((tool === "bash" || tool === "shell") && typeof record.command === "string") {
        const refusal = findSecretPrinting(record.command, guardConfig.secretPrintingCommands);
        if (refusal) throw new Error(`secret-guard: ${refusalMessage(refusal)}`);
        return;
      }

      if (!FILE_TOOLS.has(tool)) return;
      if ((tool === "glob" || tool === "grep") && typeof input.callID === "string") {
        searchArgs.set(input.callID, record);
      }

      const operation = WRITE_TOOLS.has(tool) ? "write" : "read";
      for (const key of FILE_PATH_ARGS) {
        const value = record[key];
        if (typeof value !== "string" || !value) continue;
        if (classifyPath(value, guardConfig, operation) === "deny") {
          const why = operation === "write"
            ? "it matches a secret or ignored path, or is part of the guard OpenCode runs"
            : "it matches a secret or ignored path";
          throw new Error(`secret-guard: ${operation} access to ${value} is blocked because ${why}.`);
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
