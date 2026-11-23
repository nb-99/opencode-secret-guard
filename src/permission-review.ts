/**
 * Optional, approval-only review of OpenCode V2 permission prompts by TypeSafe's
 * System One model Jev, served through OpenCode Zen, or another backend.
 *
 * Only an incoming `ask` is reviewed, and the only change this module ever makes
 * is `ask` -> `allow` for that one evaluation: never `deny`, never a saved rule.
 * Code owns the decision; the model answers narrow yes/no questions and every
 * failure, gap or doubt leaves the prompt in place. The deterministic guard runs
 * in its own hooks and is not consulted or relaxed here.
 *
 * The thresholds below are not calibrated against labelled data; they are
 * deliberately strict starting points.
 */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { GUARD_REVISION } from "./build-info.ts";
import { inspectScratchRoot, inScratch, sameScratchRoot } from "./scratch-paths.ts";
import { DEFAULT_PERMISSION_REVIEW, type PermissionReviewMode, type PermissionReviewSettings } from "./policy.ts";
import { formatNote, LOG_UNAVAILABLE_NOTE, PAYLOAD_LOG_UNAVAILABLE_NOTE } from "./review-notes.ts";
import { fileReviewLog, PAYLOAD_LOG_LIMITS, payloadLogPath, reviewLogPath, type ReviewLogWriter, type ReviewRecord } from "./review-log.ts";
import {
  approvalBasis, authorizationScore, explanationText, MAX_RATIONALE_CHARS, MAX_SUMMARY_CHARS, negativeThreshold, positiveThreshold,
  type ApprovalBasis, type ReviewExplanation, type ReviewScores,
} from "./review-status.ts";
import { setupReviewStatus, type ReviewRpcContext } from "./review-rpc.ts";
import { COMPACTED_QUESTIONS, QUESTION_NAMES, REVIEW_QUESTIONS } from "./review-questions.ts";
import { needsExplicitConsent } from "./review-consent.ts";
import {
  createReviewBackend,
  Ineligible,
  PROMPT_VERSION,
  within,
  type ReviewAnswers,
  type ReviewFetch,
  type ReviewRequest,
  type ReviewUsage,
} from "./review-backends.ts";
import {
  buildEvidence,
  credentialCheck,
  effectiveDirectory,
  parseContext,
  refusalGate,
  tokenMatcher,
  type ActionEvidence,
  type ContextWarnings,
  type CredentialCheck,
  type EvidenceTag,
  type LiveRefusals,
  type ParsedContext,
  type RefusedCall,
  type ReviewAction,
  type SecretNames,
  type SkipDetail,
} from "./review-evidence.ts";
import { createScreenCache, runScreen, SCREEN_DEADLINE_SHARE, SCREEN_MIN_REMAINING_MS } from "./review-screen.ts";
export { REVIEW_QUESTIONS } from "./review-questions.ts";
export { SYSTEM_ONE_ENDPOINT, SYSTEM_ONE_MODEL } from "./review-backends.ts";
export type { ReviewFetch } from "./review-backends.ts";
export type { SecretNames } from "./review-evidence.ts";

/** Covers session lookup, context, credential resolution and the request. */
const REVIEW_DEADLINE_MS = 10_000;
/** Reviews beyond this wait in order; the wait counts against each review's deadline. */
const MAX_CONCURRENT_REVIEWS = 4;
const PENDING_TTL_MS = 15 * 60_000;
const MAX_PENDING_CALLS = 512;
const MAX_UNSAFE_CALLS = 1_024;
/** Open permission requests remembered to map a reject to its call. */
const MAX_ASKED = 1_024;
/** The reply codes of v2.0.20 schema permission.ts. */
const REPLIES = new Set(["once", "always", "reject"]);
/** Sessions paused by a live reject. When full, every other session waits for its user too. */
const MAX_PAUSED_SESSIONS = 1_024;
/** Sessions whose refused calls are kept as evidence, and calls kept per session. */
const MAX_REFUSED_CALL_SESSIONS = 1_024;
const MAX_REFUSED_CALLS = 8;
/** Parent lookups from a subagent session to its root. */
const MAX_ANCESTRY = 4;
/** Display-only cache of subagent -> root session IDs for TUI rollup. */
const MAX_DISPLAY_ROOTS = 1_024;
const DISPLAY_ROOT_TIMEOUT_MS = 500;
/** Attempts to shrink the evidence until the request fits the backend's limit. */
const FIT_ATTEMPTS = 4;

const MAX_COMMAND_CHARS = 4_000;
const MAX_FIELD_CHARS = 1_000;
const MAX_RESOURCES = 16;

type MaybePromise = void | Promise<void>;

export interface PermissionEvaluation {
  readonly sessionID: string;
  readonly agent?: string;
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  readonly metadata?: Record<string, unknown>;
  readonly source?: { readonly type: string; readonly messageID: string; readonly id: string };
  effect: "allow" | "ask" | "deny";
  message?: string;
}

/** Identifies one tool call; V2 sends it on both execute hooks and in `permission.source`. */
export interface ToolCallIdentity {
  readonly sessionID?: string;
  readonly agent?: string;
  readonly messageID?: string;
  readonly id?: string;
}

export interface ToolCallBefore extends ToolCallIdentity {
  tool: string;
  input: unknown;
}

/** The V2 context members the reviewer needs; only touched when it is enabled. */
export interface ReviewContext extends ReviewRpcContext {
  readonly tool: {
    hook(name: "execute.before", callback: (event: ToolCallBefore) => MaybePromise): Promise<unknown>;
    hook(name: "execute.after", callback: (event: ToolCallIdentity & { tool: string }) => MaybePromise): Promise<unknown>;
  };
  readonly permission?: {
    hook(name: "evaluate", callback: (event: PermissionEvaluation) => MaybePromise): Promise<unknown>;
  };
  readonly session?: {
    get(input: { sessionID: string }): Promise<unknown>;
    context(input: { sessionID: string }): Promise<unknown>;
  };
  readonly integration?: {
    readonly connection?: {
      active(integrationID: string): Promise<unknown>;
      resolve(connection: unknown): Promise<unknown>;
    };
  };
  /** v2.0.20 `packages/plugin/src/promise/event.ts`: events arrive unwrapped as `{ type, data, ... }`. */
  readonly event?: {
    subscribe(input: { signal: AbortSignal }): AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  };
  /** v2.2.5+: stateless generation. A missing method makes the `opencode` API that needs it fail closed. */
  readonly experimental?: {
    readonly generate?: {
      decisions?(input: unknown): Promise<unknown>;
      text?(input: unknown): Promise<unknown>;
    };
  };
  /** v2.2.6: stateless chat generation outside `experimental`, preferred when present. */
  readonly generate?: {
    text?(input: unknown): Promise<unknown>;
  };
  /** v2.3.0 plugin `App`; only the version is read, for the decision log. */
  readonly app?: { readonly version?: unknown };
}

