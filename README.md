# opencode-secret-guard

Keeps secrets out of an [OpenCode](https://opencode.ai) agent's context.

OpenCode's `permission.bash` rules match the command _string_. That is fine for
"should this be confirmed?" but useless as a boundary: `F=.env; cat $F`,
`cat .en?`, `base64 < .env` and `python3 -c "open('.env')"` all read the same
file without containing a matchable pattern. Anything built on string inspection
is defeated by shell expansion.

This enforces the boundary where expansion cannot reach it:

- **bash** — OpenCode's configured shell runs every command under a generated
  macOS `sandbox-exec` profile, without rewriting the command shown in the TUI.
  Enforcement is in the kernel, so it covers variable expansion, globs,
  redirections, `find -exec`, interpreters, archivers and recursive greps alike.
- **file tools** — `read`, `write`, `edit`, `patch` (`apply_patch` on V1),
  `list`, `glob`, `grep` and V1's `lsp` run the same policy as a path predicate, and
  `glob`/`grep` results are filtered. A patch is checked against every file
  its headers name. V2's browser tools that open a local file (`files.upload`,
  `files.drop`, `preview`) are checked as reads.

Both layers are derived from one policy file, and a test compares their verdicts
on ordinary paths. File-tool matching is additionally conservative for
case-insensitive or unknown filesystem lookup modes; the kernel regex profile
does not implement that alias matching.

The rule is: a credential may be **used**, never **read**. `git push` reaches
`~/.ssh` because git needs it; `cat ~/.ssh/id_ed25519` does not, and neither
does `gh auth token`, whose whole output is the secret. Anything OpenCode itself
loads at its next start — its config, plugins, this policy, the directories on
`PATH` — cannot be written by a command, so one command cannot disable the
guard for the ones that follow.

See [docs/design.md](docs/design.md) for the full design and
[docs/lessons-learned.md](docs/lessons-learned.md) for the empirically verified
`sandbox-exec` behaviour it depends on.

## Requirements

OpenCode **V1 1.18.29 or newer**, or **V2**. One package serves both: its entry
point default-exports `{ id, setup, server }`, and each version calls the one it
knows. The V2 adapter follows the V2 2.0.16 source and was tested live on
V2 2.0.20. Directory loading was verified on V1 1.18.31; the minimum V1
1.18.29 still needs a live check. See [docs/v2-migration.md](docs/v2-migration.md)
for the tested revisions, coverage and remaining checks.

| Mode                    | shell tool      | file tools | Requires                  |
| ----------------------- | --------------- | ---------- | ------------------------- |
| `shell+files` (default) | kernel-enforced | guarded    | macOS with `sandbox-exec` |
| `files-only`            | **unguarded**   | guarded    | anything                  |

`files-only` is a real reduction — any command can read any secret — so it must
be requested explicitly, it announces itself at startup, and the shell wrapper
refuses to run under it. `shell+files` never degrades to it automatically: a
guard that looks installed while guarding far less than the reader assumes is
worse than one that refuses to start.

### Upgrading from 1.x

- `lib/plugin.ts` no longer exists. Point the plugin entry at the `lib`
  directory (`file:///…/lib`); Home Manager users get this from `pluginPath`.
  A stale path makes OpenCode start without the plugin, so the file tools are
  unguarded until it is fixed.
- OpenCode V1 older than 1.18.29 is not supported.
- Confirm in OpenCode's plugin list that the plugin is active.

## Install with Home Manager

```nix
{ config, lib, inputs, ... }:
let
  guard = config.programs.opencode-secret-guard;
in
{
  # flake input: inputs.opencode-secret-guard.url = "github:nb-99/opencode-secret-guard";
  imports = [ inputs.opencode-secret-guard.homeManagerModules.default ];

  programs.opencode-secret-guard = {
    enable = true;
    mode = "shell+files";
    # Additions to the shipped default; upstream fixes still apply.
    extraRelaxationGroups.oci.binaries = [ "ko" ];
    extraSecretExceptions = [ "/pkg/store/secrets/obfuscator\\.go$" ];
    # A shipped refusal this host does not want.
    removeSecretPrintingCommands = [ { binary = "sops"; } ];
    # Whole-key overrides.
    settings = {
      denyRoots = [ "~/.config/secrets" ];
      exemptRoots = [ "~/notes/agent-memory" ];
      secretEnvironment = [ "CONTEXT7_API_KEY" ];
    };
  };

  programs.opencode.settings = {
    # V1's key. V2 rewrites `plugin` to its own `plugins` when it loads the config.
    plugin = lib.optional (guard.pluginPath != null) guard.pluginPath;
  }
  // lib.optionalAttrs (guard.shellPath != null) { shell = guard.shellPath; };
}
```

