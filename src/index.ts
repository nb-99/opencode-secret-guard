/**
 * OpenCode plugin entry point, for both major versions.
 *
 * The default export carries `setup` for V2 and `server` for V1; each host reads
 * the key it knows and ignores the other (V1 object entry points need OpenCode
 * 1.18.29). V2 loads a configured plugin from a directory and resolves
 * `index.ts` in it, which is why this file is called index.ts. Everything else
 * lives beside it, where tests import it normally.
 *
 * The host types are a small structural slice, not imports from
 * @opencode-ai/plugin or @opencode/plugin: those pull in zod, effect and the
 * OpenCode SDK, which a hermetic typecheck would have to vendor. The cost is
 * that a host renaming a field is invisible to the compiler, so the adapters
 * check every event field at runtime and refuse or withhold what they cannot
 * read. The V2 shapes were read from @opencode/plugin 2.0.16 and are pinned by
 * tests/v2.test.ts against a fake host, not yet against a running V2.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hostDirectory, startupFailure } from "./guard.ts";
import { loadConfig } from "./policy.ts";
import { createRefusingV1Hooks, createV1Hooks } from "./v1.ts";
import { setupRefusingV2, setupV2 } from "./v2.ts";
import type { V2Context } from "./v2.ts";

/** This module's own directory: <package>/lib when installed. */
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: "opencode-secret-guard",

  setup: async (ctx: V2Context) => {
    try {
      await setupV2(ctx, loadConfig(), MODULE_DIRECTORY);
    } catch (error) {
      await setupRefusingV2(ctx, startupFailure(error));
    }
  },

  server: async (input: { directory?: unknown }) => {
    try {
      return createV1Hooks(loadConfig(), MODULE_DIRECTORY, hostDirectory(input?.directory));
    } catch (error) {
      return createRefusingV1Hooks(startupFailure(error));
    }
  },
};
