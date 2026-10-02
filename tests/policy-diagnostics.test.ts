import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { aliasPatternDiagnostics, loadConfig, validateConfig } from "../src/policy.ts";
import plugin from "../src/index.ts";
import { host } from "./support.ts";

const template = JSON.parse(fs.readFileSync(new URL("../policy/default.json", import.meta.url), "utf8"));

test("the shipped path patterns require no unsupported-grammar diagnostic", () => {
  expect(aliasPatternDiagnostics(template)).toEqual([]);
});

test("diagnostics distinguish denial from exception consequences and deduplicate patterns", () => {
  const config = validateConfig({ ...template, secretPatterns: ["/secret[0-9]+$", "/secret[0-9]+$"],
    secretExceptions: ["/public.*$"], denyRoots: [], exemptRoots: [] }, "synthetic", "/home/example");
  const messages = aliasPatternDiagnostics(config);
  expect(messages).toHaveLength(2);
  expect(messages[0]).toContain('"secretPatterns"');
  expect(messages[0]).toContain("may deny all non-exempt workspace files");
  expect(messages[1]).toContain('"secretExceptions"');
  expect(messages[1]).toContain("cannot grant a naming exception");
  for (const message of messages) expect(message).toContain("Known-sensitive paths retain JavaScript regex behavior");
});

test("policy loading stays silent for the per-command shell resolver", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-policy-diagnostic-"));
  const source = path.join(root, "policy.json");
  fs.writeFileSync(source, JSON.stringify({ ...template, secretPatterns: ["/secret\\d+$"], denyRoots: [], exemptRoots: [] }));
  const warnings: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((message: any) => { warnings.push(String(message)); return true; });
  try {
    const config = loadConfig(source, root);
    expect(config.secretPatterns).toEqual(["/secret\\d+$"]);
    expect(Object.keys(config).sort()).toEqual(Object.keys(validateConfig(template, "template", root)).sort());
    expect(warnings).toHaveLength(0);
  } finally {
    stderr.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each(["V1", "V2"])("%s reports unsupported expressions once at plugin startup, not per call", async (version) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-startup-diagnostic-"));
  const source = path.join(root, "policy.json");
  fs.writeFileSync(source, JSON.stringify({ ...template, mode: "files-only", secretPatterns: ["/secret\\d+$"], denyRoots: [], exemptRoots: [] }));
  const previous = process.env.OPENCODE_SECRET_GUARD_CONFIG;
  process.env.OPENCODE_SECRET_GUARD_CONFIG = source;
  const warnings: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((message: any) => { warnings.push(String(message)); return true; });
  try {
    if (version === "V1") {
      const hooks = await plugin.server({ directory: root });
      await hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "true" } });
      await hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "true" } });
    } else {
      const fake = host(root);
      await plugin.setup(fake.ctx);
      await fake.call({ tool: "shell", input: { command: "true" } });
      await fake.call({ tool: "shell", input: { command: "true" } });
    }
    const diagnostics = warnings.filter((message) => message.includes("unsupported by the bounded alias matcher"));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(source);
    expect(diagnostics[0]).toContain("case-insensitive or unknown filesystem paths");
  } finally {
    stderr.mockRestore();
    if (previous === undefined) delete process.env.OPENCODE_SECRET_GUARD_CONFIG;
    else process.env.OPENCODE_SECRET_GUARD_CONFIG = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid JavaScript patterns still abort validation", () => {
  expect(() => validateConfig({ ...template, secretPatterns: ["["] }, "synthetic", "/home/example"))
    .toThrow("invalid regular expression");
});
