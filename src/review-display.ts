import { JevRpc } from "./review-rpc.ts";
import { createReviewStatusStore, MAX_SESSION_REVIEWS, parseReviewStatus, reviewLines, type ReviewStatus } from "./review-status.ts";

type Location = { directory: string; workspaceID?: string };
export interface ReviewDisplayContext {
  readonly location?: Location;
  readonly data: {
    location?: { default(): Location };
    listen(listener: (event: { details: { type: string; location?: { directory: string }; data?: unknown } }) => void): () => void;
  };
  readonly client: {
    rpc(definition: typeof JevRpc): {
      snapshot(input: { sessionID: string }, options: { location: Location; signal: AbortSignal }): Promise<unknown>;
    };
  };
  readonly ui: {
    readonly toast: { show(options: {
      title: string; message: string; variant: "info" | "success" | "warning"; duration: number; sessionID: string;
    }): void };
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Live updates notify. Snapshots only restore the display, without replaying old notifications. */
export function createReviewDisplay(ctx: ReviewDisplayContext, refreshTimeoutMs = 4_000) {
  const store = createReviewStatusStore();
  const notified = createReviewStatusStore();
  const listeners = new Set<(sessionID?: string) => void>();
  const reconnectListeners = new Set<() => void>();
  const requests = new Set<{ controller: AbortController; sessionID: string; live: ReturnType<typeof createReviewStatusStore> }>();
  let disposed = false;
  const location = () => ctx.location ?? ctx.data.location?.default();
  const changed = (sessionID?: string) => {
    for (const listener of listeners) {
      try { listener(sessionID); } catch { /* Display only. */ }
    }
  };
  // Use the host's reconnecting bus, not a second raw RPC event stream.
  const stop = ctx.data.listen(({ details: event }) => {
    if (disposed) return;
    if (event.type === "server.connected") {
      for (const request of requests) request.controller.abort();
      store.clear();
      changed();
      for (const listener of reconnectListeners) {
        try { listener(); } catch { /* Display only. */ }
      }
      return;
    }
    if (event.type !== `rpc.${JevRpc.id}.review`) return;
    const current = location();
    if (!current || event.location?.directory !== current.directory) return;
    // Public event locations omit workspaceID. The server includes it in the validated payload.
    const status = parseReviewStatus(event.data);
    if (!status || status.workspaceID !== (current.workspaceID ?? null)) return;
    for (const request of requests) {
      if (request.sessionID === status.sessionID) request.live.update(status);
    }
    if (store.update(status)) changed(status.sessionID);
    // Snapshots cannot consume a live phase's notification.
    if (!notified.update(status)) return;
    try {
      ctx.ui.toast.show({
        title: "Jev permission review",
        message: reviewLines(status).join("\n"),
        variant: status.phase !== "completed" ? "info" : status.applied === "allow" ? "success" : "warning",
        duration: status.phase === "completed" ? 10_000 : 4_000,
        sessionID: status.sessionID,
      });
    } catch { /* Display only. */ }
  });
  return {
    snapshot(sessionID: string): ReviewStatus[] { return store.snapshot(sessionID); },
    async refresh(sessionID: string): Promise<boolean> {
      const current = location();
      if (disposed || !current) return false;
      const controller = new AbortController();
      const request = { controller, sessionID, live: createReviewStatusStore() };
      requests.add(request);
      const timer = setTimeout(() => controller.abort(), refreshTimeoutMs);
      const interrupted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("review-status-unavailable")), { once: true });
      });
      try {
        const result = await Promise.race([
          ctx.client.rpc(JevRpc).snapshot({ sessionID }, { location: current, signal: controller.signal }), interrupted,
        ]);
        if (disposed || !record(result) || !Array.isArray(result.reviews) || result.reviews.length > MAX_SESSION_REVIEWS) return false;
        const statuses: ReviewStatus[] = [];
        for (const value of result.reviews) {
          if (!record(value) || typeof value.sessionID !== "string") return false;
          if (value.sessionID !== sessionID) continue;
          const status = parseReviewStatus(value);
          if (!status) return false;
          if (status.workspaceID !== (current.workspaceID ?? null)) return false;
          statuses.push(status);
        }
        store.reconcile(sessionID, [...statuses, ...request.live.snapshot(sessionID)]);
        changed(sessionID);
        return true;
      } catch { return false; }
      finally { clearTimeout(timer); requests.delete(request); }
    },
    subscribe(listener: (sessionID?: string) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    onReconnect(listener: () => void): () => void {
      reconnectListeners.add(listener);
      return () => { reconnectListeners.delete(listener); };
    },
    dispose() {
      disposed = true;
      for (const request of requests) request.controller.abort();
      requests.clear();
      stop();
      listeners.clear();
      reconnectListeners.clear();
      store.clear();
      notified.clear();
    },
  };
}

export type ReviewDisplay = ReturnType<typeof createReviewDisplay>;
