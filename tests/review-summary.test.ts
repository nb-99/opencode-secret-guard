import { describe, expect, test } from "bun:test";
import { MAX_REVIEW_STATUSES, type ReviewScores, type ReviewStatus } from "../src/review-status.ts";
import {
  createReviewSummaryStore, lineText, MAX_SKIP_REASONS, panelSection, parseReviewSummary, reviewOutcome, type PanelLine, type ReviewSummary,
} from "../src/review-summary.ts";

function completed(overrides: Partial<ReviewStatus> = {}): ReviewStatus {
  return {
    reviewID: "review-1", sessionID: "session-1", workspaceID: null, messageID: "message-1", callID: "call-1",
    action: "bash", mode: "auto", phase: "completed", modelCalled: true, startedAt: 1_000, elapsedMs: 250, threshold: 0.9,
    proposed: "ask", applied: "ask", reason: "model-confirmation-required",
    ...overrides,
  };
}

const scores = (a: number, w: number, c: number, s: number, r = 0.02, n = 0.1): ReviewScores =>
  ({ explicitly_authorized: a, within_scope: w, confirmation_required: c, sensitive_effect: s, remote_effect: r, named_by_user: n, read_only: 0, local_reversible: 0 });
const approved = (id: string, value: ReviewScores) =>
  completed({ reviewID: id, proposed: "allow", applied: "allow", reason: "model-approved", scores: value });
const passed = (a: number, w: number, c: number, s: number, r: number) =>
  ({ explicitly_authorized: a, within_scope: w, confirmation_required: c, sensitive_effect: s, remote_effect: r });

function summary(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    sessionID: "session-1", workspaceID: null, mode: "auto", threshold: 0.9,
    reviews: 4, approved: 2, manual: 1, skipped: 1, failed: 0, scored: 3,
    eligible: 3, invalidated: 0, screens: 1, skips: [{ reason: "context-rejected-turn", count: 1 }],
    average: scores(0.96, 0.95, 0.07, 0.04, 0.3, 0.6),
    authorization: 0.96,
    passed: passed(2, 3, 3, 3, 2),
    ...overrides,
  };
}

const text = (lines: PanelLine[]) => lines.map(lineText);
const clock = () => "14:04";

