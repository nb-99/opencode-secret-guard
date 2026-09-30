import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/policy.ts";
import plugin from "../src/index.ts";

const policyPath = process.env.OPENCODE_SECRET_GUARD_CONFIG;
if (!policyPath) throw new Error("OPENCODE_SECRET_GUARD_CONFIG must be set");

// `server` and `setup` load the shipped policy, which is shell+files and so
// starts only on macOS; the shape test runs anywhere.
const darwin = process.platform === "darwin";

let fixture: string;

beforeAll(() => {
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-guard-index-")));
  fs.writeFileSync(path.join(fixture, "private.txt"), "x\n");
  fs.writeFileSync(path.join(fixture, ".gitignore"), "private.txt\n");
  const init = spawnSync(loadConfig(policyPath).tools.git, ["init", "-q", fixture]);
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
});

afterAll(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe("the default export", () => {
  test("carries what each host reads", () => {
    expect(plugin.id).toBe("opencode-secret-guard");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
  });

  test.skipIf(!darwin)("server guards relative paths against the directory V1 passes", async () => {
    const hooks = await plugin.server({ directory: fixture });

    await expect(hooks["tool.execute.before"]({ tool: "read" }, { args: { filePath: "private.txt" } })).rejects.toThrow(
      /blocked/,
    );
  });

  test.skipIf(!darwin)("server starts without a directory and refuses relative paths rather than guessing", async () => {
    for (const input of [{}, { directory: "relative" }, { directory: 3 }, undefined]) {
      const hooks = await plugin.server(input as { directory?: unknown });

      await expect(hooks["tool.execute.before"]({ tool: "read" }, { args: { filePath: "private.txt" } })).rejects.toThrow(
        /no project directory/,
      );
    }
  });

  test.skipIf(!darwin)("setup registers the shell check and both tool hooks on V2", async () => {
    const fake = fakeV2();
    await plugin.setup(fake.ctx);

    expect([...fake.hooks.keys()].sort()).toEqual(["shell.create.before", "tool.execute.after", "tool.execute.before"]);
    await expect(fake.run("read", { path: "private.txt" })).rejects.toThrow(/blocked/);
  });
});

/** A V2 context with hooks recorded by name; `run` passes a tool call through `execute.before`. */
function fakeV2(shellHook?: () => Promise<never>) {
  const hooks = new Map<string, (event: any) => unknown>();
  const record = (domain: string) => async (name: string, callback: (event: any) => unknown) => {
    hooks.set(`${domain}.${name}`, callback);
  };
  const ctx = {
    location: { directory: fixture },
    shell: { hook: shellHook ?? record("shell") },
    tool: { hook: record("tool") },
  } as any;
  const run = async (tool: string, input: unknown) => {
    await hooks.get("tool.execute.before")!({ tool, input });
    return "ran";
  };
  return { ctx, hooks, run };
}

describe("a policy that cannot be loaded", () => {
  /** Runs `callback` with the plugin reading an invalid policy. */
  async function withBrokenPolicy(callback: () => Promise<void>) {
    const broken = path.join(fixture, "broken-policy.json");
    fs.writeFileSync(broken, "{ not json");
    process.env.OPENCODE_SECRET_GUARD_CONFIG = broken;
    try {
      await callback();
    } finally {
      process.env.OPENCODE_SECRET_GUARD_CONFIG = policyPath;
    }
  }

  test("makes V2 refuse every shell and guarded tool instead of failing to load", async () => {
    await withBrokenPolicy(async () => {
      const fake = fakeV2();
      await plugin.setup(fake.ctx);

      const refusal = /could not start: .*invalid JSON/;
      await expect(fake.run("read", { path: "README.md" })).rejects.toThrow(refusal);
      await expect(fake.run("shell", { command: "true" })).rejects.toThrow(refusal);
      expect(() => fake.hooks.get("shell.create.before")!({ shell: "/bin/sh" })).toThrow(refusal);
      await expect(fake.run("webfetch", {})).resolves.toBe("ran");
    });
  });

  test("still refuses the tools on V2 when the shell hook cannot be registered", async () => {
    await withBrokenPolicy(async () => {
      const fake = fakeV2(() => Promise.reject(new Error("no shell domain")));
      await plugin.setup(fake.ctx);

      await expect(fake.run("read", { path: "README.md" })).rejects.toThrow(/could not start/);
    });
  });

  test("makes V1 refuse every guarded tool instead of failing to load", async () => {
    await withBrokenPolicy(async () => {
      const hooks = await plugin.server({ directory: fixture });

      await expect(hooks["tool.execute.before"]({ tool: "read" }, { args: { filePath: "README.md" } })).rejects.toThrow(
        /could not start/,
      );
      await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "true" } })).rejects.toThrow(
        /could not start/,
      );
      await expect(hooks["tool.execute.before"]({ tool: "webfetch" }, { args: {} })).resolves.toBeUndefined();
    });
  });
});
