import { describe, expect, mock, test } from "bun:test";
import type { ReviewDisplay, ReviewDisplayContext } from "../src/review-display.ts";
import type { ReviewPanelContext } from "../src/review-panel.ts";
import { JevRpc } from "../src/review-rpc.ts";
import type { ReviewStatus } from "../src/review-status.ts";
import { setupTui, type TuiContext } from "../src/tui.ts";

type Host = TuiContext & ReviewDisplayContext & ReviewPanelContext;
type BusListener = Parameters<ReviewDisplayContext["data"]["listen"]>[0];
type PermissionListener = Parameters<TuiContext["data"]["on"]>[1];
type Slot = Parameters<ReviewPanelContext["ui"]["slot"]>[0];
type Snapshot = ReturnType<ReviewDisplayContext["client"]["rpc"]>["snapshot"];
type Panel = { registerReviewPanel(ctx: ReviewPanelContext, display: ReviewDisplay): () => void };
type Toast = Parameters<TuiContext["ui"]["toast"]["show"]>[0];
const project = { directory: "/synthetic/project" };

function status(overrides: Partial<ReviewStatus> = {}): ReviewStatus {
  return {
    reviewID: "review-1", sessionID: "session-1", workspaceID: null,
    messageID: "message-1", callID: "call-1", action: "bash", mode: "auto",
    phase: "checking", modelCalled: false, startedAt: 1_000, elapsedMs: 0, threshold: 0.9,
    ...overrides,
  };
}

function completed(overrides: Partial<ReviewStatus> = {}): ReviewStatus {
  return status({
    phase: "completed", modelCalled: true, elapsedMs: 250,
    proposed: "ask", applied: "ask", reason: "model-confirmation-required",
    ...overrides,
  });
}

