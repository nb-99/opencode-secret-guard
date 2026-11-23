# opencode-secret-guard

[![CI](https://github.com/nb-99/opencode-secret-guard/actions/workflows/check.yml/badge.svg)](https://github.com/nb-99/opencode-secret-guard/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Keeps secrets out of an [OpenCode](https://opencode.ai) agent's context with kernel-level sandboxing and a unified file-tool policy.

OpenCode's `permission.bash` rules match the command string, which shell expansion defeats: `F=.env; cat $F`, `cat .en?`, `base64 < .env`, and `python3 -c "open('.env')"` all read `.env` without matching a string rule. `opencode-secret-guard` enforces one shared policy below shell expansion so that **a credential may be used, never read**.

`git push` can reach `~/.ssh` because `git` needs it. `cat ~/.ssh/id_ed25519` and `gh auth token` cannot.

## Features

- **Kernel-enforced shell sandbox (macOS):** Runs every shell command under a generated `sandbox-exec` profile via OpenCode's `shell` setting without rewriting the command shown in the TUI. Covers variables, globs, redirections, interpreters, archivers, and `find -exec`.
- **Unified file and browser tool guard (cross-platform):** Enforces the same policy on `read`, `write`, `edit`, `patch`, `list`, `glob`, `grep`, and browser file tools (`files.upload`, `files.drop`, `preview`). Filters `glob` and `grep` results and honors `.gitignore` with an allowlist for build artifacts.
- **Scoped credential relaxation:** Grants credential binaries (`git`, `kubectl`, `aws`, `gcloud`, `az`, `docker`, `npm`, and others) access to their own credential paths only when every segment of the command is safe. Prints a one-line hint when a failed command lost its group or hit a guard rule.
- **Secret-printing refusals and environment scrubbing:** Refuses commands whose output is a secret (`gh auth token`, `kubectl get secret -o yaml`, `aws eks get-token`, `op read`, `sops -d`, and similar) and strips secret environment variables (`*_TOKEN`, `*_SECRET`, `*_API_KEY`, etc.) before execution.
- **Tamper protection:** Blocks writes to OpenCode's config, plugin and tool directories, caches, this package, the policy file, `~/.zshenv`, user-writable `PATH` directories, and configured `writeProtectedRoots`. Prevents renaming protected directories or hard-linking secrets.
- **Guarded temporary cleanup (`cleanup_temp`):** Opt-in tool that lets an agent delete task directories under a configured scratch root (such as `$TMPDIR/opencode`) using OpenCode `edit` permissions and a write-confined `/bin/rm` sandbox, without weakening bash `rm` rules.
- **Optional permission review:** Off by default. Sends eligible shell `ask` prompts to a model (Jev via OpenCode Zen, an OpenCode model, or an OpenAI-compatible endpoint) for one-time auto-approval, with live TUI sidebar status and toasts.

## Requirements and modes

Requires **OpenCode 2**.

| Feature | Minimum OpenCode version |
| --- | --- |
| Core file and shell guard | 2.0 |
| Optional permission review | 2.0.20+ (TUI sidebar: 2.1.4+; `opencode` backend: 2.2.5+) |
| `cleanup_temp` tool | 2.0.29+ |

| Mode | Shell tool | File tools | Platform |
| --- | --- | --- | --- |
| `shell+files` (default) | Kernel-enforced | Guarded | macOS (`sandbox-exec`) |
| `files-only` | **Unguarded** | Guarded | macOS, Linux |

`files-only` leaves shell commands completely unguarded, so you must select it explicitly. `shell+files` never falls back to `files-only` automatically, and the shell wrapper refuses to run under `files-only`.

## Installation

### Home Manager (recommended)

Import `homeManagerModules.default` (also exported as `homeModules.default`) and wire the module's read-only `pluginPath` and `shellPath` outputs into `programs.opencode.settings`:

```nix
{ config, lib, inputs, ... }:
let
  guard = config.programs.opencode-secret-guard;
in
{
  # Flake input: inputs.opencode-secret-guard.url = "github:nb-99/opencode-secret-guard";
  imports = [ inputs.opencode-secret-guard.homeManagerModules.default ];

  programs.opencode-secret-guard = {
    enable = true;
    mode = "shell+files";

    # Append to shipped defaults so upstream policy updates still apply.
    extraRelaxationGroups.oci.binaries = [ "ko" ];
    extraSecretExceptions = [ "/pkg/store/secrets/obfuscator\\.go$" ];

    # Drop a shipped secret-printing refusal if this host needs it.
    removeSecretPrintingCommands = [ { binary = "sops"; } ];

    # Protect OpenCode installs that live outside the read-only Nix store.
    extraWriteProtectedRoots = [
      "/opt/homebrew/Cellar/opencode"
      "/opt/homebrew/opt/opencode"
      "/opt/homebrew/bin/opencode"
      "/Applications/OpenCode.app"
    ];

    # Optional model review of shell `ask` prompts.
    permissionReview.mode = "observe";

    # Whole-key overrides (applied after extra* options).
    settings = {
      cleanupRoot = "$TMPDIR/opencode";
      denyRoots = [ "~/.config/secrets" ];
      exemptRoots = [ "~/notes/agent-memory" ];
      secretEnvironment = [ "CONTEXT7_API_KEY" ];
    };
  };

  programs.opencode.settings = {
    plugins = lib.optional (guard.pluginPath != null) guard.pluginPath;
  }
  // lib.optionalAttrs (guard.shellPath != null) {
    shell = guard.shellPath;
  };
}
```

- **Additive options** (`extraSecretPatterns`, `extraSecretExceptions`, `extraArtifactAllowlist`, `extraSecretPrintingCommands`, `extraRelaxationGroups`, `extraWriteProtectedRoots`) merge into [`policy/default.json`](policy/default.json). `removeSecretPrintingCommands` removes shipped rules before additions apply.
- **Whole-key overrides** go in `settings`, except `mode`, `tools` (`gitPackage`), and `permissionReview`, which have typed top-level options.
- **`shellPath` and `pluginPath`** evaluate to `null` when they do not apply (for example, `shellPath` is `null` in `files-only` mode).

### Without Nix

Build the package or unpack a release, then install the default policy:

```sh
nix build github:nb-99/opencode-secret-guard
cp result/share/opencode-secret-guard/default-policy.json \
  ~/.config/opencode/secret-guard.json
```

Point OpenCode at the shell wrapper and plugin directory:

```jsonc
{
  "shell": "/path/to/opencode-secret-guard/bin/opencode-secret-guard",
  "plugins": ["file:///path/to/opencode-secret-guard/lib"]
}
```

Outside the Nix wrapper, set `SECRET_GUARD_BUN` to the absolute path of `bun` (the wrapper never searches `PATH`), and set `tools.git` in your policy if you do not want `/usr/bin/git`.

## Configuration

The plugin reads `~/.config/opencode/secret-guard.json` (or `$OPENCODE_SECRET_GUARD_CONFIG`). Start from [`policy/default.json`](policy/default.json). Roots may begin with `~`, which expands at runtime.

Validation fails closed: an unsupported `configVersion`, invalid regex, non-absolute root, or non-`$HOME`-relative `allowPaths` entry aborts startup and refuses guarded tool calls. The current format is **`configVersion` 8**; versions 1 through 7 still load with defaults for newer fields.

| Key | Description |
| --- | --- |
| `configVersion` | Format version (`8`; `1` to `7` remain accepted). |
| `mode` | `"shell+files"` (default) or `"files-only"`. |
| `cleanupRoot` | Opt-in root for `cleanup_temp` (supports `~` and `$TMPDIR`), or `null` to disable. Requires `shell+files`. |
| `tools.git` | Absolute path to `git` spawned by the guard (never resolved via `PATH`). |
| `secretPatterns` | Regexes matching protected files and directories. |
| `secretExceptions` | Regexes carving out non-secret lookalikes (for example `.env.example`). |
| `artifactAllowlist` | Directory and file names allowed despite `.gitignore` (still subject to `secretPatterns`). |
| `relaxationGroups` | Maps group names (`aws`, `azure`, `gcp`, `kube`, `npm`, `oci`, `ssh`, etc.) to `binaries`, `$HOME`-relative `allowPaths`, and `allowEnvironment` regexes. |
| `secretPrintingCommands` | `{ "binary", "args" }` rules refused outright because their output is a secret. |
| `denyRoots` | Absolute paths that are never relaxed and never excepted. |
| `exemptRoots` | Existing directory trees exempted from secret checks (tamper and cache protection still win). |
| `writeProtectedRoots` | Trees no command or file tool may modify, such as non-Nix OpenCode installs. Reads and execution stay allowed. |
| `secretEnvironment` | Exact environment variable names always stripped before a command runs. |
| `secretEnvironmentPatterns` | Regexes for environment variables stripped unless a group's `allowEnvironment` keeps them. |
| `cacheTtlMs` | Milliseconds before a cached sandbox profile is regenerated (`2000` by default). |
| `permissionReview` | Optional model reviewer for shell `ask` prompts (see below). |

### Guarded temporary cleanup (`cleanup_temp`)

Set `cleanupRoot` (for example `"$TMPDIR/opencode"`) to expose `cleanup_temp`. The tool accepts paths relative to that root, checks OpenCode's `edit` permission for every inventoried entry, and deletes them with `/bin/rm` inside a write-confined `sandbox-exec` profile that keeps the secret policy active.

```json
{ "paths": ["my-task/output", "my-task/download"] }
```

To skip interactive confirmation for that scratch root, add an OpenCode `permission.edit` rule for the expanded path (OpenCode does not expand `$TMPDIR`): `/var/folders/*/*/T/opencode/**` on macOS, or `/tmp/opencode/**` for a `/tmp` root.

### Optional permission review

Permission review is off by default. It never denies requests, never saves persistent "always" rules, and never relaxes the sandbox. It only evaluates eligible shell `ask` prompts:

- `off`: Disabled (default).
- `observe`: Reviews prompts, logs judgments, and displays results in the TUI while still asking you.
- `auto`: Grants a one-time `allow` when every check clears `confidenceThreshold`; otherwise falls back to the normal prompt.

| Option | Default | Description |
| --- | --- | --- |
| `mode` | `"off"` | `"off"`, `"observe"`, or `"auto"`. |
| `backend` | `"jev"` | `"jev"` (Jev via OpenCode Zen), `"opencode"` (any model OpenCode can reach), or `"endpoint"` (OpenAI-compatible server). |
| `confidenceThreshold` | `0.9` | Number in `(0.5, 1]`. Positive checks must reach `t` (unasked read-only or local-reversible commands on the allow list also pass authorization); negative checks must stay at or below `1 - t`. See [docs/permission-review.md](docs/permission-review.md#how-a-request-is-approved). |
| `toasts` | `"all"` | `"all"` shows every review phase; `"attention"` shows toasts only when you need to act (progress and auto-approvals stay in the sidebar). |
| `restrictionScreen` | `true` | Screens omitted context chunks for agent rules when evidence exceeds the request size limit. |
| `logPayloads` | `false` | When `true`, also writes review request and response bodies to a private local log file. |
| `opencode` | unset | Required when `backend` is `"opencode"`: `{ "model": "provider/model[#variant]", "api": "decisions" \| "text", "deadlineMs": 10000, "maxRequestBytes": null }`. |
| `endpoint` | unset | Required when `backend` is `"endpoint"`: `{ "baseURL": "https://...", "model": "...", "apiKeyFile": null, "api": "text" \| "decisions" \| "systemone", "deadlineMs": 20000, "maxRequestBytes": null }`. `baseURL` must be HTTPS or loopback HTTP. |

Example policy snippet using an OpenCode-configured decision model:

```json
{
  "configVersion": 8,
  "permissionReview": {
    "mode": "auto",
    "backend": "opencode",
    "toasts": "attention",
    "opencode": {
      "model": "opencode/jev-1.13-free",
      "api": "decisions"
    }
  }
}
```

## How shell commands behave

- **One credential group per command:** A command keeps its group's credential paths when every segment is a binary in that group, an inert builtin (`cd`, `echo`, `true`), or a safe pipe consumer (`head`, `tail`, `sort`, `cut`, `wc`, `rg`, `grep`, `jq`, `awk` without file operands). Mixing groups, leading `VAR=value` assignments, command substitution, `sed`, `tee`, or `xargs` drops the command to the strict profile.
- **Actionable failure hints:** When a command exits non-zero, the wrapper adds a conditional one-line note if a guard rule likely caused it (lost relaxation group, refused write path, `PATH` installer, scrubbed variable, or setuid binary). Split compound commands instead of retrying the same shape.
- **No secret-printing invocations:** Commands like `gh auth token`, `kubectl get secret -o yaml`, and `aws eks get-token` are refused even behind `sudo`, `env`, `sh -c`, or `$(...)`. Value-free listings like `kubectl get secrets -o name` work normally.
- **No global installs from the agent shell:** Because user-writable `PATH` directories and OpenCode's runtime files are write-protected, `brew install` and `npm i -g` fail in the agent shell. Run those from your own terminal. Prompts, skills, commands, and `~/.zshrc` remain editable.
- **No setuid binaries under `sandbox-exec`:** `ps`, `top`, `sudo`, `su`, `crontab`, `at`, and `traceroute` fail with `operation not permitted`. Use `pgrep -fl` and `lsof -i` instead of `ps`, and run privileged commands from your own terminal.

## Limitations

- **Out-of-band processes:** MCP servers, the LSP, and interactive PTY terminals run outside the sandbox. Commands run with `!` in the prompt use the configured shell and are guarded.
- **Network and macOS keychain:** Network access is unrestricted (defense relies on preventing secret reads). Credentials in the macOS keychain are not guarded by file rules.
- **Plugin load failures:** If OpenCode cannot load the plugin (for example due to a wrong path), file tools run unguarded while the shell wrapper still enforces its sandbox. Verify the plugin appears in OpenCode's plugin list. Once loaded, policy or startup errors fail closed on every guarded tool call.
- **Credential scoping, not capability isolation:** A relaxed binary's own extension mechanisms (for example a `git` alias) remain in scope for that binary.
- **Case-insensitive and unknown filesystems:** On case-insensitive or unknown filesystems (including default macOS APFS and WSL DrvFS), file-tool pattern matching is conservative across case aliases; some naming exceptions such as `.env.example` may be refused unless covered by an explicit `exemptRoots` directory.
- **`sandbox-exec` snapshot semantics:** Apple formally deprecates `sandbox-exec` (still present in macOS 26). Generated profiles are snapshots until `cacheTtlMs` expires, so newly created directories may wait for a rebuild before enumeration.

## Development and tests

```sh
nix flake check -L      # Typecheck, unit tests, default-policy, and package layout checks
nix run .#integration   # macOS kernel sandbox tests (run from an unsandboxed terminal)
```

For direct Bun runs from a checkout, install locked dependencies and link the compiled `path-lookup` helper first:

```sh
npm ci
nix build .#default
ln -s ../result/bin/path-lookup bin/path-lookup
bun test tests/*.test.ts
```

## License

[MIT](LICENSE)
