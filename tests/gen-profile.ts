/**
 * Prints the host backend's sandbox command for the given repo/home/group, one
 * word per line, as the resolver hands it to the shell wrapper. Used by
 * sandbox.test.sh so the integration tests exercise the real generator rather
 * than a hand-written profile.
 *
 * Usage: bun gen-profile.ts <config.json> <repoRoot> <home> <group|->
 * Env:   SG_EXEMPT_ROOTS, SG_DENY_ROOTS — colon-separated overrides.
 */
import { loadConfig } from "../src/policy.ts";
import type { GuardConfig } from "../src/policy.ts";
import { hostSandbox } from "../src/sandbox.ts";
import { tamperTargets } from "../src/tamper.ts";

const [policyPath, repoRoot, home, groupArgument] = process.argv.slice(2);
if (!policyPath || !repoRoot || !home || !groupArgument) {
  throw new Error("usage: gen-profile.ts <config.json> <repoRoot> <home> <group|->");
}

const host = hostSandbox();
if (!host.backend) throw new Error(`this host has no shell sandbox: ${host.reason}`);

const split = (value: string | undefined) =>
  value ? value.split(":").filter((entry) => entry.length > 0) : undefined;

const base = loadConfig(policyPath, home);
const config: GuardConfig = {
  ...base,
  exemptRoots: split(process.env.SG_EXEMPT_ROOTS) ?? base.exemptRoots,
  denyRoots: split(process.env.SG_DENY_ROOTS) ?? base.denyRoots,
};

const words = host.backend.shellCommand({
  config,
  home,
  cwd: repoRoot,
  group: groupArgument === "-" ? null : groupArgument,
  tamper: tamperTargets({
    repoRoot,
    pathEnvironment: process.env.PATH,
    home,
    policyPath,
    writeProtectedRoots: config.writeProtectedRoots,
  }),
});
process.stdout.write(words.map((word) => `${word}\n`).join(""));
