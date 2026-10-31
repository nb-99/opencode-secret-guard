import { describe, expect, mock, test } from "bun:test";
import { createReviewDisplay, type ReviewDisplayContext } from "../src/review-display.ts";
import { JevRpc, setupReviewStatus, type ReviewRpcContext, type ReviewRpcRegistration } from "../src/review-rpc.ts";
import { type ReviewStatus } from "../src/review-status.ts";

function status(overrides: Partial<ReviewStatus> = {}): ReviewStatus {
  return {
    reviewID: "review-1", sessionID: "session-1", workspaceID: "workspace-1",
    messageID: "message-1", callID: "call-1",
    action: "bash", mode: "auto", phase: "checking", modelCalled: false,
    startedAt: 1_000, elapsedMs: 0, threshold: 0.9,
    ...overrides,
  };
}

function completed(overrides: Partial<ReviewStatus> = {}): ReviewStatus {
  return status({
    phase: "completed", modelCalled: true, elapsedMs: 250,
    proposed: "ask", applied: "ask", reason: "confirmation-required",
    ...overrides,
  });
}

const reviewedScores = {
  explicitly_authorized: 0.98, within_scope: 0.95, confirmation_required: 0.22, high_impact: 0.05,
};
const reviewedScoreLines = [
  "Authorization: 98% (≥90%; pass)",
  "Within scope: 95% (≥90%; pass)",
  "Confirmation required: 22% (≤10%; fail)",
  "High impact: 5% (≤10%; pass)",
];

type SnapshotHandler = (input: unknown) => Promise<{ reviews: ReviewStatus[] }>;
function rpcHarness(options: {
  emit?: ReviewRpcRegistration["events"]["emit"];
  dispose?: ReviewRpcRegistration["dispose"];
  registerError?: boolean;
} = {}) {
  let definition: typeof JevRpc | undefined;
  let handlers: { snapshot: SnapshotHandler } | undefined;
  const emitted: { name: string; data: ReviewStatus }[] = [];
  const unregister = mock(options.dispose ?? (async () => {}));
  const permissionHook = mock(() => { throw new Error("Display must not register permission hooks"); });
  const toolHook = mock(() => { throw new Error("Display must not invoke tools"); });
  const ctx: ReviewRpcContext & { permission: { hook: typeof permissionHook }; tool: { hook: typeof toolHook } } = {
    location: project,
    permission: { hook: permissionHook },
    tool: { hook: toolHook },
    rpc: {
      async register(value, registeredHandlers) {
        definition = value;
        handlers = registeredHandlers;
        if (options.registerError) throw new Error("Registration unavailable");
        return {
          dispose: unregister,
          events: {
            emit(name, data) {
              emitted.push({ name, data });
              return options.emit?.(name, data) ?? Promise.resolve();
            },
          },
        };
      },
    },
  };
  return {
    ctx, emitted, unregister, permissionHook, toolHook,
    get definition() { return definition; },
    get handlers() { return handlers!; },
    snapshot(input: unknown) { return handlers!.snapshot(input); },
  };
}

type Location = NonNullable<ReviewDisplayContext["location"]>;
type Event = { type: string; location?: { directory: string }; data?: unknown };
type Toast = Parameters<ReviewDisplayContext["ui"]["toast"]["show"]>[0];
const project = { directory: "/synthetic/project", workspaceID: "workspace-1" };
const reviewEventType = "rpc.opencode-secret-guard.jev.review";

