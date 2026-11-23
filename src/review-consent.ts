/**
 * A deterministic floor under the model's `read_only` and `local_reversible`
 * answers. It is an allow list: a command passes only when every segment runs
 * a program named here, with arguments its rule checked. Any other command
 * needs the user's own request, whatever the model answers. The floor only
 * removes the two relaxed bases, so it can only cause more prompts.
 */
import {
  analyzeSegments, AWK_ESCAPES, expandedNames, hasOpaqueConstruct, shellWords, stripHeredocs,
} from "./command-policy.ts";

/** Variables a prefix may set without changing which program runs or what it loads. */
const HARMLESS_VARIABLES = /^(CI|NO_COLOR|FORCE_COLOR|TERM|COLUMNS|LINES|LANG|LC_[A-Z]+|TZ|NODE_ENV|RUST_BACKTRACE|PYTHONUNBUFFERED)=|^(GIT_)?PAGER=cat\s/;

/**
 * A program name zsh resolves only one way: no quotes, escapes, expansions,
 * paths, or capitals, which the case-insensitive macOS file system would match.
 */
const PLAIN_NAME = /^[a-z0-9][a-z0-9._+-]*$/;

/** Wrappers that run the next word as the program. */
const WRAPPERS = new Set(["time", "nohup", "command", "builtin"]);

/**
 * Tools `rtk` proxies with the tool's own arguments. Its other subcommands,
 * such as `rtk test` or `rtk run`, run any command.
 */
const RTK_TOOLS = new Set(["git", "gh", "ls", "grep", "rg", "find", "diff", "cargo", "go", "kubectl", "tsc", "eslint",
  "prettier", "vitest", "jest", "pytest"]);

