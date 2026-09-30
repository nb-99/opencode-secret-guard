import type { V2Context } from "../src/v2.ts";

/** A V2 context that records hook registrations and replays events in order. */
export function host(directory: string | undefined, shellHook?: () => Promise<never>) {
  const registered = new Map<string, Array<(event: any) => unknown>>();
  const register = (domain: string) => async (name: string, callback: (event: any) => unknown) => {
    const key = `${domain}.${name}`;
    registered.set(key, [...(registered.get(key) ?? []), callback]);
  };
  const ctx = {
    location: { directory },
    shell: { hook: shellHook ?? register("shell") },
    tool: { hook: register("tool") },
  } as unknown as V2Context;
  const emit = async <E>(key: string, event: E): Promise<E> => {
    for (const callback of registered.get(key) ?? []) await callback(event);
    return event;
  };
  /** Returns the tool and input V2 would run after every execute.before hook. */
  const call = async (event: { tool: string; input: unknown }) => {
    await emit("tool.execute.before", event);
    return { tool: event.tool, input: event.input as any };
  };
  return { ctx, registered, emit, call };
}
