import { describe, expect, test } from "bun:test";
import {
  MAX_REVIEW_STATUSES,
  MAX_SESSION_REVIEWS,
  createReviewStatusStore,
  negativeThreshold,
  parseReviewStatus,
  reviewHeading,
  reviewLines,
  scoreRows,
  type ReviewScores,
  type ReviewStatus,
} from "../src/review-status.ts";

function status(overrides: Partial<ReviewStatus> = {}): ReviewStatus {
  return {
    reviewID: "review-1",
    sessionID: "session-1",
    workspaceID: null,
    messageID: "message-1",
    callID: "call-1",
    action: "bash",
    mode: "auto",
    phase: "checking",
    modelCalled: false,
    startedAt: 1_000,
    elapsedMs: 0,
    threshold: 0.9,
    ...overrides,
  };
}

function completed(overrides: Partial<ReviewStatus> = {}): ReviewStatus {
  return status({
    phase: "completed",
    modelCalled: true,
    elapsedMs: 250,
    proposed: "ask",
    applied: "ask",
    reason: "confirmation-required",
    ...overrides,
  });
}

function scores(overrides: Partial<ReviewScores> = {}): ReviewScores {
  return {
    explicitly_authorized: 0.98,
    within_scope: 0.95,
    confirmation_required: 0.22,
    high_impact: 0.05,
    ...overrides,
  };
}

