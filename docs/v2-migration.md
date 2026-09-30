# OpenCode V2 migration plan

Status: implemented in 2.0.0. Steps 1 to 9 are done; the manual smoke test in
step 10 needs a V2 install and has not been run; its checklist is under "To
check once V2 is available". Cleanups deliberately left out are under "Deferred
cleanups".

Step 1 result: OpenCode 1.18.31 loads a configured plugin directory containing
an `index.ts` object entry point and calls its `server()`. `pluginPath`
therefore names `lib/` for both versions, and no separate `pluginDirectory`
option exists.

Deviations from the plan, found while reading the V2 source (v2.0.16):

- V2 expands a leading `~` in tool path arguments; the guard now does too, and
  resolves relative paths against the host's directory instead of the process's.
  V1 gets the same base directory from `server(input)`.
- V2 glob and grep results carry structured `output`, which the model may see as
  well as `content`, so the V2 adapter filters the structured entries and
  rebuilds the text from the survivors instead of parsing text.
- `execute.after` has no failure channel in V2, so an unrecognised search result
  is replaced by a notice and the hook never throws.
- `checkShell` was not added: both adapters call `validateShell` in
  `src/shell.ts`, which now also requires the wrapper file to exist.
- The V2 adapter does not record `execute.before` inputs by `event.id`. V2 glob
  and grep entries are relative to `location.directory`, so the result alone is
  enough, and the `event.id` row in the hook table is unused.
- `checkToolCall` takes the policy as an argument, and refuses a file tool call
  it cannot read instead of allowing it.
- V2's `read` opens a canonically equal sibling of a missing name; the guard
  classifies those siblings too. Found in review, not in the original plan.
- A patch header may hold any character but `\n`, including U+2028 and U+2029,
  so `patchPaths` slices headers instead of matching them with a regex.
- The V1 fallback to `process.cwd()` for a missing project directory is gone.
  Both adapters start without a directory and refuse relative paths and search
  results instead: a plugin that throws while loading guards no file tool.
- A path starting with `~` is classified both ways, because V2 expands it and
  V1 does not.
- V1's `lsp` tool (it takes a `filePath`) is guarded as a read tool whose path is
  optional.
- `classifyPaths` denies a path whose classification fails; before, it allowed
  it, while the before-call check refused the same call.
- V1's before-call hook repeats the wrapper-exists check on every `bash` call,
  because V1 picks its shell afresh per command.
- The README uses the `plugin` key for both versions (V2 rewrites it), not the
  `plugins` key Step 9 planned.
- V1's `filterSearchOutput` set-aside of the `Found N matches` line confirmed
  the grep gap was real: the first group was never classified.

## Goal

Release 2.0.0 of the plugin, supporting OpenCode V1 and V2 from one package and
one entry module. OpenCode V1 releases older than 1.18.29 are no longer
supported.

## Decisions

- **One entry module for both versions.** The module default-exports
  `{ id, setup, server }`. V2 calls `setup(ctx)`; V1 calls `server(input,
  options)`. This follows the dual-export shape in the
  [V2 migration guide][migrate]. V1 loads an object entry point only from
  1.18.29, so that is the new V1 minimum and the plugin version becomes 2.0.0.
