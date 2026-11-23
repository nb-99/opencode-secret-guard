/**
 * The evidence a permission review sends, built in two steps. `parseContext`
 * validates one session's V2 context at the boundary. `refusalGate` applies
 * the refusal rules. `buildEvidence` fills the request `state` in tiers within
 * a byte budget, so that no amount of context makes a review impossible.
 *
 * Shapes and strings follow OpenCode v2.0.20 and v2.3.0:
 * schema/session-message.ts, session/recent-text.ts, runner/step.ts and
 * runner/to-llm-message.ts. A changed host string can only cause more prompts.
 */
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { matchesAny } from "./paths.ts";
import { Ineligible } from "./review-backends.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The guard's configured secret environment names, reused for assignments. */
export interface SecretNames {
  readonly secretEnvironment: ReadonlyArray<string>;
  readonly secretEnvironmentPatterns: ReadonlyArray<string>;
}

/** Real token formats. In the pending action they keep the prompt. */
const TOKEN = new RegExp(
  [
    String.raw`\bsk-[A-Za-z0-9_-]{16,}`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`\bgithub_pat_\w{20,}`,
    String.raw`\bglpat-[\w-]{20,}`,
    String.raw`\bAKIA[0-9A-Z]{16}\b`,
    String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
    String.raw`\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}`,
    String.raw`://[^/\s:@]+:[^/\s@]+@`,
  ].join("|"),
  "i",
);
/** A generic `name=value` credential. Also matches prefixed and suffixed names such as AWS_SECRET_ACCESS_KEY=. A removed value is no credential. */
const GENERIC = /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\w*\s*[=:]\s*(?!\[value removed\])\S+/i;
const GENERIC_NAME = /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\w*$/i;
const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_]*)\s*[=:](?!\s*\[value removed\])/g;
/** A name, `=` or `:` with no space, and the rest of that word. */
const ASSIGNED_WORD = /\b([A-Za-z_][A-Za-z0-9_-]*)([=:])(\S*)/g;
/**
 * One word without quoting, expansion or shell operators, optionally in
 * matching quotes. Replacing it cannot hide shell syntax or leave part of
 * the secret.
 */
