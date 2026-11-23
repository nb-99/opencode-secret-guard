import { describe, expect, test } from "bun:test";
import {
  MAX_RATIONALE_CHARS,
  MAX_REVIEW_STATUSES,
  MAX_SESSION_REVIEWS,
  MAX_SUMMARY_CHARS,
  approvalBasis,
  createReviewStatusStore,
  explanationText,
  negativeThreshold,
  parseReviewStatus,
  positiveThreshold,
  reviewHeading,
  reviewLines,
  scorePasses,
  scoreRows,
  wantsToast,
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
    sensitive_effect: 0.05,
    remote_effect: 0.04,
    named_by_user: 0.2,
    read_only: 0,
    local_reversible: 0,
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

  test("requires all finite scores between 0 and 1", () => {
    const endpoints = scores({ explicitly_authorized: 0, within_scope: 1, confirmation_required: 0, sensitive_effect: 1, remote_effect: 0, named_by_user: 1, read_only: 1, local_reversible: 0 });
    expect(parseReviewStatus(completed({ scores: endpoints }))?.scores).toEqual(endpoints);
    for (const field of ["explicitly_authorized", "within_scope", "confirmation_required", "sensitive_effect", "remote_effect", "named_by_user", "read_only", "local_reversible"] as const) {
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
      scores: { explicitly_authorized: 0.98, within_scope: 0.95, confirmation_required: 0.22, sensitive_effect: 0.05, remote_effect: 0.04, named_by_user: 0.2, read_only: 0, local_reversible: 0 },
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

  test("keeps the explains flag and toasts setting, and rejects other values", () => {
    expect(parseReviewStatus(status({ explains: true, toasts: "attention" }))).toEqual(status({ explains: true, toasts: "attention" }));
    expect(parseReviewStatus(status({ explains: false, toasts: "all" }))).toEqual(status({ explains: false, toasts: "all" }));
    for (const explains of [null, 1, "true"]) expect(parseReviewStatus({ ...status(), explains })).toBeUndefined();
    for (const toasts of [null, "none", "ALL", 1]) expect(parseReviewStatus({ ...status(), toasts })).toBeUndefined();
  });

  test("keeps the eligible and screened flags, and rejects other values", () => {
    expect(parseReviewStatus(completed({ eligible: true, screened: false }))).toEqual(completed({ eligible: true, screened: false }));
    for (const field of ["eligible", "screened"] as const) {
      for (const value of [null, 1, "true"]) expect(parseReviewStatus({ ...completed(), [field]: value })).toBeUndefined();
    }
  });

  test("accepts a bounded, single-line explanation and rejects anything else", () => {
    const explanation = { summary: "s".repeat(MAX_SUMMARY_CHARS), rationale: "Asked for by the user…" };
    expect(parseReviewStatus(completed({ explanation }))?.explanation).toEqual(explanation);
    for (const value of [null, [], "text", {}, { summary: "Runs tests." }, { rationale: "Requested." },
      { summary: "", rationale: "Requested." },
      { summary: "Runs tests.", rationale: "r".repeat(MAX_RATIONALE_CHARS + 1) },
      { summary: "s".repeat(MAX_SUMMARY_CHARS + 1), rationale: "Requested." },
      { summary: "Runs\ntests.", rationale: "Requested." },
      { summary: "Runs tests.", rationale: "\u001b[2JRequested." },
      { summary: " Runs tests.", rationale: "Requested." },
      { summary: "Runs tests.", rationale: 1 }]) {
      expect(parseReviewStatus({ ...completed(), explanation: value })).toBeUndefined();
    }
    const parsed = parseReviewStatus({ ...completed(), explanation: { ...explanation, extra: "dropped" } });
    expect(parsed?.explanation).toEqual(explanation);
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
    expect(store.update({ ...completed(), scores: { ...scores(), sensitive_effect: Infinity } })).toBeUndefined();
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
    snapshot[0]!.scores!.sensitive_effect = 1;
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
  test("renders every check with the correct threshold direction", () => {
    expect(scoreRows(scores(), 0.9)).toEqual([
      { label: "Authorization", score: "explicit 98%, read-only 0%, undoable 0%", required: "one ≥90%, explicit if remote", pass: true },
      { label: "Within scope", score: "95%", required: "≥90%", pass: true },
      { label: "Confirmation required", score: "22%", required: "≤10%", pass: false },
      { label: "Sensitive effect", score: "5%", required: "≤10%", pass: true },
      { label: "Remote effect", score: "4%, named 20%", required: "≤10% or named ≥90%", pass: true },
    ]);
  });

  test("accepts equality and rejects scores on the wrong side of each limit", () => {
    expect(scoreRows(scores({ explicitly_authorized: 0.89, within_scope: 0.9, confirmation_required: 0.1, sensitive_effect: 0.11, remote_effect: 0.1 }), 0.9)).toEqual([
      { label: "Authorization", score: "explicit 89%, read-only 0%, undoable 0%", required: "one ≥90%, explicit if remote", pass: false },
      { label: "Within scope", score: "90%", required: "≥90%", pass: true },
      { label: "Confirmation required", score: "10%", required: "≤10%", pass: true },
      { label: "Sensitive effect", score: "11%", required: "≤10%", pass: false },
      { label: "Remote effect", score: "10%, named 20%", required: "≤10% or named ≥90%", pass: true },
    ]);
  });

  test("a remote effect passes only when the user named the action", () => {
    const rows = (remote_effect: number, named_by_user: number) => scoreRows(scores({ remote_effect, named_by_user }), 0.9).at(-1);
    expect(rows(0.95, 0.9)).toEqual({ label: "Remote effect", score: "95%, named 90%", required: "≤10% or named ≥90%", pass: true });
    expect(rows(0.95, 0.89)).toMatchObject({ pass: false });
    expect(rows(0.11, 0.2)).toMatchObject({ pass: false });
  });

  test("a read-only or local reversible action needs no request, unless it has a remote effect", () => {
    const unasked = { explicitly_authorized: 0.2 };
    expect(approvalBasis(scores({ ...unasked, read_only: 0.9 }), 0.9)).toBe("read-only");
    expect(approvalBasis(scores({ ...unasked, local_reversible: 0.95 }), 0.9)).toBe("local-reversible");
    expect(approvalBasis(scores({ ...unasked, read_only: 0.89, local_reversible: 0.89 }), 0.9)).toBeUndefined();
    expect(approvalBasis(scores({ ...unasked, read_only: 0.99, remote_effect: 0.11, named_by_user: 1 }), 0.9)).toBeUndefined();
    expect(approvalBasis(scores({ read_only: 0.99, remote_effect: 0.9 }), 0.9)).toBe("explicit");
    expect(scoreRows(scores({ ...unasked, local_reversible: 0.95 }), 0.9)[0]).toEqual({
      label: "Authorization", score: "explicit 20%, read-only 0%, undoable 95%", required: "one ≥90%, explicit if remote", pass: true,
    });
    expect(approvalBasis(scores({ ...unasked, read_only: 0.99 }), 0.9, true)).toBeUndefined();
    expect(approvalBasis(scores({ read_only: 0.99 }), 0.9, true)).toBe("explicit");
    expect(scoreRows(scores({ ...unasked, local_reversible: 0.95 }), 0.9, true)[0]).toEqual({
      label: "Authorization", score: "explicit 20%, read-only 0%, undoable 95%", required: "explicit ≥90%", pass: false,
    });
    const shown = parseReviewStatus(status({ phase: "completed", proposed: "ask", applied: "ask", reason: "model-not-authorized",
      scores: scores({ ...unasked, read_only: 0.99 }), explicitOnly: true }))!;
    expect(shown.explicitOnly).toBe(true);
    expect(reviewLines(shown)).toContain("Authorization: explicit 20%, read-only 99%, undoable 0% (explicit ≥90%; fail)");
    expect(parseReviewStatus({ ...status(), explicitOnly: "yes" })).toBeUndefined();
  });

  test("uses the exact decimal negative limit of 0.07 for a 0.93 threshold", () => {
    expect(negativeThreshold(0.93)).toBe(0.07);
    expect(scoreRows(scores({ explicitly_authorized: 0.93, within_scope: 0.93, confirmation_required: 0.07, sensitive_effect: 0.07, remote_effect: 0.07 }), 0.93)).toEqual([
      { label: "Authorization", score: "explicit 93%, read-only 0%, undoable 0%", required: "one ≥93%, explicit if remote", pass: true },
      { label: "Within scope", score: "93%", required: "≥93%", pass: true },
      { label: "Confirmation required", score: "7%", required: "≤7%", pass: true },
      { label: "Sensitive effect", score: "7%", required: "≤7%", pass: true },
      { label: "Remote effect", score: "7%, named 20%", required: "≤7% or named ≥93%", pass: true },
    ]);
    expect(scoreRows(scores({ explicitly_authorized: 0.94, within_scope: 0.92, confirmation_required: 0.0701, sensitive_effect: 0.0699 }), 0.93).slice(0, 4)).toEqual([
      { label: "Authorization", score: "explicit 94%, read-only 0%, undoable 0%", required: "one ≥93%, explicit if remote", pass: true },
      { label: "Within scope", score: "92%", required: "≥93%", pass: false },
      { label: "Confirmation required", score: "7.01%", required: "≤7%", pass: false },
      { label: "Sensitive effect", score: "6.99%", required: "≤7%", pass: true },
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
    expect(reviewHeading(evaluating)).toBe("The reviewer is evaluating");
    expect(reviewLines(evaluating)).toEqual(["The reviewer is evaluating", "Observe mode · read", "Scores: pending"]);
  });

  test("includes every score, mode, action, reason and context warning", () => {
    const input = completed({ scores: scores(), contextWarnings: { compacted: true, outside_project: true } });
    expect(reviewHeading(input)).toBe("Manual approval required");
    expect(reviewLines(input)).toEqual([
      "Manual approval required",
      "Auto mode · bash",
      "Proposed: ask · Applied: ask",
      "Reason: confirmation-required",
      "Authorization: explicit 98%, read-only 0%, undoable 0% (one ≥90%, explicit if remote; pass)",
      "Within scope: 95% (≥90%; pass)",
      "Confirmation required: 22% (≤10%; fail)",
      "Sensitive effect: 5% (≤10%; pass)",
      "Remote effect: 4%, named 20% (≤10% or named ≥90%; pass)",
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
      "Authorization: explicit 98%, read-only 0%, undoable 0% (one ≥90%, explicit if remote; pass)",
      "Within scope: 95% (≥90%; pass)",
      "Confirmation required: 2% (≤10%; pass)",
      "Sensitive effect: 5% (≤10%; pass)",
      "Remote effect: 4%, named 20% (≤10% or named ≥90%; pass)",
    ]);
    expect(reviewHeading(approved)).toBe("Automatically approved");
    expect(reviewLines(approved)).toEqual([
      "Automatically approved",
      "Auto mode · bash",
      "Proposed: allow · Applied: allow",
      "Reason: model-approved",
      "Authorization: explicit 98%, read-only 0%, undoable 0% (one ≥90%, explicit if remote; pass)",
      "Within scope: 95% (≥90%; pass)",
      "Confirmation required: 2% (≤10%; pass)",
      "Sensitive effect: 5% (≤10%; pass)",
      "Remote effect: 4%, named 20% (≤10% or named ≥90%; pass)",
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
    expect(reviewHeading(cancelled)).toBe("Review scores passed; approval cancelled");
    expect(reviewLines(cancelled)).toContain("Proposed: allow · Applied: ask");
    expect(reviewLines(cancelled)).toContain("Reason: context-changed");
    expect(reviewHeading(completed({ mode: "observe", proposed: "ask", applied: "allow", reason: "model-not-authorized", scores: scores() }))).toBe("Permission allowed; observe mode did not apply approval");
  });

  test("keeps fixed remedy text", () => {
    expect(reviewLines(completed({ modelCalled: false, reason: "auth-no-connection" }))).toContain(
      "Next: no active OpenCode Zen connection; connect OpenCode Zen with an API key in OpenCode, then retry.",
    );
  });

  test("shows the model's explanation instead of the decision fields and score rows", () => {
    const explanation = { summary: "Force-pushes main to origin.", rationale: "You said to ask before any push." };
    const input = completed({ reason: "model-confirmation-required", scores: scores(), explanation, contextWarnings: { compacted: true, outside_project: false } });
    expect(reviewLines(input)).toEqual([
      "Manual approval required",
      "Auto mode · bash",
      "Does: Force-pushes main to origin.",
      "Why: You said to ask before any push.",
      "Compacted context",
    ]);
  });

  test("keeps the reason code and remedy when code overrules the model's explained verdict", () => {
    const explanation = { summary: "Runs the tests.", rationale: "You asked for a local test run." };
    const passing = scores({ confirmation_required: 0.02 });
    expect(reviewLines(completed({ proposed: "allow", reason: "context-changed", scores: passing, explanation }))).toEqual([
      "Review scores passed; approval cancelled",
      "Auto mode · bash",
      "Does: Runs the tests.",
      "Why: You asked for a local test run.",
      "Reason: context-changed",
    ]);
    expect(reviewLines(completed({ proposed: "allow", reason: "deadline", scores: passing, explanation })).slice(-2)).toEqual([
      "Reason: deadline",
      "Next: the review timed out.",
    ]);
  });

  test("text-mode progress and failure toasts have no score placeholders", () => {
    expect(reviewLines(status({ explains: true }))).toEqual(["Review triggered: checking eligibility", "Auto mode · bash"]);
    expect(reviewLines(status({ explains: true, phase: "evaluating", modelCalled: true })))
      .toEqual(["The reviewer is evaluating", "Auto mode · bash"]);
    expect(reviewLines(completed({ explains: true, reason: "response-shape" }))).toEqual([
      "Review failed; manual approval required",
      "Auto mode · bash",
      "Proposed: ask · Applied: ask",
      "Reason: response-shape",
    ]);
  });

  test("a text-mode judgment without an explanation still shows its scores", () => {
    expect(reviewLines(completed({ explains: true, reason: "model-high-impact", scores: scores() }))).toContain("Sensitive effect: 5% (≤10%; pass)");
  });

  test("subagent statuses tag the mode line, parse rootSessionID, and roll up to root snapshots", () => {
    expect(parseReviewStatus(status({ sessionID: "child-1", rootSessionID: "root-1" })))
      .toMatchObject({ sessionID: "child-1", rootSessionID: "root-1" });
    expect(parseReviewStatus(status({ sessionID: "root-1", rootSessionID: "root-1" }))).toBeUndefined();
    expect(parseReviewStatus(status({ sessionID: "child-1", rootSessionID: "bad id" as string }))).toBeUndefined();
    expect(reviewLines(status({ sessionID: "child-1", rootSessionID: "root-1", explains: true })))
      .toEqual(["Review triggered: checking eligibility", "Auto mode · bash · subagent"]);
    const store = createReviewStatusStore();
    expect(store.update(status({ reviewID: "sub-1", sessionID: "child-1" }))).toBeDefined();
    expect(store.snapshot("root-1")).toEqual([]);
    // Later phase can attach rootSessionID once resolved, but cannot change an already-set rootSessionID.
    expect(store.update(status({ reviewID: "sub-1", sessionID: "child-1", rootSessionID: "root-1", phase: "evaluating", modelCalled: true }))).toBeDefined();
    expect(store.snapshot("root-1").map((item) => item.reviewID)).toEqual(["sub-1"]);
    expect(store.snapshot("child-1").map((item) => item.reviewID)).toEqual(["sub-1"]);
    expect(store.update(completed({ reviewID: "sub-1", sessionID: "child-1", rootSessionID: "root-2" }))).toBeUndefined();
    expect(store.update(completed({ reviewID: "sub-1", sessionID: "child-1", rootSessionID: "root-1" }))).toBeDefined();
    expect(store.snapshot("root-1")[0]).toMatchObject({ reviewID: "sub-1", phase: "completed", rootSessionID: "root-1" });
  });

  test("positiveThreshold relaxes positive checks for text API while keeping safety checks strict", () => {
    expect(positiveThreshold(0.9, false)).toBe(0.9);
    expect(positiveThreshold(0.9, true)).toBe(0.8);
    expect(positiveThreshold(0.95, true)).toBe(0.9);
    expect(positiveThreshold(0.8, true)).toBe(0.65);
    expect(positiveThreshold(1, true)).toBe(1);
    const hedged: ReviewScores = {
      explicitly_authorized: 0.84,
      within_scope: 0.85,
      confirmation_required: 0.05,
      sensitive_effect: 0.05,
      remote_effect: 0.05,
      named_by_user: 0.82,
      read_only: 0,
      local_reversible: 0,
    };
    expect(approvalBasis(hedged, 0.9, false, false)).toBeUndefined();
    expect(approvalBasis(hedged, 0.9, false, true)).toBe("explicit");
    expect(scorePasses(hedged, 0.9, false, false)).toMatchObject({ explicitly_authorized: false, within_scope: false });
    expect(scorePasses(hedged, 0.9, false, true)).toEqual({
      explicitly_authorized: true, within_scope: true, confirmation_required: true, sensitive_effect: true, remote_effect: true,
    });
    // Negative checks stay strict at 1 - threshold (<= 0.10 for threshold 0.9) even in text mode.
    expect(scorePasses({ ...hedged, confirmation_required: 0.12 }, 0.9, false, true).confirmation_required).toBe(false);
    expect(scorePasses({ ...hedged, sensitive_effect: 0.12 }, 0.9, false, true).sensitive_effect).toBe(false);
    expect(scoreRows(hedged, 0.9, false, true).map((row) => row.required)).toEqual([
      "one ≥80%, explicit if remote",
      "≥80%",
      "≤10%",
      "≤10%",
      "≤10% or named ≥80%",
    ]);
  });
});

describe("wantsToast", () => {
  const attention = { toasts: "attention" } as const;

  test("shows every phase by default", () => {
    for (const input of [status(), status({ toasts: "all", phase: "evaluating", modelCalled: true }), completed({ applied: "allow" })]) {
      expect(wantsToast(input)).toBe(true);
    }
  });

  test("attention hides progress, approvals and silent skips", () => {
    for (const input of [
      status(attention),
      status({ ...attention, phase: "evaluating", modelCalled: true }),
      completed({ ...attention, proposed: "allow", applied: "allow", reason: "model-approved" }),
      completed({ ...attention, modelCalled: false, reason: "action-unsupported" }),
    ]) {
      expect(wantsToast(input)).toBe(false);
    }
  });

  test("attention keeps judgments and failures that leave a prompt, and skips with a remedy", () => {
    for (const input of [
      completed({ ...attention, reason: "model-high-impact" }),
      completed({ ...attention, mode: "observe", proposed: "allow", reason: "model-approved" }),
      completed({ ...attention, reason: "response-shape" }),
      completed({ ...attention, modelCalled: false, reason: "auth-no-connection" }),
    ]) {
      expect(wantsToast(input)).toBe(true);
    }
  });
});

describe("explanationText", () => {
  test("returns plain text unchanged", () => {
    expect(explanationText("Runs the tests.", 20)).toBe("Runs the tests.");
  });

  test("turns control, format and line separator characters into single spaces", () => {
    expect(explanationText(" Runs\u001b[31m\ttests\u2028now\u202e \r\n", 40)).toBe("Runs [31m tests now");
  });

  test("turns lone surrogates, private-use and unassigned characters into spaces", () => {
    expect(explanationText("a\ud800b\ue000c\u0378d", 20)).toBe("a b c d");
  });

  test("cuts long text at a word with an ellipsis within the limit", () => {
    expect(explanationText("Deletes the build directory and every cached artifact", 30)).toBe("Deletes the build directory…");
  });

  test("cuts a single long word without splitting a surrogate pair", () => {
    const cut = explanationText("🔒".repeat(10), 6)!;
    expect(cut).toBe("🔒🔒…");
    expect(cut.length).toBeLessThanOrEqual(6);
  });

  test("rejects values that are not text or are blank", () => {
    for (const value of [undefined, null, 1, {}, "", " \n\t "]) expect(explanationText(value, 20)).toBeUndefined();
  });
});
