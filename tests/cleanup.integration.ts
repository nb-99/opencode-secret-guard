import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { cleanupProfile, prepareCleanup } from "../src/cleanup.ts";
import { loadConfig } from "../src/policy.ts";

const base = loadConfig(process.env.OPENCODE_SECRET_GUARD_CONFIG);
const shell = process.env.SECRET_GUARD_SHELL;
if (!shell) throw new Error("Use nix run .#integration to exercise the installed cleanup tool");
const moduleDirectory = path.join(path.dirname(path.dirname(shell)), "lib");
const { createHooks } = await import(path.join(moduleDirectory, "hooks.ts"));
let fixture: string;
let root: string;

beforeAll(() => {
  const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]);
  if (probe.status !== 0) throw new Error("Cleanup integration requires an unsandboxed macOS terminal");
});
beforeEach(() => {
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-kernel-")));
  root = path.join(fixture, "scratch");
  fs.mkdirSync(path.join(root, "job"), { recursive: true });
  fs.writeFileSync(path.join(root, "job/output"), "temporary");
  fs.writeFileSync(path.join(fixture, "sentinel"), "keep");
});
afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

async function tool(cleanupRoot = root) {
  const hooks = createHooks({ ...base, cleanupRoot }, moduleDirectory);
  await hooks.config({ shell });
  return hooks.tool.cleanup_temp;
}
const context = (ask = async (_input: any) => {}) => ({ abort: new AbortController().signal, ask });
const sandbox = (profile: string, binary: string, args: string[]) =>
  spawnSync("/usr/bin/sandbox-exec", ["-p", profile, binary, ...args], { encoding: "utf8" });

test("installed tool deletes only requested targets and can repeat cleanup", async () => {
  const cleanup = await tool();
  await cleanup.execute({ paths: ["job"] }, context());
  await cleanup.execute({ paths: ["job"] }, context());
  expect(fs.existsSync(path.join(root, "job"))).toBe(false);
  expect(fs.readFileSync(path.join(fixture, "sentinel"), "utf8")).toBe("keep");
  expect(fs.existsSync(root)).toBe(true);
});

test("native edit denial prevents the deletion worker", async () => {
  let requested = false;
  await expect((await tool()).execute({ paths: ["job"] }, context(async (input) => {
    requested = true;
    expect(input.permission).toBe("edit");
    expect(input.always).toEqual([]);
    throw new Error("edit denied");
  }))).rejects.toThrow("edit denied");
  expect(requested).toBe(true);
  expect(fs.existsSync(path.join(root, "job/output"))).toBe(true);
});

test("invalid additional operands reject the complete call", async () => {
  await expect((await tool()).execute({ paths: ["job", "../sentinel"] }, context())).rejects.toThrow();
  expect(fs.existsSync(path.join(root, "job/output"))).toBe(true);
  expect(fs.existsSync(path.join(fixture, "sentinel"))).toBe(true);
});

