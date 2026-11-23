/**
 * The kernel mechanism behind "shell+files" mode. The guard decides what a
 * command may touch; a backend turns that into something the host's kernel
 * enforces and names the command that applies it. The guard picks the
 * mechanism here; the backends it lists implement it.
 */
import type { GitignoreRules } from "./gitignore.ts";
import type { GuardConfig } from "./policy.ts";
import { sandboxExec } from "./sandbox-exec.ts";
import type { TamperTargets } from "./tamper.ts";

export type Availability = { available: true } | { available: false; reason: string };

/** What one guarded shell command runs under. */
export interface ShellConfinement {
  config: GuardConfig;
  home: string;
  cwd: string;
  group: string | null;
  tamper: TamperTargets;
}

/** The strict shell policy, narrowed to deleting exactly `entries`. */
export interface DeletionConfinement {
  config: GuardConfig;
  home: string;
  gitignore: GitignoreRules;
  tamper: TamperTargets;
  /** Canonical paths that may be unlinked; nothing else may be written. */
  entries: string[];
  /** The canonical cleanup root, which stays. */
  root: string;
}

export interface SandboxBackend {
  readonly name: string;
  /** The sandbox refuses to execute setuid binaries, whatever the policy allows. */
  readonly blocksSetuid: boolean;
  probe(): Availability;
  /**
   * The command a guarded shell command runs under: an absolute executable and
   * its arguments, to which the command string is appended as the last one.
   * The string must run under `zsh -c`, because the command analysis and the
   * tamper rules for zsh's startup files assume zsh.
   */
  shellCommand(confinement: ShellConfinement): string[];
  /** The command a deletion runs under; the program and its arguments follow. */
  deletionCommand(confinement: DeletionConfinement): string[];
}

export type HostSandbox = { backend: SandboxBackend } | { backend: null; reason: string };

/** Every backend the guard knows, in order of preference. */
const BACKENDS: readonly SandboxBackend[] = [sandboxExec];

/** The first backend this host can run, or why none can. */
export function hostSandbox(): HostSandbox {
  const reasons: string[] = [];
  for (const backend of BACKENDS) {
    const availability = backend.probe();
    if (availability.available) return { backend };
    reasons.push(`${backend.name} ${availability.reason}`);
  }
  return { backend: null, reason: reasons.join("; ") };
}

/**
 * The backend "shell+files" mode runs on, or null in "files-only" mode. That
 * mode promises kernel enforcement, so it must not start where none can be
 * delivered. Reporting the reason here is the difference between a named
 * refusal at startup and every command failing later with an EPERM that names
 * neither the guard nor the cause.
 */
export function selectBackend(config: GuardConfig): SandboxBackend | null {
  if (config.mode !== "shell+files") return null;
  const host = hostSandbox();
  if (host.backend) return host.backend;
  throw new Error(
    `secret-guard: mode "shell+files" needs a shell sandbox, but this ${process.platform} host has none: ` +
      `${host.reason}. Set "mode": "files-only" to run with the weaker file-tool layer alone.`,
  );
}
