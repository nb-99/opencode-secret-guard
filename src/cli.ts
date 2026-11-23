/**
 * Resolver entry point for the shell wrapper.
 *
 * Prints the sandbox command, the failure hint and the environment variables
 * to scrub, in the line protocol `resolveForShell` describes. Every failure
 * exits non-zero so the wrapper aborts rather than running a command
 * unsandboxed.
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
  process.stderr.write(`secret-guard: ${message.replace(/^secret-guard: /, "")}\n`);
  process.exit(1);
}
