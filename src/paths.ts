import * as fs from "node:fs";
import * as path from "node:path";

export function realpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    // Fall back to the lexically resolved parent so rules still land on the
    // canonical directory when the leaf does not exist yet.
    try {
      const parent = fs.realpathSync(path.dirname(target));
      return path.join(parent, path.basename(target));
    } catch {
      return path.resolve(target);
    }
  }
}

export function matchesAny(target: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(target);
    } catch {
      return false;
    }
  });
}

export function isInside(target: string, root: string): boolean {
  const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
  return target === normalized || target.startsWith(normalized + "/");
}

export function isExistingDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

