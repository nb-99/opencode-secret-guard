import type { ColorInput } from "@opentui/core";
import { createComponent, createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Dynamic } from "@opentui/solid";
import type { ReviewAvailability, ReviewStatus } from "./review-status.ts";
import { panelSection, type PanelLine, type PanelSection, type ReviewSummary, type Tone } from "./review-summary.ts";
import type { ReviewDisplay } from "./review-display.ts";

/** Colours are opaque to the plugin and passed straight to OpenTUI. */
type Color = ColorInput;
export interface ReviewPanelContext {
  readonly ui: {
    slot(claim: { append: "sidebar.content"; render(props: { readonly sessionID: string }): unknown }): () => void;
  };
  readonly storage?: {
    store<Value extends object>(
      key: string,
      options: { readonly initial: Value },
    ): readonly [Readonly<Value>, (mutation: (draft: Value) => void) => Promise<void>];
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

function toneColor(ctx: ReviewPanelContext, tone: Tone): Color | undefined {
  const text = ctx.theme?.text;
  if (!text) return undefined;
  if (tone === "base" || tone === "muted" || tone === "faint") return text[tone];
  return text.feedback[tone]?.base;
}

function openState(
  ctx: ReviewPanelContext,
  fallback: () => boolean,
  toggleFallback: () => void,
): readonly [() => boolean, () => void] {
  if (ctx.storage?.store) {
    try {
      const [view, updateView] = ctx.storage.store("view", { initial: { open: true } });
      return [
        () => view.open !== false,
        () => { void updateView((draft) => { draft.open = draft.open === false; }).catch(() => {}); },
      ];
    } catch { /* Fall back to in-memory toggle. */ }
  }
  return [fallback, toggleFallback];
}

/** Uses the host's shared Solid/OpenTUI runtime, without a JSX build step. */
export function registerReviewPanel(ctx: ReviewPanelContext, display: ReviewDisplay): () => void {
  const [fallbackOpen, setFallbackOpen] = createSignal(true);
  const toggleFallback = () => { setFallbackOpen((current) => !current); };
  // One text per line, so long lines wrap. Span colours apply only through `style`.
  const line = (segments: PanelLine) => createComponent(Dynamic, {
    component: "text",
    children: segments.length ? segments.map((segment) => createComponent(Dynamic, {
      component: "span",
      style: { fg: toneColor(ctx, segment.tone) },
      children: segment.text,
    })) : " ",
  });

  function Summary(props: { readonly sessionID: string }) {
    const [open, toggle] = openState(ctx, fallbackOpen, toggleFallback);
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
    const section = createMemo(() => panelSection(summary(), latest(), available()));
    return Show({
      get when() { return section(); },
      children: (current: () => PanelSection) => createComponent(Dynamic, {
        component: "box",
        flexDirection: "column",
        children: [
          createComponent(Dynamic, {
            component: "box",
            flexDirection: "row",
            gap: 1,
            onMouseDown: toggle,
            children: [
              createComponent(Dynamic, {
                component: "text",
                fg: toneColor(ctx, "base"),
                get children() { return open() ? "▼" : "▶"; },
              }),
              createComponent(Dynamic, {
                component: "text",
                fg: toneColor(ctx, "base"),
                get children() {
                  const title = createComponent(Dynamic, { component: "b", children: current().title });
                  return open() ? title : [
                    title,
                    createComponent(Dynamic, {
                      component: "span",
                      style: { fg: toneColor(ctx, "muted") },
                      children: ` (${current().collapsed})`,
                    }),
                  ];
                },
              }),
            ],
          }),
          Show({
            get when() { return open(); },
            get children() {
              return createComponent(Dynamic, {
                component: "box",
                flexDirection: "column",
                get children() { return current().lines.map(line); },
              });
            },
          }),
        ],
      }),
    });
  }
  return ctx.ui.slot({ append: "sidebar.content", render: (props) => createComponent(Summary, props) });
}
