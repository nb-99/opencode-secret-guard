/**
 * OpenCode plugin entry point.
 *
 * OpenCode treats every exported runtime function as a plugin factory, so this
 * module deliberately exports one thing. Everything else lives in hooks.ts,
 * where tests and the resolver import it normally.
 *
 * The factory is typed structurally rather than through @opencode-ai/plugin:
 * that package depends on zod, effect and the OpenCode SDK, so importing one
 * type from it would make a hermetic typecheck vendor the whole tree. Writing a
 * stand-in declaration instead would be worse — a hand-written type that drifts
 * from the real interface hides exactly the mismatch it claims to catch. The
 * hook names and shapes are pinned by tests against the real runtime.
 */
import { createHooks } from "./hooks.ts";
import { loadConfig } from "./policy.ts";

type PluginFactory = () => Promise<ReturnType<typeof createHooks>>;

const plugin: PluginFactory = async () => createHooks(loadConfig());

export default plugin;
