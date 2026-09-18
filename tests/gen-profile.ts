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
import type { GuardConfig } from "../src/policy.ts";
import { buildProfile } from "../src/profile.ts";
import { tamperTargets } from "../src/tamper.ts";

const [policyPath, repoRoot, home, groupArgument] = process.argv.slice(2);
if (!policyPath || !repoRoot || !home || !groupArgument) {
  throw new Error("usage: gen-profile.ts <config.json> <repoRoot> <home> <group|->");
}

const split = (value: string | undefined) =>
  value ? value.split(":").filter((entry) => entry.length > 0) : undefined;

const base = loadConfig(policyPath, home);
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
    gitignore: gitignoreRules(config.tools.git, repoRoot, config.artifactAllowlist),
    tamper: tamperTargets({ repoRoot, pathEnvironment: process.env.PATH, home, policyPath }),
  }),
);