describe("parseReviewStatus", () => {
  test("accepts all modes and phases with explicit model-call state", () => {
    for (const mode of ["auto", "observe"] as const) {
      for (const phase of ["checking", "evaluating", "completed"] as const) {
        const input = phase === "completed"
          ? completed({ mode })
          : status({ mode, phase, modelCalled: phase === "evaluating" });
        expect(parseReviewStatus(input)).toEqual(input);
      }
    }
  });

  test("accepts bounded identifiers and nullable message and call IDs", () => {
    const input = status({
      reviewID: "r".repeat(80),
      sessionID: "session_ID.v2:1-2",
      messageID: null,
      callID: null,
      action: "a".repeat(40),
    });
    expect(parseReviewStatus(input)).toEqual(input);
    expect(parseReviewStatus(status({ messageID: "m".repeat(80), callID: "c".repeat(80) }))).toBeDefined();
  });

  for (const field of ["reviewID", "sessionID", "workspaceID", "messageID", "callID"] as const) {
    test(`${field} rejects missing, invalid and oversized identifiers`, () => {
      for (const value of [undefined, "", "a".repeat(81), "has space", "path/name", "line\nbreak", "🔒", 42, {}]) {
        expect(parseReviewStatus({ ...status(), [field]: value })).toBeUndefined();
      }
      if (field === "reviewID" || field === "sessionID") {
        expect(parseReviewStatus({ ...status(), [field]: null })).toBeUndefined();
      }
    });
  }

  test("accepts safe action names and rejects command text and unbounded names", () => {
    expect(parseReviewStatus(status({ action: "tool_name.v2-1" }))).toBeDefined();
    for (const action of [undefined, null, "", "a".repeat(41), "bash:command", "cat file", "/bin/bash", "bash\n", 1]) {
      expect(parseReviewStatus({ ...status(), action })).toBeUndefined();
    }
  });

  test("rejects non-record values and invalid modes, phases or model-call state", () => {
    for (const input of [null, undefined, [], "status", 1, true]) {
      expect(parseReviewStatus(input)).toBeUndefined();
    }
    for (const mode of [undefined, null, "manual", "AUTO", 1]) {
      expect(parseReviewStatus({ ...status(), mode })).toBeUndefined();
    }
    for (const phase of [undefined, null, "pending", "failed", 1]) {
      expect(parseReviewStatus({ ...status(), phase })).toBeUndefined();
    }
    for (const modelCalled of [undefined, null, 0, 1, "false"]) {
      expect(parseReviewStatus({ ...status(), modelCalled })).toBeUndefined();
    }
  });

  test("requires finite, nonnegative times", () => {
    expect(parseReviewStatus(status({ startedAt: 0, elapsedMs: 0 }))).toBeDefined();
    for (const field of ["startedAt", "elapsedMs"] as const) {
      for (const value of [undefined, null, -1, NaN, Infinity, -Infinity, "1000"]) {
        expect(parseReviewStatus({ ...status(), [field]: value })).toBeUndefined();
      }
    }
  });

  test("requires a threshold greater than 0.5 and at most 1", () => {
    for (const threshold of [0.5000001, 0.9, 0.93, 1]) {
      expect(parseReviewStatus(status({ threshold }))).toBeDefined();
    }
    for (const threshold of [undefined, null, -1, 0, 0.5, 1.0000001, NaN, Infinity, -Infinity, "0.9"]) {
      expect(parseReviewStatus({ ...status(), threshold })).toBeUndefined();
    }
  });

  test("requires all four finite scores between 0 and 1", () => {
    const endpoints = scores({ explicitly_authorized: 0, within_scope: 1, confirmation_required: 0, high_impact: 1 });
    expect(parseReviewStatus(completed({ scores: endpoints }))?.scores).toEqual(endpoints);
    for (const field of ["explicitly_authorized", "within_scope", "confirmation_required", "high_impact"] as const) {
      for (const value of [undefined, null, -0.0001, 1.0001, NaN, Infinity, -Infinity, "0.98"]) {
        expect(parseReviewStatus({ ...completed(), scores: { ...scores(), [field]: value } })).toBeUndefined();
      }
    }
    for (const value of [null, [], "scores", 1]) {
      expect(parseReviewStatus({ ...completed(), scores: value })).toBeUndefined();
    }
  });

  test("requires proposed, applied and a bounded reason for completed reviews", () => {
    for (const proposed of ["allow", "ask"] as const) {
      for (const applied of ["allow", "ask", "deny"] as const) {
        expect(parseReviewStatus(completed({ proposed, applied, reason: "r".repeat(60) }))).toBeDefined();
      }
    }
    for (const proposed of [undefined, null, "deny", "approve", 1]) {
      expect(parseReviewStatus({ ...completed(), proposed })).toBeUndefined();
    }
    for (const applied of [undefined, null, "approve", 1]) {
      expect(parseReviewStatus({ ...completed(), applied })).toBeUndefined();
    }
    for (const reason of [undefined, null, "", "r".repeat(61), "Raw command", "bad/reason", "UPPERCASE", 1]) {
      expect(parseReviewStatus({ ...completed(), reason })).toBeUndefined();
    }
  });

  test("strips private fields and nested extras into a safe structured projection", () => {
    const parsed = parseReviewStatus({
      ...completed(),
      command: "synthetic-command-secret",
      prompt: "synthetic-prompt-secret",
      credentials: { token: "synthetic-token-secret" },
      path: "/synthetic/private/path",
      response: { body: "synthetic-response-secret" },
      scores: { ...scores(), prompt: "synthetic-score-secret", explanation: "synthetic-explanation-secret" },
      contextWarnings: { compacted: true, outside_project: true, credentials: "synthetic-warning-secret" },
    });
    expect(parsed).toEqual({
      reviewID: "review-1",
      sessionID: "session-1",
      workspaceID: null,
      messageID: "message-1",
      callID: "call-1",
      action: "bash",
      mode: "auto",
      phase: "completed",
      modelCalled: true,
      startedAt: 1_000,
      elapsedMs: 250,
      threshold: 0.9,
      proposed: "ask",
      applied: "ask",
      reason: "confirmation-required",
      scores: { explicitly_authorized: 0.98, within_scope: 0.95, confirmation_required: 0.22, high_impact: 0.05 },
      contextWarnings: { compacted: true, outside_project: true },
    });
  });

  test("does not retain decision fields before completion", () => {
    expect(parseReviewStatus({ ...status(), proposed: "allow", applied: "allow", reason: "not-final" })).toEqual(status());
  });

  test("does not fabricate scores for skipped or failed reviews", () => {
    for (const input of [
      completed({ modelCalled: false, reason: "action-not-eligible" }),
      completed({ modelCalled: true, reason: "model-request-failed" }),
    ]) {
      expect(parseReviewStatus(input)).toEqual(input);
      expect(parseReviewStatus(input)).not.toHaveProperty("scores");
    }
  });

  test("requires boolean context warnings", () => {
    expect(parseReviewStatus(completed({ contextWarnings: { compacted: false, outside_project: false } }))).toBeDefined();
    for (const contextWarnings of [null, [], {}, { compacted: true }, { outside_project: true },
      { compacted: "true", outside_project: false }, { compacted: false, outside_project: 1 }]) {
      expect(parseReviewStatus({ ...completed(), contextWarnings })).toBeUndefined();
    }
  });

  test("returns independent nested objects", () => {
    const input = completed({ scores: scores(), contextWarnings: { compacted: true, outside_project: false } });
    const parsed = parseReviewStatus(input)!;
    parsed.scores!.explicitly_authorized = 0;
    parsed.contextWarnings!.compacted = false;
    expect(input.scores!.explicitly_authorized).toBe(0.98);
    expect(input.contextWarnings!.compacted).toBe(true);
  });
});