/** v2.0.20 plugin `Cleanup`. */
export type ReviewCleanup = () => void;

export interface ReviewDependencies {
  fetch: ReviewFetch;
  deadlineMs: number;
  now: () => number;
  log: (line: string) => void;
  /** The decision log; see review-log.ts. */
  record: ReviewLogWriter;
  logPath: string;
  /** The opt-in payload log, written only with `logPayloads`. */
  recordPayload: ReviewLogWriter;
  payloadLogPath: string;
}

const defaultDependencies = (): ReviewDependencies => {
  const logPath = reviewLogPath();
  const payloadPath = payloadLogPath();
  return {
    fetch: (globalThis as unknown as { fetch: ReviewFetch }).fetch,
    deadlineMs: REVIEW_DEADLINE_MS,
    now: Date.now,
    log: (line) => process.stderr.write(`secret-guard: permission review: ${line}\n`),
    record: fileReviewLog(logPath),
    logPath,
    recordPayload: fileReviewLog(payloadPath, PAYLOAD_LOG_LIMITS),
    payloadLogPath: payloadPath,
  };
};

/** A safe identifier for correlation, or null; host ids are not trusted to be short or plain. */
const safeID = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : null);
const safeAction = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(value) ? value : "other");
const safeVersion = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9._+-]{1,40}$/.test(value) ? value : null);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The decision this module reports. Only `explanation` carries content: model-written text. */
export type ReviewOutcome = {
  allow: boolean; proposed?: "allow" | "ask"; reason: string; score?: number; scores?: ReviewScores;
  explanation?: ReviewExplanation; contextWarnings?: ContextWarnings;
  /** The approval relied on the user naming a remote or publishing action. */
  remoteNamed?: boolean;
  /** Why the approved action needed no further authorization. */
  basis?: ApprovalBasis;
  /** Only the user's request could authorize the action. */
  explicitOnly?: boolean;
};

const ask = (reason: string): ReviewOutcome => ({ allow: false, reason });

/**
 * The model's explanation as the terminal shows it, or nothing. It is checked
 * for credentials before and after cleaning, so a cut cannot hide a match.
 */
function shownExplanation(raw: ReviewExplanation | undefined, credentials: CredentialCheck): ReviewExplanation | undefined {
  if (!raw) return undefined;
  const summary = explanationText(raw.summary, MAX_SUMMARY_CHARS);
  const rationale = explanationText(raw.rationale, MAX_RATIONALE_CHARS);
  if (!summary || !rationale) return undefined;
  return [raw.summary, raw.rationale, summary, rationale].some(credentials.any) ? undefined : { summary, rationale };
}

const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * Only shell calls are eligible, including their external-access requests.
 * An edit or write is judged by content this module does not export, so it
 * stays a prompt, as do patches, MCP tools and anything else. A real token
 * format keeps the prompt. A generic or configured `name=value` has its value
 * removed only when the value is one plain word; any other match keeps the
 * prompt, so the removal never hides part of what runs.
 */
function actionEvidence(
  evaluation: PermissionEvaluation,
  tool: string,
  input: unknown,
  location: string,
  credentials: CredentialCheck,
): { action: ActionEvidence; redacted: boolean } {
  let redacted = false;
  const field = (value: unknown, limit: number, what: string): string => {
    if (typeof value !== "string" || value.length === 0) throw new Ineligible(`${what}-missing`);
    if (value.length > limit) throw new Ineligible(`${what}-oversize`);
    if (credentials.token(value)) throw new Ineligible(`${what}-credential`);
    const shown = credentials.redactValues(value);
    if (credentials.any(shown)) throw new Ineligible(`${what}-credential`);
    if (shown !== value) redacted = true;
    return shown;
  };
  if (!isRecord(input)) throw new Ineligible("input-shape");
  if (evaluation.resources.length === 0 || evaluation.resources.length > MAX_RESOURCES) {
    throw new Ineligible("resources-bounds");
  }
  const resources = evaluation.resources.map((resource) => field(resource, MAX_COMMAND_CHARS, "resource"));
  const name = tool.toLowerCase();
  if ((evaluation.action !== "shell" && evaluation.action !== "external_directory") || name !== "shell") {
    throw new Ineligible("action-unsupported");
  }
  const command = field(input.command, MAX_COMMAND_CHARS, "command");
  if (input.workdir !== undefined) field(input.workdir, MAX_FIELD_CHARS, "workdir");
  const workdir = input.workdir as string | undefined;
  const cwd = field(effectiveDirectory(location, workdir), MAX_FIELD_CHARS, "cwd");
  return {
    action: {
      kind: "shell",
      permission_action: evaluation.action,
      requested_command: command,
      requested_cwd: cwd,
      project_directory: location,
      permission_resources: resources,
    },
    redacted,
  };
}

/**
 * `threshold` is validated by the policy: 0.5 < t <= 1. A negative answer
 * must stay at or below 1 - t, computed in decimal at t's own precision, so
 * t = 0.93 gives exactly 0.07 rather than 0.06999...; at t = 1 the limit is
 * 0 and any positive p asks. A JSON number in (0.5, 1] prints without an
 * exponent, so its decimal digits are its precision.
 *
 * A remote or publishing effect passes when the user named the action and
 * its target. Data loss, security, credentials and production stay manual.
 * An action the user did not ask for passes only when it reads, or changes
 * only local state that can be undone, and has no remote effect. With
 * `explicitOnly`, only the user's request authorizes it. With `explains`
 * (the `text` API), positive checks use `positiveThreshold(threshold, true)`
 * while negative safety checks keep the strict `negativeThreshold(threshold)`.
 */
