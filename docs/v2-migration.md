# OpenCode V2 migration

Plugin 2.0.0 supports OpenCode V1 1.18.29 or newer and V2 through one package.
V2 2.0.20 has been tested live on macOS. V1 1.18.31 directory loading is
verified; a live check on the minimum V1 1.18.29 remains pending.

## Installation contract

The package default-exports `{ id, setup, server }` from `lib/index.ts`.
V2 calls `setup(ctx)`; V1 calls `server(input, options)`, as described in the
[plugin migration guide][migrate]. V1 supports object entry points from
1.18.29, which sets the minimum version and requires the plugin's 2.0.0 bump.

Configure the plugin directory, `file:///…/lib`, instead of the old
`file:///…/lib/plugin.ts`. Home Manager's `pluginPath` supplies that directory
for both hosts. V2 rejects a configured file path ([source][v2-source]) and
resolves `server`, then `index`, inside a directory ([`Host.resolve`][v2-host]).
V1 1.18.31 was tested with a directory containing an `index.ts` object export.
Its loader calls `server` and ignores the V2 keys
([`readV1Plugin`][v1-shared], [`applyPlugin`][v1-index]).

The README uses the V1 `plugin` config key for both versions. V2 rewrites it to
`plugins` ([normalizer][v2-normalize]); this was also verified live. The `shell`
key still points to this package's wrapper. See the [README](../README.md) for
installation examples.

