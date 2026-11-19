import { expect, test } from "bun:test";
import { formatReport, summarizeDecisionLog } from "../src/review-report.ts";

const review = (fields: Record<string, unknown>) => JSON.stringify({
  time: "2026-11-19T10:00:00.000Z", event: "review", mode: "observe", action: "shell", sessionID: "ses_1", messageID: "msg_1",
  callID: "call_1", reviewID: "r", ...fields,
});
const SCORES = { explicitly_authorized: 1, within_scope: 1, confirmation_required: 0, sensitive_effect: 0, remote_effect: 0, named_by_user: 0 };

test("summarizes decisions by outcome, skip reason, evidence and screen run", () => {
  const report = summarizeDecisionLog([
    JSON.stringify({ time: "2026-11-18T09:00:00.000Z", event: "start", guardVersion: "abc1234", hostVersion: "2.3.0", promptVersion: "p1" }),
    JSON.stringify({ time: "2026-11-18T09:00:01.000Z", event: "start", guardVersion: "abc1234", hostVersion: "2.3.0", promptVersion: "p1" }),
    review({ modelCalled: false, reason: "context-rejected-turn", eligible: true, skipDetail: { refusal: "declined", position: "after" } }),
    review({ modelCalled: false, reason: "action-unsupported", eligible: false }),
    review({
      modelCalled: true, reason: "model-approved", proposed: "allow", applied: "ask", eligible: true, scores: SCORES,
      evidence: ["compaction-recent", "screen"], screen: { chunks: 4, cached: 1, asked: 3, selected: 2, failed: false },
      inputTokens: 100, outputTokens: 7, reviewID: "r-evidence", time: "2026-11-19T11:00:00.000Z",
    }),
    review({ modelCalled: true, reason: "model-approved", proposed: "allow", applied: "allow", mode: "auto", eligible: true, scores: SCORES }),
    review({ modelCalled: true, reason: "context-changed", proposed: "allow", applied: "ask", eligible: true, scores: SCORES, screen: { failed: true, selected: 0 } }),
    review({ modelCalled: true, reason: "model-sensitive-effect", proposed: "ask", applied: "ask", eligible: true, scores: SCORES }),
    review({ modelCalled: true, reason: "response-json", proposed: "ask", applied: "ask", eligible: true }),
    "not json",
    "",
  ]);
  expect(report).toMatchObject({
    from: "2026-11-18T09:00:00.000Z", to: "2026-11-19T11:00:00.000Z",
    starts: 2, versions: [{ guardVersion: "abc1234", hostVersion: "2.3.0", promptVersion: "p1" }],
    reviews: 7, eligible: 6, modelCalls: 5, proposedApprovals: 2, appliedApprovals: 1,
    manual: 2, invalidated: 1, failed: 1, skipped: 2,
    screens: { runs: 2, failed: 1, selected: 2 }, tokens: { input: 100, output: 7 },
    skips: { "context-rejected-turn": 1, "action-unsupported": 1 },
    evidence: { "compaction-recent": 1, screen: 1 },
    malformed: 1,
  });
  expect(report.approvalsWithEvidence).toEqual([{
    time: "2026-11-19T11:00:00.000Z", reviewID: "r-evidence", sessionID: "ses_1", messageID: "msg_1", callID: "call_1",
    action: "shell", mode: "observe", applied: "ask", evidence: ["compaction-recent", "screen"],
  }]);
  const text = formatReport(report);
  expect(text).toContain("Proposed approvals: 2; applied approvals: 1");
  expect(text).toContain("Manual: 2 (invalidated approvals: 1); failed: 1; skipped: 2");
  expect(text).toContain("  context-rejected-turn: 1");
  expect(text).toContain("evidence=compaction-recent,screen");
});

test("an empty log gives an empty report", () => {
  expect(summarizeDecisionLog([])).toMatchObject({ reviews: 0, from: null, approvalsWithEvidence: [] });
  expect(formatReport(summarizeDecisionLog([]))).toContain("Decision log ? to ?");
});

test("never prints a value the guard does not write, such as a terminal escape", () => {
  const escape = "\u001b[2K\rforged";
  const report = summarizeDecisionLog([review({
    modelCalled: true, reason: "model-approved", proposed: "allow", applied: "allow", scores: SCORES,
    mode: escape, sessionID: "ses 1", evidence: ["screen", escape],
  })]);
  expect(report.approvalsWithEvidence).toEqual([expect.objectContaining({ mode: null, sessionID: null, evidence: ["screen"] })]);
  const text = formatReport(report);
  expect(text).not.toContain("\u001b");
  expect(text).toContain("Unverified: any process that can write the log file can add lines to it.");
});
