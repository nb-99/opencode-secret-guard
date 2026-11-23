/** Per-session review totals and the sidebar layout built from them. */
import { guidanceFor } from "./review-notes.ts";
import {
  authorizationScore, CHECK_KEYS, MAX_REVIEW_STATUSES, parseReviewStatus, parseScores, SCORE_KEYS, scorePasses,
  type CheckKey, type ReviewAvailability, type ReviewScores, type ReviewStatus,
} from "./review-status.ts";

export type ReviewOutcome = "approved" | "manual" | "skipped" | "failed";

export type SkipCount = { reason: string; count: number };

export type ReviewSummary = {
  sessionID: string;
  workspaceID: string | null;
  mode: "observe" | "auto";
  threshold: number;
  reviews: number;
  approved: number;
  manual: number;
  skipped: number;
  failed: number;
  scored: number;
  /** Asks that passed the action and call checks. */
  eligible: number;
  /** Passing judgments that code cancelled, such as `context-changed`; counted in `manual`. */
  invalidated: number;
  /** Reviews that ran the restriction screen. */
  screens: number;
  /** Skipped reviews by reason, most frequent first; at most MAX_SKIP_REASONS, the rest under `other`. */
  skips: SkipCount[];
  /** Present only when `scored` is above zero. */
  average?: ReviewScores;
  /** Average of the authorization score that each review compared; present with `average`. */
  authorization?: number;
  passed: Record<CheckKey, number>;
};

export const MAX_SKIP_REASONS = 12;
const OTHER_REASON = "other";

export const SCORE_CATEGORIES: readonly { key: CheckKey; label: string }[] = [
  { key: "explicitly_authorized", label: "Authorization" },
  { key: "within_scope", label: "Within scope" },
  { key: "confirmation_required", label: "Confirmation" },
  { key: "sensitive_effect", label: "Sensitive" },
  { key: "remote_effect", label: "Remote" },
];
const OUTCOMES: readonly ReviewOutcome[] = ["approved", "manual", "skipped", "failed"];
const COUNTS = ["eligible", "invalidated", "screens"] as const;
const reasonPattern = /^[a-z0-9-]{1,60}$/;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const checkMap = <T>(make: (key: CheckKey) => T) =>
  Object.fromEntries(CHECK_KEYS.map((key) => [key, make(key)])) as Record<CheckKey, T>;
const scoreMap = <T>(make: (key: keyof ReviewScores) => T) =>
  Object.fromEntries(SCORE_KEYS.map((key) => [key, make(key)])) as Record<keyof ReviewScores, T>;

/** Undefined until the review completes. */
export function reviewOutcome(status: ReviewStatus): ReviewOutcome | undefined {
  if (status.phase !== "completed") return undefined;
  if (!status.modelCalled) return "skipped";
  if (!status.scores) return "failed";
  return status.reason === "model-approved" ? "approved" : "manual";
}