`cleanup_temp` remains V1-only. V2 plugin tools cannot open a permission prompt
for computed deletion paths. Registering the tool without that prompt would
remove its permission boundary, so the adapter omits it and writes a startup
notice when `cleanupRoot` is set. This limitation is tracked in
[#16](https://github.com/nb-99/opencode-secret-guard/issues/16).

## Host adapters

`src/guard.ts` contains the shared tool-call policy. Each adapter checks host
payloads at its boundary and translates them into `checkToolCall` arguments.
The package uses local structural types rather than `@opencode/plugin`.
`Plugin.define` is an identity function, and the loader accepts the object
export directly. Avoiding the SDK also avoids vendoring its dependency tree for
the hermetic typecheck; the package vendors only Zod for the V1 cleanup tool.

| Purpose | V1 | V2 |
| --- | --- | --- |
| Check the shell | `config` validates `config.shell`; before-hook gates `bash` | `shell` `create.before` validates `event.shell` |
| Block a call | `tool.execute.before(input, output)` | `tool` `execute.before(event)` |
| Filter search results | parse and rewrite `output.output` | filter `result.output`, rebuild `content` and counts |
| Search arguments | actual `args` in the after-hook | structured result paths suffice |
| Working directory | `server()` input's `directory` | `ctx.location.directory` |
| Register cleanup | returned `tool` map and `context.ask` | unavailable |

V2 before-hooks cover built-in, plugin and MCP calls, including subagent calls
at the same location, before the executor's permission checks ([source][v2-tool]).
Live Code Mode checks confirmed that inner calls reach the hook under their
effective tool names.

### Startup and shell checks

Both hosts catch plugin setup failures and continue without the plugin
([V2][v2-plugin-service], [V1][v1-index]). The entry point catches its own startup
failure and installs refusing hooks instead. Invalid policy therefore refuses
guarded file and shell calls with the reason. A stale plugin path never reaches
the entry point and still leaves file tools unguarded.

V1 also only logs errors from the `config` hook. In `shell+files` mode, the
before-hook refuses `bash` until shell validation succeeds and rechecks that the
wrapper file exists. Failed revalidation clears the successful state. The file
check is defense in depth; V1 resolves the shell during `Tool.init`, not per
command ([source][v1-bash]).

V2 selects the configured shell with `priority: "compat"`, rejecting `fish`
and `nu` by name but accepting the wrapper. It spawns `[shell, "-c", command]`
with unchanged command text ([selection][v2-select], [spawn][v2-shell]).
A missing configured file falls back to the platform shell. The guard checks
every `create.before` event and refuses any shell other than its own wrapper.

The interactive PTY terminal is separate from the model's shell tool and does
not trigger `create.before`. It is unguarded on both hosts. V2 prompt commands
entered with `!` use the configured shell.

### Paths and tools

| Tool | V1 argument | V2 argument |
| --- | --- | --- |
| `bash` / `shell` | `command` | `command` |
| `read`, `write`, `edit` | `filePath` | `path` |
| `apply_patch` / `patch` | `patchText` | `patchText` |
| `glob`, `grep` | optional `path` | optional `path` |

Neither host has a built-in `list` tool; `read` lists directories. The guard
also recognizes `list`, and checks V1's optional `lsp.filePath` as a read.
V2's browser file tools open files in the unsandboxed server, so the guard checks
`browser_files_upload` and `browser_files_drop` arrays of `paths`, and
`browser_preview.path`, as reads. Uploads can expose bytes through a later
browser call; browser permissions alone do not enforce file access policy.

Relative paths use the host directory, never `process.cwd()`. Without an
absolute host directory, both adapters refuse relative paths and search
results. The shared call check classifies leading `~` both literally and
expanded because V1 and V2 resolve it differently. V2 `read` can substitute a
canonically equal sibling for a missing name, so those candidates are checked
too. Directory listings and missing-file suggestions can still show names;
the guard protects contents.

Patch checks cover every `Add File`, `Update File`, `Delete File` and `Move to`
header ([parser][v2-patch]). Headers are sliced on `\n`, preserving characters
such as U+2028 and U+2029 that a regex `.` would miss. Unreadable file-call
arguments are refused. Git classification errors deny paths; `isGitIgnored`
rejects statuses other than 0 or 1 without caching a verdict.

V2 retains global config at `~/.config/opencode`, cache at `~/.cache/opencode`
and data at `~/.local/share/opencode` ([paths][v2-global]). Tamper protection
covers its npm plugin cache at `<cache>/npm`, helpers at `<cache>/bin`, and
local `.opencode/plugin/` and `.opencode/plugins/` trees. V2 installs package
plugins with Arborist and `ignoreScripts: true`; `package.json` protection
remains necessary because V1 still runs `bun install`.

### Search filtering

V1's text parser lives in `src/v1.ts` and uses the actual after-hook arguments,
without a before-call map. Supported hosts emit absolute search paths; the
relative fallback uses the search root with literal `~` semantics. The parser
keeps the current grep file across blank lines because ripgrep match text
retains its trailing newline. It validates groups and match counts, withholds
malformed or uncheckable results, and recomputes summaries and counts.

V2 glob returns structured `{ path, type }` entries. Grep returns matches with
`entry.path`, `line` and `text` ([glob][v2-glob], [grep][v2-grep]). These paths
are relative to `location.directory`, so filtering needs no before-call state.
The adapter filters `output`, rebuilds `content` and updates metadata counts,
preserving truncation notices. It filters a result whenever present, regardless
of status. Because `execute.after` has no failure channel, malformed or
uncheckable results become a withheld-result notice rather than an exception.

### Later plugins

V2 pins checked tool calls and shells against later hook assignments. V1 calls
remain exposed to later argument rewrites. See [the design](design.md#two-hosts-one-policy)
for the frozen-input invariant, executor-wrapping trade-off and plugin limitations.

## Verification evidence

The author recorded these live checks on OpenCode 2.0.20, macOS, `shell+files`:

| Revision and evidence | Coverage |
| --- | --- |
| [`d571cae`][live-initial] | Directory loading beside rtk, legacy `plugin` normalization, shell enforcement and refusal messages, relative/`~`/`..` paths, case and symlinks, glob/grep filtering and truncation, Code Mode and browser file tools |
| [`5fe54da`][live-recheck] | Invalid-JSON policy refuses reads and shells; later project-plugin input and shell replacements are refused; two projects on one server pass in both orders |

These reports validate those revisions. They do not establish that later
changes have passed live checks. V1 1.18.31 directory loading was verified
separately; V1-only behavior was not rechecked in the V2 sessions.

V2 unit tests use a shared fake host that runs hooks sequentially, so later-hook
tests exercise the same event ordering. Test commands use shell-expanded
`tests/*.test.ts` globs to include new suites. Run `nix flake check -L` for the
typecheck, unit, policy, package-layout and shell checks. Run
`nix run .#integration` from a plain terminal for the macOS kernel suite;
`sandbox-exec` cannot nest inside the agent's sandbox.

### Remaining live checks

V1 1.18.29 still needs directory loading and tool checks, including cleanup
registration and permission prompts, experimental `lsp` refusals, the shell
validation gate and wrapper-removal refusal. Source inspection establishes the
after-hook arguments and host directory contract; their behavior on the minimum
release still needs live confirmation.

V2 checks still unrecorded include a stale `lib/plugin.ts` path, a missing
configured shell, unsupported policy versions, startup stderr notices in the
TUI, failed-call event shape, and the interactive PTY boundary. A later rewrite
to `/bin/sh` was refused live, but the reports do not separately establish the
TUI presentation for every shell failure. Patch `*** Environment ID:` handling
also needs confirmation that it does not change the filesystem root used for
classification. The no-break-space read substitution could not be tested live
because the submitted path became a plain space; unit tests cover it. A captured
real glob/grep fixture would provide a regression check for rebuilt formatting.

## Source versions

Hook and tool contracts were read from [V2 2.0.16][v2-tag] and
[V1 1.18.33][v1-tag], with V1 1.18.29 source used for minimum-version behavior.
Plugin path loading was also checked at the `v2` branch head with
`@opencode/plugin` 2.0.19. The [V2 plugin docs][plugins] and
[migration guide][migrate] describe the public API. Live evidence above pins
the tested host to V2 2.0.20.

[migrate]: https://opencode.ai/v2/docs/build/plugins/migrate-v1
[plugins]: https://opencode.ai/v2/docs/build/plugins
[v2-tag]: https://github.com/anomalyco/opencode/tree/v2.0.16
[v1-tag]: https://github.com/anomalyco/opencode/tree/v1.18.33
[v2-source]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/config/plugin/source.ts
[v2-host]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/plugin/src/host.ts
[v2-normalize]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/config/normalize.ts
[v1-shared]: https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/plugin/shared.ts
[v1-index]: https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/plugin/index.ts
[v1-bash]: https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/tool/shell.ts
[v2-plugin-service]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/plugin.ts
[v2-tool]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/tool.ts
[v2-patch]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/util/src/patch.ts
[v2-glob]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/tool/plugin/glob.ts
[v2-grep]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/tool/plugin/grep.ts
[v2-select]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/shell/select.ts
[v2-shell]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/shell.ts
[v2-global]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/util/src/global.ts
[live-initial]: https://github.com/nb-99/opencode-secret-guard/pull/17#issuecomment-5910743386
[live-recheck]: https://github.com/nb-99/opencode-secret-guard/pull/17#issuecomment-5915577295
