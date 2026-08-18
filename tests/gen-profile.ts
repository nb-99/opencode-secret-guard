/**
 * Prints a sandbox profile for the given repo/home/group. Used by
 * sandbox.test.sh so the integration tests exercise the real generator rather
 * than a hand-written profile.
 *
 * Usage: bun gen-profile.ts <config.json> <repoRoot> <home> <group|->
 * Env:   SG_EXEMPT_ROOTS, SG_DENY_ROOTS — colon-separated overrides.
 */
import { gitignoreRules } from "../src/gitignore.ts";
import { loadConfig } from "../src/policy.ts";
import { buildProfile } from "../src/profile.ts";

type GuardConfig = {
  configVersion: number;
  mode: "shell+files" | "files-only";
  secretPatterns: string[];
  secretExceptions: string[];
  artifactAllowlist: string[];
  relaxationGroups: Record<string, { binaries: string[]; allowPaths: string[] }>;
  denyRoots: string[];
  exemptRoots: string[];
  secretEnvironment: string[];
  cacheTtlMs: number;
};

const [policyPath, repoRoot, home, groupArgument] = process.argv.slice(2);
if (!policyPath || !repoRoot || !home || !groupArgument) {
  throw new Error("usage: gen-profile.ts <config.json> <repoRoot> <home> <group|->");
}

const split = (value: string | undefined) =>
  value ? value.split(":").filter((entry) => entry.length > 0) : undefined;

const base = loadConfig(policyPath, home) as GuardConfig;
const config: GuardConfig = {
  ...base,
  exemptRoots: split(process.env.SG_EXEMPT_ROOTS) ?? base.exemptRoots,
  denyRoots: split(process.env.SG_DENY_ROOTS) ?? base.denyRoots,
};

process.stdout.write(
  buildProfile({
    config,
    home,
    group: groupArgument === "-" ? null : groupArgument,
    gitignore: gitignoreRules(repoRoot, config.artifactAllowlist),
  }),
);
