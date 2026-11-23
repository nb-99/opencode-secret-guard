/**
 * What the guard plans for one shell command: the sandbox command, the
 * environment to scrub and the hint to print. A fake backend stands in for the
 * host's, so these run on every host; what a kernel enforces is tested by
 * sandbox.test.sh.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CommandAnalysis } from "../src/command-policy.ts";
import { loadConfig, opencodeConfigDirectory } from "../src/policy.ts";
import { encodeHint, expectedShell, failureHint, resolveForShell, scrubbedEnvironment } from "../src/shell.ts";
import { fakeBackend, NO_SANDBOX, stubHostSandbox } from "./support.ts";

const policyPath = process.env.OPENCODE_SECRET_GUARD_CONFIG;
if (!policyPath) throw new Error("OPENCODE_SECRET_GUARD_CONFIG must be set");
const config = loadConfig(policyPath);
const host = stubHostSandbox();

describe("shell resolver protocol", () => {
  const quiet = () => ({ ...config, secretEnvironment: [], secretEnvironmentPatterns: [] });
  const sandbox = ["/fake/sandbox", "--group=-", "/bin/sh", "-c"];

  test("returns the sandbox command's length and words, then the hint, then one name to scrub per line", () => {
    const payload: string = resolveForShell("echo hi", {
      ...quiet(),
      secretEnvironment: ["CONTEXT7_API_KEY", "HOMEASSISTANT_TOKEN"],
    });

    expect(payload.split("\n")).toEqual(["4", ...sandbox, "", "CONTEXT7_API_KEY", "HOMEASSISTANT_TOKEN"]);
  });

  test("emits the sandbox command and an empty hint when nothing needs scrubbing", () => {
    expect(resolveForShell("echo hi", quiet()).split("\n")).toEqual(["4", ...sandbox, ""]);
  });

  test("hands the backend the group the command resolved to", () => {
    const backend = fakeBackend();
    const lines = host.during({ backend }, () => resolveForShell("kubectl get pods", quiet()).split("\n"));
    expect(lines[2]).toBe("--group=kube");
    expect(backend.shellConfinements).toHaveLength(1);
    expect(backend.shellConfinements[0]!.cwd).toBe(process.cwd());
  });

  test("a newline in a protected path cannot become a scrub entry", () => {
    const target = path.join(opencodeConfigDirectory(), "plugins/a\nb");
    const lines = resolveForShell(`touch '${target}'`, {
      ...quiet(), secretEnvironment: ["TEST_TOKEN"],
    }).split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[5]).toContain("plugins/a b");
    expect(lines.slice(6)).toEqual(["TEST_TOKEN"]);
  });

  test.each([
    ["no words", []],
    ["an empty word", ["/fake/sandbox", ""]],
    ["a word with a newline", ["/fake/sandbox", "a\nb"]],
    ["too many words", Array(100).fill("/fake/sandbox")],
    ["a relative executable", ["sandbox", "-c"]],
    ["an executable env would take as an assignment", ["/fake/a=b/sandbox", "-c"]],
  ])("refuses a sandbox command with %s, which the wrapper could not read back", (_, words) => {
    const backend = { ...fakeBackend(), shellCommand: () => words as string[] };
    expect(() => host.during({ backend }, () => resolveForShell("echo hi", quiet()))).toThrow(/one word per line/);
  });

  test("refuses an inherited secret whose name the protocol would split", () => {
    const name = "A\nX_TOKEN";
    process.env[name] = "leak";
    try {
      expect(() => resolveForShell("echo hi", config)).toThrow(/cannot be removed from the environment/);
    } finally {
      delete process.env[name];
    }
  });

  test("refuses to plan a shell+files command on a host without a shell sandbox", () => {
    expect(() => host.during(NO_SANDBOX, () => resolveForShell("echo hi", quiet()))).toThrow(
      /needs a shell sandbox.*fake-sandbox is unavailable/,
    );
  });

  test("files-only refuses to act as the configured shell", () => {
    // The wrapper exists only to enforce the shell layer; running a command
    // under no sandbox would be worse than refusing.
    expect(() => resolveForShell("echo hi", { ...config, mode: "files-only" })).toThrow(
      /must not be configured as opencode's shell/,
    );
  });

  test("explains a strict fallback on one line, naming the group that was lost", () => {
    const lines = resolveForShell("kubectl get pods && cat ~/.kube/config", quiet()).split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[5]).toMatch(/^\?secret-guard: if this failed on a permission error/);
    expect(lines[5]).toContain("`kube`");
    expect(lines[5]).toContain("`cat ~/.kube/config`");
  });

  test("stays silent about strict commands that never named a credential binary", () => {
    expect(resolveForShell("cat README.md", quiet()).split("\n")[5]).toBe("");
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

describe("failureHint", () => {
  const tamper = {
    literals: ["/Users/test/.config/opencode/opencode.json", "/Users/test/.zshenv"],
    subpaths: ["/Users/test/.config/opencode/plugins", "/opt/homebrew/bin"],
  };
  const quiet: CommandAnalysis = { group: "ssh", reason: null, candidates: ["ssh"], refusal: null };
  const full = (command: string, scrub: string[] = [], analysis: CommandAnalysis = quiet, backend = fakeBackend()) =>
    failureHint({ analysis, command, tamper, scrub, home: "/Users/test", cwd: "/Users/test/repo", backend });
  const hint = (command: string, scrub: string[] = [], analysis: CommandAnalysis = quiet) =>
    full(command, scrub, analysis).text;

  test("says nothing about an ordinary failure", () => {
    expect(hint("git push origin HEAD")).toBe("");
    expect(hint("cat README.md")).toBe("");
  });

  test("the strict reason wins, because it explains the denial the command hit first", () => {
    const strict: CommandAnalysis = {
      group: null,
      reason: "`npm test` belongs to no credential group",
      candidates: ["ssh"],
      refusal: null,
    };
    expect(hint("git status && npm test", ["GITHUB_TOKEN"], strict)).toContain("strict profile");
  });

  test("a possible setuid exec denial outranks the strict reason", () => {
    const strict: CommandAnalysis = {
      group: null,
      reason: "`sudo` belongs to no credential group",
      candidates: ["ssh"],
      refusal: null,
    };
    expect(hint("ps aux | rg node")).toContain("system `ps`, that binary is setuid");
    expect(hint("ps aux")).toContain("pgrep");
    expect(hint("git log && sudo tee /etc/hosts", [], strict)).toContain("system `sudo`, that binary is setuid");
    expect(hint("git log --format=%h")).toBe("");
    expect(hint("ping -c 1 unreachable.invalid")).toBe("");
    expect(hint("false && ps aux")).toContain("if this failed while executing");
    expect(hint("ps aux")).toContain("fake-sandbox refuses to execute it");
  });

  test("leaves setuid binaries alone under a backend that runs them", () => {
    expect(full("ps aux", [], quiet, fakeBackend({ blocksSetuid: false })).text).toBe("");
  });

  test("only the setuid hint survives a 127 exit, without asserting a cause", () => {
    // zsh reports both a missing binary and a binary it may not execute as
    // 127, so the marker, not the status, decides which line the wrapper
    // prints. `!` survives it; `?` does not.
    expect(full("ps aux").showOn127).toBe(true);
    expect(encodeHint(full("ps aux")).startsWith("!")).toBe(true);
    expect(full("brew install jq").showOn127).toBe(false);
    expect(encodeHint(full("brew install jq")).startsWith("?")).toBe(true);
    expect(encodeHint(full("git push origin HEAD"))).toBe("");
  });

  test("every hint is worded as a condition, not a cause", () => {
    const strict: CommandAnalysis = {
      group: null,
      reason: "`make` belongs to no credential group",
      candidates: ["ssh"],
      refusal: null,
    };
    // The wrapper sees an exit status, not what failed.
    expect(hint("ps aux")).toContain("if this failed");
    expect(hint("git status && make", [], strict)).toContain("if this failed");
    expect(hint("printf x > ~/.zshenv")).toContain("if this failed");
    expect(hint("brew install jq")).toContain("if this failed");
    expect(hint("echo $GH_TOKEN", ["GH_TOKEN"])).toContain("if this failed");
  });

  test("names the protected path a write was denied on, however it was spelled", () => {
    expect(hint("printf x > ~/.zshenv")).toContain("~/.zshenv");
    // Taken as written, because a protected directory's entry may be a symlink
    // whose destination is not protected — the guard denies at the link.
    expect(hint("echo {} > /opt/homebrew/bin/git")).toContain("/opt/homebrew/bin/git");
    // Relative to the working directory, and through a protected parent.
    expect(hint("cp evil.ts ../.config/opencode/plugins/evil.ts")).toContain("plugins/evil.ts");
    expect(hint("printf x > ~/notes.md")).toBe("");
  });

  test("names a protected path reached through a symlinked parent", () => {
    // The other direction: the word itself is unremarkable and only resolving
    // it lands inside a target. Both spellings have to be tested.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-hint-"));
    const plugins = path.join(root, "config", "opencode", "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    const link = path.join(root, "shortcut");
    fs.symlinkSync(plugins, link);
    const targets = { literals: [], subpaths: [fs.realpathSync(plugins)] };

    const text = failureHint({
      analysis: quiet,
      command: `cp evil.ts ${link}/evil.ts`,
      tamper: targets,
      scrub: [],
      home: root,
      cwd: root,
      backend: fakeBackend(),
    }).text;

    expect(text).toContain("shortcut/evil.ts");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("names an installer that writes a PATH directory it never spells out", () => {
    expect(hint("brew install jq")).toContain("`brew install`");
    expect(hint("npm i -g @openai/codex")).toContain("`npm -g`");
    expect(hint("cargo install ripgrep")).toContain("`cargo install`");
    expect(hint("npm ci")).toBe("");
    expect(hint("go test ./...")).toBe("");
  });

  test("names a scrubbed variable the command asked for, and stays quiet otherwise", () => {
    expect(hint('curl -H "Authorization: Bearer $GH_TOKEN" https://api', ["GH_TOKEN"]))
      .toContain("GH_TOKEN");
    expect(hint("echo ${GH_TOKEN}", ["GH_TOKEN"])).toContain("GH_TOKEN");
    expect(hint("curl https://api", ["GH_TOKEN"])).toBe("");
  });

  test("is a single line, so the wrapper's payload stays unambiguous", () => {
    for (const command of ["printf x > ~/.zshenv", "brew install jq", "echo $GH_TOKEN"]) {
      expect(hint(command, ["GH_TOKEN"])).not.toContain("\n");
    }
  });
});
