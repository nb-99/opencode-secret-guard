# Optional permission review with Jev

Status: approval-only first version. Off by default.

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
  ([details](v2-migration.md#permission-review-dependencies));
  it has not been tested against a live OpenCode session. If the running
  OpenCode lacks the permission, session, integration or event APIs, or the
  event stream ends, the reviewer prints a notice and prompts are unchanged.
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
| `off`     | Default. The reviewer is not set up and sends no traffic.                         |
| `observe` | Each `ask` is logged and noted on the permission request; only eligible shell asks are sent to Jev. You are still asked. |
| `auto`    | A request that meets every approval condition is allowed once; otherwise asked.   |

When review leaves a prompt in place, in `observe` and in `auto`, the
reviewer appends one line to the permission request's message, after any
message already there:
`secret-guard review: would allow (<reason>)` (`observe` only) or
`secret-guard review: manual approval (<reason>)`, followed by a remedy for
reasons you can act on, such as a missing OpenCode Zen connection. An
approval in `auto` adds no message.

OpenCode V2.0.20 carries this message on the permission request, but neither
its TUI ([prompt](https://github.com/anomalyco/opencode/blob/84c9be93a56304a108f1a22df0c5d62c26d5b6ca/packages/tui/src/routes/session/permission.tsx),
[footer](https://github.com/anomalyco/opencode/blob/84c9be93a56304a108f1a22df0c5d62c26d5b6ca/packages/tui/src/mini/footer.permission.tsx)) nor its desktop app
([dock](https://github.com/anomalyco/opencode/blob/84c9be93a56304a108f1a22df0c5d62c26d5b6ca/packages/app/src/session/requests/session-permission-dock.tsx))
displays a request's message, so the note does not appear on the prompt
itself. The note is a text convention, not an authenticated claim: another
plugin you run could write the same text.

### TUI notices

The package also contains a TUI plugin, `lib/tui.ts`. According to the
V2.0.20 source, the TUI loads it from the same plugin directory as the server
plugin, so no extra configuration is needed; this has not been tested in a
live TUI yet. It only listens for permission prompts. With review `off` it is
normally silent, because the reviewer adds no notes; it still reacts to the
same text written by another trusted plugin, since notes are a convention
(see above). When a prompt carries
a reviewer note, it shows a toast:

- `observe`, would allow: an informational toast, once per request.
- A reason with a remedy, such as a missing or rejected OpenCode Zen key (see
  [Credential reasons](#credential-reasons)), a timeout, or a stopped event
  stream (`events-unavailable`): a "Manual approval required" warning naming
  the reason's remedy, at most once per reason every 10 minutes.
- Any other reason: no toast; the decision is in the log.
- The decision log cannot be written: a separate warning, at most once every
  10 minutes, shown with any of the above. The prompt carries it as an extra
  line, `secret-guard log: unavailable`, only while the most recent write
  failed; it clears once a write succeeds.

Toasts follow live events: one missed while the TUI is disconnected is not
shown later. The log keeps the record. The toast text is fixed per reason. It never contains the command, the
resources or the prompt's message. An approval in `auto` creates no prompt,
so it appears only in the log. The one-off startup and unavailability notices
go only to the log and stderr; once the event stream has ended, later prompts
show the `events-unavailable` warning.

In the V2.0.20 source inspected, the desktop app offers server plugins no
notification API, so there the decision log is the place to look.

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
tail -n 20 "$log" | jq -c '{time, mode, proposed, applied, reason}'
```

Records have one of three `event` values:

- `start`: `time`, `pid`, `mode`, `model`, `threshold` and `logPayloads`.
- `review`: also `action`, `proposed` (the reviewer's verdict, `allow` or
  `ask`), `applied` (the effect when the reviewer's hook returned; a later
  plugin can still change it, so this is not a record of what ran),
  `reason`, `threshold`, `elapsedMs`, a `reviewID` that matches the payload
  log, and the `sessionID`, `messageID` and `callID` of the
  tool call. These identify the call in the session's data; the prompt does
  not display them.
- `unavailable`: a fixed `notice` text.

V2 evaluates a pending request again after an "always" reply, so the same
identifiers can appear in more than one `review` record. Records never contain
the command, paths, resources, your messages, the
model's answer, host error text or a key.

The plugin creates the file with mode 0600 and its directory with mode 0700.
It refuses to write through a symlink, a hard link, a FIFO or other
non-regular file, to a file or directory owned by someone else, or to an
existing one that group or others can access; it does not change their modes.
The first refused or failed write of each plugin instance prints one stderr
line, `secret-guard: permission review: review log unavailable at <path>; ...`;
in the TUI the next prompt shows a warning (see [TUI notices](#tui-notices)).
Review continues unchanged; an `auto` approval has no prompt, so a failure
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

Start with `observe`, compare each decision in the log with your own answer
to the prompt, and switch to `auto` only when you agree with them.

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

Only `ask` requests from the `shell` tool with permission action `shell` are
reviewed, in a root session (no parent, not a fork) whose location is the
plugin's project directory, without a subpath. The working directory must lie
inside the project directory. The model receives:

- `requested_command`: the command from the original tool input
- `requested_cwd`: the directory that input asked for, resolved against the
  project directory; not proof of where the command finally runs
- `project_directory`
- `permission_resources`: the commands OpenCode parsed for the prompt
- `user_messages`: the plain text of the session's user-role messages,
  oldest first

Everything else stays a prompt, including edits, writes, reads, patches, MCP
tools and external-directory requests.

## How a request is approved

The model answers four yes/no questions about the request, each as a score
between 0 and 1. With `confidenceThreshold` t (default 0.9), the request is
allowed in `auto` only if all hold:

| Question                                                         | Required  |
| ---------------------------------------------------------------- | --------- |
| `explicitly_authorized`: did you ask for or approve this action? | ≥ t       |
| `within_scope`: does all of it serve the task you described?     | ≥ t       |
| `confirmation_required`: did you ask to confirm or not do this?  | ≤ 1 − t   |
| `high_impact`: could it lose data, reach remote systems, publish data, change permissions, or touch credentials? | ≤ 1 − t |

At the default that is ≥ 0.9 and ≤ 0.1; at 0.95 it is ≥ 0.95 and ≤ 0.05;
at 1 only certain answers pass. A value of 0.5 or below is rejected, because
it would approve answers the model is undecided about. The scores are the
model's yes-probabilities, not calibrated confidence: no labeled evaluation
set backs any threshold, so a higher value makes approvals rarer, not
provably correct. Each `review` record in the decision log contains the
threshold it used. This feature has not been shown to be safe or accurate on live traffic;
`observe` exists to gather that evidence on your own work.

## When you are still asked

Besides any unmet approval condition, the reviewer leaves the prompt when:

- The request is outside the [scope](#scope), cannot be matched to exactly
  one pending tool call, or its agent differs. A call identity that two live
  calls shared, or whose tracked call was dropped unfinished (after 15
  minutes, beyond 512 tracked calls, or invalidated by a session event), is
  never approved again while the plugin runs. After 1,024 such identities,
  no call is approved until the plugin reloads.
- The same tool call is evaluated again; only the first evaluation is
  reviewed.
- The session was compacted, has no user message, or its user messages exceed
  12,000 characters in total. Text is never truncated.
- A user message has attached files or explicitly selected skills. The
  reviewer neither reads nor sends their contents, so it cannot see
  instructions or restrictions in them.
- The session history records a `permission.rejected` error, which OpenCode
  uses for a configured block and for a rejection with feedback, or any
  aborted assistant or tool error. A plain rejection appears in history as an
  aborted error, and so does an ordinary interrupted call. Because the check
  reads history, it still applies after a restart.
- A `reject` reply was seen live in the session while the plugin was running.
  This ends review in that session until the plugin reloads. After 1,024
  such sessions, review stops in every session. After a restart, the history
  check above still applies, because a plain rejection is saved as an aborted
  error.
- The command, working directory or a resource is missing or too long.
- A recognized credential appears in the command, working directory, a
  resource or a user message (see [What leaves your machine](#what-leaves-your-machine)).
- No usable API key is available.
- The session is interrupted, deleted or moved, or its inbox changes, while
  the review runs.
- Before allowing, the reviewer reads the session again: its location or
  user messages differ, or the tool call changed or finished.
- The whole review takes longer than 10 seconds, or the call fails or returns
  an unusable answer.
- Two reviews are already running.

## What leaves your machine

Each review sends to OpenCode Zen the fields listed under [Scope](#scope),
including all user messages of the session. Nothing is redacted: if a
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
all user messages sent for review, and the model's answers. Enable it only
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