export function decide(
  answers: ReviewAnswers,
  threshold = DEFAULT_PERMISSION_REVIEW.confidenceThreshold,
  explicitOnly = false,
  explains = false,
): ReviewOutcome {
  const positive = positiveThreshold(threshold, explains);
  const negativeLimit = negativeThreshold(threshold);
  const scores = Object.fromEntries(QUESTION_NAMES.map((name) => [name, answers[name].noul])) as ReviewScores;
  const remote = scores.remote_effect > negativeLimit;
  // Display only: the comparisons below decide, not this score.
  const score = Math.min(
    authorizationScore(scores, threshold, explicitOnly),
    scores.within_scope,
    1 - scores.confirmation_required,
    1 - scores.sensitive_effect,
    Math.max(1 - scores.remote_effect, scores.named_by_user),
  );
  const only = explicitOnly ? { explicitOnly } : {};
  const scored = (reason: string): ReviewOutcome => ({ allow: false, reason, score, scores, ...only });
  const basis = approvalBasis(scores, threshold, explicitOnly, explains);
  if (scores.confirmation_required > negativeLimit) return scored("model-confirmation-required");
  if (scores.sensitive_effect > negativeLimit) return scored("model-sensitive-effect");
  if (remote && scores.named_by_user < positive) return scored("model-remote-unnamed");
  if (!basis) return scored("model-not-authorized");
  if (scores.within_scope < positive) return scored("model-out-of-scope");
  return { allow: true, reason: "model-approved", score, scores, basis, ...only, ...(remote ? { remoteNamed: true } : {}) };
}

async function apiKey(ctx: ReviewContext, signal: AbortSignal): Promise<string> {
  const connection = ctx.integration?.connection;
  if (!connection) throw new Ineligible("auth-unsupported");
  // Host errors carry arbitrary text and are reduced to a code.
  // A thunk, so a host method that throws synchronously is caught the same way.
  const host = <T>(call: () => Promise<T>) =>
    within(Promise.resolve().then(call), signal).catch((error) => {
      throw error instanceof Ineligible || signal.aborted ? error : new Ineligible("auth-error");
    });
  const active = await host(() => connection.active("opencode"));
  if (active === undefined || active === null) throw new Ineligible("auth-no-connection");
  const credential = await host(() => connection.resolve(active));
  if (!isRecord(credential)) throw new Ineligible("auth-unresolved");
  if (credential.type !== "key") throw new Ineligible("auth-not-key");
  if (typeof credential.key !== "string" || !credential.key.trim()) throw new Ineligible("auth-empty-key");
  return credential.key.trim();
}

/**
 * A first-come slot queue. Resolves true when the review had to wait. A
 * review whose signal aborts while it waits leaves the queue as `busy`.
 */
export function createSlots(limit: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return {
    acquire(signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return Promise.reject(new Ineligible("busy"));
      if (running < limit) {
        running++;
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve, reject) => {
        const grant = () => {
          signal.removeEventListener("abort", abort);
          resolve(true);
        };
        const abort = () => {
          const index = waiting.indexOf(grant);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Ineligible("busy"));
        };
        waiting.push(grant);
        signal.addEventListener("abort", abort, { once: true });
      });
    },
    /** Hands the slot to the next waiting review, if any. */
    release() {
      const next = waiting.shift();
      if (next) next();
      else running--;
    },
  };
}

interface PendingCall {
  event: ToolCallBefore;
  seen: number;
  /** Original scratch resources to recheck; null if any external access was not verified as scratch. */
  externalResources?: string[] | null;
  /**
   * Each permission action is attempted before its first await. V2 repeats
   * pending evaluations after an "always" reply; repeats must not gain approval.
   */
  attempted?: Set<ReviewAction>;
}

const pendingKey = (sessionID: unknown, messageID: unknown, id: unknown) =>
  typeof sessionID === "string" && typeof messageID === "string" && typeof id === "string"
    ? JSON.stringify([sessionID, messageID, id])
    : undefined;

/** The call as it would run now; reading through the event follows later rewrites. */
function snapshot(event: ToolCallBefore): { tool: string; input: unknown; text: string } {
  const tool = event.tool;
  const input = event.input;
  if (typeof tool !== "string") throw new Ineligible("call-shape");
  let text: string;
  try {
    text = JSON.stringify([tool, input]);
  } catch {
    throw new Ineligible("call-unserialisable");
  }
  return { tool, input: JSON.parse(text)[1], text };
}

/** The pending session and, for a subagent session, its root. */
interface SessionChain {
  /** Location and ancestry; the final recheck compares it. */
  readonly identity: string;
  /** The root session of a subagent session, where the user writes. */
  readonly rootID?: string;
  readonly forked: boolean;
}

/**
 * A session in this plugin's location. A subagent session follows `parentID`
 * to its root; a fork reviews with its own copied history. A fork of a
 * subagent session follows the subagent rules.
 */
async function resolveSession(
  sessions: NonNullable<ReviewContext["session"]>,
  sessionID: string,
  location: string,
  signal: AbortSignal,
): Promise<SessionChain> {
  const session = await within(sessions.get({ sessionID }), signal);
  if (!isRecord(session) || session.id !== sessionID) throw new Ineligible("session-unknown");
  // v2.0.20 Session.Info: `location.directory` is absolute; `subpath` is separate.
  if (!isRecord(session.location) || session.location.directory !== location) throw new Ineligible("session-location");
  if (session.subpath !== undefined && session.subpath !== null && session.subpath !== "") {
    throw new Ineligible("session-subpath");
  }
  const forked = session.fork !== undefined && session.fork !== null;
  const place = [session.location.directory, session.location.workspaceID ?? null];
  const chain = [sessionID];
  let current: Record<string, unknown> = session;
  while (current.parentID !== undefined && current.parentID !== null) {
    const parentID = current.parentID;
    if (typeof parentID !== "string" || chain.includes(parentID) || chain.length > MAX_ANCESTRY) {
      throw new Ineligible("session-ancestry");
    }
    const parent = await within(sessions.get({ sessionID: parentID }), signal).catch((error) => {
      throw error instanceof Ineligible ? error : new Ineligible("session-ancestry");
    });
    if (!isRecord(parent) || parent.id !== parentID) throw new Ineligible("session-ancestry");
    chain.push(parentID);
    current = parent;
  }
  return {
    identity: JSON.stringify([...place, chain]),
    ...(chain.length > 1 ? { rootID: chain.at(-1)! } : {}),
    forked,
  };
}