const PLAIN_VALUE = /^(["']?)[\w.~+/@%,:=-]+\1$/;
/** At each word start: a name, then `=` or `:`, then a word, with optional spaces. Zero-width, so nested names are found too. */
const NAMED_WORD = /(?=\b([A-Za-z_][A-Za-z0-9_-]*)\s*[=:]\s*(\S+))/g;
/** A word that looks like a secret rather than prose: quoted, or a digit and at least 6 characters, or at least 20. */
const SECRET_WORD = /^(?:(?=.*\d).{6,}|.{20,})$/;
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
export const REMOVED_LINE = "[line removed: possible credential]";
export const REMOVED_VALUE = "[value removed]";

/** Recognises some credentials; not an exhaustive scanner. */
export interface CredentialCheck {
  /** A real token format. */
  token(text: string): boolean;
  /** Any recognised credential, including a generic or configured `name=value`. */
  any(text: string): boolean;
  /** Replaces each plain one-word value of a generic or configured `name=value` or `name:value`. */
  redactValues(text: string): string;
  /**
   * For evidence text: replaces plain values, then replaces each private key
   * block, and each line with a token or a secret-looking named value, with a
   * marker. Prose such as `token: never print it` stays.
   */
  removeLines(text: string): { text: string; removed: boolean };
}

export function credentialCheck(secrets: SecretNames): CredentialCheck {
  const secretName = (name: string) =>
    GENERIC_NAME.test(name) || secrets.secretEnvironment.includes(name) || matchesAny(name, [...secrets.secretEnvironmentPatterns]);
  const any = (text: string) => {
    if (TOKEN.test(text) || GENERIC.test(text)) return true;
    for (const [, name] of text.matchAll(ASSIGNMENT)) if (secretName(name!)) return true;
    return false;
  };
  const redactValues = (text: string) =>
    text.replace(ASSIGNED_WORD, (whole, name: string, separator: string, value: string) =>
      secretName(name) && PLAIN_VALUE.test(value) ? `${name}${separator}${REMOVED_VALUE}` : whole);
  const secretLine = (line: string) => {
    if (TOKEN.test(line)) return true;
    for (const [, name, value] of line.matchAll(NAMED_WORD)) {
      if (!secretName(name!)) continue;
      // Prose rarely quotes a value after a credential name.
      if (/^["']/.test(value!) || SECRET_WORD.test(value!.replace(/["'`,;.)]+$/, ""))) return true;
    }
    return false;
  };
  return {
    token: (text) => TOKEN.test(text),
    any,
    redactValues,
    removeLines(text) {
      const lines = text.split("\n");
      const kept: string[] = [];
      let removed = false;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        if (PEM_BEGIN.test(line)) {
          removed = true;
          kept.push(REMOVED_LINE);
          let end = index;
          while (end < lines.length && !PEM_END.test(lines[end]!)) end++;
          // Without an END line the rest of the item could be key material.
          if (end === lines.length) break;
          index = end;
          continue;
        }
        const shown = redactValues(line);
        if (secretLine(shown)) {
          removed = true;
          kept.push(REMOVED_LINE);
          continue;
        }
        if (shown !== line) removed = true;
        kept.push(shown);
      }
      return { text: kept.join("\n"), removed };
    },
  };
}

/**
 * The action as the reviewer sees it: the tool call's own command and the
 * absolute directory it asks for, plus the commands V2 parsed for the prompt.
 */
export type ReviewAction = "shell" | "external_directory";
export type ActionEvidence = {
  kind: "shell";
  permission_action: ReviewAction;
  requested_command: string;
  requested_cwd: string;
  project_directory: string;
  permission_resources: string[];
};

/**
 * v2.0.20 `FileAccess.resolvePath`: `~` and `~/` name the home directory and
 * everything else resolves against the location directory.
 */
export function effectiveDirectory(location: string, workdir: string | undefined): string {
  if (workdir === undefined) return location;
  const home = os.homedir();
  if (workdir === "~") return home;
  if (workdir.startsWith("~/")) return path.join(home, workdir.slice(2));
  return path.resolve(location, workdir);
}

export type RefusalKind = "declined" | "rejected" | "interrupted" | "shutdown" | "unknown-aborted";

/** runner/step.ts in v2.0.20 and v2.3.0; pinned by the characterization tests. */
export const ABORT_TEXTS = {
  declined: "The user declined this tool call",
  interrupted: ["Tool execution interrupted", "Step interrupted"],
  shutdown: "Interaction cancelled because the location shut down",
} as const;

/**
 * A saved error as a refusal kind, or undefined for other errors.
 * to-session-error.ts saves a reject with feedback and a configured deny as
 * `permission.rejected`; only live correlation tells them apart.
 */
export function classifyError(error: unknown): RefusalKind | undefined {
  if (!isRecord(error)) return undefined;
  if (error.type === "permission.rejected") return "rejected";
  if (error.type !== "aborted") return undefined;
  if (error.message === ABORT_TEXTS.declined) return "declined";
  if ((ABORT_TEXTS.interrupted as readonly unknown[]).includes(error.message)) return "interrupted";
  if (error.message === ABORT_TEXTS.shutdown) return "shutdown";
  return "unknown-aborted";
}

/** A kind that refuses an action; an interrupt only counts for the turn rule. */
const REFUSES = new Set<RefusalKind>(["declined", "rejected", "unknown-aborted"]);

interface Positioned {
  /** Position in its session's context. */
  readonly index: number;
  /** `time.created` in milliseconds, when the host sends it. */
  readonly at?: number;
}
export interface UserEntry extends Positioned { readonly id: string | null; readonly text: string }
export interface RefusalEntry extends Positioned {
  readonly kind: RefusalKind;
  readonly messageID: string | null;
  readonly callID?: string;
  readonly tool?: string;
  readonly input?: Record<string, unknown>;
  readonly message?: string;
}
export type SkillSource = "prompt" | "session" | "agent" | "compaction";
export interface SkillEntry extends Positioned { readonly name: string; readonly text: string; readonly source: SkillSource }
export interface AttachmentEntry extends Positioned {
  readonly messageID: string | null;
  readonly name: string;
  readonly mime: string;
  /** Decoded content of a text file or directory listing; absent for binary types. */
  readonly text?: string;
}
export interface CompactionEntry extends Positioned {
  readonly id: string | null;
  readonly summary: string;
  /** The user parts of the verbatim text kept beside the summary, oldest first. */
  readonly recentUsers: string[];
}

export interface ParsedContext {
  readonly users: UserEntry[];
  readonly refusals: RefusalEntry[];
  readonly skills: SkillEntry[];
  readonly attachments: AttachmentEntry[];
  readonly compactions: CompactionEntry[];
  /** Identities of the evidence-bearing messages, in order: the same text under a new id is new evidence. */
  readonly ids: unknown[];
}

const millis = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};
const timeOf = (record: Record<string, unknown>): number | undefined =>
  isRecord(record.time) ? millis(record.time.created) : undefined;
/** A refusal happens when its step or tool call ends, which can be long after it started. */
const endOf = (record: Record<string, unknown>): number | undefined =>
  isRecord(record.time) ? millis(record.time.completed) ?? millis(record.time.created) : undefined;

const stringOr = <T>(value: unknown, fallback: T) => (typeof value === "string" ? value : fallback);

/** to-llm-message.ts reads these two types as text and sends images and PDFs as media. */
const TEXT_MIMES = new Set(["text/plain", "application/x-directory"]);

function decodeBase64(data: unknown): string | undefined {
  if (typeof data !== "string") return undefined;
  try {
    return Buffer.from(data, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * recent-text.ts writes a kept user message as skill blocks, `[User]: <text>`
 * and attachment lines. Each user block ends at the next line that starts
 * another message part. Tool output can imitate a `[User]:` line, so the
 * result is indirect evidence only.
 */
const PART_START = /^\[(?:Assistant|Tool|Synthetic|Shell\])/;
export function recentParts(recent: string): { users: string[]; skills: Array<{ name: string; text: string }> } {
  const users: string[] = [];
  const skills: Array<{ name: string; text: string }> = [];
  let current: { kind: "user" | "skill"; name: string; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join("\n").replace(/\s+$/, "");
    if (current.kind === "user") users.push(text);
    else if (text) skills.push({ name: current.name, text });
    current = undefined;
  };
  for (const line of recent.split("\n")) {
    const skill = /^\[Skill activated: (.*)\]$/.exec(line);
    if (line.startsWith("[User]:")) {
      flush();
      current = { kind: "user", name: "", lines: [line.slice("[User]:".length).replace(/^ /, "")] };
    } else if (skill) {
      flush();
      current = { kind: "skill", name: skill[1]!, lines: [] };
    } else if (PART_START.test(line)) {
      flush();
    } else {
      current?.lines.push(line);
    }
  }
  flush();
  return { users, skills };
}

/** The text of a completed tool result, as recent-text.ts serializes it. */
function toolText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
  return parts.length ? parts.map((item) => (item as { text: string }).text).join("\n") : undefined;
}

/**
 * One session's context, validated. Throws Ineligible on a shape the reviewer
 * cannot read, and on a compaction that has not completed.
 */
export function parseContext(context: unknown): ParsedContext {
  if (!Array.isArray(context)) throw new Ineligible("context-shape");
  const parsed: ParsedContext = { users: [], refusals: [], skills: [], attachments: [], compactions: [], ids: [] };
  // Interrupts in the latest assistant message, by position in `parsed.refusals`.
  let interrupts: number[] = [];
  context.forEach((message, index) => {
    if (!isRecord(message) || typeof message.type !== "string") throw new Ineligible("context-shape");
    const at = timeOf(message);
    const id = typeof message.id === "string" ? message.id : null;
    const placed = (time: number | undefined) => (time === undefined ? { index } : { index, at: time });
    const place = placed(at);
    switch (message.type) {
      case "compaction": {
        // A failed compaction replaces nothing: the history before it stays in the context.
        if (message.status === "failed") return;
        if (message.status !== "completed") throw new Ineligible("context-compacted");
        if (typeof message.summary !== "string") throw new Ineligible("context-shape");
        // v2.0.20 stores `recent`; v2.3.0 rebuilds it into `metadata.recent`. Provider-native fields are never read.
        const recent = stringOr(message.recent, stringOr(isRecord(message.metadata) ? message.metadata.recent : undefined, ""));
        const parts = recentParts(recent);
        parsed.compactions.push({ ...place, id, summary: message.summary, recentUsers: parts.users });
        for (const skill of parts.skills) parsed.skills.push({ ...place, ...skill, source: "compaction" });
        parsed.ids.push(["compaction", id]);
        return;
      }
      case "user": {
        interrupts = [];
        if (typeof message.text !== "string") throw new Ineligible("context-shape");
        parsed.users.push({ ...place, id, text: message.text });
        for (const field of ["files", "skills"] as const) {
          if (message[field] !== undefined && !Array.isArray(message[field])) throw new Ineligible("context-shape");
        }
        for (const file of (message.files as unknown[] | undefined) ?? []) {
          if (!isRecord(file) || typeof file.mime !== "string") throw new Ineligible("context-shape");
          const source = isRecord(file.source) ? file.source : {};
          const name = stringOr(file.name, source.type === "uri" ? stringOr(source.uri, "inline attachment") : "inline attachment");
          // Only content stored in the session; a `uri` source is never followed.
          const text = TEXT_MIMES.has(file.mime) ? decodeBase64(file.data) : undefined;
          parsed.attachments.push({ ...place, messageID: id, name, mime: file.mime, ...(text === undefined ? {} : { text }) });
        }
        for (const skill of (message.skills as unknown[] | undefined) ?? []) {
          if (!isRecord(skill) || typeof skill.name !== "string") throw new Ineligible("context-shape");
          // Without `text`, the skill repeats one selected earlier in the same prompt.
          if (typeof skill.text === "string") parsed.skills.push({ ...place, name: skill.name, text: skill.text, source: "prompt" });
        }
        parsed.ids.push(["user", id]);
        return;
      }
      case "skill": {
        if (typeof message.name !== "string" || typeof message.text !== "string") throw new Ineligible("context-shape");
        parsed.skills.push({ ...place, name: message.name, text: message.text, source: "session" });
        parsed.ids.push(["skill", id]);
        return;
      }
      case "assistant": {
        interrupts = [];
        const ended = endOf(message);
        const own = classifyError(message.error);
        if (own === "interrupted") interrupts.push(parsed.refusals.length);
        if (own) parsed.refusals.push({ ...placed(ended), kind: own, messageID: id });
        if (!Array.isArray(message.content)) return;
        for (const part of message.content) {
          if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state)) continue;
          const name = stringOr(part.name, undefined);
          const input = isRecord(part.state.input) ? part.state.input : undefined;
          const callID = stringOr(part.id, undefined);
          if (part.state.status === "error") {
            const kind = classifyError(part.state.error);
            if (!kind) continue;
            const message = isRecord(part.state.error) ? stringOr(part.state.error.message, undefined) : undefined;
            if (kind === "interrupted") interrupts.push(parsed.refusals.length);
            parsed.refusals.push({
              ...placed(endOf(part) ?? ended), kind, messageID: id,
              ...(callID === undefined ? {} : { callID }), ...(name === undefined ? {} : { tool: name }),
              ...(input === undefined ? {} : { input }), ...(message === undefined ? {} : { message }),
            });
            parsed.ids.push(["refusal", id, callID ?? null, kind]);
          } else if (part.state.status === "completed" && name === "skill") {
            // The only tool result the reviewer reads: a skill the agent loaded.
            const text = toolText(part.state.content);
            const metadata = isRecord(part.state.metadata) ? part.state.metadata : {};
            const skillName = stringOr(metadata.name, stringOr(input?.id, stringOr(input?.name, "skill")));
            if (text) parsed.skills.push({ ...place, name: skillName, text, source: "agent" });
          }
        }
        return;
      }
      case "synthetic": {
        // execution/restart.ts adds this notice when it resumes a turn that a
        // server restart interrupted. Those interrupts are the host's, not the user's.
        if (!isRecord(message.metadata) || message.metadata.notice !== "restart") return;
        for (const position of interrupts) parsed.refusals[position] = { ...parsed.refusals[position]!, kind: "shutdown" };
        interrupts = [];
        parsed.ids.push(["restart", id]);
        return;
      }
      default:
        // Other synthetic messages, such as a subagent's result, and other types are not user evidence.
        return;
    }
  });
  return parsed;
}

/** A call the user rejected while this plugin ran; it survives compaction. */
export interface RefusedCall {
  readonly messageID?: string;
  readonly callID?: string;
  readonly tool?: string;
  readonly command?: string;
  readonly directory?: string;
  /** The reply time, on this plugin's clock. */
  readonly at: number;
}

export interface LiveRefusals {
  /** The reply time of the reject that pauses this session, if one does. */
  readonly pausedSince?: number;
  /** A reject named no session: every session stays paused until the plugin reloads. */
  readonly everySession?: boolean;
  /** This session's refused calls, oldest first. */
  readonly calls: ReadonlyArray<RefusedCall>;
}

export type SkipDetail = { refusal: RefusalKind | "live"; position: "after" };

export interface PriorRefusal {
  tool: string | null;
  command: string | null;
  directory: string | null;
  kind: RefusalKind;
  feedback: string | null;
  /** The feedback was typed live in reply to this refusal, so it is also in `user_messages`. */
  live_feedback: boolean;
  user_messages_after: number;
  same_as_pending: boolean;
}

/** Live feedback: the message of a call the user rejected with feedback, while this plugin ran. */
interface Feedback { readonly text: string; readonly order: number; readonly at: number }

export type Gate =
  | { readonly skip: { readonly reason: string; readonly detail: SkipDetail } }
  | {
    readonly skip?: undefined;
    readonly feedback: Feedback[];
    readonly prior: Array<PriorRefusal & { order: number }>;
    /** The pause ended: the user wrote, or gave feedback, after the reject. */
    readonly lifted: boolean;
  };

const MAX_PRIOR_REFUSALS = 8;
const callKey = (messageID: unknown, callID: unknown) => JSON.stringify([messageID ?? null, callID ?? null]);

export interface GateInput {
  readonly target: ParsedContext;
  /** The root session of a subagent session; the user writes only there. */
  readonly root?: ParsedContext;
  readonly live: LiveRefusals;
  readonly rootLive?: LiveRefusals;
  readonly action: ActionEvidence;
  readonly location: string;
  readonly credentials: CredentialCheck;
}

/**
 * The refusal rules. A turn starts at the latest user message of the session
 * that holds authority: the session itself, or the root of a subagent session.
 * A refusal or an interrupt after it pauses review in the session where it
 * happened; an interrupt that a server restart caused does not. Older
 * refusals become evidence. A live reject pauses its session
 * until the user writes again or gives feedback.
 */
export function refusalGate(input: GateInput): Gate {
  const { target, root, live, action } = input;
  const subagent = root !== undefined;
  const liveCalls = new Map(live.calls.filter((call) => call.messageID && call.callID).map((call) => [callKey(call.messageID, call.callID), call]));
  const feedback: Feedback[] = [];
  for (const refusal of target.refusals) {
    const call = liveCalls.get(callKey(refusal.messageID, refusal.callID));
    if (refusal.kind !== "rejected" || !call || refusal.callID === undefined || !refusal.message?.trim()) continue;
    feedback.push({ text: refusal.message, order: subagent ? call.at : refusal.index + 0.5, at: call.at });
  }
  const authority = root ?? target;
  // Same-session order is by position; across sessions only the host's times compare.
  const latestUser = subagent
    ? Math.max(-Infinity, ...authority.users.map((user) => user.at ?? Infinity), ...feedback.map((entry) => entry.at))
    : Math.max(-1, ...target.users.map((user) => user.index), ...feedback.map((entry) => entry.order));
  const after = (refusal: RefusalEntry) =>
    subagent ? refusal.at === undefined || !Number.isFinite(latestUser) || refusal.at > latestUser : refusal.index > latestUser;

  if (live.everySession) return { skip: { reason: "session-rejected", detail: { refusal: "live", position: "after" } } };
  let lifted = false;
  if (live.pausedSince !== undefined) {
    const since = live.pausedSince;
    // Only a call refused in this pause counts; an older one already had its own.
    const located = target.refusals.filter((refusal) => (liveCalls.get(callKey(refusal.messageID, refusal.callID))?.at ?? -Infinity) >= since);
    lifted = authority.users.some((user) => user.at !== undefined && user.at > since) ||
      feedback.some((entry) => entry.at >= since) ||
      (!subagent && located.some((refusal) => target.users.some((user) => user.index > refusal.index)));
    if (!lifted) return { skip: { reason: "session-rejected", detail: { refusal: "live", position: "after" } } };
  }
  const turn = target.refusals.find((refusal) => refusal.kind !== "shutdown" && after(refusal));
  if (turn) return { skip: { reason: "context-rejected-turn", detail: { refusal: turn.kind, position: "after" } } };

  const describe = (tool: string | undefined, command: string | undefined, directory: string | undefined) => {
    const clean = (value: string | undefined) => {
      if (value === undefined) return null;
      const redacted = input.credentials.removeLines(value).text;
      return redacted.length > MAX_REFUSAL_FIELD ? `${Array.from(redacted).slice(0, MAX_REFUSAL_FIELD).join("")}…` : redacted;
    };
    const shown = { tool: clean(tool), command: clean(command), directory: clean(directory) };
    return {
      ...shown,
      same_as_pending: tool === "shell" && shown.command === action.requested_command && shown.directory === action.requested_cwd,
    };
  };
  const fromHistory = (refusal: RefusalEntry, session: ParsedContext, inRoot: boolean) => {
    const shell = refusal.tool === "shell" && refusal.input !== undefined;
    const command = shell ? stringOr(refusal.input!.command, undefined) : undefined;
    const workdir = shell ? stringOr(refusal.input!.workdir, undefined) : undefined;
    const isLive = !inRoot && refusal.kind === "rejected" && Boolean(refusal.message?.trim()) &&
      liveCalls.has(callKey(refusal.messageID, refusal.callID));
    const usersAfter = inRoot || !subagent
      ? session.users.filter((user) => user.index > refusal.index).length + (inRoot ? 0 : feedback.filter((entry) => entry.order > refusal.index).length)
      : authority.users.filter((user) => user.at !== undefined && refusal.at !== undefined && user.at > refusal.at).length;
    return {
      ...describe(refusal.tool, command, shell ? effectiveDirectory(input.location, workdir) : undefined),
      kind: refusal.kind,
      feedback: refusal.kind === "rejected" && refusal.message ? input.credentials.removeLines(refusal.message).text : null,
      live_feedback: isLive,
      user_messages_after: usersAfter,
      order: subagent ? refusal.at ?? refusal.index : refusal.index,
    };
  };
  const fromLive = (call: RefusedCall) => ({
    ...describe(call.tool, call.command, call.directory),
    kind: "rejected" as const,
    feedback: null,
    live_feedback: false,
    user_messages_after: authority.users.filter((user) => user.at !== undefined && user.at > call.at).length,
    order: subagent ? call.at : Infinity,
  });
  const located = new Set(target.refusals.map((refusal) => callKey(refusal.messageID, refusal.callID)));
  const prior = [
    ...target.refusals.filter((refusal) => REFUSES.has(refusal.kind)).map((refusal) => fromHistory(refusal, target, false)),
    ...live.calls.filter((call) => !located.has(callKey(call.messageID, call.callID))).map(fromLive),
  ];
  if (root) {
    const rootLocated = new Set(root.refusals.map((refusal) => callKey(refusal.messageID, refusal.callID)));
    prior.push(
      ...root.refusals.filter((refusal) => REFUSES.has(refusal.kind)).map((refusal) => fromHistory(refusal, root, true)),
      ...(input.rootLive?.calls ?? []).filter((call) => !rootLocated.has(callKey(call.messageID, call.callID))).map(fromLive),
    );
  }
  prior.sort((a, b) => a.order - b.order);
  return { feedback, prior: prior.slice(-MAX_PRIOR_REFUSALS), lifted };
}

const MAX_REFUSAL_FIELD = 1_000;

/** A text item over this many code points keeps its start and end. */
export const CUT_CHARS = 4_000;
const KEEP_CHARS = 2_000;

/** OpenCode's compaction transcript cuts long text the same way. */
export function cutText(text: string): { text: string; omitted?: string } {
  if (text.length <= CUT_CHARS) return { text };
  const points = Array.from(text);
  if (points.length <= CUT_CHARS) return { text };
  const omitted = points.slice(KEEP_CHARS, points.length - KEEP_CHARS).join("");
  return {
    text: `${points.slice(0, KEEP_CHARS).join("")}\n[${points.length - 2 * KEEP_CHARS} characters omitted]\n${points.slice(-KEEP_CHARS).join("")}`,
    omitted,
  };
}

/** The compaction template's user limits go first, so a cut keeps them. */
export function requirementsFirst(summary: string): string {
  const heading = /^## Requirements[ \t]*$/m.exec(summary);
  if (!heading || heading.index === 0) return summary;
  const bodyStart = heading.index + heading[0].length;
  const next = summary.slice(bodyStart).search(/^## /m);
  const end = next === -1 ? summary.length : bodyStart + next;
  const section = summary.slice(heading.index, end).trimEnd();
  const rest = `${summary.slice(0, heading.index)}${summary.slice(end)}`.trim();
  return rest ? `${section}\n\n${rest}` : section;
}

const RESTRICTION = /\b(?:never|do not|don['’]t|must|only|ask|before|without|confirm)\b/i;
const MAX_EXCERPT_CHARS = 400;
const MAX_EXCERPTS_PER_ITEM = 12;
const MAX_COMMAND_TOKENS = 12;
const STOP_TOKENS = new Set(["rtk", "sudo", "env", "then", "do", "done", "if", "fi", "true", "false"]);

/** Words of the pending command that can name it in a rule, such as `push`, `rm` or a target path. */
export function commandTokens(command: string): string[] {
  const tokens = new Set<string>();
  for (const word of command.split(/[\s;&|()<>'"`=]+/)) {
    if (word.length < 2 || word.startsWith("-") || STOP_TOKENS.has(word.toLowerCase()) || !/^[\w./:@~+-]+$/.test(word)) continue;
    tokens.add(word.toLowerCase());
    if (tokens.size === MAX_COMMAND_TOKENS) break;
  }
  return [...tokens];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a line names one of `tokens`, as a whole word or path. */
export function tokenMatcher(tokens: ReadonlyArray<string>): (line: string) => boolean {
  if (tokens.length === 0) return () => false;
  const pattern = new RegExp(`(?<![\\w./-])(?:${tokens.map(escapeRegExp).join("|")})(?![\\w-])`, "i");
  return (line) => pattern.test(line);
}

export type CoverageSource =
  | "user_message" | "prior_refusal" | "delegated_task" | "compaction_summary" | "compaction_recent_user"
  | "skill" | "attachment" | "restriction_excerpts" | "restriction_screen" | "other";

export interface CoverageEntry {
  source: CoverageSource;
  id: string | null;
  status: "cut" | "omitted";
  characters: number;
}

/** Text that the state cut or left out, from tiers 2 to 4; the restriction screen reads it. */
export interface Leftover {
  readonly source: string;
  readonly order: number;
  readonly text: string;
}

export type EvidenceTag =
  | "compaction-recent" | "refusal-lifted" | "live-feedback" | "attachments" | "skills" | "agent-skill"
  | "credential-removed" | "cut" | "screen" | "fork" | "subagent" | "remote-named";

export interface ContextWarnings {
  compacted: boolean;
  outside_project: boolean;
  forked: boolean;
  subagent: boolean;
  credential_removed: boolean;
  binary_attachments: boolean;
  screen_failed: boolean;
}

export interface EvidenceInput {
  readonly action: ActionEvidence;
  readonly target: ParsedContext;
  readonly root?: ParsedContext;
  readonly gate: Extract<Gate, { skip?: undefined }>;
  readonly warnings: Pick<ContextWarnings, "outside_project" | "forked" | "credential_removed">;
  /** The most bytes the serialized `state` may use. */
  readonly budget: number;
  readonly credentials: CredentialCheck;
}

export interface Evidence {
  readonly state: Record<string, unknown> & { context_warnings: ContextWarnings; restriction_excerpts: Excerpt[]; coverage: CoverageEntry[] };
  /** Changes with any evidence the state holds or names, and with any evidence message's id. */
  readonly identity: string;
  readonly tags: Set<EvidenceTag>;
  readonly leftovers: Leftover[];
  readonly tokens: string[];
}

export type Excerpt = { source: string; text: string };

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const MAX_BINARY_MARKERS = 16;
const MAX_COVERAGE = 24;

type Target = "user_messages" | "prior_refusals" | "delegated_task" | "compaction_context" | "compaction_recent_user" | "skills" | "attachments";

interface Item {
  readonly tier: 1 | 2 | 3 | 4;
  readonly target: Target;
  readonly source: CoverageSource;
  readonly id: string | null;
  /** Larger is newer; the budget takes the newest first within a tier. */
  readonly order: number;
  readonly text: string;
  readonly entry: (text: string) => unknown;
}

const safeLabel = (value: string | null) => (value !== null && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : null);

/**
 * The request `state`, filled in tiers within `budget`: always the pending
 * action, warnings and coverage list; then (1) user messages, refusals and a
 * delegated task, (2) compaction summaries and the user parts of their
 * verbatim text, (3) skills, (4) attached text. A tier starts only when the
 * previous one is complete. Lines from evidence that was cut or left out that
 * can state a restriction go to `restriction_excerpts`.
 */
export function buildEvidence(input: EvidenceInput): Evidence {
  const { action, target, root, gate, credentials } = input;
  const subagent = root !== undefined;
  const authority = root ?? target;
  const tags = new Set<EvidenceTag>();
  const warnings: ContextWarnings = {
    compacted: target.compactions.length > 0 || (root?.compactions.length ?? 0) > 0,
    outside_project: input.warnings.outside_project,
    forked: input.warnings.forked,
    subagent,
    credential_removed: input.warnings.credential_removed,
    binary_attachments: false,
    screen_failed: false,
  };
  const scrub = (text: string) => {
    const result = credentials.removeLines(text);
    if (result.removed) warnings.credential_removed = true;
    return result.text;
  };
  const order = (entry: Positioned) => (subagent ? entry.at ?? entry.index : entry.index);

  if (authority.users.length === 0 && gate.feedback.length === 0 &&
    !authority.compactions.some((compaction) => compaction.summary.trim() || compaction.recentUsers.length > 0)) {
    throw new Ineligible("context-no-human");
  }

  const items: Item[] = [];
  const user = (text: string) => text;
  for (const entry of authority.users) {
    items.push({ tier: 1, target: "user_messages", source: "user_message", id: entry.id, order: order(entry), text: scrub(entry.text), entry: user });
  }
  for (const entry of gate.feedback) {
    tags.add("live-feedback");
    items.push({ tier: 1, target: "user_messages", source: "user_message", id: null, order: entry.order, text: scrub(entry.text), entry: user });
  }
  for (const refusal of gate.prior) {
    const { order: refusalOrder, ...shown } = refusal;
    tags.add("refusal-lifted");
    items.push({
      tier: 1, target: "prior_refusals", source: "prior_refusal", id: null, order: refusalOrder, text: shown.feedback ?? "",
      entry: (text) => ({ ...shown, feedback: shown.feedback === null ? null : text }),
    });
  }
  if (subagent) {
    for (const entry of target.users) {
      items.push({ tier: 1, target: "delegated_task", source: "delegated_task", id: entry.id, order: order(entry), text: scrub(entry.text), entry: user });
    }
  }
  const compactions: Array<[CompactionEntry, boolean]> = [
    ...authority.compactions.map((entry) => [entry, true] as [CompactionEntry, boolean]),
    ...(subagent ? target.compactions.map((entry) => [entry, false] as [CompactionEntry, boolean]) : []),
  ];
  for (const [entry, own] of compactions) {
    items.push({
      tier: 2, target: "compaction_context", source: "compaction_summary", id: entry.id, order: Infinity,
      text: scrub(requirementsFirst(entry.summary)), entry: (text) => ({ summary: text }),
    });
    entry.recentUsers.forEach((text, position) => {
      tags.add("compaction-recent");
      // In a subagent session, even the verbatim user parts were written by another agent.
      items.push(own
        ? { tier: 2, target: "compaction_recent_user", source: "compaction_recent_user", id: entry.id, order: position, text: scrub(text), entry: user }
        : { tier: 1, target: "delegated_task", source: "delegated_task", id: entry.id, order: -Infinity, text: scrub(text), entry: user });
    });
  }
  const seenSkills = new Set<string>();
  const skills = [...target.skills, ...(root?.skills ?? [])];
  for (const skill of skills) {
    const key = JSON.stringify([skill.name, createHash("sha256").update(skill.text).digest("hex")]);
    if (seenSkills.has(key)) continue;
    seenSkills.add(key);
    tags.add(skill.source === "agent" ? "agent-skill" : "skills");
    const name = scrub(skill.name);
    items.push({
      tier: 3, target: "skills", source: "skill", id: name, order: order(skill), text: scrub(skill.text),
      entry: (text) => ({ name, source: skill.source, text }),
    });
  }
  const binary: Array<{ name: string; mime: string }> = [];
  for (const attachment of [...target.attachments, ...(root?.attachments ?? [])]) {
    tags.add("attachments");
    const name = scrub(attachment.name);
    const mime = scrub(attachment.mime);
    if (attachment.text === undefined) {
      warnings.binary_attachments = true;
      if (binary.length < MAX_BINARY_MARKERS) binary.push({ name, mime });
      continue;
    }
    items.push({
      tier: 4, target: "attachments", source: "attachment", id: name, order: order(attachment), text: scrub(attachment.text),
      entry: (text) => ({ name, mime, text }),
    });
  }
  if (subagent) tags.add("subagent");
  if (input.warnings.forked) tags.add("fork");

  const lists: Record<Target, Array<{ order: number; entry: unknown }>> = {
    user_messages: [], prior_refusals: [], delegated_task: [], compaction_context: [], compaction_recent_user: [], skills: [], attachments: [],
  };
  const coverage: CoverageEntry[] = [];
  const leftovers: Array<Leftover & { tier: number }> = [];
  const state = () => ({
    pending_action: action,
    context_warnings: warnings,
    user_messages: lists.user_messages.map((item) => item.entry),
    prior_refusals: lists.prior_refusals.map((item) => item.entry),
    ...(subagent ? { delegated_task: lists.delegated_task.map((item) => item.entry) } : {}),
    compaction_context: lists.compaction_context.map((item) => item.entry),
    compaction_recent_user: lists.compaction_recent_user.map((item) => item.entry),
    skills: lists.skills.map((item) => item.entry),
    attachments: lists.attachments.map((item) => item.entry),
    binary_attachments: binary,
    restriction_excerpts: [] as Excerpt[],
    coverage: [] as CoverageEntry[],
  });
  // Room for excerpts and the coverage list.
  const reserve = Math.min(16_000, Math.max(2_000, Math.floor(input.budget * 0.2)));
  let remaining = input.budget - jsonBytes(state()) - reserve;
  let blocked = false;
  for (const tier of [1, 2, 3, 4] as const) {
    const tierItems = items.filter((item) => item.tier === tier).sort((a, b) => b.order - a.order);
    for (const item of tierItems) {
      const label = item.source === "skill" || item.source === "attachment" ? `${item.source}:${item.id}` : item.source;
      const cut = cutText(item.text);
      const entry = item.entry(cut.text);
      const size = jsonBytes(entry) + 1;
      if (!blocked && size <= remaining) {
        remaining -= size;
        lists[item.target].push({ order: item.order, entry });
        if (cut.omitted !== undefined) {
          coverage.push({ source: item.source, id: safeLabel(item.id), status: "cut", characters: Array.from(cut.omitted).length });
          leftovers.push({ tier, source: label, order: item.order, text: cut.omitted });
        }
        continue;
      }
      blocked = true;
      coverage.push({ source: item.source, id: safeLabel(item.id), status: "omitted", characters: Array.from(item.text).length });
      leftovers.push({ tier, source: label, order: item.order, text: item.text });
    }
  }
  for (const list of Object.values(lists)) list.sort((a, b) => a.order - b.order);
  if (coverage.length) tags.add("cut");
  if (warnings.credential_removed) tags.add("credential-removed");

  const shownCoverage = coverage.length <= MAX_COVERAGE ? coverage : [
    ...coverage.slice(0, MAX_COVERAGE - 1),
    { source: "other" as const, id: null, status: "omitted" as const, characters: coverage.slice(MAX_COVERAGE - 1).reduce((sum, entry) => sum + entry.characters, 0) },
  ];
  const tokens = commandTokens(action.requested_command);
  const names = tokenMatcher(tokens);
  const candidates: Array<Excerpt & { named: boolean; order: number }> = [];
  const seen = new Set<string>();
  for (const leftover of leftovers) {
    let taken = 0;
    for (const raw of leftover.text.split("\n")) {
      const line = raw.trim();
      if (!line || taken === MAX_EXCERPTS_PER_ITEM) continue;
      const named = names(line);
      if (!named && !RESTRICTION.test(line)) continue;
      const text = line.length > MAX_EXCERPT_CHARS ? `${Array.from(line).slice(0, MAX_EXCERPT_CHARS).join("")}…` : line;
      if (seen.has(text)) continue;
      seen.add(text);
      taken++;
      candidates.push({ source: leftover.source, text, named, order: leftover.order });
    }
  }
  candidates.sort((a, b) => Number(b.named) - Number(a.named) || b.order - a.order);
  const built = state();
  built.coverage = shownCoverage;
  let size = jsonBytes(built);
  let dropped = 0;
  for (const { source, text } of candidates) {
    const excerpt = { source, text };
    const added = jsonBytes(excerpt) + 1;
    if (size + added > input.budget) {
      dropped += Array.from(text).length;
      continue;
    }
    built.restriction_excerpts.push(excerpt);
    size += added;
  }
  if (dropped) built.coverage.push({ source: "restriction_excerpts", id: null, status: "omitted", characters: dropped });
  const identity = createHash("sha256")
    .update(JSON.stringify({ ids: target.ids, rootIDs: root?.ids ?? null, state: built }))
    .digest("hex");
  return {
    state: built,
    identity,
    tags,
    leftovers: leftovers.filter((leftover) => leftover.tier > 1).map(({ tier: _tier, ...leftover }) => leftover),
    tokens,
  };
}