describe("createReviewStatusStore", () => {
  test("restores the latest session reviews with in-flight entries first", () => {
    const store = createReviewStatusStore();
    for (let index = 1; index <= MAX_SESSION_REVIEWS + 2; index++) {
      store.update(completed({ reviewID: `done-${index}`, startedAt: 1_000 + index }));
    }
    store.update(status({ reviewID: "checking", startedAt: 100 }));
    store.update(status({ reviewID: "evaluating", phase: "evaluating", modelCalled: true, startedAt: 200 }));
    store.update(completed({ reviewID: "other-session", sessionID: "session-2", startedAt: 9_000 }));

    expect(MAX_SESSION_REVIEWS).toBe(4);
    expect(store.snapshot("session-1").map((entry) => entry.reviewID)).toEqual([
      "evaluating", "checking", "done-6", "done-5",
    ]);
    expect(store.snapshot("session-2").map((entry) => entry.reviewID)).toEqual(["other-session"]);
    expect(store.snapshot("unknown-session")).toEqual([]);
  });

  test("keeps only the latest status for each review without phase regression or duplicates", () => {
    const store = createReviewStatusStore();
    const checking = status();
    const evaluating = status({ phase: "evaluating", modelCalled: true, elapsedMs: 50 });
    const done = completed({ scores: scores() });

    expect(store.update(checking)).toEqual(checking);
    expect(store.update(checking)).toBeUndefined();
    expect(store.update(evaluating)).toEqual(evaluating);
    expect(store.update(checking)).toBeUndefined();
    expect(store.update({ ...evaluating, elapsedMs: 100 })).toBeUndefined();
    expect(store.update(done)).toEqual(done);
    expect(store.update(done)).toBeUndefined();
    expect(store.update(evaluating)).toBeUndefined();
    expect(store.update(checking)).toBeUndefined();
    expect(store.update({ ...done, applied: "deny", reason: "changed-result" })).toBeUndefined();
    expect(store.snapshot("session-1")).toEqual([done]);
  });

  test("refuses the same review ID in another session without changing either session", () => {
    const store = createReviewStatusStore();
    const checking = status();
    store.update(checking);
    expect(store.update(completed({ sessionID: "session-2" }))).toBeUndefined();
    expect(store.snapshot("session-1")).toEqual([checking]);
    expect(store.snapshot("session-2")).toEqual([]);
    expect(store.update(completed())).toEqual(completed());
  });

  test("ignores invalid updates without replacing valid state", () => {
    const store = createReviewStatusStore();
    const checking = status();
    store.update(checking);
    expect(store.update({ ...completed(), threshold: 0.5 })).toBeUndefined();
    expect(store.update({ ...completed(), scores: { ...scores(), high_impact: Infinity } })).toBeUndefined();
    expect(store.snapshot("session-1")).toEqual([checking]);
  });

  test("rejects a review identity that moves to another workspace", () => {
    const store = createReviewStatusStore();
    store.update(status({ workspaceID: "workspace-1" }));
    expect(store.update(completed({ workspaceID: "workspace-2" }))).toBeUndefined();
    expect(store.snapshot("session-1")).toEqual([status({ workspaceID: "workspace-1" })]);
  });

  test("reconciles authoritative session membership without regressing present reviews", () => {
    const store = createReviewStatusStore();
    const done = completed({ scores: scores() });
    store.update(status({ reviewID: "ghost" }));
    store.update(done);
    store.update(status({ reviewID: "other", sessionID: "session-2" }));
    store.reconcile("session-1", [status()]);
    expect(store.snapshot("session-1")).toEqual([done]);
    expect(store.snapshot("session-2")).toEqual([status({ reviewID: "other", sessionID: "session-2" })]);
    store.reconcile("session-1", []);
    expect(store.snapshot("session-1")).toEqual([]);
  });

  test("bounds total reviews and evicts completed entries before active entries", () => {
    const store = createReviewStatusStore();
    store.update(status({ reviewID: "active-old", sessionID: "active-session", startedAt: 1 }));
    for (let index = 1; index < MAX_REVIEW_STATUSES; index++) {
      store.update(completed({ reviewID: `done-${index}`, sessionID: `session-${index}` }));
    }
    store.update(status({ reviewID: "active-new", sessionID: "active-session", startedAt: 2 }));
    store.update(completed({ reviewID: "done-new", sessionID: "new-session" }));

    const remaining = [
      ...store.snapshot("active-session"),
      ...store.snapshot("new-session"),
      ...Array.from({ length: MAX_REVIEW_STATUSES - 1 }, (_, index) => store.snapshot(`session-${index + 1}`)).flat(),
    ];
    expect(remaining).toHaveLength(MAX_REVIEW_STATUSES);
    expect(store.snapshot("active-session").map((entry) => entry.reviewID)).toEqual(["active-new", "active-old"]);
    expect(store.snapshot("session-1")).toEqual([]);
    expect(store.snapshot("session-2")).toEqual([]);
    expect(store.snapshot("session-3").map((entry) => entry.reviewID)).toEqual(["done-3"]);
    expect(store.snapshot("new-session").map((entry) => entry.reviewID)).toEqual(["done-new"]);
  });

  test("remains bounded when every review is in flight", () => {
    const store = createReviewStatusStore();
    for (let index = 0; index <= MAX_REVIEW_STATUSES; index++) {
      store.update(status({ reviewID: `active-${index}`, sessionID: `session-${index}` }));
    }
    const remaining = Array.from({ length: MAX_REVIEW_STATUSES + 1 }, (_, index) => store.snapshot(`session-${index}`)).flat();
    expect(remaining).toHaveLength(MAX_REVIEW_STATUSES);
    expect(store.snapshot(`session-${MAX_REVIEW_STATUSES}`).map((entry) => entry.reviewID)).toEqual([
      `active-${MAX_REVIEW_STATUSES}`,
    ]);
  });

  test("protects stored state from mutations to inputs, update results and snapshots", () => {
    const store = createReviewStatusStore();
    const input = completed({ scores: scores(), contextWarnings: { compacted: true, outside_project: false } });
    const result = store.update(input)!;
    input.sessionID = "mutated-input";
    input.scores!.explicitly_authorized = 0;
    input.contextWarnings!.compacted = false;
    result.reason = "mutated-result";
    result.scores!.within_scope = 0;
    result.contextWarnings!.outside_project = true;
    const snapshot = store.snapshot("session-1");
    snapshot[0]!.reviewID = "mutated-snapshot";
    snapshot[0]!.scores!.high_impact = 1;
    snapshot[0]!.contextWarnings!.compacted = false;
    snapshot.push(status({ reviewID: "injected" }));

    expect(store.snapshot("session-1")).toEqual([
      completed({ scores: scores(), contextWarnings: { compacted: true, outside_project: false } }),
    ]);
    expect(store.snapshot("mutated-input")).toEqual([]);
  });

  test("clears every session and accepts a reused review ID after clearing", () => {
    const store = createReviewStatusStore();
    store.update(status());
    store.update(completed({ reviewID: "review-2", sessionID: "session-2" }));
    store.clear();
    store.clear();
    expect(store.snapshot("session-1")).toEqual([]);
    expect(store.snapshot("session-2")).toEqual([]);
    const reused = status({ sessionID: "session-2" });
    expect(store.update(reused)).toEqual(reused);
    expect(store.snapshot("session-2")).toEqual([reused]);
  });
});

