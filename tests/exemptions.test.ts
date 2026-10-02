import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exemptRootContaining, pinExemptRoots, validExemptRoots } from "../src/exemptions.ts";
import { checkToolCall } from "../src/guard.ts";
import * as pathLookup from "../src/lookup.ts";
import { loadConfig, type GuardConfig } from "../src/policy.ts";
import { classifyPath } from "../src/predicate.ts";

// Only the shipped, controlled template is read. All home paths and synthetic
// credential bodies below belong to this test's temporary fixture.
const template = JSON.parse(fs.readFileSync(new URL("../policy/default.json", import.meta.url), "utf8"));
let fixture: string;
let home: string;
let policy: string;

beforeEach(() => {
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-exempt-")));
  home = path.join(fixture, "home");
  policy = path.join(fixture, "policy.json");
  put(path.join(home, ".ssh/id_rsa"));
});

afterEach(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

function put(target: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "synthetic fixture, not a credential\n");
  return target;
}

function loaded(exemptRoots: string[], overrides: Partial<GuardConfig> = {}): GuardConfig {
  fs.writeFileSync(policy, JSON.stringify({
    ...template,
    denyRoots: [path.join(fixture, "vault")],
    exemptRoots,
    ...overrides,
  }));
  return loadConfig(policy, home);
}

function denied(target: string, config: GuardConfig): void {
  expect(classifyPath(target, config)).toBe("deny");
  expect(() => checkToolCall("read", { path: target }, config, fixture)).toThrow("blocked");
}

