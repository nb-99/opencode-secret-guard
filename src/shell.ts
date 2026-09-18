import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CommandAnalysis } from "./command-policy.ts";
import { analyzeCommand, analyzeSegments, parseCommand, shellWords } from "./command-policy.ts";
import { findRepoRoot } from "./gitignore.ts";
import { matchesAny, realpath } from "./paths.ts";
import type { GuardConfig } from "./policy.ts";
import { profilePath } from "./profile.ts";
import type { TamperTargets } from "./tamper.ts";
import { isTamperProtected, tamperTargets } from "./tamper.ts";

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

/** The guard's own variables: their names contain "SECRET" and hold no secret. */
export const OWN_ENVIRONMENT = /^(SECRET_GUARD_|OPENCODE_SECRET_GUARD_)/;

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
      if (OWN_ENVIRONMENT.test(name)) continue;
      if (matchesAny(name, config.secretEnvironmentPatterns) && !matchesAny(name, keep)) names.add(name);
    }
  }
  return [...names].sort();
}

export function resolveShellPlan(
  command: string,
  guardConfig: GuardConfig,
): { profile: string; group: string | null; hint: FailureHint; scrub: string[] } {
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
  const home = os.homedir();
  const cwd = process.cwd();
  const tamper = tamperTargets({
    repoRoot: findRepoRoot(cwd),
    pathEnvironment: process.env.PATH,
    home,
  });
  const profile = profilePath({
    config: guardConfig,
    home,
    cwd,
    group: analysis.group,
    tamper,
  });
  const scrub = scrubbedEnvironment(guardConfig, analysis.group);
  return {
    profile,
    group: analysis.group,
    hint: failureHint({ analysis, command, tamper, scrub, home, cwd }),
    scrub,
  };
}

/**
 * Refusing is the right answer for a command whose output *is* the secret:
 * there is no partial run that would have been useful.
 */
export function refusalMessage(invocation: string): string {
  return (
    `refusing to run \`${invocation}\`: its output is a credential, which must not enter the agent's context. ` +
    "Use the credential through the tool that needs it instead of printing it. " +
    "If this invocation prints no credential, ask the user to drop the matching `secretPrintingCommands` rule."
  );
}

/**
 * One line for the wrapper to print when a command that named a credential
 * binary fails under the strict profile. Empty when there is nothing to say.
 * Newlines are folded because the protocol below is line-oriented.
 *
 * Phrased as a condition, not a diagnosis: the wrapper sees an exit status,
 * not what failed. `mkdir /root/x && git log` fails on the mkdir, and saying
 * "this ran strict, the credentials were unreadable" as a statement of cause
 * sends the reader after the wrong thing.
 */
export function strictHint(analysis: CommandAnalysis): string {
  if (analysis.group || !analysis.reason) return "";
  const groups = analysis.candidates.map((name) => `\`${name}\``).join(" and ");
  return (
    `secret-guard: if this failed on a permission error, the cause is that the command ran under the ` +
    `strict profile because ${analysis.reason}. The ${groups} credentials were unreadable there. ` +
    `Split it into one call per step, keeping only credential binaries and stdin-only filters together.`
  ).replace(/\s*\n\s*/g, " ");
}

/**
 * Binaries that are setuid on macOS. `sandbox-exec` refuses to execute one at
 * all, which is the kernel's rule and not the profile's, so this failure is
 * certain rather than conditional — and the error, `operation not permitted`,
 * looks exactly like a denied file. Only the common ones an agent reaches for
 * are listed; the alternatives matter more than completeness.
 */
export const SETUID_BINARIES: Record<string, string> = {
  ps: "use `pgrep -fl PATTERN` to find a process and `lsof -i :PORT` for a port",
  top: "use `pgrep -fl PATTERN`",
  sudo: "run privileged commands from your own terminal",
  su: "run privileged commands from your own terminal",
  crontab: "edit the crontab from your own terminal",
  at: "schedule from your own terminal",
  traceroute: "run it from your own terminal",
  ping: "run it from your own terminal",
};

/** The first setuid binary the command invokes, or null. */
export function setuidBinary(command: string): string | null {
  for (const segment of analyzeSegments(command) ?? []) {
    const binary = parseCommand(segment.command)?.binary;
    if (binary && binary in SETUID_BINARIES) return binary;
  }
  return null;
}

/**
 * Commands that install a program into a directory on `PATH` without naming
 * that directory anywhere in their words. The tamper rules deny the write, and
 * the tool's own error rarely mentions a path the scan below could recognise.
 */
export const GLOBAL_INSTALLERS: { binary: string; pattern: RegExp }[] = [
  { binary: "brew", pattern: /^(install|upgrade|reinstall|tap|link)$/ },
  { binary: "npm", pattern: /^(-g|--global|--location=global)$/ },
  { binary: "pnpm", pattern: /^(-g|--global)$/ },
  { binary: "yarn", pattern: /^global$/ },
  { binary: "bun", pattern: /^(-g|--global)$/ },
  { binary: "cargo", pattern: /^install$/ },
  { binary: "go", pattern: /^install$/ },
  { binary: "gem", pattern: /^install$/ },
  { binary: "pipx", pattern: /^install$/ },
  { binary: "uv", pattern: /^tool$/ },
];

/**
 * The first word of the command that names a path no command may write, or
 * null. Words are taken as written: a path spelled by a variable is invisible
 * here, and a command that uses one has already been forced strict.
 *
 * Both spellings are tested, because a target is protected at the link as well
 * as at its destination and a `PATH` entry is protected as `PATH` spells it.
 * Resolving alone would miss `/opt/homebrew/bin/git`, whose realpath leaves the
 * protected directory for the Cellar; the lexical form alone would miss a word
 * reaching a target through a symlinked parent.
 */
