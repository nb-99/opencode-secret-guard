import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import { readDirectoryModes, readDirectoryModesBatch } from "../src/lookup.ts";

const helper = fileURLToPath(new URL("../bin/path-lookup", import.meta.url));
let run: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  run?.mockRestore();
  run = undefined;
});

function mockRun(result: unknown) {
  const mock = spyOn(childProcess, "spawnSync").mockReturnValue(result as any);
  run = mock;
  return mock;
}

describe("bounded directory lookup batch", () => {
  test("sends all paths in one fixed-helper process and preserves row order", () => {
    const rows = [["sensitive"], ["sensitive", "insensitive", "unknown"]];
    const mock = mockRun({ status: 0, stdout: JSON.stringify(rows) });
    expect(readDirectoryModesBatch(["/", "/Mixed/File"])).toEqual(rows);
    expect(mock.mock.calls).toEqual([[helper, ["--batch"], {
      input: "/\0/Mixed/File\0",
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
    }]]);
  });

  test("does not spawn for an empty batch or invalid paths", () => {
    const mock = mockRun({ status: 0, stdout: "[]" });
    expect(readDirectoryModesBatch([])).toEqual([]);
    const invalid = ["relative", "/embedded\0/path", "/" + "a".repeat(4095), "/" + "é".repeat(2048), "/\uD800"];
    for (const modes of readDirectoryModesBatch(invalid)) {
      expect(modes.length).toBeGreaterThan(0);
      expect(modes.every((mode) => mode === "unknown")).toBe(true);
    }
    expect(mock).not.toHaveBeenCalled();
  });

  test("does not shift valid results around rejected paths", () => {
    const mock = mockRun({ status: 0, stdout: '[["sensitive"],["insensitive","unknown"]]' });
    expect(readDirectoryModesBatch(["relative", "/", "/bad\0/path", "/valid"])).toEqual([
      ["unknown", "unknown"], ["sensitive"], ["unknown", "unknown", "unknown"], ["insensitive", "unknown"],
    ]);
    expect(mock.mock.calls[0]![2]!.input).toBe("/\0/valid\0");
  });

  test("bounds the number of paths per process", () => {
    const mock = mockRun({ status: 0, stdout: "invalid" });
    expect(readDirectoryModesBatch(Array(257).fill("/"))).toEqual(Array.from({ length: 257 }, () => ["unknown"]));
    expect(mock.mock.calls).toHaveLength(2);
    expect(mock.mock.calls[0]![2]!.input).toBe("/\0".repeat(256));
    expect(mock.mock.calls[1]![2]!.input).toBe("/\0");
  });

  test("successful chunks keep their own rows, including the last partial chunk", () => {
    const targets = Array.from({ length: 257 }, (_, index) => `/file-${index}`);
    const mock = mockRun({ status: 0, stdout: JSON.stringify(Array.from({ length: 256 }, () => ["sensitive", "sensitive"])) });
    mock.mockReturnValueOnce({ status: 0, stdout: JSON.stringify(Array.from({ length: 256 }, () => ["sensitive", "sensitive"])) } as any)
      .mockReturnValueOnce({ status: 0, stdout: '[["insensitive","insensitive"]]' } as any);
    const rows = readDirectoryModesBatch(targets);
    expect(rows[0]).toEqual(["sensitive", "sensitive"]);
    expect(rows[255]).toEqual(["sensitive", "sensitive"]);
    expect(rows[256]).toEqual(["insensitive", "insensitive"]);
    expect(mock.mock.calls[1]![2]!.input).toBe("/file-256\0");
  });

  test("bounds input bytes per process, including UTF-8 and NUL terminators", () => {
    const target = "/" + "é".repeat(2047);
    const mock = mockRun({ status: 0, stdout: "invalid" });
    readDirectoryModesBatch(Array(17).fill(target));
    expect(mock.mock.calls).toHaveLength(2);
    expect(Buffer.byteLength(mock.mock.calls[0]![2]!.input as string)).toBe(64 * 1024);
    expect(mock.mock.calls[1]![2]!.input).toBe(target + "\0");
  });

  test("validates rows independently without accepting corrupt counts or modes", () => {
    mockRun({ status: 0, stdout: '[["sensitive"],["sensitive","ALLOW"],["insensitive","unknown"]]' });
    expect(readDirectoryModesBatch(["/", "/bad", "/good"])).toEqual([
      ["sensitive"], ["unknown", "unknown"], ["insensitive", "unknown"],
    ]);
  });

  test.each([
    "[]", '[["sensitive"]]', '[["sensitive"],["unknown"],["unknown"]]',
    '{"rows":[["sensitive"],["unknown","unknown"]]}', "[", "[] trailing",
  ])("rejects malformed output %s", (stdout) => {
    mockRun({ status: 0, stdout });
    expect(readDirectoryModesBatch(["/", "/file"])).toEqual([["unknown"], ["unknown", "unknown"]]);
  });

  test.each([null, ["sensitive"], ["sensitive", "unknown", "unknown"],
    { 0: "sensitive", 1: "unknown", length: 2 }])("rejects malformed rows independently", (row) => {
    mockRun({ status: 0, stdout: JSON.stringify([["sensitive"], row]) });
    expect(readDirectoryModesBatch(["/", "/file"])).toEqual([["sensitive"], ["unknown", "unknown"]]);
  });

  test.each([
    { status: 1, stdout: '[["sensitive"]]' },
    { status: null, signal: "SIGTERM", stdout: '[["sensitive"]]' },
    { status: 0, error: new Error("ENOENT"), stdout: '[["sensitive"]]' },
    { status: null, error: Object.assign(new Error("output limit exceeded"), { code: "ENOBUFS" }), stdout: '[["sensitive"]]' },
  ])("helper errors and output-limit failures are unknown", (result) => {
    mockRun(result);
    expect(readDirectoryModesBatch(["/"])).toEqual([["unknown"]]);
  });

  test("a thrown spawn failure is unknown", () => {
    const mock = spyOn(childProcess, "spawnSync").mockImplementation(() => { throw new Error("fixture failure"); });
    run = mock;
    expect(readDirectoryModesBatch(["/file"])).toEqual([["unknown", "unknown"]]);
  });

  test("does not cache across batches", () => {
    const mock = mockRun({ status: 0, stdout: '[["sensitive"]]' });
    expect(readDirectoryModesBatch(["/"])).toEqual([["sensitive"]]);
    mock.mockReturnValue({ status: 0, stdout: '[["unknown"]]' } as any);
    expect(readDirectoryModesBatch(["/"])).toEqual([["unknown"]]);
    expect(mock.mock.calls).toHaveLength(2);
  });

  test("preserves the single-path argv and JSON-array protocol", () => {
    const mock = mockRun({ status: 0, stdout: '["sensitive","unknown"]' });
    expect(readDirectoryModes("/file")).toEqual(["sensitive", "unknown"]);
    expect(mock.mock.calls).toEqual([[helper, ["/file"], {
      encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"],
    }]]);
  });

  test("bounds fallback allocation for an oversized component list", () => {
    const mock = mockRun({ status: 0, stdout: "[]" });
    const [modes] = readDirectoryModesBatch(["/a".repeat(100_000)]);
    expect(modes!.length).toBe(4096);
    expect(modes!.every((mode) => mode === "unknown")).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  });
});
