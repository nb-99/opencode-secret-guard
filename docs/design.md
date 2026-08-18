# Secret Guard

Keeps secrets out of the agent's context. Configured by the policy file;
implemented by the modules in `src/`.

## Configuration

the policy file is serialized to JSON, tagged with the `configVersion` of
the file format, and written to `~/.config/opencode/secret-guard.json`. The
plugin reads and validates it at runtime — `OPENCODE_SECRET_GUARD_CONFIG`
overrides the location for tests.

Nothing is substituted into the plugin source at build time, so the runtime
contract does not depend on Nix. Validation is strict and fails closed:
unsupported `configVersion`, wrong types, a non-absolute `denyRoots`/
`exemptRoots` entry, an `allowPaths` entry that is not `$HOME`-relative, or a
pattern that does not compile all abort startup. Patterns are compiled at load
time specifically because the matcher treats an uncompilable pattern as "no
match", so an unvalidated typo in a deny pattern would silently stop guarding.
Roots may be written with a leading `~`, expanded against the real home.

### Modes

`mode` selects how much of the boundary is in force. It defaults to
`shell+files`, so a policy written before the field existed keeps its full
boundary rather than silently weakening.

| Mode | Bash tool | File tools | Requires |
| --- | --- | --- | --- |
| `shell+files` (default) | kernel-enforced | predicate | macOS with `sandbox-exec` |
| `files-only` | **unguarded** | predicate | anything |

`files-only` exists so the portable half of the guard is usable on hosts that
have no `sandbox-exec`. It is genuinely weaker: any command can read any secret.
It therefore has to be asked for explicitly, it prints a warning at startup, and
the shell wrapper refuses to run at all under it — a wrapper that executed
commands without a profile would be worse than no wrapper.

`shell+files` refuses to start on a host it cannot deliver on, naming the reason
at startup instead of letting every command fail later with an `EPERM` that
names neither the guard nor the cause. It never falls back to `files-only`
automatically: a guard that looks installed while guarding far less than the
reader assumes is the worst of the available options.

## Why not command patterns

OpenCode's `permission.bash` rules match the command *string*. That is fine for
"should this be confirmed?" but useless as a boundary: `F=.env; cat $F`,
`cat .en?`, `base64 < .env`, and `python3 -c "open('.env')"` all read the same
file without ever containing a matchable pattern. Anything built on string
inspection is defeated by shell expansion.

## Layer 1 — kernel sandbox (bash)

OpenCode uses the packaged `opencode-secret-guard` executable as its configured
shell. OpenCode passes it the command produced by earlier hooks as
`-c <command>`; the executable then runs

```sh
/usr/bin/sandbox-exec -f <profile.sb> /bin/zsh -c '<command>'
```

The wrapper and the plugin ship as one package:

```text
opencode-secret-guard/
├── bin/opencode-secret-guard   # the configured shell
└── lib/secret-guard.ts         # plugin hooks and profile resolver
```

Neither file is substituted at build time. The wrapper locates the resolver
relative to itself and takes `bun` from `SECRET_GUARD_BUN` or `PATH`, so the
package works from a Nix store path or a plain checkout. In return, the plugin
verifies at startup that OpenCode's configured shell *is* this package's own
`bin/opencode-secret-guard`, comparing realpaths rather than matching a store
path — which keeps the check valid through a Home Manager profile symlink while
still rejecting a wrapper from a different installation.

One resolver invocation returns the profile path on its first line and the
names in `secretEnvironment` on the following ones, which
`/usr/bin/env -u …` then removes. Shell init loads these values from
`~/.config/secrets` for MCP servers; without scrubbing, any guarded command
could still reveal an inherited value through `printenv`, despite being unable
to open the source file. Because the protocol is line-oriented, the policy
validator restricts these names to `[A-Za-z_][A-Za-z0-9_]*`. MCP servers retain
their configured credentials; only agent shell children lose these inherited
variables. The command stored and shown by OpenCode is not replaced with this
implementation detail.

Enforcement happens in the kernel, so it covers variable expansion, globs,
redirections, `find -exec`, interpreters, archivers, and recursive greps
uniformly. The generated shell and profile are exercised end to end by
`tests/sandbox.test.sh`.

The shell receives whatever command `rtk.ts` has produced. It **fails closed**:
a missing `sandbox-exec`, an invalid shell invocation, a missing resolver or
`bun`, or a profile that cannot be generated aborts the command.

This is safe only because OpenCode's bash tool is not a persistent shell — `cd`
and exported variables never survived between calls anyway.

## Profile structure

Rules are emitted in this order, because SBPL applies the **last** matching
rule:

