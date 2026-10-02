import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkToolCall } from "../src/guard.ts";
import { ignoreCache, repoRootCache } from "../src/gitignore.ts";
import { hasUnknownLookup, inspectPath, realpath } from "../src/paths.ts";
import * as pathLookup from "../src/lookup.ts";
import { fileURLToPath } from "node:url";
import { loadConfig, validateConfig } from "../src/policy.ts";
import { classifyPath, classifyPaths } from "../src/predicate.ts";
import { bothPaths, isTamperProtected, mayBeTamperProtected, protectedNodes, tamperTargets, writablePathDirectories } from "../src/tamper.ts";

const baseConfig = loadConfig(process.env.OPENCODE_SECRET_GUARD_CONFIG!);
let root: string;
const restore: Array<() => void> = [];
const native = {
  realpath: fs.realpathSync,
  readdir: fs.readdirSync,
  lstat: fs.lstatSync,
  stat: fs.statSync,
  exists: fs.existsSync,
  readDirectoryModes: pathLookup.readDirectoryModes,
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-case-")));
  // Filesystem semantics in these tests are explicit metadata, not inferred
  // from case probes or the host that happens to run the fixtures.
  const modes = spyOn(pathLookup, "readDirectoryModes").mockImplementation((target) => directoryModes(target, () => "sensitive"));
  restore.push(() => modes.mockRestore());
});

afterEach(() => {
  restore.splice(0).reverse().forEach((undo) => undo());
  ignoreCache.clear();
  repoRootCache.clear();
  fs.rmSync(root, { recursive: true, force: true });
});

function put(relative: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "synthetic fixture only\n");
  return target;
}

function directoryModes(target: string, mode: (directory: string) => pathLookup.LookupMode): pathLookup.LookupMode[] {
  let directory = path.parse(target).root;
  const result = [mode(directory)];
  for (const component of target.slice(directory.length).split(path.sep).filter(Boolean)) {
    directory = path.join(directory, component);
    result.push(mode(directory));
  }
  return result;
}

/** DrvFS semantics on Linux CI: lookup ignores case, realpath retains it. */
function insensitive(sensitiveDirectories: string[] = []) {
  const lookup = (value: unknown): any => {
    if (typeof value !== "string" || !value.startsWith(root + "/")) return value;
    let current = root;
    for (const component of value.slice(root.length + 1).split("/")) {
      let names: string[];
      try {
        names = native.readdir(current) as string[];
      } catch {
        return value;
      }
      const name = names.includes(component) ? component : sensitiveDirectories.includes(current) ? undefined :
        names.find((entry) => entry.toLowerCase() === component.toLowerCase());
      current = path.join(current, name ?? component);
    }
    return current;
  };
  const modes = spyOn(pathLookup, "readDirectoryModes").mockImplementation((target) => directoryModes(target, (directory) =>
    directory === root || directory.startsWith(root + "/")
      ? sensitiveDirectories.includes(lookup(directory)) ? "sensitive" : "insensitive"
      : "sensitive"));
  restore.push(() => modes.mockRestore());
  const install = (name: keyof typeof fs, implementation: (...args: any[]) => any) => {
    const spy = spyOn(fs, name as any).mockImplementation(implementation);
    restore.push(() => spy.mockRestore());
    return spy;
  };
  install("realpathSync", (value, ...args) => {
    const actual = lookup(value);
    const resolved = (native.realpath as any)(actual, ...args);
    return resolved === actual ? value : resolved;
  });
  install("lstatSync", (value, ...args) => (native.lstat as any)(lookup(value), ...args));
  install("statSync", (value, ...args) => (native.stat as any)(lookup(value), ...args));
  install("existsSync", (value) => native.exists(lookup(value)));
  return install("readdirSync", (value, ...args) => (native.readdir as any)(lookup(value), ...args));
}

