import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createV1Hooks } from "../src/v1.ts";
import { loadConfig } from "../src/policy.ts";
import type { GuardConfig } from "../src/policy.ts";
import { classifyPath } from "../src/predicate.ts";
import { profilePath } from "../src/profile.ts";
import { PACKAGE_DIRECTORY, isTamperProtected, protectedNodes, tamperTargets, writablePathDirectories } from "../src/tamper.ts";

const policyPath = process.env.OPENCODE_SECRET_GUARD_CONFIG;
if (!policyPath) throw new Error("OPENCODE_SECRET_GUARD_CONFIG must be set");

let fixture: string;
let repo: string;
let config: GuardConfig;
let previousXdg: string | undefined;

/** The V1 hooks for a project at `repo`, installed under the fixture. */
const v1 = (guardConfig: GuardConfig, moduleDirectory: string) => createV1Hooks(guardConfig, moduleDirectory, repo);

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

  test("keeps a symlinked entry, whose link can be re-pointed even when its target cannot be written", () => {
    const real = path.join(fixture, "real-bin");
    fs.mkdirSync(real);
    const link = path.join(fixture, "link-bin");
    fs.symlinkSync(real, link);

    expect(writablePathDirectories(link, null)).toEqual([link]);
    expect(tamperTargets({ repoRoot: null, pathEnvironment: link, home: fixture, policyPath, writeProtectedRoots: [] }).subpaths).toEqual(
      expect.arrayContaining([link, real]),
    );
  });
});

