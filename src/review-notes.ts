/**
 * The note the permission reviewer appends to a permission request's message,
 * shared by the server plugin that writes it and the TUI plugin that reads it.
 * No imports, so the TUI entry stays free of the reviewer's dependencies.
 */

export const NOTE_PREFIX = "secret-guard review:";

/**
 * What a person can do about a reason. Reasons without an entry need no
 * action beyond answering the prompt.
 */
const REASON_GUIDANCE: Readonly<Record<string, string>> = {
  "auth-unsupported": "this OpenCode does not expose saved credentials to plugins; review needs OpenCode V2.0.20 or later.",
  "auth-no-connection": "no active OpenCode Zen connection; connect OpenCode Zen with an API key in OpenCode, then retry.",
  "auth-unresolved": "the active OpenCode Zen connection did not resolve to a credential; reconnect it with an API key.",
  "auth-not-key": "the active OpenCode Zen connection is not an API key (for example OAuth), which review does not support; connect with an API key.",
  "auth-empty-key": "the saved OpenCode Zen API key is empty; reconnect with a valid key.",
  "auth-error": "OpenCode failed while looking up the OpenCode Zen connection.",
  "auth-rejected": "OpenCode Zen rejected the saved API key (HTTP 401); replace the key in OpenCode.",
  "events-unavailable": "the OpenCode event stream is not running; restart OpenCode to resume review.",
  deadline: "the review timed out.",
};

export const guidanceFor = (reason: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(REASON_GUIDANCE, reason) ? REASON_GUIDANCE[reason] : undefined;

/** A separate line, so it never hides the review note's reason. */
export const LOG_UNAVAILABLE_NOTE = "secret-guard log: unavailable";

export const PAYLOAD_LOG_UNAVAILABLE_NOTE = "secret-guard log: payloads unavailable";

export const hasPayloadLogUnavailableNote = (message: unknown): boolean =>
  typeof message === "string" && message.split("\n").includes(PAYLOAD_LOG_UNAVAILABLE_NOTE);

export const hasLogUnavailableNote = (message: unknown): boolean =>
  typeof message === "string" && message.split("\n").includes(LOG_UNAVAILABLE_NOTE);

export type Proposal = "would allow" | "manual approval";

/**
 * An observe-mode model judgment. `score` is the weakest of the four answers,
 * oriented so that higher favours approval, and `threshold` is the policy's
 * confidence threshold (0.5 < t <= 1).
 */
export type ObserveScore = { score: number; threshold: number };

export function formatNote(proposal: Proposal, reason: string, observed?: ObserveScore): string {
  const guidance = guidanceFor(reason);
  const scored = observed ? `; observe score=${observed.score} threshold=${observed.threshold}` : "";
  return `${NOTE_PREFIX} ${proposal} (${reason})${scored}${guidance ? `: ${guidance}` : ""}`;
}

const NOTE =
  /^secret-guard review: (would allow|manual approval) \(([a-z0-9-]{1,60})\)(?:; observe score=([0-9.e+-]{1,24}) threshold=([0-9.e+-]{1,24}))?(?::.*)?$/;

/** A plain decimal or exponent form, as `String(number)` writes it. */
const NUMBER = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/;

const observedScore = (score: string | undefined, threshold: string | undefined): ObserveScore | undefined => {
  if (score === undefined || threshold === undefined) return undefined;
  if (!NUMBER.test(score) || !NUMBER.test(threshold)) return undefined;
  const parsed = { score: Number(score), threshold: Number(threshold) };
  const valid = Number.isFinite(parsed.score) && Number.isFinite(parsed.threshold) && parsed.score >= 0 && parsed.score <= 1 && parsed.threshold > 0.5 && parsed.threshold <= 1;
  return valid ? parsed : undefined;
};

/** The last reviewer note in a message; only its proposal, reason code and validated score are returned. */
export function parseNote(message: unknown): { proposal: Proposal; reason: string; observed?: ObserveScore } | undefined {
  if (typeof message !== "string") return undefined;
  const lines = message.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = NOTE.exec(lines[index]!);
    if (!match) continue;
    const observed = observedScore(match[3], match[4]);
    return { proposal: match[1] as Proposal, reason: match[2]!, ...(observed ? { observed } : {}) };
  }
  return undefined;
}