describe("plain realpath", () => {
  test("resolves existing paths and missing suffixes without metadata reads or helper processes", () => {
    const target = put("Existing/File");
    fs.symlinkSync(path.dirname(target), path.join(root, "link"));
    const modes = spyOn(pathLookup, "readDirectoryModes");
    const run = spyOn(childProcess, "spawnSync");
    const scan = spyOn(fs, "readdirSync");
    restore.push(() => modes.mockRestore(), () => run.mockRestore(), () => scan.mockRestore());
    modes.mockClear();
    run.mockClear();
    scan.mockClear();
    expect(realpath(target)).toBe(target);
    expect(realpath(path.join(root, "link/File"))).toBe(target);
    expect(realpath(path.join(root, "link/New/Deep/File"))).toBe(path.join(root, "Existing/New/Deep/File"));
    expect(modes.mock.calls).toHaveLength(0);
    expect(run.mock.calls).toHaveLength(0);
    expect(scan.mock.calls).toHaveLength(0);
  });

  test("does not normalize a spelling-preserving filesystem alias", () => {
    put("Mixed/File");
    insensitive();
    const alias = path.join(root, "mIXED/fILE");
    expect(realpath(alias)).toBe(alias);
    expect(realpath(path.join(root, "mIXED/New/Leaf"))).toBe(path.join(root, "mIXED/New/Leaf"));
  });

  test("plain resolution falls back lexically on permission errors, but inspection refuses", () => {
    const target = put("File");
    const denied = spyOn(fs, "realpathSync").mockImplementation(() => {
      throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    });
    restore.push(() => denied.mockRestore());
    expect(realpath(target)).toBe(target);
    expect(() => inspectPath(target)).toThrow("fixture denied");
  });

  test("tamper roots, PATH entries and protected nodes need no metadata helper", () => {
    const bin = path.dirname(put("Bin/program"));
    const policy = put("Config/policy.json");
    const packageDirectory = path.dirname(put("Package/index.ts"));
    const modes = spyOn(pathLookup, "readDirectoryModes");
    const run = spyOn(childProcess, "spawnSync");
    restore.push(() => modes.mockRestore(), () => run.mockRestore());
    modes.mockClear();
    run.mockClear();
    expect(writablePathDirectories(bin, null)).toEqual([bin]);
    const targets = tamperTargets({ repoRoot: null, pathEnvironment: bin, home: root, policyPath: policy, packageDirectory });
    expect(isTamperProtected(policy, targets)).toBe(true);
    expect(isTamperProtected(path.join(bin, "new-program"), targets)).toBe(true);
    const nodes = protectedNodes({ ...baseConfig, denyRoots: [path.join(root, "Vault")] }, root);
    expect(nodes.literals).toContain(path.join(root, "Vault"));
    expect(modes.mock.calls).toHaveLength(0);
    expect(run.mock.calls).toHaveLength(0);
  });
});

