import { describe, expect, test } from "bun:test";
import { MAX_REVIEW_STATUSES, type ReviewScores, type ReviewStatus } from "../src/review-status.ts";
import {
  createReviewSummaryStore, lineText, panelLines, parseReviewSummary, reviewOutcome, type PanelLine, type ReviewSummary,
} from "../src/review-summary.ts";

function completed(overrides: Partial<ReviewStatus> = {}): ReviewStatus {
  return {
    reviewID: "review-1", sessionID: "session-1", workspaceID: null, messageID: "message-1", callID: "call-1",
    action: "bash", mode: "auto", phase: "completed", modelCalled: true, startedAt: 1_000, elapsedMs: 250, threshold: 0.9,
    proposed: "ask", applied: "ask", reason: "model-confirmation-required",
    ...overrides,
  };
}

const scores = (a: number, w: number, c: number, h: number): ReviewScores =>
  ({ explicitly_authorized: a, within_scope: w, confirmation_required: c, high_impact: h });
const approved = (id: string, value: ReviewScores) =>
  completed({ reviewID: id, proposed: "allow", applied: "allow", reason: "model-approved", scores: value });

function summary(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    sessionID: "session-1", workspaceID: null, mode: "auto", threshold: 0.9,
    reviews: 4, approved: 2, manual: 1, skipped: 1, failed: 0, scored: 3,
    average: scores(0.96, 0.95, 0.07, 0.04),
    passed: { explicitly_authorized: 2, within_scope: 3, confirmation_required: 3, high_impact: 3 },
    ...overrides,
  };
}

const text = (lines: PanelLine[]) => lines.map(lineText);
const clock = () => "14:04";

describe("reviewOutcome", () => {
  test("classifies completed reviews by what Jev did", () => {
    expect(reviewOutcome(approved("a", scores(0.98, 0.95, 0.02, 0.01)))).toBe("approved");
    expect(reviewOutcome(completed({ scores: scores(0.98, 0.95, 0.22, 0.01) }))).toBe("manual");
    expect(reviewOutcome(completed({ modelCalled: false, reason: "context-rejected" }))).toBe("skipped");
    expect(reviewOutcome(completed({ reason: "model-request-failed" }))).toBe("failed");
  });

  test("counts a passing judgment whose approval was cancelled as manual", () => {
    expect(reviewOutcome(completed({ proposed: "allow", reason: "context-changed", scores: scores(0.98, 0.95, 0.02, 0.01) })))
      .toBe("manual");
  });

  test("has no outcome before completion", () => {
    expect(reviewOutcome(completed({ phase: "evaluating", proposed: undefined, applied: undefined, reason: undefined })))
      .toBeUndefined();
  });
});

describe("createReviewSummaryStore", () => {
  test("averages scores and counts passes at each review's own threshold", () => {
    const store = createReviewSummaryStore();
    store.add(approved("r1", scores(1, 1, 0, 0)));
    store.add(completed({ reviewID: "r2", scores: scores(0.8, 0.9, 0.2, 0.1) }));
    store.add(completed({ reviewID: "r3", modelCalled: false, reason: "context-rejected" }));
    // At 0.93 the negative limit is exactly 0.07, which passes.
    const last = store.add(completed({ reviewID: "r4", threshold: 0.93, scores: scores(0.9, 0.94, 0.07, 0.08) }));
    const { average, ...counts } = last!;
    expect(counts).toEqual({
      sessionID: "session-1", workspaceID: null, mode: "auto", threshold: 0.93,
      reviews: 4, approved: 1, manual: 2, skipped: 1, failed: 0, scored: 3,
      passed: { explicitly_authorized: 1, within_scope: 3, confirmation_required: 2, high_impact: 2 },
    });
    expect(average!.explicitly_authorized).toBeCloseTo(0.9, 10);
    expect(average!.within_scope).toBeCloseTo(0.946667, 6);
    expect(average!.confirmation_required).toBeCloseTo(0.09, 10);
    expect(average!.high_impact).toBeCloseTo(0.06, 10);
    expect(store.get("session-1")).toEqual(last);
  });

  test("omits the average until a review has scores", () => {
    const store = createReviewSummaryStore();
    const result = store.add(completed({ modelCalled: false, reason: "context-rejected" }));
    expect(result).toEqual({
      sessionID: "session-1", workspaceID: null, mode: "auto", threshold: 0.9,
      reviews: 1, approved: 0, manual: 0, skipped: 1, failed: 0, scored: 0,
      passed: { explicitly_authorized: 0, within_scope: 0, confirmation_required: 0, high_impact: 0 },
    });
  });

  test("ignores reviews in progress and reviews from another workspace", () => {
    const store = createReviewSummaryStore();
    expect(store.add(completed({ phase: "checking", proposed: undefined, applied: undefined, reason: undefined }))).toBeUndefined();
    store.add(completed());
    expect(store.add(completed({ reviewID: "r2", workspaceID: "workspace-2" }))).toBeUndefined();
    expect(store.get("session-1")?.reviews).toBe(1);
  });

  test("returns copies that cannot change the stored totals", () => {
    const store = createReviewSummaryStore();
    store.add(approved("r1", scores(1, 1, 0, 0)))!.approved = 9;
    store.get("session-1")!.passed.within_scope = 9;
    expect(store.get("session-1")).toMatchObject({ approved: 1, passed: { within_scope: 1 } });
  });

  test("keeps the most recently active sessions within the bound", () => {
    const store = createReviewSummaryStore();
    for (let index = 0; index < MAX_REVIEW_STATUSES; index++) store.add(completed({ sessionID: `session-${index}` }));
    store.add(completed({ reviewID: "r2", sessionID: "session-0" }));
    store.add(completed({ sessionID: "session-new" }));
    expect(store.get("session-0")?.reviews).toBe(2);
    expect(store.get("session-1")).toBeUndefined();
    expect(store.get("session-new")?.reviews).toBe(1);
  });
});

