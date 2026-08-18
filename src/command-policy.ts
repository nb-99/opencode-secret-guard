import type { GuardConfig } from "./policy.ts";

/** Command wrappers that are transparent for the purpose of picking a group. */
export const UNWRAP_PREFIXES = new Set(["rtk", "command", "builtin", "nohup", "time"]);

/**
 * Builtins that cannot open a file, so they can neither read nor write anything
 * a relaxation grants. Segments invoking one are skipped when picking a group.
 *
 * Without this, `cd repo && git commit` falls back to the strict profile and
 * fails inside git — typically as an unrelated-looking gpg error about being
 * unable to read ~/.gnupg. `git log; echo done` failed the same way, and so did
 * `git status || true`. A redirection would let even these create or truncate a
 * file, so those segments are not skipped.
 */
export const INERT_BUILTINS = new Set([
  ":",
  "cd",
  "echo",
  "false",
  "popd",
  "printf",
  "pushd",
  "sleep",
  "true",
]);

/**
 * Filters whose normal job is to consume standard input. Their stdin is the
 * previous segment's stdout, which the caller could already read, so they add
 * no reach of their own — but unlike the builtins above they *can* open a file
 * when given one. A segment invoking one is therefore only skipped when none of
 * its arguments could name a path; see `isInertFilter`.
 *
 * Deliberately absent: `tee`, `sed` and `awk` write files or shell out; `less`
 * runs a preprocessor through LESSOPEN. `rg`, `grep` and `jq` are absent too,
 * but for a different reason — their first operand is a pattern, not a
 * filename — and they get their own rule in `isPatternFilter` below.
 */
export const PIPE_FILTERS = new Set([
  "cat",
  "column",
  "head",
  "nl",
  "rev",
  "sort",
  "tail",
  "tr",
  "uniq",
  "wc",
]);

/**
 * Pattern-first filters. They are skippable only as pipe consumers, with no
 * file operands or modes that search the working tree.
 */
export const PATTERN_FILTERS = new Set(["rg", "grep", "jq"]);

/**
 * Options of the pattern-first filters that read a file or run a command.
 * The value may be attached (`--file=…`, `-fpats`) or a separate token, but
 * the *presence* of the flag is the risk, so both forms are rejected without
 * having to parse the value. The short names also match their attached forms
 * (`-fFILE`, `-Ldir`).
 */
export const PATTERN_FILTER_PATH_FLAGS: Record<string, string[]> = {
  rg: ["-f", "--file", "--ignore-file", "--pre", "--hostname-bin"],
  grep: ["-f", "--file", "--exclude-from"],
  jq: ["-f", "--from-file", "-L", "--argfile", "--slurpfile", "--rawfile", "--run-tests"],
};

export const PATTERN_FILTER_SAFE_SHORT_FLAGS: Record<string, string> = {
  rg: "0FHIJLNUSVbchilnopqstuvwxz",
  grep: "EFGHILUVabcdehinoqsvwxyZ",
  jq: "MRSVacejmnrs",
};

export const PATTERN_FILTER_SAFE_LONG_FLAGS: Record<string, Set<string>> = {
  rg: new Set([
    "--case-sensitive",
    "--column",
    "--count",
    "--count-matches",
    "--crlf",
    "--fixed-strings",
    "--heading",
    "--ignore-case",
    "--invert-match",
    "--json",
    "--line-buffered",
    "--line-number",
    "--no-heading",
    "--no-line-number",
    "--no-messages",
    "--no-unicode",
    "--null",
    "--only-matching",
    "--passthru",
    "--pcre2",
    "--pretty",
    "--quiet",
    "--smart-case",
    "--text",
    "--trim",
    "--unrestricted",
    "--vimgrep",
    "--word-regexp",
  ]),
  grep: new Set([
    "--basic-regexp",
    "--byte-offset",
    "--count",
    "--extended-regexp",
    "--files-with-matches",
    "--files-without-match",
    "--fixed-strings",
    "--ignore-case",
    "--invert-match",
    "--line-buffered",
    "--line-number",
    "--no-filename",
    "--no-messages",
    "--null",
    "--null-data",
    "--only-matching",
    "--quiet",
    "--silent",
    "--text",
    "--unix-byte-offsets",
    "--with-filename",
    "--word-regexp",
    "--line-regexp",
  ]),
  jq: new Set([
    "--ascii-output",
    "--compact-output",
    "--exit-status",
    "--join-output",
    "--monochrome-output",
    "--null-input",
    "--raw-input",
    "--raw-output",
    "--seq",
    "--sort-keys",
    "--stream",
    "--unbuffered",
  ]),
};

