import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalName, checkToolCall, hostDirectory, patchPaths } from "../src/guard.ts";
import { loadConfig } from "../src/policy.ts";
import type { GuardConfig } from "../src/policy.ts";
import { resolveTarget } from "../src/predicate.ts";
import { hasAliasLookup, inspectPath } from "../src/paths.ts";

const policyPath = process.env.OPENCODE_SECRET_GUARD_CONFIG;
if (!policyPath) throw new Error("OPENCODE_SECRET_GUARD_CONFIG must be set");

let fixture: string;
let repo: string;
let config: GuardConfig;

/**
 * Secrets in this fixture are named by a gitignore rule, not by the policy's
 * name patterns, so they are denied only when a path resolves inside `repo`.
 * `.env` and `id_rsa` are denied wherever they are and would prove nothing
 * about where a relative path resolves.
 */
beforeAll(() => {
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-guard-guard-")));
  repo = path.join(fixture, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  for (const file of [".env", "id_rsa", "README.md", "opencode.json", "src/index.ts", "private.txt", "my secret.txt", "don't.txt", "plain name.txt"]) {
    fs.writeFileSync(path.join(repo, file), "x\n");
  }
  // A directory literally named "~": V1 opens it for a path like ~/notes.txt,
  // where V2 opens the home directory's file.
  fs.mkdirSync(path.join(repo, "~"));
  fs.writeFileSync(path.join(repo, "~", "notes.txt"), "x\n");
  fs.symlinkSync(path.join(repo, ".env"), path.join(repo, "link-to-env"));
  fs.writeFileSync(path.join(repo, ".gitignore"), "private.txt\nmy secret.txt\ndon't.txt\n/~/\n");
  config = loadConfig(policyPath);
  spawnSync(config.tools.git, ["init", "-q", repo]);
});

afterAll(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

const check = (tool: string, args: unknown) => checkToolCall(tool, args, config, repo);

describe("resolveTarget", () => {
  test("expands ~ and resolves relative paths against the given directory", () => {
    expect(resolveTarget("~", "/w")).toBe(os.homedir());
    expect(resolveTarget("~/a/b", "/w")).toBe(path.join(os.homedir(), "a", "b"));
    expect(resolveTarget("a/../b", "/w")).toBe("/w/b");
    expect(resolveTarget("/abs/x", "/w")).toBe("/abs/x");
  });

  test("leaves ~user alone, as OpenCode's tools do", () => {
    expect(resolveTarget("~user/a", "/w")).toBe("/w/~user/a");
  });
});

describe("hostDirectory", () => {
  test("accepts an absolute path", () => {
    expect(hostDirectory("/work/project")).toBe("/work/project");
  });

  test("returns undefined and says so for anything else", () => {
    for (const value of ["relative/dir", "", undefined, null, 3, {}]) {
      const written: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      (process.stderr as any).write = (chunk: unknown) => (written.push(String(chunk)), true);
      try {
        expect(hostDirectory(value)).toBeUndefined();
      } finally {
        (process.stderr as any).write = original;
      }
      expect(written.join("")).toMatch(/did not provide an absolute project directory/);
    }
  });
});

describe("without a project directory", () => {
  const bare = (tool: string, args: unknown) => checkToolCall(tool, args, config, undefined);

  test("refuses a relative path, because it cannot be placed", () => {
    expect(() => bare("read", { path: "README.md" })).toThrow(/no project directory/);
    expect(() => bare("write", { path: "src/index.ts" })).toThrow(/no project directory/);
    expect(() => bare("patch", { patchText: "*** Update File: src/index.ts" })).toThrow(/no project directory/);
  });

  test("still classifies an absolute path, and a ~ path", () => {
    expect(() => bare("read", { path: path.join(repo, ".env") })).toThrow("blocked");
    expect(() => bare("read", { path: path.join(repo, "README.md") })).not.toThrow();
    expect(() => bare("read", { path: "~/.ssh/id_rsa" })).toThrow("blocked");
  });
});

describe("patchPaths", () => {
  test("names every path a patch adds, updates, deletes or moves to", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+*** Update File: not-a-header.txt",
      "*** Update File: .env",
      "*** Move to: moved/.env",
      "@@",
      "-a",
      "+b",
      "*** Delete File: id_rsa",
      "  *** Update File:   indented.txt \r",
      "*** End Patch",
    ].join("\n");

    expect(patchPaths(patch)).toEqual(["new.txt", ".env", "moved/.env", "id_rsa", "indented.txt"]);
  });

  test("keeps a path that holds a character a regex `.` would not match", () => {
    // Both hosts' parsers split on \\n only, so these are all part of the path.
    for (const separator of ["\u2028", "\u2029", "\r", "\v", "\f", "\u0085"]) {
      const target = `a${separator}/../.env`;
      expect(patchPaths(`*** Begin Patch\n*** Add File: ${target}\n*** End Patch`)).toEqual([target]);
    }
  });

  test("finds headers inside a heredoc wrapper", () => {
    const patch = "cat <<'EOF'\n*** Begin Patch\n*** Update File: .env\n*** End Patch\nEOF";
    expect(patchPaths(patch)).toEqual([".env"]);
  });

  test("names nothing for text with no headers", () => {
    expect(patchPaths("hello\n*** Begin Patch\n*** End Patch")).toEqual([]);
  });
});

