/**
 * TUI companion of the permission reviewer. OpenCode V2.0.20 renders neither
 * in the TUI nor in the desktop app the message a server plugin adds to a
 * permission request, so this plugin turns the reviewer's note on each
 * `permission.asked` event into a toast. Only the TUI loads it; the desktop
 * app has no equivalent and relies on the decision log.
 *
 * Toasts carry fixed text chosen by the parsed reason code, never the
 * request's message, command or resources. Contracts, from the v2.0.20 source
 * (84c9be93): `packages/plugin/src/tui/plugin.ts` (default `{ id, setup }`),
 * `tui/context.ts` (`data.on` returns an unsubscribe; `ui.toast.show`) and
 * `schema/src/permission.ts` (`permission.asked` data is the request, with
 * `id`, `sessionID` and an optional `message`). No SDK types are imported.
 */
import { guidanceFor, hasLogUnavailableNote, hasPayloadLogUnavailableNote, parseNote } from "./review-notes.ts";

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

export function createTuiListener(ui: TuiContext["ui"], now: () => number = Date.now) {
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
      if (!note) return;
      if (note.proposal === "would allow") {
        ui.toast.show({ title: TITLE, message: "Observe mode: Jev would allow this request. You are still asked.", variant: "info", duration: 4_000, sessionID });
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

export default {
  id: "opencode-secret-guard.tui",
  setup(ctx: TuiContext) {
    return ctx.data.on("permission.asked", createTuiListener(ctx.ui));
  },
};