export const PATTERN_FILTER_NUMERIC_FLAGS: Record<string, Set<string>> = {
  rg: new Set(["-A", "-B", "-C", "-m", "--after-context", "--before-context", "--context", "--max-count"]),
  grep: new Set(["-A", "-B", "-C", "-m", "--after-context", "--before-context", "--context", "--max-count"]),
  jq: new Set(["--indent"]),
};

/** Splits shell words while preserving quoted whitespace as one token. */
export function shellWords(input: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') current += input[++i] ?? "";
      else current += c;
      started = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\") {
      current += input[++i] ?? "";
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }

  if (quote) return null;
  if (started) words.push(current);
  return words;
}

/**
 * True when a piped rg, grep or jq segment can only consume standard input.
 * Any file operand, recursive/files mode, opaque environment assignment, or
 * path-bearing option keeps the entire command strict.
 */
export function isPatternFilter(
  segment: string,
  binary: string,
  args: string,
  receivesPipe: boolean,
  hasEnvironmentAssignments: boolean,
): boolean {
  if (!PATTERN_FILTERS.has(binary) || !receivesPipe || hasEnvironmentAssignments) return false;
  if (/[<>]/.test(segment)) return false;

  const pathFlags = PATTERN_FILTER_PATH_FLAGS[binary];
  const tokens = shellWords(args);
  if (!tokens) return false;

  const positionals: string[] = [];
  let patternsFromFlags = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") return false;
    if (token.startsWith("-")) {
      if (
        (binary === "rg" || binary === "grep") &&
        (/^-e\S/.test(token) || token.startsWith("--regexp="))
      ) {
        patternsFromFlags++;
        continue;
      }
      if (
        pathFlags.some(
          (flag) =>
            token === flag ||
            token.startsWith(flag + "=") ||
            (flag.length === 2 &&
              !token.startsWith("--") &&
              token.slice(1).includes(flag.slice(1))),
        )
      ) {
        return false;
      }
      if (binary === "rg" && (token === "--files" || token === "--files-without-match")) return false;
      if (
        binary === "grep" &&
        (token === "--recursive" ||
          token === "--dereference-recursive" ||
          token.startsWith("--directories") ||
          /^-[^-]*[rR]/.test(token))
      ) return false;
      if (
        (binary === "rg" || binary === "grep") &&
        (token === "-e" || token === "--regexp")
      ) {
        if (++i >= tokens.length) return false;
        patternsFromFlags++;
        continue;
      }
      if (binary === "jq" && (token === "--arg" || token === "--argjson")) {
        if (i + 2 >= tokens.length) return false;
        i += 2;
        continue;
      }
      if (PATTERN_FILTER_NUMERIC_FLAGS[binary].has(token)) {
        if (i + 1 >= tokens.length || !/^\d+$/.test(tokens[i + 1]!)) return false;
        i += 1;
        continue;
      }
      if (binary === "jq" && (token === "--args" || token === "--jsonargs")) return false;
      if (token.startsWith("--")) {
        if (!PATTERN_FILTER_SAFE_LONG_FLAGS[binary].has(token)) return false;
        continue;
      }
      const shortFlags = token.slice(1);
      if ([...shortFlags].some((flag) => !PATTERN_FILTER_SAFE_SHORT_FLAGS[binary].includes(flag))) {
        return false;
      }
      continue;
    }
    positionals.push(token);
  }

  return binary === "jq"
    ? positionals.length === 1
    : patternsFromFlags > 0
      ? positionals.length === 0
      : positionals.length === 1;
}

