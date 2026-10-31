import { createComponent, createEffect, createSignal, onCleanup } from "solid-js";
import { Dynamic } from "@opentui/solid";
import { reviewLines, type ReviewStatus } from "./review-status.ts";
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
    const [available, setAvailable] = createSignal<boolean | undefined>();
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
        if (current.length) { receivedUpdates++; setAvailable(true); }
      });
      const refresh = async () => {
        const before = receivedUpdates;
        const result = await display.refresh(sessionID);
        if (active && (result || receivedUpdates === before)) setAvailable(result);
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
          get children() {
            const state = reviews();
            // An off reviewer has no RPC registration. Keep its sidebar contribution empty.
            if (available() !== true && state.length === 0) return "";
            const connection = available() === false ? "\nReview status unavailable; cached results below.\n" : "\n";
            return "JEV PERMISSION REVIEW" + connection + (state.length ? state.map((status) => reviewLines(status, true).join("\n")).join("\n\n") :
              available() === undefined ? "Loading review status…" : available() ? "No reviews recorded for this session." : "No cached review status.");
          },
        });
      },
    });
  }
  return ctx.ui.slot({ append: "sidebar.content", render: (props) => createComponent(Summary, props) });
}
