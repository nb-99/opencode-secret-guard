import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CommandAnalysis } from "./command-policy.ts";
import { analyzeCommand } from "./command-policy.ts";
import { matchesAny, realpath } from "./paths.ts";
import type { GuardConfig } from "./policy.ts";
import { profilePath } from "./profile.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * The wrapper ships beside this module in one package, at <package>/bin. That
 * relationship is the check: a store-path pattern would refuse to start on any
 * host that did not install through Nix, while comparing realpaths works for a
 * store path, a Home Manager profile symlink and a plain checkout alike, and
 * still rejects a wrapper belonging to a different installation.
 */
export function expectedShell(moduleDirectory: string): string {
  return path.join(path.dirname(moduleDirectory), "bin", "opencode-secret-guard");
}

export function validateShell(shell: unknown, moduleDirectory: string): void {
  const expected = expectedShell(moduleDirectory);
  const configured = typeof shell === "string" && shell.length > 0 ? shell : "";
  if (!configured || realpath(configured) !== realpath(expected)) {
    throw new Error(
      `secret-guard: opencode's shell must be ${expected}, but it is ${configured || "unset"}. ` +
        "The bash tool is unguarded until it is.",
    );
  }
}

/**
 * "shell+files" promises kernel enforcement, so it must not start where that
 * cannot be delivered. Reporting the reason here is the difference between a
 * named refusal at startup and every command failing later with an EPERM that
 * names neither the guard nor the cause.
 */
export function validatePlatform(config: GuardConfig): void {
  if (config.mode !== "shell+files") return;
  if (process.platform !== "darwin") {
    throw new Error(
      `secret-guard: mode "shell+files" needs macOS, but this host is ${process.platform}. ` +
        'Set "mode": "files-only" to run with the weaker file-tool layer alone.',
    );
  }
  if (!fs.existsSync(SANDBOX_EXEC)) {
    throw new Error(
      `secret-guard: mode "shell+files" needs ${SANDBOX_EXEC}, which is missing. ` +
        'Set "mode": "files-only" to run with the weaker file-tool layer alone.',
    );
  }
}

export function resolveProfile(command: string, guardConfig: GuardConfig): string {
  return resolveShellPlan(command, guardConfig).profile;
}

/**
 * Names to remove from a command's environment: the policy's explicit list
 * plus every inherited variable whose name matches a secret pattern, minus
 * what the resolved group's binaries need (`aws` keeps `AWS_SECRET_ACCESS_KEY`).
 * Only pattern hits are re-admitted: an explicitly named variable is the user
 * saying "never", which no group overrides. Computed from the resolver's own
 * environment, which is the one the command inherits.
 */
export function scrubbedEnvironment(
  config: GuardConfig,
  group: string | null,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const keep = group ? config.relaxationGroups[group]?.allowEnvironment ?? [] : [];
  const names = new Set(config.secretEnvironment);
  if (config.secretEnvironmentPatterns.length > 0) {
    for (const name of Object.keys(environment)) {
      if (matchesAny(name, config.secretEnvironmentPatterns) && !matchesAny(name, keep)) names.add(name);
    }
  }
  return [...names].sort();
}

export function resolveShellPlan(
  command: string,
  guardConfig: GuardConfig,
): { profile: string; group: string | null; hint: string; scrub: string[] } {
  // The wrapper only exists to enforce the shell layer. Being invoked while the
  // policy disables that layer means the two disagree about what is guarded, so
  // it refuses rather than running the command under no profile at all.
  if (guardConfig.mode === "files-only") {
    throw new Error(
      'the policy sets mode "files-only", so this shell must not be configured as opencode\'s shell.',
    );
  }
  if (!fs.existsSync(SANDBOX_EXEC)) {
    throw new Error(
      `${SANDBOX_EXEC} is missing, refusing to run an unsandboxed command.`,
    );
  }

  const analysis = analyzeCommand(command, guardConfig);
  if (analysis.refusal) throw new Error(refusalMessage(analysis.refusal));
  const profile = profilePath({
    config: guardConfig,
    home: os.homedir(),
    cwd: process.cwd(),
    group: analysis.group,
  });
  return {
    profile,
    group: analysis.group,
    hint: strictHint(analysis),
    scrub: scrubbedEnvironment(guardConfig, analysis.group),
  };
}

/**
 * Refusing is the right answer for a command whose output *is* the secret:
 * there is no partial run that would have been useful.
 */
export function refusalMessage(invocation: string): string {
  return (
    `refusing to run \`${invocation}\`: its output is a credential, which must not enter the agent's context. ` +
    "Use the credential through the tool that needs it instead of printing it."
  );
}

/**
 * One line for the wrapper to print when a command that named a credential
 * binary fails under the strict profile. Empty when there is nothing to say.
 * Newlines are folded because the protocol below is line-oriented.
 */
export function strictHint(analysis: CommandAnalysis): string {
  if (analysis.group || !analysis.reason) return "";
  const groups = analysis.candidates.map((name) => `\`${name}\``).join(" and ");
  return (
    `secret-guard: this command ran under the strict profile because ${analysis.reason}. ` +
    `The ${groups} credentials were unreadable. Split it into one call per step, ` +
    `keeping only credential binaries and stdin-only filters together.`
  ).replace(/\s*\n\s*/g, " ");
}

/**
 * The shell wrapper's side of the contract: the profile path, then the hint
 * (possibly empty), then one environment variable to scrub per line. All come
 * from one invocation because the wrapper pays the interpreter's startup cost
 * on every command.
 */
export function resolveForShell(command: string, guardConfig: GuardConfig): string {
  const plan = resolveShellPlan(command, guardConfig);
  return [plan.profile, plan.hint, ...plan.scrub].join("\n");
}