function displayHarness(options: {
  location?: Location;
  defaultLocation?: Location;
  useDefaultLocation?: boolean;
  noLocation?: boolean;
  snapshot?: (input: { sessionID: string }, options: { location: Location; signal: AbortSignal }) => Promise<unknown>;
  toastError?: boolean;
  refreshTimeoutMs?: number;
} = {}) {
  let listener: ((event: { details: Event }) => void) | undefined;
  const definitions: (typeof JevRpc)[] = [];
  const toasts: Toast[] = [];
  const snapshotCalls: { input: { sessionID: string }; options: { location: Location; signal: AbortSignal } }[] = [];
  const unsubscribe = mock(() => {});
  const defaultLocation = mock(() => options.defaultLocation ?? project);
  const ctx: ReviewDisplayContext = {
    location: options.noLocation || options.useDefaultLocation ? undefined : options.location ?? project,
    data: {
      ...(options.noLocation ? {} : { location: { default: defaultLocation } }),
      listen(callback) {
        listener = callback;
        return unsubscribe;
      },
    },
    client: {
      rpc(definition) {
        definitions.push(definition);
        return {
          async snapshot(input, requestOptions) {
            snapshotCalls.push({ input, options: requestOptions });
            return options.snapshot ? options.snapshot(input, requestOptions) : { reviews: [] };
          },
        };
      },
    },
    ui: {
      toast: {
        show(toast) {
          toasts.push(toast);
          if (options.toastError) throw new Error("Toast unavailable");
        },
      },
    },
  };
  const display = createReviewDisplay(ctx, options.refreshTimeoutMs);
  return {
    display, definitions, toasts, snapshotCalls, unsubscribe, defaultLocation,
    event(event: Event) { listener!({ details: event }); },
    emit(data: unknown, location: { directory: string } = options.location ?? options.defaultLocation ?? project) {
      listener!({ details: { type: reviewEventType, location: { directory: location.directory }, data } });
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("review RPC boundary", () => {
  test("registers a portable definition with only snapshot and the review event", async () => {
    const rpc = rpcHarness();
    const publisher = await setupReviewStatus(rpc.ctx);
    expect(rpc.definition).toBe(JevRpc);
    expect(JSON.parse(JSON.stringify(rpc.definition))).toEqual(JevRpc);
    expect(JevRpc.id).toBe("opencode-secret-guard.jev");
    expect(Object.keys(JevRpc.methods)).toEqual(["snapshot"]);
    expect(Object.keys(rpc.handlers)).toEqual(["snapshot"]);
    expect(Object.keys(JevRpc.events)).toEqual(["review"]);
    expect(JevRpc.methods.snapshot.input).toEqual({
      type: "object", properties: { sessionID: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,80}$" } },
      required: ["sessionID"], additionalProperties: false,
    });
    expect(JevRpc.methods.snapshot.output.properties.reviews.maxItems).toBe(4);
    expect(JevRpc.events.review.schema.additionalProperties).toBe(false);
    expect(JevRpc.events.review.schema.required).toContain("workspaceID");
    expect(JevRpc.events.review.schema.properties.workspaceID).toEqual({
      anyOf: [{ type: "string", pattern: "^[A-Za-z0-9_.:-]{1,80}$" }, { type: "null" }],
    });
    expect(Object.keys(JevRpc.events.review.schema.properties).sort()).toEqual([
      "action", "applied", "callID", "contextWarnings", "elapsedMs", "messageID", "mode", "modelCalled",
      "phase", "proposed", "reason", "reviewID", "scores", "sessionID", "startedAt", "threshold", "workspaceID",
    ]);
    publisher.dispose();
  });

  test("publishes and snapshots only content-free status fields", async () => {
    const rpc = rpcHarness();
    const publisher = await setupReviewStatus(rpc.ctx);
    const safe = completed({ scores: { ...reviewedScores }, contextWarnings: { compacted: true, outside_project: false } });
    publisher.publish({
      ...safe,
      command: "synthetic-private-command", prompt: "synthetic-private-prompt",
      path: "/synthetic/private/path", response: { body: "synthetic-private-response" },
      scores: { ...reviewedScores, explanation: "synthetic-private-explanation" },
      contextWarnings: { compacted: true, outside_project: false, token: "synthetic-private-token" },
    } as ReviewStatus);
    expect(rpc.emitted).toEqual([{ name: "review", data: safe }]);
    expect(await rpc.snapshot({ sessionID: "session-1" })).toEqual({ reviews: [safe] });
    expect(JSON.stringify(rpc.emitted)).not.toContain("synthetic-private");
    publisher.dispose();
  });

  test("snapshot reads cannot invoke actions or change the stored permission outcome", async () => {
    const rpc = rpcHarness();
    const publisher = await setupReviewStatus(rpc.ctx);
    const decision = completed({ mode: "observe", proposed: "allow", applied: "ask", reason: "model-approved" });
    publisher.publish(decision);
    const result = await rpc.snapshot({ sessionID: "session-1", action: "allow", command: "synthetic-command" });
    expect(result).toEqual({ reviews: [decision] });
    result.reviews[0]!.applied = "allow";
    expect(await rpc.snapshot({ sessionID: "session-1" })).toEqual({ reviews: [decision] });
    for (const input of [null, undefined, [], "session-1", {}, { sessionID: 1 }, { sessionID: "other-session" }]) {
      expect(await rpc.snapshot(input)).toEqual({ reviews: [] });
    }
    expect(rpc.emitted).toEqual([{ name: "review", data: decision }]);
    expect(rpc.permissionHook).not.toHaveBeenCalled();
    expect(rpc.toolHook).not.toHaveBeenCalled();
    publisher.dispose();
  });

  test("drops invalid statuses and scores before emitting or snapshotting", async () => {
    const rpc = rpcHarness();
    const publisher = await setupReviewStatus(rpc.ctx);
    for (const value of [
      null, [], { ...status(), phase: "failed" }, { ...status(), action: "cat synthetic-file" },
      { ...status(), workspaceID: undefined }, { ...status(), workspaceID: "invalid workspace" },
      { ...completed(), applied: undefined }, { ...completed(), reason: "private response text" },
      { ...completed(), scores: { ...reviewedScores, high_impact: Infinity } },
      { ...completed(), scores: { ...reviewedScores, confirmation_required: -0.1 } },
      { ...completed(), scores: { ...reviewedScores, within_scope: 1.01 } },
      { ...completed(), scores: { explicitly_authorized: 0.98 } },
    ]) publisher.publish(value as ReviewStatus);
    expect(rpc.emitted).toEqual([]);
    expect(await rpc.snapshot({ sessionID: "session-1" })).toEqual({ reviews: [] });
    publisher.dispose();
  });

  test("a pending registration does not block setup and is disposed if it arrives after unload", async () => {
    const registration = deferred<ReviewRpcRegistration>();
    const dispose = mock(async () => {});
    const publisher = await setupReviewStatus({ rpc: { register: () => registration.promise } });
    publisher.publish(status());
    publisher.dispose();
    registration.resolve({ dispose, events: { emit: async () => {} } });
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  for (const failure of ["synchronous", "asynchronous"] as const) {
    test(`${failure} emit failure cannot throw or change permission state`, async () => {
      const rpc = rpcHarness({
        emit: () => {
          if (failure === "synchronous") throw new Error("Emit unavailable");
          return Promise.reject(new Error("Emit unavailable"));
        },
      });
      const publisher = await setupReviewStatus(rpc.ctx);
      const decision = completed({ applied: "deny", reason: "permission-denied" });
      expect(() => publisher.publish(decision)).not.toThrow();
      await Promise.resolve();
      expect(await rpc.snapshot({ sessionID: "session-1" })).toEqual({ reviews: [decision] });
      expect(decision.applied).toBe("deny");
      expect(rpc.permissionHook).not.toHaveBeenCalled();
      expect(rpc.toolHook).not.toHaveBeenCalled();
      publisher.dispose();
    });
  }

  test("snapshot returns at most four reviews for the requested session", async () => {
    const rpc = rpcHarness();
    const publisher = await setupReviewStatus(rpc.ctx);
    for (let index = 1; index <= 6; index++) {
      publisher.publish(completed({ reviewID: `review-${index}`, startedAt: index }));
    }
    publisher.publish(status({ reviewID: "other-review", sessionID: "session-2" }));
    expect((await rpc.snapshot({ sessionID: "session-1" })).reviews.map((entry) => entry.reviewID)).toEqual([
      "review-6", "review-5", "review-4", "review-3",
    ]);
    expect(await rpc.snapshot({ sessionID: "session-2" })).toEqual({
      reviews: [status({ reviewID: "other-review", sessionID: "session-2" })],
    });
    publisher.dispose();
  });

  test("dispose unregisters, clears snapshots and ignores future publishes", async () => {
    const rpc = rpcHarness();
    const publisher = await setupReviewStatus(rpc.ctx);
    publisher.publish(status());
    publisher.dispose();
    expect(rpc.unregister).toHaveBeenCalledTimes(1);
    expect(() => publisher.publish(completed())).not.toThrow();
    expect(await rpc.snapshot({ sessionID: "session-1" })).toEqual({ reviews: [] });
    expect(rpc.emitted).toEqual([{ name: "review", data: status() }]);
  });

  test("missing or failed registration leaves publication and cleanup safe", async () => {
    const missing = await setupReviewStatus({});
    expect(() => missing.publish(status())).not.toThrow();
    expect(() => missing.dispose()).not.toThrow();
    const rpc = rpcHarness({ registerError: true });
    const failed = await setupReviewStatus(rpc.ctx);
    expect(() => failed.publish(completed())).not.toThrow();
    expect(() => failed.dispose()).not.toThrow();
    expect(rpc.emitted).toEqual([]);
    expect(rpc.unregister).not.toHaveBeenCalled();
  });

  for (const failure of ["synchronous", "asynchronous"] as const) {
    test(`${failure} unregister failure cannot throw or retain status`, async () => {
      const rpc = rpcHarness({
        dispose: () => {
          if (failure === "synchronous") throw new Error("Unregister unavailable");
          return Promise.reject(new Error("Unregister unavailable"));
        },
      });
      const publisher = await setupReviewStatus(rpc.ctx);
      publisher.publish(status());
      expect(() => publisher.dispose()).not.toThrow();
      await Promise.resolve();
      expect(await rpc.snapshot({ sessionID: "session-1" })).toEqual({ reviews: [] });
    });
  }
});

describe("review display boundary", () => {
  test("identifies the changed session for sidebar updates and reconnect invalidation", async () => {
    const ui = displayHarness();
    const updates: Array<string | undefined> = [];
    ui.display.subscribe((sessionID) => updates.push(sessionID));
    ui.emit(status());
    ui.emit(status({ reviewID: "review-2", sessionID: "session-2" }));
    await ui.display.refresh("session-1");
    ui.event({ type: "server.connected" });
    expect(updates).toEqual(["session-1", "session-2", "session-1", undefined]);
    ui.display.dispose();
  });

  test("a hung snapshot expires, cancels its request and permits later recovery", async () => {
    let hang = true;
    const ui = displayHarness({ refreshTimeoutMs: 10, snapshot: async () =>
      hang ? new Promise(() => {}) : { reviews: [completed({ scores: reviewedScores })] } });
    expect(await ui.display.refresh("session-1")).toBe(false);
    expect(ui.snapshotCalls[0]!.options.signal.aborted).toBe(true);
    hang = false;
    expect(await ui.display.refresh("session-1")).toBe(true);
    expect(ui.display.snapshot("session-1")[0]!.scores).toEqual(reviewedScores);
    expect(ui.toasts).toEqual([]);
    ui.display.dispose();
  });

  test("accepts only host review events with the exact directory and payload workspace", () => {
    const ui = displayHarness();
    const changed = mock(() => {});
    ui.display.subscribe(changed);
    for (const location of [
      { directory: "/synthetic/other" },
      { directory: "/synthetic/project/" },
    ]) ui.emit(status(), location);
    for (const workspaceID of ["workspace-2", null, undefined, "invalid workspace", 1]) {
      ui.emit({ ...status(), workspaceID });
    }
    ui.event({ type: reviewEventType, data: status() });
    ui.event({ type: reviewEventType, location: { directory: project.directory } });
    ui.event({ type: reviewEventType, location: { directory: project.directory }, ...status() });
    ui.event({ type: "review", location: { directory: project.directory }, data: status() });
    ui.event({ type: "rpc.other-plugin.review", location: { directory: project.directory }, data: status() });
    expect(ui.toasts).toEqual([]);
    expect(ui.display.snapshot("session-1")).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    ui.event({ type: reviewEventType, location: { directory: project.directory }, data: status() });
    expect(ui.display.snapshot("session-1")).toEqual([status()]);
    expect(ui.toasts).toHaveLength(1);
    expect(ui.definitions).toEqual([]);
    ui.display.dispose();
  });

  test("uses the default location only when no explicit location exists", async () => {
    const fallback = { directory: "/synthetic/fallback" };
    const ui = displayHarness({ useDefaultLocation: true, defaultLocation: fallback });
    ui.emit(status({ workspaceID: "unexpected-workspace" }), fallback);
    const accepted = status({ workspaceID: null });
    ui.emit(accepted, fallback);
    expect(ui.toasts).toHaveLength(1);
    expect(ui.display.snapshot("session-1")).toEqual([accepted]);
    expect(await ui.display.refresh("session-1")).toBe(true);
    expect(ui.snapshotCalls).toMatchObject([{ input: { sessionID: "session-1" }, options: { location: fallback } }]);
    expect(ui.snapshotCalls[0]!.options.signal).toBeInstanceOf(AbortSignal);
    expect(ui.snapshotCalls[0]!.options.signal.aborted).toBe(false);
    ui.display.dispose();
    const explicit = displayHarness({ defaultLocation: fallback });
    explicit.emit(status(), fallback);
    expect(explicit.toasts).toEqual([]);
    expect(explicit.defaultLocation).not.toHaveBeenCalled();
    explicit.display.dispose();
  });

  test("notifies every unique live phase with reviewed status and all four scores", () => {
    const ui = displayHarness();
    const checking = status();
    const evaluating = status({ phase: "evaluating", modelCalled: true, elapsedMs: 50 });
    const done = completed({ scores: { ...reviewedScores }, contextWarnings: { compacted: true, outside_project: true } });
    const updates: ReviewStatus[][] = [];
    ui.display.subscribe(() => { updates.push(ui.display.snapshot("session-1")); });
    ui.emit(checking);
    ui.emit(evaluating);
    ui.emit(done);
    expect(updates).toEqual([[checking], [evaluating], [done]]);
    expect(ui.toasts).toEqual([
      {
        title: "Jev permission review", sessionID: "session-1", variant: "info", duration: 4_000,
        message: "Review triggered: checking eligibility\nAuto mode · bash\nScores: not evaluated",
      },
      {
        title: "Jev permission review", sessionID: "session-1", variant: "info", duration: 4_000,
        message: "Jev is evaluating\nAuto mode · bash\nScores: pending",
      },
      {
        title: "Jev permission review", sessionID: "session-1", variant: "warning", duration: 10_000,
        message: [
          "Manual approval required", "Auto mode · bash", "Proposed: ask · Applied: ask",
          "Reason: confirmation-required", ...reviewedScoreLines, "Compacted context", "Outside-project access",
        ].join("\n"),
      },
    ]);
    ui.display.dispose();
  });

  test("notifies every review rather than limiting notifications to snapshot capacity", () => {
    const ui = displayHarness();
    for (let index = 1; index <= 6; index++) {
      ui.emit(completed({ reviewID: `review-${index}` }));
    }
    expect(ui.toasts.map((toast) => toast.sessionID)).toEqual([
      "session-1", "session-1", "session-1", "session-1", "session-1", "session-1",
    ]);
    ui.display.dispose();
  });

  test("duplicates and stale snapshots cannot regress status or replay old toasts", async () => {
    const pending = deferred<unknown>();
    const ui = displayHarness({ snapshot: () => pending.promise });
    const restored = ui.display.refresh("session-1");
    const checking = status();
    const evaluating = status({ phase: "evaluating", modelCalled: true });
    const done = completed({ scores: { ...reviewedScores } });
    ui.emit(checking);
    ui.emit(checking);
    ui.emit(evaluating);
    ui.emit(checking);
    ui.emit(done);
    ui.emit(done);
    ui.emit(evaluating);
    pending.resolve({ reviews: [checking] });
    expect(await restored).toBe(true);
    expect(ui.display.snapshot("session-1")).toEqual([done]);
    expect(ui.toasts).toHaveLength(3);
    ui.emit(checking);
    ui.emit(done);
    expect(ui.toasts).toHaveLength(3);
    ui.display.dispose();
  });

  test("failed and skipped reviews never invent scores", () => {
    const ui = displayHarness();
    const failed = completed({ reason: "model-request-failed" });
    const skipped = completed({ reviewID: "review-2", modelCalled: false, reason: "action-not-eligible" });
    ui.emit(failed);
    ui.emit(skipped);
    expect(ui.toasts.map((toast) => toast.message)).toEqual([
      "Review failed; manual approval required\nAuto mode · bash\nProposed: ask · Applied: ask\nReason: model-request-failed\nScores: unavailable",
      "Review skipped; manual approval required\nAuto mode · bash\nProposed: ask · Applied: ask\nReason: action-not-eligible\nScores: not evaluated",
    ]);
    expect(ui.toasts.map((toast) => toast.variant)).toEqual(["warning", "warning"]);
    for (const entry of ui.display.snapshot("session-1")) expect(entry).not.toHaveProperty("scores");
    ui.display.dispose();
  });

  test("shows proposed allow separately from applied ask in observe mode", () => {
    const ui = displayHarness();
    ui.emit(completed({
      mode: "observe", proposed: "allow", applied: "ask", reason: "model-approved",
      scores: { ...reviewedScores, confirmation_required: 0.02 },
    }));
    expect(ui.toasts[0]).toEqual({
      title: "Jev permission review", sessionID: "session-1", variant: "warning", duration: 10_000,
      message: [
        "Would approve; manual approval required", "Observe mode · bash", "Proposed: allow · Applied: ask",
        "Reason: model-approved", "Authorization: 98% (≥90%; pass)", "Within scope: 95% (≥90%; pass)",
        "Confirmation required: 2% (≤10%; pass)", "High impact: 5% (≤10%; pass)",
      ].join("\n"),
    });
    expect(ui.display.snapshot("session-1")[0]!.applied).toBe("ask");
    ui.display.dispose();
  });

  test("applied allow succeeds but applied deny never requests manual approval", () => {
    const ui = displayHarness();
    const passingScores = { ...reviewedScores, confirmation_required: 0.02 };
    ui.emit(completed({ proposed: "allow", applied: "allow", reason: "model-approved", scores: passingScores }));
    ui.emit(completed({
      reviewID: "denied-review", proposed: "allow", applied: "deny", reason: "permission-denied", scores: passingScores,
    }));
    expect(ui.toasts.map((toast) => ({ message: toast.message, variant: toast.variant }))).toEqual([
      {
        message: [
          "Automatically approved", "Auto mode · bash", "Proposed: allow · Applied: allow", "Reason: model-approved",
          "Authorization: 98% (≥90%; pass)", "Within scope: 95% (≥90%; pass)",
          "Confirmation required: 2% (≤10%; pass)", "High impact: 5% (≤10%; pass)",
        ].join("\n"),
        variant: "success",
      },
      {
        message: [
          "Permission denied; review did not override it", "Auto mode · bash", "Proposed: allow · Applied: deny",
          "Reason: permission-denied", "Authorization: 98% (≥90%; pass)", "Within scope: 95% (≥90%; pass)",
          "Confirmation required: 2% (≤10%; pass)", "High impact: 5% (≤10%; pass)",
        ].join("\n"),
        variant: "warning",
      },
    ]);
    expect(ui.toasts[1]!.message).not.toContain("manual approval required");
    ui.display.dispose();
  });

  test("passing scores with cancelled approval never claim automatic or observe approval", () => {
    const ui = displayHarness();
    const passing = { ...reviewedScores, confirmation_required: 0.02 };
    for (const mode of ["auto", "observe"] as const) {
      ui.emit(completed({
        reviewID: `cancelled-${mode}`, mode, proposed: "allow", applied: "ask",
        reason: "approval-cancelled", scores: passing,
      }));
    }
    expect(ui.toasts.map((toast) => toast.message)).toEqual([
      [
        "Jev scores passed; approval cancelled", "Auto mode · bash", "Proposed: allow · Applied: ask",
        "Reason: approval-cancelled", "Authorization: 98% (≥90%; pass)", "Within scope: 95% (≥90%; pass)",
        "Confirmation required: 2% (≤10%; pass)", "High impact: 5% (≤10%; pass)",
      ].join("\n"),
      [
        "Jev scores passed; approval cancelled", "Observe mode · bash", "Proposed: allow · Applied: ask",
        "Reason: approval-cancelled", "Authorization: 98% (≥90%; pass)", "Within scope: 95% (≥90%; pass)",
        "Confirmation required: 2% (≤10%; pass)", "High impact: 5% (≤10%; pass)",
      ].join("\n"),
    ]);
    expect(ui.toasts.map((toast) => toast.variant)).toEqual(["warning", "warning"]);
    ui.display.dispose();
  });

  test("actionable reasons include a fixed remedy without exposing response details", () => {
    const ui = displayHarness();
    ui.emit({
      ...completed({ reason: "auth-rejected" }), response: "synthetic-private-auth-response",
    });
    expect(ui.toasts[0]!.message).toBe([
      "Review failed; manual approval required", "Auto mode · bash", "Proposed: ask · Applied: ask",
      "Reason: auth-rejected", "Scores: unavailable",
      "Next: OpenCode Zen rejected the saved API key (HTTP 401); replace the key in OpenCode.",
    ].join("\n"));
    expect(ui.display.snapshot("session-1")).toEqual([completed({ reason: "auth-rejected" })]);
    expect(JSON.stringify(ui.toasts)).not.toContain("synthetic-private-auth-response");
    ui.display.dispose();
  });

  test("invalid live data produces no toast or sidebar update", () => {
    const ui = displayHarness();
    const changes = mock(() => {});
    ui.display.subscribe(changes);
    for (const value of [null, [], {}, { ...status(), phase: "unknown" },
      { ...completed(), scores: { ...reviewedScores, high_impact: NaN } },
      { ...completed(), applied: "approved" }]) ui.emit(value);
    expect(ui.toasts).toEqual([]);
    expect(ui.display.snapshot("session-1")).toEqual([]);
    expect(changes).not.toHaveBeenCalled();
    ui.display.dispose();
  });

  test("snapshot recovery updates sidebar subscribers without replaying notifications", async () => {
    const done = completed({ scores: { ...reviewedScores } });
    const other = completed({ reviewID: "other-review", sessionID: "session-2" });
    const ui = displayHarness({ snapshot: async () => ({ reviews: [done, other] }) });
    const updates: ReviewStatus[][] = [];
    ui.display.subscribe(() => { updates.push(ui.display.snapshot("session-1")); });
    expect(await ui.display.refresh("session-1")).toBe(true);
    expect(ui.snapshotCalls).toMatchObject([{ input: { sessionID: "session-1" }, options: { location: project } }]);
    expect(ui.snapshotCalls[0]!.options.signal).toBeInstanceOf(AbortSignal);
    expect(ui.snapshotCalls[0]!.options.signal.aborted).toBe(false);
    expect(ui.definitions).toEqual([JevRpc]);
    expect(updates).toEqual([[done]]);
    expect(ui.display.snapshot("session-2")).toEqual([]);
    expect(ui.toasts).toEqual([]);
    ui.display.dispose();
  });

  test("a completed snapshot cannot consume the later live completion toast", async () => {
    const done = completed({ scores: { ...reviewedScores } });
    const ui = displayHarness({ snapshot: async () => ({ reviews: [done] }) });
    const checking = status();
    const evaluating = status({ phase: "evaluating", modelCalled: true });
    ui.emit(checking);
    expect(await ui.display.refresh("session-1")).toBe(true);
    expect(ui.display.snapshot("session-1")).toEqual([done]);
    expect(ui.toasts).toHaveLength(1);
    ui.emit(evaluating);
    ui.emit(done);
    ui.emit(done);
    expect(ui.display.snapshot("session-1")).toEqual([done]);
    expect(ui.toasts.map((toast) => toast.message)).toEqual([
      "Review triggered: checking eligibility\nAuto mode · bash\nScores: not evaluated",
      "Jev is evaluating\nAuto mode · bash\nScores: pending",
      [
        "Manual approval required", "Auto mode · bash", "Proposed: ask · Applied: ask",
        "Reason: confirmation-required", ...reviewedScoreLines,
      ].join("\n"),
    ]);
    ui.display.dispose();
  });

  test("snapshot reconciliation removes missed old reviews and restores four new completions", async () => {
    const recovered = [1, 2, 3, 4].map((index) => completed({ reviewID: `new-${index}`, startedAt: 2_000 + index }));
    const ui = displayHarness({ snapshot: async () => ({ reviews: recovered }) });
    ui.emit(status({ reviewID: "old-active" }));
    ui.emit(completed({ reviewID: "old-completed" }));
    const other = status({ reviewID: "other-review", sessionID: "session-2" });
    ui.emit(other);
    expect(await ui.display.refresh("session-1")).toBe(true);
    expect(ui.display.snapshot("session-1")).toEqual([
      completed({ reviewID: "new-4", startedAt: 2_004 }),
      completed({ reviewID: "new-3", startedAt: 2_003 }),
      completed({ reviewID: "new-2", startedAt: 2_002 }),
      completed({ reviewID: "new-1", startedAt: 2_001 }),
    ]);
    expect(ui.display.snapshot("session-2")).toEqual([other]);
    expect(ui.toasts).toHaveLength(3);
    ui.display.dispose();
  });

  test("an empty snapshot clears ghost reviews without replaying notifications", async () => {
    const ui = displayHarness();
    const checking = status();
    const done = completed({ reviewID: "completed-ghost" });
    const updates: ReviewStatus[][] = [];
    ui.display.subscribe(() => { updates.push(ui.display.snapshot("session-1")); });
    ui.emit(checking);
    ui.emit(done);
    expect(await ui.display.refresh("session-1")).toBe(true);
    expect(ui.display.snapshot("session-1")).toEqual([]);
    expect(updates.at(-1)).toEqual([]);
    expect(ui.toasts).toHaveLength(2);
    ui.emit(done);
    expect(ui.toasts).toHaveLength(2);
    ui.display.dispose();
  });

  test("reconciliation preserves new live reviews received while a snapshot is in flight", async () => {
    const pending = deferred<unknown>();
    const ui = displayHarness({ snapshot: () => pending.promise });
    ui.emit(status({ reviewID: "old-ghost" }));
    const refresh = ui.display.refresh("session-1");
    const live = status({ reviewID: "new-live", startedAt: 2_000 });
    ui.emit(live);
    pending.resolve({ reviews: [] });
    expect(await refresh).toBe(true);
    expect(ui.display.snapshot("session-1")).toEqual([live]);
    expect(ui.toasts).toHaveLength(2);
    ui.display.dispose();
  });

  test("reconciliation keeps a higher phase for IDs still present in the snapshot", async () => {
    const done = completed({ scores: { ...reviewedScores } });
    const ui = displayHarness({ snapshot: async () => ({ reviews: [status()] }) });
    ui.emit(done);
    expect(await ui.display.refresh("session-1")).toBe(true);
    expect(ui.display.snapshot("session-1")).toEqual([done]);
    expect(ui.toasts).toHaveLength(1);
    ui.display.dispose();
  });

  test("a snapshot with the wrong payload workspace fails without changing cached status", async () => {
    for (const workspaceID of ["workspace-2", null, undefined, "invalid workspace"]) {
      const ui = displayHarness({ snapshot: async () => ({ reviews: [{ ...completed(), workspaceID }] }) });
      const checking = status();
      ui.emit(checking);
      expect(await ui.display.refresh("session-1")).toBe(false);
      expect(ui.display.snapshot("session-1")).toEqual([checking]);
      expect(ui.toasts).toHaveLength(1);
      ui.display.dispose();
    }
  });

  test("malformed and oversized snapshot results return false without state or toasts", async () => {
    for (const result of [null, undefined, [], "result", {}, { reviews: null }, { reviews: {} },
      { reviews: "reviews" }, { reviews: Array.from({ length: 5 }, (_, index) => completed({ reviewID: `review-${index}` })) }]) {
      const ui = displayHarness({ snapshot: async () => result });
      const changes = mock(() => {});
      ui.display.subscribe(changes);
      expect(await ui.display.refresh("session-1")).toBe(false);
      expect(ui.display.snapshot("session-1")).toEqual([]);
      expect(ui.toasts).toEqual([]);
      expect(changes).not.toHaveBeenCalled();
      ui.display.dispose();
    }
  });

  test("a malformed status in the requested session makes snapshot recovery fail", async () => {
    const ui = displayHarness({ snapshot: async () => ({ reviews: [{ ...completed(), scores: { ...reviewedScores, high_impact: Infinity } }] }) });
    expect(await ui.display.refresh("session-1")).toBe(false);
    expect(ui.display.snapshot("session-1")).toEqual([]);
    expect(ui.toasts).toEqual([]);
    ui.display.dispose();
  });

  for (const failure of ["synchronous", "asynchronous"] as const) {
    test(`${failure} snapshot failure returns false without a toast or exception`, async () => {
      const ui = displayHarness({
        snapshot: () => {
          if (failure === "synchronous") throw new Error("Snapshot unavailable");
          return Promise.reject(new Error("Snapshot unavailable"));
        },
      });
      expect(await ui.display.refresh("session-1")).toBe(false);
      expect(ui.toasts).toEqual([]);
      expect(ui.display.snapshot("session-1")).toEqual([]);
      ui.display.dispose();
    });
  }

  test("missing location ignores live events and does not issue a snapshot request", async () => {
    const ui = displayHarness({ noLocation: true });
    ui.emit(status());
    expect(await ui.display.refresh("session-1")).toBe(false);
    expect(ui.snapshotCalls).toEqual([]);
    expect(ui.toasts).toEqual([]);
    expect(ui.display.snapshot("session-1")).toEqual([]);
    ui.display.dispose();
  });

  test("throwing toast and subscriber callbacks cannot prevent status updates", () => {
    const ui = displayHarness({ toastError: true });
    ui.display.subscribe(() => { throw new Error("Subscriber unavailable"); });
    const updates: ReviewStatus[][] = [];
    ui.display.subscribe(() => { updates.push(ui.display.snapshot("session-1")); });
    expect(() => ui.emit(status())).not.toThrow();
    expect(() => ui.emit(completed())).not.toThrow();
    expect(updates).toEqual([[status()], [completed()]]);
    expect(ui.display.snapshot("session-1")).toEqual([completed()]);
    ui.display.dispose();
  });

  test("subscriber cleanup stops sidebar updates without stopping the live display", () => {
    const ui = displayHarness();
    const updates: ReviewStatus[][] = [];
    const stop = ui.display.subscribe(() => { updates.push(ui.display.snapshot("session-1")); });
    ui.emit(status());
    stop();
    ui.emit(completed());
    expect(updates).toEqual([[status()]]);
    expect(ui.display.snapshot("session-1")).toEqual([completed()]);
    expect(ui.toasts).toHaveLength(2);
    ui.display.dispose();
  });

  test("server reconnect clears cached reviews and notifies reconnect subscribers before new live events", () => {
    const ui = displayHarness();
    const checking = status();
    const other = status({ reviewID: "other-review", sessionID: "session-2" });
    ui.emit(checking);
    ui.emit(other);
    const updates: ReviewStatus[][] = [];
    ui.display.subscribe(() => { updates.push(ui.display.snapshot("session-1")); });
    const reconnectSnapshots: ReviewStatus[][] = [];
    ui.display.onReconnect(() => { reconnectSnapshots.push(ui.display.snapshot("session-1")); });
    ui.event({ type: "server.connected" });
    expect(updates).toEqual([[]]);
    expect(reconnectSnapshots).toEqual([[]]);
    expect(ui.display.snapshot("session-2")).toEqual([]);
    expect(ui.toasts).toHaveLength(2);
    expect(ui.unsubscribe).not.toHaveBeenCalled();
    const done = completed();
    ui.emit(done);
    expect(ui.display.snapshot("session-1")).toEqual([done]);
    expect(updates).toEqual([[], [done]]);
    expect(ui.toasts).toHaveLength(3);
    ui.emit(checking);
    expect(ui.toasts).toHaveLength(3);
    ui.display.dispose();
  });

  test("reconnect callbacks can restore status without replaying snapshot toasts", async () => {
    const done = completed({ scores: { ...reviewedScores } });
    const ui = displayHarness({ snapshot: async () => ({ reviews: [done] }) });
    let recovery: Promise<boolean> | undefined;
    ui.display.onReconnect(() => { recovery = ui.display.refresh("session-1"); });
    ui.event({ type: "server.connected" });
    expect(recovery).toBeDefined();
    expect(await recovery).toBe(true);
    expect(ui.display.snapshot("session-1")).toEqual([done]);
    expect(ui.snapshotCalls).toMatchObject([{ input: { sessionID: "session-1" }, options: { location: project } }]);
    expect(ui.toasts).toEqual([]);
    ui.display.dispose();
  });

  test("reconnect aborts an old snapshot before it can refill the cache", async () => {
    const pending = deferred<unknown>();
    const ui = displayHarness({ snapshot: () => pending.promise });
    ui.emit(status());
    const refresh = ui.display.refresh("session-1");
    ui.event({ type: "server.connected" });
    expect(ui.snapshotCalls[0]!.options.signal.aborted).toBe(true);
    expect(await refresh).toBe(false);
    pending.resolve({ reviews: [completed()] });
    await Promise.resolve();
    expect(ui.display.snapshot("session-1")).toEqual([]);
    expect(ui.toasts).toHaveLength(1);
    ui.display.dispose();
  });

  test("reconnect subscriber cleanup and throwing callbacks leave the host listener usable", () => {
    const ui = displayHarness();
    const removed = mock(() => {});
    const stop = ui.display.onReconnect(removed);
    stop();
    ui.display.onReconnect(() => { throw new Error("Reconnect subscriber unavailable"); });
    const reconnects: ReviewStatus[][] = [];
    ui.display.onReconnect(() => { reconnects.push(ui.display.snapshot("session-1")); });
    expect(() => ui.event({ type: "server.connected" })).not.toThrow();
    expect(removed).not.toHaveBeenCalled();
    expect(reconnects).toEqual([[]]);
    ui.emit(status());
    expect(ui.display.snapshot("session-1")).toEqual([status()]);
    ui.display.dispose();
    ui.event({ type: "server.connected" });
    expect(reconnects).toEqual([[]]);
    expect(ui.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("dispose unsubscribes and ignores queued events and an in-flight snapshot", async () => {
    const pending = deferred<unknown>();
    const ui = displayHarness({ snapshot: () => pending.promise });
    const updates: ReviewStatus[][] = [];
    ui.display.subscribe(() => { updates.push(ui.display.snapshot("session-1")); });
    ui.emit(status());
    const refresh = ui.display.refresh("session-1");
    ui.display.dispose();
    expect(ui.unsubscribe).toHaveBeenCalledTimes(1);
    expect(ui.snapshotCalls[0]!.options.signal.aborted).toBe(true);
    ui.emit(completed());
    pending.resolve({ reviews: [completed()] });
    expect(await refresh).toBe(false);
    expect(ui.display.snapshot("session-1")).toEqual([]);
    expect(updates).toEqual([[status()]]);
    expect(ui.toasts).toHaveLength(1);
    expect(await ui.display.refresh("session-1")).toBe(false);
    expect(ui.snapshotCalls).toHaveLength(1);
  });
});
