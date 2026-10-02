import * as childProcess from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type LookupMode = "sensitive" | "insensitive" | "unknown";
export type ReadDirectoryModes = (target: string) => LookupMode[];

/** Root first, then each component, including the target if it is a directory.
 * A non-directory target has an unknown final slot. No file contents are read.
 */
export function readDirectoryModes(target: string): LookupMode[] {
  const count = target.slice(path.parse(target).root.length).split(path.sep).filter(Boolean).length + 1;
  const unknown = (): LookupMode[] => Array(count).fill("unknown");
  // Fixed package-relative location, never PATH or user configuration. A source
  // checkout without the bundled helper deliberately reports unknown metadata.
  const helper = fileURLToPath(new URL("../bin/path-lookup", import.meta.url));
  try {
    const result = childProcess.spawnSync(helper, [target], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) return unknown();
    const modes: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(modes) || modes.length !== count ||
      modes.some((mode) => mode !== "sensitive" && mode !== "insensitive" && mode !== "unknown")) return unknown();
    return modes as LookupMode[];
  } catch {
    return unknown();
  }
}
