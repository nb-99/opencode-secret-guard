/** Content-free review status shared by the server and terminal plugin. */
import { guidanceFor } from "./review-notes.ts";
export type ReviewScores = {
  explicitly_authorized: number;
  within_scope: number;
  confirmation_required: number;
  high_impact: number;
};

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
  proposed?: "allow" | "ask";
  applied?: "allow" | "ask" | "deny";
  reason?: string;
  scores?: ReviewScores;
  contextWarnings?: { compacted: boolean; outside_project: boolean };
};

export const MAX_REVIEW_STATUSES = 128;
export const MAX_SESSION_REVIEWS = 4;
export const REVIEW_ID_PATTERN = "^[A-Za-z0-9_.:-]{1,80}$";
export const REVIEW_ACTION_PATTERN = "^[A-Za-z0-9_.-]{1,40}$";
export const REVIEW_REASON_PATTERN = "^[a-z0-9-]{1,60}$";
const idPattern = new RegExp(REVIEW_ID_PATTERN);
const actionPattern = new RegExp(REVIEW_ACTION_PATTERN);
const reasonPattern = new RegExp(REVIEW_REASON_PATTERN);
const phases = { checking: 0, evaluating: 1, completed: 2 };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && idPattern.test(value);
const nullableID = (value: unknown) => value === null || identifier(value);
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Strip unknown fields. Status never carries command text, paths, prompts or response bodies. */
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

export function scoreRows(scores: ReviewScores, threshold: number) {
  const low = negativeThreshold(threshold);
  return [
    { label: "Authorization", value: scores.explicitly_authorized, limit: threshold, positive: true },
    { label: "Within scope", value: scores.within_scope, limit: threshold, positive: true },
    { label: "Confirmation required", value: scores.confirmation_required, limit: low, positive: false },
    { label: "High impact", value: scores.high_impact, limit: low, positive: false },
  ].map((row) => ({
    label: row.label,
    score: percent(row.value),
    required: `${row.positive ? "≥" : "≤"}${percent(row.limit)}`,
    pass: row.positive ? row.value >= row.limit : row.value <= row.limit,
  }));
}

export function reviewHeading(status: ReviewStatus): string {
  if (status.phase === "checking") return "Review triggered: checking eligibility";
  if (status.phase === "evaluating") return "Jev is evaluating";
  if (status.applied === "deny") return "Permission denied; review did not override it";
  if (status.applied === "allow") return status.mode === "auto" ?
    "Automatically approved" : "Permission allowed; observe mode did not apply approval";
  if (status.proposed === "allow" && status.reason !== "model-approved") return "Jev scores passed; approval cancelled";
  if (status.mode === "observe" && status.proposed === "allow") return "Would approve; manual approval required";
  if (!status.scores) return status.modelCalled ? "Review failed; manual approval required" : "Review skipped; manual approval required";
  return "Manual approval required";
}

export function reviewLines(status: ReviewStatus, narrow = false): string[] {
  const guidance = status.reason ? guidanceFor(status.reason) : undefined;
  return [
    reviewHeading(status),
    narrow ? `${status.action} · ${status.mode} · ${status.callID ?? status.reviewID}` :
      `${status.mode === "auto" ? "Auto" : "Observe"} mode · ${status.action}`,
    ...(status.phase === "completed" ? narrow ? [`Proposed: ${status.proposed}`, `Applied: ${status.applied}`] :
      [`Proposed: ${status.proposed} · Applied: ${status.applied}`] : []),
    ...(status.reason ? [`Reason: ${status.reason}`] : []),
    ...(status.scores ? scoreRows(status.scores, status.threshold).flatMap((row) => narrow ?
      [row.label, `  ${row.score}  ${row.required}  ${row.pass ? "PASS" : "FAIL"}`] :
      [`${row.label}: ${row.score} (${row.required}; ${row.pass ? "pass" : "fail"})`]) :
      [status.phase === "evaluating" ? "Scores: pending" : status.modelCalled ? "Scores: unavailable" : "Scores: not evaluated"]),
    ...(guidance ? [`Next: ${guidance}`] : []),
    ...(status.contextWarnings?.compacted ? ["Compacted context"] : []),
    ...(status.contextWarnings?.outside_project ? ["Outside-project access"] : []),
  ];
}
