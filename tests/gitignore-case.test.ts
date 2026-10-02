import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isGitIgnored, isPossiblyGitIgnored, possibleIgnoreVerdicts } from "../src/gitignore.ts";
import { classifyPaths } from "../src/predicate.ts";
import { loadConfig } from "../src/policy.ts";
import * as lookup from "../src/lookup.ts";

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-ignore-case-"));
  expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
  // The legacy-sensitive assertions must not depend on Git's filesystem probe.
  expect(spawnSync("git", ["-C", root, "config", "core.ignorecase", "false"]).status).toBe(0);
  fs.writeFileSync(path.join(root, ".gitignore"), "private.txt\nsecret.txt\n!SECRET.txt\nnode_modules/\n");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("folded ignore checks protect both stored casing directions", () => {
  for (const name of ["private.txt", "PRIVATE.TXT"]) {
    expect(isPossiblyGitIgnored("git", path.join(root, name))).toBe(true);
  }
});

test("a folded negation cannot clear a denial through another alias", () => {
  for (const name of ["secret.txt", "SECRET.txt"]) {
    expect(isPossiblyGitIgnored("git", path.join(root, name))).toBe(true);
  }
});

test("ordinary unmatched files stay allowed and sensitive ignore semantics stay unchanged", () => {
  expect(isPossiblyGitIgnored("git", path.join(root, "README.md"))).toBe(false);
  expect(isGitIgnored("git", path.join(root, "private.txt"), [])).toBe(true);
  expect(isGitIgnored("git", path.join(root, "PRIVATE.TXT"), [])).toBe(false);
});

test("an artifact name cannot implicitly exempt its insensitive aliases", () => {
  expect(isPossiblyGitIgnored("git", path.join(root, "NODE_MODULES/pkg/file.txt"))).toBe(true);
});

test("batch alias verdicts agree with single checks and do not survive rule changes", () => {
  const targets = ["private.txt", "PRIVATE.TXT", "secret.txt", "SECRET.txt", "README.md"].map((name) => path.join(root, name));
  const verdicts = possibleIgnoreVerdicts("git", targets);
  for (const target of targets) expect(verdicts.get(target)).toBe(isPossiblyGitIgnored("git", target));
  fs.writeFileSync(path.join(root, ".gitignore"), "");
  try {
    expect([...possibleIgnoreVerdicts("git", targets).values()]).toEqual(targets.map(() => false));
  } finally {
    fs.writeFileSync(path.join(root, ".gitignore"), "private.txt\nsecret.txt\n!SECRET.txt\nnode_modules/\n");
  }
});

test("a Git failure never becomes an allowed alias verdict", () => {
  const stub = path.join(root, "failing-git");
  fs.writeFileSync(stub, "#!/bin/sh\nexit 128\n", { mode: 0o700 });
  expect(() => possibleIgnoreVerdicts(stub, [path.join(root, "PRIVATE.TXT")])).toThrow("cannot establish case-alias gitignore protection");
  const modes = spyOn(lookup, "readDirectoryModes").mockImplementation((target) =>
    Array(target.split(path.sep).filter(Boolean).length + 1).fill("unknown"));
  try {
    const config = loadConfig(fileURLToPath(new URL("../policy/default.json", import.meta.url)));
    config.tools.git = stub;
    expect(classifyPaths([path.join(root, "PRIVATE.TXT")], config).get(path.join(root, "PRIVATE.TXT"))).toBe("deny");
  } finally {
    modes.mockRestore();
  }
});
