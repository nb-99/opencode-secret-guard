# Optional permission review with Jev

Status: approval-only. Off by default.

The secret guard decides deterministically what a command or file tool may
touch. Permission review is a separate, optional step: when OpenCode V2 is
about to show you an `ask` prompt, the plugin can send that one request to the
Jev model (TypeSafe System One) and approve it automatically. The model answers
four narrow questions, and code combines the answers (see
[How a request is approved](#how-a-request-is-approved)). Anything else still
reaches you as a normal prompt.

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
- In both `observe` and `auto`, the prompt waits for the review, up to 10
  seconds. `observe` is synchronous on purpose.
- It requires OpenCode V2.0.20 or later. The V2 plugin and credential
  contracts it relies on were checked against the 2.0.20 and 2.0.23 source
  ([details](v2-migration.md#permission-review-dependencies)). The TUI contracts
  described below were checked against the V2.1.4 source.
  If a required permission, session, integration or event API is missing,
  the reviewer prints a notice and leaves prompts in place.
  It also stops reviewing if its server event stream ends.
- On OpenCode V1 an enabled reviewer prints a startup notice that it is only
  available on V2. Prompts are unchanged and the guard works as before.
- Evidence of your intent comes from user-role messages in the root session.
  Not all of that text is typed by you: slash-command templates, shell output
  interpolated into a template (for example a pull-request diff), MCP prompts
  and API clients can all produce user-role messages. OpenCode stores no
  authenticated provenance for them, and the reviewer cannot reliably tell
  them apart, so it trusts the commands, MCP servers, clients and plugins you
  run. The model is told that consent claimed inside quoted material is not
  yours, which reduces but does not remove this risk.
- Both `observe` and `auto` review completed compactions and outside-project
  shell work with context warnings. See [Scope](#scope).
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

`permissionReview` requires `configVersion` 4. Its keys are `mode`,
`logPayloads` and `confidenceThreshold`; each is optional. Without
`permissionReview` the mode is `off`. An invalid `permissionReview` is
a policy validation error, so the guard refuses to start as for any invalid
policy. Problems at runtime, such as a missing host API, no credential, or a
failed call, only leave the normal prompt.

```json
{
  "configVersion": 4,
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

Values are not coerced: `"true"` or `"0.9"` is a validation error. The guard
reads the policy at startup, so restart OpenCode after a change.

| `mode`    | Behavior                                                                          |
| --------- | --------------------------------------------------------------------------------- |
| `off`     | Default. The reviewer is not set up and sends no model traffic.                   |
| `observe` | Each `ask` is logged and noted; eligible `shell`-tool asks (`shell` and `external_directory`) are sent to Jev. You still decide. |
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

The section shows up to four reviews for the current project-scoped session.
Active reviews appear first; within each group, newer reviews appear first.
Each entry shows the mode, permission action, phase and available context warnings.
Completed entries also show the reason, `proposed` verdict and `applied` effect.
Every incoming `ask` gets checking and completion status, including skipped
edit, read, MCP and delegated-session requests. These entries also occupy the
four-review list. Only eligible `shell` and `external_directory` checks from
the shell tool reach Jev.

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

Every unique live phase update produces a toast, in both `auto` and `observe`:

| Phase | Meaning | Toast |
| ----- | ------- | ----- |
| `checking` | Review started; eligibility checks run before a model call. | Informational. |
| `evaluating` | The reviewer starts the Jev request. Skipped reviews do not reach this phase. | Informational. |
| `completed` | Review ended, including approvals, negative judgments, skipped requests and failures. | Success for applied `allow`; warning otherwise. |

Duplicate or older live phase updates do not produce another toast.
Automatic approvals and negative `auto` judgments therefore have notifications,
even when no permission prompt appears. The reviewer emits completion status
for skipped and failed reviews too.

When Jev returns a valid judgment, the sidebar and phase toast show all four
raw yes-probabilities. Each row shows its threshold, comparison direction and
pass/fail result:

- Authorization and scope must each be at least `confidenceThreshold`.
- Confirmation and impact must each be at most `1 - confidenceThreshold`.

At the default threshold, these limits are ≥ 90% and ≤ 10%, respectively.
The display does not replace the [per-answer approval rules](#how-a-request-is-approved).
It does not invent missing scores. It shows `not evaluated` before a model call,
`pending` during evaluation, and `unavailable` after a call without a valid judgment.

`proposed` records Jev's verdict when Jev returns a valid judgment; otherwise it is `ask`.
`applied` records the permission effect at the reviewer's hook exit.
It does not prove that a command ran or that later hooks kept that effect.
If context changes after a passing judgment, the review keeps all four scores
and proposed `allow`, but applies `ask` with the invalidation reason.
In `observe`, even a valid proposed `allow` leaves manual approval in place.
For reasons with a remedy, the sidebar and toast also show a `Next:` line.
`guidanceFor` selects fixed, safe text from a validated reason code.
It covers credential problems, timeouts and `events-unavailable`.

#### Reconnection and privacy

The server keeps a bounded, in-memory store of 128 review statuses.
Its read-only `JevRpc` definition has ID `opencode-secret-guard.jev`, a `snapshot`
method and `review` events. Each session snapshot contains at most four reviews.
See the [plugin RPC documentation](https://opencode.ai/v2/docs/build/plugins/rpc).

This state survives a TUI client disconnect, not a server restart or plugin unload.
The TUI uses `ctx.data.listen` on the host's reconnecting event bus for
`rpc.opencode-secret-guard.jev.review` and `server.connected`.
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

With review `off`, the server registers no review RPC.
The sidebar probes once on mounting, without polling.
Its contribution stays empty until a snapshot succeeds or a live status arrives.
An off reviewer therefore does not produce an unavailable-status panel.

Status and decision logs never contain commands, paths, resources, user messages,
keys, host error text or model response bodies. They use identifiers, fixed codes,
validated scores and context-warning flags. Neither display recovery nor raw score
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
For negative `observe` judgments, it names the first failed check and displays
the weakest score and threshold. The score is
`min(explicitly_authorized, within_scope, 1 - confirmation_required, 1 - high_impact)`.
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

- `start`: `time`, `pid`, `mode`, `model`, `threshold` and `logPayloads`.
- `review`: also `action`, `proposed` (Jev's verdict from a valid judgment,
  otherwise `ask`), `applied` (the effect when the reviewer's hook returned; a later
  plugin can still change it, so this is not a record of what ran),
  `reason`, `threshold`, and `modelCalled` (a boolean recording whether the
  reviewer started a model request, not whether it succeeded).
  Valid judgments add a `scores` object with `explicitly_authorized`,
  `within_scope`, `confirmation_required` and `high_impact`, plus the
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
  `outsideProject` booleans. They identify the warnings sent to Jev without
  recording paths or summary text. Exits before context validation omit both fields.
  `outsideProject` covers the requested working directory and external access
  reported by OpenCode for the shell call. Both flags can be true in either mode.
- `unavailable`: a fixed `notice` text.

V2 evaluates a pending request again after an "always" reply, so the same
identifiers can appear in more than one `review` record. Records never contain
the command, paths, resources, your messages, the
model response body, host error text or a key.

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

Use `observe` to record judgments without applying approvals. Use `auto` to
apply judgments that pass every approval check. Both modes use the same scope
and score checks, including compacted and outside-project shell work.

With Home Manager, set it through the existing `settings` option, which is
written into the protected config file:

```nix
programs.opencode-secret-guard.settings.permissionReview = {
  mode = "observe";
  logPayloads = false;
  confidenceThreshold = 0.9;
};
```

`settings.permissionReview` replaces the whole object, so omitted keys take
their defaults.

Do not put API keys or other secret literals in Nix: they would end up in the
world-readable Nix store.

## Model and credentials

- Endpoint: `https://opencode.ai/zen/v1/systemone`, model `jev-1.13-free`,
  called directly with the runtime's `fetch`. Neither is configurable.
- Credentials: the OpenCode API key you already saved in OpenCode, obtained
  through the plugin integration API, as source-verified on 2.0.20 and
  2.0.23. The plugin stores no key itself. The key is resolved before the
  session's messages are read.
- If no saved credential is active, or it is not a usable API key (for
  example OAuth), the reviewer is skipped and you are asked normally; see
  [Credential reasons](#credential-reasons).
- There is no paid fallback. Jev is currently offered free on OpenCode Zen;
  that offer may end, in which case review fails and prompts return.

See the [Jev model documentation](https://opencode.ai/v2/docs/console/models#jev)
and the [OpenCode plugin documentation](https://opencode.ai/v2/docs/build/plugins).

## Scope

Only eligible `ask` requests from the `shell` tool are sent to Jev.
Supported permission actions are `shell` and `external_directory`. The session must be a root
session, not a fork, at the plugin's project directory, without a subpath.
The requested working directory can be outside the project in either mode.
The model receives:

- `permission_action`: the current check, `shell` or `external_directory`
- `requested_command`: the command from the original tool input
- `requested_cwd`: the directory that input asked for, resolved against the
  project directory; not proof of where the command finally runs
- `project_directory`
- `permission_resources`: parsed commands for `shell`, or access targets for
  `external_directory`
- `user_messages`: the plain text of the session's user-role messages,
  oldest first
- `compaction_context`: completed compaction summaries, each with
  `summary`; empty when no compaction is present
- `context_warnings`: `compacted` and `outside_project` booleans. The latter
  covers the requested working directory or prior external-access permission
  checks for the same tool call, including `cd` targets within the command.

Completed summaries can provide the only context in either mode. Their text
does not become a user message. The questions use summaries only as indirect
evidence of the task, consent and restrictions. Summary-only confirmation does
not satisfy an ask-first requirement; that needs your own words in `user_messages`.
The reviewer does not send
`recent`, which contains a raw transcript, or provider-native compaction fields.
Running, failed or malformed compactions remain ineligible. An empty native
summary contributes no evidence, but later user messages can still be reviewed
with the compaction warning.

OpenCode V2.0.20 returns the latest completed compaction and later messages.
The reviewer cannot inspect original messages, refusals or attachments before
that boundary. A summary may omit them. Live refusals remain final while the
plugin runs, even if compaction removes their history.

Every question includes guidance for these warnings:

- Compaction can omit earlier restrictions. Summaries are generated evidence,
  not direct user consent. The questions tell Jev to reduce authorization and
  scope scores when original consent or limits are unclear. Missing restrictions
  do not show that confirmation is unnecessary.
  The restriction and scope questions explicitly include summaries. Recorded
  restrictions apply to the action. Summaries can repeat untrusted tool output
  or assistant claims; consent attributed to you is not verified.
- Project-local consent does not authorize another target. The questions require
  evidence for the exact external target and side effects. They tell Jev to
  reduce authorization and scope scores when that evidence is missing.

These are qualitative instructions, not a fixed score penalty.
The same approval threshold applies with either warning.
The warnings do not prove danger or guarantee
that Jev will detect missing context.

OpenCode checks external-directory access before shell permission for the same
call. The reviewer evaluates each permission action separately. In `auto`, each
check can receive a one-time approval if its own review passes. Approving
external access does not approve a separate shell ask. Shell permission can
already be allowed by a rule. In that case, external-access approval can be
the last permission check before execution. In `observe`, every ask stays manual.

Everything else stays a prompt, including edits, writes, reads, patches, MCP
tools and external-directory requests from tools other than `shell`.
Review does not read another project's instructions or permission rules.

## How a request is approved

The model answers four yes/no questions about the request, each as a score
between 0 and 1. With `confidenceThreshold` t (default 0.9), the request is
allowed in `auto` only if all hold:

| Question                                                         | Required  |
| ---------------------------------------------------------------- | --------- |
| `explicitly_authorized`: did you ask for or approve this action? | ≥ t       |
| `within_scope`: does all of it serve the task you described?     | ≥ t       |
| `confirmation_required`: do applicable instructions still require confirmation, or forbid this action? | ≤ 1 − t |
| `high_impact`: could it lose data, reach remote systems, publish data, change permissions, or touch credentials? | ≤ 1 − t |

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
This includes compacted sessions and outside-project shell work. Separate
external-access and shell checks can have different results. Switching modes
or repeating inference can change subsequent context and model answers.

### Confirmation restrictions

The normal confirmation question starts with these exact sentences:

> Do instructions in `state.user_messages` require further confirmation for `state.pending_action`, or forbid what it would do? Judge its command, flags, arguments, targets, working directory and effects.

The compacted question also checks instructions recorded in `state.compaction_context`.
Summaries remain indirect evidence, not direct consent. Missing context does not establish that restrictions are absent or satisfied.
Confirmation recorded only in a summary cannot satisfy an ask-first requirement.
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

This guidance is not a blanket confirmation bypass. The other three questions,
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
- The context has no user message and no non-blank completed summary.
  User messages and summaries share a 12,000-character budget. Text is never
  truncated. Running, failed or malformed compactions make the request ineligible.
- A user message has attached files or explicitly selected skills. The
  reviewer neither reads nor sends their contents, so it cannot see
  instructions or restrictions in them.
- The session history records a `permission.rejected` error, which OpenCode
  uses for a configured block and for a rejection with feedback, or any
  aborted assistant or tool error. A plain rejection appears in history as an
  aborted error, and so does an ordinary interrupted call. Because the check
  reads available history, it still applies after a restart unless compaction
  removed the refusal. A compaction warning cannot recover a missing refusal.
- A `reject` reply was seen live in the session while the plugin was running.
  This ends review in that session until the plugin reloads. After 1,024
  such sessions, review stops in every session. After a restart, the history
  check above still applies when the saved aborted error remains available.
- The command, working directory or a resource is missing or too long.
- A recognized credential appears in the command, working directory, a
  resource, a user message or compaction text (see [What leaves your machine](#what-leaves-your-machine)).
- No usable API key is available.
- The session is interrupted, deleted or moved, or its inbox changes, while
  the review runs.
- Before reporting a proposed approval, the reviewer reads the session again.
  A changed location, user message, compaction entry or tool call invalidates
  that result. A finished tool call also invalidates it.
- The whole review takes longer than 10 seconds, or the call fails or returns
  an unusable answer.
- Two reviews are already running.

## What leaves your machine

Each review sends to OpenCode Zen the fields listed under [Scope](#scope),
including the available user messages and completed compaction
summaries. Summaries can reproduce private text from earlier messages, tool
results, reasoning or another project. The raw `recent` transcript and
provider-native fields are not sent. In either mode, `requested_cwd` can name an
absolute path outside the project. Nothing is redacted: if a
recognized credential appears anywhere in them, the model is not called and
you are asked. Recognition covers common token formats, private-key headers,
inline passwords and URL credentials, and assignments to variable names in the
guard's `secretEnvironment` and `secretEnvironmentPatterns`. It is not an
exhaustive scanner, and it is conservative: prose such as `token: expired` in
a message also counts. No zero-retention guarantee is made. Leave the mode `off` for work
whose instructions or paths must not leave the machine.

## Payload log

With `logPayloads: true` and a mode other than `off`, the plugin also writes
`permission-review-payloads.jsonl` next to the decision log. Unlike the
decision log, it contains the commands, resources, working directory and
all user messages and summaries sent for review, and the model's answers. Enable it only
for debugging, and only where that is acceptable on disk.

```sh
tail -F "${XDG_STATE_HOME:-$HOME/.local/state}/opencode-secret-guard/permission-review-payloads.jsonl"
```

Each record has `event: "payload"`, `time`, `pid`, the `reviewID` of its
`review` record, the `sessionID`, `messageID` and `callID`, `model`, and a
`phase`:

- `request`: `endpoint` and `body`, the exact JSON sent. Written right
  before the call, so a review that never reaches the network, for example
  without a key, writes nothing.
- `response`: `status`, `body` and `omitted`. The body is read only up to
  the 64 kB response limit and the review deadline, for errors too.
  `omitted` is `null` for a complete body; otherwise `body` is empty and
  `omitted` says why: `oversize` (over the limit; no prefix is kept, so a
  cut cannot leave part of the key), `declared-oversize` (not read because
  its declared length was too large), `unreadable`, or the abort reason
  below when the review ended while reading. The validation result is
  unchanged: an incomplete body still leaves the prompt.
- `failure`: no response was received, or the success body could not be
  read. `reason` is `network`, `response-read`, `deadline` (the 10-second
  limit), `session-event`, `session-rejected`, `events-ended` or `unloaded` (the
  review was cancelled), or
  `request-aborted` for any other abort. The error text is never kept.

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
- Provenance-aware review of parent, forked, and delegated sessions.
- Semantic adapters for further tools and MCP servers, and opt-in review of
  attached file and skill contents.
- Per-question or per-action thresholds calibrated against a labeled
  evaluation corpus.
- OAuth credentials, once their contract is verified.
- Other model backends or paid routes, only if you explicitly choose them.
- Excluding specific `ask` rules from review.
- Backing off during a System One outage.
- Reviewing the final shell command and working directory, if OpenCode adds
  them to the permission request.

## Prior art

[opencode-permission-reviewer](https://github.com/Warc0s/opencode-permission-reviewer)
already reviews OpenCode permission requests with Jev.