describe("scoreRows", () => {
  test("renders 98, 95, 22 and 5 percent with the correct threshold direction", () => {
    expect(scoreRows(scores(), 0.9)).toEqual([
      { label: "Authorization", score: "98%", required: "≥90%", pass: true },
      { label: "Within scope", score: "95%", required: "≥90%", pass: true },
      { label: "Confirmation required", score: "22%", required: "≤10%", pass: false },
      { label: "High impact", score: "5%", required: "≤10%", pass: true },
    ]);
  });

  test("accepts equality and rejects scores on the wrong side of each limit", () => {
    expect(scoreRows(scores({ explicitly_authorized: 0.89, within_scope: 0.9, confirmation_required: 0.1, high_impact: 0.11 }), 0.9)).toEqual([
      { label: "Authorization", score: "89%", required: "≥90%", pass: false },
      { label: "Within scope", score: "90%", required: "≥90%", pass: true },
      { label: "Confirmation required", score: "10%", required: "≤10%", pass: true },
      { label: "High impact", score: "11%", required: "≤10%", pass: false },
    ]);
  });

  test("uses the exact decimal negative limit of 0.07 for a 0.93 threshold", () => {
    expect(negativeThreshold(0.93)).toBe(0.07);
    expect(scoreRows(scores({ explicitly_authorized: 0.93, within_scope: 0.93, confirmation_required: 0.07, high_impact: 0.07 }), 0.93)).toEqual([
      { label: "Authorization", score: "93%", required: "≥93%", pass: true },
      { label: "Within scope", score: "93%", required: "≥93%", pass: true },
      { label: "Confirmation required", score: "7%", required: "≤7%", pass: true },
      { label: "High impact", score: "7%", required: "≤7%", pass: true },
    ]);
    expect(scoreRows(scores({ explicitly_authorized: 0.94, within_scope: 0.92, confirmation_required: 0.0701, high_impact: 0.0699 }), 0.93)).toEqual([
      { label: "Authorization", score: "94%", required: "≥93%", pass: true },
      { label: "Within scope", score: "92%", required: "≥93%", pass: false },
      { label: "Confirmation required", score: "7.01%", required: "≤7%", pass: false },
      { label: "High impact", score: "6.99%", required: "≤7%", pass: true },
    ]);
  });
});

