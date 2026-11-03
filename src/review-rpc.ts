import { createReviewStatusStore, MAX_SESSION_REVIEWS, type ReviewStatus } from "./review-status.ts";
import { createReviewSummaryStore, type ReviewSummary } from "./review-summary.ts";

// OpenCode 2.2.5 builds RPC validators with Effect 4, which rejects JSON Schema
// `pattern`. Both ends apply the character patterns in parseReviewStatus instead.
const id = { type: "string", minLength: 1, maxLength: 80 };
const probability = { type: "number", minimum: 0, maximum: 1 };
const count = { type: "integer", minimum: 0 };
const scores = {
  type: "object", additionalProperties: false,
  properties: {
    explicitly_authorized: probability, within_scope: probability,
    confirmation_required: probability, high_impact: probability,
  },
  required: ["explicitly_authorized", "within_scope", "confirmation_required", "high_impact"],
};
const mode = { enum: ["observe", "auto"] };
const threshold = { type: "number", exclusiveMinimum: 0.5, maximum: 1 };
const summary = {
  type: "object",
  properties: {
    sessionID: id, workspaceID: { anyOf: [id, { type: "null" }] }, mode, threshold,
    reviews: count, approved: count, manual: count, skipped: count, failed: count, scored: count,
    average: scores,
    passed: {
      type: "object", additionalProperties: false,
      properties: { explicitly_authorized: count, within_scope: count, confirmation_required: count, high_impact: count },
      required: ["explicitly_authorized", "within_scope", "confirmation_required", "high_impact"],
    },
  },
  required: ["sessionID", "workspaceID", "mode", "threshold", "reviews", "approved", "manual", "skipped", "failed", "scored", "passed"],
  additionalProperties: false,
};
const status = {
  type: "object",
  properties: {
    reviewID: id, sessionID: id,
    workspaceID: { anyOf: [id, { type: "null" }] },
    messageID: { anyOf: [id, { type: "null" }] },
    callID: { anyOf: [id, { type: "null" }] },
    action: { type: "string", minLength: 1, maxLength: 40 },
    mode,
    phase: { enum: ["checking", "evaluating", "completed"] },
    modelCalled: { type: "boolean" },
    startedAt: { type: "number", minimum: 0 },
    elapsedMs: { type: "number", minimum: 0 },
    threshold,
    proposed: { enum: ["allow", "ask"] },
    applied: { enum: ["allow", "ask", "deny"] },
    reason: { type: "string", minLength: 1, maxLength: 60 },
    scores,
    contextWarnings: {
      type: "object", additionalProperties: false,
      properties: { compacted: { type: "boolean" }, outside_project: { type: "boolean" } },
      required: ["compacted", "outside_project"],
    },
  },
  required: ["reviewID", "sessionID", "workspaceID", "messageID", "callID", "action", "mode", "phase", "modelCalled", "startedAt", "elapsedMs", "threshold"],
  additionalProperties: false,
};

// V2 Rpc.define returns this portable definition unchanged when no errors are declared.
export const JevRpc = {
  id: "opencode-secret-guard.jev",
  methods: {
    snapshot: {
      input: { type: "object", properties: { sessionID: id }, required: ["sessionID"], additionalProperties: false },
      output: {
        type: "object",
        properties: { reviews: { type: "array", items: status, maxItems: MAX_SESSION_REVIEWS }, summary },
        required: ["reviews"], additionalProperties: false,
      },
    },
  },
  events: {
    review: { schema: { ...status, type: "object" as const } },
    summary: { schema: { ...summary, type: "object" as const } },
  },
};

export type ReviewSnapshot = { reviews: ReviewStatus[]; summary?: ReviewSummary };
export type ReviewEvent = { name: "review"; data: ReviewStatus } | { name: "summary"; data: ReviewSummary };

export interface ReviewRpcRegistration {
  dispose(): Promise<void>;
  readonly events: { emit(name: ReviewEvent["name"], data: ReviewEvent["data"]): Promise<void> };
}

export interface ReviewRpcContext {
  readonly location?: { readonly directory: string; readonly workspaceID?: string };
  readonly rpc?: {
    register(definition: typeof JevRpc, handlers: {
      snapshot(input: unknown): Promise<ReviewSnapshot>;
    }): Promise<ReviewRpcRegistration>;
  };
}

/** Display failures cannot change permission decisions or extend a review's deadline. */
export async function setupReviewStatus(ctx: ReviewRpcContext) {
  const store = createReviewStatusStore();
  const summaries = createReviewSummaryStore();
  let registration: ReviewRpcRegistration | undefined;
  let disposed = false;
  // Registration must not hold up guard or reviewer setup.
  void (async () => {
    try {
      const registered = await ctx.rpc?.register(JevRpc, {
        snapshot: async (input) => {
          const sessionID = typeof input === "object" && input !== null && "sessionID" in input ? input.sessionID : undefined;
          if (typeof sessionID !== "string") return { reviews: [] };
          const summary = summaries.get(sessionID);
          return { reviews: store.snapshot(sessionID), ...(summary ? { summary } : {}) };
        },
      });
      if (disposed) await registered?.dispose();
      else registration = registered;
    } catch {
      // The reviewer can continue without its terminal display.
    }
  })();
  return {
    publish(value: ReviewStatus) {
      if (disposed) return;
      const data = store.update(value);
      if (!data) return;
      // The store accepts each phase once, so each completion is counted once.
      const summary = summaries.add(data);
      if (!registration) return;
      const events: ReviewEvent[] = [{ name: "review", data }, ...(summary ? [{ name: "summary" as const, data: summary }] : [])];
      for (const event of events) {
        try { void registration.events.emit(event.name, event.data).catch(() => {}); } catch { /* Display only. */ }
      }
    },
    dispose() {
      disposed = true;
      store.clear();
      summaries.clear();
      try { void registration?.dispose().catch(() => {}); } catch { /* Display only. */ }
    },
  };
}