/**
 * v2.0.20 `session-event.ts` events, each with `data.sessionID`, after which a
 * review in flight may no longer reflect the human's current instructions.
 */
const INVALIDATING_EVENTS = new Set([
  "session.execution.interrupted",
  "session.deleted",
  "session.moved",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
]);

interface ActiveReview {
  readonly sessionID: string;
  /** Set once known: events for the root also cancel reviews in its subagent sessions. */
  rootSessionID?: string;
  readonly controller: AbortController;
  cancelled?: string;
}

/** What a review found, for the decision log and the status; codes and counts only. */
interface ReviewInfo {
  eligible: boolean;
  skipDetail?: SkipDetail;
  tags?: Set<EvidenceTag>;
  screen?: { chunks: number; cached: number; asked: number; selected: number; failed: boolean };
  usage?: ReviewUsage;
  /** Time spent waiting for a review slot, when the review waited. */
  queuedMs?: number;
  /** Size of the judgment request sent to the backend. */
  requestBytes?: number;
}

/**
 * Registers the reviewer and returns its cleanup. Never throws: a reviewer that
 * cannot start or loses its event stream leaves every prompt in place and the
 * guard running, and says so.
 */
export async function setupPermissionReview(
  ctx: ReviewContext,
  settings: PermissionReviewSettings & { mode: Exclude<PermissionReviewMode, "off"> },
  location: string | undefined,
  secrets: SecretNames & { readonly cleanupRoot?: string | null },
  overrides: Partial<ReviewDependencies> = {},
): Promise<ReviewCleanup | undefined> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const { mode, confidenceThreshold: threshold } = settings;
  const restrictionScreen = settings.restrictionScreen ?? DEFAULT_PERMISSION_REVIEW.restrictionScreen;
  const { log } = dependencies;
  const say = (line: string) => {
    try {
      log(line);
    } catch {
      // A failing log must not turn a review into a host error.
    }
  };
  // Whether the last write succeeded; a pending prompt reports a failing log.
  let logWritable = true;
  let logFailureReported = false;
  const record = (fields: ReviewRecord) => {
    try {
      dependencies.record({ time: new Date(dependencies.now()).toISOString(), pid: process.pid, mode, ...fields });
      logWritable = true;
    } catch {
      // The log is best effort and never affects a decision. The error text is
      // not echoed; the fixed notice says where to look. Once per reviewer.
      logWritable = false;
      if (logFailureReported) return;
      logFailureReported = true;
      say(`review log unavailable at ${dependencies.logPath}; check the directory's and file's ownership and private permissions, free space, and the rotation target. Decisions are not affected.`);
    }
  };
  let payloadWritable = true;
  let payloadFailureReported = false;
  const recordPayload = (fields: ReviewRecord) => {
    try {
      dependencies.recordPayload({ time: new Date(dependencies.now()).toISOString(), pid: process.pid, ...fields });
      payloadWritable = true;
    } catch {
      payloadWritable = false;
      if (payloadFailureReported) return;
      payloadFailureReported = true;
      say(`payload log unavailable at ${dependencies.payloadLogPath}; check the directory's and file's ownership and private permissions, free space, and the rotation target. Decisions are not affected.`);
    }
  };
  /** Fixed text only: it is recorded as is. */
  const unavailable = (line: string) => {
    record({ event: "unavailable", notice: line });
    say(line);
  };
  const { permission, session: sessions, event: events } = ctx;
  if (!permission || !sessions || !ctx.integration?.connection || !events || location === undefined) {
    unavailable("unavailable: this OpenCode does not provide the permission, session, integration and event APIs it needs; prompts are unchanged.");
    return undefined;
  }

  const generate = ctx.experimental?.generate;
  // The name outside `experimental` first.
  const textHost = ctx.generate?.text ? ctx.generate : generate;
  const backend = createReviewBackend(settings, {
    fetch: dependencies.fetch,
    apiKey: (signal) => apiKey(ctx, signal),
    decisions: generate?.decisions ? (input) => generate.decisions!(input) : undefined,
    text: textHost?.text ? (input) => textHost.text!(input) : undefined,
  });
  // A local endpoint can need longer than the 10 second default; see review-backends.ts.
  const deadlineMs = settings.endpoint?.deadlineMs ?? settings.opencode?.deadlineMs ?? dependencies.deadlineMs;
  const credentials = credentialCheck(secrets);
  const inspectScratch = () => {
    try { return secrets.cleanupRoot ? inspectScratchRoot(secrets.cleanupRoot) : undefined; }
    catch { return undefined; }
  };
  const scratchPin = inspectScratch();
  const currentScratch = () => {
    if (!scratchPin) return undefined;
    const current = inspectScratch();
    return current && sameScratchRoot(current, scratchPin) ? current : undefined;
  };
  const scratchResource = (scratch: typeof scratchPin, resource: string) =>
    inScratch(scratch, resource.endsWith("/*") ? resource.slice(0, -2) : resource);
  // Display-only cache for rolling subagent statuses/summaries up to their root
  // session. Security checks always call uncached `resolveSession`.
  const displayRoots = new Map<string, string | null>();
  const rememberDisplayRoot = (sessionID: string, rootID: string | undefined) => {
    displayRoots.delete(sessionID);
    displayRoots.set(sessionID, rootID ?? null);
    if (displayRoots.size > MAX_DISPLAY_ROOTS) displayRoots.delete(displayRoots.keys().next().value!);
  };
  const lookupDisplayRoot = async (sessionID: string): Promise<string | undefined> => {
    if (displayRoots.has(sessionID)) return displayRoots.get(sessionID) ?? undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("deadline"), Math.min(DISPLAY_ROOT_TIMEOUT_MS, deadlineMs));
    try {
      const chain = await resolveSession(sessions, sessionID, location, controller.signal);
      rememberDisplayRoot(sessionID, chain.rootID);
      return chain.rootID;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
  const screenCache = createScreenCache();
  const statuses = await setupReviewStatus(ctx);
  const pending = new Map<string, PendingCall>();
  const reviews = new Set<ActiveReview>();
  const slots = createSlots(MAX_CONCURRENT_REVIEWS);
  // Call identities that can no longer be bound to one call: two live calls
  // shared them (CodeMode children can), or a call was dropped unfinished (expiry, cap or a session event) and
  // may still be waiting while a later call reuses its identity. Kept for the
  // plugin's lifetime and never evicted; once full, no call is approved.
  const unsafe = new Set<string>();
  const poison = (key: string) => {
    if (unsafe.size < MAX_UNSAFE_CALLS) unsafe.add(key);
  };
  const isUnsafe = (key: string) => unsafe.size >= MAX_UNSAFE_CALLS || unsafe.has(key);
  const retire = (key: string) => {
    const entry = pending.get(key);
    pending.delete(key);
    if (entry?.event.tool === "shell") poison(key);
  };

  // Live rejects. A reject pauses review in its session until the user writes
  // again or gives feedback. Pauses are never evicted: when the store is full,
  // every session without an entry waits for its user after the latest reject.
  const asked = new Map<string, { sessionID: string; messageID?: string; callID?: string; action?: string }>();
  const pauses = new Map<string, number>();
  let overflowSince: number | undefined;
  let everySession = false;
  const refusedCalls = new Map<string, RefusedCall[]>();
  const liveFor = (sessionID: string): LiveRefusals => {
    const since = pauses.get(sessionID) ?? overflowSince;
    return { ...(since === undefined ? {} : { pausedSince: since }), everySession, calls: refusedCalls.get(sessionID) ?? [] };
  };
  const pause = (sessionID: string | undefined, call: RefusedCall | undefined, at: number) => {
    if (sessionID === undefined) {
      everySession = true;
      return;
    }
    if (pauses.has(sessionID) || pauses.size < MAX_PAUSED_SESSIONS) {
      pauses.delete(sessionID);
      pauses.set(sessionID, at);
    } else {
      overflowSince = at;
    }
    if (!call) return;
    const calls = [...(refusedCalls.get(sessionID) ?? []), call].slice(-MAX_REFUSED_CALLS);
    refusedCalls.delete(sessionID);
    refusedCalls.set(sessionID, calls);
    if (refusedCalls.size > MAX_REFUSED_CALL_SESSIONS) refusedCalls.delete(refusedCalls.keys().next().value!);
  };
  // Only the pause that the review saw ends; a newer reject keeps its own.
  const lift = (sessionID: string, since: number | undefined) => {
    if (since !== undefined && pauses.get(sessionID) === since) pauses.delete(sessionID);
  };

  const subscription = new AbortController();
  // Reviews run only while the event stream is live; without it a change of
  // instructions could go unnoticed.
  let live = false;

  const cancelSession = (sessionID: string | undefined, reason: string) => {
    for (const active of reviews) {
      if (sessionID !== undefined && active.sessionID !== sessionID && active.rootSessionID !== sessionID) continue;
      active.cancelled = reason;
      active.controller.abort(reason);
    }
    for (const [key, entry] of pending) {
      if (sessionID === undefined || entry.event.sessionID === sessionID) retire(key);
    }
  };

  const stop = (reason: string) => {
    live = false;
    subscription.abort();
    cancelSession(undefined, reason);
  };

  const expired = (entry: PendingCall) => entry.seen < dependencies.now() - PENDING_TTL_MS;
  // Map order is insertion order, so the oldest entries go first.
  const expire = () => {
    for (const [key, entry] of pending) {
      if (expired(entry) || pending.size > MAX_PENDING_CALLS) retire(key);
    }
  };

  const review = async (
    evaluation: PermissionEvaluation,
    reviewID: string,
    started: number,
    info: ReviewInfo,
    onRequest: () => void,
    onRoot: (rootID: string | undefined) => void,
  ): Promise<ReviewOutcome> => {
    if (!live) return ask("events-unavailable");
    const source = evaluation.source;
    if (!source || source.type !== "tool") return ask("no-tool-source");
    const callKey = pendingKey(evaluation.sessionID, source.messageID, source.id);
    const call = callKey === undefined ? undefined : pending.get(callKey);
    if (!call) return ask("call-unknown");
    if (expired(call)) {
      retire(callKey!);
      return ask("call-unknown");
    }
    if (evaluation.agent !== undefined && call.event.agent !== undefined && evaluation.agent !== call.event.agent) {
      return ask("agent-mismatch");
    }
    // V2 checks external access before shell permission, including `cd` targets within the command.
    if (evaluation.action !== "shell" && evaluation.action !== "external_directory") return ask("action-unsupported");
    if (call.attempted?.has(evaluation.action)) return ask("repeat");
    call.attempted ??= new Set<ReviewAction>();
    call.attempted.add(evaluation.action);
    if (isUnsafe(callKey!)) return ask("call-ambiguous");

    const active: ActiveReview = { sessionID: evaluation.sessionID, controller: new AbortController() };
    reviews.add(active);
    const signal = active.controller.signal;
    const timer = setTimeout(() => active.controller.abort("deadline"), deadlineMs);
    const sessionID = evaluation.sessionID;
    let holding = false;
    let contextWarnings: ContextWarnings | undefined;
    let judged: ReviewOutcome | undefined;
    const withWarnings = (outcome: ReviewOutcome): ReviewOutcome =>
      ({ ...judged, ...outcome,
        ...(judged ? { proposed: judged.allow ? "allow" : "ask" } as const : {}),
        ...(contextWarnings ? { contextWarnings } : {}),
      });
    try {
      const before = snapshot(call.event);
      const { action, redacted } = actionEvidence(evaluation, before.tool, before.input, location, credentials);
      const queuedAt = dependencies.now();
      let waited = !signal.aborted;
      try {
        waited = await slots.acquire(signal);
      } finally {
        if (waited) info.queuedMs = dependencies.now() - queuedAt;
      }
      holding = true;
      info.eligible = true;
      const input = before.input as { command: string; workdir?: string };
      const cwd = effectiveDirectory(location, input.workdir);
      const externalCwd = !inside(location, cwd);
      const outside = (scratch: typeof scratchPin) =>
        (externalCwd && (input.workdir?.split(path.sep).includes("..") || !inScratch(scratch, cwd))) ||
        call.externalResources === null || (call.externalResources ?? []).some((resource) => !scratchResource(scratch, resource));
      const scratch = currentScratch();
      if (scratch && !credentials.any(scratch.root)) action.scratch_directory = scratch.root;
      const outsideProject = outside(scratch);
      const explicitOnly = outsideProject || needsExplicitConsent(input.command);
      const chain = await resolveSession(sessions, sessionID, location, signal);
      rememberDisplayRoot(sessionID, chain.rootID);
      if (chain.rootID !== undefined) {
        active.rootSessionID = chain.rootID;
        onRoot(chain.rootID);
      }
      // Credentials come before the transcript, so a missing credential never
      // causes the context to be read.
      const channel = await backend.prepare(signal);
      const read = async (): Promise<{ target: ParsedContext; root?: ParsedContext }> => {
        const [target, root] = await Promise.all([
          within(sessions.context({ sessionID }), signal),
          chain.rootID === undefined ? undefined : within(sessions.context({ sessionID: chain.rootID }), signal),
        ]);
        return { target: parseContext(target), ...(root === undefined ? {} : { root: parseContext(root) }) };
      };
      const gateFor = (contexts: { target: ParsedContext; root?: ParsedContext }) => refusalGate({
        ...contexts,
        live: liveFor(sessionID),
        ...(chain.rootID === undefined ? {} : { rootLive: liveFor(chain.rootID) }),
        action, location, credentials,
      });
      const contexts = await read();
      const pausedSince = liveFor(sessionID).pausedSince;
      const gate = gateFor(contexts);
      if (gate.skip) {
        info.skipDetail = gate.skip.detail;
        return withWarnings(ask(gate.skip.reason));
      }
      if (gate.lifted) lift(sessionID, pausedSince);
      const compacted = contexts.target.compactions.length > 0 || (contexts.root?.compactions.length ?? 0) > 0;
      const questions = compacted ? COMPACTED_QUESTIONS : REVIEW_QUESTIONS;
      const build = (parsed: { target: ParsedContext; root?: ParsedContext }, ready: typeof gate, budget: number) => buildEvidence({
        action, ...parsed, gate: ready, budget, credentials,
        warnings: { outside_project: outsideProject, forked: chain.forked, credential_removed: redacted },
      });
      // Fit the evidence to the backend's limits; the request size is measured, not estimated.
      let budget = Math.min(backend.stateBytes, backend.maxRequestBytes - backend.requestBytes({ state: {}, questions }));
      let evidence = build(contexts, gate, budget);
      for (let attempt = 1; attempt < FIT_ATTEMPTS; attempt++) {
        const over = backend.requestBytes({ state: evidence.state, questions }) - backend.maxRequestBytes;
        if (over <= 0) break;
        budget -= over + 1_024;
        evidence = build(contexts, gate, budget);
      }
      // Nothing is sent, not even the screen, when the evidence cannot fit.
      if (backend.requestBytes({ state: evidence.state, questions }) > backend.maxRequestBytes) throw new Ineligible("request-oversize");
      const state = evidence.state;
      contextWarnings = state.context_warnings;
      info.tags = evidence.tags;
      const correlation = {
        event: "payload",
        reviewID,
        sessionID: safeID(sessionID),
        messageID: safeID(source.messageID),
        callID: safeID(source.id),
        model: backend.model,
      };
      const trace = settings.logPayloads ? (fields: ReviewRecord) => recordPayload({ ...correlation, ...fields }) : undefined;

      const remainingMs = deadlineMs - (dependencies.now() - started);
      if (restrictionScreen && evidence.leftovers.length > 0 && remainingMs >= SCREEN_MIN_REMAINING_MS) {
        const screenController = new AbortController();
        const stopScreen = () => screenController.abort(typeof signal.reason === "string" ? signal.reason : "deadline");
        signal.addEventListener("abort", stopScreen, { once: true });
        const screenTimer = setTimeout(() => screenController.abort("deadline"), Math.floor(remainingMs * SCREEN_DEADLINE_SHARE));
        try {
          const result = await runScreen({
            backend, channel, cache: screenCache, leftovers: evidence.leftovers, names: tokenMatcher(evidence.tokens),
            call: { signal: screenController.signal, trace, onRequest, label: "screen" },
            room: budget - Buffer.byteLength(JSON.stringify(state)),
          });
          info.screen = { chunks: result.chunks, cached: result.cached, asked: result.asked, selected: result.selected, failed: result.failed };
          evidence.tags.add("screen");
          if (result.failed) state.context_warnings.screen_failed = true;
          state.restriction_excerpts.push(...result.excerpts);
          if (result.unscreened) {
            state.coverage.push({ source: "restriction_screen", id: null, status: "omitted", characters: result.unscreenedCharacters });
          }
          // Excerpts give way if the request is too large, the screen's first.
          while (state.restriction_excerpts.length && backend.requestBytes({ state, questions }) > backend.maxRequestBytes) {
            state.restriction_excerpts.pop();
          }
        } finally {
          clearTimeout(screenTimer);
          signal.removeEventListener("abort", stopScreen);
        }
        if (signal.aborted) throw new Ineligible("deadline");
      }

      const request: ReviewRequest = { state, questions };
      info.requestBytes = backend.requestBytes(request);
      const judgment = await channel.judge(request, { signal, trace, onRequest });
      if (judgment.usage) info.usage = judgment.usage;
      const explanation = shownExplanation(judgment.explanation, credentials);
      const outcome = judged = { ...decide(judgment.answers, threshold, explicitOnly, backend.api === "text"), ...(explanation ? { explanation } : {}) };
      if (outcome.remoteNamed) evidence.tags.add("remote-named");
      if (!outcome.allow) return withWarnings(outcome);
      // What was reviewed must still be what runs, in the same session state:
      // events can be missed, so the sessions and their evidence are read
      // again within the same deadline.
      if ((await resolveSession(sessions, sessionID, location, signal)).identity !== chain.identity) {
        return withWarnings(ask("session-changed"));
      }
      const fresh = await read();
      const freshGate = gateFor(fresh);
      if (freshGate.skip) return withWarnings(ask(freshGate.skip.reason));
      if (build(fresh, freshGate, budget).identity !== evidence.identity) return withWarnings(ask("context-changed"));
      if (signal.aborted) return withWarnings(ask(active.cancelled ?? "deadline"));
      if (pending.get(callKey!) !== call) return withWarnings(ask("call-ended"));
      if (isUnsafe(callKey!)) return withWarnings(ask("call-ambiguous"));
      if (snapshot(call.event).text !== before.text) return withWarnings(ask("call-changed"));
      if (!outsideProject && (externalCwd || call.externalResources !== undefined) && outside(currentScratch())) {
        return withWarnings(ask("scratch-changed"));
      }
      return withWarnings(outcome);
    } catch (error) {
      if (active.cancelled) return withWarnings(ask(active.cancelled));
      if (error instanceof Ineligible) return withWarnings(ask(error.message));
      if (signal.aborted) return withWarnings(ask("deadline"));
      return withWarnings(ask(error instanceof Error && error.name === "AbortError" ? "deadline" : "error"));
    } finally {
      clearTimeout(timer);
      // Releases any response body still open, including one refused unread.
      active.controller.abort();
      reviews.delete(active);
      if (holding) slots.release();
    }
  };

  /** A reject, mapped to its call when the request was seen; the call survives compaction. */
  const rejected = (data: Record<string, unknown>) => {
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
    const requestID = typeof data.requestID === "string" ? data.requestID : undefined;
    const request = requestID === undefined ? undefined : asked.get(requestID);
    if (requestID !== undefined) asked.delete(requestID);
    const at = dependencies.now();
    let call: RefusedCall | undefined;
    if (request && request.sessionID === sessionID && request.messageID && request.callID) {
      const tracked = pending.get(pendingKey(sessionID, request.messageID, request.callID) ?? "")?.event;
      const input = tracked && isRecord(tracked.input) ? tracked.input : undefined;
      const shell = tracked?.tool === "shell" && input !== undefined;
      const command = shell && typeof input!.command === "string" ? input!.command : undefined;
      const workdir = shell && typeof input!.workdir === "string" ? input!.workdir : undefined;
      const tool = tracked?.tool ?? request.action;
      call = {
        messageID: request.messageID,
        callID: request.callID,
        at,
        ...(tool === undefined ? {} : { tool }),
        ...(command === undefined ? {} : { command, directory: effectiveDirectory(location, workdir) }),
      };
    }
    pause(sessionID, call, at);
    cancelSession(sessionID, "session-rejected");
  };

  try {
    const stream = await events.subscribe({ signal: subscription.signal });
    live = true;
    void (async () => {
      try {
        for await (const event of stream) {
          if (!isRecord(event) || typeof event.type !== "string") continue;
          const data = isRecord(event.data) ? event.data : undefined;
          const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined;
          // v2.0.20 schema permission.ts: ephemeral `permission.asked` {id, sessionID, action, resources, source}.
          if (event.type === "permission.asked") {
            const source = isRecord(data?.source) ? data.source : undefined;
            if (typeof data?.id !== "string" || sessionID === undefined) continue;
            asked.delete(data.id);
            asked.set(data.id, {
              sessionID,
              ...(typeof source?.messageID === "string" ? { messageID: source.messageID } : {}),
              ...(typeof source?.id === "string" ? { callID: source.id } : {}),
              ...(typeof data.action === "string" ? { action: data.action } : {}),
            });
            if (asked.size > MAX_ASKED) asked.delete(asked.keys().next().value!);
            continue;
          }
          // Ephemeral `permission.replied` {sessionID, requestID, reply}.
          if (event.type === "permission.replied") {
            const requestID = typeof data?.requestID === "string" ? data.requestID : undefined;
            const request = requestID === undefined ? undefined : asked.get(requestID);
            // Only identifiers and a fixed code: the decision log holds no content.
            if (request && REPLIES.has(data?.reply as string)) {
              record({
                event: "reply", reply: data!.reply as string, action: safeAction(request.action), sessionID: safeID(request.sessionID),
                messageID: safeID(request.messageID), callID: safeID(request.callID),
              });
            }
            if (data?.reply === "reject") rejected(data);
            else if (requestID !== undefined) asked.delete(requestID);
            continue;
          }
          if (!INVALIDATING_EVENTS.has(event.type)) continue;
          if (event.type === "session.deleted" || event.type === "session.moved") {
            if (sessionID === undefined) displayRoots.clear();
            else displayRoots.delete(sessionID);
          }
          // An event the reviewer cannot attribute could concern any session.
          cancelSession(sessionID, "session-event");
        }
      } catch {
        // Reported below.
      }
      if (subscription.signal.aborted) return;
      stop("events-ended");
      unavailable("unavailable: the OpenCode event stream ended; prompts are unchanged.");
    })();

    await ctx.tool.hook("execute.before", (event) => {
      const key = pendingKey(event.sessionID, event.messageID, event.id);
      // Track all live calls so another tool cannot lend its external request to a shell call.
      if (!live || key === undefined) return;
      const existing = pending.get(key);
      // Only collisions involving shell calls can confuse an eligible review.
      if (existing) {
        if (existing.event.tool === "shell" || event.tool === "shell") poison(key);
        return;
      }
      if (isUnsafe(key)) return;
      pending.set(key, { event, seen: dependencies.now() });
      expire();
    });
    await ctx.tool.hook("execute.after", (event) => {
      // A different tool sharing the identity must not clear the tracked call.
      const key = pendingKey(event.sessionID, event.messageID, event.id);
      if (key !== undefined && pending.get(key)?.event.tool === event.tool) pending.delete(key);
    });
    await permission.hook("evaluate", async (evaluation) => {
      if (evaluation.action === "external_directory" && evaluation.effect !== "deny" && evaluation.source?.type === "tool") {
        const key = pendingKey(evaluation.sessionID, evaluation.source.messageID, evaluation.source.id);
        const call = key === undefined ? undefined : pending.get(key);
        if (call && (evaluation.agent === undefined || call.event.agent === undefined || evaluation.agent === call.event.agent)) {
          if (call.externalResources !== null) {
            const previous = call.externalResources ?? [];
            const resources = evaluation.resources;
            const scratch = currentScratch();
            call.externalResources = scratch && resources.length > 0 && previous.length + resources.length <= MAX_RESOURCES &&
              resources.every((resource) => typeof resource === "string" && resource.length <= MAX_COMMAND_CHARS && scratchResource(scratch, resource))
              ? [...previous, ...resources] : null;
          }
        }
      }
      if (evaluation.effect !== "ask") return;
      const started = dependencies.now();
      const reviewID = randomUUID();
      const action = safeAction(evaluation.action);
      let rootSessionID = safeID(displayRoots.get(evaluation.sessionID)) ?? undefined;
      const withRoot = () => (rootSessionID && rootSessionID !== evaluation.sessionID ? { rootSessionID } : {});
      const identity = {
        reviewID, sessionID: evaluation.sessionID,
        workspaceID: safeID(ctx.location?.workspaceID),
        messageID: safeID(evaluation.source?.messageID), callID: safeID(evaluation.source?.id),
        action, mode, startedAt: started, threshold,
        explains: backend.api === "text", toasts: settings.toasts,
      };
      let modelCalled = false;
      const info: ReviewInfo = { eligible: false };
      statuses.publish({ ...identity, ...withRoot(), phase: "checking", modelCalled, elapsedMs: 0 });
      let outcome: ReviewOutcome;
      try {
        outcome = await review(
          evaluation,
          reviewID,
          started,
          info,
          () => {
            if (modelCalled) return;
            modelCalled = true;
            statuses.publish({ ...identity, ...withRoot(), phase: "evaluating", modelCalled, elapsedMs: Math.max(0, dependencies.now() - started) });
          },
          (rootID) => {
            rootSessionID = safeID(rootID) ?? rootSessionID;
          },
        );
      } catch {
        outcome = ask("error");
      }
      if (
        rootSessionID === undefined &&
        !info.eligible &&
        !displayRoots.has(evaluation.sessionID) &&
        live &&
        (evaluation.action === "shell" || evaluation.action === "external_directory") &&
        dependencies.now() - started < deadlineMs
      ) {
        rootSessionID = safeID(await lookupDisplayRoot(evaluation.sessionID)) ?? undefined;
      }
      const verdict = outcome.proposed ?? (outcome.allow ? "allow" : "ask");
      say(`${mode}: ${outcome.allow ? "allow" : "ask"} ${action} (${outcome.reason})`);
      // Preserve a decision changed while review was pending.
      const stillAsk = evaluation.effect === "ask";
      if (stillAsk && mode === "auto" && outcome.allow) evaluation.effect = "allow";
      // Recorded first, so the notes below reflect this write.
      record({
        event: "review",
        action,
        proposed: verdict,
        applied: evaluation.effect,
        reason: outcome.reason,
        modelCalled,
        eligible: info.eligible,
        ...(outcome.score === undefined ? {} : { score: outcome.score }),
        ...(outcome.scores === undefined ? {} : { scores: outcome.scores }),
        ...(outcome.contextWarnings === undefined ? {} : {
          contextCompacted: outcome.contextWarnings.compacted,
          outsideProject: outcome.contextWarnings.outside_project,
        }),
        ...(info.skipDetail ? { skipDetail: info.skipDetail } : {}),
        ...(info.tags ? { evidence: [...info.tags].sort() } : {}),
        ...(info.screen ? { screen: info.screen } : {}),
        ...(info.usage?.inputTokens === undefined ? {} : { inputTokens: info.usage.inputTokens }),
        ...(info.usage?.outputTokens === undefined ? {} : { outputTokens: info.usage.outputTokens }),
        ...(info.requestBytes === undefined ? {} : { requestBytes: info.requestBytes }),
        ...(info.queuedMs === undefined ? {} : { queuedMs: info.queuedMs }),
        ...(outcome.basis === undefined ? {} : { basis: outcome.basis }),
        ...(outcome.explicitOnly ? { explicitOnly: true } : {}),
        promptVersion: PROMPT_VERSION,
        threshold,
        reviewID,
        elapsedMs: dependencies.now() - started,
        sessionID: safeID(evaluation.sessionID),
        messageID: safeID(evaluation.source?.messageID),
        callID: safeID(evaluation.source?.id),
      });
      statuses.publish({
        ...identity, ...withRoot(), phase: "completed", modelCalled, elapsedMs: Math.max(0, dependencies.now() - started),
        proposed: verdict, applied: evaluation.effect, reason: outcome.reason,
        eligible: info.eligible, screened: info.screen !== undefined,
        ...(outcome.scores ? { scores: outcome.scores } : {}),
        ...(outcome.explicitOnly ? { explicitOnly: true } : {}),
        ...(outcome.explanation ? { explanation: outcome.explanation } : {}),
        ...(outcome.contextWarnings ? {
          contextWarnings: { compacted: outcome.contextWarnings.compacted, outside_project: outcome.contextWarnings.outside_project },
        } : {}),
      });
      if (evaluation.effect !== "ask") return;
      const notes: string[] = [];
      if (mode === "observe" || !outcome.allow) {
        const observed = mode === "observe" && !outcome.allow && outcome.score !== undefined ? { score: outcome.score, threshold } : undefined;
        notes.push(formatNote(mode === "observe" && outcome.allow ? "would allow" : "manual approval", outcome.reason, observed));
      }
      if (!logWritable) notes.push(LOG_UNAVAILABLE_NOTE);
      if (!payloadWritable) notes.push(PAYLOAD_LOG_UNAVAILABLE_NOTE);
      if (notes.length === 0) return;
      evaluation.message = [evaluation.message, ...notes].filter(Boolean).join("\n");
    });
  } catch {
    stop("unavailable");
    statuses.dispose();
    // Host errors can carry arbitrary text; the notice stays fixed.
    unavailable("unavailable: OpenCode refused a reviewer hook or event subscription; prompts are unchanged.");
    return undefined;
  }

  // The stream can end while the hooks register; that was reported instead.
  if (!live) return () => { stop("unloaded"); statuses.dispose(); };
  // The path stays out of the record, which holds no user paths.
  record({
    event: "start", backend: settings.backend, ...(backend.api ? { api: backend.api } : {}),
    model: backend.model, threshold, logPayloads: settings.logPayloads, restrictionScreen,
    guardVersion: GUARD_REVISION, hostVersion: safeVersion(ctx.app?.version), promptVersion: PROMPT_VERSION,
  });
  say(`${mode} with ${backend.model}, threshold ${threshold}; decision log: ${dependencies.logPath}`);
  if (settings.logPayloads) say(`request and response bodies are logged to ${dependencies.payloadLogPath}`);
  return () => { stop("unloaded"); statuses.dispose(); };
}
