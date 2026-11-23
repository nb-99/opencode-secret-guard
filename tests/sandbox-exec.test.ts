/**
 * The macOS backend's output: the SBPL profiles it writes and the commands it
 * names. These read text only, so they run on every host; whether macOS
 * enforces the profile is tested by sandbox.test.sh.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/policy.ts";
import type { GuardConfig } from "../src/policy.ts";
import { buildProfile, SANDBOX_EXEC, sandboxExec } from "../src/sandbox-exec.ts";

const policyPath = process.env.OPENCODE_SECRET_GUARD_CONFIG;
if (!policyPath) throw new Error("OPENCODE_SECRET_GUARD_CONFIG must be set");

let fixture: string;
let repo: string;
let config: GuardConfig;

beforeAll(() => {
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-guard-sbpl-")));
  repo = path.join(fixture, "repo");
  fs.mkdirSync(path.join(repo, "vault", "memory"), { recursive: true });
  // Mirrors production: the exempt memory root is nested inside the denied
  // vault root, so the two rules must be emitted in the right order.
  config = {
    ...loadConfig(policyPath),
    exemptRoots: [path.join(repo, "vault/memory")],
    denyRoots: [path.join(repo, "vault")],
  };
});

afterAll(() => fs.rmSync(fixture, { recursive: true, force: true }));

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
        helmSecretTemplates: [path.join(repo, "templates/postgresql/secret.yaml")],
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

  test("allows only enumerated Helm templates after the secret deny", () => {
    const text = profile(null);
    const allow = text.indexOf("tracked Helm secret templates");
    expect(allow).toBeGreaterThan(text.indexOf(";; 4. secret patterns"));
    expect(text.slice(allow)).toContain(`(literal "${path.join(repo, "templates/postgresql/secret.yaml")}")`);
    expect(text.slice(allow)).not.toContain(`(literal "${path.join(repo, "templates/ignored/secret.yaml")}")`);
    expect(text.slice(allow)).toContain('#"/secrets/"');
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

describe("sandbox-exec backend", () => {
  const tamper = { literals: [], subpaths: [] };

  test("is available only on macOS", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      expect(sandboxExec.probe()).toEqual({ available: false, reason: "needs macOS" });
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  test("runs a shell command through zsh under a cached profile file", () => {
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = path.join(fixture, "cache");
    try {
      const command = sandboxExec.shellCommand({ config, home: fixture, cwd: repo, group: null, tamper });
      expect(command).toEqual([SANDBOX_EXEC, "-f", expect.stringMatching(/\.sb$/), "/bin/zsh", "-c"]);
      expect(command[2]!.startsWith(path.join(fixture, "cache", "opencode-secret-guard") + "/")).toBe(true);
      expect(fs.readFileSync(command[2]!, "utf8").startsWith("(version 1)\n(allow default)")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
    }
  });

  test("passes a deletion profile inline, refusing one too large for the kernel", () => {
    const gitignore = { repoRoot: null, subpaths: [], literals: [], directories: [], helmSecretTemplates: [] };
    const deletion = { config, home: fixture, gitignore, tamper, root: fixture };
    const command = sandboxExec.deletionCommand({ ...deletion, entries: [path.join(fixture, "job")] });
    expect(command.slice(0, 2)).toEqual([SANDBOX_EXEC, "-p"]);
    expect(command).toHaveLength(3);
    expect(command[2]).toContain(";; Cleanup only narrows the base policy");

    const entries = Array.from({ length: 4096 }, (_, i) => path.join(fixture, "job", `${"x".repeat(40)}-${i}`));
    expect(() => sandboxExec.deletionCommand({ ...deletion, entries })).toThrow(/cleanup profile is too large/);
  });
});