- **`cleanup_temp` is V1-only.** V2 gives plugin tools no way to open a
  permission prompt for a list of paths the tool computes, and the tool must
  not delete anything without that prompt. Under V2, the plugin does not
  register the tool and says so once at startup. Tracked in
  [#16](https://github.com/nb-99/opencode-secret-guard/issues/16).
- **Two existing V1 gaps are fixed in this release** because the same code
  moves anyway:
  - Patch tools are not guarded. V1 `apply_patch` and V2 `patch` take
    `patchText`, which `FILE_TOOLS` does not handle, so the paths in a patch
    are never classified.
  - Grep output starts with a `Found N matches` line. `filterSearchOutput`
    splits groups on blank lines, so the first file group may share a chunk
    with that line and never be classified. A test decides whether this is
    real before the fix.
- **No dependency on `@opencode/plugin`.** `Plugin.define` is an identity
  function, and the V2 loader accepts any default export with a string `id`
  and a `setup` function. The plugin keeps using small local types and checks
  every hook payload at runtime. The reason is the one `src/index.ts` gives
  for avoiding `@opencode-ai/plugin`: a hermetic typecheck would have to
  vendor its dependency tree.

## Findings

Sources: V2 source at tag [`v2.0.16`][v2-tag] and the head of the `v2` branch
(`@opencode/plugin` 2.0.19, used only for how the plugin path is loaded; every
hook and tool shape below is from 2.0.16), V1 source at [`v1.18.33`][v1-tag], the
[V2 plugin docs][plugins] and the [migration guide][migrate]. V2 changes
quickly; recheck anything marked unverified before relying on it.

### Loading

- V2 skips a configured plugin path that is a file, logging "configured plugin
  path must be a directory" ([source][v2-source]). This applies to
  `file:///…/lib/plugin.ts`, the path Home Manager wired before 2.0.0. A configured
  directory resolves `server` and then `index` inside it
  ([`Host.resolve`][v2-host]), so the V2 entry must be `lib/index.ts` and the
  configured target `lib/`.
- V2 rewrites a V1 `plugin` config key to `plugins` when it loads the config
  ([normalizer][v2-normalize]). Existing configs keep loading.
- V1.18.33 treats a default-exported object with `id`, `server` or `tui` as an
  object entry point, calls `server(input, options)`, ignores other keys, and
  does not scan named exports afterwards ([`readV1Plugin`][v1-shared],
  [`applyPlugin`][v1-index]).
- Verified in step 1: V1 1.18.31 loads a configured directory.

### Failure semantics

- Both versions catch an error from plugin setup, log it, and continue without
  the plugin ([V2][v2-plugin-service], [V1][v1-index]). V1 also only logs an
  error from the `config` hook. A startup check therefore cannot stop
  OpenCode from starting; only a check at the point of use can refuse work.

### Hooks

| Purpose                 | V1                                          | V2                                                             |
| ----------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| Check the shell         | `config` hook reads `config.shell`          | `ctx.shell.hook("create.before")` reads `event.shell`          |
| Block a tool call       | `tool.execute.before(input, output)`        | `ctx.tool.hook("execute.before")`, `event.tool`, `event.input` |
| Correlate before/after  | `input.callID`                              | `event.id`                                                     |
| Filter glob/grep output | rewrite the `output.output` string          | rewrite `event.result.output` and `event.result.content`       |
| Register a tool         | returned `tool` map, `context.ask`          | `ctx.tool.transform(editor => editor.add(...))`, no `ask`      |
| Working directory       | `directory` argument of `server()`          | `ctx.location.directory`                                       |

- V2's `execute.before` runs for built-in, plugin and MCP tools, including in
  subagent sessions at the same location, and runs before the permission
  checks inside each tool's executor ([source][v2-tool]).
- V2's `create.before` event is
  `{ command, cwd, timeout, shell, env }`. Throwing from it stops the spawn.
  Unverified: how the V2 TUI displays an error thrown from a hook.

### Tools and arguments

| Tool                 | V1 (1.18.33)                         | V2                                           |
| -------------------- | ------------------------------------ | -------------------------------------------- |
| Shell                | `bash`, `command`                    | `shell`, `command`                           |
| Read (also listings) | `read`, `filePath`                   | `read`, `path`                               |
| Write                | `write`, `filePath`                  | `write`, `path`                              |
| Edit                 | `edit`, `filePath`                   | `edit`, `path`                               |
| Patch                | `apply_patch`, `patchText`           | `patch`, `patchText`                         |
| Glob                 | `glob`, `pattern`, `path`            | `glob`, `pattern`, `path`                    |
| Grep                 | `grep`, `pattern`, `path`, `include` | `grep`, `pattern`, `path`, `include`, others |

- Neither version has a `list` tool; `read` on a directory lists it.
- V2's browser plugin reads local files in `browser_files_upload` and
  `browser_files_drop` (`paths`, an array) and `browser_preview` (`path`). It
  opens them with plain `fs.open` in the unsandboxed server, and its `browser`
  permission only hides the tools when wholly denied, so `external_directory`
  rules do not apply. An upload followed by `browser.evaluate` returns the
  file's bytes to the model, so the guard checks all three tools as reads.
- Patch headers are `*** Add File: <path>`, `*** Update File: <path>`,
  `*** Delete File: <path>` and `*** Move to: <path>`, inside
  `*** Begin Patch` and `*** End Patch` ([parser][v2-patch]).
- V2 glob returns `output` as an array of `{ path, type }` entries and
  `content` as their absolute paths joined by newlines, plus a truncation note.
  Grep returns `output` as an array of matches with `entry.path`, `line` and
  `text`, and `content` as `Found N matches`, then one block per file:
  `<path>:` followed by `  Line <n>: <text>` lines. `metadata` carries the
  counts ([glob][v2-glob], [grep][v2-grep]).

### Shell

- The V2 `shell` config key still exists. The shell tool resolves it with
  `priority: "compat"`. That rejects only `fish` and `nu` by name, so the
  wrapper's name is accepted. It spawns `[shell, "-c", command]` with the
  command text unchanged, the same argv the wrapper requires
  ([select][v2-select], [spawn][v2-shell]).
- If the configured path does not resolve to a file, V2 silently falls back to
  the platform default shell. The `create.before` check closes this: it throws
  whenever `event.shell` is not this package's wrapper.
- V2's interactive terminal uses a separate PTY service that does not trigger
  `create.before` and is not a model tool. It is not guarded, as in V1.

### Protected paths

- V2 keeps config in `~/.config/opencode`, cache in `~/.cache/opencode` (npm
  plugin cache at `<cache>/npm`, helper binaries at `<cache>/bin`), data in
  `~/.local/share/opencode`, and local plugins in `.opencode/plugin/` and
  `.opencode/plugins/` ([paths][v2-global]). `tamperTargets` already protects
  all of these. V2 installs package plugins with npm's Arborist and
  `ignoreScripts: true`, not `bun install`. The `package.json` rules stay,
  because V1 still runs `bun install`.

## Steps

Kept as planned; see Status and Deviations above for what changed. Each step
leaves the checks passing.

1. **Test directory loading in V1.** Point OpenCode 1.18.31 at a directory
   containing an `index.ts` object entry point.
   - If it loads, Home Manager's `pluginPath` becomes
     `file://${package}/lib` for both versions.
   - If it does not, `pluginPath` stays a file for V1 and a new read-only
     `pluginDirectory` option serves V2. The README states which to use.
2. **Separate policy from the host API.** Move the version-independent logic
   out of `src/hooks.ts` into `src/guard.ts`:
   - `checkToolCall(tool, input, baseDirectory)`: secret-printing refusal for
     `bash` and `shell`, path classification for file tools.
   - `checkShell(shell)`: the existing `validateShell` comparison.
   - Glob/grep filtering over plain path lists, so both versions share one
     classifier call.

   Relative paths resolve against a base directory passed in by each adapter,
   not against `process.cwd()`.
3. **Fix the two gaps.** Add patch parsing that returns every path named by an
   `Add`, `Update`, `Delete` or `Move to` header, and classify each as a write.
   Add a grep test with a leading `Found N matches` line; fix the grouping if
   it fails.
4. **V1 adapter, `src/v1.ts`.** The current `createHooks`, calling
   `src/guard.ts`, with the `directory` argument of `server()` as the base
   directory. It keeps the
   `config` shell check and `cleanup_temp`.
5. **V2 adapter, `src/v2.ts`.** `setup(ctx)` does the following:
   - Validates the platform, and in `files-only` mode prints the existing
     warning.
   - Registers `ctx.shell.hook("create.before")`. In `shell+files` mode it
     throws unless `event.shell` resolves to this package's wrapper.
   - Registers `ctx.tool.hook("execute.before")` with the file and refusal
     checks, and records glob/grep inputs by `event.id`.
   - Registers `ctx.tool.hook("execute.after")` for glob and grep. On
     `status: "completed"` it filters `result.output`, rebuilds
     `result.content` in the format above and updates `result.metadata`
     counts. A result whose shape it does not recognise is withheld, not
     passed through.
   - Writes one line to stderr that `cleanup_temp` is unavailable under V2
     when `cleanupRoot` is set, naming issue #16.

   Every event field is checked once where it enters the adapter.
6. **Entry point.** Replace `src/plugin.ts` with `src/index.ts`:
   `export default { id: "opencode-secret-guard", setup, server }`, with the
   comment from `src/plugin.ts` updated.
7. **Tests.**
   - Point the existing hook tests in `tests/predicate.test.ts` and
     `tests/tamper.test.ts` at the V1 adapter, and `tests/cleanup.integration.ts`
     at its new import.
   - Add `tests/v2.test.ts` with a fake context that records registrations
     and replays events: blocked reads and writes, patch paths, shell tool
     refusals, wrong and missing shells, structured glob/grep filtering, and
     malformed payloads.
   - Add the patch and grep tests from step 3 for both adapters.
   - Add the new test files to `package.json`, `AGENTS.md` and
     `nix/checks.nix`.
8. **Nix.** The layout check tests `lib/index.ts` and imports it to confirm
   the default export has a string `id` and functions `setup` and `server`.
   Update `pluginPath` in `nix/hm-module.nix` according to step 1.
9. **Documentation and version.**
   - README: requirements (V1 1.18.29 or newer, or V2), `plugin` config
     snippets that serve both versions (V2 rewrites the key), and a `cleanup_temp` section that states
     clearly it is V1-only, why, and links #16. Add the V2 terminal and hook
     ordering points to Limitations.
   - `docs/design.md`: update the package layout and the plugin entry point
     and hook sections.
   - Bump `package.json` to 2.0.0.
10. **Verify.**
    - `nix flake check -L`.
    - `nix run .#integration` from a plain terminal.
    - Manual smoke test on OpenCode 1.18.31 and on V2: the plugin appears as
      active; reading `.env` is refused; glob and grep results omit secret
      files; a wrong or missing `shell` refuses commands; `cleanup_temp` is
      listed under V1 only.

## Risks

- **Hook order.** A plugin whose hook runs after this one can still change
  `event.input` or `event.shell`. V1 has the same exposure; neither version
  offers ordering control.
- **Error display.** How V2 shows an error thrown from `execute.before` or
  `create.before` is unverified. The smoke test covers it.
- **API drift.** The V2 findings come from 2.0.16 and the `v2` branch head.
  Pin the version the smoke test used in the README. The checklist under "To
  check once V2 is available" is that smoke test.

## Deferred cleanups

Judged as taste during review and left out of 2.0.0. None changes behaviour or
weakens a check. Do them together in a follow-up if the code is touched again.

- **Share the tool-name normalisation.** `String(tool ?? "").toLowerCase()`
  appears in `guard.ts`, `v1.ts` and `v2.ts`, and the glob/grep test in three
  places. Export `toolName()` and `isSearchTool()` from `guard.ts`.
- **Remove V1's `searchArgs` map.** It is inherited from `hooks.ts`. It can go
  if V1's `tool.execute.after` input always carries `args` in 1.18.29 and
  later; that is unverified. It also leaks one entry per glob or grep call that
  throws, since only the after-hook deletes.
- **Move V1's text parser into `v1.ts`.** `filterSearchOutput`, `resultPath` and
  `GREP_SUMMARY` in `predicate.ts` parse V1's output format and have one
  production caller. Moving them, and their tests, makes dropping V1 a local
  change and leaves `predicate.ts` as the classifier. It also removes a stale
  `// Profile cache` heading above them.
- **Simplify `filterSearchResult` in `v2.ts`.** Branch on the tool once so the
  `as Entry` and `as Match` casts go, resolve each path once instead of again in
  `globContent` and `grepContent`, and add the truncation note in one place.
- **One route to the withheld notice.** Let `filterSearchResult` throw on an
  unrecognised shape so the `catch` is the only route, dropping the `| null`
  return. Keep the two distinct notices and the stderr line.
- **Drop the `MaybePromise` alias** in `v2.ts`; `unknown` is as strict for a
  host that ignores the return value.
- **`any` to `unknown` in `v1.ts`.** `checkToolCall` already takes `unknown`.
  Use `input?.callID` consistently.
- **Batch patch-path classification.** `checkToolCall` classifies each patch path
  on its own, which can spawn one `git check-ignore` per file (about 11 ms
  each) and rebuilds the tamper-protected set each time. Call
  `primeIgnoreCache` once per patch, as `classifyPaths` does. Measure first: a
  typical patch names one to five files.
- **Test tidying.** Rename the `v1` helper in `tests/tamper.test.ts` and
  `tests/predicate.test.ts` to `v1Hooks`. Type the `ToolAfter` shape in
  `tests/v2.test.ts` from an export instead of repeating it.
- **Smaller comments.** Delete the two-line aside in `v1.ts` above the
  files-only warning, and shorten the provenance sentence in the `v2.ts` header.
- **Pin the rebuilt text against real V2 output.** `globContent` and
  `grepContent` copy V2's formatting. One test that compares against a captured
  real result would catch a format change.
- **Not recommended:** having each adapter translate its host's tool names into
  fixed kinds before calling `guard.ts`. It would let dropping V1 skip `guard.ts`
  entirely, at the price of a translation layer; the union of names costs one
  line to prune.

## To check once V2 is available

The V2 adapter has been tested only against a fake host built from the 2.0.16
source. Run these on a live V2, then update the README's "not yet run against a
live V2" sentence and pin the version tested. Repeat the V1 items on 1.18.29,
the minimum, as well as a current release.

**Loading and failure**
- The plugin, configured as `plugin: ["file:///…/lib"]`, shows as active, and the
  `plugin` key is rewritten to `plugins` as the normaliser suggests.
- A broken policy (invalid JSON, wrong `configVersion`) makes `setup` throw. Note
  whether V2 logs it visibly, and confirm it then runs without the plugin; the
  README says it does. *2.0.20: only a `WARN failed to load plugin` log line,
  and the file tools ran unguarded while the wrapper refused commands. The
  plugin now catches the failure and refuses shell and file tools instead;
  re-check that the refusal reaches the model.*
- A stale `lib/plugin.ts` path from 1.x logs an error and loads nothing.
- Whether the `files-only` warning and the `cleanup_temp` notice on stderr
  reach the user in the TUI. If not, move them to a channel that does.

**Hook behaviour**
- An error thrown from `execute.before` stops the tool, and the model sees the
  `secret-guard: …` message. Same for `create.before`: note how the TUI shows it.
- Assigning `event.result` in `execute.after` is what the model receives, for
  both the filtered result and the withheld notices.
- A `status: "error"` event carries `error` and no `result`, as read from the
  source.
- Hook order: register a second plugin whose hook changes `event.input` or
  `event.shell` after this one, and confirm the exposure the README documents.

**Directory and paths**
- `ctx.location.directory` equals the directory the tools resolve relative paths
  against. Check two sessions in different worktrees or project directories
  served by one plugin instance; if they differ, resolve from the event instead.
- A relative path, a `~/…` path and a path with `..` are refused or allowed as the
  policy says, and `~/…` is the home directory's file.
- V2's `read` of a misspelled name (no-break space, curly quote) does not reach an
  ignored file, and the "file not found" suggestions and directory listings show
  what the README says about names.
- A patch with a leading `*** Environment ID:` line: does an environment map to a
  different filesystem root? If so, host-path classification does not apply.
- Whether any V2 tool other than `read write edit patch glob grep shell` opens
  workspace files, and whether Code Mode's inner calls reach `execute.before`
  with the inner tool's name.

**Search results**
- A real glob and grep result matches what `globContent` and `grepContent`
  rebuild: header line, blank line between files, truncation note, `metadata`.
  Capture one as a test fixture (see Deferred cleanups).
- Secret files, ignored files and symlinks to secrets are absent from `output`
  and `content` both, including on truncated results.

**Shell**
- `shell` set to the wrapper works, and a missing or wrong path is refused by
  `create.before` rather than running in V2's fallback shell.
- The interactive terminal (PTY) is unguarded, as documented.

**V1**
- 1.18.29 loads the directory and calls `server()`; `cleanup_temp` still
  registers and prompts.
- `tool.execute.after` input carries `args` (decides the `searchArgs` cleanup).
- `server()` input always carries an absolute `directory`.
- With the experimental LSP tool enabled, `lsp` on a secret file is refused.
- The wrapper-exists recheck stops a `bash` call after the wrapper is removed.

[migrate]: https://opencode.ai/v2/docs/build/plugins/migrate-v1
[plugins]: https://opencode.ai/v2/docs/build/plugins
[v2-tag]: https://github.com/anomalyco/opencode/tree/v2.0.16
[v1-tag]: https://github.com/anomalyco/opencode/tree/v1.18.33
[v2-source]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/config/plugin/source.ts
[v2-host]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/plugin/src/host.ts
[v2-normalize]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/config/normalize.ts
[v1-shared]: https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/plugin/shared.ts
[v1-index]: https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/plugin/index.ts
[v2-plugin-service]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/plugin.ts
[v2-tool]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/tool.ts
[v2-patch]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/util/src/patch.ts
[v2-glob]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/tool/plugin/glob.ts
[v2-grep]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/tool/plugin/grep.ts
[v2-select]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/shell/select.ts
[v2-shell]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/shell.ts
[v2-global]: https://github.com/anomalyco/opencode/blob/v2.0.16/packages/util/src/global.ts
