/**
 * An offline summary of the permission review decision log, for the period
 * in `observe` mode before switching to `auto`. Run it with Bun:
 *
 *   bun <package>/lib/review-report.ts [--json] [LOG ...]
 *
 * Without a path it reads the decision log and its `.1` rotation. The log
 * holds codes, identifiers and scores only, so the report does too.
 */
import * as fs from "node:fs";
import { reviewLogPath } from "./review-log.ts";

export interface ReviewedApproval {
  time: string | null;
  reviewID: string | null;
  sessionID: string | null;
  messageID: string | null;
  callID: string | null;
  action: string | null;
  mode: string | null;
  applied: string | null;
  evidence: string[];
}

export interface DecisionReport {
  from: string | null;
  to: string | null;
  starts: number;
  versions: Array<{ guardVersion: string | null; hostVersion: string | null; promptVersion: string | null }>;
  reviews: number;
  eligible: number;
  modelCalls: number;
  /** Passing judgments that kept `model-approved`; `observe` applies none of them. */
  proposedApprovals: number;
  appliedApprovals: number;
  manual: number;
  failed: number;
  skipped: number;
  /** Passing judgments that code cancelled, such as `context-changed`. */
  invalidated: number;
  screens: { runs: number; failed: number; selected: number };
  tokens: { input: number; output: number };
  skips: Record<string, number>;
  reasons: Record<string, number>;
  evidence: Record<string, number>;
  /** Proposed approvals that relied on evidence this reviewer did not use before; read these first. */
  approvalsWithEvidence: ReviewedApproval[];
  /** Lines that were not JSON objects. */
  malformed: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * The guard writes codes, identifiers, versions and times only. Anything else
 * did not come from it, and is never printed, including terminal escapes.
 */
const SAFE_TEXT = /^[\w.:+@/-]{1,128}$/;
const text = (value: unknown) => (typeof value === "string" && SAFE_TEXT.test(value) ? value : null);
const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0);
const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

export function summarizeDecisionLog(lines: Iterable<string>): DecisionReport {
  const report: DecisionReport = {
    from: null, to: null, starts: 0, versions: [],
    reviews: 0, eligible: 0, modelCalls: 0, proposedApprovals: 0, appliedApprovals: 0,
    manual: 0, failed: 0, skipped: 0, invalidated: 0,
    screens: { runs: 0, failed: 0, selected: 0 }, tokens: { input: 0, output: 0 },
    skips: {}, reasons: {}, evidence: {}, approvalsWithEvidence: [], malformed: 0,
  };
  const versions = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      report.malformed++;
      continue;
    }
    if (!isRecord(entry)) {
      report.malformed++;
      continue;
    }
    const time = text(entry.time);
    if (time !== null) {
      if (report.from === null || time < report.from) report.from = time;
      if (report.to === null || time > report.to) report.to = time;
    }
    if (entry.event === "start") {
      report.starts++;
      const version = { guardVersion: text(entry.guardVersion), hostVersion: text(entry.hostVersion), promptVersion: text(entry.promptVersion) };
      const key = JSON.stringify(version);
      if (!versions.has(key)) {
        versions.add(key);
        report.versions.push(version);
      }
      continue;
    }
    if (entry.event !== "review") continue;
    report.reviews++;
    const reason = text(entry.reason) ?? "unknown";
    bump(report.reasons, reason);
    if (entry.eligible === true) report.eligible++;
    if (entry.applied === "allow") report.appliedApprovals++;
    const evidence = Array.isArray(entry.evidence) ? entry.evidence.map(text).filter((tag): tag is string => tag !== null) : [];
    for (const tag of evidence) bump(report.evidence, tag);
    report.tokens.input += count(entry.inputTokens);
    report.tokens.output += count(entry.outputTokens);
    if (isRecord(entry.screen)) {
      report.screens.runs++;
      if (entry.screen.failed === true) report.screens.failed++;
      report.screens.selected += count(entry.screen.selected);
    }
    if (entry.modelCalled !== true) {
      report.skipped++;
      bump(report.skips, reason);
      continue;
    }
    report.modelCalls++;
    if (!isRecord(entry.scores)) {
      report.failed++;
      continue;
    }
    if (reason !== "model-approved") {
      report.manual++;
      if (entry.proposed === "allow") report.invalidated++;
      continue;
    }
    report.proposedApprovals++;
    if (evidence.length) {
      report.approvalsWithEvidence.push({
        time, reviewID: text(entry.reviewID), sessionID: text(entry.sessionID), messageID: text(entry.messageID),
        callID: text(entry.callID), action: text(entry.action), mode: text(entry.mode), applied: text(entry.applied), evidence,
      });
    }
  }
  return report;
}

const sorted = (counts: Record<string, number>) =>
  Object.entries(counts).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([key, value]) => `  ${key}: ${value}`);

export function formatReport(report: DecisionReport): string {
  const lines = [
    `Decision log ${report.from ?? "?"} to ${report.to ?? "?"}`,
    "Unverified: any process that can write the log file can add lines to it.",
    `Starts: ${report.starts}`,
    ...report.versions.map((version) =>
      `  guard ${version.guardVersion ?? "unknown"}, OpenCode ${version.hostVersion ?? "unknown"}, prompt ${version.promptVersion ?? "unknown"}`),
    `Asks reviewed: ${report.reviews}; eligible: ${report.eligible}; model calls: ${report.modelCalls}`,
    `Proposed approvals: ${report.proposedApprovals}; applied approvals: ${report.appliedApprovals}`,
    `Manual: ${report.manual} (invalidated approvals: ${report.invalidated}); failed: ${report.failed}; skipped: ${report.skipped}`,
    `Restriction screen: ${report.screens.runs} runs, ${report.screens.failed} failed, ${report.screens.selected} chunks selected`,
    `Tokens: ${report.tokens.input} input, ${report.tokens.output} output`,
    ...(report.malformed ? [`Malformed lines: ${report.malformed}`] : []),
    "Skips by reason:", ...sorted(report.skips),
    "Evidence used:", ...sorted(report.evidence),
    `Proposed approvals with new evidence (${report.approvalsWithEvidence.length}):`,
    ...report.approvalsWithEvidence.map((approval) =>
      `  ${approval.time ?? "?"} ${approval.mode ?? "?"} ${approval.action ?? "?"} applied=${approval.applied ?? "?"} ` +
      `session=${approval.sessionID ?? "?"} message=${approval.messageID ?? "?"} call=${approval.callID ?? "?"} ` +
      `evidence=${approval.evidence.join(",")}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** Older generation first, so the lines stay in time order. */
function readLogs(paths: string[]): string[] {
  const files = paths.length ? paths : [`${reviewLogPath()}.1`, reviewLogPath()];
  return files.flatMap((file) => {
    try {
      return fs.readFileSync(file, "utf8").split("\n");
    } catch (error) {
      if (paths.length) throw error;
      return [];
    }
  });
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const report = summarizeDecisionLog(readLogs(args.filter((arg) => arg !== "--json")));
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
}
