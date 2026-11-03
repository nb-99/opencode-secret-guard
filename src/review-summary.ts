/** Per-session review totals and the sidebar layout built from them. */
import { guidanceFor } from "./review-notes.ts";
import {
  MAX_REVIEW_STATUSES, parseReviewStatus, scorePasses,
  type ReviewAvailability, type ReviewScores, type ReviewStatus,
} from "./review-status.ts";

export type ScoreKey = keyof ReviewScores;
export type ReviewOutcome = "approved" | "manual" | "skipped" | "failed";

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
  /** Present only when `scored` is above zero. */
  average?: ReviewScores;
  passed: Record<ScoreKey, number>;
};

export const SCORE_CATEGORIES: readonly { key: ScoreKey; label: string }[] = [
  { key: "explicitly_authorized", label: "Authorization" },
  { key: "within_scope", label: "Within scope" },
  { key: "confirmation_required", label: "Confirmation" },
  { key: "high_impact", label: "High impact" },
];
const SCORE_KEYS = SCORE_CATEGORIES.map((category) => category.key);
const OUTCOMES: readonly ReviewOutcome[] = ["approved", "manual", "skipped", "failed"];

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const scoreMap = <T>(make: (key: ScoreKey) => T) =>
  Object.fromEntries(SCORE_KEYS.map((key) => [key, make(key)])) as Record<ScoreKey, T>;

/** Undefined until the review completes. */
export function reviewOutcome(status: ReviewStatus): ReviewOutcome | undefined {
  if (status.phase !== "completed") return undefined;
  if (!status.modelCalled) return "skipped";
  if (!status.scores) return "failed";
  return status.reason === "model-approved" ? "approved" : "manual";
}

