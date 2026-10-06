/**
 * The permission reviewer's JSONL logs: one JSON object per line, appended to
 * a fixed per-user file. Only the reviewer writes them, only while review is
 * enabled, and a failure to write never reaches a decision.
 *
 * Decision-log records carry codes and identifiers only, never a command,
 * resource, path, message text, credential, host error text or model output.
 * Payload-log records, written only with the opt-in `logPayloads`, do contain
 * the request and response bodies, including commands and user messages. The
 * files are observability, not policy: anything running as the user can write
 * to them.
 *
 * Every record opens the file anew without following a symlink or blocking on
 * a FIFO, checks it is a private regular file of this user, and appends one
 * short line with a single O_APPEND write; a short write is an error. Whether
 * concurrent writers never interleave within a line is up to the file system.
 * Once the file would exceed MAX_LOG_BYTES it is renamed to `.1`, replacing
 * the previous one. Rotation races between processes can lose records: this
 * is a best-effort diagnostic log, not an audit trail.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MAX_LOG_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 4096;

/**
 * The opt-in payload log (`logPayloads`) holds request and response bodies,
 * so its records are larger: a 48 kB request or 64 kB response, JSON-escaped.
 * Unlike the decision log it contains commands and the user's messages.
 */
export const PAYLOAD_LOG_LIMITS = { maxRecordBytes: 512 * 1024, maxLogBytes: 8 * 1024 * 1024 } as const;

function stateDirectory(): string {
  // XDG ignores a relative value, which would otherwise land in the working directory.
  const state = process.env.XDG_STATE_HOME;
  const base = state && path.isAbsolute(state) ? state : path.join(os.homedir(), ".local", "state");
  return path.join(base, "opencode-secret-guard");
}

export const reviewLogPath = (): string => path.join(stateDirectory(), "permission-review.jsonl");
export const payloadLogPath = (): string => path.join(stateDirectory(), "permission-review-payloads.jsonl");

export type ReviewRecord = Record<string, string | number | boolean | null>;
export type ReviewLogWriter = (record: ReviewRecord) => void;

/** Existing files with wider modes are refused, not changed: they are the user's. */
const ownedPrivate = (stat: fs.Stats, kind: "file" | "directory") =>
  (kind === "file" ? stat.isFile() && stat.nlink === 1 : stat.isDirectory()) &&
  (stat.mode & 0o077) === 0 &&
  (typeof process.getuid !== "function" || stat.uid === process.getuid());

function openForAppend(file: string): number {
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK,
    0o600,
  );
  try {
    // A hard link to another file would be appended to, or renamed away below.
    if (!ownedPrivate(fs.fstatSync(fd), "file")) throw new Error("unsafe log file");
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/** Throws on any failure; `setupPermissionReview` swallows it. */
export function fileReviewLog(
  file: string = reviewLogPath(),
  { maxRecordBytes = MAX_RECORD_BYTES, maxLogBytes = MAX_LOG_BYTES } = {},
): ReviewLogWriter {
  return (record) => {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!ownedPrivate(fs.lstatSync(directory), "directory")) throw new Error("unsafe log directory");
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    if (line.byteLength > maxRecordBytes) throw new Error("oversize log record");
    let fd = openForAppend(file);
    try {
      if (fs.fstatSync(fd).size + line.byteLength > maxLogBytes) {
        fs.closeSync(fd);
        fd = -1;
        fs.renameSync(file, `${file}.1`);
        fd = openForAppend(file);
      }
      if (fs.writeSync(fd, line) !== line.byteLength) throw new Error("short log write");
    } finally {
      if (fd >= 0) fs.closeSync(fd);
    }
  };
}