The module writes the policy and installs the package, but deliberately does not
write into `programs.opencode` itself: consumers assemble their own OpenCode
settings, and reaching into another module's option tree invites merge conflicts
over values this module cannot see.

`extraSecretPatterns`, `extraSecretExceptions`, `extraArtifactAllowlist`,
`extraSecretPrintingCommands` and `extraRelaxationGroups` append to the shipped
default, so a host carries only its deltas. `removeSecretPrintingCommands` drops
shipped refusal rules before the additions are appended, for a host that needs
`sops -d` or a narrower `kubectl` rule without giving up the rest of the list.
`settings` replaces a key wholesale. `gitPackage` (default `pkgs.git`) is the
git the guard itself spawns, written as a store path.

`shellPath` and `pluginPath` are **null when they do not apply** — `shellPath`
whenever the guard is disabled or in `files-only` mode, since the wrapper
refuses to run there. Wiring them unconditionally therefore fails at evaluation
rather than producing a configuration that looks installed and aborts every
command.

## Install without Nix

```sh
nix build github:nb-99/opencode-secret-guard   # or unpack a release
cp result/share/opencode-secret-guard/default-policy.json \
   ~/.config/opencode/secret-guard.json
```

Then point OpenCode at the package:

```jsonc
{
  // The same key on V1 and V2.
  "shell": "/path/to/opencode-secret-guard/bin/opencode-secret-guard",
  // The plugin is a directory; both versions load its index.ts. V2's own name
  // for this key is "plugins", and it accepts "plugin" too.
  "plugin": ["file:///path/to/opencode-secret-guard/lib"]
}
```

The wrapper needs `SECRET_GUARD_BUN` set to the absolute path of `bun`; it never
searches `PATH`, for the same reason its interpreter line is fixed. Without
Nix the policy's `tools.git` defaults to `/usr/bin/git`; set it to the git you
want the guard to spawn.

## Configuration

The plugin reads `~/.config/opencode/secret-guard.json`, or the path in
`OPENCODE_SECRET_GUARD_CONFIG`. Nothing is substituted at build time.

Start from [`policy/default.json`](policy/default.json). Roots may be written
with a leading `~`, expanded at runtime, so a policy is portable between hosts.

| Key                         | Meaning                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `configVersion`             | File format; rejected if unsupported                                                    |
| `mode`                      | `shell+files` or `files-only`                                                           |
| `cleanupRoot`               | Opt-in root for `cleanup_temp`, may start with `~` or `$TMPDIR`; `null` disables it and files-only mode cannot enable it |
| `tools.git`                 | Absolute path of the git the guard spawns; never resolved through `PATH`                |
| `secretPatterns`            | JavaScript regexes; alias paths use the bounded grammar described below                  |
| `secretExceptions`          | Naming allowances; alias paths require a proved universal match                         |
| `artifactAllowlist`         | Proved component-name allowances against Git ignore rules, not secret patterns           |
| `relaxationGroups`          | Per-binary credential access, e.g. `git` → `~/.ssh`, plus `allowEnvironment`            |
| `secretPrintingCommands`    | Invocations refused outright because their output is the credential                    |
| `denyRoots`                 | Never relaxed, never excepted                                                           |
| `exemptRoots`               | Explicit subtree exemptions; file tools require an existing directory, and cache/write-tamper protection takes precedence |
| `secretEnvironment`         | Variable names scrubbed before a command runs, always                                   |
| `secretEnvironmentPatterns` | Regexes; every inherited variable whose name matches is scrubbed                        |
| `cacheTtlMs`                | How often a profile is regenerated                                                      |

Validation fails closed: an unsupported version, a wrong type, a non-absolute
root, an `allowPaths` entry that is not `$HOME`-relative, or a pattern that does
not compile all abort startup. Patterns are compiled at load time because the
matcher treats an uncompilable pattern as "no match" — an unvalidated typo in a
deny pattern would otherwise silently stop guarding.