1. `deny file-read-data` for `.gitignore`d paths (reads only)
2. `allow file-read-data` for allowlisted path components
3. `allow file-read-data` for the directories inside ignored trees
4. `deny file-read-data file-write*` for every secret pattern
5. `allow` for the relaxation group, if one applies
6. `allow` for the exception patterns (`.env.example`, …)
7. `deny` for `denyRoots` — never relaxed, never excepted
8. `allow` for `exemptRoots` — carved back out of step 7
9. `deny file-write*` for the generated-profile cache

Three non-obvious constraints, all verified empirically:

- **Paths are canonicalized before matching.** `/etc` is really `/private/etc`,
  so a rule anchored on `^/etc/` never fires. Every emitted path is `realpath`'d
  and every pattern is suffix- or component-anchored.
- **Last-rule-wins applies per operation name.** `(allow file-read*)` does *not*
  override `(deny file-read-data)`. An allow must repeat the deny's exact
  operation list.
- **Deny `file-read-data`, not `file-read*`.** The latter includes metadata, so
  denying it makes `ls -la` fail on every secret rather than merely hiding its
  contents.

Ignored *directories* become a `^<dir>/` regex rather than `(subpath …)`, so
`readdir` still works on the ignored directory itself and `find` does not error
on every ignored directory. That prefix does, however, cover the *sub*
directories of the tree, and enumerating a directory is a `file-read-data`
operation on the directory — which is why every directory below an ignored tree
is re-allowed individually in step 3. Without it, any tree walker (eslint,
`find`) fails with `EPERM` one level into an ignored directory. A file path is
never equal to one of those literals, so contents stay denied. Filenames are not
the secret; their contents are.

The walk skips allowlisted names, whose subtree step 2 already re-allows, and
stops at 4096 directories so one pathological cache cannot dominate profile size
and generation time. Anything past the limit keeps the old, un-enumerable
behaviour.

`.gitignore` rules come from
`git ls-files -o -i --exclude-standard --directory`, which gives exact git
semantics with directories collapsed — no glob-to-regex translation to get
wrong. Paths with components on `artifactAllowlist` (`.gitignore`,
`node_modules`, `dist`, `build`, …) beneath the active repository are re-allowed
after the Git-ignore deny. This also works when Git collapses an ignored parent
such as `.opencode/` into one entry. Other files under that parent remain
denied, and secret patterns are then re-applied, so `node_modules/pkg/.env`
remains denied. Canonical targets of tracked files are removed from this layer,
so an ignored symlink cannot make tracked project data unreadable.

Profiles are cached under `${XDG_CACHE_HOME:-~/.cache}/opencode-secret-guard/`
keyed by the shell's actual working-directory repo root, group, home, and config,
with a short TTL (`cacheTtlMs`). Commands can read but cannot
write this directory, preventing a command from replacing its next profile with
a permissive one. File tools cannot access the cache.

**A profile is a snapshot.** Because directories inside ignored trees are listed
individually, one created after generation is not enumerable until the profile
is rebuilt. Shortening the TTL narrows that window but cannot close it: a single
compound command (`pnpm test && eslint .`) creates the directories *after* its
own profile was built. Two structural alternatives exist, neither adopted:
re-validating every recorded directory's mtime on a cache hit costs more than
regenerating, and denying ignored *files* individually instead of the tree
prefix would make enumeration deterministic at the price of leaving a
just-created ignored file readable until the next rebuild.

## Per-binary relaxation

`~/.ssh`, `~/.aws`, `~/.kube` and friends are exactly the files the agent must
be able to read *indirectly* — denying them outright breaks git-over-SSH,
`kubectl`, `aws`, and `terraform`. Each group re-allows only its own paths:

| Group | Binaries | Re-allows |
| --- | --- | --- |
| `ssh` | `git`, `ssh`, `scp`, `rsync`, `gh`, `glab`, `fj`, `jj`, … | `~/.ssh`, `~/.gnupg`, `~/.git-credentials`, `~/.netrc` |
| `kube` | `kubectl`, `helm`, `k9s`, `stern`, `flux`, `argocd`, … | `~/.kube` |
| `aws` | `aws`, `terraform`, `tofu`, `terragrunt`, `packer`, `sam` | `~/.aws` |
| `oci` | `docker`, `podman`, `nerdctl`, `skopeo`, `crane` | `~/.docker` |
| `npm` | `npm`, `pnpm`, `yarn`, `bun`, `npx` | `~/.npmrc` |
| `gcp` | `gcloud`, `gsutil` | `~/.config/gcloud` |
| `azure` | `az` | `~/.azure` |

