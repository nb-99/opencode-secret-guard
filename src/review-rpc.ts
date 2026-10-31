import { createReviewStatusStore, MAX_SESSION_REVIEWS, type ReviewStatus } from "./review-status.ts";

// OpenCode 2.2.5 builds RPC validators with Effect 4, which rejects JSON Schema
// `pattern`. Both ends apply the character patterns in parseReviewStatus instead.
const id = { type: "string", minLength: 1, maxLength: 80 };
const probability = { type: "number", minimum: 0, maximum: 1 };
const status = {
  type: "object",
  properties: {
    reviewID: id, sessionID: id,
    workspaceID: { anyOf: [id, { type: "null" }] },
    messageID: { anyOf: [id, { type: "null" }] },
    callID: { anyOf: [id, { type: "null" }] },
    action: { type: "string", minLength: 1, maxLength: 40 },
    mode: { enum: ["observe", "auto"] },
    phase: { enum: ["checking", "evaluating", "completed"] },
    modelCalled: { type: "boolean" },
    startedAt: { type: "number", minimum: 0 },
    elapsedMs: { type: "number", minimum: 0 },
    threshold: { type: "number", exclusiveMinimum: 0.5, maximum: 1 },
    proposed: { enum: ["allow", "ask"] },
    applied: { enum: ["allow", "ask", "deny"] },
    reason: { type: "string", minLength: 1, maxLength: 60 },
    scores: {
      type: "object", additionalProperties: false,
      properties: {
        explicitly_authorized: probability, within_scope: probability,
        confirmation_required: probability, high_impact: probability,
      },
      required: ["explicitly_authorized", "within_scope", "confirmation_required", "high_impact"],
    },
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
        type: "object", properties: { reviews: { type: "array", items: status, maxItems: MAX_SESSION_REVIEWS } },
        required: ["reviews"], additionalProperties: false,
      },
    },
  },
  events: { review: { schema: { ...status, type: "object" as const } } },
};

export interface ReviewRpcRegistration {
  dispose(): Promise<void>;
  readonly events: { emit(name: "review", data: ReviewStatus): Promise<void> };
}

export interface ReviewRpcContext {
  readonly location?: { readonly directory: string; readonly workspaceID?: string };
  readonly rpc?: {
    register(definition: typeof JevRpc, handlers: {
      snapshot(input: unknown): Promise<{ reviews: ReviewStatus[] }>;
    }): Promise<ReviewRpcRegistration>;
  };
}

/** Display failures cannot change permission decisions or extend a review's deadline. */
export async function setupReviewStatus(ctx: ReviewRpcContext) {
  const store = createReviewStatusStore();
  let registration: ReviewRpcRegistration | undefined;
  let disposed = false;
  // Registration must not hold up guard or reviewer setup.
  void (async () => {
    try {
      const registered = await ctx.rpc?.register(JevRpc, {
        snapshot: async (input) => {
          const sessionID = typeof input === "object" && input !== null && "sessionID" in input ? input.sessionID : undefined;
          return { reviews: typeof sessionID === "string" ? store.snapshot(sessionID) : [] };
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
      if (!data || !registration) return;
      try { void registration.events.emit("review", data).catch(() => {}); } catch { /* Display only. */ }
    },
    dispose() {
      disposed = true;
      store.clear();
      try { void registration?.dispose().catch(() => {}); } catch { /* Display only. */ }
    },
  };
}