describe("reviewOutcome", () => {
  test("classifies completed reviews by what the model did", () => {
    expect(reviewOutcome(approved("a", scores(0.98, 0.95, 0.02, 0.01)))).toBe("approved");
    expect(reviewOutcome(completed({ scores: scores(0.98, 0.95, 0.22, 0.01) }))).toBe("manual");
    expect(reviewOutcome(completed({ modelCalled: false, reason: "context-rejected-turn" }))).toBe("skipped");
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
    store.add(approved("r1", scores(1, 1, 0, 0, 0, 0)));
    store.add(completed({ reviewID: "r2", scores: scores(0.8, 0.9, 0.2, 0.1, 0.9, 0.95), eligible: true }));
    store.add(completed({ reviewID: "r3", modelCalled: false, reason: "context-rejected-turn" }));
    // At 0.93 the negative limit is exactly 0.07, which passes.
    const last = store.add(completed({ reviewID: "r4", threshold: 0.93, scores: scores(0.9, 0.94, 0.07, 0.08, 0.5, 0.5) }));
    const { average, authorization, ...counts } = last!;
    expect(counts).toEqual({
      sessionID: "session-1", workspaceID: null, mode: "auto", threshold: 0.93,
      reviews: 4, approved: 1, manual: 2, skipped: 1, failed: 0, scored: 3,
      eligible: 1, invalidated: 0, screens: 0, skips: [{ reason: "context-rejected-turn", count: 1 }],
      // The remote check passes through the user naming the action.
      passed: passed(1, 3, 2, 2, 2),
    });
    expect(average!.explicitly_authorized).toBeCloseTo(0.9, 10);
    expect(authorization).toBeCloseTo(0.9, 10);
    expect(average!.within_scope).toBeCloseTo(0.946667, 6);
    expect(average!.confirmation_required).toBeCloseTo(0.09, 10);
    expect(average!.sensitive_effect).toBeCloseTo(0.06, 10);
    expect(average!.remote_effect).toBeCloseTo(0.466667, 6);
    expect(average!.named_by_user).toBeCloseTo(0.483333, 6);
    expect(store.get("session-1")).toEqual(last);
  });

  test("averages the authorization score each review compared, such as a read-only one", () => {
    const store = createReviewSummaryStore();
    const last = store.add(approved("r1", { ...scores(0.05, 0.95, 0.02, 0.01), read_only: 0.95 }))!;
    expect(last.average!.explicitly_authorized).toBeCloseTo(0.05, 10);
    expect(last.authorization).toBeCloseTo(0.95, 10);
    expect(last.passed.explicitly_authorized).toBe(1);
    const only = createReviewSummaryStore().add(completed({
      reviewID: "r2", scores: { ...scores(0.05, 0.95, 0.02, 0.01), read_only: 0.95 }, explicitOnly: true,
    }))!;
    expect(only.authorization).toBeCloseTo(0.05, 10);
    expect(only.passed.explicitly_authorized).toBe(0);
  });

  test("counts eligible asks, invalidated approvals, screen runs and skips by reason", () => {
    const store = createReviewSummaryStore();
    store.add(completed({ reviewID: "r1", proposed: "allow", reason: "context-changed", scores: scores(1, 1, 0, 0), eligible: true, screened: true }));
    store.add(completed({ reviewID: "r2", modelCalled: false, reason: "session-rejected", eligible: true }));
    store.add(completed({ reviewID: "r3", modelCalled: false, reason: "action-unsupported" }));
    const last = store.add(completed({ reviewID: "r4", modelCalled: false, reason: "session-rejected", eligible: true }))!;
    expect(last).toMatchObject({
      reviews: 4, manual: 1, skipped: 3, eligible: 3, invalidated: 1, screens: 1,
      skips: [{ reason: "session-rejected", count: 2 }, { reason: "action-unsupported", count: 1 }],
    });
  });

  test("keeps at most the skip reasons it can show and counts the rest as other", () => {
    const store = createReviewSummaryStore();
    let last: ReviewSummary | undefined;
    for (let index = 0; index < MAX_SKIP_REASONS + 3; index++) {
      last = store.add(completed({ reviewID: `r${index}`, modelCalled: false, reason: `reason-${index}` }));
    }
    expect(last!.skips).toHaveLength(MAX_SKIP_REASONS);
    expect(last!.skips[0]).toEqual({ reason: "other", count: 4 });
    expect(parseReviewSummary(last)).toEqual(last);
  });

  test("omits the average until a review has scores", () => {
    const store = createReviewSummaryStore();
    const result = store.add(completed({ modelCalled: false, reason: "context-rejected-turn" }));
    expect(result).toEqual({
      sessionID: "session-1", workspaceID: null, mode: "auto", threshold: 0.9,
      reviews: 1, approved: 0, manual: 0, skipped: 1, failed: 0, scored: 0,
      eligible: 0, invalidated: 0, screens: 0, skips: [{ reason: "context-rejected-turn", count: 1 }],
      passed: passed(0, 0, 0, 0, 0),
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
    const unscored = summary({ reviews: 1, approved: 0, manual: 0, skipped: 1, scored: 0, eligible: 0, screens: 0,
      passed: passed(0, 0, 0, 0, 0) });
    delete unscored.average;
    delete unscored.authorization;
    expect(parseReviewSummary(unscored)).toEqual(unscored);
  });

  test("rejects totals that do not add up or exceed their bounds", () => {
    const { average: _average, ...withoutAverage } = summary();
    for (const value of [
      null, [], summary({ reviews: 5 }), summary({ approved: 1.5 }), summary({ scored: 5 }),
      summary({ manual: -1, skipped: 3 }), summary({ passed: { ...summary().passed, sensitive_effect: 4 } }),
      summary({ average: scores(0.9, 0.9, 0.1, 1.2) }), summary({ sessionID: "bad session" }),
      summary({ authorization: 1.5 }), summary({ authorization: undefined }),
      summary({ threshold: 0.5 }), { ...summary(), mode: "off" }, withoutAverage,
      summary({ scored: 0, passed: passed(0, 0, 0, 0, 0) }),
      summary({ eligible: 5 }), summary({ invalidated: 2 }), summary({ screens: -1 }),
      summary({ skips: [] }), summary({ skips: [{ reason: "Bad reason", count: 1 }] }),
      summary({ skips: [{ reason: "a", count: 1 }, { reason: "a", count: 0 }] }),
      { ...summary(), skips: undefined },
    ]) expect(parseReviewSummary(value)).toBeUndefined();
  });
});

describe("panelSection", () => {
  test("stays hidden while pending or when no review RPC is registered", () => {
    expect(panelSection(undefined, undefined, undefined)).toBeUndefined();
    expect(panelSection(undefined, undefined, { ok: false, code: "rpc.unavailable" })).toBeUndefined();
  });

  test("shows an empty session and other failures", () => {
    const empty = panelSection(undefined, undefined, { ok: true })!;
    expect(empty.title).toBe("Guard Review");
    expect(empty.collapsed).toBe("no reviews");
    expect(text(empty.lines)).toEqual(["No reviews in this session yet."]);

    const timedOut = panelSection(undefined, undefined, { ok: false, code: "timeout" })!;
    expect(timedOut.title).toBe("Guard Review");
    expect(timedOut.collapsed).toBe("unavailable");
    expect(text(timedOut.lines)).toEqual(["Status unavailable (timeout)"]);
  });

  test("shows the threshold once, outcome totals, skip reasons, one row per check and the latest review", () => {
    const latest = completed({ modelCalled: false, reason: "context-rejected-turn" });
    const section = panelSection(summary(), latest, { ok: true }, clock)!;
    expect(section.title).toBe("Guard Review");
    expect(section.collapsed).toBe("4 reviews, 1 manual");
    expect(text(section.lines)).toEqual([
      "4 reviews · auto · ≥90%",
      "2 approved · 1 manual · 1 skipped",
      "Skips: context-rejected-turn 1",
      "",
      "Authorization ━━━━━━━━━━  96%  2/3",
      "Within scope  ━━━━━━━━━━  95%  3/3",
      "Confirmation  ━─────────   7%  3/3",
      "Sensitive     ──────────   4%  3/3",
      "Remote        ━━━───────  30%  2/3",
      "",
      "Latest – bash · skipped · 14:04",
      "  context-rejected-turn",
    ]);
  });

  test("colours a category by whether every review passed it", () => {
    const rows = panelSection(summary(), undefined, { ok: true }, clock)!.lines.slice(4, 9);
    expect(rows.map((row) => row[1]!.tone)).toEqual(["warning", "success", "success", "success", "warning"]);
    expect(rows.map((row) => row[2]!.tone)).toEqual(["faint", "faint", "faint", "faint", "faint"]);
  });

  test("keeps cached totals visible beside a failure code", () => {
    const section = panelSection(summary(), undefined, { ok: false, code: "rpc.unavailable" }, clock)!;
    expect(section.collapsed).toBe("4 reviews, unavailable");
    expect(text(section.lines).slice(0, 2)).toEqual([
      "4 reviews · auto · ≥90%",
      "Status unavailable (rpc.unavailable); showing cached data",
    ]);
  });

  test("uses observe wording and says when nothing was scored yet", () => {
    const observed = summary({ mode: "observe", reviews: 1, approved: 1, manual: 0, skipped: 0, scored: 1, skips: [],
      passed: passed(1, 1, 1, 1, 1) });
    const latest = completed({ mode: "observe", proposed: "allow", reason: "model-approved", scores: scores(0.96, 0.95, 0.07, 0.04) });
    const observedSection = panelSection(observed, latest, { ok: true }, clock)!;
    expect(observedSection.collapsed).toBe("1 review");
    const lines = text(observedSection.lines);
    expect(lines.slice(0, 2)).toEqual(["1 review · observe · ≥90%", "1 would approve"]);
    expect(lines.at(-1)).toBe("Latest ✓ bash · would approve · 14:04");
    const unscored = summary({ reviews: 1, approved: 0, manual: 0, skipped: 1, scored: 0, skips: [{ reason: "busy", count: 1 }],
      passed: passed(0, 0, 0, 0, 0) });
    delete unscored.average;
    const unscoredSection = panelSection(unscored, undefined, { ok: true }, clock)!;
    expect(unscoredSection.collapsed).toBe("1 review");
    expect(text(unscoredSection.lines)).toEqual([
      "1 review · auto · ≥90%", "1 skipped", "Skips: busy 1", "", "No scored reviews yet.",
    ]);
  });

  test("prioritizes live phase, unavailability and failures in the collapsed summary", () => {
    const evaluating = completed({ phase: "evaluating", proposed: undefined, applied: undefined, reason: undefined });
    expect(panelSection(summary(), evaluating, { ok: true }, clock)!.collapsed).toBe("4 reviews, evaluating");
    const withFailure = summary({ reviews: 3, approved: 1, manual: 1, skipped: 0, failed: 1, scored: 2, skips: [],
      passed: passed(1, 2, 2, 2, 2) });
    expect(panelSection(withFailure, undefined, { ok: true }, clock)!.collapsed).toBe("3 reviews, 1 failed");
  });

  test("shows a review in progress, remedy text and context warnings", () => {
    const evaluating = completed({ phase: "evaluating", proposed: undefined, applied: undefined, reason: undefined });
    const live = panelSection(undefined, evaluating, undefined, clock)!;
    expect(live.collapsed).toBe("evaluating");
    expect(text(live.lines)).toEqual([
      "auto · ≥90%",
      "Latest … bash · evaluating · 14:04",
    ]);
    const failing = completed({ modelCalled: false, reason: "auth-no-connection", contextWarnings: { compacted: true, outside_project: true } });
    const skipped = panelSection(undefined, failing, { ok: true }, clock)!;
    expect(skipped.collapsed).toBe("skipped");
    expect(text(skipped.lines).slice(1)).toEqual([
      "Latest – bash · skipped · 14:04",
      "  auth-no-connection",
      "  Next: no active OpenCode Zen connection; connect OpenCode Zen with an API key in OpenCode, then retry.",
      "  ⚠ compacted context, outside-project access",
    ]);
  });
});
