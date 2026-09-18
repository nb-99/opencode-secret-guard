import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHooks } from "../src/hooks.ts";
import { loadConfig } from "../src/policy.ts";
import type { GuardConfig } from "../src/policy.ts";
import { classifyPath } from "../src/predicate.ts";
import { PACKAGE_DIRECTORY, isTamperProtected, protectedNodes, tamperTargets, writablePathDirectories } from "../src/tamper.ts";

const policyPath = process.env.OPENCODE_SECRET_GUARD_CONFIG;
if (!policyPath) throw new Error("OPENCODE_SECRET_GUARD_CONFIG must be set");

let fixture: string;
let repo: string;
let config: GuardConfig;
let previousXdg: string | undefined;

beforeAll(() => {
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-guard-tamper-")));
  repo = path.join(fixture, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "index.ts"), "export {}\n");
  spawnSync(loadConfig(policyPath).tools.git, ["init", "-q", repo]);

  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(fixture, "config");
  fs.mkdirSync(path.join(fixture, "config", "opencode"), { recursive: true });
  config = loadConfig(policyPath, fixture);
});

afterAll(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe("writablePathDirectories", () => {
  test("keeps writable and missing entries, drops read-only and in-repo ones", () => {
    const writable = path.join(fixture, "bin");
    fs.mkdirSync(writable);
    const missing = path.join(fixture, "not-yet");
    const inRepo = path.join(repo, "node_modules", ".bin");
    fs.mkdirSync(inRepo, { recursive: true });

    const found = writablePathDirectories(
      [writable, "/usr/bin", missing, inRepo, "relative/bin", ""].join(":"),
      repo,
    );

    expect(found).toContain(writable);
    expect(found).toContain(missing);
    expect(found).not.toContain("/usr/bin");
    expect(found).not.toContain(inRepo);
    expect(found.some((entry) => !path.isAbsolute(entry))).toBe(false);
  });

  test("resolves symlinked entries to the directory they point at", () => {
    const real = path.join(fixture, "real-bin");
    fs.mkdirSync(real);
    const link = path.join(fixture, "link-bin");
    fs.symlinkSync(real, link);

    expect(writablePathDirectories(link, null)).toEqual([real]);
  });
});

describe("tamperTargets", () => {
  test("names what OpenCode executes at startup, globally and per project", () => {
    const targets = tamperTargets({ repoRoot: repo, pathEnvironment: "", policyPath });
    const configDirectory = path.join(fixture, "config", "opencode");

    expect(targets.literals).toContain(fs.realpathSync(policyPath));
    expect(targets.literals).toContain(configDirectory);
    expect(targets.literals).toContain(path.join(configDirectory, "opencode.json"));
    expect(targets.literals).toContain(path.join(configDirectory, "package.json"));
    expect(targets.literals).toContain(path.join(repo, "opencode.json"));
    expect(targets.literals).toContain(path.join(repo, ".opencode", "package.json"));
    expect(targets.subpaths).toContain(path.join(configDirectory, "plugins"));
    expect(targets.subpaths).toContain(path.join(repo, ".opencode", "plugins"));
    expect(targets.subpaths).toContain(path.join(repo, ".opencode", "tools"));
    expect(targets.subpaths).toContain(PACKAGE_DIRECTORY);
  });

  test("leaves prompts and skills alone", () => {
    const targets = tamperTargets({ repoRoot: repo, pathEnvironment: "", policyPath });
    const configDirectory = path.join(fixture, "config", "opencode");

    expect(isTamperProtected(path.join(configDirectory, "skills", "x", "SKILL.md"), targets)).toBe(false);
    expect(isTamperProtected(path.join(configDirectory, "AGENTS.md"), targets)).toBe(false);
    expect(isTamperProtected(path.join(repo, ".opencode", "command", "x.md"), targets)).toBe(false);
    expect(isTamperProtected(path.join(repo, "src", "index.ts"), targets)).toBe(false);
  });

  test("covers a file inside a protected tree and the tree itself", () => {
    const targets = tamperTargets({ repoRoot: repo, pathEnvironment: "", policyPath });
    expect(isTamperProtected(path.join(repo, ".opencode", "plugins", "evil.ts"), targets)).toBe(true);
    expect(isTamperProtected(path.join(repo, ".opencode", "plugins"), targets)).toBe(true);
  });

  test("protects the directory nodes leading to every target, so none can be swapped for a symlink", () => {
    const bin = path.join(fixture, "path", "bin");
    const targets = tamperTargets({ repoRoot: repo, pathEnvironment: bin, policyPath });

    // The nodes themselves cannot be renamed or replaced...
    for (const node of [
      path.join(repo, ".opencode"),
      repo,
      path.join(fixture, "config"),
      path.join(fixture, "path"),
      fixture,
    ]) {
      expect(targets.literals).toContain(node);
    }
    // ...while writing beside a protected child stays possible.
    expect(isTamperProtected(path.join(repo, ".opencode", "command", "x.md"), targets)).toBe(false);
    expect(isTamperProtected(path.join(fixture, "path", "notes.txt"), targets)).toBe(false);
  });
});

describe("protectedNodes", () => {
  test("derives directory nodes from trailing-slash patterns", () => {
    const nodes = protectedNodes(config, fixture);
    expect(nodes.regexes).toContain("/\\.kube$");
    expect(nodes.regexes).toContain("/secrets$");
    expect(nodes.regexes.some((regex) => regex.includes("env"))).toBe(false);
  });

  test("collects ancestors of home-relative roots but stops below home", () => {
    const nodes = protectedNodes(config, fixture);
    expect(nodes.literals).toContain(path.join(fixture, ".config", "gcloud"));
    expect(nodes.literals).toContain(path.join(fixture, ".config"));
    expect(nodes.literals).toContain(path.join(fixture, ".config", "secrets"));
    expect(nodes.literals).not.toContain(fixture);
    expect(nodes.literals).not.toContain(path.dirname(fixture));
  });

  test("names a deny root outside home without walking its ancestors", () => {
    const outside = path.join(os.tmpdir(), "elsewhere", "vault");
    const nodes = protectedNodes({ ...config, denyRoots: [outside], relaxationGroups: {} }, fixture);
    expect(nodes.literals).toEqual([outside]);
  });
});

describe("the file-tool predicate distinguishes reads from writes", () => {
  test("a protected config file is readable but not writable", () => {
    const target = path.join(repo, "opencode.json");
    expect(classifyPath(target, config, "read")).toBe("allow");
    expect(classifyPath(target, config, "write")).toBe("deny");
  });

  test("ordinary source stays writable", () => {
    expect(classifyPath(path.join(repo, "src", "index.ts"), config, "write")).toBe("allow");
  });

  test("every write tool is refused on a protected path and the error says why", async () => {
    const hooks = createHooks(config, path.join(fixture, "package", "lib"));
    for (const tool of ["edit", "write", "patch"]) {
      await expect(
        hooks["tool.execute.before"]({ tool }, { args: { filePath: path.join(repo, "opencode.json") } }),
      ).rejects.toThrow(/write access .* part of the guard/);
    }
    await expect(
      hooks["tool.execute.before"]({ tool: "read" }, { args: { filePath: path.join(repo, "opencode.json") } }),
    ).resolves.toBeUndefined();
  });
});