Tracked regular `templates/**/secret.yaml` and `secret.yml` files belonging to
a chart (`Chart.yaml` beside its `templates/` directory) are readable and
editable, including by `helm lint`. Ignored or untracked lookalikes keep the
usual secret-file restriction. Other secret patterns and denied roots still
apply. Chart templates should not contain plaintext credentials; the guard
checks their path and Git status, not their contents.

### Filesystem case aliases

File tools obtain per-directory lookup metadata from the bundled `path-lookup`
helper. Known-sensitive paths keep JavaScript regex semantics. Insensitive or
unknown paths use a bounded ASCII path-pattern grammar: a possible deny match
protects every alias, while a naming exception must cover every spelling.
Unsupported syntax, Unicode ambiguity, and evaluation limits cannot grant an
exception. A proved prefix exception is independent of unknown descendants.
An unsupported custom deny pattern conservatively refuses every alias-bearing
path unless an explicit root exemption applies. Unsupported custom naming
exceptions never grant access there. Policy loading retains arbitrary valid
JavaScript regexes for known-sensitive paths rather than rejecting them globally.
Plugin startup writes a diagnostic to stderr for each unsupported path
pattern, naming its field, expression, and consequence. A warning does not
change the policy or make unsupported syntax safe on alias-bearing paths.
The per-command shell resolver loads policy silently.

The helper queries per-directory casefold flags on ext4 and tmpfs. Linux 6.13
added tmpfs casefold support, so filesystem type alone cannot prove sensitivity.
Unsupported or failed metadata queries remain unknown, including on currently
unrecognized Btrfs, XFS, and OverlayFS mounts. Darwin uses volume capabilities.
Search-result classification sends up to 256 paths per helper invocation,
bounded by 64 KiB input. Malformed output or helper failure cannot grant access.
There is no filesystem metadata cache between calls.

The tested WSL mount exposes no usable directory case attribute. Its mode is
unknown. Naming exceptions, ignored artifacts, and Helm-template allowances can
be refused on both unknown and known-insensitive filesystems, including default
macOS APFS. An artifact allowance can still apply when the artifact component
has a proved universal match, despite case aliases in other components. It only
overrides Git ignore rules; secret patterns still apply within the artifact.
A tracked Helm allowance similarly requires a universal filename match and
the existing Git and chart checks. Fully insensitive names remain restricted.
Explicit existing-directory exemptions remain available, but a missing exemption root
grants no file-tool access until it exists and the policy is reloaded. Loaded
file-tool policies pin each exempt directory's identity and drop its grant if
the root is replaced or retargeted. The shell profile does not have this lasting
identity binding; inode reuse and filesystem check/use races also remain.
Root exemptions are broader than artifact allowances: they precede secret
patterns. Do not use them as an equivalent replacement for an artifact allowance.

See [the supported grammar and decision](docs/adr/0001-case-alias-policy.md)
and [the WSL verification and limits](docs/wsl-case-matching.md). This does not
add shell isolation to `files-only` mode.

The current policy format is version 3. Version-1 and version-2 policies still
load: `tools.git` defaults to `/usr/bin/git`, and `secretEnvironmentPatterns`,
`secretPrintingCommands` and `allowEnvironment` default to empty. Home Manager
writes the current version automatically.

## What a command can and cannot do

**Credentials are usable, not readable.** A command whose every segment is a
credential binary of one group (`git`, `kubectl`, `aws`, …), an inert builtin
(`cd`, `echo`, …) or a stdin-only filter (`head`, `cut -d=`, `rg` as a direct
pipe consumer, `awk '{print $1}'`, …) runs with that group's credential
directory readable. Any other shape — a path operand, a redirection, a second
group, an environment assignment, command substitution — runs under the strict
profile, where the credentials are unreadable. If such a command fails, the
wrapper prints one line saying which segment cost the group, so the fix is to
split the command, not to retry it.