export function tamperedPath(
  command: string,
  tamper: TamperTargets,
  home: string,
  cwd: string,
): string | null {
  for (const segment of analyzeSegments(command) ?? []) {
    for (const word of shellWords(segment.command) ?? []) {
      if (!word || word.startsWith("-")) continue;
      if (!word.includes("/") && !word.startsWith("~")) continue;
      const expanded = word.startsWith("~/") ? path.join(home, word.slice(2)) : word;
      const lexical = path.resolve(cwd, expanded);
      if (isTamperProtected(lexical, tamper)) return word;
      if (isTamperProtected(realpath(lexical), tamper)) return word;
    }
  }
  return null;
}

/** The installer invocation in the command, as `binary subcommand`, or null. */
export function globalInstaller(command: string): string | null {
  for (const segment of analyzeSegments(command) ?? []) {
    const parsed = parseCommand(segment.command);
    if (!parsed) continue;
    const words = shellWords(parsed.args) ?? [];
    for (const { binary, pattern } of GLOBAL_INSTALLERS) {
      if (parsed.binary === binary && words.some((word) => pattern.test(word))) {
        return `${binary} ${words.find((word) => pattern.test(word))}`;
      }
    }
  }
  return null;
}

/** Scrubbed variables the command names outright, in the order they appear. */
export function scrubbedReferences(command: string, scrub: string[]): string[] {
  if (scrub.length === 0) return [];
  const named = new Set<string>();
  for (const match of command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
    if (scrub.includes(match[1]!)) named.add(match[1]!);
  }
  return [...named];
}

/**
 * What the wrapper prints when the command fails, and whether that line
 * survives a 127 exit.
 *
 * `certain` means the denial happens every time the command is run at all, so
 * the status does not need to corroborate it. Everything else is a note that
 * only applies if the failure was a permission error, which the wrapper cannot
 * see — it knows the exit status and nothing more.
 */
export interface FailureHint {
  text: string;
  certain: boolean;
}

/**
 * The one line the wrapper prints when the command fails. A failure under this
 * guard is often a denial the kernel reports as a bare `operation not
 * permitted`, naming neither the guard nor the rule — so an agent retries the
 * same shape instead of changing it. Each case below says what was denied and
 * what to do instead; silence is the default, because most failures are the
 * command's own.
 *
 * Every case but the setuid one is worded as a condition. A hint that asserts
 * the cause of a failure it cannot see is worse than no hint: `mkdir /root/x
 * && git log` fails on the mkdir, and "the credentials were unreadable" sends
 * the reader after the wrong thing.
 */
export function failureHint(options: {
  analysis: CommandAnalysis;
  command: string;
  tamper: TamperTargets;
  scrub: string[];
  home: string;
  cwd: string;
}): FailureHint {
  const { analysis, command, tamper, scrub, home, cwd } = options;
  const conditional = (text: string): FailureHint => ({ text, certain: false });

  // First: the only certain one. It also outranks the strict reason, which for
  // `sudo …` would blame the group it cost rather than the refusal to exec.
  const setuid = setuidBinary(command);
  if (setuid) {
    return {
      text:
        `secret-guard: \`${setuid}\` is setuid, and sandbox-exec refuses to execute a setuid binary — ` +
        `that is the kernel's rule, not the policy's, so it cannot be granted. Instead, ${SETUID_BINARIES[setuid]}.`,
      certain: true,
    };
  }

  const strict = strictHint(analysis);
  if (strict) return conditional(strict);

  const tampered = tamperedPath(command, tamper, home, cwd);
  if (tampered) {
    return conditional(
      `secret-guard: if this failed with "operation not permitted", it is because \`${tampered}\` is part of ` +
        "what OpenCode loads at its next start, or a directory on PATH. No command may write those, " +
        "so one command cannot disable the guard for the next. Make the change from your own terminal.",
    );
  }

  const installer = globalInstaller(command);
  if (installer) {
    return conditional(
      `secret-guard: if this failed on a permission error, it is because \`${installer}\` installs into a ` +
        "directory on PATH, which no command may write — a planted binary would run unsandboxed. " +
        "Install it from your own terminal, or into the repository.",
    );
  }

  const referenced = scrubbedReferences(command, scrub);
  if (referenced.length > 0) {
    return conditional(
      `secret-guard: if this failed for want of a value, note that ${referenced.join(", ")} ` +
        `${referenced.length === 1 ? "was" : "were"} removed from the environment before the command ran, ` +
        "because the name matches a credential pattern. Only a relaxation group's own binaries keep such a " +
        "variable; pass the value through the tool that needs it.",
    );
  }

  return conditional("");
}

/** The hint as the wrapper reads it: a certainty marker, then the text. */
export function encodeHint(hint: FailureHint): string {
  return hint.text ? `${hint.certain ? "!" : "?"}${hint.text}` : "";
}

/**
 * The shell wrapper's side of the contract: the profile path, then the hint
 * with its certainty marker (an empty line when there is nothing to say), then
 * one environment variable to scrub per line. All come from one invocation
 * because the wrapper pays the interpreter's startup cost on every command.
 */
export function resolveForShell(command: string, guardConfig: GuardConfig): string {
  const plan = resolveShellPlan(command, guardConfig);
  return [plan.profile, encodeHint(plan.hint), ...plan.scrub].join("\n");
}

