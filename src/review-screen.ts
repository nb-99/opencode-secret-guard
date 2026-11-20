/**
 * The optional restriction screen. Evidence that the state cut or left out
 * can still hold rules for the agent. The screen asks the configured review
 * backend which chunks of that text state a rule, and code copies the
 * selected chunks unchanged into `restriction_excerpts`. The model only picks
 * chunk ids, so it can neither paraphrase nor add a rule. User messages and
 * refusals never pass through it, and a failure only loses the extra excerpts.
 */
import { createHash } from "node:crypto";
import type { ReviewBackend, ReviewCall, ReviewChannel, ScreenChunk } from "./review-backends.ts";
import type { Excerpt, Leftover } from "./review-evidence.ts";

/** A chunk at or above this probability is kept: a missed rule costs more than a wasted line. */
export const SCREEN_CUTOFF = 0.3;
/** The screen runs only with this much of the review deadline left, and takes at most this share of it. */
export const SCREEN_MIN_REMAINING_MS = 3_000;
export const SCREEN_DEADLINE_SHARE = 0.4;
const CHUNK_MIN = 600;
const CHUNK_AIM = 1_500;
const CHUNK_MAX = 2_000;
export const SCREEN_CACHE_ENTRIES = 2_048;

const HEADING = /^#{1,6} /;

function splitLong(block: string): string[] {
  if (block.length <= CHUNK_MAX) return [block];
  const pieces: string[] = [];
  let current = "";
  for (const line of block.split("\n")) {
    const parts = line.length > CHUNK_MAX ? Array.from(line).reduce<string[]>((out, char) => {
      if (!out.length || out.at(-1)!.length + char.length > CHUNK_MAX) out.push("");
      out[out.length - 1] += char;
      return out;
    }, []) : [line];
    for (const part of parts) {
      if (current && current.length + part.length + 1 > CHUNK_MAX) {
        pieces.push(current);
        current = part;
      } else {
        current = current ? `${current}\n${part}` : part;
      }
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Splits text at Markdown headings and blank lines into chunks of about 600 to 1,500 characters, never above 2,000. */
export function chunkText(text: string): string[] {
  const blocks = text.split(/\n[ \t]*\n|\n(?=#{1,6} )/).map((block) => block.trim()).filter(Boolean).flatMap(splitLong);
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    const startsSection = HEADING.test(block) && current.length >= CHUNK_MIN;
    if (current && (startsSection || current.length + block.length + 2 > CHUNK_AIM)) {
      chunks.push(current);
      current = block;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Screen results by backend, model and chunk text. The question does not depend on the action. */
export function createScreenCache(limit = SCREEN_CACHE_ENTRIES) {
  const entries = new Map<string, number>();
  return {
    get(key: string): number | undefined {
      const value = entries.get(key);
      if (value === undefined) return undefined;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key: string, value: number) {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
    get size() { return entries.size; },
  };
}
export type ScreenCache = ReturnType<typeof createScreenCache>;

export interface ScreenResult {
  readonly excerpts: Excerpt[];
  readonly chunks: number;
  readonly cached: number;
  readonly asked: number;
  readonly selected: number;
  /** Chunks beyond the request's limits, which were not screened. */
  readonly unscreened: number;
  /** Characters of the chunks that were not screened. */
  readonly unscreenedCharacters: number;
  readonly failed: boolean;
}

export interface ScreenInput {
  readonly backend: ReviewBackend;
  readonly channel: ReviewChannel;
  readonly cache: ScreenCache;
  readonly leftovers: ReadonlyArray<Leftover>;
  readonly names: (line: string) => boolean;
  readonly call: ReviewCall;
  /** Bytes the excerpts may add to the main state. */
  readonly room: number;
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export async function runScreen(input: ScreenInput): Promise<ScreenResult> {
  const { backend, cache } = input;
  const seen = new Set<string>();
  const chunks: Array<{ source: string; order: number; text: string; key: string; named: boolean }> = [];
  for (const leftover of [...input.leftovers].sort((a, b) => b.order - a.order)) {
    for (const text of chunkText(leftover.text)) {
      const key = [backend.api ?? "jev", backend.model, createHash("sha256").update(text).digest("hex")].join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      chunks.push({ source: leftover.source, order: leftover.order, text, key, named: text.split("\n").some(input.names) });
    }
  }
  const probabilities = new Map<string, number>();
  const uncached = chunks.filter((chunk) => {
    const value = cache.get(chunk.key);
    if (value !== undefined) probabilities.set(chunk.key, value);
    return value === undefined;
  }).sort((a, b) => Number(b.named) - Number(a.named));
  const cached = chunks.length - uncached.length;

  // As many uncached chunks as one request holds, named ones first.
  const asked: Array<ScreenChunk & { key: string }> = [];
  const base = backend.screenBytes([]);
  let requestSize = base;
  let stateSize = bytes({ chunks: [] });
  for (const chunk of uncached) {
    const candidate = { id: `c${asked.length}`, source: chunk.source, text: chunk.text, key: chunk.key };
    const shown = { id: candidate.id, source: candidate.source, text: candidate.text };
    const added = backend.screenBytes([shown]) - base + 1;
    if (requestSize + added > backend.maxRequestBytes || stateSize + bytes(shown) + 1 > backend.stateBytes) break;
    requestSize += added;
    stateSize += bytes(shown) + 1;
    asked.push(candidate);
  }
  const request = () => asked.map(({ id, source, text }) => ({ id, source, text }));
  while (asked.length && backend.screenBytes(request()) > backend.maxRequestBytes) asked.pop();
  const unscreened = uncached.slice(asked.length);

  let failed = false;
  if (asked.length) {
    try {
      const answers = await input.channel.screen(request(), input.call);
      for (const chunk of asked) {
        const value = answers.get(chunk.id);
        if (value === undefined) continue;
        probabilities.set(chunk.key, value);
        cache.set(chunk.key, value);
      }
    } catch {
      failed = true;
    }
  }

  const kept = chunks
    .filter((chunk) => (probabilities.get(chunk.key) ?? 0) >= SCREEN_CUTOFF)
    .sort((a, b) => Number(b.named) - Number(a.named) || probabilities.get(b.key)! - probabilities.get(a.key)! || b.order - a.order);
  const excerpts: Excerpt[] = [];
  let room = input.room;
  for (const chunk of kept) {
    const excerpt = { source: chunk.source, text: chunk.text };
    const size = bytes(excerpt) + 1;
    if (size > room) continue;
    room -= size;
    excerpts.push(excerpt);
  }
  return {
    excerpts,
    chunks: chunks.length,
    cached,
    asked: asked.length,
    selected: kept.length,
    unscreened: unscreened.length,
    unscreenedCharacters: unscreened.reduce((sum, chunk) => sum + chunk.text.length, 0),
    failed,
  };
}