describe("pinned root exemptions", () => {
  test("retargeting a loaded root before its first call cannot grant credential access", () => {
    const root = path.join(fixture, "vault/memory");
    put(path.join(root, "id_rsa"));
    const config = loaded([root]);

    fs.renameSync(root, root + "-original");
    fs.symlinkSync(home, root);
    expect(validExemptRoots(config)).toEqual([]);
    denied(path.join(root, ".ssh/id_rsa"), config);
    denied(path.join(home, ".ssh/id_rsa"), config);
    // Even an explicit repeat of the pin API cannot overwrite the load snapshot.
    expect(pinExemptRoots(config)).toEqual([root]);
    expect(validExemptRoots(config)).toEqual([]);
  });

  test("retargeting a symlink ancestor removes rather than moves the grant", () => {
    const original = path.join(fixture, "original");
    put(path.join(original, "memory/id_rsa"));
    const mount = path.join(fixture, "mount");
    fs.symlinkSync(original, mount);
    const root = path.join(mount, "memory");
    const config = loaded([root]);
    expect(validExemptRoots(config)).toEqual([path.join(original, "memory")]);

    put(path.join(home, "memory/.ssh/id_rsa"));
    fs.unlinkSync(mount);
    fs.symlinkSync(home, mount);
    expect(validExemptRoots(config)).toEqual([]);
    denied(path.join(root, ".ssh/id_rsa"), config);
    denied(path.join(home, "memory/.ssh/id_rsa"), config);
  });

  test("a fresh directory at the same canonical name has no grant until reload", () => {
    const root = path.join(fixture, "vault/memory");
    const target = put(path.join(root, "id_rsa"));
    const config = loaded([root]);
    expect(classifyPath(target, config)).toBe("allow");
    fs.renameSync(root, root + "-original");
    put(target);
    expect(validExemptRoots(config)).toEqual([]);
    denied(target, config);
    expect(classifyPath(target, loadConfig(policy, home))).toBe("allow");
  });

  test("creating a missing root before the first call does not acquire a grant", () => {
    const root = path.join(fixture, "vault/memory");
    const config = loaded([root]);
    // Deliberately no classifier call until after creation. The loader
    // must have pinned absence, rather than lazily trusting the later directory.
    const target = put(path.join(root, "id_rsa"));
    expect(pinExemptRoots(config)).toEqual([root]);
    expect(validExemptRoots(config)).toEqual([]);
    denied(target, config);

    const reloaded = loadConfig(policy, home);
    expect(validExemptRoots(reloaded)).toEqual([root]);
    expect(classifyPath(target, reloaded)).toBe("allow");
  });

  test("a validated initial symlink grants only its pinned shared directory", () => {
    const shared = path.join(fixture, "shared");
    const target = put(path.join(shared, "id_rsa"));
    const root = path.join(fixture, "memory-link");
    fs.symlinkSync(shared, root);
    const config = loaded([root]);
    expect(validExemptRoots(config)).toEqual([shared]);
    expect(classifyPath(target, config)).toBe("allow");
    expect(classifyPath(path.join(root, "id_rsa"), config)).toBe("allow");
    denied(path.join(home, ".ssh/id_rsa"), config);
    fs.symlinkSync(path.join(home, ".ssh/id_rsa"), path.join(shared, "body-link"));
    denied(path.join(shared, "body-link"), config);

    fs.renameSync(root, root + "-original");
    fs.symlinkSync(home, root);
    expect(validExemptRoots(config)).toEqual([]);
    denied(path.join(root, ".ssh/id_rsa"), config);
    denied(target, config);
  });

  test.each(["", "/"])("an equivalent replacement symlink loses its identity with suffix %j", (suffix) => {
    const shared = path.join(fixture, "shared");
    put(path.join(shared, "id_rsa"));
    const root = path.join(fixture, "memory-link");
    fs.symlinkSync(shared, root);
    const config = loaded([root + suffix]);
    fs.renameSync(root, root + "-original");
    fs.symlinkSync(shared, root);
    expect(pinExemptRoots(config)).toEqual([shared]);
    expect(validExemptRoots(config)).toEqual([]);
    denied(path.join(root, "id_rsa"), config);
  });

  test("existing benign symlink parents remain usable without granting their siblings", () => {
    const realTemporary = path.join(fixture, "private/var/tmp");
    put(path.join(realTemporary, "memory/id_rsa"));
    const alias = path.join(fixture, "tmp");
    fs.symlinkSync(realTemporary, alias);
    const config = loaded([path.join(alias, "memory")]);
    expect(validExemptRoots(config)).toEqual([path.join(realTemporary, "memory")]);
    expect(classifyPath(path.join(alias, "memory/id_rsa"), config)).toBe("allow");
    denied(put(path.join(realTemporary, "sibling/id_rsa")), config);
  });

  test("trusted directly constructed configs pin once and never follow root-list mutations", () => {
    const root = path.join(fixture, "vault/memory");
    put(path.join(root, "id_rsa"));
    const config = { ...loaded([]), exemptRoots: [root] };
    expect(validExemptRoots(config)).toEqual([root]);
    config.exemptRoots.push(home);
    expect(pinExemptRoots(config)).toEqual([root]);
    expect(validExemptRoots(config)).toEqual([root]);
    denied(path.join(home, ".ssh/id_rsa"), config);
  });

  test("runtime identity verification performs no canonicalization helper lookups", () => {
    const root = path.join(fixture, "vault/memory");
    put(path.join(root, "id_rsa"));
    const config = loaded([root]);
    const lookup = spyOn(pathLookup, "readDirectoryModes");
    try {
      expect(validExemptRoots(config)).toEqual([root]);
      fs.renameSync(root, root + "-original");
      fs.symlinkSync(home, root);
      expect(validExemptRoots(config)).toEqual([]);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  test("adding and removing ordinary files preserves the directory exemption", () => {
    const root = path.join(fixture, "vault/memory");
    const target = put(path.join(root, "id_rsa"));
    const config = loaded([root]);
    const added = put(path.join(root, "notes.txt"));
    expect(validExemptRoots(config)).toEqual([root]);
    expect(classifyPath(target, config)).toBe("allow");
    fs.unlinkSync(added);
    expect(validExemptRoots(config)).toEqual([root]);
    expect(classifyPath(target, config)).toBe("allow");
    expect(exemptRootContaining(config, path.join(root, "guarded/missing"))).toBe(root);
  });

  test("changing ctime-backed fallback birthtime does not revoke the same directory", () => {
    const root = path.join(fixture, "vault/memory");
    const target = put(path.join(root, "id_rsa"));
    const stat = fs.statSync;
    const lstat = fs.lstatSync;
    let fallback = 1n;
    const metadata = (original: typeof fs.statSync, entry: unknown, options: unknown[]) => {
      const stats = (original as any)(entry, ...options);
      if (entry === root) stats.birthtimeNs = stats.ctimeNs = fallback;
      return stats;
    };
    const statLookup = spyOn(fs, "statSync").mockImplementation(((entry: unknown, ...options: unknown[]) =>
      metadata(stat, entry, options)) as typeof fs.statSync);
    const lstatLookup = spyOn(fs, "lstatSync").mockImplementation(((entry: unknown, ...options: unknown[]) =>
      metadata(lstat, entry, options)) as typeof fs.lstatSync);
    try {
      const config = loaded([root]);
      const added = put(path.join(root, "notes.txt"));
      fallback = 2n;
      expect(validExemptRoots(config)).toEqual([root]);
      expect(classifyPath(target, config)).toBe("allow");
      fs.unlinkSync(added);
      fallback = 3n;
      expect(validExemptRoots(config)).toEqual([root]);
      expect(classifyPath(target, config)).toBe("allow");
      expect(exemptRootContaining(config, path.join(root, "guarded/missing"))).toBe(root);
    } finally {
      lstatLookup.mockRestore();
      statLookup.mockRestore();
    }
  });

  test.each([1, 2])("policy validation runs only %i exemption helper calls, not guarded-root calls", (count) => {
    const roots = Array.from({ length: count }, (_, index) => path.join(fixture, `vault/root-${index}`));
    roots.forEach((root) => fs.mkdirSync(root, { recursive: true }));
    const lookup = spyOn(pathLookup, "readDirectoryModes");
    try {
      loaded(roots);
      expect(lookup).toHaveBeenCalledTimes(roots.length);
    } finally {
      lookup.mockRestore();
    }
  });

  test("existing case-distinct directory names are not conflated by validation", () => {
    const exempt = path.join(fixture, "Shared");
    const guarded = path.join(fixture, "shared");
    fs.mkdirSync(exempt);
    fs.mkdirSync(guarded);
    const config = loaded([exempt], { denyRoots: [guarded] });
    expect(validExemptRoots(config)).toEqual([exempt]);
    expect(exemptRootContaining(config, guarded)).toBeUndefined();
    expect(exemptRootContaining(config, path.join(exempt, "missing/leaf"))).toBe(exempt);
  });

  test("existing mixed-case aliases compare directory identities, not spelling", () => {
    const exempt = path.join(fixture, "Shared");
    fs.mkdirSync(exempt);
    const alias = path.join(fixture, "sHARED");
    fs.symlinkSync(exempt, alias);
    expect(() => loaded([exempt], { denyRoots: [path.join(alias, "missing/leaf")] }))
      .toThrow("contains the guarded path");
  });

  test("a guarded symlink body inside an exemption is rejected", () => {
    const exempt = path.join(fixture, "shared");
    const guardedBody = put(path.join(exempt, "nested/credential"));
    const link = path.join(fixture, "guarded-link");
    fs.symlinkSync(guardedBody, link);
    expect(() => loaded([exempt], { denyRoots: [link] })).toThrow("contains the guarded path");
  });

  test("a guarded symlink namespace inside an exemption is rejected even when its body is outside", () => {
    const exempt = path.join(fixture, "shared");
    fs.mkdirSync(exempt);
    fs.symlinkSync(path.join(home, ".ssh/id_rsa"), path.join(exempt, "guarded-link"));
    expect(() => loaded([exempt], { denyRoots: [path.join(exempt, "guarded-link")] }))
      .toThrow("contains the guarded path");
  });

  test("missing guarded leaves below an existing exemption are rejected", () => {
    const exempt = path.join(fixture, "shared");
    fs.mkdirSync(exempt);
    expect(() => loaded([exempt], { denyRoots: [path.join(exempt, "missing/deep/credential")] }))
      .toThrow("contains the guarded path");
  });

  test("missing exemptions still reject future overlapping guarded paths conservatively", () => {
    const missing = path.join(fixture, "Future");
    expect(() => loaded([missing], { denyRoots: [path.join(fixture, "future/guarded")] }))
      .toThrow("contains the guarded path");
    expect(() => loaded([missing], { denyRoots: [path.join(missing, "guarded")] }))
      .toThrow("contains the guarded path");
    const config = loaded([missing], { denyRoots: [path.join(fixture, "Future-sibling/guarded")] });
    expect(validExemptRoots(config)).toEqual([]);
  });

  test("guarded-root metadata read errors fail closed during validation", () => {
    const exempt = path.join(fixture, "shared");
    fs.mkdirSync(exempt);
    const guarded = path.join(fixture, "unreadable/credential");
    const stat = fs.statSync;
    const lookup = spyOn(fs, "statSync").mockImplementation(((target: unknown, ...options: unknown[]) => {
      if (target === guarded) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
      return (stat as any)(target, ...options);
    }) as typeof fs.statSync);
    try {
      expect(() => loaded([exempt], { denyRoots: [guarded] })).toThrow("fixture denied");
    } finally {
      lookup.mockRestore();
    }
  });
});
