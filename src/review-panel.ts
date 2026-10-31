import { createComponent, createEffect, createSignal, onCleanup } from "solid-js";
import { Dynamic } from "@opentui/solid";
import { panelText, type ReviewAvailability, type ReviewStatus } from "./review-status.ts";
import type { ReviewDisplay } from "./review-display.ts";

export interface ReviewPanelContext {
  readonly ui: {
    slot(claim: { append: "sidebar.content"; render(props: { readonly sessionID: string }): unknown }): () => void;
  };
}

/** Uses the host's shared Solid/OpenTUI runtime, without a JSX build step. */
export function registerReviewPanel(ctx: ReviewPanelContext, display: ReviewDisplay): () => void {
  function Summary(props: { readonly sessionID: string }) {
    const [reviews, setReviews] = createSignal<ReviewStatus[]>([]);
    const [available, setAvailable] = createSignal<ReviewAvailability>();
    createEffect(() => {
      const sessionID = props.sessionID;
      let active = true;
      let receivedUpdates = 0;
      setAvailable(undefined);
      setReviews(display.snapshot(sessionID));
      const stop = display.subscribe((changedSession) => {
        if (!active || (changedSession !== undefined && changedSession !== sessionID)) return;
        const current = display.snapshot(sessionID);
        setReviews(current);
        if (current.length) { receivedUpdates++; setAvailable({ ok: true }); }
      });
      const refresh = async () => {
        const before = receivedUpdates;
        const result = await display.refresh(sessionID);
        if (!result.ok && result.code === "cancelled") return;
        if (active && (result.ok || receivedUpdates === before)) setAvailable(result);
      };
      void refresh();
      const stopReconnect = display.onReconnect(() => { void refresh(); });
      onCleanup(() => { active = false; stop(); stopReconnect(); });
    });
    return createComponent(Dynamic, {
      component: "box", flexDirection: "column", gap: 1,
      get children() {
        return createComponent(Dynamic, {
          component: "text",
          get children() { return panelText(reviews(), available()); },
        });
      },
    });
  }
  return ctx.ui.slot({ append: "sidebar.content", render: (props) => createComponent(Summary, props) });
}
