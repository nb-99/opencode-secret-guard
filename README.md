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
{
  inputs.opencode-secret-guard.url = "github:nb-99/opencode-secret-guard";

  # …

  imports = [ inputs.opencode-secret-guard.homeManagerModules.default ];

  programs.opencode-secret-guard = {
    enable = true;
    mode = "shell+files";
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

The wrapper needs `bun` on `PATH`, or `SECRET_GUARD_BUN` pointing at it.

## Configuration

The plugin reads `~/.config/opencode/secret-guard.json`, or the path in
`OPENCODE_SECRET_GUARD_CONFIG`. Nothing is substituted at build time.

Start from [`policy/default.json`](policy/default.json). Roots may be written
with a leading `~`, expanded at runtime, so a policy is portable between hosts.

| Key                 | Meaning                                                |
| ------------------- | ------------------------------------------------------ |
| `configVersion`     | File format; rejected if unsupported                   |
| `mode`              | `shell+files` or `files-only`                          |
| `cleanupRoot`       | Opt-in root for `cleanup_temp`; `null` disables it and files-only mode cannot enable it |
| `secretPatterns`    | Regexes denied in both layers                          |
| `secretExceptions`  | Re-allowed after the deny block                        |
| `artifactAllowlist` | Path components re-allowed against the gitignore layer |
| `relaxationGroups`  | Per-binary credential access, e.g. `git` → `~/.ssh`    |
| `denyRoots`         | Never relaxed, never excepted                          |
| `exemptRoots`       | Overrides everything above                             |
| `secretEnvironment` | Variables scrubbed before a command runs               |
| `cacheTtlMs`        | How often a profile is regenerated                     |

Validation fails closed: an unsupported version, a wrong type, a non-absolute
root, an `allowPaths` entry that is not `$HOME`-relative, or a pattern that does
not compile all abort startup. Patterns are compiled at load time because the
matcher treats an uncompilable pattern as "no match" — an unvalidated typo in a
deny pattern would otherwise silently stop guarding.

The current policy format is version 2. Version-1 policies still load with
cleanup disabled. To enable cleanup in a manually managed policy, set
`configVersion` to `2` and add `cleanupRoot`. Home Manager writes the current
version automatically.

## Guarded temporary cleanup

Set `cleanupRoot` to an existing directory such as
`/tmp/agent-temporary-workspace` to expose the `cleanup_temp` tool:

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
`/tmp/agent-temporary-workspace/**`. Use the same spelling as `cleanupRoot`;
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
  is a credential-scoping boundary, not a capability sandbox.
- `sandbox-exec` is formally deprecated by Apple. It still ships in macOS 26 and
  is still used by Chrome and Claude Code.
- A profile is a snapshot, so a directory created after generation is not
  enumerable until the profile is rebuilt.

## License

MIT