describe("case-sensitive filesystem", () => {
  test("keeps real .env and .ENV entries and their policy verdicts distinct", () => {
    const lower = put(".env");
    const upper = put(".ENV");
    // The real-filesystem assertion applies where two distinct entries exist.
    if (fs.readdirSync(root).filter((name) => name === ".env" || name === ".ENV").length !== 2) return;
    expect(inspectPath(lower).canonical).toBe(lower);
    expect(inspectPath(upper).canonical).toBe(upper);
    expect(classifyPath(lower, baseConfig)).toBe("deny");
    expect(classifyPath(upper, baseConfig)).toBe("allow");
  });

  test("keeps case-distinct exact hardlinks distinct even with the same inode", () => {
    const lower = put(".env");
    const upper = path.join(root, ".Env");
    if (fs.existsSync(upper)) return;
    fs.linkSync(lower, upper);
    expect(inspectPath(lower).canonical).toBe(lower);
    expect(inspectPath(upper).canonical).toBe(upper);
  });

  test("does not enumerate an ordinary case-sensitive directory", () => {
    const target = put("Mixed/File.txt");
    const scan = spyOn(fs, "readdirSync");
    restore.push(() => scan.mockRestore());
    expect(inspectPath(target).canonical).toBe(target);
    expect(scan.mock.calls.some(([directory]) => directory === root || directory === path.join(root, "Mixed"))).toBe(false);
  });

  test("resolves a symlink and multiple missing descendants through its target", () => {
    fs.mkdirSync(path.join(root, "Existing"));
    fs.symlinkSync(path.join(root, "Existing"), path.join(root, "link"));
    expect(realpath(path.join(root, "link/new/deep/file"))).toBe(path.join(root, "Existing/new/deep/file"));
  });

  test("does not expand an exemption across distinct case-sensitive directory names", () => {
    const allowed = put("Vault/Memory/.env");
    const denied = put("Vault/MEMORY/.env");
    if (fs.readdirSync(path.join(root, "Vault")).length !== 2) return;
    const config = { ...baseConfig, denyRoots: [path.join(root, "Vault")], exemptRoots: [path.join(root, "Vault/Memory")] };
    expect(classifyPath(allowed, config)).toBe("allow");
    expect(classifyPath(denied, config)).toBe("deny");
  });
});

test("canonicalizing an alias does not stat unrelated inaccessible siblings", () => {
  const actual = put(".env");
  put("unrelated.txt");
  insensitive();
  let unrelatedChecked = false;
  const stat = spyOn(fs, "lstatSync").mockImplementation((value: any, ...args: any[]): any => {
    if (value === path.join(root, "unrelated.txt")) {
      unrelatedChecked = true;
      throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    }
    const resolved = value === path.join(root, ".ENV") ? actual : value;
    return (native.lstat as any)(resolved, ...args);
  });
  restore.push(() => stat.mockRestore());
  expect(inspectPath(path.join(root, ".ENV")).canonical).toBe(actual);
  expect(unrelatedChecked).toBe(false);
});

test("non-ASCII names cannot be treated as sensitive merely because the ASCII mask is empty", () => {
  const actual = put("ẞ");
  insensitive();
  const inspected = inspectPath(actual);
  expect(hasUnknownLookup(inspected)).toBe(true);
  expect(classifyPath(actual, { ...baseConfig, secretPatterns: ["/ß$"], secretExceptions: [] })).toBe("deny");
});

