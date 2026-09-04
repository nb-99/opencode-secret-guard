import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupProfile, createCleanupTool, prepareCleanup } from "../src/cleanup.ts";
import { loadConfig, validateConfig } from "../src/policy.ts";

const base = loadConfig(process.env.OPENCODE_SECRET_GUARD_CONFIG);
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
    expect(validateConfig({ ...base, configVersion: 1, cleanupRoot: null }, "test", fixture).cleanupRoot).toBeNull();
    expect(() => validateConfig({ ...base, configVersion: 1, cleanupRoot: root }, "test", fixture))
      .toThrow("requires configVersion 2");
  });
  test.each([42, "", "relative", "/", "/tmp/.."])("rejects invalid root %j", (cleanupRoot) => {
    expect(() => validateConfig({ ...base, cleanupRoot }, "test", fixture)).toThrow("cleanupRoot");
  });
  test("refuses files-only cleanup", () => {
    expect(() => validateConfig({ ...base, cleanupRoot: root, mode: "files-only" }, "test", fixture))
      .toThrow("shell+files");
  });
  test("expands the configured home without reading files", () => {
    expect(validateConfig({ ...base, cleanupRoot: "~/scratch" }, "test", fixture).cleanupRoot).toBe(root);
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
