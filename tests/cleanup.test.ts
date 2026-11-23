import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupCommand, createCleanupTool, prepareCleanup } from "../src/cleanup.ts";
import type { CleanupPlan } from "../src/cleanup.ts";
import { loadConfig, validateConfig } from "../src/policy.ts";
import type { GuardConfig } from "../src/policy.ts";
import { sandboxExec } from "../src/sandbox-exec.ts";
import { fakeBackend, stubHostSandbox } from "./support.ts";

const base = loadConfig(process.env.OPENCODE_SECRET_GUARD_CONFIG);
const host = stubHostSandbox();
/** The SBPL profile the macOS backend would confine a cleanup with. */
const cleanupProfile = (config: GuardConfig, plan: CleanupPlan) => cleanupCommand(config, plan, sandboxExec)[2]!;
let fixture: string;
let root: string;
beforeEach(() => {
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-unit-")));
  root = path.join(fixture, "scratch");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "job"));
  fs.writeFileSync(path.join(root, "job", "output"), "temporary");
});
afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

describe("cleanup policy", () => {
  test("opt-in defaults to null", () => {
    expect(validateConfig({ ...base, cleanupRoot: undefined }, "test", fixture).cleanupRoot).toBeNull();
  });
  test("legacy policies remain usable without cleanup", () => {
    expect(validateConfig({ ...base, configVersion: 1, cleanupRoot: null, permissionReview: undefined }, "test", fixture).cleanupRoot).toBeNull();
    expect(() => validateConfig({ ...base, configVersion: 1, cleanupRoot: root, permissionReview: undefined }, "test", fixture))
      .toThrow("requires configVersion 2");
  });
  test.each([42, "", "relative", "/", "/tmp/..", "$TMPDIRX/scratch", "$HOME/scratch"])("rejects invalid root %j", (cleanupRoot) => {
    expect(() => validateConfig({ ...base, cleanupRoot }, "test", fixture)).toThrow("cleanupRoot");
  });
  test("refuses files-only cleanup", () => {
    expect(() => validateConfig({ ...base, cleanupRoot: root, mode: "files-only" }, "test", fixture))
      .toThrow("shell+files");
  });
  test("expands the configured home without reading files", () => {
    expect(validateConfig({ ...base, cleanupRoot: "~/scratch" }, "test", fixture).cleanupRoot).toBe(root);
  });
  test("expands a leading $TMPDIR, including macOS's trailing slash", () => {
    expect(validateConfig({ ...base, cleanupRoot: "$TMPDIR/scratch" }, "test", "/home", `${fixture}/`).cleanupRoot)
      .toBe(root);
    expect(validateConfig({ ...base, cleanupRoot: "$TMPDIR" }, "test", "/home", `${fixture}/`).cleanupRoot)
      .toBe(fixture);
  });
  test("defaults $TMPDIR to the process temporary directory", () => {
    expect(validateConfig({ ...base, cleanupRoot: "$TMPDIR/opencode" }, "test", fixture).cleanupRoot)
      .toBe(path.join(os.tmpdir(), "opencode"));
  });
});