describe("patch tools", () => {
  const patch = (...headers: string[]) => ({
    patchText: ["*** Begin Patch", ...headers, "*** End Patch"].join("\n"),
  });

  test.each(["patch", "apply_patch"])("%s is refused when any header names a secret", (tool) => {
    for (const header of [
      "*** Update File: .env",
      "*** Add File: id_rsa",
      "*** Delete File: .env",
      "*** Update File: README.md\n*** Move to: .env",
    ]) {
      expect(() => check(tool, patch(header))).toThrow(/write access to .* is blocked/);
    }
  });

  test.each(["patch", "apply_patch"])("%s cannot hide a path behind a line separator", (tool) => {
    // path.resolve(repo, "a\\u2028/../.env") is <repo>/.env, and the host's
    // parser accepts the header as written.
    for (const separator of ["\u2028", "\u2029", "\r"]) {
      expect(() => check(tool, patch(`*** Add File: a${separator}/../.env`))).toThrow(/is blocked/);
    }
  });

  test.each(["patch", "apply_patch"])("%s is refused on a path that is part of the guard", (tool) => {
    expect(() => check(tool, patch("*** Update File: opencode.json"))).toThrow(/part of the guard/);
  });

  test.each(["patch", "apply_patch"])("%s may edit ordinary files", (tool) => {
    expect(() => check(tool, patch("*** Update File: src/index.ts", "*** Add File: src/new.ts"))).not.toThrow();
  });

  test("the whole patch is refused when only one file is protected", () => {
    expect(() => check("patch", patch("*** Update File: src/index.ts", "*** Delete File: .env"))).toThrow(".env");
  });

  test("a patch that names no path is refused rather than allowed", () => {
    expect(() => check("patch", {})).toThrow(/named no path/);
    expect(() => check("apply_patch", { patchText: "*** Begin Patch\n*** End Patch" })).toThrow(/named no path/);
  });
});