**Some invocations are refused outright.** `gh auth token`,
`aws eks get-token`, `kubectl config view --raw`,
`kubectl get secret … -o yaml`, `security find-generic-password -w` and the rest
of `secretPrintingCommands` never run, wrapped in `sudo`/`env`/`sh -c`/`$(…)` or
not: their output *is* the secret. Use the credential through the tool that
needs it. Output formats that carry no values — `kubectl get secrets -o name`,
`-o wide` — are not refused. Heredoc bodies passed to `cat` or
`git commit -F -` may describe a refused invocation; bodies passed to other
consumers remain scanned because those programs may execute stdin. A host
that needs one of the shipped rules gone drops it with
`removeSecretPrintingCommands` rather than replacing the key.

**The environment is scrubbed.** Names in `secretEnvironment`, and every
inherited variable matching `secretEnvironmentPatterns` (`*_TOKEN`,
`*_SECRET`, `*_PASSWORD`, `*_API_KEY`, …), are removed before the command
starts. A group's `allowEnvironment` re-admits pattern hits its binaries need
(`aws` keeps `AWS_*`); explicitly named variables are never re-admitted. A
command may expand any variable the group does not keep — `echo $PWD && git
status` keeps its group — because the rest are gone before it runs.

**The guard's inputs are immutable.** No command can write OpenCode's global or
project config, its plugin and tool directories, the `package.json` that makes
it run `bun install`, the npm plugin cache, this package, the policy, `~/.zshenv`
(which the interpreter sources before every command), or any user-writable
directory on `PATH` outside the repository (`/opt/homebrew/bin`,
`/usr/local/bin`, …). Each of those is protected at the path it is named by
*and* at the path it resolves to, so replacing a Home Manager symlink is denied
too. Reads are unaffected; prompts, skills, commands and `~/.zshrc` stay
editable. Practically: `brew install` and `npm i -g` from the agent shell fail —
install tools from your own terminal.

**A failed command explains relevant restrictions.** When a command exits non-zero, the
wrapper adds one line if the guard is a plausible cause: a setuid binary that
cannot run at all, the segment that cost the relaxation, the protected path a
write was denied on, the installer that targets a `PATH` directory, or the
scrubbed variable the command asked for. It knows the exit status and not what
failed, so every line is worded as a condition. Status 127 suppresses all but
the setuid hint: zsh uses that status for both missing and denied executables.

**Renaming does not move a secret out from under its rule.** The directory
nodes that carry a protected name (`~/.kube`, `secrets/`) and the ancestors a
credential path leads through (`~/.config` for `~/.config/gcloud`) cannot be
renamed; hard links to protected files are refused by the kernel.

**setuid binaries do not run under `sandbox-exec`.** `ps`, `top`, `sudo`, `su`,
`crontab`, `at` and `traceroute` fail with `operation not permitted`. Use
`pgrep -fl PATTERN` and `lsof -i :PORT` instead of `ps`, and do privileged work
from your own terminal.

## Guarded temporary cleanup