describe("cleanup targets", () => {
  test("accepts files, task directories and missing descendants", () => {
    const plan = prepareCleanup(root, ["job/output", "absent/nested", "job"]);
    expect(plan.targets).toEqual([path.join(root, "job/output"), path.join(root, "absent/nested"), path.join(root, "job")]);
  });
  test.each(["", ".", "..", "job/..", "../scratch-backup", "/tmp/file", "job//output", "job/", "job\\output", "job/\0"])
    ("rejects ambiguous or escaping target %j", (target) => {
      expect(() => prepareCleanup(root, [target])).toThrow();
      expect(fs.existsSync(path.join(root, "job/output"))).toBe(true);
    });
  test("rejects a mixed call before deleting the valid target", () => {
    expect(() => prepareCleanup(root, ["job/output", "../outside"])).toThrow();
    expect(fs.readFileSync(path.join(root, "job/output"), "utf8")).toBe("temporary");
  });
  test("rejects operand symlinks and symlinked ancestors", () => {
    fs.symlinkSync(fixture, path.join(root, "link"));
    expect(() => prepareCleanup(root, ["link"])).toThrow("symlink");
    expect(() => prepareCleanup(root, ["link/missing"])).toThrow("symlink");
  });
  test("rejects a symlink root", () => {
    const link = path.join(fixture, "alias");
    fs.symlinkSync(root, link);
    expect(() => prepareCleanup(link, ["job"])).toThrow("symlink");
  });
  test("rejects nonexistent and non-directory roots", () => {
    expect(() => prepareCleanup(path.join(fixture, "missing"), ["job"])).toThrow();
    expect(() => prepareCleanup(path.join(root, "job/output"), ["job"])).toThrow("directory");
  });
  test("keeps whitespace and shell metacharacters literal", () => {
    const name = "job/a b;$(echo nope)";
    expect(prepareCleanup(root, [name]).targets).toEqual([path.join(root, name)]);
  });
});

describe("cleanup tool and profile", () => {
  test("rejects malformed arguments inside execute", async () => {
    const tool = createCleanupTool({ ...base, cleanupRoot: root }, () => true);
    const context = { abort: new AbortController().signal, ask: async () => { throw new Error("must not ask"); } };
    for (const input of [{ paths: [] }, { paths: ["job"], command: "anything" }, { paths: [3] }]) {
      await expect(tool.execute(input, context)).rejects.toThrow();
    }
  });
  test("refuses execution before shell configuration is validated", async () => {
    const tool = createCleanupTool({ ...base, cleanupRoot: root }, () => false);
    await expect(tool.execute({ paths: ["job"] }, {
      abort: new AbortController().signal,
      ask: async () => { throw new Error("must not ask"); },
    })).rejects.toThrow("has not been validated");
  });
  test("asks for approval only after the backend has confined the planned entries", async () => {
    const backend = fakeBackend();
    const tool = createCleanupTool({ ...base, cleanupRoot: root }, () => true);
    const asked = host.during({ backend }, () => tool.execute({ paths: ["job"] }, {
      abort: new AbortController().signal,
      ask: async () => { throw new Error("denied"); },
    }));
    await expect(asked).rejects.toThrow("denied");
    expect(backend.deletionConfinements).toHaveLength(1);
    expect(backend.deletionConfinements[0]!.root).toBe(root);
    expect(backend.deletionConfinements[0]!.entries).toEqual([path.join(root, "job"), path.join(root, "job/output")]);
    expect(fs.existsSync(path.join(root, "job/output"))).toBe(true);
  });
  test("only adds denies after the original secret and cache rules", () => {
    const profile = cleanupProfile({ ...base, cleanupRoot: root }, prepareCleanup(root, ["job"]));
    const tail = profile.slice(profile.indexOf(";; Cleanup only"));
    expect(profile).toContain("(deny file-read-data file-write*");
    expect(profile).toContain("generated guard profiles are never writable");
    expect(tail).not.toContain("(allow ");
    expect(tail).toContain(`(literal "${path.join(root, "job")}")`);
    expect(tail).toContain(`(literal "${path.join(root, "job/output")}")`);
    expect(tail).toContain(`(literal "${root}")`);
    expect(tail).toContain("(deny file-write-data file-write-create)");
    expect(profile).not.toContain(";; 5. relaxation");
  });
  test("permissions cover descendants and the profile grants no subtree wildcard", () => {
    const plan = prepareCleanup(root, ["job"]);
    expect(plan.permissionPaths).toContain(path.join(root, "job/output"));
    const tail = cleanupProfile({ ...base, cleanupRoot: root }, plan).split(";; Cleanup only")[1];
    expect(tail).not.toContain("(subpath ");
  });
});
