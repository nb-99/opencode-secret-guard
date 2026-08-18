/**
 * Resolver entry point for the shell wrapper.
 *
 * Prints the profile path on the first line and the environment variables to
 * scrub on the following ones. Every failure exits non-zero so the wrapper
 * aborts rather than running a command unsandboxed.
 */
import { loadConfig } from "./policy.ts";
import { resolveForShell } from "./shell.ts";

try {
  const [mode, command] = process.argv.slice(2);
  if (mode !== "--resolve" || command === undefined) {
    throw new Error("expected --resolve <command>");
  }
  process.stdout.write(resolveForShell(command, loadConfig()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`secret-guard: ${message}\n`);
  process.exit(1);
}