/**
 * True when the command can run something the segment scan cannot see, which
 * makes the every-segment rule meaningless: `kubectl version $(cat
 * ~/.kube/config)` shows one segment whose binary is `kubectl`, so without this
 * it would resolve to the `kube` group and hand the substitution a readable
 * `~/.kube`.
 *
 * The scan is quote-aware, because the same characters are literal text in most
 * of the places they appear. Judged per region, matching zsh:
 *
 * | region       | `` ` `` and `$(` | `<(` and `>(` |
 * | ------------ | ---------------- | ------------- |
 * | unquoted     | expands          | expands       |
 * | double-quote | expands          | literal       |
 * | single-quote | literal          | literal       |
 * | backslashed  | literal          | literal       |
 *
 * `eval`, `exec`, `source`, and `.` are deliberately *not* matched here. They
 * only run something when they lead a segment, and there `parseCommand` already
 * reports them as the binary, which belongs to no group — so `resolveGroup`
 * returns null through the ordinary rule. Matching them as text only ever
 * misfired on prose: `git commit -m "refactor eval handling"` and even
 * `git push origin source-maps` used to run strict.
 */
export function hasOpaqueConstruct(command: string): boolean {
  let quote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];

    // Single quotes take no escapes at all in zsh; only the closing quote ends.
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }

    // Outside single quotes a backslash makes the next character literal.
    if (c === "\\") {
      i++;
      continue;
    }

    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "`") return true;
      else if (c === "$" && next === "(") return true;
      else if (c === "$" && next === "{" && command[i + 2] === "(") return true;
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "`") return true;
    if (c === "$" && next === "(") return true;
    if (c === "$" && next === "{" && command[i + 2] === "(") return true;
    if ((c === "<" || c === ">") && next === "(") return true;
    if (c === "=" && next === "(") return true;
    if (c === "(") return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Command analysis
// ---------------------------------------------------------------------------

/**
 * Splits a command on shell control operators, respecting quoting. Returns null
 * when quoting is unbalanced, which callers must treat as "use strict".
 */
export interface CommandSegment {
  command: string;
  receivesPipe: boolean;
}