/** Running totals that outlive the bounded status store. Memory only, like the statuses. */
export function createReviewSummaryStore() {
  type Totals = Omit<ReviewSummary, "average" | "authorization" | "skips"> &
    { sums: ReviewScores; authorizationSum: number; skipCounts: Map<string, number> };
  const sessions = new Map<string, Totals>();
  const view = (totals: Totals): ReviewSummary => {
    const { sums, authorizationSum, skipCounts, ...rest } = totals;
    const skips = [...skipCounts].map(([reason, value]) => ({ reason, count: value }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    return structuredClone({
      ...rest,
      skips,
      ...(totals.scored ? {
        average: scoreMap((key) => Math.min(1, sums[key] / totals.scored)),
        authorization: Math.min(1, authorizationSum / totals.scored),
      } : {}),
    });
  };
  return {
    /** Counts each completed status once; the caller passes only new completions. */
    add(status: ReviewStatus, sessionID = status.sessionID): ReviewSummary | undefined {
      const outcome = reviewOutcome(status);
      if (!outcome) return undefined;
      let totals = sessions.get(sessionID);
      if (totals && totals.workspaceID !== status.workspaceID) return undefined;
      sessions.delete(sessionID);
      totals ??= {
        sessionID, workspaceID: status.workspaceID, mode: status.mode, threshold: status.threshold,
        reviews: 0, approved: 0, manual: 0, skipped: 0, failed: 0, scored: 0, eligible: 0, invalidated: 0, screens: 0,
        sums: scoreMap(() => 0), authorizationSum: 0, passed: checkMap(() => 0), skipCounts: new Map(),
      };
      totals.mode = status.mode;
      totals.threshold = status.threshold;
      totals.reviews++;
      totals[outcome]++;
      if (status.eligible) totals.eligible++;
      if (status.screened) totals.screens++;
      if (outcome === "manual" && status.proposed === "allow") totals.invalidated++;
      if (outcome === "skipped") {
        const known = totals.skipCounts.has(status.reason!) || totals.skipCounts.size < MAX_SKIP_REASONS - 1;
        const reason = known ? status.reason! : OTHER_REASON;
        totals.skipCounts.set(reason, (totals.skipCounts.get(reason) ?? 0) + 1);
      }
      if (status.scores) {
        totals.scored++;
        const passes = scorePasses(status.scores, status.threshold, status.explicitOnly, status.explains);
        for (const key of SCORE_KEYS) totals.sums[key] += status.scores[key];
        totals.authorizationSum += authorizationScore(status.scores, status.threshold, status.explicitOnly);
        for (const key of CHECK_KEYS) if (passes[key]) totals.passed[key]++;
      }
      // Reinsertion keeps the most recently active session last.
      sessions.set(sessionID, totals);
      if (sessions.size > MAX_REVIEW_STATUSES) sessions.delete(sessions.keys().next().value!);
      return view(totals);
    },
    get(sessionID: string): ReviewSummary | undefined {
      const totals = sessions.get(sessionID);
      return totals && view(totals);
    },
    clear() { sessions.clear(); },
  };
}

function parseSkips(value: unknown, skipped: number): SkipCount[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_SKIP_REASONS) return undefined;
  const skips: SkipCount[] = [];
  for (const entry of value) {
    if (!record(entry) || typeof entry.reason !== "string" || !reasonPattern.test(entry.reason) ||
      !count(entry.count) || entry.count === 0 || skips.some((skip) => skip.reason === entry.reason)) return undefined;
    skips.push({ reason: entry.reason, count: entry.count });
  }
  return skips.reduce((total, skip) => total + skip.count, 0) === skipped ? skips : undefined;
}

/** Strips unknown fields and rejects totals that do not add up. */
export function parseReviewSummary(value: unknown): ReviewSummary | undefined {
  if (!record(value) || !record(value.passed)) return undefined;
  // Reuse the status rules for identifiers, mode and threshold.
  const identity = parseReviewStatus({
    reviewID: "summary", sessionID: value.sessionID, workspaceID: value.workspaceID, messageID: null, callID: null,
    action: "summary", mode: value.mode, phase: "checking", modelCalled: false, startedAt: 0, elapsedMs: 0,
    threshold: value.threshold,
  });
  if (!identity) return undefined;
  const average = value.average === undefined ? undefined : parseScores(value.average);
  const authorization = value.authorization;
  const { reviews, scored, passed } = value;
  if (!count(reviews) || !count(scored) || scored > reviews || !OUTCOMES.every((outcome) => count(value[outcome])) ||
    OUTCOMES.reduce((total, outcome) => total + (value[outcome] as number), 0) !== reviews ||
    !CHECK_KEYS.every((key) => count(passed[key]) && passed[key] <= scored) ||
    !COUNTS.every((key) => count(value[key]) && value[key] <= reviews) ||
    (value.invalidated as number) > (value.manual as number) ||
    (value.average !== undefined && !average) || (scored > 0) !== (average !== undefined) ||
    (average ? !probability(authorization) : authorization !== undefined)) return undefined;
  const skips = parseSkips(value.skips, value.skipped as number);
  if (!skips) return undefined;
  return {
    sessionID: identity.sessionID, workspaceID: identity.workspaceID, mode: identity.mode, threshold: identity.threshold,
    reviews, approved: value.approved as number, manual: value.manual as number,
    skipped: value.skipped as number, failed: value.failed as number, scored,
    eligible: value.eligible as number, invalidated: value.invalidated as number, screens: value.screens as number,
    skips,
    ...(average ? { average, authorization: authorization as number } : {}),
    passed: checkMap((key) => passed[key] as number),
  };
}

export type Tone = "base" | "muted" | "faint" | "success" | "warning" | "error" | "info";
export type Segment = { text: string; tone: Tone };
/** One terminal line; a blank line has no segments. */
export type PanelLine = Segment[];
export type PanelSection = {
  title: string;
  collapsed: string;
  lines: PanelLine[];
};

const PANEL_TITLE = "Guard Review";
const BAR_CELLS = 10;
const LABEL_WIDTH = 14;
const SHOWN_SKIPS = 3;
const percent = (value: number) => `${Math.round(value * 100)}%`;
const reviewCount = (reviews: number) => `${reviews} ${reviews === 1 ? "review" : "reviews"}`;
const join = (parts: Segment[], separator = " · "): Segment[] =>
  parts.flatMap((part, index) => index ? [{ text: separator, tone: "muted" as const }, part] : [part]);

function clockTime(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function latestMeta(status: ReviewStatus): [string, Tone, string] {
  const outcome = reviewOutcome(status);
  if (outcome === "approved") return ["✓", "success", status.mode === "auto" ? "approved" : "would approve"];
  if (outcome === "manual") return ["✗", "warning", "needs approval"];
  if (outcome === "skipped") return ["–", "muted", "skipped"];
  if (outcome === "failed") return ["!", "error", "failed"];
  return ["…", "info", status.phase];
}

function latestLines(status: ReviewStatus, clock: (ms: number) => string): PanelLine[] {
  const [symbol, tone, label] = latestMeta(status);
  const lines: PanelLine[] = [[
    { text: "Latest ", tone: "muted" }, { text: `${symbol} `, tone },
    ...join([
      { text: status.action, tone: "base" },
      ...(status.rootSessionID ? [{ text: "subagent", tone: "muted" as const }] : []),
      { text: label, tone },
      { text: clock(status.startedAt), tone: "muted" },
    ]),
  ]];
  if (status.reason && status.reason !== "model-approved") lines.push([{ text: `  ${status.reason}`, tone: "muted" }]);
  const guidance = status.reason ? guidanceFor(status.reason) : undefined;
  if (guidance) lines.push([{ text: `  Next: ${guidance}`, tone: "warning" }]);
  const warnings = [
    ...(status.contextWarnings?.compacted ? ["compacted context"] : []),
    ...(status.contextWarnings?.outside_project ? ["outside-project access"] : []),
  ];
  if (warnings.length) lines.push([{ text: `  ⚠ ${warnings.join(", ")}`, tone: "warning" }]);
  return lines;
}

function scoreLine(summary: ReviewSummary & { average: ReviewScores }, key: CheckKey, label: string): PanelLine {
  const value = key === "explicitly_authorized" ? summary.authorization ?? summary.average[key] : summary.average[key];
  const filled = Math.round(value * BAR_CELLS);
  const tone: Tone = summary.passed[key] === summary.scored ? "success" : "warning";
  return [
    { text: label.padEnd(LABEL_WIDTH), tone: "base" },
    { text: "━".repeat(filled), tone },
    { text: "─".repeat(BAR_CELLS - filled), tone: "faint" },
    { text: ` ${percent(value).padStart(4)}`, tone },
    { text: `  ${summary.passed[key]}/${summary.scored}`, tone: "muted" },
  ];
}

function collapsedSummary(
  summary: ReviewSummary | undefined,
  latest: ReviewStatus | undefined,
  failure: string | undefined,
): string {
  if (summary) {
    const reviews = reviewCount(summary.reviews);
    if (latest && reviewOutcome(latest) === undefined) return `${reviews}, ${latest.phase}`;
    if (failure !== undefined) return `${reviews}, unavailable`;
    if (summary.failed > 0) return `${reviews}, ${summary.failed} failed`;
    if (summary.manual > 0) return `${reviews}, ${summary.manual} manual`;
    return reviews;
  }
  if (latest) {
    if (reviewOutcome(latest) === undefined) return latest.phase;
    return failure !== undefined ? "unavailable" : latestMeta(latest)[2];
  }
  return failure !== undefined ? "unavailable" : "no reviews";
}

/**
 * Collapsible sidebar section; undefined hides it. With nothing to show, pending
 * and `rpc.unavailable` stay hidden, because a reviewer that is off registers no RPC.
 * `latest` is the newest in-progress status, otherwise the newest completed one.
 */
export function panelSection(
  summary: ReviewSummary | undefined,
  latest: ReviewStatus | undefined,
  availability: ReviewAvailability,
  clock: (ms: number) => string = clockTime,
): PanelSection | undefined {
  const failure = availability?.ok === false ? availability.code : undefined;
  const empty = !summary && !latest;
  if (empty && (availability === undefined || failure === "rpc.unavailable")) return undefined;
  const source = summary ?? latest;
  const reviews = summary ? `${reviewCount(summary.reviews)} · ` : "";
  const lines: PanelLine[] = source
    ? [[{ text: `${reviews}${source.mode} · ≥${percent(source.threshold)}`, tone: "muted" }]]
    : [];
  if (failure !== undefined) {
    lines.push([{ text: `Status unavailable (${failure})${empty ? "" : "; showing cached data"}`, tone: "warning" }]);
  }
  if (empty) {
    if (failure === undefined) lines.push([{ text: "No reviews in this session yet.", tone: "muted" }]);
    return { title: PANEL_TITLE, collapsed: collapsedSummary(summary, latest, failure), lines };
  }
  if (summary) {
    const outcomes: [ReviewOutcome, string, Tone][] = [
      ["approved", summary.mode === "auto" ? "approved" : "would approve", "success"],
      ["manual", "manual", "warning"], ["skipped", "skipped", "muted"], ["failed", "failed", "error"],
    ];
    lines.push(join(outcomes.filter(([outcome]) => summary[outcome] > 0)
      .map(([outcome, label, tone]) => ({ text: `${summary[outcome]} ${label}`, tone }))));
    if (summary.skips.length) {
      lines.push([{
        text: `Skips: ${summary.skips.slice(0, SHOWN_SKIPS).map((skip) => `${skip.reason} ${skip.count}`).join(", ")}`,
        tone: "muted",
      }]);
    }
    lines.push([]);
    if (summary.average) {
      const scored = summary as ReviewSummary & { average: ReviewScores };
      for (const { key, label } of SCORE_CATEGORIES) lines.push(scoreLine(scored, key, label));
    } else {
      lines.push([{ text: "No scored reviews yet.", tone: "muted" }]);
    }
  }
  if (latest) {
    if (summary) lines.push([]);
    lines.push(...latestLines(latest, clock));
  }
  return { title: PANEL_TITLE, collapsed: collapsedSummary(summary, latest, failure), lines };
}

export const lineText = (line: PanelLine) => line.map((segment) => segment.text).join("");