/** Running totals that outlive the bounded status store. Memory only, like the statuses. */
export function createReviewSummaryStore() {
  type Totals = Omit<ReviewSummary, "average"> & { sums: ReviewScores };
  const sessions = new Map<string, Totals>();
  const view = (totals: Totals): ReviewSummary => {
    const { sums, ...rest } = totals;
    return structuredClone({
      ...rest,
      ...(totals.scored ? { average: scoreMap((key) => Math.min(1, sums[key] / totals.scored)) } : {}),
    });
  };
  return {
    /** Counts each completed status once; the caller passes only new completions. */
    add(status: ReviewStatus): ReviewSummary | undefined {
      const outcome = reviewOutcome(status);
      if (!outcome) return undefined;
      let totals = sessions.get(status.sessionID);
      if (totals && totals.workspaceID !== status.workspaceID) return undefined;
      sessions.delete(status.sessionID);
      totals ??= {
        sessionID: status.sessionID, workspaceID: status.workspaceID, mode: status.mode, threshold: status.threshold,
        reviews: 0, approved: 0, manual: 0, skipped: 0, failed: 0, scored: 0,
        sums: scoreMap(() => 0), passed: scoreMap(() => 0),
      };
      totals.mode = status.mode;
      totals.threshold = status.threshold;
      totals.reviews++;
      totals[outcome]++;
      if (status.scores) {
        totals.scored++;
        const passes = scorePasses(status.scores, status.threshold);
        for (const key of SCORE_KEYS) {
          totals.sums[key] += status.scores[key];
          if (passes[key]) totals.passed[key]++;
        }
      }
      // Reinsertion keeps the most recently active session last.
      sessions.set(status.sessionID, totals);
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

/** Strips unknown fields and rejects totals that do not add up. */
export function parseReviewSummary(value: unknown): ReviewSummary | undefined {
  if (!record(value) || !record(value.passed)) return undefined;
  // Reuse the status rules for identifiers, mode and threshold.
  const identity = parseReviewStatus({
    reviewID: "summary", sessionID: value.sessionID, workspaceID: value.workspaceID, messageID: null, callID: null,
    action: "summary", mode: value.mode, phase: "checking", modelCalled: false, startedAt: 0, elapsedMs: 0,
    threshold: value.threshold, ...(value.average === undefined ? {} : { scores: value.average }),
  });
  if (!identity) return undefined;
  const { reviews, scored, passed } = value;
  if (!count(reviews) || !count(scored) || scored > reviews || !OUTCOMES.every((outcome) => count(value[outcome])) ||
    OUTCOMES.reduce((total, outcome) => total + (value[outcome] as number), 0) !== reviews ||
    !SCORE_KEYS.every((key) => count(passed[key]) && passed[key] <= scored) ||
    (scored > 0) !== (identity.scores !== undefined)) return undefined;
  return {
    sessionID: identity.sessionID, workspaceID: identity.workspaceID, mode: identity.mode, threshold: identity.threshold,
    reviews, approved: value.approved as number, manual: value.manual as number,
    skipped: value.skipped as number, failed: value.failed as number, scored,
    ...(identity.scores ? { average: identity.scores } : {}),
    passed: scoreMap((key) => passed[key] as number),
  };
}

export type Tone = "title" | "base" | "muted" | "faint" | "success" | "warning" | "error" | "info";
export type Segment = { text: string; tone: Tone };
/** One terminal line; a blank line has no segments. */
export type PanelLine = Segment[];

const BAR_CELLS = 10;
const LABEL_WIDTH = 14;
const percent = (value: number) => `${Math.round(value * 100)}%`;
const join = (parts: Segment[], separator = " · "): Segment[] =>
  parts.flatMap((part, index) => index ? [{ text: separator, tone: "muted" as const }, part] : [part]);

function clockTime(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function latestLines(status: ReviewStatus, clock: (ms: number) => string): PanelLine[] {
  const outcome = reviewOutcome(status);
  const [symbol, tone, label]: [string, Tone, string] =
    outcome === "approved" ? ["✓", "success", status.mode === "auto" ? "approved" : "would approve"] :
    outcome === "manual" ? ["✗", "warning", "needs approval"] :
    outcome === "skipped" ? ["–", "muted", "skipped"] :
    outcome === "failed" ? ["!", "error", "failed"] :
    ["…", "info", status.phase];
  const lines: PanelLine[] = [[
    { text: "Latest ", tone: "muted" }, { text: `${symbol} `, tone },
    ...join([{ text: status.action, tone: "base" }, { text: label, tone }, { text: clock(status.startedAt), tone: "muted" }]),
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

function scoreLine(summary: ReviewSummary & { average: ReviewScores }, key: ScoreKey, label: string): PanelLine {
  const value = summary.average[key];
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

/**
 * Sidebar lines; none hides the section. With nothing to show, pending and
 * `rpc.unavailable` stay hidden, because a reviewer that is off registers no RPC.
 * `latest` is the newest in-progress status, otherwise the newest completed one.
 */
export function panelLines(
  summary: ReviewSummary | undefined,
  latest: ReviewStatus | undefined,
  availability: ReviewAvailability,
  clock: (ms: number) => string = clockTime,
): PanelLine[] {
  const failure = availability?.ok === false ? availability.code : undefined;
  const empty = !summary && !latest;
  if (empty && (availability === undefined || failure === "rpc.unavailable")) return [];
  const source = summary ?? latest;
  const reviews = summary ? `${summary.reviews} ${summary.reviews === 1 ? "review" : "reviews"} · ` : "";
  const lines: PanelLine[] = [[
    { text: "JEV REVIEW", tone: "title" },
    ...(source ? [{ text: `  ${reviews}${source.mode} · ≥${percent(source.threshold)}`, tone: "muted" as const }] : []),
  ]];
  if (failure !== undefined) {
    lines.push([{ text: `Status unavailable (${failure})${empty ? "" : "; showing cached data"}`, tone: "warning" }]);
  }
  if (empty) {
    if (failure === undefined) lines.push([{ text: "No reviews in this session yet.", tone: "muted" }]);
    return lines;
  }
  if (summary) {
    const outcomes: [ReviewOutcome, string, Tone][] = [
      ["approved", summary.mode === "auto" ? "approved" : "would approve", "success"],
      ["manual", "manual", "warning"], ["skipped", "skipped", "muted"], ["failed", "failed", "error"],
    ];
    lines.push(join(outcomes.filter(([outcome]) => summary[outcome] > 0)
      .map(([outcome, label, tone]) => ({ text: `${summary[outcome]} ${label}`, tone }))));
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
  return lines;
}

export const lineText = (line: PanelLine) => line.map((segment) => segment.text).join("");
