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
the hermetic typecheck; the package vendors only Zod at runtime, used by the V1 cleanup
tool and by the V2 permission reviewer.

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

### Permission review dependencies

The optional [permission reviewer](permission-review.md) uses V2 host
contracts that were checked against the [v2.0.20][v2.0.20-tag] and
[v2.0.23][v2.0.23-tag] source, not in a live session:

- `permission` `evaluate` runs after the rulesets resolve a request's effect
  and lets a plugin change it ([source][v2-permission]).
- A tool permission request's `source` carries the tool call's `messageID` and
  `id`, which correlate it with the `tool` `execute.before` and `execute.after`
  events ([source][v2-plugin-tool]).
- The [shell tool][v2-plugin-shell] checks [external-directory access][v2-file-access]
  before shell permission. Both checks carry the same tool-call source identity.
  The reviewer tracks each permission action separately.
- `session.get` and `session.context` return the session and its messages;
  message types include `user` and `compaction` ([source][v2-session-message]).
  Completed V2.0.20 compactions have top-level string fields `summary` and
  `recent`. The latter contains a raw text transcript, not another summary.
  [Context loading][v2-session-store] starts at the
  [latest completed compaction][v2-session-history]. See the
  [review scope](permission-review.md#scope) for the resulting evidence limits.
- `integration.connection.active` and `resolve` return the saved credential
  for an integration ([source][v2-integration]).
- `event.subscribe` streams host events ([source][v2-plugin-event]). The
  reviewer cancels reviews on `session.execution.interrupted`,
  `session.deleted`, `session.moved` and `session.inbox.*` events
  ([source][v2-session-event]), and stops reviewing a session after a
  `permission.replied` rejection ([source][v2-schema-permission]).
- A plugin's `setup` may return a cleanup function
  ([source][v2-plugin-cleanup]); the guard returns the reviewer's, which
  closes its event subscription and disposes its review RPC registration and
  in-memory status store.

### TUI review dependencies

The review sidebar and notifications use supported plugin contracts checked
against the [V2.1.4][v2.1.4-tag] source. No custom OpenCode build is required.

- `Host.resolve` loads `lib/tui.ts` beside the server entry
  ([source][v2-tui-host]). The TUI appends a `sidebar.content` section through
  `ctx.ui.slot` ([contract][v2-tui-context], [slot mount][v2-tui-sidebar]).
  The section mounts with the visible sidebar and may require scrolling.
  It is not part of the native permission prompt.
- The selectable `session.panel` slot opens explicitly in side or fullscreen mode
  ([contract][v2-tui-context]). This plugin uses the sidebar instead.
- The server registers `JevRpc` with ID `opencode-secret-guard.jev`.
  Its only method, `snapshot`, reads status without changing permission decisions.
  Its `review` events carry the same validated status fields
  ([RPC documentation][v2-review-rpc]). Registration does not block reviewer setup.
  Cleanup unregisters the RPC and clears the bounded 128-entry store.
  A client disconnect does not clear server state; a server restart or unload does.
- `ctx.data.listen` follows the host's reconnecting event bus for
  `rpc.opencode-secret-guard.jev.review` and `server.connected`
  ([data contract][v2-tui-context], [reconnection][v2-tui-connection]).
  The generic RPC event is typed for `data.on`; `data.listen` can receive all event types.
  The plugin does not create a direct `client.rpc(JevRpc).events.on` loop,
  because that stream does not reconnect.
- Public event locations expose `directory` only
  ([`PublicRef`][v2-public-location]). The required nullable status field
  `workspaceID` comes from the server's `ctx.location.workspaceID`.
  The TUI checks the public directory and validated payload workspace ID.
  Snapshot calls route through `client.rpc(JevRpc).snapshot` with the full
  project location, including workspace routing, and the selected session ID.
  Each call has a four-second abort deadline.
- The mounted section reads a snapshot on mounting, session changes and
  `server.connected`, without polling. Reconnection aborts pending reads and
  clears the display cache before refresh. Snapshot reconciliation prunes
  absent session review IDs and preserves newer live updates received during the read.
  A separate live-only phase history deduplicates toasts.
  Snapshots neither replay old toasts nor consume a later live completion toast.
- The sidebar shows up to four session reviews, active first and then newest.
  Every incoming `ask` produces checking and completion status, including
  skipped file, MCP and delegated-session requests. Only eligible shell-tool
  `shell` and `external_directory` checks call Jev.
  An off reviewer registers no RPC; the section remains empty until a snapshot
  succeeds or a live status arrives. The mounting probe does not start polling.
- Plain TypeScript calls Solid's `createComponent` and OpenTUI's `Dynamic`,
  without JSX compilation or a bundled UI runtime. OpenCode supplies the shared
  Solid/OpenTUI modules through OpenTUI's
  [runtime plugin configuration][opentui-runtime-configure].
  Development and typecheck dependencies pin the UI declarations separately.
- `ctx.ui.toast.show` displays each unique live phase and fixed `Next:` remedy text.
  The separate `permission.asked` listener still deduplicates decision-log and
  payload-log warnings for 10 minutes. An automatic approval has no prompt,
  so a failed log write can still lack a TUI log warning.

The source retains a permission-note fallback for missing RPC, slots or `data.listen`.
This is defensive, not a verified older-version requirement: the inspected
[V2.0.20 TUI context][v2-old-tui-context] also has these APIs. See
[sidebar behavior and limits](permission-review.md#tui-sidebar-and-notifications).

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

Headless native review-panel rendering, reactive updates and cleanup have been verified.
That evidence does not verify live OpenCode RPC or reconnection.
Question-contract tests check request shape and wording, not live Jev interpretation.

### Remaining live checks

V1 1.18.29 still needs directory loading and tool checks, including cleanup
registration and permission prompts, experimental `lsp` refusals, the shell
validation gate and wrapper-removal refusal. Source inspection establishes the
after-hook arguments and host directory contract; their behavior on the minimum
release still needs live confirmation.

V2 checks still unrecorded include a stale `lib/plugin.ts` path, a missing
configured shell, unsupported policy versions, failed-call event shape, and the interactive PTY boundary. A later rewrite
to `/bin/sh` was refused live, but the reports do not separately establish the
TUI presentation for every shell failure. Patch `*** Environment ID:` handling
also needs confirmation that it does not change the filesystem root used for
classification. The no-break-space read substitution could not be tested live
because the submitted path became a plain space; unit tests cover it. A captured
real glob/grep fixture would provide a regression check for rebuilt formatting.

The [permission reviewer](permission-review.md) has unit tests with stubbed
host APIs and System One. These tests do not validate every live combination
of host APIs, credentials, review decisions or errors.
The sidebar and notification implementation has not been deployed or checked
in a live OpenCode TUI. Live RPC routing, disconnect recovery and sidebar
presentation remain unverified. The confirmation wording has not been validated
against live Jev responses, including summary-only ask-first restrictions.

Reviewer stderr is not shown by default: the inspected V2.0.20 managed service
discards it after startup (`packages/client/src/service-contender.ts`).
A standalone server passes it through only with `--print-logs`
(`packages/cli/src/services/standalone.ts`). The V2.0.20 TUI and desktop app
do not display permission request `message` notes. The companion instead uses
the sidebar and event-driven toasts described above, with a separate
`permission.asked` listener for log warnings.

## Source versions

Hook and tool contracts were read from [V2 2.0.16][v2-tag] and
[V1 1.18.33][v1-tag], with V1 1.18.29 source used for minimum-version behavior.
Plugin path loading was also checked at the `v2` branch head with
`@opencode/plugin` 2.0.19. The [V2 plugin docs][plugins] and
[migration guide][migrate] describe the public API. Live evidence above pins
the tested host to V2 2.0.20.
Review UI, event routing and reconnect contracts were checked against the
tagged V2.1.4 source. Shared UI runtime mappings were checked against OpenTUI
0.6.8. These source checks do not establish live OpenCode behavior.

[migrate]: https://opencode.ai/v2/docs/build/plugins/migrate-v1
[plugins]: https://opencode.ai/v2/docs/build/plugins
[v2-tag]: https://github.com/anomalyco/opencode/tree/v2.0.16
[v2.0.20-tag]: https://github.com/anomalyco/opencode/tree/v2.0.20
[v2.0.23-tag]: https://github.com/anomalyco/opencode/tree/v2.0.23
[v2.1.4-tag]: https://github.com/anomalyco/opencode/tree/v2.1.4
[v2-tui-host]: https://github.com/anomalyco/opencode/blob/v2.1.4/packages/plugin/src/host.ts
[v2-tui-context]: https://github.com/anomalyco/opencode/blob/v2.1.4/packages/plugin/src/tui/context.ts
[v2-old-tui-context]: https://github.com/anomalyco/opencode/blob/v2.0.20/packages/plugin/src/tui/context.ts
[v2-tui-sidebar]: https://github.com/anomalyco/opencode/blob/v2.1.4/packages/tui/src/routes/session/sidebar.tsx#L69-L75
[v2-tui-connection]: https://github.com/anomalyco/opencode/blob/v2.1.4/packages/client/src/solid/connection.ts
[v2-public-location]: https://github.com/anomalyco/opencode/blob/v2.1.4/packages/schema/src/location.ts
[v2-review-rpc]: https://opencode.ai/v2/docs/build/plugins/rpc
[opentui-runtime-configure]: https://github.com/anomalyco/opentui/blob/v0.6.8/packages/solid/scripts/runtime-plugin-support-configure.ts
[v1-tag]: https://github.com/anomalyco/opencode/tree/v1.18.33
[v2-source]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/config/plugin/source.ts
[v2-host]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/plugin/src/host.ts
[v2-normalize]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/config/normalize.ts
[v1-shared]: https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/plugin/shared.ts
[v1-index]: https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/plugin/index.ts
[v1-bash]: https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/tool/shell.ts
[v2-plugin-service]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/plugin.ts
[v2-tool]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/tool.ts
[v2-permission]: https://github.com/anomalyco/opencode/blob/v2.0.20/packages/core/src/permission.ts
[v2-plugin-tool]: https://github.com/anomalyco/opencode/blob/v2.0.20/packages/plugin/src/promise/tool.ts
[v2-plugin-shell]: https://github.com/anomalyco/opencode/blob/v2.0.20/packages/core/src/tool/plugin/shell.ts
[v2-file-access]: https://github.com/anomalyco/opencode/blob/v2.0.20/packages/core/src/file-access.ts
[v2-integration]: https://github.com/anomalyco/opencode/blob/v2.0.20/packages/plugin/src/promise/integration.ts
[v2-session-message]: https://github.com/anomalyco/opencode/blob/v2.0.20/packages/schema/src/session-message.ts
[v2-session-store]: https://github.com/anomalyco/opencode/blob/v2.0.20/packages/core/src/session/store.ts
[v2-session-history]: https://github.com/anomalyco/opencode/blob/v2.0.20/packages/core/src/session/history.ts
[v2-plugin-event]: https://github.com/anomalyco/opencode/blob/v2.0.20/packages/plugin/src/promise/event.ts
[v2-session-event]: https://github.com/anomalyco/opencode/blob/v2.0.20/packages/schema/src/session-event.ts
[v2-schema-permission]: https://github.com/anomalyco/opencode/blob/v2.0.20/packages/schema/src/permission.ts
[v2-plugin-cleanup]: https://github.com/anomalyco/opencode/blob/v2.0.20/packages/plugin/src/promise/plugin.ts
[v2-patch]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/util/src/patch.ts
[v2-glob]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/tool/plugin/glob.ts
[v2-grep]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/tool/plugin/grep.ts
[v2-select]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/shell/select.ts
[v2-shell]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/shell.ts
[v2-global]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/util/src/global.ts
[live-initial]: https://github.com/nb-99/opencode-secret-guard/pull/17#issuecomment-5910743386
[live-recheck]: https://github.com/nb-99/opencode-secret-guard/pull/17#issuecomment-5915577295
