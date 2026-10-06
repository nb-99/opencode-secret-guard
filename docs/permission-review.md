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

`permissionReview` requires `configVersion` 4. Its only key is `mode`.
Without `permissionReview` the mode is `off`. An invalid `permissionReview` is
a policy validation error, so the guard refuses to start as for any invalid
policy. Problems at runtime, such as a missing host API, no credential, or a
failed call, only leave the normal prompt.

```json
{
  "configVersion": 4,
  "permissionReview": {
    "mode": "observe"
  }
}
```

This fragment shows only the relevant keys; merge it into your existing policy.

| `mode`    | Behavior                                                                          |
| --------- | --------------------------------------------------------------------------------- |
| `off`     | Default. The reviewer is not set up and sends no traffic.                         |
| `observe` | Each `ask` is logged and noted on the prompt; only eligible shell asks are sent to Jev. You are still asked. |
| `auto`    | A request that meets every approval condition is allowed once; otherwise asked.   |

In `observe`, the reviewer appends one line to the prompt's existing message:
`secret-guard review: would allow (<reason>)` or
`secret-guard review: manual approval (<reason>)`.

In `observe` and `auto` the plugin also writes one line to stderr for each
incoming `ask`, including those it does not send to the model, for example:

```text
secret-guard: permission review: observe: allow shell (model-approved)
```

The line contains the mode, the outcome, the permission action (or `other` if
the name is not a short plain name) and a reason code. It never contains the
command, path or message text. In `observe`, `allow` means "would allow":
the review itself runs nothing. Where OpenCode shows plugin stderr, for
example in the TUI, has not been verified.

Start with `observe`, compare the `secret-guard review` note on each prompt
with your own answer, and switch to `auto` only when you agree with them.

With Home Manager, set it through the existing `settings` option, which is
written into the protected config file:

```nix
programs.opencode-secret-guard.settings.permissionReview.mode = "observe";
```

Do not put API keys or other secret literals in Nix: they would end up in the
world-readable Nix store.

## Model and credentials

- Endpoint: `https://opencode.ai/zen/v1/systemone`, model `jev-1.13-free`,
  called directly with the runtime's `fetch`. Neither is configurable.
- Credentials: the OpenCode API key you already saved in OpenCode, obtained
  through the plugin integration API, as source-verified on 2.0.20 and
  2.0.23. The plugin stores no key itself. The key is resolved before the
  session's messages are read.
- If no saved credential is active, or it is not an API key (for example
  OAuth), the reviewer is skipped and you are asked normally.
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
between 0 and 1. In `auto` the request is allowed only if all hold:

| Question                                                         | Required  |
| ---------------------------------------------------------------- | --------- |
| `explicitly_authorized`: did you ask for or approve this action? | ≥ 0.9     |
| `within_scope`: does all of it serve the task you described?     | ≥ 0.9     |
| `confirmation_required`: did you ask to confirm or not do this?  | ≤ 0.1     |
| `high_impact`: could it lose data, reach remote systems, publish data, change permissions, or touch credentials? | ≤ 0.1 |

These thresholds are fixed and uncalibrated: no labeled evaluation set backs
them. This feature has not been shown to be safe or accurate on live traffic;
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

## Possible future extensions

These are ideas, not commitments, and none is implemented:

- Automatic deny, as a separate opt-in from automatic approval.
- Provenance-aware review of parent, forked, and delegated sessions.
- Semantic adapters for further tools and MCP servers, and opt-in review of
  attached file and skill contents.
- Per-action thresholds calibrated against a labeled evaluation corpus.
- OAuth credentials, once their contract is verified.
- Other model backends or paid routes, only if you explicitly choose them.
- Excluding specific `ask` rules from review.
- Backing off during a System One outage.
- Reviewing the final shell command and working directory, if OpenCode adds
  them to the permission request.

## Prior art

[opencode-permission-reviewer](https://github.com/Warc0s/opencode-permission-reviewer)
already reviews OpenCode permission requests with Jev.