describe("tamperTargets", () => {
  test("names what OpenCode executes at startup, globally and per project", () => {
    const targets = tamperTargets({ repoRoot: repo, pathEnvironment: "", home: fixture, policyPath, writeProtectedRoots: [] });
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
    const targets = tamperTargets({ repoRoot: repo, pathEnvironment: "", home: fixture, policyPath, writeProtectedRoots: [] });
    const configDirectory = path.join(fixture, "config", "opencode");

    expect(isTamperProtected(path.join(configDirectory, "skills", "x", "SKILL.md"), targets)).toBe(false);
    expect(isTamperProtected(path.join(configDirectory, "AGENTS.md"), targets)).toBe(false);
    expect(isTamperProtected(path.join(repo, ".opencode", "command", "x.md"), targets)).toBe(false);
    expect(isTamperProtected(path.join(repo, "src", "index.ts"), targets)).toBe(false);
  });

  test("covers a file inside a protected tree and the tree itself", () => {
    const targets = tamperTargets({ repoRoot: repo, pathEnvironment: "", home: fixture, policyPath, writeProtectedRoots: [] });
    expect(isTamperProtected(path.join(repo, ".opencode", "plugins", "evil.ts"), targets)).toBe(true);
    expect(isTamperProtected(path.join(repo, ".opencode", "plugins"), targets)).toBe(true);
  });

  test("protects a symlinked target at the link as well as at its destination", () => {
    // How Home Manager installs the policy: a link in the config directory
    // pointing into the store. Protecting only the destination leaves the link
    // free to be unlinked and rewritten, and the link is what the next command
    // is judged by.
    const destination = path.join(fixture, "store", "secret-guard.json");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, "{}\n");
    const link = path.join(fixture, "config", "opencode", "linked-policy.json");
    fs.symlinkSync(destination, link);

    const targets = tamperTargets({ repoRoot: repo, pathEnvironment: "", home: fixture, policyPath: link, writeProtectedRoots: [] });
    expect(isTamperProtected(link, targets)).toBe(true);
    expect(isTamperProtected(destination, targets)).toBe(true);
  });

  test("protects the file the command interpreter sources before every command", () => {
    const targets = tamperTargets({ repoRoot: repo, pathEnvironment: "", home: fixture, policyPath, writeProtectedRoots: [] });
    expect(isTamperProtected(path.join(fixture, ".zshenv"), targets)).toBe(true);
    // Read for interactive shells only, so the wrapper never runs them.
    expect(isTamperProtected(path.join(fixture, ".zshrc"), targets)).toBe(false);
    expect(isTamperProtected(path.join(fixture, ".zprofile"), targets)).toBe(false);
  });

  test("protects the directory nodes leading to every target, so none can be swapped for a symlink", () => {
    const bin = path.join(fixture, "path", "bin");
    const targets = tamperTargets({ repoRoot: repo, pathEnvironment: bin, home: fixture, policyPath, writeProtectedRoots: [] });

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

describe("writeProtectedRoots", () => {
  // A Homebrew-style layout: launcher and opt links into a versioned keg, and
  // an app bundle outside PATH.
  let brew: string;
  let keg: string;
  let bundle: string;
  let roots: string[];

  beforeAll(() => {
    brew = path.join(fixture, "brew");
    keg = path.join(brew, "Cellar", "tool");
    fs.mkdirSync(path.join(keg, "1.0", "bin"), { recursive: true });
    fs.writeFileSync(path.join(keg, "1.0", "bin", "tool"), "#!/bin/sh\n", { mode: 0o755 });
    fs.mkdirSync(path.join(brew, "Cellar", "other"));
    fs.mkdirSync(path.join(brew, "bin"));
    fs.symlinkSync("../Cellar/tool/1.0/bin/tool", path.join(brew, "bin", "tool"));
    fs.mkdirSync(path.join(brew, "opt"));
    fs.symlinkSync("../Cellar/tool/1.0", path.join(brew, "opt", "tool"));
    bundle = path.join(fixture, "Applications", "Tool.app");
    fs.mkdirSync(path.join(bundle, "Contents", "Resources"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "Contents", "Resources", "app.asar"), "bundle\n");
    roots = [keg, path.join(brew, "opt", "tool"), path.join(brew, "bin", "tool"), bundle];
  });

  const targets = () =>
    tamperTargets({ repoRoot: repo, pathEnvironment: "", home: fixture, policyPath, writeProtectedRoots: roots });

  test("protects the installation tree, including versions installed later", () => {
    expect(isTamperProtected(path.join(keg, "1.0", "bin", "tool"), targets())).toBe(true);
    expect(isTamperProtected(path.join(keg, "2.0", "bin", "tool"), targets())).toBe(true);
    expect(isTamperProtected(path.join(bundle, "Contents", "Resources", "app.asar"), targets())).toBe(true);
  });

  test("protects launcher links and what they resolve to", () => {
    expect(isTamperProtected(path.join(brew, "bin", "tool"), targets())).toBe(true);
    expect(isTamperProtected(path.join(brew, "opt", "tool"), targets())).toBe(true);
    expect(targets().subpaths).toContain(path.join(keg, "1.0"));
  });

  test("protects the directory nodes leading to a root, but not their siblings", () => {
    expect(targets().literals).toEqual(expect.arrayContaining([path.join(brew, "Cellar"), brew, path.dirname(bundle)]));
    expect(isTamperProtected(path.join(brew, "Cellar", "other", "note"), targets())).toBe(false);
    expect(isTamperProtected(path.join(brew, "bin", "other"), targets())).toBe(false);
  });

  test("accepts a root that does not exist yet", () => {
    const missing = path.join(fixture, "not-installed", "Tool.app");
    const found = tamperTargets({ repoRoot: null, pathEnvironment: "", home: fixture, policyPath, writeProtectedRoots: [missing] });
    expect(isTamperProtected(path.join(missing, "Contents", "MacOS", "Tool"), found)).toBe(true);
  });

  test("the file tools may read but not write below a root, even through a link or an exemption", () => {
    const protectedConfig = { ...config, writeProtectedRoots: roots };
    const binary = path.join(keg, "1.0", "bin", "tool");
    expect(classifyPath(binary, protectedConfig, "read")).toBe("allow");
    expect(classifyPath(binary, protectedConfig, "write")).toBe("deny");
    expect(classifyPath(path.join(brew, "bin", "tool"), protectedConfig, "write")).toBe("deny");
    expect(classifyPath(path.join(bundle, "Contents", "Resources", "app.asar"), protectedConfig, "write")).toBe("deny");
    expect(classifyPath(binary, { ...protectedConfig, exemptRoots: [brew] }, "write")).toBe("deny");
    expect(classifyPath(path.join(brew, "Cellar", "other", "note"), protectedConfig, "write")).toBe("allow");
  });

  test("an upgrade that re-points a protected link yields a new profile naming the new target", () => {
    const link = path.join(brew, "opt", "upgraded");
    fs.symlinkSync(path.join(keg, "1.0"), link);
    const options = {
      config: { ...config, writeProtectedRoots: [link] },
      home: fixture,
      cwd: repo,
      group: null,
      directory: path.join(fixture, "profiles"),
    };
    const before = profilePath(options);
    fs.mkdirSync(path.join(keg, "2.0"));
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(keg, "2.0"), link);
    const after = profilePath(options);

    expect(after).not.toBe(before);
    expect(fs.readFileSync(after, "utf8")).toContain(`(subpath "${path.join(keg, "2.0")}")`);
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
    expect(nodes.literals).toEqual([path.join(fs.realpathSync(os.tmpdir()), "elsewhere", "vault")]);
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
    const hooks = v1(config, path.join(fixture, "package", "lib"));
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
