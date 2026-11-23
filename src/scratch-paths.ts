import * as fs from "node:fs";
import * as path from "node:path";
import { isInside } from "./paths.ts";

export type ScratchRoot = { root: string; device: number; inode: number };

export function inspectScratchRoot(declared: string): ScratchRoot {
  if (!path.isAbsolute(declared) || declared.split(path.sep).includes("..")) throw new Error("invalid cleanupRoot");
  // Strip trailing slashes before lstat so they cannot make it follow the final link.
  const directory = path.resolve(declared);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory()) throw new Error("cleanupRoot must be an existing directory, not a symlink");
  const root = fs.realpathSync(directory);
  if (root === path.parse(root).root) throw new Error("refusing filesystem root");
  return { root, device: stat.dev, inode: stat.ino };
}

export function sameScratchRoot(a: ScratchRoot, b: ScratchRoot): boolean {
  return a.root === b.root && a.device === b.device && a.inode === b.inode;
}

/** Walk from a verified root. Only ENOENT permits a not-yet-created suffix. */
export function scratchDescendant(root: string, relative: string): string {
  const parts = relative.split(path.sep);
  if (path.isAbsolute(relative) || /[\0\r\n\\]/.test(relative) || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`expected a relative descendant path, got ${JSON.stringify(relative)}`);
  }
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return path.join(current, ...parts.slice(index + 1));
    }
    if (stat.isSymbolicLink()) throw new Error(`symlink operand or ancestor: ${relative}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`not a directory: ${relative}`);
    if (fs.realpathSync(current) !== current) throw new Error(`target changed during validation: ${relative}`);
  }
  return current;
}

/** A host path may spell the root's parent through an alias, such as /tmp on macOS. */
export function inScratch(root: ScratchRoot | undefined, target: string): boolean {
  if (!root || !path.isAbsolute(target) || target.split(path.sep).includes("..") || /[\0\r\n\\*?\[\]{}()]/.test(target)) return false;
  const absolute = path.resolve(target);
  try {
    let spelling = root.root;
    if (!isInside(absolute, spelling)) {
      // Resolve only ancestors above the scratch root. Below it every link must be rejected.
      const name = path.basename(root.root);
      let prefix = path.parse(absolute).root;
      for (const part of absolute.slice(prefix.length).split(path.sep)) {
        if (part === name && path.join(fs.realpathSync(prefix), part) === root.root) {
          spelling = path.join(prefix, part);
          break;
        }
        prefix = path.join(prefix, part);
      }
      if (!isInside(absolute, spelling)) return false;
    }
    if (absolute !== spelling) scratchDescendant(root.root, path.relative(spelling, absolute));
    return true;
  } catch {
    return false;
  }
}
