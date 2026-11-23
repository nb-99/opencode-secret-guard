/**
 * The shell wrapper's side of the resolver protocol, run with a stand-in
 * resolver that prints a crafted payload and a stand-in sandbox that records
 * its words. Every malformed payload must stop the command before it runs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const bash = Bun.which("bash");
if (!bash) throw new Error("the wrapper tests need bash on PATH");
const source = fileURLToPath(new URL("../bin/opencode-secret-guard", import.meta.url));

let fixture: string;
let wrapper: string;
let sandbox: string;
let ran: string;

beforeAll(() => {
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-guard-wrapper-")));
  fs.mkdirSync(path.join(fixture, "pkg", "bin"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "pkg", "lib"));
  fs.writeFileSync(path.join(fixture, "pkg", "lib", "cli.ts"), "");
  wrapper = path.join(fixture, "pkg", "bin", "opencode-secret-guard");
  // The Linux Nix build sandbox has no /usr/bin/env; every other line is the shipped wrapper's.
  let text = fs.readFileSync(source, "utf8");
  if (!fs.existsSync("/usr/bin/env")) text = text.replaceAll("/usr/bin/env ", `${Bun.which("env")} `);
  fs.writeFileSync(wrapper, text);

  fs.writeFileSync(path.join(fixture, "resolver"), `#!${bash}\ncat "$PAYLOAD"\n`, { mode: 0o755 });
  sandbox = path.join(fixture, "sandbox");
  fs.writeFileSync(sandbox, `#!${bash}\nprintf 'confined by %s\\n' "$1"\nshift\nexec "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(fixture, "a=b"));
  fs.copyFileSync(sandbox, path.join(fixture, "a=b", "sandbox"));
  fs.chmodSync(path.join(fixture, "a=b", "sandbox"), 0o755);
  ran = path.join(fixture, "ran");
});

afterAll(() => fs.rmSync(fixture, { recursive: true, force: true }));

/** Runs `command` through the wrapper, with `lines` as the resolver's output. */
function run(lines: string[], command: string) {
  const payload = path.join(fixture, "payload");
  fs.writeFileSync(payload, lines.join("\n"));
  const result = spawnSync(bash!, [wrapper, "-c", command], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, PAYLOAD: payload, SECRET_GUARD_BUN: path.join(fixture, "resolver"), MY_TOKEN: "leak" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const confined = () => [sandbox, "--marker", bash!, "-c"];

describe("shell wrapper protocol", () => {
  test("runs the command under the sandbox words with the scrubbed names removed", () => {
    const result = run(["4", ...confined(), "", "MY_TOKEN"], "echo token=${MY_TOKEN-unset}");
    expect(result).toEqual({ status: 0, stdout: "confined by --marker\ntoken=unset\n", stderr: "" });
  });

  test("accepts a payload whose empty hint line was stripped with nothing after it", () => {
    expect(run(["4", ...confined()], "echo token=${MY_TOKEN-unset}").stdout).toBe("confined by --marker\ntoken=leak\n");
  });

  test("prints a hint only on failure, and only a marked one on 127", () => {
    expect(run(["4", ...confined(), "?hint"], "exit 3")).toMatchObject({ status: 3, stderr: "hint\n" });
    expect(run(["4", ...confined(), "?hint"], "exit 127")).toMatchObject({ status: 127, stderr: "" });
    expect(run(["4", ...confined(), "!hint"], "exit 127")).toMatchObject({ status: 127, stderr: "hint\n" });
    expect(run(["4", ...confined(), "!hint"], "true")).toMatchObject({ status: 0, stderr: "" });
  });

  test.each([
    ["an empty payload", () => [""]],
    ["no word count", () => ["abc"]],
    ["a zero count", () => ["0"]],
    ["a padded count", () => ["04", ...confined()]],
    ["a count with a carriage return", () => ["4\r", ...confined()]],
    ["fewer words than counted", () => ["5", ...confined()]],
    ["a relative sandbox", () => ["2", "sandbox", "-c"]],
    ["a missing sandbox", () => ["2", path.join(fixture, "absent"), "-c"]],
    ["an assignment-shaped sandbox", () => ["4", path.join(fixture, "a=b", "sandbox"), "--marker", bash!, "-c"]],
  ])("refuses %s without running the command", (_, lines) => {
    const result = run(lines(), `: > '${ran}'`);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^secret-guard: /);
    expect(fs.existsSync(ran)).toBe(false);
  });
});
