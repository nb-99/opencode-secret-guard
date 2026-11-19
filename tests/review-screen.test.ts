import { describe, expect, test } from "bun:test";
import type { ReviewBackend, ReviewChannel, ScreenChunk } from "../src/review-backends.ts";
import { chunkText, createScreenCache, runScreen, SCREEN_CUTOFF } from "../src/review-screen.ts";

describe("chunkText", () => {
  test("splits at headings and blank lines, aiming at 600 to 1,500 characters", () => {
    const section = (title: string) => `## ${title}\n${"word ".repeat(140)}`;
    const chunks = chunkText([section("One"), section("Two"), "short tail"].join("\n\n"));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.startsWith("## One")).toBe(true);
    expect(chunks[1]!.startsWith("## Two")).toBe(true);
    expect(chunks[1]!.endsWith("short tail")).toBe(true);
  });

  test("never exceeds 2,000 characters, even for one long line", () => {
    const chunks = chunkText(`${"x".repeat(5_000)}\n${"🔒".repeat(1_500)}`);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2_000);
    expect(chunks.join("").replace(/\n/g, "")).toBe(`${"x".repeat(5_000)}${"🔒".repeat(1_500)}`);
  });
});

describe("runScreen", () => {
  const backend = (maxRequestBytes = 100_000): ReviewBackend => ({
    model: "judge",
    api: "decisions",
    maxRequestBytes,
    stateBytes: Number.POSITIVE_INFINITY,
    requestBytes: () => 0,
    screenBytes: (chunks) => Buffer.byteLength(JSON.stringify({ chunks })),
    prepare: async () => { throw new Error("not used"); },
  });
  const channel = (answer: (chunks: ReadonlyArray<ScreenChunk>) => Map<string, number> | Promise<never>) => {
    const asked: ScreenChunk[][] = [];
    const value: ReviewChannel = {
      judge: async () => { throw new Error("not used"); },
      screen: async (chunks) => (asked.push([...chunks]), answer(chunks)),
    };
    return { value, asked };
  };
  const call = { signal: new AbortController().signal, trace: undefined, onRequest: () => {}, label: "screen" as const };
  const leftovers = [
    { source: "skill:old", order: 1, text: "Rule A: leave migrations alone." },
    { source: "skill:new", order: 2, text: "Background only.\n\nRule B: push only on Fridays." },
  ];
  const score = (text: string) => (text.includes("Rule A") ? SCREEN_CUTOFF : text.includes("Rule B") ? 0.9 : 0.29);

  test("keeps chunks at the cutoff, puts chunks that name the command first, ignores unknown ids, and copies text unchanged", async () => {
    const screen = channel((chunks) => new Map([["c99", 1], ...chunks.map((chunk) => [chunk.id, score(chunk.text)] as [string, number])]));
    const result = await runScreen({
      backend: backend(), channel: screen.value, cache: createScreenCache(), leftovers, call, room: 10_000,
      names: (line) => line.includes("migrations"),
    });
    expect(screen.asked[0]!.map((chunk) => chunk.text)).toEqual(["Rule A: leave migrations alone.", "Background only.\n\nRule B: push only on Fridays."]);
    expect(result).toMatchObject({ chunks: 2, cached: 0, asked: 2, selected: 2, failed: false, unscreened: 0 });
    expect(result.excerpts).toEqual([
      { source: "skill:old", text: "Rule A: leave migrations alone." },
      { source: "skill:new", text: "Background only.\n\nRule B: push only on Fridays." },
    ]);
  });

  test("answers repeat chunks from the cache, and a failure keeps the cached answers", async () => {
    const cache = createScreenCache();
    const first = channel((chunks) => new Map(chunks.map((chunk) => [chunk.id, score(chunk.text)])));
    await runScreen({ backend: backend(), channel: first.value, cache, leftovers: leftovers.slice(0, 1), call, room: 10_000, names: () => false });
    const failing = channel(() => Promise.reject(new Error("down")));
    const result = await runScreen({ backend: backend(), channel: failing.value, cache, leftovers, call, room: 10_000, names: () => false });
    expect(failing.asked[0]!.map((chunk) => chunk.id)).toEqual(["c0"]);
    expect(result).toMatchObject({ cached: 1, asked: 1, failed: true, selected: 1 });
    expect(result.excerpts).toEqual([{ source: "skill:old", text: "Rule A: leave migrations alone." }]);
  });

  test("screens only what one request holds, and says how much was left", async () => {
    const screen = channel((chunks) => new Map(chunks.map((chunk) => [chunk.id, 1])));
    const limit = Buffer.byteLength(JSON.stringify({ chunks: [{ id: "c0", source: "skill:new", text: leftovers[1]!.text }] })) + 5;
    const result = await runScreen({ backend: backend(limit), channel: screen.value, cache: createScreenCache(), leftovers, call, room: 10_000, names: () => false });
    expect(result).toMatchObject({ asked: 1, unscreened: 1, unscreenedCharacters: leftovers[0]!.text.length });
  });

  test("adds no more excerpts than the room allows", async () => {
    const screen = channel((chunks) => new Map(chunks.map((chunk) => [chunk.id, 1])));
    const result = await runScreen({ backend: backend(), channel: screen.value, cache: createScreenCache(), leftovers, call, room: 70, names: () => false });
    expect(result.excerpts).toEqual([{ source: "skill:old", text: "Rule A: leave migrations alone." }]);
    expect(result.selected).toBe(2);
  });
});