/** The program a segment runs and its arguments, or null when either is unclear. */
function program(segment: string): { name: string; args: string } | null {
  let rest = segment;
  for (;;) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"$`\\]*"|'[^']*'|[^\s"'$`\\]*)\s+/.exec(rest);
    if (!assignment) break;
    if (!HARMLESS_VARIABLES.test(assignment[0])) return null;
    rest = rest.slice(assignment[0].length);
  }
  for (let guard = 0; guard < 4; guard++) {
    const token = /^\S+/.exec(rest)?.[0];
    if (!token || !PLAIN_NAME.test(token)) return null;
    rest = rest.slice(token.length).trimStart();
    if (token === "rtk") {
      if (!RTK_TOOLS.has(/^\S+/.exec(rest)?.[0] ?? "")) return null;
      continue;
    }
    if (!WRAPPERS.has(token)) return { name: token, args: rest };
    if (rest.startsWith("-")) return null;
  }
  return null;
}

/**
 * Output redirections other than copies to standard output or error and
 * `/dev/null` write files. Input redirections only read.
 */
function writesFile(segment: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") i++;
    else if (c === "'" || c === '"') quote = c;
    else if (c === ">") {
      const rest = segment.slice(i + 1);
      if (/^&[12](?![\w.\/-])/.test(rest) || /^>?\s*\/dev\/null(?![\w.\/-])/.test(rest)) continue;
      return true;
    }
  }
  return false;
}

/** The arguments without redirections and their targets, which `writesFile` checked. */
function withoutRedirections(args: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (quote) {
      out += c;
      if (c === "\\" && quote === '"') out += args[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      out += c + (args[++i] ?? "");
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      continue;
    }
    if (c !== "<" && c !== ">" && !(c === "&" && args[i + 1] === ">")) {
      out += c;
      continue;
    }
    out = out.replace(/(^|\s)\d+$/, "$1");
    while (/[<>&|-]/.test(args[i + 1] ?? "")) i++;
    while (/\s/.test(args[i + 1] ?? "")) i++;
    let target: string | null = null;
    while (i + 1 < args.length) {
      const d = args[i + 1]!;
      if (!target && /\s/.test(d)) break;
      i++;
      if (target) {
        if (d === target) target = null;
      } else if (d === "'" || d === '"') target = d;
      else if (d === "\\") i++;
    }
    out += " ";
  }
  return out;
}

/**
 * True when an argument has an unquoted glob or brace expansion. Either can
 * turn a file name such as `--output=x` into an option.
 */
function expands(args: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") i++;
    else if (c === "'" || c === '"') quote = c;
    else if (c === "*" || c === "?" || c === "[") return true;
    else if (c === "{" && /^\{[^\s}]*(,|\.\.)/.test(args.slice(i))) return true;
  }
  return false;
}

const positionals = (words: string[]) => words.filter((word) => !word.startsWith("-") || word === "-");

/**
 * True when an option before `--` may be one of the `long` options or carries
 * one of the `short` letters. A long option matches by prefix, since git and
 * others accept any unambiguous prefix. A short letter matches inside a bundle
 * such as `-dr`.
 */
function mentions(words: string[], long: string[], short = ""): boolean {
  for (const word of words) {
    if (word === "--") return false;
    if (word.startsWith("--")) {
      const name = word.slice(2).split("=")[0]!;
      if (long.some((option) => option.startsWith(name))) return true;
    } else if (word.startsWith("-") && [...word.slice(1)].some((letter) => short.includes(letter))) return true;
  }
  return false;
}

/**
 * True when every option is in `allowed`. A long entry also matches its
 * `--name=value` form, and an entry ending in `*` matches by prefix, such as
 * `-j*` for `-j8`. `--` is an option here, so a rule must allow it by name.
 */
function onlyOptions(words: string[], allowed: string[]): boolean {
  return words.every((word) =>
    !word.startsWith("-") || word === "-" ||
    allowed.some((option) =>
      option.endsWith("*")
        ? word.startsWith(option.slice(0, -1))
        : word === option || (option.startsWith("--") && word.startsWith(`${option}=`))));
}

/**
 * The first word that is not an option, and the words after it. Every option
 * before it must be one of `flags`, or one of `values` with its value.
 */
function leading(words: string[], flags: string[] = [], values: string[] = []): { name: string; rest: string[] } | null {
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (!word.startsWith("-")) return { name: word, rest: words.slice(i + 1) };
    if (flags.includes(word)) continue;
    if (values.includes(word)) i++;
    else if (!values.some((value) => value.startsWith("--") && word.startsWith(`${value}=`))) return null;
  }
  return null;
}

type Rule = (words: string[], depth: number) => boolean;

/** Git subcommands that only read. */
const GIT_READS = new Set([
  "status", "log", "diff", "show", "ls-files", "ls-tree", "rev-parse", "rev-list", "describe", "blame", "grep",
  "shortlog", "cat-file", "merge-base", "name-rev", "for-each-ref", "count-objects", "version", "check-ignore",
  "check-attr", "range-diff", "whatchanged", "diff-tree", "show-ref",
]);
/** Options of the reading subcommands that write a file or run a program. */
const GIT_READ_RISKS = ["output", "ext-diff", "open-files-in-pager"];

function git(words: string[]): boolean {
  const command = leading(words, ["--no-pager", "-P", "--no-optional-locks"], ["-C"]);
  if (!command) return false;
  const { name, rest } = command;
  const first = positionals(rest)[0];
  if (GIT_READS.has(name)) return !mentions(rest, GIT_READ_RISKS, name === "grep" ? "O" : "");
  switch (name) {
    // A refspec with a colon can overwrite a local branch.
    case "fetch":
      return !mentions(rest, ["upload-pack", "prune-tags", "stdin"], "P") &&
        rest.every((word) => word === first || !word.includes(":"));
    case "add":
      return !mentions(rest, ["edit", "patch", "interactive"], "epi");
    case "init":
      return !mentions(rest, ["template", "separate-git-dir"]);
    case "branch":
      return !mentions(rest, ["delete", "delete-merged", "force", "move", "copy", "set-upstream", "set-upstream-to",
        "unset-upstream", "edit-description"], "dDfmMcCu");
    // Without `-b`, a checkout can discard changes to the paths it names.
    case "checkout":
      return rest.includes("-b") && positionals(rest).length <= 2 &&
        onlyOptions(rest, ["-b", "-q", "--quiet", "-t", "--track", "--no-track"]);
    case "switch":
      return positionals(rest).length <= 2 && onlyOptions(rest, ["-c", "--create", "-q", "--quiet", "-t", "--track",
        "--no-track", "-d", "--detach", "--guess", "--no-guess"]);
    case "stash":
    case "reflog":
      return (first === "list" || first === "show" || (name === "reflog" && first === undefined)) &&
        !mentions(rest, GIT_READ_RISKS);
    // `--contains`, `--points-at`, `--merged` and `-n` imply `--list`.
    case "tag":
      return (rest.length === 0 || rest.some((word) => /^(-l|--list|-n\d*|--(no-)?(contains|merged)|--points-at)(=|$)/.test(word))) &&
        onlyOptions(rest, ["-l", "--list", "-n*", "--sort", "--format", "--contains", "--no-contains", "--points-at",
          "--merged", "--no-merged", "-i", "--ignore-case", "--column", "--no-column"]);
    case "remote":
      return (first === undefined || first === "show" || first === "get-url") &&
        onlyOptions(rest, ["-v", "--verbose", "-n", "--push", "--all"]);
    // With one name and no action, `git config` reads it.
    case "config": {
      const names = positionals(rest);
      const reads = first === "get" || first === "list" || names.length === 1 ||
        rest.some((word) => ["--get", "--get-all", "--get-regexp", "-l", "--list"].includes(word));
      return reads && !["set", "unset", "rename-section", "remove-section", "edit"].includes(first ?? "") &&
        onlyOptions(rest, ["--get", "--get-all", "--get-regexp", "-l", "--list", "--local", "--global", "--system",
          "--worktree", "--show-origin", "--show-scope", "--name-only", "-z", "--null", "--type", "--bool", "--int",
          "--path", "--default", "--includes", "--no-includes", "--all", "--regexp", "--value"]);
    }
    case "worktree":
      if (first === "list") return onlyOptions(rest, ["--porcelain", "-v", "--verbose", "-z"]);
      return first === "add" && onlyOptions(rest, ["-b", "--detach", "-d", "-q", "--quiet", "--checkout",
        "--no-checkout", "--lock", "--track", "--no-track", "--guess-remote", "--no-guess-remote"]);
    case "submodule":
      return first === "status" && onlyOptions(rest, ["--cached", "--recursive", "-q", "--quiet"]);
    default:
      return false;
  }
}

/** `gh` and `glab` command groups whose read verbs only read. */
const FORGE_GROUPS = new Set([
  "pr", "issue", "repo", "run", "workflow", "release", "label", "cache", "ruleset", "gist", "secret", "variable",
  "mr", "snippet", "ci", "pipeline", "job",
]);
const FORGE_READ_VERBS = new Set(["view", "list", "ls", "status", "diff", "checks", "watch"]);

/** `gh api` and `glab api` read only as a GET or HEAD without fields or input. */
function forgeApi(words: string[]): boolean {
  const flags = ["--paginate", "--slurp", "-i", "--include", "--silent", "--verbose"];
  const values = ["-H", "--header", "-q", "--jq", "-t", "--template", "--cache", "--hostname", "-p", "--preview"];
  const readMethod = (method: string | undefined) => /^(GET|HEAD)$/i.test(method ?? "");
  const endpoints: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (!word.startsWith("-")) endpoints.push(word);
    else if (word === "-X" || word === "--method") {
      if (!readMethod(words[++i])) return false;
    } else if (word.startsWith("-X") || word.startsWith("--method=")) {
      if (!readMethod(word.startsWith("-X") ? word.slice(2) : word.slice(9))) return false;
    } else if (values.includes(word)) i++;
    else if (!flags.includes(word) && !values.some((value) =>
      value.startsWith("--") ? word.startsWith(`${value}=`) : word.startsWith(value) && word.length > 2)) return false;
  }
  return endpoints.length === 1 && endpoints[0] !== "graphql";
}

function forge(tool: "gh" | "glab"): Rule {
  return (words) => {
    const command = leading(words, [], ["-R", "--repo"]);
    if (!command) return false;
    const { name, rest } = command;
    if (name === "api") return forgeApi(rest);
    if (name === "status" || name === "search") return true;
    const verb = rest[0];
    // `glab ci view` is an interactive view that can retry and cancel jobs.
    if (tool === "glab" && verb === "view" && ["ci", "pipeline", "job"].includes(name)) return false;
    return FORGE_GROUPS.has(name) && verb !== undefined && FORGE_READ_VERBS.has(verb);
  };
}

const KUBECTL_READS = new Set([
  "get", "describe", "logs", "explain", "api-resources", "api-versions", "version", "cluster-info", "top", "diff",
]);

function kubectl(words: string[]): boolean {
  // A kubeconfig can name a program to run, a server or token sends credentials
  // elsewhere, and the profile and dump options write files.
  if (words.some((word) => /^--(kubeconfig|token|server|profile-output|output-directory)(=|$)|^-s/.test(word))) return false;
  const command = leading(words, [], ["-n", "--namespace", "--context", "--cluster", "--request-timeout", "-v"]);
  if (!command) return false;
  const { name, rest } = command;
  const verb = rest[0];
  if (name === "config") return verb === "get-contexts" || verb === "current-context" || verb === "get-clusters";
  if (name === "auth") return verb === "can-i";
  if (name === "cluster-info") return !rest.includes("dump");
  return KUBECTL_READS.has(name);
}

/** `curl` reads when it only fetches HTTP or HTTPS URLs and sends no data or files. */
function curl(words: string[]): boolean {
  const flags = ["--silent", "--show-error", "--location", "--fail", "--fail-with-body", "--head", "--include",
    "--verbose", "--compressed"];
  const values = ["-A", "--user-agent", "-m", "--max-time", "--connect-timeout", "--retry"];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (!word.startsWith("-")) {
      if (word.includes("://") && !/^https?:\/\//i.test(word)) return false;
    } else if (word === "-H" || word === "--header") {
      if ((words[++i] ?? "@").startsWith("@")) return false;
    } else if (word === "-o" || word === "--output") {
      if (words[++i] !== "/dev/null") return false;
    } else if (word === "-w" || word === "--write-out") {
      if ((words[++i] ?? "%output").includes("%output")) return false;
    } else if (word === "-X" || word === "--request") {
      if (!/^(GET|HEAD)$/.test(words[++i] ?? "")) return false;
    } else if (values.includes(word)) i++;
    else if (!flags.includes(word) && !/^-[sSLfIiv]+$/.test(word)) return false;
  }
  return true;
}

const FIND_ACTIONS = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;

function awk(words: string[]): boolean {
  let i = 0;
  for (; i < words.length && words[i]!.startsWith("-"); i++) {
    const word = words[i]!;
    if (word === "-F" || word === "-v") i++;
    else if (!/^-[Fv]./.test(word)) return false;
  }
  const script = words[i];
  return script !== undefined && !AWK_ESCAPES.test(script);
}

/**
 * `sed` prints a line range, or applies one substitution with flags that
 * neither write a file nor run a command.
 */
function sed(words: string[]): boolean {
  if (words[0] === "-n" && /^\d+(,(\d+|\$))?p$/.test(words[1] ?? "")) return onlyOptions(words.slice(2), []);
  const script = words.findIndex((word) => !word.startsWith("-"));
  return script >= 0 && onlyOptions(words.slice(0, script), ["-E", "-r"]) && onlyOptions(words.slice(script + 1), []) &&
    /^s\/([^\/\\\n]|\\.)*\/([^\/\\\n]|\\.)*\/[gIi0-9]*$/.test(words[script]!);
}

/** `printf -v` sets a variable such as `PATH` or `HOME` for the segments after it. */
const printf: Rule = (words) => !words[0]?.startsWith("-") || words[0] === "--";

/** True when a word names standard input or a device, from which a runtime would read code. */
const fromDevice = (word: string) => word === "-" || word.startsWith("/dev/");

/** `node` runs a script file or its test runner, never code from the command line or standard input. */
function node(words: string[]): boolean {
  const files = positionals(words);
  return onlyOptions(words, ["--test", "--test-name-pattern", "--test-skip-pattern", "--test-only",
    "--test-concurrency", "--test-timeout", "--experimental-strip-types", "--no-warnings", "--enable-source-maps"]) &&
    !files.some(fromDevice) && (words.includes("--test") || files.length > 0);
}

const PYTHON_MODULES = new Set(["pytest", "unittest", "mypy", "black", "ruff", "isort"]);
const python: Rule = (words, depth) =>
  words[0] === "-m" && PYTHON_MODULES.has(words[1] ?? "") && runner(words.slice(2), depth);

interface PackageManager {
  flags: string[];
  values: string[];
  /** Subcommands that run the project's scripts or tests, or only read. */
  runs: Set<string>;
  /** Subcommands that install the locked dependencies when given no package. */
  installs: Set<string>;
}

const PACKAGE_MANAGERS: Record<string, PackageManager> = {
  npm: {
    flags: ["--workspaces", "-ws", "-s", "--silent"],
    values: ["-w", "--workspace", "--prefix"],
    runs: new Set(["test", "t", "tst", "run", "run-script", "ls", "list", "outdated", "view", "info", "why", "explain"]),
    installs: new Set(["ci", "install", "i"]),
  },
  pnpm: {
    flags: ["-r", "--recursive", "-w", "--workspace-root", "-s", "--silent"],
    values: ["--filter", "-F", "-C", "--dir"],
    runs: new Set(["test", "t", "run", "ls", "list", "why", "outdated"]),
    installs: new Set(["install", "i"]),
  },
  yarn: {
    flags: ["-s", "--silent"],
    values: ["--cwd"],
    runs: new Set(["test", "run", "list", "why", "info"]),
    installs: new Set(["install"]),
  },
  bun: { flags: [], values: [], runs: new Set(["test", "run", "build"]), installs: new Set(["install", "i"]) },
};

function packageManager(manager: PackageManager): Rule {
  return (words) => {
    const command = leading(words, manager.flags, manager.values);
    if (!command) return false;
    if (manager.runs.has(command.name)) {
      // `bun run -`, `/dev/stdin` and `--eval` run code that is not in the project.
      return !command.rest.some((word) => fromDevice(word) || /^(-e|-p|--eval|--print)(=|$)/.test(word));
    }
    return manager.installs.has(command.name) && positionals(command.rest).length === 0 &&
      !mentions(command.rest, ["global", "location"], "g");
  };
}

/** One subcommand from `allowed`, with no option before it and none of `risks` after it. */
function subcommand(allowed: string[], risks: string[] = [], short = ""): Rule {
  return (words) => {
    const command = leading(words);
    return command !== null && allowed.includes(command.name) && !mentions(command.rest, risks, short);
  };
}

/** `go` builds and tests the project; a module path with a version fetches code to run. */
function go(words: string[]): boolean {
  const command = leading(words);
  if (!command || !["build", "test", "vet", "fmt", "run", "list", "version", "env"].includes(command.name)) return false;
  if (command.rest.some((word) => /^--?(exec|toolexec|vettool|o)(=|$)/.test(word))) return false;
  if (command.name === "run" && command.rest.some((word) => word.includes("@"))) return false;
  return command.name !== "env" || !command.rest.some((word) => /^--?[wu](=|$)/.test(word));
}

/** `make` runs the project's targets; a variable assignment can replace the commands they run. */
function make(words: string[]): boolean {
  return positionals(words).every((word) => !word.includes("=")) &&
    onlyOptions(words, ["-j*", "--jobs*", "-k", "--keep-going", "-s", "--silent", "-n", "--dry-run", "-B",
      "--always-make", "-C*", "--directory", "-q", "--question", "--no-print-directory"]);
}

/**
 * Options of `nix` commands that build or evaluate the project. Others can
 * set hooks that run programs, evaluate code from the command line, or
 * replace a path with a link.
 */
const NIX_OPTIONS = [
  "-L", "--print-build-logs", "--no-link", "--json", "--dry-run", "--rebuild", "--keep-going", "-k",
  "-v", "-vv", "-vvv", "--quiet", "--show-trace", "--print-out-paths", "--all-systems",
  "--no-write-lock-file", "--no-update-lock-file", "--offline", "-j", "--max-jobs", "--cores", "--raw",
  "--log-format", "--extra-experimental-features", "--experimental-features", "--override-input", "--recursive", "-r",
  "--derivation",
];

function nix(words: string[]): boolean {
  if (words.length === 1 && words[0] === "--version") return true;
  const command = leading(words, [], ["--extra-experimental-features", "--experimental-features"]);
  if (!command || !onlyOptions(command.rest, NIX_OPTIONS)) return false;
  const { name, rest } = command;
  if (name === "flake") return ["check", "show", "metadata"].includes(rest[0] ?? "");
  return ["build", "eval", "log", "path-info", "fmt", "search", "why-depends"].includes(name);
}

/**
 * `nix-shell -p` with plain package names, whose `--run` command must pass the
 * floor too. Without `-p`, a positional names a Nix file to evaluate.
 */
function nixShell(words: string[], depth: number): boolean {
  let packages = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "-p" || word === "--packages") packages = true;
    else if (word === "--pure") continue;
    else if (word === "--run" || word === "--command") {
      const inner = words[++i];
      if (inner === undefined || !allows(inner, depth + 1)) return false;
    } else if (!packages || word.startsWith("-") || !/^[A-Za-z0-9_.+-]+$/.test(word)) return false;
  }
  return packages;
}

function terraform(words: string[]): boolean {
  const rest = words[0]?.startsWith("-chdir=") ? words.slice(1) : words;
  const command = leading(rest);
  return command !== null &&
    ["fmt", "validate", "plan", "version", "init", "providers", "graph", "show"].includes(command.name) &&
    !command.rest.some((word) => /^--?(migrate-state|force-copy|out)(=|$)/.test(word));
}

/**
 * `docker build` and `podman build` of a local context with options that
 * neither expose credentials and other directories nor write files.
 */
function containers(words: string[]): boolean {
  const command = leading(words);
  if (!command) return false;
  const { name, rest } = command;
  if (["ps", "images", "logs", "inspect", "version", "info"].includes(name)) return true;
  if (name !== "build") return false;
  const values = ["-t", "--tag", "-f", "--file", "--target", "--build-arg", "--platform", "--progress"];
  const flags = ["--no-cache", "--pull", "-q", "--quiet", "--load"];
  const contexts: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    if (values.includes(word)) {
      if (word === "-f" || word === "--file") contexts.push(rest[i + 1] ?? "-");
      i++;
    } else if (!word.startsWith("-")) contexts.push(word);
    else if (!flags.includes(word) && !values.some((value) => value.startsWith("--") && word.startsWith(`${value}=`))) {
      return false;
    }
  }
  return contexts.every((path) => path !== "-" && !/:\/\/|^git@|^github\.com\//.test(path));
}

/**
 * Options of formatters, linters, type checkers and test runners that write
 * output, cache or temporary files, which a runner may first delete. Names
 * are compared in lower case, since `tsc` ignores case.
 */
const RUNNER_PATH_OPTION = /^--?[\w.-]*(output|outfile|dir|temp|cache|destination|trace|location)|^--?out(=|$)/;

/** A path outside the working directory, alone or as an option's value. */
const OUTSIDE_PATH = /(^|=)(\/|~)|(^|[=\/])\.\.(\/|$)/;

/**
 * Formatters, linters, type checkers and test runners. They run project code
 * and may rewrite project files, which the user accepted as local and
 * reversible. They may not write elsewhere or choose a directory to delete.
 */
const runner: Rule = (words) => !words.some((word) =>
  RUNNER_PATH_OPTION.test(word.toLowerCase()) || /^-[a-z]*o/i.test(word) || OUTSIDE_PATH.test(word));

/** Programs that cannot write, delete or reach a remote host by any option. */
const READERS = new Set([
  "ls", "cat", "head", "tail", "wc", "stat", "du", "df", "pwd", "echo", "true", "false", "cd", "pushd",
  "popd", "which", "basename", "dirname", "realpath", "readlink", "date", "uname", "whoami", "id", "sleep", "test",
  "grep", "egrep", "fgrep", "diff", "cmp", "comm", "cut", "tr", "nl", "column", "fold", "paste", "rev", "md5",
  "md5sum", "shasum", "sha1sum", "sha256sum", "mkdir", "touch", "jq",
]);

const RUNNERS = [
  "tsc", "eslint", "prettier", "biome", "ruff", "black", "isort", "mypy", "pyright", "pytest", "vitest", "jest",
  "mocha", "gofmt", "rustfmt", "shellcheck", "shfmt", "nixfmt", "alejandra", "statix", "deadnix", "markdownlint",
  "markdownlint-cli2", "golangci-lint", "actionlint", "hadolint", "yamllint", "tflint", "stylua", "clang-format",
  "swiftformat", "swiftlint", "ktlint", "rubocop",
];

/** `uniq` writes its second file operand. */
function uniq(words: string[]): boolean {
  let files = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "-f" || word === "-s" || word === "-w") i++;
    else if (!word.startsWith("-") || word === "-") files++;
  }
  return files <= 1;
}

const RULES: Record<string, Rule> = {
  ...Object.fromEntries(RUNNERS.map((name) => [name, runner])),
  git,
  gh: forge("gh"),
  glab: forge("glab"),
  kubectl,
  curl,
  printf,
  find: (words) => !words.some((word) => FIND_ACTIONS.test(word)),
  fd: (words) => !mentions(words, ["exec", "exec-batch"], "xX"),
  rg: (words) => !mentions(words, ["pre", "hostname-bin"]),
  sort: (words) => !mentions(words, ["output", "compress-program"], "o"),
  uniq,
  awk,
  gawk: awk,
  sed,
  node,
  python,
  python3: python,
  ...Object.fromEntries(Object.entries(PACKAGE_MANAGERS).map(([name, manager]) => [name, packageManager(manager)])),
  cargo: subcommand(["build", "b", "test", "t", "check", "c", "clippy", "fmt", "doc", "d", "bench", "run", "r", "tree",
    "metadata", "nextest"], ["fix", "config"], "Z"),
  go,
  make,
  nix,
  "nix-shell": nixShell,
  terraform,
  tofu: terraform,
  docker: containers,
  podman: containers,
  helm: subcommand(["template", "lint", "list", "ls", "status", "get", "show", "version", "search", "history"],
    ["kubeconfig", "kube-token", "kube-apiserver", "post-renderer", "output-dir"]),
  swift: subcommand(["build", "test"]),
};

function segmentAllows(segment: string, depth: number): boolean {
  if (writesFile(segment)) return false;
  const parsed = program(segment);
  if (!parsed) return false;
  if (READERS.has(parsed.name)) return true;
  const rule = RULES[parsed.name];
  const args = withoutRedirections(parsed.args);
  // A glob, a brace or a variable can expand into an option this check never saw.
  if (!rule || expands(args) || expandedNames(args).length > 0) return false;
  const words = shellWords(args);
  return words !== null && rule(words, depth);
}

function allows(command: string, depth: number): boolean {
  if (depth > 2) return false;
  const stripped = stripHeredocs(command);
  if (stripped === null || hasOpaqueConstruct(stripped)) return false;
  // zsh splits words only on space, tab and newline, and joins a line ending
  // in a backslash to the next; the word scans here do neither.
  if (/[^\S \t\n]|\\\n/.test(stripped)) return false;
  const segments = analyzeSegments(stripped);
  return segments !== null && segments.length > 0 && segments.every((segment) => segmentAllows(segment.command, depth));
}

/** True when the command needs the user's own request, whatever the model answers. */
export function needsExplicitConsent(command: string): boolean {
  return !allows(command, 0);
}
