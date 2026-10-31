/** Terminal review display. V2.1.4 supports sidebar slots and project-scoped plugin RPC. */
import { guidanceFor, hasLogUnavailableNote, hasPayloadLogUnavailableNote, parseNote } from "./review-notes.ts";
import { createReviewDisplay, type ReviewDisplayContext } from "./review-display.ts";
import type { ReviewPanelContext } from "./review-panel.ts";

type ToastVariant = "info" | "success" | "warning" | "error";

export interface TuiContext {
  readonly data: {
    on(type: "permission.asked", handler: (event: { data?: unknown }) => void): () => void;
  };
  readonly ui: {
    readonly toast: {
      show(options: { title?: string; message: string; variant?: ToastVariant; duration?: number; sessionID?: string }): void;
    };
  };
}

const TITLE = "Secret guard review";
/** One warning per reason in this window; a fixed connection stops them anyway. */
export const REASON_QUIET_MS = 10 * 60_000;
const MAX_SEEN_REQUESTS = 256;
/** Not a reason code, so it cannot collide with one. */
const LOG_KEY = "log unavailable";
const PAYLOAD_LOG_KEY = "payload log unavailable";
const PAYLOAD_LOG_WARNING =
  "The payload log (permission-review-payloads.jsonl, enabled by logPayloads) cannot be written. Check that its directory and file are yours with private permissions, and that the disk has space. Approvals are unaffected.";
const LOG_WARNING =
  "The decision log cannot be written. Check that ~/.local/state/opencode-secret-guard (or under $XDG_STATE_HOME) and its file are yours with private permissions, and that the disk has space. Approvals are unaffected.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MODEL_JUDGMENTS: Readonly<Record<string, string>> = {
  "model-not-authorized": "authorization",
  "model-out-of-scope": "scope",
  "model-confirmation-required": "confirmation",
  "model-high-impact": "impact",
};

/**
 * Percentages with the fewest decimals (up to 4) that tell the two apart; a
 * score that still rounds to the threshold is marked as approximate.
 */
function percents(score: number, threshold: number): [string, string] {
  const format = (value: number, digits: number) => `${Number((value * 100).toFixed(digits))}%`;
  for (const digits of [0, 1, 2, 4]) {
    if (format(score, digits) !== format(threshold, digits)) return [format(score, digits), format(threshold, digits)];
  }
  return [`≈${format(score, 4)}`, format(threshold, 4)];
}

export function createTuiListener(ui: TuiContext["ui"], now: () => number = Date.now, warningsOnly = false) {
  const seen = new Set<string>();
  // Keys are reason codes with guidance and the two log keys only, so the map stays small.
  const warned = new Map<string, number>();
  return (event: { data?: unknown }) => {
    try {
      const data = event?.data;
      if (!isRecord(data)) return;
      const note = parseNote(data.message);
      const logFailing = hasLogUnavailableNote(data.message);
      const payloadLogFailing = hasPayloadLogUnavailableNote(data.message);
      if (!note && !logFailing && !payloadLogFailing) return;
      const id = typeof data.id === "string" ? data.id : undefined;
      if (id !== undefined) {
        if (seen.has(id)) return;
        seen.add(id);
        if (seen.size > MAX_SEEN_REQUESTS) seen.delete(seen.values().next().value!);
      }
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
      const warn = (key: string, message: string) => {
        const last = warned.get(key);
        if (last !== undefined && now() - last < REASON_QUIET_MS) return;
        warned.set(key, now());
        ui.toast.show({ title: TITLE, message, variant: "warning", duration: 8_000, sessionID });
      };
      if (logFailing) warn(LOG_KEY, LOG_WARNING);
      if (payloadLogFailing) warn(PAYLOAD_LOG_KEY, PAYLOAD_LOG_WARNING);
      if (warningsOnly) return;
      if (!note) return;
      if (note.proposal === "would allow") {
        ui.toast.show({ title: TITLE, message: "Observe mode: Jev would allow this request. You are still asked.", variant: "info", duration: 4_000, sessionID });
        return;
      }
      const judgment =
        note.observed && Object.prototype.hasOwnProperty.call(MODEL_JUDGMENTS, note.reason) ? MODEL_JUDGMENTS[note.reason] : undefined;
      if (judgment && note.observed) {
        const [score, threshold] = percents(note.observed.score, note.observed.threshold);
        ui.toast.show({
          title: TITLE,
          message: `Observe mode: Jev would not auto-approve (reason: ${judgment}). Approval score: ${score}; threshold: ${threshold}. Manual approval required.`,
          variant: "warning",
          duration: 8_000,
          sessionID,
        });
        return;
      }
      const guidance = guidanceFor(note.reason);
      // Other reasons are ordinary prompts and stay quiet; the log has them.
      if (guidance) warn(note.reason, `Manual approval required: ${guidance}`);
    } catch {
      // Only a notice is lost; the permission prompt is unaffected.
    }
  };
}

type DisplayContext = TuiContext & Partial<ReviewDisplayContext> & Partial<ReviewPanelContext>;

export function setupTui(ctx: DisplayContext, loadPanel = () => import("./review-panel.ts")) {
  if (!ctx.client?.rpc || !ctx.ui.slot || !ctx.data.listen) return ctx.data.on("permission.asked", createTuiListener(ctx.ui));
  const display = createReviewDisplay(ctx as ReviewDisplayContext);
  const stopWarnings = ctx.data.on("permission.asked", createTuiListener(ctx.ui, Date.now, true));
  let disposed = false;
  let unregister: (() => void) | undefined;
  // Only the TUI loads the host's shared Solid/OpenTUI runtime.
  void loadPanel().then(({ registerReviewPanel }) => {
    if (!disposed) unregister = registerReviewPanel(ctx as ReviewPanelContext, display);
  }).catch(() => {
    if (!disposed) ctx.ui.toast.show({ title: TITLE, message: "The Jev sidebar could not load. Review notifications and decision logs remain available.", variant: "warning", duration: 8_000 });
  });
  return () => {
    disposed = true;
    unregister?.();
    stopWarnings();
    display.dispose();
  };
}

export default {
  id: "opencode-secret-guard.tui",
  setup: setupTui,
};
