import { createComponent, createEffect, createSignal, onCleanup } from "solid-js";
import { Dynamic } from "@opentui/solid";
import type { ReviewAvailability, ReviewStatus } from "./review-status.ts";
import { panelLines, type PanelLine, type ReviewSummary, type Tone } from "./review-summary.ts";
import type { ReviewDisplay } from "./review-display.ts";

/** Colours are opaque to the plugin and passed straight to OpenTUI. */
type Color = unknown;
export interface ReviewPanelContext {
  readonly ui: {
    slot(claim: { append: "sidebar.content"; render(props: { readonly sessionID: string }): unknown }): () => void;
  };
  readonly theme?: {
    readonly text: {
      readonly base: Color;
      readonly muted: Color;
      readonly faint: Color;
      readonly feedback: Readonly<Record<"success" | "warning" | "error" | "info", { readonly base: Color }>>;
    };
  };
}

/** OpenTUI's TextAttributes.BOLD. */
const BOLD = 1;

function toneColor(ctx: ReviewPanelContext, tone: Tone): Color {
  const text = ctx.theme?.text;
  if (!text) return undefined;
  if (tone === "title" || tone === "base") return text.base;
  if (tone === "muted" || tone === "faint") return text[tone];
  return text.feedback[tone]?.base;
}

/** Uses the host's shared Solid/OpenTUI runtime, without a JSX build step. */
export function registerReviewPanel(ctx: ReviewPanelContext, display: ReviewDisplay): () => void {
  // One text per line, so long lines wrap. Span colours apply only through `style`.
  const line = (segments: PanelLine) => createComponent(Dynamic, {
    component: "text",
    children: segments.length ? segments.map((segment) => createComponent(Dynamic, {
      component: "span",
      style: { fg: toneColor(ctx, segment.tone), ...(segment.tone === "title" ? { attributes: BOLD } : {}) },
      children: segment.text,
    })) : " ",
  });

  function Summary(props: { readonly sessionID: string }) {
    const [summary, setSummary] = createSignal<ReviewSummary>();
    const [latest, setLatest] = createSignal<ReviewStatus>();
    const [available, setAvailable] = createSignal<ReviewAvailability>();
    createEffect(() => {
      const sessionID = props.sessionID;
      let active = true;
      let receivedUpdates = 0;
      const load = () => {
        const current = display.summary(sessionID);
        const newest = display.snapshot(sessionID)[0];
        setSummary(current);
        setLatest(newest);
        return Boolean(current || newest);
      };
      setAvailable(undefined);
      load();
      const stop = display.subscribe((changedSession) => {
        if (!active || (changedSession !== undefined && changedSession !== sessionID)) return;
        if (load()) { receivedUpdates++; setAvailable({ ok: true }); }
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
      component: "box", flexDirection: "column",
      get children() { return panelLines(summary(), latest(), available()).map(line); },
    });
  }
  return ctx.ui.slot({ append: "sidebar.content", render: (props) => createComponent(Summary, props) });
}