describe("filesystem evidence", () => {
  test.skipIf(process.platform !== "linux" || !fs.existsSync(fileURLToPath(new URL("../bin/path-lookup", import.meta.url))) || !fs.existsSync("/proc"))
    ("unrecognised filesystems never claim sensitive lookup metadata", () => {
      expect(native.readDirectoryModes("/proc").at(-1)).toBe("unknown");
    });
  test("preserves a proven-sensitive prefix before unknown lookup modes", () => {
    const target = put("Mixed/😀ÉName/.ENV");
    const evidence = inspectPath(target, (existing) => directoryModes(existing, (directory) =>
      directory === root || directory.startsWith(root + "/") ? "unknown" : "sensitive"));
    expect(evidence.canonical).toBe(target);
    expect(evidence.insensitive.length).toBe(target.length);
    expect(evidence.insensitive.slice(0, root.length)).toEqual(Array(root.length).fill(false));
    const suffix = target.slice(root.length);
    expect(evidence.insensitive.slice(root.length)).toEqual(suffix.split("").map((letter) => /^[a-z]$/i.test(letter)));
    expect(hasUnknownLookup(evidence)).toBe(true);
    expect(evidence.knownPrefixLength).toBe(root.length + 1);
  });

  test("applies each parent mode, including sensitive islands", () => {
    const target = put("Mixed/Sensitive/.ENV");
    insensitive([path.join(root, "Mixed/Sensitive")]);
    const evidence = inspectPath(path.join(root, "mIXED/sENSITIVE/.ENV"));
    expect(evidence.canonical).toBe(target);
    expect(evidence.insensitive.slice(root.length + 1, target.lastIndexOf("/")))
      .toEqual("Mixed/Sensitive".split("").map((letter) => /^[a-z]$/i.test(letter)));
    expect(evidence.insensitive.slice(target.lastIndexOf("/") + 1)).toEqual(Array(4).fill(false));
    expect(hasUnknownLookup(evidence)).toBe(false);
  });

  test("inherits the existing parent only for the first missing component", () => {
    fs.mkdirSync(path.join(root, "Existing"));
    const modes = (existing: string) => directoryModes(existing, () => "sensitive");
    const first = inspectPath(path.join(root, "Existing/New"), modes);
    expect(first.insensitive.every((flag) => !flag)).toBe(true);
    expect(hasUnknownLookup(first)).toBe(false);
    expect(first.knownPrefixLength).toBe(first.canonical.length);
    const deeper = inspectPath(path.join(root, "Existing/New/Deep/FILE"), modes);
    const prefix = path.join(root, "Existing/New") + "/";
    expect(deeper.insensitive.slice(0, prefix.length)).toEqual(Array(prefix.length).fill(false));
    expect(deeper.insensitive.slice(prefix.length)).toEqual("Deep/FILE".split("").map((letter) => /^[a-z]$/i.test(letter)));
    expect(hasUnknownLookup(deeper)).toBe(true);
    expect(deeper.knownPrefixLength).toBe(prefix.length);
  });

  test("uses the canonical symlink target's chain in one metadata read", () => {
    const target = put("Actual/File");
    fs.symlinkSync(path.dirname(target), path.join(root, "link"));
    const calls: string[] = [];
    const evidence = inspectPath(path.join(root, "link/New/Leaf"), (existing) => {
      calls.push(existing);
      return directoryModes(existing, () => "sensitive");
    });
    expect(calls).toEqual([path.dirname(target)]);
    expect(evidence.canonical).toBe(path.join(root, "Actual/New/Leaf"));
    expect(hasUnknownLookup(evidence)).toBe(true);
  });

  test("a missing leaf keeps its proven-insensitive parent mode", () => {
    fs.mkdirSync(path.join(root, "Existing"));
    const modes = (existing: string) => directoryModes(existing, (directory) =>
      directory === path.join(root, "Existing") ? "insensitive" : "sensitive");
    const evidence = inspectPath(path.join(root, "Existing/NEW"), modes);
    expect(evidence.insensitive.slice(-3)).toEqual([true, true, true]);
    expect(hasUnknownLookup(evidence)).toBe(false);
    const deeper = inspectPath(path.join(root, "Existing/NEW/Leaf"), modes);
    expect(deeper.insensitive.slice(-4)).toEqual([true, true, true, true]);
    expect(hasUnknownLookup(deeper)).toBe(true);
  });

  test("unknown metadata still canonicalizes existing aliases", () => {
    const target = put("Mixed/.env");
    insensitive();
    const evidence = inspectPath(path.join(root, "mIXED/.ENV"), (existing) => directoryModes(existing, () => "unknown"));
    expect(evidence.canonical).toBe(target);
    expect(hasUnknownLookup(evidence)).toBe(true);
    expect(evidence.insensitive[target.indexOf("Mixed")]).toBe(true);
  });

  test("unknown lookup does not conflate case-distinct exact hardlinks", () => {
    const lower = put(".env");
    const upper = path.join(root, ".Env");
    if (fs.existsSync(upper)) return;
    fs.linkSync(lower, upper);
    const modes = (existing: string) => directoryModes(existing, () => "unknown");
    expect(inspectPath(lower, modes).canonical).toBe(lower);
    expect(inspectPath(upper, modes).canonical).toBe(upper);
  });

  test("does not downgrade realpath permission errors to missing components", () => {
    const target = put("File");
    const denied = spyOn(fs, "realpathSync").mockImplementation(() => {
      throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    });
    restore.push(() => denied.mockRestore());
    expect(() => inspectPath(target)).toThrow("fixture denied");
  });

  test("validates the single fixed helper response and fails unknown", () => {
    const target = put("Mixed/File");
    const modes = directoryModes(target, () => "sensitive");
    const run = spyOn(childProcess, "spawnSync").mockReturnValue({ status: 0, stdout: JSON.stringify(modes) } as any);
    restore.push(() => run.mockRestore());
    expect(native.readDirectoryModes(target)).toEqual(modes);
    expect(run.mock.calls.length).toBe(1);
    expect(run.mock.calls[0]![0]).toBe(fileURLToPath(new URL("../bin/path-lookup", import.meta.url)));
    expect(run.mock.calls[0]![1]).toEqual([target]);
    for (const response of ["not json", "[]", JSON.stringify(modes.map(() => true))]) {
      run.mockReturnValue({ status: 0, stdout: response } as any);
      expect(native.readDirectoryModes(target)).toEqual(modes.map(() => "unknown"));
    }
    run.mockReturnValue({ error: Object.assign(new Error("missing"), { code: "ENOENT" }), status: null } as any);
    expect(native.readDirectoryModes(target)).toEqual(modes.map(() => "unknown"));
    run.mockReturnValue({ status: 1, stdout: JSON.stringify(modes) } as any);
    expect(native.readDirectoryModes(target)).toEqual(modes.map(() => "unknown"));
  });

  test.skipIf(process.platform !== "linux" || !fs.existsSync(fileURLToPath(new URL("../bin/path-lookup", import.meta.url))) ||
    fs.statfsSync(os.tmpdir()).type !== 0xef53)
    ("reads real ext4 sensitivity with the bundled helper", () => {
      const target = put("Mixed/File");
      const modes = native.readDirectoryModes(target);
      expect(modes.at(-2)).toBe("sensitive");
      const evidence = inspectPath(target, native.readDirectoryModes);
      expect(evidence.canonical).toBe(target);
      expect(evidence.insensitive.slice(root.length + 1).every((flag) => !flag)).toBe(true);
      expect(hasUnknownLookup(evidence)).toBe(modes.slice(0, -1).includes("unknown"));
    });
});