> **OpenCode V1 only.** `cleanup_temp` is not registered on V2, and the plugin
> says so at startup when `cleanupRoot` is set. It asks OpenCode for `edit`
> permission on every path it will delete, and V2 gives plugin tools no way to
> ask. Tracked in [#16](https://github.com/nb-99/opencode-secret-guard/issues/16).
> On V2, leave `cleanupRoot` unset and delete with ordinary `rm`, which the shell
> guard already confines.

Set `cleanupRoot` to an existing directory such as `$TMPDIR/opencode`, the
scratch directory OpenCode itself uses, to expose the `cleanup_temp` tool. A
leading `$TMPDIR` expands to the OpenCode process's temporary directory, so the
root follows macOS's randomized per-user `TMPDIR`:

```json
{"paths": ["my-task/output", "my-task/download"]}
```

Paths are relative to the configured root. Keep each task's files in its own
subdirectory. The tool rejects absolute paths, `..`, deletion of the root,
and symlink operands or ancestors. Missing targets are safe to repeat if the
root still exists. Symlinks inside a requested directory are unlinked rather
than followed.

The tool inventories descendants and awaits OpenCode's `edit` permission for
every path before deleting anything. Read-only agents and descendant-specific
denials remain effective; approval displays a deletion manifest without file
contents. To avoid prompting for this root, configure an OpenCode
`permission.edit` allowance for the expanded path. OpenCode does not expand
variables in permission patterns, so write it out: `/tmp/opencode/**` for a
`/tmp` root, or `/var/folders/*/*/T/opencode/**` for `$TMPDIR/opencode` on
macOS. The worker independently resolves macOS aliases such as `/private/tmp`.
Keep ordinary bash `rm` rules at `ask`; no command-string exemption is needed.

Deletion runs as fixed `/bin/rm` arguments under `sandbox-exec`, not as shell
text or a filesystem call in the plugin process. Its profile retains the
secret policy and additionally denies writes outside the inventoried entries,
writes to the root, and file creation or data writes. There is no credential
relaxation or automatic fallback to an unguarded worker.

New entries that appear after approval are not deletable. Requests are bounded
to 4,096 entries and a 128 KiB generated profile; select smaller subtrees when a
request exceeds those limits.

All requested paths are validated before execution, but deletion itself is
not transactional. A protected `.env` inside a requested directory can produce
a partial-cleanup error while remaining intact. A refusal is not a reason to
retry through unrestricted bash. This feature confines the cleanup tool, not
all writes by ordinary shell commands.

## Tests

```sh
nix flake check        # typecheck, unit tests, default-policy and layout checks
nix run .#integration  # + kernel tests
```

Nix tests provide the native lookup helper automatically. For direct Bun tests
from a checkout, install the locked npm dependencies and link the built helper
at its fixed location first:

```sh
npm ci
nix build .#default
ln -s ../result/bin/path-lookup bin/path-lookup
```

Without that helper, a checkout deliberately treats lookup metadata as unknown.
The generated helper link is ignored by Git.

The kernel suite must run from a plain terminal. `sandbox-exec` refuses to apply
a profile inside an existing sandbox, and the suite's fixtures are exactly what
an outer guard denies, so both entry points probe first and exit 2 with an
explanation rather than failing later as an unexplained `EPERM`.

## Limitations

- MCP servers and the LSP run outside the sandbox.
- The guard's hooks and other plugins' hooks run in the order OpenCode
  registers them, and neither version lets a plugin choose its place. On V2 the
  guard pins what it checked: a hook that runs later and assigns a new tool
  name, input or shell gets it checked again, and one that changes a checked
  input in place fails and rejects the call. On V1 a hook that runs later can
  still change a tool's arguments. A plugin runs unsandboxed in OpenCode's
  process either way, so this protects against plugins that rewrite calls, not
  against a plugin that renames a tool for the model, replaces a tool or reads
  files itself. The shell environment is not checked, so a plugin that sets a
  variable the wrapper reads (`OPENCODE_SECRET_GUARD_CONFIG`,
  `SECRET_GUARD_BUN`) can redirect it.
- The interactive terminal (V2's PTY service) is not a model tool and is not
  guarded, on V1 or V2. On V2, commands the user runs with `!` in the prompt go
  through the configured shell and are guarded.
- If OpenCode cannot load the plugin (a bad path) it starts without it, and the
  file tools are unguarded. The configured shell wrapper still applies its
  sandbox profile to commands. Confirm in OpenCode's plugin list that the
  plugin is active. If the plugin loads but cannot start (an invalid policy,
  `shell+files` off macOS), it refuses every shell and file tool call with the
  reason instead. In `shell+files` mode, V1 also refuses `bash` until its
  `config` hook has validated the shell, and rechecks the wrapper file before
  each call.
- If OpenCode gives no project directory, the plugin still starts but refuses
  every relative path and every search result.
- A file tool call whose arguments the guard cannot read is refused, and so is a
  search result it cannot check, so an OpenCode update that renames a field
  shows up as an error instead of an unguarded tool.
- OpenCode V2's `read` lists sibling names in its "file not found" message and
  in directory listings, and the guard does not filter those. File names are not
  treated as secret; file contents are.
- Network access is unrestricted; the mitigation is that a process which cannot
  read a secret cannot exfiltrate it.
- A relaxed binary's own extension mechanisms are in scope for that binary. This
  is a credential-scoping boundary, not a capability sandbox. The refusal list
  covers the invocations that print a credential by design; a `git` alias that
  runs a shell is still git.
- Credentials held in the macOS keychain are reachable through Security.framework
  by any process the keychain trusts; the guard covers files, not the keychain.
- `sandbox-exec` is formally deprecated by Apple. It still ships in macOS 26 and
  is still used by Chrome and Claude Code.
- A profile is a snapshot, so a directory created after generation is not
  enumerable until the profile is rebuilt.

## License

MIT