test("permission requests retain the /tmp alias while kernel paths are canonical", async () => {
  const alias = root.replace(/^\/private\/tmp\//, "/tmp/").replace(/^\/private\/var\//, "/var/");
  await (await tool(alias)).execute({ paths: ["job"] }, context(async (input) => {
    expect(input.patterns).toEqual([path.join(alias, "job"), path.join(alias, "job/output")]);
    expect(input.metadata.filepath).toBe(alias);
    expect(input.metadata.diff).toContain(`-DELETE ${path.join(alias, "job/output")}`);
  }));
  expect(fs.existsSync(path.join(root, "job"))).toBe(false);
});

test("a descendant-specific native edit denial rejects recursive cleanup", async () => {
  const protectedFile = path.join(root, "job/output");
  await expect((await tool()).execute({ paths: ["job"] }, context(async (input) => {
    if (input.patterns.includes(protectedFile)) throw new Error("descendant edit denied");
  }))).rejects.toThrow("descendant edit denied");
  expect(fs.readFileSync(protectedFile, "utf8")).toBe("temporary");
});

test("kernel preserves entries that appear after the approved inventory", () => {
  const profile = cleanupProfile({ ...base, cleanupRoot: root }, prepareCleanup(root, ["job"]));
  fs.writeFileSync(path.join(root, "job/late"), "unapproved");
  const result = sandbox(profile, "/bin/rm", ["-rf", "--", path.join(root, "job")]);
  expect(result.status).not.toBe(0);
  expect(fs.readFileSync(path.join(root, "job/late"), "utf8")).toBe("unapproved");
});

test("a changed inventory during approval is rejected before deletion", async () => {
  await expect((await tool()).execute({ paths: ["job"] }, context(async () => {
    fs.writeFileSync(path.join(root, "job/late"), "unapproved");
  }))).rejects.toThrow("changed during approval");
  expect(fs.readFileSync(path.join(root, "job/output"), "utf8")).toBe("temporary");
});

test("descendant symlinks are unlinked without following their targets", async () => {
  fs.symlinkSync(fixture, path.join(root, "job/link"));
  await (await tool()).execute({ paths: ["job"] }, context());
  expect(fs.readFileSync(path.join(fixture, "sentinel"), "utf8")).toBe("keep");
});

test("secret denies survive cleanup confinement and report partial failure", async () => {
  fs.writeFileSync(path.join(root, "job/.env"), "keep secret");
  await expect((await tool()).execute({ paths: ["job"] }, context())).rejects.toThrow("may be partial");
  expect(fs.readFileSync(path.join(root, "job/.env"), "utf8")).toBe("keep secret");
});

test("cancellation during approval does not launch deletion", async () => {
  const controller = new AbortController();
  await expect((await tool()).execute({ paths: ["job"] }, {
    abort: controller.signal, ask: async () => controller.abort(),
  })).rejects.toThrow();
  expect(fs.existsSync(path.join(root, "job/output"))).toBe(true);
});

test("root replacement during approval is rejected", async () => {
  await expect((await tool()).execute({ paths: ["job"] }, context(async () => {
    fs.renameSync(root, path.join(fixture, "moved"));
    fs.symlinkSync(path.join(fixture, "moved"), root);
  }))).rejects.toThrow("symlink");
  expect(fs.existsSync(path.join(fixture, "moved/job/output"))).toBe(true);
});

test("kernel stops mixed operands and sibling-prefix deletion even with a broad base exemption", () => {
  const profile = cleanupProfile({ ...base, cleanupRoot: root, exemptRoots: [fixture] }, prepareCleanup(root, ["job"]));
  const sibling = root + "-backup";
  fs.writeFileSync(sibling, "keep sibling");
  const result = sandbox(profile, "/bin/rm", ["-rf", "--", path.join(root, "job"), path.join(fixture, "sentinel"), sibling, root]);
  expect(result.status).not.toBe(0);
  expect(fs.readFileSync(sibling, "utf8")).toBe("keep sibling");
  expect(fs.readFileSync(path.join(fixture, "sentinel"), "utf8")).toBe("keep");
  expect(fs.existsSync(root)).toBe(true);
});

test("kernel stops an ancestor symlink swapped after target validation", () => {
  const profile = cleanupProfile({ ...base, cleanupRoot: root }, prepareCleanup(root, ["job"]));
  fs.renameSync(path.join(root, "job"), path.join(fixture, "moved"));
  fs.symlinkSync(path.join(fixture, "moved"), path.join(root, "job"));
  const result = sandbox(profile, "/bin/rm", ["-f", "--", path.join(root, "job/output")]);
  expect(result.status).not.toBe(0);
  expect(fs.readFileSync(path.join(fixture, "moved/output"), "utf8")).toBe("temporary");
});

test("cleanup profile cannot truncate or create files", () => {
  const profile = cleanupProfile({ ...base, cleanupRoot: root }, prepareCleanup(root, ["job"]));
  const result = sandbox(profile, "/bin/sh", ["-c", 'printf changed > "$1"; printf changed > "$2"',
    "test", path.join(root, "job/output"), path.join(root, "job/new")]);
  expect(result.status).not.toBe(0);
  expect(fs.readFileSync(path.join(root, "job/output"), "utf8")).toBe("temporary");
  expect(fs.existsSync(path.join(root, "job/new"))).toBe(false);
});
