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
- **file tools** — `read`, `write`, `edit`, `patch`, `list`, `glob` and `grep`
  run the same policy as a path predicate, and `glob`/`grep` results are
  filtered.

Both layers are derived from one policy file, and a test compares their verdicts
against each other on every run.

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

| Mode                    | bash tool       | file tools | Requires                  |
| ----------------------- | --------------- | ---------- | ------------------------- |
| `shell+files` (default) | kernel-enforced | guarded    | macOS with `sandbox-exec` |
| `files-only`            | **unguarded**   | guarded    | anything                  |

`files-only` is a real reduction — any command can read any secret — so it must
be requested explicitly, it announces itself at startup, and the shell wrapper
refuses to run under it. `shell+files` never degrades to it automatically: a
guard that looks installed while guarding far less than the reader assumes is
worse than one that refuses to start.

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

```json
{
  "shell": "/path/to/opencode-secret-guard/bin/opencode-secret-guard",
  "plugin": ["file:///path/to/opencode-secret-guard/lib/plugin.ts"]
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
| `cleanupRoot`               | Opt-in root for `cleanup_temp`; `null` disables it and files-only mode cannot enable it |
| `tools.git`                 | Absolute path of the git the guard spawns; never resolved through `PATH`                |
| `secretPatterns`            | Regexes denied in both layers                                                           |
| `secretExceptions`          | Re-allowed after the deny block                                                         |
| `artifactAllowlist`         | Path components re-allowed against the gitignore layer                                  |
| `relaxationGroups`          | Per-binary credential access, e.g. `git` → `~/.ssh`, plus `allowEnvironment`            |
| `secretPrintingCommands`    | Invocations refused outright because their output is the credential                    |
| `denyRoots`                 | Never relaxed, never excepted                                                           |
| `exemptRoots`               | Overrides everything above                                                              |
| `secretEnvironment`         | Variable names scrubbed before a command runs, always                                   |
| `secretEnvironmentPatterns` | Regexes; every inherited variable whose name matches is scrubbed                        |
| `cacheTtlMs`                | How often a profile is regenerated                                                      |

Validation fails closed: an unsupported version, a wrong type, a non-absolute
root, an `allowPaths` entry that is not `$HOME`-relative, or a pattern that does
not compile all abort startup. Patterns are compiled at load time because the
matcher treats an uncompilable pattern as "no match" — an unvalidated typo in a
deny pattern would otherwise silently stop guarding.

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
`-o wide` — are not refused, and neither is prose: a heredoc body is stdin text,
so a commit message or a document may describe a refused invocation. A host
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

**A failed command says which rule it hit.** When a command exits non-zero, the
wrapper adds one line if the guard is a plausible cause: a setuid binary that
cannot run at all, the segment that cost the relaxation, the protected path a
write was denied on, the installer that targets a `PATH` directory, or the
scrubbed variable the command asked for. It knows the exit status and not what
failed, so every line but the setuid one is worded as a condition. A binary
that does not exist (status 127) is never the guard's doing and gets no line.

**Renaming does not move a secret out from under its rule.** The directory
nodes that carry a protected name (`~/.kube`, `secrets/`) and the ancestors a
credential path leads through (`~/.config` for `~/.config/gcloud`) cannot be
renamed; hard links to protected files are refused by the kernel.

**setuid binaries do not run under `sandbox-exec`.** `ps`, `top`, `sudo`, `su`,
`crontab`, `at` and `traceroute` fail with `operation not permitted`. Use
`pgrep -fl PATTERN` and `lsof -i :PORT` instead of `ps`, and do privileged work
from your own terminal.

## Guarded temporary cleanup

Set `cleanupRoot` to an existing directory such as
`/tmp/opencode` to expose the `cleanup_temp` tool:

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
contents. To avoid prompting for this root, configure
an OpenCode `permission.edit` allowance for
`/tmp/opencode/**`. Use the same spelling as `cleanupRoot`;
the worker independently resolves macOS aliases such as `/private/tmp`.
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

The kernel suite must run from a plain terminal. `sandbox-exec` refuses to apply
a profile inside an existing sandbox, and the suite's fixtures are exactly what
an outer guard denies, so both entry points probe first and exit 2 with an
explanation rather than failing later as an unexplained `EPERM`.

## Limitations

- MCP servers and the LSP run outside the sandbox.
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
