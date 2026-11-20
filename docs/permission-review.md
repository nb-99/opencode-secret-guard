# Optional permission review

Status: approval-only. Off by default.

The secret guard decides deterministically what a command or file tool may
touch. Permission review is a separate, optional step: when OpenCode V2 is
about to show you an `ask` prompt, the plugin can send that one request to a
model and approve it automatically. The default model is Jev (TypeSafe System
One). You can also choose a decision or chat model through OpenCode, or an
OpenAI-compatible endpoint; see [Backends](#backends). The model answers six narrow questions, and code
combines the answers (see [How a request is approved](#how-a-request-is-approved)).
Anything else still reaches you as a normal prompt.

## What it does and does not do

- It only sees requests that OpenCode would already ask you about. A rule
  you configured as `deny` in OpenCode never reaches it.
- It cannot override the guard's deterministic refusals or relax the kernel
  sandbox. It can see a shell command that the sandbox later restricts, such
  as `cat .env`; approving the prompt does not mean the command will run
  successfully.
- An approval changes only the current evaluation from `ask` to `allow`. The
  reviewer never answers "always" and never writes a persistent permission
  rule.
- It never denies. Every other outcome leaves the normal prompt.
- In `auto` it applies to every in-scope `ask`, including rules you set to
  `ask` explicitly. There is no per-rule exclusion. A deterministic deny is
  still final.
- In both `observe` and `auto`, the prompt waits for the review, up to the
  backend's deadline: 10 seconds for `jev`, or `deadlineMs` for `opencode` and `endpoint`. `observe` is synchronous on purpose.
- It requires OpenCode V2.0.20 or later. The `opencode` backend requires
  2.2.5 or later; its `text` API was checked against 2.2.6 ([Backends](#backends)). The V2 plugin and credential
  contracts it relies on were checked against the 2.0.20 and 2.0.23 source
  ([details](v2-migration.md#permission-review-dependencies)). The TUI contracts
  described below were checked against the V2.1.4 source.
  If a required permission, session, integration or event API is missing,
  the reviewer prints a notice and leaves prompts in place.
  It also stops reviewing if its server event stream ends.
- On OpenCode V1 an enabled reviewer prints a startup notice that it is only
  available on V2. Prompts are unchanged and the guard works as before.
- Evidence of your intent comes from user-role messages in the session, or in
  the root session of a subagent session.
  Not all of that text is typed by you: slash-command templates, shell output
  interpolated into a template (for example a pull-request diff), MCP prompts
  and API clients can all produce user-role messages. OpenCode stores no
  authenticated provenance for them, and the reviewer cannot reliably tell
  them apart, so it trusts the commands, MCP servers, clients and plugins you
  run. The model is told that consent claimed inside quoted material is not
  yours, which reduces but does not remove this risk.
- Both `observe` and `auto` review compacted sessions, forks, subagent
  sessions, sessions with attachments, skills or earlier refusals, and
  outside-project shell work, with context warnings. See [Evidence](#evidence).
- On V2, a shell call runs in this order: `tool` `execute.before` sees the
  original tool input; `shell` `create.before` plugins may then rewrite the
  command or working directory; the built-in shell tool parses the result
  and asks for permission, which triggers `permission` `evaluate` with the
  parsed resources only; the command is spawned after approval. The
  reviewer therefore sees resources derived from any rewrite, but judges
  them alongside the original tool command and the working directory it was
  meant to run in. The permission request does not carry the final command
  or working directory, so the reviewer does not verify them, and nothing it
  does detects every rewrite. It trusts the shell-rewriting plugins you run.
  A tool input that changes during review still makes the approval void.

## Configuration

`permissionReview` requires `configVersion` 5 or later. The `api` keys and
`opencode.deadlineMs` require `configVersion` 6, `toasts` requires
`configVersion` 7, and `restrictionScreen` and `maxRequestBytes` require
`configVersion` 8. Its keys are `mode`, `logPayloads`, `confidenceThreshold`,
`backend`, `toasts`, `restrictionScreen`, `opencode` and `endpoint`;
each is optional. `backend` defaults to `jev`. Without `permissionReview` the
mode is `off`. An invalid `permissionReview` is
a policy validation error, so the guard refuses to start as for any invalid
policy. Problems at runtime, such as a missing host API, no credential, or a
failed call, only leave the normal prompt.

```json
{
  "configVersion": 8,
  "permissionReview": {
    "mode": "observe",
    "logPayloads": false,
    "confidenceThreshold": 0.9
  }
}
```

This fragment shows only the relevant keys; merge it into your existing policy.

| Key                   | Default | Values                                                                  |
| --------------------- | ------- | ----------------------------------------------------------------------- |
| `mode`                | `off`   | `off`, `observe` or `auto`; see below.                                  |
| `logPayloads`         | `false` | `true` also writes every request and response body to the [payload log](#payload-log). |
| `confidenceThreshold` | `0.9`   | A number above 0.5 and at most 1; see [How a request is approved](#how-a-request-is-approved). |
| `backend`             | `jev`   | `jev`, `opencode` or `endpoint`; see [Backends](#backends).             |
| `toasts`              | `all`   | `all` or `attention`; see [Live phase notifications](#live-phase-notifications). |
| `restrictionScreen`   | `true`  | `false` turns off the [restriction screen](#restriction-screen).        |
| `opencode`            | none    | `{ "model", "api", "deadlineMs", "maxRequestBytes" }`. `model` is `provider/model` with an optional `#variant`. `api` is `decisions` (default, a decision model) or `text` (a chat model). `deadlineMs` defaults to 10000. Required with `backend` `opencode`, an error otherwise. |
| `endpoint`            | none    | `{ "baseURL", "model", "apiKeyFile", "deadlineMs", "api", "maxRequestBytes" }`. `api` is `text` (default, `/chat/completions`), `decisions` (`/decisions`) or `systemone` (`/systemone`). Required with `backend` `endpoint`, an error otherwise. |

`maxRequestBytes` is `null` (the default) or a whole number from 32000 to
360000. It sets the largest review request; see [Request size](#request-size).

Values are not coerced: `"true"` or `"0.9"` is a validation error. The guard
reads the policy at startup, so restart OpenCode after a change.

| `mode`    | Behavior                                                                          |
| --------- | --------------------------------------------------------------------------------- |
| `off`     | Default. The reviewer is not set up and sends no model traffic.                   |
| `observe` | Each `ask` is logged and noted; eligible `shell`-tool asks (`shell` and `external_directory`) are sent to the review model. You still decide. |
| `auto`    | A request that meets every approval condition is allowed once; otherwise asked.   |

When review leaves a prompt in place, in `observe` and in `auto`, the
reviewer appends one line to the permission request's message, after any
message already there:
`secret-guard review: would allow (<reason>)` (`observe` only) or
`secret-guard review: manual approval (<reason>)`, followed by a remedy for
reasons you can act on, such as a missing OpenCode Zen connection. An
approval in `auto` adds no message. Negative model judgments in `observe`
also carry the score suffix described below.

OpenCode V2.0.20 carries this message on the permission request, but neither
its TUI ([prompt](https://github.com/anomalyco/opencode/blob/84c9be93a56304a108f1a22df0c5d62c26d5b6ca/packages/tui/src/routes/session/permission.tsx),
[footer](https://github.com/anomalyco/opencode/blob/84c9be93a56304a108f1a22df0c5d62c26d5b6ca/packages/tui/src/mini/footer.permission.tsx)) nor its desktop app
([dock](https://github.com/anomalyco/opencode/blob/84c9be93a56304a108f1a22df0c5d62c26d5b6ca/packages/app/src/session/requests/session-permission-dock.tsx))
displays a request's message, so the note does not appear on the prompt
itself. The note is a text convention, not an authenticated claim: another
plugin you run could write the same text.

### TUI sidebar and notifications

The package contains a TUI plugin, `lib/tui.ts`, loaded from the same plugin
directory as the server plugin. No custom OpenCode build is required.
The plugin appends its section to the supported `sidebar.content` slot.
The section mounts with the session sidebar; you may need to scroll to see it.
It is plugin UI, not a slot inside the native permission prompt.
Hiding the sidebar hides the section, but does not stop reviews or notifications.

The section summarizes the current project-scoped session since the server started:

```text
GUARD REVIEW  11 reviews · auto · ≥90%
7 approved · 2 manual · 2 skipped
Skips: context-rejected-turn 1, session-rejected 1

Authorization ━━━━━━━━━━  96%  8/9
Within scope  ━━━━━━━━━━  95%  9/9
Confirmation  ━─────────   7%  8/9
Sensitive     ──────────   4%  8/9
Remote        ━━────────  22%  9/9

Latest – shell · skipped · 14:04
  context-rejected-turn
```

- The header shows the number of completed reviews, the mode and the threshold once.
- The next line counts completed reviews by outcome and omits outcomes with no reviews:
  - `approved` (`would approve` in `observe`): the model passed every check, and the reason is `model-approved`.
  - `manual`: the model scored the request, but approval did not apply. This includes
    negative judgments and passing judgments cancelled by a context change.
  - `skipped`: the reviewer did not call the model, for example `context-rejected-turn`.
  - `failed`: the model was called but returned no valid judgment.
- `Skips` names the three most frequent skip reasons, when there are skips.
- Each check row shows the average score over scored reviews and how many of
  them passed that check at their own threshold. The bar and the percentage are
  green when every scored review passed. Otherwise, they are amber.
  The `Remote` row averages the remote-effect score; a review passes it when
  that score is low enough or when you named the action (see [How a request is approved](#how-a-request-is-approved)).
  Skipped and failed reviews have no scores, so they do not affect the rows.
- `Latest` shows the newest review in progress, otherwise the newest completed review.
  It also shows the reason when it is not `model-approved`, a `Next:` remedy and context warnings.

The session totals behind the section also count eligible asks, approvals
that code cancelled (`invalidated`), restriction screen runs and skips by
reason (at most 12 reasons; the rest count as `other`).

Colours come from the host theme's text and feedback colours.
Every incoming `ask` gets checking and completion status, including skipped
edit, read and MCP requests. Only eligible `shell` and
`external_directory` checks from the shell tool reach the model.

OpenCode also offers the selectable `session.panel` slot, opened explicitly in
side or fullscreen mode. This plugin uses the sidebar instead.
These contracts were checked against the tagged V2.1.4 source:
[slot and panel contracts](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/plugin/src/tui/context.ts#L165-L225),
the [sidebar content slot mount](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/tui/src/routes/session/sidebar.tsx#L69-L75),
and the [TUI plugin documentation](https://opencode.ai/v2/docs/build/plugins/cli).

The panel uses plain TypeScript and `Dynamic`, without a JSX build step.
OpenCode supplies the shared Solid/OpenTUI runtime through OpenTUI's
[runtime plugin configuration](https://github.com/anomalyco/opentui/blob/v0.6.8/packages/solid/scripts/runtime-plugin-support-configure.ts).
The plugin does not bundle a separate UI runtime.

#### Live phase notifications

With `toasts` `all`, the default, every unique live phase update produces a
toast, in both `auto` and `observe`:

| Phase | Meaning | Toast |
| ----- | ------- | ----- |
| `checking` | Review started; eligibility checks run before a model call. | Informational. |
| `evaluating` | The reviewer starts the model request. Skipped reviews do not reach this phase. | Informational. |
| `completed` | Review ended, including approvals, negative judgments, skipped requests and failures. | Success for applied `allow`; warning otherwise. |

Duplicate or older live phase updates do not produce another toast.
Automatic approvals and negative `auto` judgments therefore have notifications,
even when no permission prompt appears. The reviewer emits completion status
for skipped and failed reviews too.

With `toasts` `attention`, only a completed review that needs you produces a
toast. That is a review that did not end in `allow` and either called the model
(a judgment or a failed call) or has a reason with a `Next:` remedy. Progress,
automatic approvals and skips without a remedy, such as an unsupported action,
produce no toast. The sidebar still shows each of them. This follows Codex's
automatic approval review, which shows progress in its status line and
reports approvals silently. Every status carries the setting, so the TUI
applies it without reading the policy.

When the model returns a valid judgment, the phase toast shows one row per
check. Each row shows its threshold, comparison direction and pass/fail result:

- Authorization and scope must each be at least `confidenceThreshold`.
- Confirmation and sensitive effect must each be at most `1 - confidenceThreshold`.
- Remote effect must be at most `1 - confidenceThreshold`, or the
  named-by-user score must be at least `confidenceThreshold`. The row shows
  both scores, for example `Remote effect: 96%, named 94% (≤10% or named ≥90%; pass)`.

At the default threshold, these limits are ≥ 90% and ≤ 10%, respectively.
The display does not replace the [per-answer approval rules](#how-a-request-is-approved).
It does not invent missing scores. It shows `not evaluated` before a model call,
`pending` during evaluation, and `unavailable` after a call without a valid judgment.

With the `text` API, the model also writes a short `summary` of what the action
does and a `rationale` for why it should or should not run without asking you.
When both are present, the completion toast shows them as `Does:` and `Why:`
lines, right after the mode line. They replace the score rows and the
`Proposed`/`Applied` line, because the heading already states the outcome.
A `Reason:` line remains only when code overruled the model's verdict, for
example `context-changed` or `deadline`; `model-*` reasons are left out:

```text
Manual approval required
Auto mode · shell
Does: Force-pushes local main to origin.
Why: You asked to confirm before any push.
```

This follows Codex's automatic approval review, which shows the verdict and one
concise rationale sentence.

The explanation is display-only. Code still decides from the six scores, and
the sidebar and decision log still use them. The text is the model's own claim
and is not verified. The plugin flattens it to one line, replaces control,
format, private-use and unassigned characters with spaces, and cuts it with `…`
at 100 characters for the summary and 140 for the rationale. These limits keep
plain text within a few lines of OpenCode's 60-column toast; wide characters
take more space.
An explanation that is missing, blank, not text or credential-like is dropped,
and the toast shows the score rows. Other APIs return no explanation.
With the `text` API, every status also carries `explains: true`. Its toasts
then omit the `Scores: not evaluated`, `pending` and `unavailable` lines;
the heading already says whether the review is pending, skipped or failed.

`proposed` records the model's verdict when it returns a valid judgment; otherwise it is `ask`.
`applied` records the permission effect at the reviewer's hook exit.
It does not prove that a command ran or that later hooks kept that effect.
If context changes after a passing judgment, the review keeps all six scores
and proposed `allow`, but applies `ask` with the invalidation reason.
In `observe`, even a valid proposed `allow` leaves manual approval in place.
For reasons with a remedy, the sidebar's latest review and the toast also show a `Next:` line.
`guidanceFor` selects fixed, safe text from a validated reason code.
It covers credential problems, timeouts and `events-unavailable`.

#### Reconnection and privacy

The server keeps a bounded, in-memory store of 128 review statuses.
It also keeps running totals for up to 128 sessions, which it updates once per completed review.
The totals do not depend on the status store, so evicted statuses still count.
Its read-only `JevRpc` definition has ID `opencode-secret-guard.jev`, a `snapshot`
method, `review` events and `summary` events. Each session snapshot contains at
most four reviews and, after the first completed review, the session totals.
Totals contain only counts, averages, skip reason codes, the mode and the threshold.
See the [plugin RPC documentation](https://opencode.ai/v2/docs/build/plugins/rpc).

This state survives a TUI client disconnect, not a server restart or plugin unload.
The TUI uses `ctx.data.listen` on the host's reconnecting event bus for
`rpc.opencode-secret-guard.jev.review`, `rpc.opencode-secret-guard.jev.summary` and `server.connected`.
It does not start a direct `client.rpc(JevRpc).events.on` loop, which does not reconnect.
The generic RPC event is typed for `data.on`, but `data.listen` supports listening
to all event types on that bus.

The mounted section refreshes on mounting, session changes and `server.connected`.
There is no periodic polling. Reconnection clears the display cache and aborts
pending snapshot calls before requesting fresh state.
`client.rpc(JevRpc).snapshot` uses the selected session ID and full project location,
including workspace routing. Each request has a four-second abort deadline.
Unloading the plugin also cancels pending requests.

Each snapshot replaces the retained session result and removes absent cached review IDs.
The client preserves newer live updates received while the snapshot request runs.
Totals only grow during one server run, so the client keeps the totals with the larger review count.
Snapshots restore the display without replaying toasts.
Separate live-only notification history prevents duplicate phase toasts.
A snapshot cannot consume a subsequent live completion notification.

The public event location contains only `directory`, not `workspaceID`.
Each status payload therefore requires a nullable `workspaceID`, supplied from
the server's `ctx.location.workspaceID`. The client validates the payload before
matching its workspace ID and the public event directory to the current location.
Snapshot results must match the selected session and current workspace too.
See the tagged [public location schema](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/schema/src/location.ts)
and [reconnecting client connection](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/client/src/solid/connection.ts).

With review `off`, the server registers no review RPC, and snapshots fail with `rpc.unavailable`.
The sidebar probes once on mounting, without polling.
Its contribution stays empty while that probe is pending, and when it fails with
`rpc.unavailable` and no cached status exists. An off reviewer therefore produces no panel.
Other failures show `Status unavailable (<code>)` with a fixed code, such as
`rpc.invalid_input`, `timeout` or `invalid-response`. The panel never shows host error text.

The RPC schemas contain no JSON Schema `pattern` keyword. OpenCode 2.2.5 builds RPC
validators with Effect 4.0.6, which refuses patterns. That failure returned
`rpc.invalid_input` (HTTP 400) for every snapshot and prevented live status events.
Both ends apply the identifier, action, reason and explanation character rules in
`parseReviewStatus` instead.

Decision logs never contain commands, paths, resources, user messages,
keys, host error text or model response bodies. They use identifiers, fixed codes,
validated scores and context-warning flags. Status follows the same rule, with
one exception: the `text` API's bounded `explanation`. That model-written text
can repeat parts of the command or its paths. It stays in the server's memory,
the RPC events and snapshots, and the toast; it is never written to the decision log.
With `logPayloads: true`, the payload log also keeps it as part of the response body.
Neither display recovery nor raw score
logging requires `logPayloads: true` or reads the private payload log.

#### Defensive fallback and log warnings

The plugin retains a defensive fallback if RPC, slots or `data.listen` are missing.
This is an API check, not a version cutoff. The inspected
[V2.0.20 TUI context](https://github.com/anomalyco/opencode/blob/v2.0.20/packages/plugin/src/tui/context.ts)
also has these APIs; no supported host was verified to need this fallback.
That fallback listens to `permission.asked`; automatic approvals have no prompt
and no fallback notification. It has no persistent review section or snapshot recovery.
With review `off`, the reviewer emits no status or notes. Another trusted plugin
can still write matching notes, because the note format is not authenticated.

The fallback shows proposed approvals in `observe` once per request.
It reads no status, so it ignores the `toasts` setting.
For negative `observe` judgments, it names the first failed check and displays
the weakest score and threshold. The score is
`min(explicitly_authorized, within_scope, 1 - confirmation_required, 1 - sensitive_effect, max(1 - remote_effect, named_by_user))`.
It may describe a different answer than the first failed check.
The note carries unrounded values, for example `; observe score=0.72 threshold=0.9`.
Negative `auto` judgments have no scored fallback toast.

Fallback credential/remedy warnings use fixed text, at most once per reason every
10 minutes. See [Credential reasons](#credential-reasons). Remedies also cover
timeouts and `events-unavailable`; other fallback reasons remain silent.
These notices follow `permission.asked`, not snapshot recovery.

Decision-log and payload-log warnings remain separate from review phase toasts.
The `permission.asked` listener deduplicates each warning for 10 minutes.
The prompt carries `secret-guard log: unavailable` or
`secret-guard log: payloads unavailable` while the latest corresponding write failed.
Each note clears after a successful write. An automatic approval can fail to
write its log without a prompt, so it may produce no TUI log warning.
Review status notifications do not close that warning gap.

Startup and unavailability notices go to the decision log and stderr.
After the server event stream ends, later prompts carry `events-unavailable`.
The inspected V2.0.20 desktop source offers server plugins no notification API;
these TUI slots and toasts do not add a desktop review display.

Headless native panel rendering, reactive updates and cleanup have been verified.
This does not verify live OpenCode RPC, reconnection or TUI presentation.
The sidebar and notification implementation has not been deployed or verified
in a live OpenCode TUI. The confirmation wording has not been validated against live Jev responses.

### Decision log

While review is enabled on OpenCode V2, the plugin appends one JSON object per
line to `permission-review.jsonl` in `$XDG_STATE_HOME/opencode-secret-guard/`,
or in `~/.local/state/opencode-secret-guard/` when `XDG_STATE_HOME` is unset
or not absolute. With the mode `off`, and on OpenCode V1, nothing is created.

At startup the plugin writes the path it uses to stderr, for example
`secret-guard: permission review: observe with jev-1.13-free, threshold 0.9; decision log: /Users/you/.local/state/opencode-secret-guard/permission-review.jsonl`.
OpenCode's environment can differ from your shell's; if `XDG_STATE_HOME`
differs there, that line names the path actually used. OpenCode V2.0.20 does
not show plugin stderr by default: its managed background service discards
it after startup ([source](https://github.com/anomalyco/opencode/blob/84c9be93a56304a108f1a22df0c5d62c26d5b6ca/packages/client/src/service-contender.ts#L18-L50)),
and a standalone server passes it through only with `--print-logs`
([source](https://github.com/anomalyco/opencode/blob/84c9be93a56304a108f1a22df0c5d62c26d5b6ca/packages/cli/src/services/standalone.ts#L30)). To see the
stderr lines, run `opencode --standalone --print-logs`.

Follow the log while you work, or show the latest decisions:

```sh
log="${XDG_STATE_HOME:-$HOME/.local/state}/opencode-secret-guard/permission-review.jsonl"
tail -F "$log"
tail -n 20 "$log" | jq -c '{time, mode, proposed, applied, reason, modelCalled, scores, score, threshold}'
```

Records have one of three `event` values:

- `start`: `time`, `pid`, `mode`, `backend`, `model`, `threshold`, `logPayloads`
  and `restrictionScreen`, plus `api` for `opencode` and `endpoint`. It also
  records `guardVersion` (the source revision of the installed package, or
  `null` from a checkout), `hostVersion` (the OpenCode version, when the host
  gives it) and `promptVersion` (a hash of every request format, built from the
  same fixed input, so a change to the questions or any instruction is visible).
- `review`: also `action`, `proposed` (the model's verdict from a valid judgment,
  otherwise `ask`), `applied` (the effect when the reviewer's hook returned; a later
  plugin can still change it, so this is not a record of what ran),
  `reason`, `threshold`, `promptVersion`, `eligible` (the ask passed the action
  and call checks, so its context was read), and `modelCalled` (a boolean
  recording whether the reviewer started a model request, including the
  restriction screen, not whether it succeeded).
  Valid judgments add a `scores` object with `explicitly_authorized`,
  `within_scope`, `confirmation_required`, `sensitive_effect`, `remote_effect`
  and `named_by_user`, plus the
  weakest approval-oriented `score`. These numbers are logged in both modes
  without payload logging. Skipped or failed calls without a valid judgment omit
  `scores` and `score`; they do not record invented zeroes.
  A stale passing judgment keeps its scores and proposed `allow`, with applied
  `ask` and the invalidation reason. Records also include
  `elapsedMs`, a `reviewID` that matches the payload
  log, and the `sessionID`, `messageID` and `callID` of the
  tool call. These identify the call in the session's data; the prompt does
  not display them.
  After context validation, records also include `contextCompacted` and
  `outsideProject` booleans. They identify the warnings sent to the model without
  recording paths or summary text. Exits before context validation omit both fields.
  `outsideProject` covers the requested working directory and external access
  reported by OpenCode for the shell call. Both flags can be true in either mode.
  Further optional fields:
  - `skipDetail`: for a skip because of a refusal, `{ "refusal", "position" }`.
    `refusal` is `declined`, `rejected`, `interrupted`, `unknown-aborted` or
    `live` (a reject seen while the plugin ran); `position` is `after` the latest
    user message.
  - `evidence`: the evidence paths that this review used and that earlier
    releases skipped: `compaction-recent`, `refusal-lifted`, `live-feedback`,
    `attachments`, `skills`, `agent-skill`, `credential-removed`, `cut`,
    `screen`, `fork`, `subagent` and `remote-named`.
  - `screen`: the restriction screen run, as counts: `chunks`, `cached`,
    `asked`, `selected` and `failed`.
  - `inputTokens` and `outputTokens`, when the backend reports them.
- `unavailable`: a fixed `notice` text.

V2 evaluates a pending request again after an "always" reply, so the same
identifiers can appear in more than one `review` record. Records never contain
the command, paths, resources, your messages, the
model response body, host error text or a key.

#### Offline summary

`review-report.ts` in the package summarizes the decision log: asks, eligible
asks, model calls, approvals, manual results, skips by reason, invalidated
approvals, screen runs, token counts and evidence paths. It also lists each
proposed approval with a non-empty `evidence` field. Read those first during an
`observe` period, because they are the reviews that this release made possible.

```sh
bun <package>/lib/review-report.ts
bun <package>/lib/review-report.ts --json path/to/permission-review.jsonl
```

`<package>/lib` is the plugin directory, the Home Manager `pluginPath` without
`file://`. Without a path the script reads the decision log and its `.1`
rotation.

The log is not authenticated: the agent's shell can write the state directory,
so it can add lines. The report says so, and it prints only values in the
shape the plugin writes (codes, identifiers, versions and times). Any other
value, such as a terminal escape sequence, shows as `?`.

The plugin creates the file with mode 0600 and its directory with mode 0700.
It refuses to write through a symlink, a hard link, a FIFO or other
non-regular file, to a file or directory owned by someone else, or to an
existing one that group or others can access; it does not change their modes.
The first refused or failed write of each plugin instance prints one stderr
line, `secret-guard: permission review: review log unavailable at <path>; ...`;
in the TUI the next prompt shows a warning (see [TUI sidebar and notifications](#tui-sidebar-and-notifications)).
Review continues; an `auto` approval has no prompt, so a failure
then shows only on stderr. Check ownership and modes (`chmod 700` the
directory, `chmod 600` the file), free space and the `.1` rotation target, or
delete them.

Each record is one line under 4 KiB, appended in a single write. Several
OpenCode processes share the file. When it would exceed 1 MiB it is renamed
to `permission-review.jsonl.1`, replacing the previous one, so the log stays
around 2 MiB; `tail -F` follows the new file. Concurrent rotation can drop
records: the log is best-effort diagnostics, not an audit trail. Any program
running as you can write to it, and nothing reads it back. Delete both files
at any time. A write failure never changes a decision.

The plugin also writes one line to stderr for each incoming `ask`, for
example `secret-guard: permission review: observe: allow shell (model-approved)`,
visible only as described above.

### Credential reasons

| Reason               | Meaning and remedy |
| -------------------- | ------------------ |
| `auth-no-connection` | No active OpenCode Zen connection. Connect OpenCode Zen with an API key in OpenCode. |
| `auth-unresolved`    | The active connection did not resolve to a credential. Reconnect with an API key. |
| `auth-not-key`       | The connection is not an API key, for example OAuth, which review does not support. Connect with an API key. |
| `auth-empty-key`     | The saved key is empty. Reconnect with a valid key. |
| `auth-rejected`      | OpenCode Zen answered HTTP 401 for the saved key. Replace the key. |
| `auth-error`         | OpenCode failed while looking up the connection. |
| `auth-unsupported`   | Defensive: this OpenCode does not expose saved credentials to plugins. V2.0.20 does. |
| `key-unreadable`    | `endpoint` backend: the `apiKeyFile` cannot be read. Check the path and its permissions. |
| `key-empty`         | `endpoint` backend: the `apiKeyFile` is empty. Write the key to it. |
| `opencode-unsupported` | `opencode` backend: this OpenCode does not have the call for `opencode.api`: `experimental.generate.decisions` or `generate.text`. Use a newer OpenCode, or another backend. |
| `opencode-model-unsupported` | `opencode` backend: the model does not fit `opencode.api`, for example a chat model with `decisions` or a decision model with `text`. See [Backends](#backends). |
| `opencode-model-not-found` | `opencode` backend: OpenCode has no enabled model or provider with that name. |
| `opencode-invalid-request` | `opencode` backend: OpenCode rejected the request, for example an unknown `#variant`. |
| `opencode-unavailable` | `opencode` backend: OpenCode cannot generate now, for example because the provider's credentials are missing. |
| `opencode-provider-<reason>` | `opencode` backend: the provider failed the request. `<reason>` is `authentication`, `rate-limit`, `content-filter`, `invalid-request`, `overloaded` or `provider`. |
| `opencode-error`    | `opencode` backend: any other generation failure. |
| `decision-error`    | `decisions` API: the model returned an error or refusal answer for one question. |

Use `observe` to record judgments without applying approvals. Use `auto` to
apply judgments that pass every approval check. Both modes use the same scope
and score checks, including compacted, forked, subagent and outside-project shell work.

After you install a release that changes what the reviewer reads, run it in
`observe` for a period of normal use, for example two weeks. Read every
proposed approval in the sidebar or with the [offline summary](#offline-summary),
starting with the reviews whose `evidence` field is not empty. Switch to
`auto` when those approvals look right. To roll back, use `observe` or `off`,
or pin the previous guard release.

With Home Manager, use the typed `permissionReview` option. The module writes
it into the protected config file:

```nix
programs.opencode-secret-guard.permissionReview = {
  mode = "observe";
  logPayloads = false;
  confidenceThreshold = 0.9;
  # Optional; "attention" hides progress and approval toasts.
  toasts = "all";
  # Optional; false turns off the restriction screen.
  restrictionScreen = true;
  # Optional; the default is jev.
  backend = "endpoint";
  endpoint = {
    baseURL = "http://127.0.0.1:11434/v1";
    model = "example-local-model";
    apiKeyFile = null;
    # Optional; "decisions" posts to {baseURL}/decisions, "systemone" to
    # {baseURL}/systemone.
    api = "text";
    # Optional; null keeps the backend's default request limit.
    maxRequestBytes = null;
  };
};
```

A chat model through OpenCode instead:

```nix
programs.opencode-secret-guard.permissionReview = {
  mode = "observe";
  backend = "opencode";
  opencode = {
    model = "github-copilot/gpt-6-luna#low";
    api = "text";
  };
};
```

Unset keys take their defaults. Set `opencode` or `endpoint` only together with
the matching `backend`; evaluation fails otherwise. `settings.permissionReview`
is rejected, so the option is the only source of these values.

Do not put API keys or other secret literals in Nix: they would end up in the
world-readable Nix store.

## Backends

`backend` selects the model call. One backend runs per configuration.
The `opencode` and `endpoint` blocks also select an `api`.

| `backend` | Call | Key | Data goes to |
| --------- | ---- | --- | ------------ |
| `jev` (default) | `https://opencode.ai/zen/v1/systemone`, model `jev-1.13-free`, through the runtime's `fetch`. Neither is configurable. | The OpenCode API key you saved for the `opencode` provider, read through the plugin integration API. The plugin stores no key. | OpenCode Zen. |
| `opencode` | `api` `decisions` (default): OpenCode's `experimental.generate.decisions`, with a decision model. `api` `text`: OpenCode's `generate.text`, with a chat model. | Your OpenCode connections. No extra key. | The provider of that model, as OpenCode routes it. |
| `endpoint` | `api` `text` (default): `POST {baseURL}/chat/completions`, with a JSON-schema response format. `api` `decisions`: `POST {baseURL}/decisions`, the OpenAI Decisions API. `api` `systemone`: `POST {baseURL}/systemone`, the System One API. | `apiKeyFile`: a file that holds the key, or `null` when the server needs none. | The host in `baseURL`. A loopback host keeps the data on this machine. |

- `jev`: the same request, questions and answer contract as before this option existed.
  The saved key is resolved before the session's messages are read.
  If no saved credential is active, or it is not a usable API key (for example OAuth),
  the reviewer is skipped and you are asked normally; see [Credential reasons](#credential-reasons).
  Jev is currently offered free on OpenCode Zen; that offer may end, in which case
  review fails and prompts return. There is no paid fallback. See the
  [Jev model documentation](https://opencode.ai/v2/docs/console/models#jev).
- `opencode` with `api` `decisions`: needs OpenCode 2.2.5 or later, which
  provides `experimental.generate.decisions`, and a decision model.
  Chat models, such as the ones you use in sessions, fail with
  `opencode-model-unsupported`. List the decision models that your connections
  provide with `opencode api model.list --param types=decision`.
  With an OpenCode Zen key, `opencode/jev-1.13-free` is free; `opencode/jev-1.13` is paid.
  The model gets the same evidence as Jev, asked as six predicate questions.
  Each answer is the probability that the question's statement holds, the same
  yes-probability that Jev returns.
- `opencode` with `api` `text`: works with any chat model that OpenCode can
  reach, for example `github-copilot/gpt-6-luna#low`. List them with
  `opencode models`. A decision model fails with `opencode-model-unsupported`.
  The prompt holds the same instructions, evidence and answer format as the
  `endpoint` text API. The reply must be only the answer object; one
  surrounding Markdown code fence is allowed. Text-mode scores are numbers that
  the chat model writes itself. They are less reliable than decision-model
  probabilities and are not calibrated. A malformed reply keeps the prompt,
  with `response-json` or `response-shape`.
- `opencode`, both APIs: on a host without the call, each `ask` stays a prompt
  with reason `opencode-unsupported`. `deadlineMs` is a whole number from 1 to
  30000, and defaults to 10000. OpenCode cannot cancel a generation, so an answer
  that arrives after the deadline is ignored; the reason is `deadline`.
- `endpoint`: `baseURL` must use HTTPS. HTTP is allowed only for `localhost`,
  `127.0.0.1` or `[::1]`. It must not contain credentials. `model` is the
  server's model name. `apiKeyFile` is an absolute path, or starts with `~`.
  The plugin reads it before each review and never logs it. `deadlineMs` is a
  whole number from 1 to 30000, and defaults to 20000, because a local model can need
  longer than the 10-second default.
  - With `api` `text`, the server must reply with the same answer object that
    Jev returns, `{"answers": {"<question>": {"type": "noul", "noul": <probability>}}}`,
    with no other text. Other replies fail closed with `response-json` or `response-shape`.
    The plugin also asks for `summary` and `rationale` strings for the
    [toast](#live-phase-notifications). A reply without them is still valid.
  - With `api` `decisions`, the server must provide the OpenAI Decisions API
    at `{baseURL}/decisions`. The plugin sends the evidence as JSON input and
    asks six predicate questions, as for `opencode` with `decisions`. A refusal
    answer fails closed with `decision-error`.
  - With `api` `systemone`, the server must provide the System One API at
    `{baseURL}/systemone`. The plugin sends the same request as the `jev`
    backend, with `model` from the block, and expects the same answer object.
    This fits TypeSafe (`https://api.typesafe.ai/v1`, model `jev-latest`, your
    TypeSafe key) and local decision-model servers that offer `/v1/systemone`,
    such as Ollama, llama.cpp's `llama-server` or vLLM. The questions carry
    `instructions` as a JSON object and Noul `criteria`; check that the server
    accepts both. Local models are not Jev, and their scores need their own
    threshold checks.

```json
{
  "configVersion": 8,
  "permissionReview": {
    "mode": "observe",
    "backend": "endpoint",
    "endpoint": {
      "baseURL": "http://127.0.0.1:11434/v1",
      "model": "example-local-model",
      "apiKeyFile": null,
      "deadlineMs": 20000,
      "api": "text"
    }
  }
}
```

The `endpoint` backend is not benchmarked. Choose a local model and its
runtime from measured results, not from this example.

### Request size

Each backend has a limit for the request body, and every backend checks it
before it sends anything. A request over the limit keeps the prompt with
`request-oversize`.

| Backend | Request limit | Evidence (`state`) limit |
| ------- | ------------- | ------------------------ |
| `jev`, and `endpoint` with `api` `systemone` | 160,000 bytes | 80,000 bytes, below Jev's 32k tokens per question |
| `opencode`, and `endpoint` with `api` `text` or `decisions` | 48,000 bytes | What the request limit leaves after the questions |

`maxRequestBytes` in the `opencode` or `endpoint` block replaces the request
limit of that block, from 32,000 to 360,000 bytes. The evidence fills the
space that is left; see [Evidence](#evidence). The questions take about
10,000 bytes with the `text` APIs, and about 23,000 bytes with System One and
the `decisions` APIs, which repeat the shared guidance in each question. When
even the pending action and the warnings do not fit, the review keeps the
prompt with `request-oversize` before it sends anything, including the
[restriction screen](#restriction-screen).

## Scope

Only eligible `ask` requests from the `shell` tool are sent to the review model.
Supported permission actions are `shell` and `external_directory`. The session
must be at the plugin's project directory, without a subpath. Root sessions,
forks and subagent sessions are reviewed; see [Forks and subagent sessions](#forks-and-subagent-sessions).
The requested working directory can be outside the project in either mode.

Everything else stays a prompt, including edits, writes, reads, patches, MCP
tools and external-directory requests from tools other than `shell`.
Review does not read another project's instructions or permission rules.

OpenCode checks external-directory access before shell permission for the same
call. The reviewer evaluates each permission action separately. In `auto`, each
check can receive a one-time approval if its own review passes. Approving
external access does not approve a separate shell ask. Shell permission can
already be allowed by a rule. In that case, external-access approval can be
the last permission check before execution. In `observe`, every ask stays manual.

## Evidence

The model receives one `state` object. Code builds it from the session's
context, validates it, and fills it within the backend's evidence limit:

- `pending_action`: `permission_action` (`shell` or `external_directory`),
  `requested_command` (the command from the tool input, after host rewrites
  such as `rtk`), `requested_cwd` (the directory that input asked for, resolved
  against the project directory; not proof of where the command finally runs),
  `project_directory` and `permission_resources` (parsed commands for `shell`,
  or access targets for `external_directory`).
- `context_warnings`: `compacted`, `outside_project`, `forked`, `subagent`,
  `credential_removed`, `binary_attachments` and `screen_failed` booleans.
  `outside_project` covers the requested working directory or prior
  external-access permission checks for the same tool call, including `cd`
  targets within the command.
- `user_messages`: the text of the user-role messages, oldest first, and live
  refusal feedback (see [Refusals](#refusals)). In a subagent session they come
  from the root session.
- `prior_refusals`: refusals before the latest user message, oldest first; see [Refusals](#refusals).
- `delegated_task`: in a subagent session only, the prompts another agent wrote for it.
- `compaction_context`: completed compaction summaries, each with `summary`.
- `compaction_recent_user`: the user parts of the verbatim text that a
  compaction keeps beside its summary.
- `skills`: skill text, each with `name` and `source`; see [Attachments and skills](#attachments-and-skills).
- `attachments` and `binary_attachments`: attached text and the names and types of other files.
- `restriction_excerpts`: lines and chunks from evidence that was cut or left
  out and that can state a restriction, each with its `source`.
- `coverage`: each item that was cut (`cut`) or left out (`omitted`), with its
  `source`, `id` and size in characters.

### Tiers

The evidence fills the limit in tiers. A tier starts only when the previous
tier is complete; inside a tier the newest items go first.

| Tier | Content |
| ---- | ------- |
| Always | The pending action, the warnings, the coverage list and the names of binary attachments |
| 1 | User messages, live refusal feedback, prior refusals and a delegated task |
| 2 | Compaction summaries, then the user parts of their verbatim text |
| 3 | Skills from all sources, each skill once |
| 4 | Attached text files and directory listings |

- A text item over 4,000 characters keeps its first and last 2,000 characters
  with an `[N characters omitted]` marker. A pasted log therefore cannot push
  out your instructions. The `## Requirements` section of a summary goes first,
  so the cut keeps it.
- A fifth of the evidence limit, but at least 2,000 and at most 16,000 bytes,
  stays free for excerpts and the coverage list.
  For each item that was cut or left out, code copies the lines that contain a
  restriction word (`never`, `do not`, `don't`, `must`, `only`, `ask`,
  `before`, `without`, `confirm`) or a word of the pending command, such as
  `push` or a target path, into `restriction_excerpts`. Lines that name the
  command go first.
- There is no longer a size limit that skips the review. Only the pending
  action keeps its own limits.

### Restriction screen

Skills and attachments can hold rules that the tiers cut or leave out, and
that the keyword excerpts miss because they use other words. With
`restrictionScreen` `true`, the default, the reviewer asks the configured
review backend which parts of that text are rules for the agent, and sends
those parts to the main review:

1. Code splits the text that was cut or left out in tiers 2 to 4 at Markdown
   headings and blank lines, into chunks of about 600 to 1,500 characters and
   at most 2,000.
2. One request asks, for each chunk that is not in the cache: does it state a
   rule for an agent's actions, something it must not do, may only do in a
   certain way, or must ask before doing? System One and the `decisions` APIs
   answer with a probability per chunk; the `text` APIs answer with the ids of
   the chunks that state a rule. Chunks beyond the request limits are not
   screened, and the coverage list says so.
3. Code keeps each chunk at a probability of 0.3 or more, and every chunk that
   a `text` API selects. It copies the original text of each kept chunk into
   `restriction_excerpts`: chunks that name the pending command first, then by
   probability, then the newest. The model never rewrites a chunk, and unknown
   ids are ignored.

The screen runs only when evidence in tiers 2 to 4 was cut or left out, and at
least 3 seconds of the review deadline remain. It gets at most 40% of the
remaining time. Results are cached per backend, model and chunk text for the
plugin's lifetime, 2,048 entries at most, because the question does not depend
on the action. A failed or late screen, or a reply in the wrong shape, is no
skip: the review continues with the keyword excerpts, and `screen_failed` is
set. A single invalid answer, such as a duplicate id or a probability outside
0 to 1, only leaves its chunk out, without the warning and without a cache
entry.

User messages, refusals and the pending action never pass through the screen.
It only selects from text that would otherwise be cut or left out, so a screen
error cannot make the evidence worse than without the screen. Keyword
extraction still runs on every chunk. Text in a chunk can still tell the model
to select nothing. With System One and the `decisions` APIs each chunk gets its
own answer; with the `text` APIs one reply covers the whole request, so such a
chunk can suppress the other chunks in that request. Those results are cached
like any other, until the plugin reloads or the cache drops them. The screen
sends text that the main request leaves out to the same destination. If the
main request is over its limit after the screen, excerpts are dropped until it
fits, the screen's first.

### Compaction

OpenCode returns the latest completed compaction and later messages. The
reviewer sends the completed summary in `compaction_context`. A summary
compaction also keeps the newest messages as verbatim text: `recent` in
OpenCode 2.0.20, `metadata.recent` in 2.3.0. That text can hold your latest
request, which is no longer a separate message. The reviewer takes each block
that starts with `[User]:`, up to the next message part such as
`[Assistant]`, `[Tool`, `[Synthetic`, `[Shell]` or `[Skill activated`, and sends
it in `compaction_recent_user`. Skill blocks in that text count as skills.
Tool output and provider-native fields are never sent.

Summaries and the verbatim user parts are indirect evidence. Tool output in the
verbatim text can imitate a `[User]:` block, and summaries can repeat tool
output or assistant claims. OpenCode also writes a change of working directory
as a `[User]:` block, which you did not type. Neither can satisfy an ask-first
requirement or the [remote exception](#how-a-request-is-approved). A running
compaction keeps the prompt with `context-compacted`. A failed compaction
replaces nothing, so the history before it stays and the reviewer ignores it.
A native compaction has no readable summary and adds no evidence.

### Refusals

OpenCode saves refusals in the session history:

| Saved error | Kind | Effect |
| ----------- | ---- | ------ |
| Tool part, `aborted`, `The user declined this tool call` | `declined` | Refusal of that call |
| Tool part, `permission.rejected` (a reject with feedback, or a configured deny rule) | `rejected` | Refusal of that call; the message is the feedback or the rule reason |
| `aborted`, `Tool execution interrupted` or `Step interrupted` | `interrupted` | Counts for the turn rule only |
| `aborted`, `Interaction cancelled because the location shut down` | `shutdown` | None |
| Any other `aborted` | `unknown-aborted` | Refusal |

A characterization test pins these strings to OpenCode 2.0.20 and 2.3.0. A
changed string can only cause more prompts.

- **Turn rule.** A refusal or an interrupt after the latest user message keeps
  the prompt in that session (`context-rejected-turn`). The agent cannot retry
  a refused action in another form before you write again.
- **Older refusals** go to the model as `prior_refusals`: `tool`, `command`,
  `directory`, `kind`, `feedback`, `live_feedback`, `user_messages_after` and
  `same_as_pending` (the same command and directory as the pending action).
  The newest 8 are sent.
- **Lifting.** A later message of yours that clearly covers the refused action
  lifts the refusal, also for the same command. For example, you reject
  `git push`, review the change, and then write `push it and open a PR`. The
  model decides whether the message covers the action.

A `reject` reply seen live pauses review in its session. The reviewer maps the
reply to its call through `permission.asked`, cancels reviews in flight there,
and keeps the refused call in memory, so that it survives compaction. While
paused, each ask in that session shows the normal prompt. The pause ends at the
first review that finds a user message created after the reply, or live
feedback: when the refused call's history entry shows `permission.rejected`
after a live reject, its message is your feedback. It counts as a user message:
it ends the pause, and it can authorize and restrict. After a reload this link
is lost, and the saved message is restriction evidence only. Outside subagent
sessions, a user message after the refused call's history entry also ends the
pause; only the call of the current pause counts, not one from an earlier pause.

A reject that the reviewer cannot map pauses its session in the same way. A
reject without a session id pauses every session until the plugin reloads. At
most 1,024 sessions keep their own pause; after that, every session without one
waits for a message of its user after the latest reject. A pause only affects
the reviewer; it never stops or changes an agent.

### Attachments and skills

- The typed text of a message with attachments is a user message.
- Attached text files (`text/plain`) and directory listings
  (`application/x-directory`) go to tier 4, from the content stored in the
  session. The reviewer does not follow `uri` sources or read workspace files.
- Images, PDFs and other types are sent by name and type only, in
  `binary_attachments`, and set `binary_attachments` in the warnings.
- Skills from all three sources go to tier 3: selected in a prompt
  (`source` `prompt`), activated in the session (`session`) and loaded by the
  agent with the `skill` tool (`agent`). Skills kept in a compaction's verbatim
  text have `source` `compaction`. A skill counts once, by name and text. The
  `skill` tool result is the only tool output that the reviewer reads.

Skills, attachments and refusal feedback from history can restrict an action;
they never authorize one. A skill rule that the agent follows, such as
`never push without asking`, now also applies to the reviewer, so it can add
prompts.

### Forks and subagent sessions

- A fork is reviewed with its own copied history, like a root session, with
  the `forked` warning.
- A subagent session follows `parentID` to its root session, at most 4 steps.
  A repeated id, a missing parent or a longer chain keeps the prompt with
  `session-ancestry`. Your messages in the root session are the user messages.
  You do not type into a subagent session, so its user-role messages are agent
  text and go to `delegated_task`. They can narrow the task; they cannot extend
  your consent, which must cover the delegated step, its targets and its
  effects. A fork of a subagent session follows these rules too.
- The turn rule compares the subagent's refusals with the root's latest user
  message by time. A refusal counts from when its tool call or step ended, not
  when it started. A reject pauses only the session where it happened. Refusals
  in the root reach subagent reviews as `prior_refusals` only.
- Events for the root session, such as a new message, cancel reviews in flight
  in its subagent sessions. The final recheck reads both sessions.

### Guidance in the questions

Every question carries the same guidance: the data `boundary`, the
`message_order` of user messages, `command_rewrites` such as `rtk`,
`context_quality` for the warnings, and `evidence_sources` for refusals,
skills, attachments, the delegated task, coverage and excerpts. These are
qualitative instructions, not a fixed score penalty, and the same approval
threshold applies with any warning. The warnings do not prove danger or
guarantee that the model will detect missing context.

The `text` APIs send this guidance once, before the evidence, as `guidance`.
System One and the `decisions` APIs repeat it in each question, because their
requests have no other place for it.

- `message_order`: `user_messages` is oldest first. A later message can lift or
  narrow an earlier restriction, for example `keep the changes local for now`
  followed by `commit and push`. It lifts only the restriction it clearly addresses.
- `command_rewrites`: a command rewriter such as the `rtk` OpenCode plugin can
  prefix commands with `rtk` before review. `rtk <tool> <arguments>` runs that tool,
  and `rtk read` replaces `cat`, `head` and `tail`. The model judges the command that
  `rtk` runs, and the prefix alone does not lower trust.
  The reviewer sends the rewritten command unchanged, because `rtk` renames some
  commands and their flags. Removing the prefix would show a command that does not run.

## How a request is approved

The model answers six yes/no questions about the request, each as a score
between 0 and 1. With `confidenceThreshold` t (default 0.9), the request is
allowed in `auto` only if all hold:

| Question | Asks | Required |
| -------- | ---- | -------- |
| `explicitly_authorized` | Did you ask for or approve this exact action and target? | ≥ t |
| `within_scope` | Does all of the action serve the task you described? | ≥ t |
| `confirmation_required` | Do applicable instructions or refusals still require confirmation, or forbid the action? | ≤ 1 − t |
| `sensitive_effect` | Could it destroy or lose data, change permissions or security, touch credentials, or change a production system? | ≤ 1 − t |
| `remote_effect` | Could it change a remote or shared system, or publish or send data elsewhere? | ≤ 1 − t, or `named_by_user` ≥ t |
| `named_by_user` | Does one of your messages name this action and its target in your own words? | Only for the `remote_effect` exception |

The remote exception lets a push or a pull request run when you named it:
`push the branch and open a PR against main` can approve
`git push -u origin feature-x` and `gh pr create --base main`. Only
`user_messages` can satisfy `named_by_user`; summaries, the verbatim compaction
text, refusal feedback from history, attachments, skills and a delegated task
cannot. All other conditions still apply. A force push destroys remote history,
so `sensitive_effect` keeps it manual, and a named production deploy still
prompts. The reasons for a negative judgment are `model-confirmation-required`,
`model-sensitive-effect`, `model-remote-unnamed`, `model-not-authorized` and
`model-out-of-scope`, checked in that order.

At the default that is ≥ 0.9 and ≤ 0.1; at 0.95 it is ≥ 0.95 and ≤ 0.05;
at 1 only certain answers pass. A value of 0.5 or below is rejected, because
it would approve answers the model is undecided about. The scores are the
model's yes-probabilities, not calibrated confidence: no labeled evaluation
set backs any threshold, so a higher value makes approvals rarer, not
provably correct. Each `review` record in the decision log contains the
threshold it used. This feature has not been shown to be safe or accurate on live traffic;
`observe` exists to gather that evidence on your own work.

In `observe`, a passing result is a proposed approval, not an applied one.
For the same evidence and model answers, `auto` would apply that approval.
This includes compacted, forked and subagent sessions and outside-project shell
work. Separate external-access and shell checks can have different results.
Switching modes or repeating inference can change subsequent context and model answers.

### Confirmation restrictions

The normal confirmation question starts with these exact sentences:

> Do instructions in `state.user_messages` require further confirmation for `state.pending_action`, or forbid what it would do? Judge its command, flags, arguments, targets, working directory and effects.

It also applies refusals in `state.prior_refusals` and rules in skills,
attachments, `state.delegated_task` and `state.restriction_excerpts`. The
compacted question also checks instructions recorded in `state.compaction_context`
and `state.compaction_recent_user`. These remain indirect evidence, not direct
consent. Missing context does not establish that restrictions are absent or satisfied.
Confirmation recorded only there cannot satisfy an ask-first requirement.
That requirement needs your own confirmation in `state.user_messages`.

Both question variants apply these rules:

- Check every flag, argument, target, working directory, chained command and side effect.
- Apply an effect restriction only to effects the action actually has.
  Known reporting-only `git clean --dry-run` satisfies `Do not delete anything`.
  A `--dry-run` flag alone does not prove reporting-only behavior.
- Keep command, tool, target and action-class bans or confirmation requirements,
  even when effects are harmless. `Ask before any git clean` still requires
  confirmation unless you already confirmed that exact action.
- Do not ask again merely because a condition is already satisfied.
  Do not assume that unmet or unknown conditions are satisfied.
  Do not infer unknown effects, alias behavior or effects of chained commands.
- Prior confirmation that names the exact action can satisfy a textual ask requirement.
  A bare `yes` or `ok` does not establish exact-action authorization.
  Prior confirmation does not cancel a refusal.

This guidance is not a blanket confirmation bypass. The other questions,
scope gates, refusal checks and all score thresholds still apply.
The question-contract tests check request shape and wording, not Jev's interpretation.

## When you are still asked

Besides any unmet approval condition, the reviewer leaves the prompt when:

- The request is outside the [scope](#scope), cannot be matched to exactly
  one pending tool call, or its agent differs. An identity becomes permanently
  ineligible when a shell call shares it with another live call.
  Dropping an unfinished shell call also makes its identity permanently ineligible.
  Calls are dropped after 15 minutes, beyond 512 tracked calls, or after a
  session event. After 1,024 unsafe identities, no call is approved until reload.
  Non-shell-only collisions and dropped non-shell calls do not fill that limit.
- The same permission action for a tool call is evaluated again. Each action
  receives at most one review per call.
- The user channel has no message, no live feedback, no non-blank completed
  summary and no verbatim user part (`context-no-human`). In a subagent
  session, the root session must have one. Running, failed or malformed
  compactions make the request ineligible.
- A refusal or an interrupt comes after the latest user message
  (`context-rejected-turn`), or a live reject paused the session
  (`session-rejected`); see [Refusals](#refusals).
- A subagent session's parent chain is broken, repeats or is longer than 4
  steps (`session-ancestry`).
- The command, working directory or a resource is missing or too long, or the
  request is over the backend's limit (`request-oversize`).
- A real token format appears in the command, working directory or a resource
  (see [What leaves your machine](#what-leaves-your-machine)).
- No usable key is available for the selected backend.
- The session, or the root of a subagent session, is interrupted, deleted or
  moved, or its inbox changes, while the review runs.
- Before reporting a proposed approval, the reviewer reads the sessions again
  and builds the evidence again with the same limit. A changed location,
  ancestry, message, refusal, skill, attachment or compaction, a new pause, or
  a changed or finished tool call invalidates that result.
- The whole review takes longer than its deadline: 10 seconds for `jev`, or
  `deadlineMs` for `opencode` and `endpoint`. The call fails, or returns an
  unusable answer.
- Two reviews are already running.

## What leaves your machine

Each review sends to the selected backend's destination (see [Backends](#backends)):
for `jev`, OpenCode Zen; for `opencode`, the provider of your chosen model; for `endpoint`,
the host in `baseURL`. The [evidence](#evidence) is sent: the pending action,
user messages, refusal feedback, completed compaction summaries and the user
parts of their verbatim text, skill text from all sources, attached text files
and directory listings, the names and types of other attachments, and the
delegated task of a subagent session. The restriction screen sends text that the
main request leaves out to the same destination. Summaries, skills and
attachments can reproduce private text from earlier messages, tool results,
reasoning, documents or another project. Tool output and provider-native fields
are not sent, except the text of a skill that the agent loaded. In either mode,
`requested_cwd` can name an absolute path outside the project.

Everything the reviewer reads is already in the agent's context. The
credential check stops an extra copy to the review backend and to the payload
log; the guard's sandbox, file-tool checks and environment scrubbing are a
separate boundary.

- In the evidence, a plain one-word value of a credential name loses its value:
  `MY_VAULT=abc` becomes `MY_VAULT=[value removed]`. A line with a token
  format, or with a credential name followed by a quoted or secret-looking
  value (a digit and at least 6 characters, or at least 20 characters), becomes
  `[line removed: possible credential]`. A private key block is removed from
  `BEGIN` to `END`, or to the end of the item without an `END` line. Prose such
  as `token: never print it` stays, because it can be one of your rules. The
  review continues with `credential_removed` set, and the questions tell the
  model that a removed line can have stated a restriction.
- In the pending action, a real token format (`sk-`, `ghp_`, `github_pat_`,
  `glpat-`, `AKIA`, `xox*-`, a private key, bearer or basic authorization, URL
  credentials) keeps the prompt, for example with `command-credential` or
  `resource-credential`.
- In the pending action, a generic or configured `name=value` loses its value
  only when the value is one plain word, without quoting, `$`, backticks,
  backslashes or shell operators: `MY_VAULT=abc` becomes
  `MY_VAULT=[value removed]`, and the review continues with
  `credential_removed` set. Any other match keeps the prompt, so the removal
  never hides part of what runs. For example, `TOKEN="$(curl … | sh)" true`
  and `x-api-key: abc` keep the prompt.

Recognition covers common token formats, private-key headers, inline passwords
and URL credentials, and assignments to variable names in the guard's
`secretEnvironment` and `secretEnvironmentPatterns`. It is not an exhaustive
scanner: a credential split across lines, or a short letters-only value after
`name:` and a space in the evidence, is not recognized. No
zero-retention guarantee is made. Leave the mode `off` for work whose
instructions, attachments or paths must not leave the machine.

## Payload log

With `logPayloads: true` and a mode other than `off`, the plugin also writes
`permission-review-payloads.jsonl` next to the decision log. Unlike the
decision log, it contains the commands, resources, working directory and
all evidence sent for review, including user messages, summaries, skills and
attachments, and the model's answers. Enable it only
for debugging, and only where that is acceptable on disk.

```sh
tail -F "${XDG_STATE_HOME:-$HOME/.local/state}/opencode-secret-guard/permission-review-payloads.jsonl"
```

Each record has `event: "payload"`, `time`, `pid`, the `reviewID` of its
`review` record, the `sessionID`, `messageID` and `callID`, `model`, and a
`phase`. The [restriction screen](#restriction-screen) writes the same phases
with a `screen-` prefix: `screen-request`, `screen-response` and `screen-failure`.

- `request`: `endpoint` and `body`, the exact JSON sent. For `endpoint` the
  endpoint is the host and port only, never the path or credentials. For
  `opencode` it is the generation call name, `experimental.generate.decisions`
  or `generate.text`, and the body is the call's input with the same evidence
  as the other backends. Written right
  before the call, so a review that never reaches the network, for example
  without a key, writes nothing.
- `response`: `status`, `body` and `omitted`. For `opencode` the status is
  always 200, and with `api` `text` the body is the model's reply text.
  The body is read only up to the 64 kB response limit and the review
  deadline, for errors too. An OpenCode reply over that limit is not logged
  and keeps the prompt with `response-oversize`.
  `omitted` is `null` for a complete body; otherwise `body` is empty and
  `omitted` says why: `oversize` (over the limit; no prefix is kept, so a
  cut cannot leave part of the key), `declared-oversize` (not read because
  its declared length was too large), `unreadable`, or the abort reason
  below when the review ended while reading. The validation result is
  unchanged: an incomplete body still leaves the prompt.
- `failure`: no response was received, or the success body could not be
  read. `reason` is `network`, `response-read`, `deadline` (the review
  deadline), `session-event`, `session-rejected`, `events-ended` or `unloaded` (the
  review was cancelled), or
  `request-aborted` for any other abort. For `jev` and `endpoint`, the error
  text is never kept. For `opencode`, a failed generation also writes a
  `failure` record with an `opencode-*` reason and `error`: OpenCode's error
  tag and message, cut to 2,000 characters. The plugin never sees the provider
  key, but the message can repeat provider text.

The `authorization` header is never written. An exact copy of the API key in
a body, raw or JSON-escaped, is replaced with `[redacted]`; other encodings
are not detected, and nothing else is redacted, so do not
treat the file as secret-free. Each record is at most 512 KiB; the file
rotates to `.1` above 8 MiB, with the same file checks as the decision log.
If a write fails, stderr says so once and prompts carry
`secret-guard log: payloads unavailable`, which the TUI shows as its own
warning. Turning the option off stops new records; existing files remain
until you delete them.

## Possible future extensions

These are ideas, not commitments, and none is implemented:

- Automatic deny, as a separate opt-in from automatic approval.
- Semantic adapters for further tools and MCP servers.
- Assistant text and other tool output as untrusted evidence.
- A cheap first review stage that can only return `ask`.
- An action-specific restriction screen, such as "is this chunk relevant to
  `git push`?"; it cannot be cached and costs one screen per review.
- Per-question or per-action thresholds calibrated against a labeled
  evaluation corpus.
- OAuth credentials, once their contract is verified.
- Excluding specific `ask` rules from review.
- Backing off during a System One outage.
- Reviewing the final shell command and working directory, if OpenCode adds
  them to the permission request.

## Prior art

[opencode-permission-reviewer](https://github.com/Warc0s/opencode-permission-reviewer)
already reviews OpenCode permission requests with Jev.
