import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findRepoRoot, gitignoreRules } from "../src/gitignore.ts";
import { createHooks } from "../src/hooks.ts";
import { configPath, loadConfig } from "../src/policy.ts";
import type { GuardConfig } from "../src/policy.ts";
import { classifyPath, classifyPaths, filterSearchOutput } from "../src/predicate.ts";
import { buildProfile } from "../src/profile.ts";
import { expectedShell, resolveForShell, resolveProfile, scrubbedEnvironment } from "../src/shell.ts";

const policyPath = process.env.OPENCODE_SECRET_GUARD_CONFIG;
if (!policyPath) {
  throw new Error("OPENCODE_SECRET_GUARD_CONFIG must point at the generated config JSON");
}
// Loaded through the validator rather than JSON.parse, so the real policy is
// checked against the schema on every run.
const baseConfig = loadConfig(policyPath);

let repo: string;
let config: GuardConfig;

/** Writes a file, creating parents. */
function put(relative: string, contents = "x\n"): string {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-guard-")));

  put(".env", "TOKEN=live\n");
  put(".env.example", "TOKEN=\n");
  put(".env.local", "TOKEN=live\n");
  put("README.md", "# readme\n");
  put("id_rsa", "PRIVATE\n");
  put("id_rsa.pub", "PUBLIC\n");
  put("server.pem", "CERT\n");
  put("secrets/token", "s\n");
  put("config/credentials", "c\n");
  put("infra/terraform.tfstate", "{}\n");
  put("infra/prod.tfvars", "x = 1\n");
  put("node_modules/pkg/index.js", "module.exports = 1\n");
  put("node_modules/pkg/.env", "TOKEN=live\n");
  put(".opencode/.gitignore", "*\n");
  put(".opencode/node_modules/pkg/index.js", "module.exports = 1\n");
  put(".opencode/node_modules/pkg/.env", "TOKEN=live\n");
  put(".opencode/private.md", "private\n");
  put("dist/app.js", "console.log(1)\n");
  put("build/out.txt", "artifact\n");
  put("private-notes/note.md", "personal\n");
  put("private-notes/nested/deep.md", "personal\n");
  put("private-notes/nested/node_modules/pkg/index.js", "module.exports = 1\n");
  put("mixed-ignored/private.md", "personal\n");
  put("mixed-ignored/tracked.md", "tracked\n");
  put("local.conf", "local\n");
  put("docs/secret-rotation.md", "# rotation\n");
  put("lib/secrets.nix", "{}\n");
  put(".gitignore", "local.conf\nbuild/\nprivate-notes/\nmixed-ignored/\nnode_modules/\ndist/\n.env\n.env.local\n");

  fs.symlinkSync(path.join(repo, ".env"), path.join(repo, "link-to-env"));
  fs.symlinkSync(path.join(repo, "local.conf"), path.join(repo, "tracked-link-to-local"));

  spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "add", "-f", "mixed-ignored/tracked.md"], { encoding: "utf8" });
  fs.symlinkSync(path.join(repo, ".gitignore"), path.join(repo, ".ignored-link"));
  fs.writeFileSync(path.join(repo, ".git/info/exclude"), ".ignored-link\n");

  // Mirrors production: the exempt memory root is nested inside the denied
  // vault root, so the two rules must be evaluated in the right order.
  config = {
    ...baseConfig,
    exemptRoots: [path.join(repo, "vault/memory")],
    denyRoots: [path.join(repo, "vault")],
  };
  put("vault/memory/index.md", "# index\n");
  put("vault/memory/.env", "not-really-a-secret\n");
  put("vault/private/journal.md", "n\n");
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

const verdict = (relative: string) => classifyPath(path.join(repo, relative), config);

