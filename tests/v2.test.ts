import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/policy.ts";
import type { GuardConfig } from "../src/policy.ts";
import { setupV2 } from "../src/v2.ts";
import type { V2Context } from "../src/v2.ts";

const policyPath = process.env.OPENCODE_SECRET_GUARD_CONFIG;
if (!policyPath) throw new Error("OPENCODE_SECRET_GUARD_CONFIG must be set");

let fixture: string;
let repo: string;
let packageLib: string;
let config: GuardConfig;
/**
 * shell+files needs macOS, so elsewhere the suite runs the file-tool layer under
 * files-only and skips what only exists in shell+files mode.
 */
const darwin = process.platform === "darwin";
let portable: GuardConfig;

beforeAll(() => {
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-guard-v2-")));
  repo = path.join(fixture, "repo");
  packageLib = path.join(fixture, "package", "lib");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "package", "bin"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "package", "bin", "opencode-secret-guard"), "#!/bin/sh\n");
  for (const file of [".env", "id_rsa", "README.md", "opencode.json", "src/index.ts", "private.txt"]) {
    fs.writeFileSync(path.join(repo, file), "x\n");
  }
  // private.txt is denied by the gitignore alone, so it is denied only when a
  // relative name is resolved inside the repository; link-to-env is denied
  // only by following the link.
  fs.writeFileSync(path.join(repo, ".gitignore"), "private.txt\n");
  fs.symlinkSync(path.join(repo, ".env"), path.join(repo, "link-to-env"));
  config = loadConfig(policyPath);
  portable = darwin ? config : { ...config, mode: "files-only" };
  spawnSync(config.tools.git, ["init", "-q", repo]);
});