This is a credential-scoping boundary, not a capability sandbox for the group
binary itself. Once selected, the binary and its subprocesses can read that
group's paths; for example, a deliberately constructed `git diff` can ask git
to print a private-key file. The resolver prevents unrelated shell segments,
expansions, filters, and injected environment options from inheriting that
access, but it cannot prove the semantic intent of every argument accepted by
git, kubectl, helm, and the other credential clients. User intent and OpenCode
ask permissions remain the control for deliberately dangerous invocations.

A group applies **only when every segment of the command invokes one of its
binaries, a skippable builtin, or a filter that cannot open a file**. This closes
the compound-command hole by construction rather than by pattern matching:

```sh
kubectl get pods                      # kube group   -> ~/.kube readable
kubectl version && cat ~/.kube/config # `cat` names a path
                                      #   -> strict profile -> denied
kubectl get pods | cat                # `cat` reads only stdin -> kube group
kubectl get crd | rg gateway.networking.k8s.io
                                      # `rg` searches only stdin -> kube group
```

Command substitution, backticks, process substitution (including zsh's `=(…)`
file form), zsh evaluation flags/glob qualifiers, subshells, and unbalanced
quoting all force the strict profile. Leading environment assignments do too:
variables such as `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`, and
`RIPGREP_CONFIG_PATH` can inject programs or options that the argument scan
cannot see. `rtk`, `command`, `nohup`, and `time` are
unwrapped first; `sudo` and `xargs` deliberately are not, so they fall through to
strict.

The substitution scan is **quote-aware**, because the same characters are
ordinary text nearly everywhere they appear. Judged per region, matching zsh:

| region | `` ` `` and `$(` | `<(`, `>(`, `=(`, and zsh evaluation forms |
| --- | --- | --- |
| unquoted | expands → strict | expands → strict |
| double-quoted | expands → strict | literal → allowed |
| single-quoted | literal → allowed | literal → allowed |
| backslash-escaped | literal → allowed | literal → allowed |

So a commit message may contain backticks — ``git commit -m 'fix `2>&1`'`` and
`git commit -m "fix \`2>&1\`"` both keep their group — while
`git commit -m "$(cat ~/.ssh/id_ed25519)"` still runs strict. Verified against
`/bin/zsh`: the escaped forms print literally and execute nothing, the unescaped
form runs.

`eval`, `exec`, `source`, and `.` are **not** pattern-matched. They only run
something when they lead a segment, and there they are simply the segment's
binary, which belongs to no group — the ordinary rule already returns strict.
Matching them as text only ever misfired on prose: `git commit -m "refactor eval
handling"` and even `git push origin source-maps` used to run strict, the latter
because `-` is a word boundary.

`cd`, `pushd`, `popd`, `sleep`, `echo`, `printf`, `true`, `false`, and `:` are skipped
instead: they cannot open a file, so they can neither read nor write what the
relaxation grants. Without that, `cd repo && git commit` runs strict and fails
deep inside git — as a gpg error about `~/.gnupg`, which names neither the guard
nor the cause. `git log; echo done` and `git status || true` failed the same
way. A segment containing `<` or `>` is never skipped, since a redirection can
create or truncate a file even from a builtin.

`cat`, `head`, `tail`, `wc`, `sort`, `uniq`, `tr`, `nl`, `rev`, and `column` are
skipped **conditionally**. Their stdin is the previous segment's stdout, which
the caller could already read, so they add no reach of their own — but they can
open a file when given one. A segment is therefore only skipped when every
argument is a bare number (`tail -n 30`) or a flag with no `/`, `~`, or `=` in
it. `cat ~/.ssh/id_ed25519`, `cat pubring.kbx`, `sort -o/tmp/out`, and
`cat < ~/.ssh/id_ed25519` all fail that test and keep the strict profile.

`rg`, `grep`, and `jq` are skipped **conditionally** too, but only as direct
pipe consumers: `kubectl get pods | rg gateway` keeps the kube group, while
`kubectl get pods && rg gateway` runs strict because rg would search the
working tree. They must have exactly their pattern/filter operands and no file
operands, recursive/files modes, leading environment assignments, or
path-bearing options (`-f`/`--file`, `--ignore-file`, `--pre`,
`--exclude-from`, jq's `--slurpfile`/`--rawfile`/`-L`). `--` also keeps the
command strict because operands after it may start with a dash and cannot be
distinguished safely. jq's `--arg`/`--argjson` value pairs are consumed as
values, so `kubectl get -o json | jq --arg p x '.items[]'` keeps the kube
group while `jq . ~/.kube/config` does not.

A file search cannot safely stay in the same compound command: a path that
looks harmless may be a parent directory or may be resolved after `cd`, and a
relaxed search process can then descend into the credential directory. Use two
shell calls instead: write to `/tmp/agent-temporary-workspace/`, then search the
file separately under the strict profile.

`tee`, `sed`, and `awk` are excluded because they write files or shell out;
`less` because `LESSOPEN` lets it run a preprocessor.

Falling back to strict is always safe but not always obvious. A **heredoc** does
it too: the segment scanner splits on newlines, so the body reads as a list of
commands that belong to no group. Write the payload to a file first — which is
also what the file tools are for — rather than piping a heredoc into a command
that needs a credential. A long commit message needs no such workaround:
newlines inside quotes are not boundaries, so `git commit -m "…"` spanning many
lines keeps its group.

Redirection operators are **not** segment boundaries even though they contain
`&`: `2>&1`, `>&2`, and `&>file` stay inside their segment. Splitting there used
to invent a segment named `1`, which belongs to no group, so every git or ssh
command carrying `2>&1` silently ran strict.

## Layer 2 — file tools

`read`, `write`, `edit`, `patch`, `list`, `glob`, and `grep` run the same
predicate. `glob` results are filtered per line and `grep` results per hit
group. The predicate mirrors the
profile's ordering, resolves each target's *own* repository root, and defaults
to **allow** whenever it cannot classify a result — the opposite of the
`opencode-ignore` plugin it replaces, which defaulted to dropping and silently
lost every hit outside the current project.

Ignored *directories* classify as allow so `list` can enumerate them, matching
the profile; the files inside them stay denied.

This layer is the *only* gate for the file tools — they run inside opencode's
process and never touch `sandbox-exec` — so it is on the hot path of every
search. Verdicts for a whole result set are resolved by `classifyPaths`, which
issues one `git check-ignore -z --stdin` per repository instead of one per
result; at ~11 ms a spawn, a hundred hits took over a second before. Repository
roots are found by walking up for a `.git` entry rather than spawning
`git rev-parse`. A unit test asserts the batch and single-path predicates return
identical verdicts, so the fast path cannot drift from the audited one.

## Roots

`denyRoots` (`~/.config/secrets`, the Obsidian vault) are opaque: `subpath`
denies block `readdir` too, so the directory cannot even be listed.
`exemptRoots` (the `agent-memory` subtree) is emitted *after* them, which is
what lets a readable subtree sit inside an unreadable parent.

This hardens a boundary that was previously enforced only by a command pattern.
The `*agent-vault*` bash rule does fire, but it matches parsed command
structure, so binding the path to a shell variable first slips past it — the
usual failure mode of string matching. The kernel rule has no such gap.

## Residual gaps

- MCP servers and the LSP run outside the sandbox. See
  [MCP sandboxing](mcp-sandboxing.md) for the options.
- Network access is unrestricted, but a process that cannot read a secret cannot
  exfiltrate it.
- Credentials supplied through a relaxed binary's own extension mechanisms
  remain a deliberate Option B trade-off: for example, a `git` alias can run a
  shell while the SSH profile is active. Eliminate per-binary relaxations for a
  strict Option C boundary.
- `sandbox-exec` is formally deprecated by Apple. It still ships in macOS 26.5
  and is still used by Chrome and Claude Code.

## Tests

```sh
nix flake check        # typecheck, unit tests, default-policy and layout checks
nix run .#integration  # + kernel tests; needs sandbox-exec, so it cannot run
                       #   inside a nix build
```

The kernel suite must run from a plain terminal. The kernel refuses to apply a
profile inside an existing sandbox, and its fixtures (a `.env`, ignored trees)
are what an outer guard denies — so both entry points probe `sandbox-exec` first
and exit 2 with an explanation rather than failing later as an unexplained
`EPERM` during fixture setup.

### Keeping the two layers in agreement

`classifyPath` mirrors `buildProfile` by hand, and almost every other test
exercises one layer or the other. The two could therefore drift apart without a
single failure, leaving a secret guarded where the agent reads files and exposed
where it runs commands, or the reverse.

The kernel suite closes that gap directly: it enumerates every fixture file,
asks `tests/classify.ts` for the file-tool verdict, asks the kernel
for the same verdict under the generated profile, and fails on any disagreement.

One divergence is deliberate and asserted rather than excluded: the profile
makes the cache **read-only** instead of unreadable, because a command must be
able to read the profile it is running under, while an agent has no reason to
see it. The file-tool predicate hides it outright.
