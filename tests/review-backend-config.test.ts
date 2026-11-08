import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { validateConfig } from "../src/policy.ts";

const policyPath = process.env.OPENCODE_SECRET_GUARD_CONFIG;
if (!policyPath) throw new Error("OPENCODE_SECRET_GUARD_CONFIG must be set");
const raw = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const HOME = "/Users/reviewer";

const withReview = (permissionReview: unknown) => validateConfig({ ...raw, permissionReview }, "test-policy", HOME, "/tmp");
const ENDPOINT = { baseURL: "https://judge.example.com/v1", model: "judge" };

describe("permission review backend selection", () => {
  test("defaults to jev with no extra block", () => {
    expect(withReview(undefined).permissionReview).toEqual({ mode: "off", logPayloads: false, confidenceThreshold: 0.9, backend: "jev" });
    expect(withReview({ mode: "observe" }).permissionReview).toEqual({ mode: "observe", logPayloads: false, confidenceThreshold: 0.9, backend: "jev" });
  });

  test("keeps the opencode model reference, with an optional variant", () => {
    expect(withReview({ mode: "auto", backend: "opencode", opencode: { model: "github-copilot/gpt-6-luna#low" } }).permissionReview)
      .toMatchObject({ backend: "opencode", opencode: { model: "github-copilot/gpt-6-luna#low" } });
  });

  test("applies endpoint defaults and expands the key file path", () => {
    expect(withReview({ mode: "auto", backend: "endpoint", endpoint: { ...ENDPOINT, apiKeyFile: "~/.config/secrets/judge" } }).permissionReview)
      .toMatchObject({ endpoint: { ...ENDPOINT, apiKeyFile: `${HOME}/.config/secrets/judge`, deadlineMs: 20_000 } });
    expect(withReview({ mode: "auto", backend: "endpoint", endpoint: ENDPOINT }).permissionReview)
      .toMatchObject({ endpoint: { ...ENDPOINT, apiKeyFile: null } });
  });

  test("accepts a loopback endpoint over HTTP", () => {
    for (const baseURL of ["http://localhost:11434/v1", "http://127.0.0.1:8080/v1", "http://[::1]:8080/v1"]) {
      expect(() => withReview({ backend: "endpoint", endpoint: { ...ENDPOINT, baseURL } })).not.toThrow();
    }
  });

  test.each([
    ["an unknown backend", { backend: "anthropic" }, /"permissionReview.backend" must be one of jev, opencode, endpoint/],
    ["an opencode backend without its block", { backend: "opencode" }, /"permissionReview.opencode" must be an object/],
    ["a jev backend with an opencode block", { opencode: { model: "a/b" } }, /"permissionReview.opencode" requires backend "opencode"/],
    ["an endpoint block for jev", { endpoint: ENDPOINT }, /"permissionReview.endpoint" requires backend "endpoint"/],
    ["an opencode model without a provider", { backend: "opencode", opencode: { model: "gpt-6-luna" } }, /"permissionReview.opencode.model" must be/],
    ["an opencode model with a space", { backend: "opencode", opencode: { model: "a/b c" } }, /"permissionReview.opencode.model" must be/],
    ["an opencode block with an unknown key", { backend: "opencode", opencode: { model: "a/b", url: "x" } }, /unknown keys: url/],
    ["a remote HTTP endpoint", { backend: "endpoint", endpoint: { ...ENDPOINT, baseURL: "http://judge.example.com/v1" } }, /"permissionReview.endpoint.baseURL" must be an HTTPS URL/],
    ["an endpoint with credentials in the URL", { backend: "endpoint", endpoint: { ...ENDPOINT, baseURL: "https://user:secret@judge.example.com/v1" } }, /baseURL/],
    ["a relative key file", { backend: "endpoint", endpoint: { ...ENDPOINT, apiKeyFile: "keys/judge" } }, /apiKeyFile" must be an absolute path/],
    ["a deadline above 30 seconds", { backend: "endpoint", endpoint: { ...ENDPOINT, deadlineMs: 30_001 } }, /deadlineMs" must be a whole number from 1 to 30000/],
    ["a zero deadline", { backend: "endpoint", endpoint: { ...ENDPOINT, deadlineMs: 0 } }, /deadlineMs/],
    ["an endpoint with an unknown key", { backend: "endpoint", endpoint: { ...ENDPOINT, temperature: 1 } }, /unknown keys: temperature/],
  ])("rejects %s", (_, review, message) => {
    expect(() => withReview({ mode: "auto", ...review })).toThrow(message);
  });
});

describe("permission review API selection", () => {
  const withVersion = (configVersion: number, permissionReview: unknown) =>
    validateConfig({ ...raw, configVersion, permissionReview }, "test-policy", HOME, "/tmp").permissionReview;
  const OPENCODE = { model: "github-copilot/gpt-6-luna#low" };

  test("resolves each block's default API and the opencode deadline", () => {
    expect(withReview({ backend: "opencode", opencode: OPENCODE }).permissionReview.opencode)
      .toEqual({ ...OPENCODE, api: "decisions", deadlineMs: 10_000 });
    expect(withReview({ backend: "endpoint", endpoint: ENDPOINT }).permissionReview.endpoint)
      .toEqual({ ...ENDPOINT, apiKeyFile: null, deadlineMs: 20_000, api: "text" });
  });

  test("keeps explicit values", () => {
    expect(withReview({ backend: "opencode", opencode: { ...OPENCODE, api: "text", deadlineMs: 25_000 } }).permissionReview.opencode)
      .toEqual({ ...OPENCODE, api: "text", deadlineMs: 25_000 });
    expect(withReview({ backend: "endpoint", endpoint: { ...ENDPOINT, api: "decisions" } }).permissionReview.endpoint)
      .toMatchObject({ api: "decisions" });
  });

  test("loads a version 5 policy without the new keys, with the same defaults", () => {
    expect(withVersion(5, { backend: "opencode", opencode: OPENCODE }).opencode).toEqual({ ...OPENCODE, api: "decisions", deadlineMs: 10_000 });
    expect(withVersion(5, { backend: "endpoint", endpoint: ENDPOINT }).endpoint).toMatchObject({ api: "text", deadlineMs: 20_000 });
    expect(withVersion(6, { backend: "endpoint", endpoint: { ...ENDPOINT, api: "decisions" } }).endpoint).toMatchObject({ api: "decisions" });
  });

  test.each([
    ["opencode.api", { backend: "opencode", opencode: { ...OPENCODE, api: "text" } }],
    ["opencode.deadlineMs", { backend: "opencode", opencode: { ...OPENCODE, deadlineMs: 5_000 } }],
    ["endpoint.api", { backend: "endpoint", endpoint: { ...ENDPOINT, api: "decisions" } }],
  ])("rejects %s in a version 5 policy", (key, review) => {
    expect(() => withVersion(5, review)).toThrow(`"permissionReview.${key}" requires configVersion 6 or later`);
  });

  test.each([
    ["an unknown opencode API", { backend: "opencode", opencode: { ...OPENCODE, api: "chat" } }, /"permissionReview.opencode.api" must be one of decisions, text, not "chat"/],
    ["a null endpoint API", { backend: "endpoint", endpoint: { ...ENDPOINT, api: null } }, /"permissionReview.endpoint.api" must be one of decisions, text, not null/],
    ["an opencode deadline above 30 seconds", { backend: "opencode", opencode: { ...OPENCODE, deadlineMs: 30_001 } }, /"permissionReview.opencode.deadlineMs" must be a whole number from 1 to 30000/],
    ["a fractional opencode deadline", { backend: "opencode", opencode: { ...OPENCODE, deadlineMs: 1.5 } }, /"permissionReview.opencode.deadlineMs"/],
    ["a zero opencode deadline", { backend: "opencode", opencode: { ...OPENCODE, deadlineMs: 0 } }, /"permissionReview.opencode.deadlineMs"/],
    ["an unknown opencode key", { backend: "opencode", opencode: { ...OPENCODE, temperature: 0 } }, /"permissionReview.opencode" has unknown keys: temperature/],
  ])("rejects %s", (_, review, message) => {
    expect(() => withReview({ mode: "auto", ...review })).toThrow(message);
  });
});