describe("configuration loading", () => {
  /** Writes a candidate policy and returns its path. */
  const policy = (name: string, value: unknown): string => {
    const target = path.join(repo, "policies", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
    return target;
  };
  const valid = (): Record<string, unknown> => ({
    ...baseConfig,
    denyRoots: [],
    exemptRoots: [],
  });

  test("the generated policy validates", () => {
    expect(baseConfig.configVersion).toBe(3);
    expect(baseConfig.secretPatterns.length).toBeGreaterThan(0);
  });

  test("the policy names the git the guard spawns, and it exists", () => {
    // The whole point of tools.git is not resolving through PATH; a policy
    // whose git is missing would make every profile generation fail closed.
    expect(path.isAbsolute(baseConfig.tools.git)).toBe(true);
    expect(fs.existsSync(baseConfig.tools.git)).toBe(true);
  });

  test("a missing policy names the path it looked at", () => {
    const absent = path.join(repo, "policies", "absent.json");
    expect(() => loadConfig(absent)).toThrow(absent);
  });

  test("malformed JSON is rejected", () => {
    expect(() => loadConfig(policy("bad.json", "{"))).toThrow(/invalid JSON/);
  });

  test.each([
    ["a newer configVersion", { configVersion: 4 }, /unsupported configVersion 4/],
    ["a missing configVersion", { configVersion: undefined }, /unsupported configVersion/],
    ["a non-string list entry", { artifactAllowlist: ["dist", 7] }, /must be an array of strings/],
    ["a negative cacheTtlMs", { cacheTtlMs: -1 }, /"cacheTtlMs"/],
    ["a non-numeric cacheTtlMs", { cacheTtlMs: "2000" }, /"cacheTtlMs"/],
    ["a relative deny root", { denyRoots: ["relative/secrets"] }, /absolute path/],
    ["a non-object relaxationGroups", { relaxationGroups: [] }, /must be an object/],
    ["a relative tools.git", { tools: { git: "git" } }, /"tools.git" must be an absolute path/],
    ["a non-object tools", { tools: "git" }, /"tools" must be an object/],
    [
      "an environment name carrying a newline",
      { secretEnvironment: ["TOKEN\nEXTRA"] },
      /invalid variable name/,
    ],
    ["an environment name with a shell metacharacter", { secretEnvironment: ["A-B"] }, /invalid variable name/],
    ["an unknown mode", { mode: "files" }, /"mode" must be one of/],
    ["an uncompilable environment pattern", { secretEnvironmentPatterns: ["("] }, /invalid regular expression/],
  ])("%s is rejected", (name, patch, expected) => {
    expect(() => loadConfig(policy(`${name}.json`, { ...valid(), ...patch }))).toThrow(expected);
  });

  test("a version-2 policy loads with the fixed git and no environment patterns", () => {
    const { tools, secretEnvironmentPatterns, ...rest } = valid();
    const loaded = loadConfig(policy("v2.json", { ...rest, configVersion: 2 }));
    expect(loaded.tools.git).toBe("/usr/bin/git");
    expect(loaded.secretEnvironmentPatterns).toEqual([]);
    expect(loaded.configVersion).toBe(3);
  });

  test("an uncompilable secret pattern is rejected", () => {
    // matchesAny treats an invalid pattern as "no match", so an unchecked typo
    // would silently stop denying rather than fail.
    expect(() =>
      loadConfig(policy("regex.json", { ...valid(), secretPatterns: ["/\\.env$", "([a-z"] })),
    ).toThrow(/invalid regular expression/);
  });

  test("an absolute allowPaths entry is rejected", () => {
    // path.join would fold it under $HOME and grant nothing.
    const relaxationGroups = { kube: { binaries: ["kubectl"], allowPaths: ["/etc/kube"] } };
    expect(() => loadConfig(policy("allow.json", { ...valid(), relaxationGroups }))).toThrow(
      /relative to \$HOME/,
    );
  });

  test("roots expand ~ against the given home", () => {
    const source = policy("home.json", {
      ...valid(),
      denyRoots: ["~/.config/secrets"],
      exemptRoots: ["~/.config/secrets/public"],
    });
    const loaded = loadConfig(source, "/fixture/home");
    expect(loaded.denyRoots).toEqual(["/fixture/home/.config/secrets"]);
    expect(loaded.exemptRoots).toEqual(["/fixture/home/.config/secrets/public"]);
  });

  test("an exempt root above a deny root or a group's allowPaths is rejected", () => {
    // The exempt allow is the last rule and covers renames, so it would reopen
    // moving the credential directory out from under its pattern.
    expect(() =>
      loadConfig(policy("exempt-deny.json", { ...valid(), denyRoots: ["~/vault/private"], exemptRoots: ["~"] }), "/fixture/home"),
    ).toThrow(/contains the guarded path \/fixture\/home\/vault\/private/);
    expect(() =>
      loadConfig(policy("exempt-group.json", { ...valid(), exemptRoots: ["~/.config"] }), "/fixture/home"),
    ).toThrow(/contains the guarded path/);
  });

  test("the default path follows XDG_CONFIG_HOME, and the override wins", () => {
    const previousBase = process.env.XDG_CONFIG_HOME;
    const previousOverride = process.env.OPENCODE_SECRET_GUARD_CONFIG;
    try {
      delete process.env.OPENCODE_SECRET_GUARD_CONFIG;
      process.env.XDG_CONFIG_HOME = "/fixture/config";
      expect(configPath()).toBe("/fixture/config/opencode/secret-guard.json");
      process.env.OPENCODE_SECRET_GUARD_CONFIG = "/fixture/override.json";
      expect(configPath()).toBe("/fixture/override.json");
    } finally {
      if (previousBase === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousBase;
      if (previousOverride === undefined) delete process.env.OPENCODE_SECRET_GUARD_CONFIG;
      else process.env.OPENCODE_SECRET_GUARD_CONFIG = previousOverride;
    }
  });

  test("the policy at the default path is readable by the guard itself", () => {
    // It sits beside opencode's config and its name contains "secret", which
    // the generic secret-container patterns must not catch — otherwise the
    // guard would deny the agent every look at its own policy.
    expect(classifyPath("/fixture/home/.config/opencode/secret-guard.json", config)).toBe("allow");
  });

  test("an omitted mode keeps the strong boundary", () => {
    // A policy predating the field must not silently weaken.
    const { mode, ...rest } = valid();
    expect(loadConfig(policy("nomode.json", rest)).mode).toBe("shell+files");
  });

  test("files-only is accepted when asked for explicitly", () => {
    const loaded = loadConfig(policy("filesonly.json", { ...valid(), mode: "files-only" }));
    expect(loaded.mode).toBe("files-only");
  });
});

describe("guard modes", () => {
  test('files-only announces the reduced boundary and skips the shell check', async () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      written.push(String(chunk));
      return true;
    };
    try {
      const hooks = createHooks({ ...config, mode: "files-only" }, path.join(repo, "package", "lib"));
      // A shell that would be rejected in shell+files mode is not consulted.
      await expect(hooks.config({ shell: "/bin/zsh" })).resolves.toBeUndefined();
    } finally {
      (process.stderr as any).write = original;
    }

    expect(written.join("")).toMatch(/files-only/);
    expect(written.join("")).toMatch(/bash tool is NOT/);
  });

  test("files-only still guards the file tools", async () => {
    const hooks = createHooks({ ...config, mode: "files-only" }, path.join(repo, "package", "lib"));

    await expect(
      hooks["tool.execute.before"]({ tool: "read" }, { args: { filePath: path.join(repo, ".env") } }),
    ).rejects.toThrow("blocked");
  });

  test("files-only refuses to act as the configured shell", () => {
    // The wrapper exists only to enforce the shell layer; running a command
    // under no profile would be worse than refusing.
    expect(() => resolveProfile("echo hi", { ...config, mode: "files-only" })).toThrow(
      /must not be configured as opencode's shell/,
    );
  });

  test("shell+files refuses to start off macOS rather than pretending", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      expect(() => createHooks(config, path.join(repo, "package", "lib"))).toThrow(/needs macOS/);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  test("files-only starts anywhere", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      expect(() =>
        createHooks({ ...config, mode: "files-only" }, path.join(repo, "package", "lib")),
      ).not.toThrow();
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});

describe("secret patterns", () => {
  test.each([
    ".env",
    ".env.local",
    "id_rsa",
    "server.pem",
    "secrets/token",
    "config/credentials",
    "infra/terraform.tfstate",
    "infra/prod.tfvars",
    "node_modules/pkg/.env",
    ".opencode/node_modules/pkg/.env",
  ])("denies %s", (relative) => {
    expect(verdict(relative)).toBe("deny");
  });
});

describe("false positives the narrowed patterns must avoid", () => {
  test.each([
    "README.md",
    "id_rsa.pub",
    "docs/secret-rotation.md",
    "lib/secrets.nix",
    "node_modules/pkg/index.js",
    ".opencode/.gitignore",
    ".opencode/node_modules/pkg/index.js",
    "dist/app.js",
  ])("allows %s", (relative) => {
    expect(verdict(relative)).toBe("allow");
  });
});

describe("exceptions", () => {
  test("allows .env.example even though .env.* is denied", () => {
    expect(verdict(".env.example")).toBe("allow");
  });

  test.each([
    "/nix/store/00000000000000000000000000000000-source/root.key",
    "/nix/store/00000000000000000000000000000000-source/test/server.pem",
    "/nix/store/00000000000000000000000000000000-source/fixtures/.env",
  ])("allows %s, since store paths are public regardless of the profile", (target) => {
    expect(classifyPath(target, config)).toBe("allow");
  });
});

describe("gitignore layer", () => {
  test("denies an ignored file", () => {
    expect(verdict("local.conf")).toBe("deny");
  });

  test("denies a file inside an ignored directory", () => {
    expect(verdict("private-notes/note.md")).toBe("deny");
  });

  test("allows an ignored artefact directory on the allowlist", () => {
    expect(verdict("node_modules/pkg/index.js")).toBe("allow");
    expect(verdict("build/out.txt")).toBe("allow");
  });

  test("allows metadata and artefacts nested below an ignored parent", () => {
    expect(verdict(".opencode/.gitignore")).toBe("allow");
    expect(verdict(".opencode/node_modules/pkg/index.js")).toBe("allow");
  });

  test("still denies ordinary content below the ignored parent", () => {
    expect(verdict(".opencode/private.md")).toBe("deny");
  });

  test("still denies a secret inside an allowlisted artefact directory", () => {
    expect(verdict("node_modules/pkg/.env")).toBe("deny");
    expect(verdict(".opencode/node_modules/pkg/.env")).toBe("deny");
  });

  test("keeps ignored directories listable at every depth", () => {
    expect(verdict("private-notes")).toBe("allow");
    expect(verdict("private-notes/nested")).toBe("allow");
  });

  test("listable directories do not make their contents readable", () => {
    expect(verdict("private-notes/nested/deep.md")).toBe("deny");
  });
});

describe("roots", () => {
  test("an exempt root overrides every deny above it", () => {
    expect(verdict("vault/memory/index.md")).toBe("allow");
    expect(verdict("vault/memory/.env")).toBe("allow");
  });

  test("a deny root hides everything else under it", () => {
    expect(verdict("vault/private/journal.md")).toBe("deny");
  });

  test("the exempt root is carved out of the enclosing deny root", () => {
    expect(verdict("vault")).toBe("deny");
    expect(verdict("vault/memory")).toBe("allow");
  });
});

describe("path resolution", () => {
  test("follows a symlink to its canonical target", () => {
    expect(verdict("link-to-env")).toBe("deny");
  });

  test("resolves .. before matching", () => {
    expect(verdict("docs/../.env")).toBe("deny");
  });

  test("allows a path with no enclosing repository", () => {
    expect(classifyPath(path.join(os.tmpdir(), "no-repo-here.txt"), config)).toBe("allow");
  });
});

describe("gitignoreRules", () => {
  test("collapses ignored directories and skips the artefact allowlist", () => {
    const rules = gitignoreRules(config.tools.git, repo, config.artifactAllowlist);
    // Compare repo-relative paths: the absolute prefix may itself contain a
    // name such as "build" (nix builds under /nix/var/nix/builds).
    const relative = [...rules.subpaths, ...rules.literals].map((p) => path.relative(repo, p));
    expect(relative).toContain("private-notes");
    expect(relative).toContain("local.conf");
    expect(relative).toContain("mixed-ignored/private.md");
    expect(relative).not.toContain("mixed-ignored/tracked.md");
    expect(relative).not.toContain(".gitignore");
    expect(relative).not.toContain("node_modules");
    expect(relative).not.toContain("dist");
    expect(relative).not.toContain("build");
  });

  test("collects the directories inside a collapsed ignored tree", () => {
    const rules = gitignoreRules(config.tools.git, repo, config.artifactAllowlist);
    const relative = rules.directories.map((p: string) => path.relative(repo, p));
    expect(relative).toContain("private-notes/nested");
    // Already re-allowed wholesale by the artefact rule, so walking into it
    // would only inflate the profile.
    expect(relative).not.toContain("private-notes/nested/node_modules");
  });

  test("stops collecting directories at the limit", () => {
    const rules = gitignoreRules(config.tools.git, repo, config.artifactAllowlist, 1);
    expect(rules.directories).toHaveLength(1);
    expect(rules.subpaths.length).toBeGreaterThan(0);
  });
});

describe("classifyPaths", () => {
  // The batch path exists purely for speed: one `git check-ignore` per
  // repository instead of one per result. Any divergence from the audited
  // single-path predicate would be a silent hole, so assert equality directly.
  test("agrees with classifyPath for every fixture path", () => {
    const relatives = [
      ".env",
      ".env.example",
      "README.md",
      "local.conf",
      "private-notes/note.md",
      "private-notes/nested",
      "private-notes/nested/deep.md",
      "node_modules/pkg/index.js",
      "node_modules/pkg/.env",
      ".opencode/private.md",
      ".opencode/.gitignore",
      "mixed-ignored/tracked.md",
      "mixed-ignored/private.md",
      "vault/memory/index.md",
      "vault/private/journal.md",
      "docs/secret-rotation.md",
    ];
    const targets = relatives.map((relative) => path.join(repo, relative));

    const batch = classifyPaths(targets, config);

    for (const target of targets) {
      expect(batch.get(target)).toBe(classifyPath(target, config));
    }
  });

  test("classifies paths spread across repositories and outside any repository", () => {
    const outside = path.join(os.tmpdir(), "secret-guard-no-repo.txt");
    const verdicts = classifyPaths([path.join(repo, "local.conf"), outside], config);

    expect(verdicts.get(path.join(repo, "local.conf"))).toBe("deny");
    expect(verdicts.get(outside)).toBe("allow");
  });

  test("returns a verdict for every requested path", () => {
    const targets = [path.join(repo, "README.md"), path.join(repo, "missing.md")];
    expect([...classifyPaths(targets, config).keys()].sort()).toEqual([...targets].sort());
  });
});

describe("findRepoRoot", () => {
  test("finds the root from a nested directory", () => {
    expect(findRepoRoot(path.join(repo, "docs"))).toBe(repo);
  });

  test("finds the root from a file path", () => {
    expect(findRepoRoot(path.join(repo, "docs/secret-rotation.md"))).toBe(repo);
  });

  test("treats a .git file as a root, so worktrees and submodules resolve", () => {
    const worktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-guard-wt-")));
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${repo}/.git/worktrees/wt\n`);
    fs.mkdirSync(path.join(worktree, "src"));

    expect(findRepoRoot(path.join(worktree, "src"))).toBe(worktree);

    fs.rmSync(worktree, { recursive: true, force: true });
  });

  test("returns null when there is no enclosing repository", () => {
    const orphan = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-guard-orphan-")));
    // /tmp itself is not a repository, so the walk must reach the root and stop.
    expect(findRepoRoot(orphan)).toBeNull();
    fs.rmSync(orphan, { recursive: true, force: true });
  });
});

describe("shell resolver protocol", () => {
  const quiet = () => ({ ...config, secretEnvironment: [], secretEnvironmentPatterns: [] });

  test("returns the profile path, then the hint, then one name to scrub per line", () => {
    const payload: string = resolveForShell("echo hi", {
      ...quiet(),
      secretEnvironment: ["CONTEXT7_API_KEY", "HOMEASSISTANT_TOKEN"],
    });
    const lines = payload.split("\n");

    expect(lines[0]).toMatch(/\.sb$/);
    expect(fs.existsSync(lines[0])).toBe(true);
    expect(lines[1]).toBe("");
    expect(lines.slice(2)).toEqual(["CONTEXT7_API_KEY", "HOMEASSISTANT_TOKEN"]);
  });

  test("emits the profile path and an empty hint when nothing needs scrubbing", () => {
    expect(resolveForShell("echo hi", quiet()).split("\n")).toEqual([
      expect.stringMatching(/\.sb$/),
      "",
    ]);
  });

  test("explains a strict fallback on one line, naming the group that was lost", () => {
    const lines = resolveForShell("kubectl get pods && cat ~/.kube/config", quiet()).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^secret-guard: this command ran under the strict profile because/);
    expect(lines[1]).toContain("`kube`");
    expect(lines[1]).toContain("`cat ~/.kube/config`");
  });

  test("stays silent about strict commands that never named a credential binary", () => {
    expect(resolveForShell("cat README.md", quiet()).split("\n")[1]).toBe("");
  });

  test("refuses to plan a credential-printing command at all", () => {
    // No profile would make `gh auth token` safe: its output is the secret.
    expect(() => resolveForShell("gh auth token", quiet())).toThrow(/refusing to run `gh auth token`/);
    expect(() => resolveForShell("echo $(aws eks get-token)", quiet())).toThrow(/aws eks get-token/);
  });

  test("the shipped default refuses the usual token printers and nothing routine", () => {
    for (const command of ["gh auth token", "aws eks get-token", "kubectl config view --raw", "kubectl get secret x -o yaml", "security find-generic-password -w -s x"]) {
      expect(() => resolveForShell(command, quiet())).toThrow(/refusing/);
    }
    for (const command of ["gh pr list", "aws sts get-caller-identity", "kubectl config view", "kubectl get secrets", "git status"]) {
      expect(() => resolveForShell(command, quiet())).not.toThrow();
    }
  });

  test("the wrapper's expected location is a sibling of this module", () => {
    expect(expectedShell("/opt/secret-guard/lib")).toBe(
      "/opt/secret-guard/bin/opencode-secret-guard",
    );
  });
});

describe("scrubbedEnvironment", () => {
  const environment = {
    PATH: "/usr/bin",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    GITHUB_TOKEN: "t",
    AWS_SECRET_ACCESS_KEY: "k",
    AWS_ACCESS_KEY_ID: "i",
    ZPLUG_SUDO_PASSWORD: "p",
    MY_API_KEY: "a",
    TOKENIZER: "not a token",
    EXPLICIT: "named in the policy",
  };
  const withDefaults = () => ({ ...config, secretEnvironment: ["EXPLICIT"] });

  test("names every inherited variable matching a pattern plus the explicit list", () => {
    expect(scrubbedEnvironment(withDefaults(), null, environment)).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "EXPLICIT",
      "GITHUB_TOKEN",
      "MY_API_KEY",
      "ZPLUG_SUDO_PASSWORD",
    ]);
  });

  test("leaves paths and near-misses alone", () => {
    const scrubbed = scrubbedEnvironment(withDefaults(), null, environment);
    // An agent socket path is not a secret, and losing it breaks every git push.
    expect(scrubbed).not.toContain("SSH_AUTH_SOCK");
    expect(scrubbed).not.toContain("TOKENIZER");
    expect(scrubbed).not.toContain("PATH");
  });

  test("never scrubs the guard's own variables, whose names merely contain SECRET", () => {
    const own = { SECRET_GUARD_BUN: "/bin/bun", OPENCODE_SECRET_GUARD_CONFIG: "/p.json", X_SECRET: "s" };
    expect(scrubbedEnvironment(withDefaults(), null, own)).toEqual(["EXPLICIT", "X_SECRET"]);
  });

  test("a group keeps what its binaries need and nothing else", () => {
    const aws = scrubbedEnvironment(withDefaults(), "aws", environment);
    expect(aws).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(aws).not.toContain("AWS_ACCESS_KEY_ID");
    expect(aws).toContain("GITHUB_TOKEN");

    const ssh = scrubbedEnvironment(withDefaults(), "ssh", environment);
    expect(ssh).not.toContain("GITHUB_TOKEN");
    expect(ssh).toContain("AWS_SECRET_ACCESS_KEY");
  });

  test("the explicit list is scrubbed even where a group would keep it", () => {
    const named = { ...config, secretEnvironment: ["GITHUB_TOKEN"], secretEnvironmentPatterns: [] };
    // allowEnvironment only re-admits pattern hits: an explicitly named
    // variable is the user saying "never", and the group must not override it.
    expect(scrubbedEnvironment(named, "ssh", environment)).toEqual(["GITHUB_TOKEN"]);
  });
});

describe("buildProfile", () => {
  const tamper = {
    literals: ["/Users/test/.config/opencode/opencode.json"],
    subpaths: ["/Users/test/.config/opencode/plugins", "/opt/homebrew/bin"],
  };
  const profile = (group: string | null) =>
    buildProfile({
      config,
      home: "/Users/test",
      group,
      gitignore: {
        repoRoot: repo,
        subpaths: [path.join(repo, "private-notes")],
        literals: [path.join(repo, "local.conf")],
        directories: [path.join(repo, "private-notes/nested")],
      },
      tamper,
    });

  test("starts permissive and denies selectively", () => {
    const text = profile(null);
    expect(text.startsWith("(version 1)\n(allow default)")).toBe(true);
    expect(text).toContain('(deny file-read-data file-write* (regex #"/\\.env$"');
  });

  test("denies data reads but not metadata, so ls keeps working", () => {
    expect(profile(null)).not.toContain("(deny file-read* ");
  });

  test("denies gitignored paths for reads only", () => {
    const text = profile(null);
    const line = text.split("\n").find((l) => l.startsWith("(deny file-read-data (regex #\"^"));
    expect(line).toBeDefined();
    expect(line).not.toContain("file-write*");
  });

  test("re-allows artefacts after gitignore and reapplies secret patterns", () => {
    const text = profile(null);
    const gitignore = text.indexOf(";; 1. .gitignore");
    const artefacts = text.indexOf("artefact allowlist");
    const secrets = text.lastIndexOf("secret patterns");
    expect(gitignore).toBeGreaterThan(-1);
    expect(artefacts).toBeGreaterThan(gitignore);
    expect(secrets).toBeGreaterThan(artefacts);
    expect(text).toContain("(allow file-read-data (regex");
    expect(text).toContain(`^${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`);
  });

  test("omits the relaxation block under the strict profile", () => {
    expect(profile(null)).not.toContain("relaxation");
  });

  test("re-allows sub-directories of ignored trees so readdir keeps working", () => {
    const text = profile(null);
    const line = text
      .split("\n")
      .find((l: string) => l.startsWith("(allow file-read-data (literal"));
    expect(line).toContain(path.join(repo, "private-notes/nested"));
  });

  test("orders the directory allow after the ignore deny and before secrets", () => {
    const text = profile(null);
    const ignore = text.indexOf(";; 1. .gitignore");
    const directories = text.indexOf("stay enumerable");
    const secrets = text.lastIndexOf("secret patterns");
    expect(directories).toBeGreaterThan(ignore);
    expect(secrets).toBeGreaterThan(directories);
  });

  test("emits the relaxation block for a group", () => {
    const text = profile("kube");
    expect(text).toContain('relaxation for the "kube" group');
    expect(text).toContain("/Users/test/.kube");
  });

  test("allows Git to access signing keys", () => {
    expect(profile("ssh")).toContain("/Users/test/.gnupg");
  });

  test("orders exceptions after denies so the last rule wins", () => {
    const text = profile(null);
    expect(text.indexOf("(deny file-read-data file-write* (regex")).toBeLessThan(
      text.indexOf("(allow file-read-data file-write* (regex"),
    );
  });

  test("orders exempt roots last", () => {
    const text = profile(null);
    const exempt = text.lastIndexOf("fully exempt");
    expect(exempt).toBeGreaterThan(text.indexOf("exceptions"));
    expect(text.slice(exempt)).toContain(path.join(repo, "vault/memory"));
  });

  test("prevents commands from replacing cached profiles", () => {
    expect(profile(null)).toContain("generated guard profiles are never writable");
    expect(profile(null)).toContain("(deny file-write* (subpath");
  });

  test("makes directory nodes carrying a protected name unrenameable", () => {
    // `/\.kube/` never matches `~/.kube` itself, so the node needs its own rule,
    // emitted before the relaxation so the kube group may still rename it.
    const text = profile(null);
    const nodes = text.indexOf(";; 5.");
    expect(nodes).toBeGreaterThan(text.indexOf(";; 4. secret"));
    expect(nodes).toBeLessThan(text.indexOf(";; 7. exceptions"));
    const line = text.split("\n")[text.split("\n").findIndex((l) => l.startsWith(";; 5.")) + 1]!;
    expect(line.startsWith("(deny file-write* ")).toBe(true);
    expect(line).toContain('#"/\\.kube$"');
    expect(line).toContain('#"/secrets$"');
    expect(line).not.toContain("file-read-data");
  });

  test("protects the ancestors a credential path leads through", () => {
    // `mv ~/.config ~/c2` would leave ~/.config/gcloud under an unmatched name.
    const text = profile(null);
    expect(text).toContain('(literal "/Users/test/.config")');
    expect(text).toContain('(literal "/Users/test/.config/gcloud")');
    expect(text).not.toContain('(literal "/Users/test")');
  });

  test("denies writes to what OpenCode loads at startup, after every exemption", () => {
    const text = profile(null);
    const tamperStep = text.indexOf(";; 11.");
    expect(tamperStep).toBeGreaterThan(text.lastIndexOf("fully exempt"));
    expect(tamperStep).toBeGreaterThan(text.indexOf(";; 10."));
    const block = text.slice(tamperStep);
    expect(block).toContain('(deny file-write* (literal "/Users/test/.config/opencode/opencode.json")');
    expect(block).toContain('(subpath "/opt/homebrew/bin")');
    expect(block).not.toContain("file-read-data");
  });
});

describe("filterSearchOutput", () => {
  test("drops a relative grep result group for a secret while retaining public hits", () => {
    const output = [
      ".env:",
      "  Line 1: TOKEN=live",
      "",
      "README.md:",
      "  Line 1: TOKEN is documented here",
    ].join("\n");

    const filtered = filterSearchOutput("grep", output, { path: repo }, config);
    expect(filtered).not.toContain("TOKEN=live");
    expect(filtered).toContain("README.md");
    expect(filtered).toContain("TOKEN is documented here");
  });

  test("keeps unclassifiable output rather than silently losing external results", () => {
    expect(filterSearchOutput("grep", "summary only", { path: repo }, config)).toBe("summary only");
  });
});

describe("plugin hooks", () => {
  test("leave bash commands unchanged for the configured shell to enforce", async () => {
    const args = { command: "cat .env" };
    const hooks = createHooks(config);

    await hooks["tool.execute.before"]({ tool: "bash" }, { args });

    expect(args.command).toBe("cat .env");
  });

  test("reject a credential-printing command before it runs", async () => {
    const hooks = createHooks(config);

    await expect(
      hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "gh pr list && gh auth token" } }),
    ).rejects.toThrow(/refusing to run `gh auth token`/);
    await expect(
      hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "gh pr list" } }),
    ).resolves.toBeUndefined();
  });

  test("reject it in files-only mode too, where no shell wrapper backs the plugin", async () => {
    const hooks = createHooks({ ...config, mode: "files-only" }, path.join(repo, "package", "lib"));

    await expect(
      hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "aws eks get-token" } }),
    ).rejects.toThrow(/refusing/);
  });

  test("rejects a shell that is not this package's wrapper", async () => {
    const hooks = createHooks(config, path.join(repo, "package", "lib"));

    await expect(hooks.config({ shell: "/bin/zsh" })).rejects.toThrow("must be");
  });

  test("rejects an unset shell rather than running unguarded", async () => {
    const hooks = createHooks(config, path.join(repo, "package", "lib"));

    await expect(hooks.config({})).rejects.toThrow("unset");
  });

  test("accepts this package's own wrapper", async () => {
    const packageRoot = path.join(repo, "package");
    const hooks = createHooks(config, path.join(packageRoot, "lib"));

    await expect(
      hooks.config({ shell: path.join(packageRoot, "bin", "opencode-secret-guard") }),
    ).resolves.toBeUndefined();
  });

  test("accepts a symlink to this package's wrapper", async () => {
    // Home Manager installs the shell through a profile symlink, and a
    // store-path pattern would have to know about that; realpaths do not.
    const packageRoot = path.join(repo, "package");
    const wrapper = path.join(packageRoot, "bin", "opencode-secret-guard");
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, "#!/bin/sh\n");
    const link = path.join(repo, "profile-opencode-secret-guard");
    fs.symlinkSync(wrapper, link);
    const hooks = createHooks(config, path.join(packageRoot, "lib"));

    await expect(hooks.config({ shell: link })).resolves.toBeUndefined();
  });

  test("rejects an identically named wrapper from another installation", async () => {
    const hooks = createHooks(config, path.join(repo, "package", "lib"));

    await expect(
      hooks.config({ shell: path.join(repo, "other", "bin", "opencode-secret-guard") }),
    ).rejects.toThrow("must be");
  });

  test("filters search output against the requested path", async () => {
    const hooks = createHooks(config);
    const output = {
      output: [".env:", "  Line 1: TOKEN=live", "", "README.md:", "  Line 1: public"].join(
        "\n",
      ),
    };

    await hooks["tool.execute.before"](
      { tool: "grep", callID: "search-1" },
      { args: { path: repo } },
    );
    await hooks["tool.execute.after"]({ tool: "grep", callID: "search-1" }, output);

    expect(output.output).not.toContain("TOKEN=live");
    expect(output.output).toContain("README.md");
  });
});