const scores = {
  explicitly_authorized: 0.98, within_scope: 0.95, confirmation_required: 0.22, high_impact: 0.05,
};
const completedMessage = [
  "Manual approval required", "Auto mode · bash", "Proposed: ask · Applied: ask",
  "Reason: model-confirmation-required", "Authorization: 98% (≥90%; pass)",
  "Within scope: 95% (≥90%; pass)", "Confirmation required: 22% (≤10%; fail)",
  "High impact: 5% (≤10%; pass)",
].join("\n");
const loaderWarning: Toast = {
  title: "Secret guard review",
  message: "The Jev sidebar could not load. Review notifications and decision logs remain available.",
  variant: "warning", duration: 8_000,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function settlePanel() {
  await Promise.resolve();
  await Promise.resolve();
}

function host(snapshotHandler: Snapshot = async () => ({ reviews: [] })) {
  const busListeners = new Set<BusListener>();
  const permissionListeners = new Set<PermissionListener>();
  const toasts: Toast[] = [];
  const slots: Slot[] = [];
  const displays: ReviewDisplay[] = [];
  const stopBus = mock(() => { busListeners.clear(); });
  const stopWarnings = mock(() => { permissionListeners.clear(); });
  const unregister = mock(() => { slots.length = 0; });
  const listen = mock((listener: BusListener) => { busListeners.add(listener); return stopBus; });
  const on = mock((_type: "permission.asked", listener: PermissionListener) => {
    permissionListeners.add(listener);
    return stopWarnings;
  });
  const snapshot = mock(snapshotHandler);
  // The supported host uses its reconnecting bus. RPC exposes no raw event stream or model methods.
  const rpcClient = { snapshot };
  const rpc = mock((_definition: typeof JevRpc) => rpcClient);
  const slot = mock((claim: Slot) => { slots.push(claim); return unregister; });
  const ctx: Host = {
    location: project,
    data: { listen, on },
    client: { rpc },
    ui: { slot, toast: { show: (toast) => { toasts.push(toast); } } },
  };
  // This fake claims a real host slot. Native rendering has separate validation.
  const panel: Panel = {
    registerReviewPanel: mock((panelContext: ReviewPanelContext, display: ReviewDisplay) => {
      displays.push(display);
      return panelContext.ui.slot({ append: "sidebar.content", render: (props) => display.snapshot(props.sessionID) });
    }),
  };
  return {
    ctx, panel, displays, slots, toasts, listen, on, stopBus, stopWarnings, unregister, rpc, rpcClient, snapshot, slot,
    get display() { return displays[0]!; },
    event(type: string, data?: unknown) {
      for (const listener of busListeners) listener({ details: { type, location: project, data } });
    },
    emit(data: unknown) {
      this.event("rpc.opencode-secret-guard.jev.review", data);
    },
    permission(message: string, id = "permission-1") {
      for (const listener of permissionListeners) listener({ data: { id, sessionID: "session-1", message } });
    },
  };
}

describe("supported TUI setup", () => {
  test("registers bus and warning listeners before the deferred panel claims its sidebar slot", async () => {
    const ui = host();
    const loading = deferred<Panel>();
    const dispose = setupTui(ui.ctx, () => loading.promise);
    expect(ui.listen).toHaveBeenCalledTimes(1);
    expect(ui.on.mock.calls.map(([type]) => type)).toEqual(["permission.asked"]);
    expect(ui.slots).toEqual([]);
    expect(ui.rpc).not.toHaveBeenCalled();
    ui.emit(status());
    loading.resolve(ui.panel);
    await settlePanel();
    expect(ui.slots).toHaveLength(1);
    expect(ui.slots[0]!.append).toBe("sidebar.content");
    expect(typeof ui.slots[0]!.render).toBe("function");
    expect(ui.display.snapshot("session-1")).toEqual([status()]);
    expect(ui.toasts).toEqual([{
      title: "Jev permission review", sessionID: "session-1", variant: "info", duration: 4_000,
      message: "Review triggered: checking eligibility\nAuto mode · bash\nScores: not evaluated",
    }]);
    expect(ui.rpc).not.toHaveBeenCalled();
    dispose();
  });

  test("notifies each live phase once and shows all four reviewed scores", async () => {
    const ui = host();
    const dispose = setupTui(ui.ctx, async () => ui.panel);
    await settlePanel();
    const checking = status();
    const evaluating = status({ phase: "evaluating", modelCalled: true, elapsedMs: 50 });
    const done = completed({ scores });
    ui.emit(checking);
    ui.emit(checking);
    ui.emit(evaluating);
    ui.emit(done);
    ui.emit(evaluating);
    ui.emit(done);
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
        message: completedMessage,
      },
    ]);
    expect(ui.display.snapshot("session-1")).toEqual([done]);
    expect(ui.rpc).not.toHaveBeenCalled();
    expect(Object.keys(ui.rpcClient)).toEqual(["snapshot"]);
    dispose();
  });

  test("restores status through snapshot-only RPC without replaying notifications", async () => {
    const done = completed({ scores });
    const ui = host(async () => ({ reviews: [done] }));
    const dispose = setupTui(ui.ctx, async () => ui.panel);
    await settlePanel();
    expect(await ui.display.refresh("session-1")).toBe(true);
    expect(ui.rpc.mock.calls).toEqual([[JevRpc]]);
    expect(ui.snapshot.mock.calls).toHaveLength(1);
    const [input, options] = ui.snapshot.mock.calls[0]!;
    expect(input).toEqual({ sessionID: "session-1" });
    expect(options.location).toEqual(project);
    expect(options.signal.aborted).toBe(false);
    expect(ui.display.snapshot("session-1")).toEqual([done]);
    expect(ui.toasts).toEqual([]);
    dispose();
  });

  test("cleanup unregisters the slot, stops listeners and ignores late snapshot completion", async () => {
    const pending = deferred<unknown>();
    const ui = host(() => pending.promise);
    const dispose = setupTui(ui.ctx, async () => ui.panel);
    await settlePanel();
    const queuedBusEvent = ui.listen.mock.calls[0]![0];
    ui.emit(status());
    const refresh = ui.display.refresh("session-1");
    dispose();
    expect(ui.unregister).toHaveBeenCalledTimes(1);
    expect(ui.stopBus).toHaveBeenCalledTimes(1);
    expect(ui.stopWarnings).toHaveBeenCalledTimes(1);
    expect(ui.slots).toEqual([]);
    expect(ui.snapshot.mock.calls[0]![1].signal.aborted).toBe(true);
    ui.emit(completed({ scores }));
    queuedBusEvent({ details: { type: "rpc.opencode-secret-guard.jev.review", location: project, data: completed({ scores }) } });
    ui.permission("secret-guard log: unavailable");
    pending.resolve({ reviews: [completed({ scores })] });
    expect(await refresh).toBe(false);
    expect(ui.display.snapshot("session-1")).toEqual([]);
    expect(ui.toasts).toHaveLength(1);
    expect(await ui.display.refresh("session-1")).toBe(false);
    expect(ui.snapshot).toHaveBeenCalledTimes(1);
  });

  test("a rejected panel loader warns but live review notifications retain all four scores", async () => {
    const ui = host();
    const loading = deferred<Panel>();
    const dispose = setupTui(ui.ctx, () => loading.promise);
    loading.reject(new Error("synthetic panel unavailable"));
    await settlePanel();
    expect(ui.toasts).toEqual([loaderWarning]);
    expect(ui.slots).toEqual([]);
    ui.emit(completed({ scores }));
    expect(ui.toasts).toEqual([loaderWarning, {
      title: "Jev permission review", sessionID: "session-1", variant: "warning", duration: 10_000,
      message: completedMessage,
    }]);
    expect(ui.rpc).not.toHaveBeenCalled();
    dispose();
    expect(ui.stopBus).toHaveBeenCalledTimes(1);
    expect(ui.stopWarnings).toHaveBeenCalledTimes(1);
  });

  for (const outcome of ["resolved", "rejected"] as const) {
    test(`dispose before the panel import is ${outcome} does not register or warn`, async () => {
      const ui = host();
      const loading = deferred<Panel>();
      const dispose = setupTui(ui.ctx, () => loading.promise);
      dispose();
      if (outcome === "resolved") loading.resolve(ui.panel);
      else loading.reject(new Error("synthetic panel unavailable"));
      await settlePanel();
      expect(ui.displays).toEqual([]);
      expect(ui.slot).not.toHaveBeenCalled();
      expect(ui.unregister).not.toHaveBeenCalled();
      expect(ui.stopBus).toHaveBeenCalledTimes(1);
      expect(ui.stopWarnings).toHaveBeenCalledTimes(1);
      expect(ui.toasts).toEqual([]);
      expect(ui.rpc).not.toHaveBeenCalled();
    });
  }

  test("modern permission messages show log warnings, not duplicate review-note notifications", async () => {
    const ui = host();
    const dispose = setupTui(ui.ctx, async () => ui.panel);
    await settlePanel();
    ui.permission("secret-guard review: manual approval (auth-no-connection)");
    ui.permission("secret-guard review: would allow (model-approved)", "permission-2");
    expect(ui.toasts).toEqual([]);
    ui.permission([
      "secret-guard review: manual approval (auth-no-connection)",
      "secret-guard log: unavailable", "secret-guard log: payloads unavailable",
    ].join("\n"), "permission-3");
    expect(ui.toasts).toEqual([
      {
        title: "Secret guard review", sessionID: "session-1", variant: "warning", duration: 8_000,
        message: "The decision log cannot be written. Check that ~/.local/state/opencode-secret-guard (or under $XDG_STATE_HOME) and its file are yours with private permissions, and that the disk has space. Approvals are unaffected.",
      },
      {
        title: "Secret guard review", sessionID: "session-1", variant: "warning", duration: 8_000,
        message: "The payload log (permission-review-payloads.jsonl, enabled by logPayloads) cannot be written. Check that its directory and file are yours with private permissions, and that the disk has space. Approvals are unaffected.",
      },
    ]);
    ui.permission("secret-guard log: unavailable\nsecret-guard log: payloads unavailable", "permission-4");
    expect(ui.toasts).toHaveLength(2);
    dispose();
  });

  test("a completed RPC event supplies the remedy for a missing Zen connection", async () => {
    const ui = host();
    const dispose = setupTui(ui.ctx, async () => ui.panel);
    await settlePanel();
    const done = completed({ modelCalled: false, reason: "auth-no-connection" });
    ui.permission("secret-guard review: manual approval (auth-no-connection)");
    ui.emit(done);
    expect(ui.toasts).toEqual([{
      title: "Jev permission review", sessionID: "session-1", variant: "warning", duration: 10_000,
      message: [
        "Review skipped; manual approval required", "Auto mode · bash", "Proposed: ask · Applied: ask",
        "Reason: auth-no-connection", "Scores: not evaluated",
        "Next: no active OpenCode Zen connection; connect OpenCode Zen with an API key in OpenCode, then retry.",
      ].join("\n"),
    }]);
    expect(ui.display.snapshot("session-1")).toEqual([done]);
    expect(ui.rpc).not.toHaveBeenCalled();
    dispose();
  });

  test("the host bus reconnect clears cached status and permits a new live notification", async () => {
    const ui = host();
    const dispose = setupTui(ui.ctx, async () => ui.panel);
    await settlePanel();
    const reconnect = mock(() => {});
    ui.display.onReconnect(reconnect);
    ui.emit(status());
    ui.event("server.connected");
    expect(ui.display.snapshot("session-1")).toEqual([]);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(ui.toasts).toHaveLength(1);
    ui.emit(status());
    expect(ui.toasts).toHaveLength(1);
    ui.emit(completed({ scores }));
    expect(ui.toasts[1]!.message).toBe(completedMessage);
    expect(ui.rpc).not.toHaveBeenCalled();
    dispose();
  });

  for (const failure of ["synchronous", "asynchronous"] as const) {
    test(`an absent review RPC with ${failure} snapshot failure stays quiet`, async () => {
      const ui = host(() => {
        if (failure === "synchronous") throw new Error("synthetic RPC not registered");
        return Promise.reject(new Error("synthetic RPC not registered"));
      });
      const dispose = setupTui(ui.ctx, async () => ui.panel);
      await settlePanel();
      expect(ui.toasts).toEqual([]);
      expect(await ui.display.refresh("session-1")).toBe(false);
      expect(ui.display.snapshot("session-1")).toEqual([]);
      expect(ui.toasts).toEqual([]);
      expect(ui.rpc.mock.calls).toEqual([[JevRpc]]);
      expect(ui.snapshot).toHaveBeenCalledTimes(1);
      expect(Object.keys(ui.ctx.client)).toEqual(["rpc"]);
      expect(Object.keys(ui.rpcClient)).toEqual(["snapshot"]);
      dispose();
    });
  }
});

