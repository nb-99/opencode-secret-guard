/**
 * V2 session messages as OpenCode stores them in v2.0.20 and v2.3.0
 * (schema/session-message.ts), for reviewer fixture tests. Times are the
 * encoded `time.created` milliseconds.
 */
export const DECLINED = { type: "aborted", message: "The user declined this tool call" } as const;
export const TOOLS_INTERRUPTED = { type: "aborted", message: "Tool execution interrupted" } as const;
export const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const;
export const SHUTDOWN = { type: "aborted", message: "Interaction cancelled because the location shut down" } as const;
export const rejected = (message: string) => ({ type: "permission.rejected", message });
/** A configured deny rule: permission.ts `BlockedError` without a hook reason. */
export const denied = (permission: string) => rejected(`Permission denied: ${permission}`);

type Extra = Record<string, unknown>;
type PartTime = { created: number; completed?: number };

export const v2 = {
  user: (id: string, text: string, created: number, extra: Extra = {}) => ({ type: "user", id, text, time: { created }, ...extra }),
  /** Tool parts without a `time` get the message's creation time as both start and end. */
  assistant: (id: string, created: number, content: unknown[] = [], extra: Extra = {}) => ({
    type: "assistant", id, agent: "build", model: { providerID: "opencode", id: "model" },
    content: content.map((part) => (part as Extra).type === "tool" && !(part as Extra).time ? { ...(part as Extra), time: { created, completed: created } } : part),
    time: { created }, ...extra,
  }),
  /** A shell tool part that ended with `error`; OpenCode sets `time.completed` when it fails. */
  failedShell: (id: string, command: string, error: unknown, workdir?: string, time?: PartTime) => ({
    type: "tool", id, name: "shell",
    state: { status: "error", input: { command, ...(workdir === undefined ? {} : { workdir }) }, error },
    ...(time === undefined ? {} : { time }),
  }),
  /** v2.3.0 tool/plugin/skill.ts: a completed `skill` call whose content is the skill text. */
  skillTool: (id: string, skill: string, text: string) => ({
    type: "tool", id, name: "skill",
    state: { status: "completed", input: { id: skill }, content: [{ type: "text", text }], metadata: { name: skill, directory: "/skills" } },
  }),
  /** A session skill activation. */
  skill: (id: string, name: string, text: string, created: number) => ({ type: "skill", id, skill: name, name, text, time: { created } }),
  /** v2.0.20 stores the verbatim text in `recent`; v2.3.0 rebuilds it into `metadata.recent`. */
  compaction: (id: string, summary: string, created: number, recent = "", host: "v2.0.20" | "v2.3.0" = "v2.3.0") => ({
    type: "compaction", id, status: "completed", reason: "auto", summary, time: { created },
    ...(host === "v2.0.20" ? { recent } : { metadata: { keepID: "msg_kept", recent } }),
  }),
  file: (name: string, mime: string, text: string) => ({
    data: Buffer.from(text).toString("base64"), mime, name, source: { type: "inline" },
  }),
  /** prompt.ts `FileAttachment` from a `uri`: the session still stores the content in `data`. */
  uriFile: (uri: string, mime: string, text: string) => ({
    data: Buffer.from(text).toString("base64"), mime, source: { type: "uri", uri },
  }),
  /** v2.3.0 prompt.ts `MediaFileAttachment`: the bytes stay on the server, so there is no `data`. */
  mediaFile: (name: string, mime: string) => ({ uri: `media:${"ab".repeat(32)}`, mime, name, source: { type: "inline" } }),
};
