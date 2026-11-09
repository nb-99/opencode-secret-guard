/**
 * Review status shared by the server and terminal plugin. Only the optional
 * text-API explanation carries content: model-written text about the action.
 */
import { guidanceFor } from "./review-notes.ts";
import type { ReviewToasts } from "./policy.ts";
export type ReviewScores = {
  explicitly_authorized: number;
  within_scope: number;
  confirmation_required: number;
  high_impact: number;
};

/** The text API's short, display-only account of its judgment. It never affects a decision. */
export type ReviewExplanation = { summary: string; rationale: string };

/** Sized for two to three lines each in OpenCode's 60-column toast. */
export const MAX_SUMMARY_CHARS = 100;
export const MAX_RATIONALE_CHARS = 140;
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

/**
 * Model text as one plain line of at most `limit` UTF-16 units, cut with an
 * ellipsis. Control, format, private-use and unassigned characters, such as
 * terminal escapes, become spaces.
 */
export function explanationText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(new RegExp(UNPRINTABLE.source, "gu"), " ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length <= limit) return text;
  let cut = "";
  for (const char of text) {
    if (cut.length + char.length > limit - 1) break;
    cut += char;
  }
  const word = cut.lastIndexOf(" ");
  return `${(word > limit / 2 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

const explanationField = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit && explanationText(value, limit) === value;

export type ReviewStatus = {
  reviewID: string;
  sessionID: string;
  workspaceID: string | null;
  messageID: string | null;
  callID: string | null;
  action: string;
  mode: "observe" | "auto";
  phase: "checking" | "evaluating" | "completed";
  modelCalled: boolean;
  startedAt: number;
  elapsedMs: number;
  threshold: number;
  /** The `text` API: the model explains its judgment, so its toasts show no score placeholders. */
  explains?: boolean;
  /** The `toasts` setting; absent means "all". */
  toasts?: ReviewToasts;
  proposed?: "allow" | "ask";
  applied?: "allow" | "ask" | "deny";
  reason?: string;
  scores?: ReviewScores;
  explanation?: ReviewExplanation;
  contextWarnings?: { compacted: boolean; outside_project: boolean };
};

export const MAX_REVIEW_STATUSES = 128;
export const MAX_SESSION_REVIEWS = 4;
const idPattern = /^[A-Za-z0-9_.:-]{1,80}$/;
const actionPattern = /^[A-Za-z0-9_.-]{1,40}$/;
const reasonPattern = /^[a-z0-9-]{1,60}$/;
const phases = { checking: 0, evaluating: 1, completed: 2 };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && idPattern.test(value);
const nullableID = (value: unknown) => value === null || identifier(value);
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Strip unknown fields. Status never carries prompts or response bodies, and
 * command text or paths only as far as the bounded model explanation repeats them.
 */
export function parseReviewStatus(value: unknown): ReviewStatus | undefined {
  if (!record(value) || !identifier(value.reviewID) || !identifier(value.sessionID) ||
    !nullableID(value.workspaceID) ||
    !nullableID(value.messageID) || !nullableID(value.callID) ||
    typeof value.action !== "string" || !actionPattern.test(value.action) ||
    (value.mode !== "observe" && value.mode !== "auto") ||
    (value.phase !== "checking" && value.phase !== "evaluating" && value.phase !== "completed") ||
    typeof value.modelCalled !== "boolean" ||
    typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) || value.startedAt < 0 ||
    typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 ||
    !probability(value.threshold) || value.threshold <= 0.5) return undefined;
  const result: ReviewStatus = {
    reviewID: value.reviewID, sessionID: value.sessionID,
    workspaceID: value.workspaceID as string | null,
    messageID: value.messageID as string | null, callID: value.callID as string | null,
    action: value.action, mode: value.mode, phase: value.phase,
    modelCalled: value.modelCalled,
    startedAt: value.startedAt, elapsedMs: value.elapsedMs, threshold: value.threshold,
  };
  if (value.explains !== undefined) {
    if (typeof value.explains !== "boolean") return undefined;
    result.explains = value.explains;
  }
  if (value.toasts !== undefined) {
    if (value.toasts !== "all" && value.toasts !== "attention") return undefined;
    result.toasts = value.toasts;
  }
  if (value.phase === "completed") {
    if ((value.proposed !== "allow" && value.proposed !== "ask") ||
      (value.applied !== "allow" && value.applied !== "ask" && value.applied !== "deny") ||
      typeof value.reason !== "string" || !reasonPattern.test(value.reason)) return undefined;
    result.proposed = value.proposed;
    result.applied = value.applied;
    result.reason = value.reason;
  }
  if (value.scores !== undefined) {
    const scores = value.scores;
    if (!record(scores) || !probability(scores.explicitly_authorized) || !probability(scores.within_scope) ||
      !probability(scores.confirmation_required) || !probability(scores.high_impact)) return undefined;
    result.scores = {
      explicitly_authorized: scores.explicitly_authorized,
      within_scope: scores.within_scope,
      confirmation_required: scores.confirmation_required,
      high_impact: scores.high_impact,
    };
  }
  if (value.explanation !== undefined) {
    const explanation = value.explanation;
    if (!record(explanation) || !explanationField(explanation.summary, MAX_SUMMARY_CHARS) ||
      !explanationField(explanation.rationale, MAX_RATIONALE_CHARS)) return undefined;
    result.explanation = { summary: explanation.summary, rationale: explanation.rationale };
  }
  if (value.contextWarnings !== undefined) {
    const warnings = value.contextWarnings;
    if (!record(warnings) || typeof warnings.compacted !== "boolean" || typeof warnings.outside_project !== "boolean") return undefined;
    result.contextWarnings = { compacted: warnings.compacted, outside_project: warnings.outside_project };
  }
  return result;
}

/** Bounded snapshots restore a connected client's display without reading private payload logs. */
export function createReviewStatusStore() {
  const entries = new Map<string, ReviewStatus>();
  return {
    update(value: unknown): ReviewStatus | undefined {
      const status = parseReviewStatus(value);
      if (!status) return undefined;
      const previous = entries.get(status.reviewID);
      if (previous && (previous.sessionID !== status.sessionID || previous.workspaceID !== status.workspaceID ||
        phases[previous.phase] >= phases[status.phase])) return undefined;
      entries.set(status.reviewID, status);
      if (entries.size > MAX_REVIEW_STATUSES) {
        const completed = [...entries.values()].find((entry) => entry.phase === "completed");
        entries.delete(completed?.reviewID ?? entries.keys().next().value!);
      }
      return structuredClone(status);
    },
    snapshot(sessionID: string): ReviewStatus[] {
      return [...entries.values()].filter((entry) => entry.sessionID === sessionID)
        .sort((a, b) => Number(a.phase === "completed") - Number(b.phase === "completed") || b.startedAt - a.startedAt)
        .slice(0, MAX_SESSION_REVIEWS).map((entry) => structuredClone(entry));
    },
    reconcile(sessionID: string, values: ReviewStatus[]) {
      const ids = new Set(values.map((value) => value.reviewID));
      for (const [id, value] of entries) {
        if (value.sessionID === sessionID && !ids.has(id)) entries.delete(id);
      }
      for (const value of values) this.update(value);
    },
    clear() { entries.clear(); },
  };
}

/** Decimal thresholds must not reject a score equal to the negative limit. */
export function negativeThreshold(threshold: number): number {
  const digits = threshold.toString().split(".")[1]?.length ?? 0;
  return Number((1 - threshold).toFixed(digits));
}

function percent(value: number): string {
  const rounded = Number((value * 100).toFixed(4));
  return `${Math.abs(rounded / 100 - value) > Number.EPSILON ? "≈" : ""}${rounded}%`;
}

/** Whether each score is on the passing side of its limit at this threshold. */
export function scorePasses(scores: ReviewScores, threshold: number): Record<keyof ReviewScores, boolean> {
  const low = negativeThreshold(threshold);
  return {
    explicitly_authorized: scores.explicitly_authorized >= threshold,
    within_scope: scores.within_scope >= threshold,
    confirmation_required: scores.confirmation_required <= low,
    high_impact: scores.high_impact <= low,
  };
}

export function scoreRows(scores: ReviewScores, threshold: number) {
  const low = negativeThreshold(threshold);
  const passes = scorePasses(scores, threshold);
  return [
    { key: "explicitly_authorized", label: "Authorization", limit: threshold, positive: true },
    { key: "within_scope", label: "Within scope", limit: threshold, positive: true },
    { key: "confirmation_required", label: "Confirmation required", limit: low, positive: false },
    { key: "high_impact", label: "High impact", limit: low, positive: false },
  ].map((row) => ({
    label: row.label,
    score: percent(scores[row.key as keyof ReviewScores]),
    required: `${row.positive ? "≥" : "≤"}${percent(row.limit)}`,
    pass: passes[row.key as keyof ReviewScores],
  }));
}

export function reviewHeading(status: ReviewStatus): string {
  if (status.phase === "checking") return "Review triggered: checking eligibility";
  if (status.phase === "evaluating") return "The reviewer is evaluating";
  if (status.applied === "deny") return "Permission denied; review did not override it";
  if (status.applied === "allow") return status.mode === "auto" ?
    "Automatically approved" : "Permission allowed; observe mode did not apply approval";
  if (status.proposed === "allow" && status.reason !== "model-approved") return "Review scores passed; approval cancelled";
  if (status.mode === "observe" && status.proposed === "allow") return "Would approve; manual approval required";
  if (!status.scores) return status.modelCalled ? "Review failed; manual approval required" : "Review skipped; manual approval required";
  return "Manual approval required";
}

export function reviewLines(status: ReviewStatus): string[] {
  const guidance = status.reason ? guidanceFor(status.reason) : undefined;
  const head = [reviewHeading(status), `${status.mode === "auto" ? "Auto" : "Observe"} mode · ${status.action}`];
  const tail = [
    ...(guidance ? [`Next: ${guidance}`] : []),
    ...(status.contextWarnings?.compacted ? ["Compacted context"] : []),
    ...(status.contextWarnings?.outside_project ? ["Outside-project access"] : []),
  ];
  // The heading and the model's rationale replace the decision fields and scores.
  // A reason code stays only when code overruled the model's verdict, such as `context-changed`.
  if (status.explanation) {
    return [
      ...head,
      `Does: ${status.explanation.summary}`,
      `Why: ${status.explanation.rationale}`,
      ...(status.reason && !status.reason.startsWith("model-") ? [`Reason: ${status.reason}`] : []),
      ...tail,
    ];
  }
  return [
    ...head,
    ...(status.phase === "completed" ? [`Proposed: ${status.proposed} · Applied: ${status.applied}`] : []),
    ...(status.reason ? [`Reason: ${status.reason}`] : []),
    ...(status.scores ? scoreRows(status.scores, status.threshold).map((row) =>
      `${row.label}: ${row.score} (${row.required}; ${row.pass ? "pass" : "fail"})`) :
      // The heading already says a review is pending, skipped or failed.
      status.explains ? [] :
      [status.phase === "evaluating" ? "Scores: pending" : status.modelCalled ? "Scores: unavailable" : "Scores: not evaluated"]),
    ...tail,
  ];
}

/**
 * Whether a toast is shown under the `toasts` setting. "attention" keeps a
 * completed review that leaves the user something to do or learn: a judgment
 * or failed model call that did not end in allow, or a reason with a remedy.
 */
export function wantsToast(status: ReviewStatus): boolean {
  if (status.toasts !== "attention") return true;
  if (status.phase !== "completed" || status.applied === "allow") return false;
  return status.modelCalled || guidanceFor(status.reason!) !== undefined;
}

/** Snapshot outcome: undefined while pending, otherwise success or a fixed failure code. */
export type ReviewAvailability = { ok: true } | { ok: false; code: string } | undefined;
