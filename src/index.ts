/**
 * Directory entry point: V2 calls `setup`, V1 >=1.18.29 calls `server`.
 * Local structural types avoid vendoring the host SDK dependencies for the
 * hermetic typecheck. Adapters validate tool payloads at runtime instead.
 * See docs/v2-migration.md for versioned contracts and verification evidence.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hostDirectory, startupFailure } from "./guard.ts";
import { aliasPatternDiagnostics, configPath, loadConfig } from "./policy.ts";
import { createRefusingV1Hooks, createV1Hooks } from "./v1.ts";
import { setupRefusingV2, setupV2 } from "./v2.ts";
import type { V2Context } from "./v2.ts";

/** This module's own directory: <package>/lib when installed. */
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/** The shell resolver loads policy per command; file-tool warnings belong at startup. */
function loadPluginPolicy() {
  const source = configPath();
  const config = loadConfig(source);
  for (const message of aliasPatternDiagnostics(config)) {
    process.stderr.write(`secret-guard: ${source}: ${message}\n`);
  }
  return config;
}

export default {
  id: "opencode-secret-guard",

  setup: async (ctx: V2Context) => {
    try {
      await setupV2(ctx, loadPluginPolicy(), MODULE_DIRECTORY);
    } catch (error) {
      await setupRefusingV2(ctx, startupFailure(error));
    }
  },

  server: async (input: { directory?: unknown }) => {
    try {
      return createV1Hooks(loadPluginPolicy(), MODULE_DIRECTORY, hostDirectory(input?.directory));
    } catch (error) {
      return createRefusingV1Hooks(startupFailure(error));
    }
  },
};