describe("file tools", () => {
  test.each([
    ["read", { filePath: ".env" }],
    ["read", { path: ".env" }],
    ["edit", { path: "id_rsa" }],
    ["write", { filePath: "id_rsa" }],
    ["grep", { pattern: "x", path: ".env" }],
    ["READ", { path: ".env" }],
  ])("%s %j is refused", (tool, args) => {
    expect(() => check(tool, args)).toThrow("blocked");
  });

  test("resolves a relative path against the tool's directory, not the process's", () => {
    // private.txt is denied only by the fixture's gitignore, which applies to
    // <repo>/private.txt and to nothing at the same relative path elsewhere.
    expect(() => check("read", { path: "private.txt" })).toThrow("blocked");
    expect(() => checkToolCall("read", { path: "private.txt" }, config, os.tmpdir())).not.toThrow();
  });

  test("expands ~ the way V2's own tools do", () => {
    // A deny root under the home directory is denied at ~/x and nowhere else.
    // The base directory has no ~ folder, so only expansion can deny the path.
    const guarded = { ...config, denyRoots: [path.join(os.homedir(), ".secret-guard-test-deny")] };
    const target = { path: "~/.secret-guard-test-deny/notes.txt" };

    expect(() => checkToolCall("read", target, guarded, fixture)).toThrow("blocked");
    expect(() => checkToolCall("read", target, config, fixture)).not.toThrow();
  });

  test("also checks the literal ~ directory, because V1 opens that one", () => {
    // <repo>/~/ is ignored; the home-directory reading of ~/notes.txt is not.
    expect(() => check("read", { path: "~/notes.txt" })).toThrow("blocked");
    expect(() => check("apply_patch", { patchText: "*** Update File: ~/notes.txt" })).toThrow("blocked");
  });

  test("follows a symlink to a secret", () => {
    expect(() => check("read", { path: "link-to-env" })).toThrow("blocked");
  });

  test("guards V1's lsp tool, which may name no file", () => {
    expect(() => check("lsp", { filePath: ".env" })).toThrow("blocked");
    expect(() => check("lsp", { operation: "workspaceSymbol" })).not.toThrow();
  });

  test("guards V2's browser tools that open a local file", () => {
    for (const tool of ["browser_files_upload", "browser_files_drop"]) {
      expect(() => check(tool, { tabID: "t", ref: "e1", paths: [".env"] })).toThrow("blocked");
      expect(() => check(tool, { tabID: "t", ref: "e1", paths: ["README.md", "link-to-env"] })).toThrow("blocked");
      expect(() => check(tool, { tabID: "t", ref: "e1", paths: ["README.md"] })).not.toThrow();
      expect(() => check(tool, { tabID: "t", ref: "e1", paths: [] })).toThrow(/named no path/);
      expect(() => check(tool, { tabID: "t", ref: "e1", paths: ".env" })).toThrow(/named no path/);
    }
    expect(() => check("browser_preview", { path: "private.txt" })).toThrow("blocked");
    expect(() => check("browser_preview", { path: "README.md" })).not.toThrow();
  });

  test("allows ordinary reads and writes", () => {
    expect(() => check("read", { path: "README.md" })).not.toThrow();
    expect(() => check("write", { path: "src/index.ts" })).not.toThrow();
  });

  test("distinguishes a read from a write on a protected config file", () => {
    expect(() => check("read", { path: "opencode.json" })).not.toThrow();
    expect(() => check("write", { path: "opencode.json" })).toThrow(/part of the guard/);
  });

  test("lets a search default to the working directory", () => {
    expect(() => check("grep", { pattern: "x" })).not.toThrow();
    expect(() => check("glob", { pattern: "*" })).not.toThrow();
  });

  test("ignores tools that are not file tools", () => {
    expect(() => check("webfetch", { path: ".env" })).not.toThrow();
    expect(() => check("webfetch", undefined)).not.toThrow();
    expect(() => check(undefined, { path: ".env" })).not.toThrow();
  });

  test("refuses a file tool whose arguments it cannot read", () => {
    // A host that renamed an argument would otherwise leave every file tool
    // unguarded with no sign of it; the tool would reject the call anyway.
    for (const tool of ["read", "write", "edit"]) {
      expect(() => check(tool, undefined)).toThrow(/cannot read/);
      expect(() => check(tool, "text")).toThrow(/cannot read/);
      expect(() => check(tool, [".env"])).toThrow(/cannot read/);
      expect(() => check(tool, {})).toThrow(/named no path/);
      expect(() => check(tool, { path: 7 })).toThrow(/named no path/);
      expect(() => check(tool, { path: "" })).toThrow(/named no path/);
      expect(() => check(tool, { location: ".env" })).toThrow(/named no path/);
    }
    expect(() => check("grep", undefined)).toThrow(/cannot read/);
  });
});

describe("read of a misspelled name", () => {
  // V2's read opens the one sibling whose name is canonically equal to the
  // missing one, and authorizes only that substitute.
  test.each([
    ["my\u00a0secret.txt", "a no-break space"],
    ["my\u202fsecret.txt", "a narrow no-break space"],
    ["don\u2019t.txt", "a curly apostrophe"],
    ["don\u2018t.txt", "a curly opening quote"],
  ])("%j (%s) is refused when the file it would open is ignored", (requested) => {
    expect(() => check("read", { path: requested })).toThrow("blocked");
  });

  test("compares names as V2 does, including a decomposed accent", () => {
    // Not testable through the file system: APFS matches NFD names to NFC files
    // itself, so the existence check would return early.
    expect(canonicalName("cafe\u0301.txt")).toBe(canonicalName("caf\u00e9.txt"));
    expect(canonicalName("a\u00a0b\u202fc")).toBe("a b c");
    expect(canonicalName("don\u2018t\u2019")).toBe("don't'");
    expect(canonicalName("a b")).not.toBe(canonicalName("a_b"));
  });

  test("an ordinary Unicode fallback requires unambiguous lookup metadata", () => {
    const requested = "plain\u00a0name.txt";
    const read = () => check("read", { path: requested });
    if (hasAliasLookup(inspectPath(path.join(repo, requested)))) expect(read).toThrow("blocked");
    else expect(read).not.toThrow();
  });

  test("is allowed when nothing resembles the missing name", () => {
    expect(() => check("read", { path: "absent.txt" })).not.toThrow();
    expect(() => check("read", { path: "missing-dir/absent.txt" })).not.toThrow();
  });

  test("does not look for substitutes when the file exists", () => {
    expect(() => check("read", { path: "README.md" })).not.toThrow();
  });
});

describe("shell tools", () => {
  test.each(["bash", "shell"])("%s refuses a command whose output is a credential", (tool) => {
    expect(() => check(tool, { command: "gh pr list && gh auth token" })).toThrow(/refusing to run `gh auth token`/);
    expect(() => check(tool, { command: "git status" })).not.toThrow();
  });

  test("leaves a command that names a secret to the configured shell", () => {
    expect(() => check("shell", { command: "cat .env" })).not.toThrow();
  });
});