afterAll(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

/** A V2 context that records hook registrations and replays events through them. */
function host(directory: string | undefined = repo) {
  const registered = new Map<string, Array<(event: any) => unknown>>();
  const register = (domain: string) => async (name: string, callback: (event: any) => unknown) => {
    const key = `${domain}.${name}`;
    registered.set(key, [...(registered.get(key) ?? []), callback]);
  };
  const ctx = {
    location: { directory },
    shell: { hook: register("shell") },
    tool: { hook: register("tool") },
  } as unknown as V2Context;
  const emit = async <E>(key: string, event: E): Promise<E> => {
    for (const callback of registered.get(key) ?? []) await callback(event);
    return event;
  };
  return { ctx, registered, emit };
}

async function started(guardConfig: GuardConfig = portable, directory: string | undefined = repo) {
  const fake = host(directory);
  await setupV2(fake.ctx, guardConfig, packageLib);
  return fake;
}

/** Runs `callback` with stderr captured. */
async function captureStderr(callback: () => Promise<unknown>): Promise<string> {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (chunk: any) => {
    written.push(String(chunk));
    return true;
  };
  try {
    await callback();
  } finally {
    (process.stderr as any).write = original;
  }
  return written.join("");
}

const before = (tool: string, input: unknown) => ({ tool, input });
const completed = (tool: string, result: Record<string, unknown>) => ({ tool, status: "completed", result }) as {
  tool: string;
  status: string;
  result?: { output?: unknown; content?: unknown; metadata?: unknown };
};

describe("registration", () => {
  test.skipIf(!darwin)("registers the shell check and both tool hooks", async () => {
    const { registered } = await started();
    expect([...registered.keys()].sort()).toEqual(["shell.create.before", "tool.execute.after", "tool.execute.before"]);
  });

  test("files-only announces the reduced boundary and registers no shell check", async () => {
    let fake!: ReturnType<typeof host>;
    const stderr = await captureStderr(async () => {
      fake = await started({ ...portable, mode: "files-only" });
    });

    expect(stderr).toMatch(/files-only/);
    expect(fake.registered.has("shell.create.before")).toBe(false);
    await expect(fake.emit("tool.execute.before", before("read", { path: ".env" }))).rejects.toThrow("blocked");
  });

  test("shell+files refuses to start off macOS rather than pretending", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await expect(setupV2(host().ctx, config, packageLib)).rejects.toThrow(/needs macOS/);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  test("starts without a project directory, refusing what it cannot place", async () => {
    // A plugin that fails to load guards no file tool, so it must not fail here.
    // "" stands for a missing one: passing undefined would select started()'s default.
    for (const directory of ["relative/dir", ""]) {
      let fake!: ReturnType<typeof host>;
      const stderr = await captureStderr(async () => {
        fake = await started(portable, directory);
      });
      expect(stderr).toMatch(/did not provide an absolute project directory/);

      await expect(fake.emit("tool.execute.before", before("read", { path: "README.md" }))).rejects.toThrow(
        /no project directory/,
      );
      await expect(fake.emit("tool.execute.before", before("read", { path: ".env" }))).rejects.toThrow(/no project directory/);
      // An absolute path needs no directory to be classified.
      await expect(fake.emit("tool.execute.before", before("read", { path: path.join(repo, ".env") }))).rejects.toThrow(
        "blocked",
      );
      await expect(fake.emit("tool.execute.before", before("read", { path: path.join(repo, "README.md") }))).resolves
        .toBeDefined();

      const after = await fake.emit("tool.execute.after", {
        tool: "glob",
        status: "completed",
        result: { output: [{ path: ".env", type: "file" }], content: "TOKEN=live" },
      } as { tool: string; status: string; result?: { output?: unknown; content?: unknown; metadata?: unknown } });
      expect(after.result).toEqual({ content: expect.stringContaining("no project directory") });
    }
  });

  test("resolves relative paths against the plugin's directory, not the process's", async () => {
    const inRepo = await started(portable, repo);
    const elsewhere = await started(portable, fixture);

    await expect(inRepo.emit("tool.execute.before", before("read", { path: "private.txt" }))).rejects.toThrow("blocked");
    await expect(elsewhere.emit("tool.execute.before", before("read", { path: "private.txt" }))).resolves.toBeDefined();
  });

  test("says that cleanup_temp is unavailable when a cleanup root is configured", async () => {
    const stderr = await captureStderr(() => started({ ...portable, cleanupRoot: path.join(fixture, "scratch") }));
    expect(stderr).toMatch(/cleanup_temp is not available on OpenCode V2/);
    expect(stderr).toContain("issues/16");

    expect(await captureStderr(() => started({ ...portable, cleanupRoot: null }))).not.toMatch(/cleanup_temp/);
  });
});

describe.skipIf(!darwin)("shell check", () => {
  const create = (shell: unknown) => ({ command: "echo hi", cwd: repo, timeout: 0, shell, env: {} });

  test("rejects a shell that is not this package's wrapper", async () => {
    const { emit } = await started();
    await expect(emit("shell.create.before", create("/bin/zsh"))).rejects.toThrow("must be");
  });

  test("rejects an unset shell rather than running unguarded", async () => {
    const { emit } = await started();
    await expect(emit("shell.create.before", create(undefined))).rejects.toThrow("unset");
  });

  test("rejects the right path when the wrapper file is missing, because V2 would run its platform shell", async () => {
    const fake = host();
    await setupV2(fake.ctx, config, path.join(fixture, "absent", "lib"));

    await expect(
      fake.emit("shell.create.before", create(path.join(fixture, "absent", "bin", "opencode-secret-guard"))),
    ).rejects.toThrow(/does not exist/);
  });

  test("accepts this package's own wrapper", async () => {
    const { emit } = await started();
    await expect(
      emit("shell.create.before", create(path.join(fixture, "package", "bin", "opencode-secret-guard"))),
    ).resolves.toBeDefined();
  });
});

describe("execute.before", () => {
  test("refuses reads and writes of secrets, resolved against the plugin's directory", async () => {
    const { emit } = await started();
    expect(process.cwd()).not.toBe(repo);

    await expect(emit("tool.execute.before", before("read", { path: ".env" }))).rejects.toThrow("blocked");
    await expect(emit("tool.execute.before", before("write", { path: "id_rsa", content: "" }))).rejects.toThrow("blocked");
    await expect(emit("tool.execute.before", before("edit", { path: "src/../.env" }))).rejects.toThrow("blocked");
    await expect(emit("tool.execute.before", before("read", { path: "README.md" }))).resolves.toBeDefined();
  });

  test("refuses a patch that names a secret", async () => {
    const { emit } = await started();
    const patchText = ["*** Begin Patch", "*** Update File: .env", "@@", "-x", "+y", "*** End Patch"].join("\n");

    await expect(emit("tool.execute.before", before("patch", { patchText }))).rejects.toThrow("write access to .env");
  });

  test("refuses a misspelled name that V2's read would resolve to an ignored file", async () => {
    const { emit } = await started();
    fs.writeFileSync(path.join(repo, "private note.txt"), "x\n");
    fs.appendFileSync(path.join(repo, ".gitignore"), "private note.txt\n");
    try {
      await expect(emit("tool.execute.before", before("read", { path: "private\u00a0note.txt" }))).rejects.toThrow("blocked");
    } finally {
      fs.rmSync(path.join(repo, "private note.txt"));
      fs.writeFileSync(path.join(repo, ".gitignore"), "private.txt\n");
    }
  });

  test("refuses a credential-printing command on the shell tool", async () => {
    const { emit } = await started();

    await expect(emit("tool.execute.before", before("shell", { command: "aws eks get-token" }))).rejects.toThrow(/refusing/);
    await expect(emit("tool.execute.before", before("shell", { command: "git status" }))).resolves.toBeDefined();
  });

  test("refuses a file tool call it cannot read rather than letting it through", async () => {
    const { emit } = await started();

    await expect(emit("tool.execute.before", before("read", undefined))).rejects.toThrow(/cannot read/);
    await expect(emit("tool.execute.before", before("read", { path: 3 }))).rejects.toThrow(/named no path/);
    await expect(emit("tool.execute.before", before("read", { location: ".env" }))).rejects.toThrow(/named no path/);
    await expect(emit("tool.execute.before", before("webfetch", undefined))).resolves.toBeDefined();
  });
});

describe("execute.after", () => {
  const glob = (entries: Array<{ path: string; type: string }>, metadata: Record<string, unknown> = { count: entries.length, truncated: false }) =>
    completed("glob", { output: entries, content: "ignored", metadata });

  const grep = (
    matches: Array<{ entry: { path: string; type: string }; line: number; text: string }>,
    metadata: Record<string, unknown> = { matches: matches.length, truncated: false },
  ) => completed("grep", { output: matches, content: "ignored", metadata });

  const entry = (file: string) => ({ path: file, type: "file" });

  test("drops denied files from a glob, in the structured output and the text alike", async () => {
    const { emit } = await started();
    const event = await emit("tool.execute.after", glob([entry(".env"), entry("README.md"), entry("id_rsa")]));

    expect(event.result).toEqual({
      output: [entry("README.md")],
      content: path.join(repo, "README.md"),
      metadata: { count: 1, truncated: false },
    });
  });

  test("drops a file that only the gitignore or a symlink makes secret", async () => {
    const { emit } = await started();
    const globbed = await emit(
      "tool.execute.after",
      glob([entry("private.txt"), entry("link-to-env"), entry("README.md")]),
    );
    const grepped = await emit(
      "tool.execute.after",
      grep([
        { entry: entry("private.txt"), line: 1, text: "ignored" },
        { entry: entry("link-to-env"), line: 1, text: "linked" },
        { entry: entry("README.md"), line: 1, text: "public" },
      ]),
    );

    expect(globbed.result?.output).toEqual([entry("README.md")]);
    expect(globbed.result?.content).toBe(path.join(repo, "README.md"));
    expect(JSON.stringify(grepped.result)).not.toMatch(/ignored|linked/);
    expect(grepped.result?.metadata).toEqual({ matches: 1, truncated: false });
  });

  test("says so when a glob has nothing left", async () => {
    const { emit } = await started();
    const event = await emit("tool.execute.after", glob([entry(".env")]));

    expect(event.result?.output).toEqual([]);
    expect(event.result?.content).toBe("No files found");
  });

  test("drops every match in a denied file from a grep, including the first group", async () => {
    const { emit } = await started();
    const event = await emit(
      "tool.execute.after",
      grep([
        { entry: entry(".env"), line: 1, text: "TOKEN=live" },
        { entry: entry(".env"), line: 2, text: "OTHER=live" },
        { entry: entry("README.md"), line: 4, text: "TOKEN is documented" },
        { entry: entry("src/index.ts"), line: 1, text: "const TOKEN" },
      ]),
    );
    const readme = path.join(repo, "README.md");
    const index = path.join(repo, "src/index.ts");

    expect(event.result?.content).toBe(
      [`Found 2 matches`, `${readme}:`, "  Line 4: TOKEN is documented", "", `${index}:`, "  Line 1: const TOKEN"].join("\n"),
    );
    expect(JSON.stringify(event.result)).not.toContain("live");
    expect(event.result?.metadata).toEqual({ matches: 2, truncated: false });
  });

  test("keeps the truncation note, counting what remains", async () => {
    const { emit } = await started();
    const event = await emit("tool.execute.after", glob([entry(".env"), entry("README.md")], { count: 2, truncated: true }));

    expect(event.result?.content).toBe(
      [
        path.join(repo, "README.md"),
        "",
        "(Results are truncated: showing first 1 results. Consider using a more specific path or pattern.)",
      ].join("\n"),
    );
    expect(event.result?.metadata).toEqual({ count: 1, truncated: true });
  });

  test("keeps the truncation note on a grep, counting what remains", async () => {
    const { emit } = await started();
    const event = await emit(
      "tool.execute.after",
      grep(
        [
          { entry: entry(".env"), line: 1, text: "TOKEN=live" },
          { entry: entry("README.md"), line: 2, text: "public" },
        ],
        { matches: 2, truncated: true },
      ),
    );

    expect(event.result?.content).toBe(
      [
        "Found 1 matches",
        `${path.join(repo, "README.md")}:`,
        "  Line 2: public",
        "",
        "(Results are truncated: showing first 1 results. Consider using a more specific path or pattern.)",
      ].join("\n"),
    );
  });

  test("a directory name with a blank line cannot hide a secret from the filter", async () => {
    // Parsing the text would split this path in two and classify neither half.
    const { emit } = await started();
    const event = await emit(
      "tool.execute.after",
      grep([
        { entry: entry("odd\n\n/.env"), line: 1, text: "TOKEN=live" },
        { entry: entry("README.md"), line: 1, text: "ok" },
      ]),
    );

    expect(JSON.stringify(event.result)).not.toContain("TOKEN=live");
    expect(event.result?.metadata).toEqual({ matches: 1, truncated: false });
  });

  test.each([
    ["glob", { output: "text", content: "TOKEN=live" }],
    ["glob", { output: [{ type: "file" }], content: "TOKEN=live" }],
    ["glob", { content: "TOKEN=live" }],
    ["grep", { output: [{ entry: ".env", line: 1, text: "TOKEN=live" }], content: "TOKEN=live" }],
    ["grep", { output: [{ entry: entry(".env"), line: "1", text: "TOKEN=live" }], content: "TOKEN=live" }],
    ["grep", { output: null, content: "TOKEN=live" }],
  ])("withholds a %s result it does not recognise, %j", async (tool, result) => {
    const { emit } = await started();
    const event = await emit("tool.execute.after", completed(tool, result));

    expect(event.result).toEqual({ content: expect.stringContaining("withheld") });
    expect(JSON.stringify(event.result)).not.toContain("TOKEN=live");
  });

  test("withholds rather than throws when the result is unusable", async () => {
    // execute.after has no failure channel: a throw would be a defect that ends the step.
    const { emit } = await started();
    const event = await emit("tool.execute.after", { tool: "glob", status: "completed", result: undefined });

    expect(event.result).toEqual({ content: expect.stringContaining("withheld") });
  });

  test("filters a result whatever its status says, so a renamed status cannot switch the filter off", async () => {
    const { emit } = await started();

    for (const status of ["success", "ok", "done", "", "error"]) {
      const event = await emit("tool.execute.after", { ...glob([entry(".env"), entry("README.md")]), status });
      expect(event.result?.output).toEqual([entry("README.md")]);
    }
  });

  test("leaves a failed call with no result alone", async () => {
    const { emit } = await started();
    const event = await emit("tool.execute.after", { tool: "grep", status: "error" });

    expect(event.result).toBeUndefined();
  });

  test("says why when it cannot check a result, and still withholds it", async () => {
    const { emit } = await started();
    const result = {
      get output(): unknown {
        throw new Error("boom");
      },
    };
    let event!: ReturnType<typeof glob>;
    const stderr = await captureStderr(async () => {
      event = await emit("tool.execute.after", { tool: "glob", status: "completed", result } as unknown as typeof event);
    });

    expect(event.result).toEqual({ content: expect.stringContaining("could not be checked") });
    expect(stderr).toBe("secret-guard: could not check glob results: boom\n");
  });

  test("leaves other tools' results untouched", async () => {
    const { emit } = await started();
    const untouched = { output: [entry(".env")], content: "kept" };

    for (const event of [completed("read", untouched), completed("shell", untouched)]) {
      const after = await emit("tool.execute.after", event);
      expect(after.result).toBe(untouched);
    }
  });
});
