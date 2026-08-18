/**
 * Prints "<allow|deny> <path>" for each path on stdin, using the same predicate
 * the file tools use.
 *
 * classifyPath and buildProfile are two implementations of one policy: the file
 * tools consult the first, the kernel enforces the second. sandbox.test.sh
 * compares the two, which is the only thing standing between them and a silent
 * drift that leaves a secret guarded in one layer and exposed in the other.
 *
 * Usage: bun classify.ts <config.json> <home> < paths
 * Env:   SG_EXEMPT_ROOTS, SG_DENY_ROOTS — colon-separated overrides, matching
 *        gen-profile.ts so both layers are asked about the same policy.
 */
import * as fs from "node:fs";
import { loadConfig } from "../src/policy.ts";
import { classifyPath } from "../src/predicate.ts";


const [policyPath, home] = process.argv.slice(2);
if (!policyPath || !home) {
  throw new Error("usage: classify.ts <config.json> <home> < paths");
}

const split = (value: string | undefined) =>
  value ? value.split(":").filter((entry) => entry.length > 0) : undefined;

const base = loadConfig(policyPath, home);
const config = {
  ...base,
  exemptRoots: split(process.env.SG_EXEMPT_ROOTS) ?? base.exemptRoots,
  denyRoots: split(process.env.SG_DENY_ROOTS) ?? base.denyRoots,
};

const targets = fs
  .readFileSync(0, "utf8")
  .split("\n")
  .filter((line) => line.length > 0);

process.stdout.write(targets.map((target) => `${classifyPath(target, config)} ${target}`).join("\n"));
process.stdout.write("\n");