export function analyzeSegments(command: string): CommandSegment[] | null {
  const segments: CommandSegment[] = [];
  let current = "";
  let receivesPipe = false;
  let quote: string | null = null;

  const pushSegment = (nextReceivesPipe: boolean) => {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      segments.push({ command: trimmed, receivesPipe });
      receivesPipe = nextReceivesPipe;
    } else if (nextReceivesPipe) {
      receivesPipe = true;
    }
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;

    if (quote) {
      if (c === "\\" && quote === '"') {
        current += c + (command[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === quote) quote = null;
      current += c;
      continue;
    }

    if (c === "\\") {
      current += c + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }
    // An `&` that belongs to a redirection operator — `2>&1`, `>&2`, `&>file`
    // — is not a control operator, so splitting there would invent a segment
    // (`1`) whose leading "binary" belongs to no group and force strict mode.
    // Bash only writes `&` next to `>`/`<` in a redirection, so a real command
    // boundary can never hide here.
    if (c === "&" && (command[i + 1] === ">" || /[<>]\s*$/.test(current))) {
      current += c;
      continue;
    }
    if ((c === "&" || c === "|") && command[i + 1] === c) {
      pushSegment(false);
      i++;
      continue;
    }
    if (c === "&" || c === "|" || c === ";" || c === "\n") {
      pushSegment(c === "|");
      continue;
    }
    current += c;
  }

  if (quote) return null;
  pushSegment(false);

  return segments;
}

export function splitSegments(command: string): string[] | null {
  return analyzeSegments(command)?.map((segment) => segment.command) ?? null;
}

/**
 * Splits a segment into the binary it invokes and the arguments that follow,
 * skipping leading environment assignments and transparent wrappers such as
 * `rtk`. Returns null when the real command cannot be seen.
 */
export function parseCommand(
  segment: string,
): { binary: string; args: string; hasEnvironmentAssignments: boolean } | null {
  let rest = segment.trim();
  let hasEnvironmentAssignments = false;

  for (let guard = 0; guard < 16; guard++) {
    // Strip `FOO=bar` prefixes.
    for (;;) {
      const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/.exec(rest);
      if (!assignment) break;
      hasEnvironmentAssignments = true;
      rest = rest.slice(assignment[0].length);
    }

    const match = /^\S+/.exec(rest);
    if (!match) return null;

    const token = match[0];
    // A subshell or brace group hides its contents from this scan.
    if (token.startsWith("(") || token.startsWith("{")) return null;

    const base = token.replace(/^['"]+|['"]+$/g, "").split("/").pop();
    if (!base) return null;

    rest = rest.slice(match[0].length).trim();
    if (UNWRAP_PREFIXES.has(base)) continue;
    return { binary: base, args: rest, hasEnvironmentAssignments };
  }
  return null;
}

/**
 * Returns the basename of the binary a segment invokes, skipping leading
 * environment assignments and transparent wrappers such as `rtk`.
 */
export function leadingBinary(segment: string): string | null {
  return parseCommand(segment)?.binary ?? null;
}

/**
 * True when a segment runs a known filter in a shape that cannot open a file:
 * every argument is either a bare number (`tail -n 30`) or a flag with no path
 * character in it, and the segment carries no redirection. `sort -o/tmp/out`
 * and `cat < ~/.ssh/id_ed25519` both fail this test and keep the strict
 * profile.
 */
export function isInertFilter(segment: string, binary: string, args: string): boolean {
  if (!PIPE_FILTERS.has(binary)) return false;
  if (/[<>]/.test(segment)) return false;

  return args
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .every((token) => /^\d+$/.test(token) || (token.startsWith("-") && !/[/~=]/.test(token)));
}

/**
 * Picks the relaxation group for a command, or null for the strict profile.
 *
 * A group applies only when *every* segment invokes a binary from that same
 * group, or a builtin or filter that cannot open a file. This is what closes
 * the compound-command hole by construction: `kubectl version && cat
 * ~/.kube/config` names a path, so the whole command runs strict and the read
 * is denied by the kernel — while `kubectl get pods | cat` does not.
 */
export function resolveGroup(command: string, config: GuardConfig): string | null {
  if (hasOpaqueConstruct(command)) return null;

  const segments = analyzeSegments(command);
  if (!segments || segments.length === 0) return null;

  const binaryToGroup = new Map<string, string>();
  for (const [name, group] of Object.entries(config.relaxationGroups)) {
    for (const binary of group.binaries) binaryToGroup.set(binary, name);
  }

  let resolved: string | null = null;
  for (const segment of segments) {
    const parsed = parseCommand(segment.command);
    if (!parsed) return null;
    const { binary, args, hasEnvironmentAssignments } = parsed;
    if (hasEnvironmentAssignments) return null;
    if (INERT_BUILTINS.has(binary) && !/[<>]/.test(segment.command)) continue;
    if (isInertFilter(segment.command, binary, args)) continue;
    if (isPatternFilter(segment.command, binary, args, segment.receivesPipe, hasEnvironmentAssignments)) continue;
    const group = binaryToGroup.get(binary);
    if (!group) return null;
    if (resolved && resolved !== group) return null;
    resolved = group;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Profile construction
// ---------------------------------------------------------------------------