describe("reviewHeading and reviewLines", () => {
  test("shows checking and evaluating without fabricated scores", () => {
    expect(reviewHeading(status())).toBe("Review triggered: checking eligibility");
    expect(reviewLines(status())).toEqual([
      "Review triggered: checking eligibility",
      "Auto mode · bash",
      "Scores: not evaluated",
    ]);
    const evaluating = status({ mode: "observe", action: "read", phase: "evaluating", modelCalled: true });
    expect(reviewHeading(evaluating)).toBe("Jev is evaluating");
    expect(reviewLines(evaluating)).toEqual(["Jev is evaluating", "Observe mode · read", "Scores: pending"]);
  });

  test("includes every score, mode, action, reason and context warning", () => {
    const input = completed({ scores: scores(), contextWarnings: { compacted: true, outside_project: true } });
    expect(reviewHeading(input)).toBe("Manual approval required");
    expect(reviewLines(input)).toEqual([
      "Manual approval required",
      "Auto mode · bash",
      "Proposed: ask · Applied: ask",
      "Reason: confirmation-required",
      "Authorization: 98% (≥90%; pass)",
      "Within scope: 95% (≥90%; pass)",
      "Confirmation required: 22% (≤10%; fail)",
      "High impact: 5% (≤10%; pass)",
      "Compacted context",
      "Outside-project access",
    ]);
  });

  test("distinguishes a skipped review from a failed model call", () => {
    const skipped = completed({ modelCalled: false, reason: "action-not-eligible" });
    const failed = completed({ modelCalled: true, reason: "model-request-failed" });
    expect(reviewHeading(skipped)).toBe("Review skipped; manual approval required");
    expect(reviewLines(skipped)).toEqual([
      "Review skipped; manual approval required",
      "Auto mode · bash",
      "Proposed: ask · Applied: ask",
      "Reason: action-not-eligible",
      "Scores: not evaluated",
    ]);
    expect(reviewHeading(failed)).toBe("Review failed; manual approval required");
    expect(reviewLines(failed)).toEqual([
      "Review failed; manual approval required",
      "Auto mode · bash",
      "Proposed: ask · Applied: ask",
      "Reason: model-request-failed",
      "Scores: unavailable",
    ]);
  });

  test("distinguishes observe proposed allow from auto applied allow", () => {
    const passing = scores({ confirmation_required: 0.02 });
    const observed = completed({ mode: "observe", proposed: "allow", applied: "ask", reason: "model-approved", scores: passing });
    const approved = completed({ proposed: "allow", applied: "allow", reason: "model-approved", scores: passing });
    expect(reviewHeading(observed)).toBe("Would approve; manual approval required");
    expect(reviewLines(observed)).toEqual([
      "Would approve; manual approval required",
      "Observe mode · bash",
      "Proposed: allow · Applied: ask",
      "Reason: model-approved",
      "Authorization: 98% (≥90%; pass)",
      "Within scope: 95% (≥90%; pass)",
      "Confirmation required: 2% (≤10%; pass)",
      "High impact: 5% (≤10%; pass)",
    ]);
    expect(reviewHeading(approved)).toBe("Automatically approved");
    expect(reviewLines(approved)).toEqual([
      "Automatically approved",
      "Auto mode · bash",
      "Proposed: allow · Applied: allow",
      "Reason: model-approved",
      "Authorization: 98% (≥90%; pass)",
      "Within scope: 95% (≥90%; pass)",
      "Confirmation required: 2% (≤10%; pass)",
      "High impact: 5% (≤10%; pass)",
    ]);
  });

  test("does not display warnings whose flags are false", () => {
    expect(reviewLines(completed({ modelCalled: false, reason: "action-not-eligible", contextWarnings: { compacted: false, outside_project: false } }))).toEqual([
      "Review skipped; manual approval required",
      "Auto mode · bash",
      "Proposed: ask · Applied: ask",
      "Reason: action-not-eligible",
      "Scores: not evaluated",
    ]);
  });

  test("does not present a cancelled passing judgment as an observe approval", () => {
    const cancelled = completed({ mode: "observe", proposed: "allow", applied: "ask", reason: "context-changed", scores: scores({ confirmation_required: 0.02 }) });
    expect(reviewHeading(cancelled)).toBe("Jev scores passed; approval cancelled");
    expect(reviewLines(cancelled)).toContain("Proposed: allow · Applied: ask");
    expect(reviewLines(cancelled)).toContain("Reason: context-changed");
    expect(reviewHeading(completed({ mode: "observe", proposed: "ask", applied: "allow", reason: "model-not-authorized", scores: scores() }))).toBe("Permission allowed; observe mode did not apply approval");
  });

  test("renders a narrow sidebar layout and keeps fixed remedy text", () => {
    expect(reviewLines(completed({ reason: "model-confirmation-required", scores: scores() }), true)).toEqual([
      "Manual approval required", "bash · auto · call-1", "Proposed: ask", "Applied: ask",
      "Reason: model-confirmation-required", "Authorization", "  98%  ≥90%  PASS",
      "Within scope", "  95%  ≥90%  PASS", "Confirmation required", "  22%  ≤10%  FAIL",
      "High impact", "  5%  ≤10%  PASS",
    ]);
    expect(reviewLines(completed({ modelCalled: false, reason: "auth-no-connection" }))).toContain(
      "Next: no active OpenCode Zen connection; connect OpenCode Zen with an API key in OpenCode, then retry.",
    );
  });
});