describe("defensive partial-host fallback", () => {
  for (const missing of ["data.listen", "client.rpc", "ui.slot"] as const) {
    test(`a partial host without ${missing} retains permission-note notifications`, () => {
      const ui = host();
      const ctx = {
        ...ui.ctx,
        data: missing === "data.listen" ? { on: ui.ctx.data.on } : ui.ctx.data,
        client: missing === "client.rpc" ? undefined : ui.ctx.client,
        ui: missing === "ui.slot" ? { toast: ui.ctx.ui.toast } : ui.ctx.ui,
      };
      const loadPanel = mock(async () => ui.panel);
      const dispose = setupTui(ctx, loadPanel);
      ui.permission("secret-guard review: manual approval (auth-no-connection)");
      expect(ui.toasts).toEqual([{
        title: "Secret guard review", sessionID: "session-1", variant: "warning", duration: 8_000,
        message: "Manual approval required: no active OpenCode Zen connection; connect OpenCode Zen with an API key in OpenCode, then retry.",
      }]);
      expect(ui.listen).not.toHaveBeenCalled();
      expect(ui.rpc).not.toHaveBeenCalled();
      expect(loadPanel).not.toHaveBeenCalled();
      dispose();
      expect(ui.stopWarnings).toHaveBeenCalledTimes(1);
    });
  }
});
