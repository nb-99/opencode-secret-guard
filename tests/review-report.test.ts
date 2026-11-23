import { expect, test } from "bun:test";
import { formatReport, summarizeDecisionLog } from "../src/review-report.ts";

const review = (fields: Record<string, unknown>) => JSON.stringify({
  time: "2026-11-19T10:00:00.000Z", event: "review", mode: "observe", action: "shell", sessionID: "ses_1", messageID: "msg_1",
  callID: "call_1", reviewID: "r", ...fields,
});
const SCORES = { explicitly_authorized: 1, within_scope: 1, confirmation_required: 0, sensitive_effect: 0, remote_effect: 0, named_by_user: 0, read_only: 0, local_reversible: 0 };

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
  const text = formatReport(summarizeDecisionLog([]));
  expect(text).toContain("Decision log ? to ?");
  expect(text).toContain("Tokens: not reported");
  expect(text).toContain("Request size: not recorded");
});

test("joins the user's replies to the reviews of the same call", () => {
  const reply = (reply: string, callID: string) => JSON.stringify({
    time: "2026-11-19T10:00:01.000Z", event: "reply", reply, action: "shell", sessionID: "ses_1", messageID: "msg_1", callID,
  });
  const report = summarizeDecisionLog([
    review({ modelCalled: true, reason: "model-approved", proposed: "allow", applied: "ask", scores: SCORES, basis: "read-only", callID: "c1" }),
    review({ modelCalled: true, reason: "model-approved", proposed: "allow", applied: "ask", scores: SCORES, basis: "explicit", callID: "c2" }),
    review({ modelCalled: true, reason: "model-not-authorized", proposed: "ask", applied: "ask", scores: SCORES, callID: "c3" }),
    review({ modelCalled: true, reason: "model-sensitive-effect", proposed: "ask", applied: "ask", scores: SCORES, callID: "c4" }),
    review({ modelCalled: false, reason: "busy", callID: "c5" }),
    reply("once", "c1"), reply("reject", "c2"), reply("always", "c3"), reply("reject", "c4"), reply("once", "c5"),
    reply("once", "c-unknown"),
  ]);
  expect(report).toMatchObject({
    bases: { "read-only": 1, explicit: 1 },
    replies: { once: 3, always: 1, reject: 2 },
    agreement: { approvedAllowed: 1, approvedRejected: 1, manualAllowed: 1, manualRejected: 1 },
  });
  expect(report.approvalsRejected).toEqual([expect.objectContaining({ callID: "c2" })]);
  const text = formatReport(report);
  expect(text).toContain("approved and allowed 1, approved but rejected 1, manual but allowed 1, manual and rejected 1");
  expect(text).toMatch(/Proposed approvals the user rejected \(1\):\n.* call=c2/);
});

test("a reply joins the review the user saw, not a later review of the same call", () => {
  const report = summarizeDecisionLog([
    review({ modelCalled: true, reason: "model-approved", proposed: "allow", applied: "ask", scores: SCORES }),
    JSON.stringify({ event: "reply", reply: "always", action: "shell", sessionID: "ses_1", messageID: "msg_1", callID: "call_1" }),
    review({ modelCalled: true, reason: "model-sensitive-effect", proposed: "ask", applied: "ask", scores: SCORES }),
  ]);
  expect(report.agreement).toEqual({ approvedAllowed: 1, approvedRejected: 0, manualAllowed: 0, manualRejected: 0 });
});

test("a reply joins the review of its own action on a call with two prompts", () => {
  const reply = (reply: string, action: string) =>
    JSON.stringify({ event: "reply", reply, action, sessionID: "ses_1", messageID: "msg_1", callID: "call_1" });
  const report = summarizeDecisionLog([
    review({ action: "external_directory", modelCalled: true, reason: "model-approved", proposed: "allow", applied: "ask", scores: SCORES }),
    reply("once", "external_directory"),
    review({ modelCalled: true, reason: "model-approved", proposed: "allow", applied: "ask", scores: SCORES }),
    review({ modelCalled: false, reason: "deadline" }),
    reply("reject", "shell"),
  ]);
  expect(report.agreement).toEqual({ approvedAllowed: 1, approvedRejected: 0, manualAllowed: 0, manualRejected: 0 });
  expect(report.approvalsRejected).toEqual([]);
});

test("reports request sizes, queue waits and screen totals", () => {
  const report = summarizeDecisionLog([
    review({ modelCalled: true, reason: "model-approved", scores: SCORES, requestBytes: 1_000, queuedMs: 40,
      screen: { chunks: 5, cached: 2, asked: 3, selected: 1, failed: false } }),
    review({ modelCalled: true, reason: "model-approved", scores: SCORES, requestBytes: 3_000 }),
  ]);
  expect(report).toMatchObject({
    requests: { count: 2, bytes: 4_000, maxBytes: 3_000 }, queued: { count: 1, maxMs: 40 },
    screens: { runs: 1, chunks: 5, cached: 2, asked: 3, selected: 1 }, tokens: { reported: 0 },
  });
  const text = formatReport(report);
  expect(text).toContain("Request size: 2 requests, 2000 bytes average, 3000 maximum");
  expect(text).toContain("Queued reviews: 1, longest wait 40 ms");
  expect(text).toContain("Restriction screen: 1 runs, 0 failed; chunks 5, cached 2, asked 3, selected 1");
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
