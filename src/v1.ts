import { createCleanupTool } from "./cleanup.ts";
import { checkToolCall, FILES_ONLY_WARNING, guardsTool } from "./guard.ts";
import type { GuardConfig } from "./policy.ts";
import { filterSearchOutput } from "./predicate.ts";
import { requireWrapperFile, validatePlatform, validateShell } from "./shell.ts";

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
        // A weaker boundary that announces itself is defensible; one that does
        // not is not.
        process.stderr.write(FILES_ONLY_WARNING);
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
      // V1 picks its shell afresh for every command and falls back to the
      // platform shell when the wrapper is gone, but the config hook checked it
      // only once. A wrapper that has vanished since must stop the command.
      if (shellValidated && tool === "bash") requireWrapperFile(moduleDirectory);
      checkToolCall(tool, output?.args, guardConfig, directory);

      if ((tool === "glob" || tool === "grep") && typeof input.callID === "string" && output?.args) {
        searchArgs.set(input.callID, output.args as Record<string, unknown>);
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
      output.output = filterSearchOutput(tool, output.output, args, guardConfig, directory);
    },
  };
}
