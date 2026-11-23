import { afterAll, beforeAll, spyOn } from "bun:test";
import * as sandbox from "../src/sandbox.ts";
import type { DeletionConfinement, HostSandbox, SandboxBackend, ShellConfinement } from "../src/sandbox.ts";
import type { V2Context } from "../src/v2.ts";

/** A V2 context that records hook registrations and replays events in order. */
export function host(directory: string | undefined, shellHook?: () => Promise<never>, extra: Record<string, unknown> = {}) {
  const registered = new Map<string, Array<(event: any) => unknown>>();
  const register = (domain: string) => async (name: string, callback: (event: any) => unknown) => {
    const key = `${domain}.${name}`;
    registered.set(key, [...(registered.get(key) ?? []), callback]);
  };
  const ctx = {
    location: { directory },
    shell: { hook: shellHook ?? register("shell") },
    tool: { hook: register("tool") },
    permission: { hook: register("permission") },
    ...extra,
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

/** Both guard modes, for tests of the file-tool layer, which must behave the same in either. */
export const MODES = ["files-only", "shell+files"] as const;

/** What a stub backend was last asked to confine. */
export type FakeBackend = SandboxBackend & {
  shellConfinements: ShellConfinement[];
  deletionConfinements: DeletionConfinement[];
};

/**
 * A backend that confines nothing and names a sandbox no host has. It stands in
 * for the host's backend wherever a test is about what the guard plans rather
 * than what a kernel enforces, so those tests run on every host.
 */
export function fakeBackend(options: { blocksSetuid?: boolean } = {}): FakeBackend {
  const backend: FakeBackend = {
    name: "fake-sandbox",
    blocksSetuid: options.blocksSetuid ?? true,
    probe: () => ({ available: true }),
    shellCommand(confinement) {
      backend.shellConfinements.push(confinement);
      return ["/fake/sandbox", `--group=${confinement.group ?? "-"}`, "/bin/sh", "-c"];
    },
    deletionCommand(confinement) {
      backend.deletionConfinements.push(confinement);
      return ["/fake/sandbox", "--delete"];
    },
    shellConfinements: [],
    deletionConfinements: [],
  };
  return backend;
}

/** The host sandbox a test sees when no backend can run. */
export const NO_SANDBOX: HostSandbox = { backend: null, reason: "fake-sandbox is unavailable in this test" };

/**
 * Replaces the host's sandbox for the tests of the calling file or describe
 * block, and restores it after them. Bun runs every test file in one process,
 * so a stub left in place would leak into the next file.
 */
export function stubHostSandbox(initial: () => HostSandbox = () => ({ backend: fakeBackend() })) {
  let current = initial;
  let spy: { mockRestore(): void } | undefined;
  beforeAll(() => {
    spy = spyOn(sandbox, "hostSandbox").mockImplementation(() => current());
  });
  afterAll(() => spy?.mockRestore());
  return {
    /** Runs `body`, and waits for the promise it returns, with `host` as the host's sandbox. */
    during<T>(host: HostSandbox, body: () => T): T {
      current = () => host;
      let result: T;
      try {
        result = body();
      } catch (error) {
        current = initial;
        throw error;
      }
      if (result instanceof Promise) return result.finally(() => { current = initial; }) as T;
      current = initial;
      return result;
    },
  };
}
