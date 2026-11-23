/**
 * The host's own cell of the mode matrix: what each mode does with the sandbox
 * this host really has. Every other unit test stands a fake backend in for it.
 * A host without a backend must refuse "shell+files" by name; a host with one
 * must start it. Whether the backend confines anything is sandbox.test.sh's
 * question.
 */
import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/policy.ts";
import { hostSandbox } from "../src/sandbox.ts";
import { createV1Hooks } from "../src/v1.ts";

const policyPath = process.env.OPENCODE_SECRET_GUARD_CONFIG;
if (!policyPath) throw new Error("OPENCODE_SECRET_GUARD_CONFIG must be set");
const config = loadConfig(policyPath);
const host = hostSandbox();
const start = (mode: "files-only" | "shell+files") =>
  createV1Hooks({ ...config, mode }, path.join(os.tmpdir(), "package", "lib"), os.tmpdir());

describe(`this host's sandbox (${host.backend?.name ?? "none"})`, () => {
  test("files-only starts", () => {
    expect(() => start("files-only")).not.toThrow();
  });

  test.if(host.backend === null)("shell+files refuses to start, naming why", () => {
    const reason = host.backend === null ? host.reason : "";
    expect(() => start("shell+files")).toThrow(`needs a shell sandbox, but this ${process.platform} host has none: ${reason}`);
  });

  test.if(host.backend !== null)("shell+files starts", () => {
    expect(() => start("shell+files")).not.toThrow();
  });
});