describe("parseReviewSummary", () => {
  test("accepts consistent totals and strips unknown fields", () => {
    expect(parseReviewSummary({ ...summary(), note: "synthetic-private", passed: { ...summary().passed, extra: 1 } }))
      .toEqual(summary());
    const unscored = summary({ reviews: 1, approved: 0, manual: 0, skipped: 1, scored: 0,
      passed: { explicitly_authorized: 0, within_scope: 0, confirmation_required: 0, high_impact: 0 } });
    delete unscored.average;
    expect(parseReviewSummary(unscored)).toEqual(unscored);
  });

  test("rejects totals that do not add up or exceed their bounds", () => {
    const { average: _average, ...withoutAverage } = summary();
    for (const value of [
      null, [], summary({ reviews: 5 }), summary({ approved: 1.5 }), summary({ scored: 5 }),
      summary({ manual: -1, skipped: 3 }), summary({ passed: { ...summary().passed, high_impact: 4 } }),
      summary({ average: scores(0.9, 0.9, 0.1, 1.2) }), summary({ sessionID: "bad session" }),
      summary({ threshold: 0.5 }), { ...summary(), mode: "off" }, withoutAverage,
      summary({ scored: 0, passed: { explicitly_authorized: 0, within_scope: 0, confirmation_required: 0, high_impact: 0 } }),
    ]) expect(parseReviewSummary(value)).toBeUndefined();
  });
});

describe("panelLines", () => {
  test("stays hidden while pending or when no review RPC is registered", () => {
    expect(panelLines(undefined, undefined, undefined)).toEqual([]);
    expect(panelLines(undefined, undefined, { ok: false, code: "rpc.unavailable" })).toEqual([]);
  });

  test("shows an empty session and other failures", () => {
    expect(text(panelLines(undefined, undefined, { ok: true }))).toEqual(["GUARD REVIEW", "No reviews in this session yet."]);
    expect(text(panelLines(undefined, undefined, { ok: false, code: "timeout" }))).toEqual(["GUARD REVIEW", "Status unavailable (timeout)"]);
  });

  test("shows the threshold once, outcome totals, one row per category and the latest review", () => {
    const latest = completed({ modelCalled: false, reason: "context-rejected" });
    expect(text(panelLines(summary(), latest, { ok: true }, clock))).toEqual([
      "GUARD REVIEW  4 reviews · auto · ≥90%",
      "2 approved · 1 manual · 1 skipped",
      "",
      "Authorization ━━━━━━━━━━  96%  2/3",
      "Within scope  ━━━━━━━━━━  95%  3/3",
      "Confirmation  ━─────────   7%  3/3",
      "High impact   ──────────   4%  3/3",
      "",
      "Latest – bash · skipped · 14:04",
      "  context-rejected",
    ]);
  });

  test("colours a category by whether every review passed it", () => {
    const rows = panelLines(summary(), undefined, { ok: true }, clock).slice(3, 7);
    expect(rows.map((row) => row[1]!.tone)).toEqual(["warning", "success", "success", "success"]);
    expect(rows.map((row) => row[2]!.tone)).toEqual(["faint", "faint", "faint", "faint"]);
  });

  test("keeps cached totals visible beside a failure code", () => {
    expect(text(panelLines(summary(), undefined, { ok: false, code: "rpc.unavailable" }, clock)).slice(0, 2)).toEqual([
      "GUARD REVIEW  4 reviews · auto · ≥90%",
      "Status unavailable (rpc.unavailable); showing cached data",
    ]);
  });

  test("uses observe wording and says when nothing was scored yet", () => {
    const observed = summary({ mode: "observe", reviews: 1, approved: 1, manual: 0, skipped: 0, scored: 1,
      passed: { explicitly_authorized: 1, within_scope: 1, confirmation_required: 1, high_impact: 1 } });
    const latest = completed({ mode: "observe", proposed: "allow", reason: "model-approved", scores: scores(0.96, 0.95, 0.07, 0.04) });
    const lines = text(panelLines(observed, latest, { ok: true }, clock));
    expect(lines.slice(0, 2)).toEqual(["GUARD REVIEW  1 review · observe · ≥90%", "1 would approve"]);
    expect(lines.at(-1)).toBe("Latest ✓ bash · would approve · 14:04");
    const unscored = summary({ reviews: 1, approved: 0, manual: 0, skipped: 1, scored: 0,
      passed: { explicitly_authorized: 0, within_scope: 0, confirmation_required: 0, high_impact: 0 } });
    delete unscored.average;
    expect(text(panelLines(unscored, undefined, { ok: true }, clock))).toEqual([
      "GUARD REVIEW  1 review · auto · ≥90%", "1 skipped", "", "No scored reviews yet.",
    ]);
  });

  test("shows a review in progress, remedy text and context warnings", () => {
    const evaluating = completed({ phase: "evaluating", proposed: undefined, applied: undefined, reason: undefined });
    expect(text(panelLines(undefined, evaluating, undefined, clock))).toEqual([
      "GUARD REVIEW  auto · ≥90%",
      "Latest … bash · evaluating · 14:04",
    ]);
    const failing = completed({ modelCalled: false, reason: "auth-no-connection", contextWarnings: { compacted: true, outside_project: true } });
    expect(text(panelLines(undefined, failing, { ok: true }, clock)).slice(1)).toEqual([
      "Latest – bash · skipped · 14:04",
      "  auth-no-connection",
      "  Next: no active OpenCode Zen connection; connect OpenCode Zen with an API key in OpenCode, then retry.",
      "  ⚠ compacted context, outside-project access",
    ]);
  });
});