describe("case-insensitive filesystem with spelling-preserving realpath", () => {
  test("unknown metadata cannot widen an exemption into a case-distinct sibling", () => {
    const allowed = put("Vault/memory/file.txt");
    const denied = put("Vault/Memory/file.txt");
    const modes = spyOn(pathLookup, "readDirectoryModes").mockImplementation((target) => directoryModes(target, () => "unknown"));
    restore.push(() => modes.mockRestore());
    const config = { ...baseConfig, denyRoots: [path.join(root, "Vault")], exemptRoots: [path.join(root, "Vault/memory")] };
    expect(classifyPath(allowed, config)).toBe("allow");
    expect(classifyPath(denied, config)).toBe("deny");
  });

  test("cache protection survives a differently spelled cache configuration", () => {
    const target = put("Cache/opencode-secret-guard/file.txt");
    insensitive();
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = path.join(root, "cACHE");
    try {
      expect(classifyPath(target, baseConfig)).toBe("deny");
    } finally {
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
    }
  });
  test("canonicalizes aliases without erasing a denial from an equivalent uppercase spelling", () => {
    const target = put("Mixed/.env");
    insensitive();
    expect(inspectPath(path.join(root, "mIXED/.ENV")).canonical).toBe(target);
    expect(classifyPath(path.join(root, "mIXED/.ENV"), baseConfig)).toBe("deny");
    expect(classifyPath(target, { ...baseConfig, secretPatterns: ["/\\.ENV$"] })).toBe("deny");
  });

  test.each([".ENV", ".KUBE/config"])("retains lowercase-policy denials when the stored name is %s", (relative) => {
    const actual = put(relative);
    insensitive();
    const lowerAlias = path.join(root, relative.toLowerCase());
    const oldSpelling = fs.realpathSync(lowerAlias);
    expect(baseConfig.secretPatterns.some((pattern) => new RegExp(pattern).test(oldSpelling))).toBe(true);
    expect(baseConfig.secretExceptions.some((pattern) => new RegExp(pattern).test(oldSpelling))).toBe(false);
    expect([...classifyPaths([lowerAlias, actual], baseConfig).values()]).toEqual(["deny", "deny"]);
  });

  test("respects a case-sensitive directory inside an insensitive tree", () => {
    const lower = put("Sensitive/.env");
    const upper = put("Sensitive/.ENV");
    insensitive([path.join(root, "Sensitive")]);
    expect(inspectPath(path.join(root, "sENSITIVE/.env")).canonical).toBe(lower);
    expect(inspectPath(path.join(root, "sENSITIVE/.ENV")).canonical).toBe(upper);
    expect(classifyPath(path.join(root, "sENSITIVE/.ENV"), baseConfig)).toBe("allow");
  });

  test("normalizes non-ASCII case aliases without changing the stored name", () => {
    const target = put("文Étage/.env");
    insensitive();
    expect(inspectPath(path.join(root, "文étage/.ENV")).canonical).toBe(target);
  });

  test("probes an ASCII letter instead of a Unicode expansion when available", () => {
    const target = put("ßfolder/.env");
    insensitive();
    expect(inspectPath(path.join(root, "ßFOLDER/.ENV")).canonical).toBe(target);
  });

  test("establishes Unicode spelling when the case probe expands to a different name", () => {
    const target = put("ẞ/.env");
    insensitive();
    expect(inspectPath(path.join(root, "ß/.ENV")).canonical).toBe(target);
  });

  test("canonicalizes the deepest existing ancestor and preserves new descendant spelling", () => {
    put("Vault/existing.txt");
    insensitive();
    const target = path.join(root, "vAULT/New/Deep/FILE.txt");
    expect(inspectPath(target).canonical).toBe(path.join(root, "Vault/New/Deep/FILE.txt"));
    expect(classifyPath(target, { ...baseConfig, denyRoots: [path.join(root, "VAULT")] }, "write")).toBe("deny");
  });

  test("deny and exempt root aliases agree, including missing descendants", () => {
    put("Vault/Memory/.env");
    put("Vault/private.txt");
    insensitive();
    const config = { ...baseConfig, denyRoots: [path.join(root, "vAULT")], exemptRoots: [path.join(root, "VAULT/mEMORY")] };
    expect(classifyPath(path.join(root, "vault/PRIVATE.txt"), config)).toBe("deny");
    expect(classifyPath(path.join(root, "vault/memory/.ENV"), config)).toBe("allow");
    expect(classifyPath(path.join(root, "vault/memory/New/Leaf"), config, "write")).toBe("allow");
    expect(() => validateConfig({ ...config, exemptRoots: [path.join(root, "VAULT")] }, "fixture", root)).toThrow("contains the guarded path");
  });

  test("gitignore gets the actual directory-entry spelling, including batch classification", () => {
    const ignored = put("Local.conf");
    fs.writeFileSync(path.join(root, ".gitignore"), "Local.conf\n");
    expect(spawnSync(baseConfig.tools.git, ["init", "-q", root]).status).toBe(0);
    insensitive();
    const alias = path.join(root, "lOCAL.CONF");
    expect(classifyPath(alias, baseConfig)).toBe("deny");
    expect(classifyPaths([alias, ignored], baseConfig).get(alias)).toBe("deny");
  });

  test("symlinks still resolve to the secret and both tamper spellings remain protected", () => {
    const target = put("Mixed/.env");
    fs.symlinkSync(target, path.join(root, "Shortcut"));
    insensitive();
    expect(realpath(path.join(root, "sHORTCUT"))).toBe(target);
    expect(classifyPath(path.join(root, "sHORTCUT"), baseConfig)).toBe("deny");
    const targets = { literals: bothPaths(path.join(root, "Shortcut")), subpaths: [] };
    expect(mayBeTamperProtected(inspectPath(path.join(root, "sHORTCUT")), targets)).toBe(true);
  });

  test("tamper policy files and their ancestors use the same canonical spelling", () => {
    put("Config/Policy.json");
    insensitive();
    const targets = tamperTargets({ repoRoot: null, pathEnvironment: "", home: root, policyPath: path.join(root, "cONFIG/pOLICY.JSON") });
    expect(mayBeTamperProtected(inspectPath(path.join(root, "CONFIG/POLICY.json")), targets)).toBe(true);
    expect(mayBeTamperProtected(inspectPath(path.join(root, "CONFIG")), targets)).toBe(true);
  });

  test("tamper evidence matches aliases while strings retain exact comparisons", () => {
    const target = put("Protected/File");
    insensitive();
    const literalTargets = { literals: [path.join(root, "pROTECTED/fILE")], subpaths: [] };
    const subtreeTargets = { literals: [], subpaths: [path.join(root, "pROTECTED")] };
    const evidence = inspectPath(target);
    expect(mayBeTamperProtected(evidence, literalTargets)).toBe(true);
    expect(mayBeTamperProtected(evidence, subtreeTargets)).toBe(true);
    expect(isTamperProtected(target, literalTargets)).toBe(false);
    expect(isTamperProtected(target, subtreeTargets)).toBe(false);
    expect(mayBeTamperProtected(inspectPath(put("ProtectedSibling/File")), subtreeTargets)).toBe(false);
  });

  test.each(["read", "write", "edit", "browser_preview", "browser_files_upload", "browser_files_drop"])("%s refuses existing aliases", (tool) => {
    put(".env");
    insensitive();
    expect(() => checkToolCall(tool, { path: path.join(root, ".ENV"), paths: [path.join(root, ".ENV")] }, baseConfig, root)).toThrow("blocked");
  });

  test.each(["*** Update File: .ENV\n", "*** Update File: public.txt\n*** Move to: .ENV\n", "*** Add File: VAULT/New/Deep/file\n"])("patch refuses source, destination and new descendants: %s", (headers) => {
    put(".env");
    put("Vault/existing.txt");
    insensitive();
    const config = { ...baseConfig, denyRoots: [path.join(root, "vAULT")] };
    expect(() => checkToolCall("patch", { patchText: `*** Begin Patch\n${headers}*** End Patch` }, config, root)).toThrow("blocked");
  });

  test("fails closed when a proven alias cannot be enumerated", () => {
    put(".env");
    const scan = insensitive();
    scan.mockImplementation((directory: any, ...args: any[]) => {
      if (directory === root) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
      return (native.readdir as any)(directory, ...args);
    });
    const alias = path.join(root, ".ENV");
    expect(() => inspectPath(alias)).toThrow("fixture denied");
    expect(() => checkToolCall("read", { path: alias }, baseConfig, root)).toThrow("fixture denied");
    expect(classifyPaths([alias], baseConfig).get(alias)).toBe("deny");
  });

  test("does not cache names across renames", () => {
    const target = put(".env");
    insensitive();
    expect(inspectPath(path.join(root, ".ENV")).canonical).toBe(target);
    fs.renameSync(target, path.join(root, ".Env"));
    expect(inspectPath(path.join(root, ".ENV")).canonical).toBe(path.join(root, ".Env"));
  });

  test("rejects a proven alias if no unique directory entry can establish its spelling", () => {
    put(".env");
    const scan = insensitive();
    scan.mockImplementation((directory: any, ...args: any[]) => directory === root ? [] : (native.readdir as any)(directory, ...args));
    expect(() => inspectPath(path.join(root, ".ENV"))).toThrow("cannot establish the on-disk spelling");
  });
});
