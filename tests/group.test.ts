import { describe, expect, test } from "bun:test";
import { hasOpaqueConstruct, leadingBinary, resolveGroup, splitSegments } from "../src/command-policy.ts";

type RelaxationGroup = { binaries: string[]; allowPaths: string[] };

const groups: Record<string, RelaxationGroup> = {
  ssh: { binaries: ["git", "ssh", "gh"], allowPaths: [".ssh"] },
  kube: { binaries: ["kubectl", "helm"], allowPaths: [".kube"] },
  aws: { binaries: ["aws", "terraform", "tofu"], allowPaths: [".aws"] },
};

// Only relaxationGroups affects group resolution; the remaining fields satisfy
// the production GuardConfig shape used by the exported helper.
const config = {
  secretPatterns: ["/\\.kube/", "/\\.ssh/", "\\.env$", "/secrets/"],
  secretExceptions: ["/\\.env\\.example$"],
  artifactAllowlist: [],
  relaxationGroups: groups,
  denyRoots: [],
  exemptRoots: [],
  secretEnvironment: [],
  cacheTtlMs: 0,
};

const group = (command: string) => resolveGroup(command, config);

describe("splitSegments", () => {
  test("splits on every control operator", () => {
    expect(splitSegments("a && b || c ; d | e")).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("splits on newline and background operator", () => {
    expect(splitSegments("a\nb & c")).toEqual(["a", "b", "c"]);
  });

  test("does not split inside single quotes", () => {
    expect(splitSegments("echo 'a && b'")).toEqual(["echo 'a && b'"]);
  });

  test("does not split inside double quotes", () => {
    expect(splitSegments('echo "a | b; c"')).toEqual(['echo "a | b; c"']);
  });

  test("honours backslash escapes", () => {
    expect(splitSegments("echo a\\;b")).toEqual(["echo a\\;b"]);
  });

  test("returns null for unbalanced quoting", () => {
    expect(splitSegments("echo 'unterminated")).toBeNull();
  });

  test.each([
    ["git log 2>&1", ["git log 2>&1"]],
    ["git log >&2", ["git log >&2"]],
    ["git log &>/tmp/x", ["git log &>/tmp/x"]],
    ["git log 2>>&1", ["git log 2>>&1"]],
    ["git log 2>&1 | tail -30", ["git log 2>&1", "tail -30"]],
  ])("keeps the redirection operator in %s intact", (command, expected) => {
    expect(splitSegments(command)).toEqual(expected);
  });

  test("still splits a background operator that follows a redirection target", () => {
    expect(splitSegments("git log >file & cat x")).toEqual(["git log >file", "cat x"]);
  });

  // Verified against /bin/zsh, the shell the guard execs: `>& word` writes both
  // streams to a *file* named `word`, so nothing after it is executed and the
  // trailing path is just an argument to the leading command.
  test("treats a word after >& as a redirection target, not a command", () => {
    expect(splitSegments("git status >& out ~/.ssh/id_ed25519")).toEqual([
      "git status >& out ~/.ssh/id_ed25519",
    ]);
  });
});

describe("leadingBinary", () => {
  test("reads a bare command", () => {
    expect(leadingBinary("kubectl get pods")).toBe("kubectl");
  });

  test("reduces an absolute path to its basename", () => {
    expect(leadingBinary("/usr/bin/git status")).toBe("git");
  });

  test("skips environment assignments", () => {
    expect(leadingBinary("FOO=bar BAZ=qux git status")).toBe("git");
  });

  test("skips quoted environment assignments", () => {
    expect(leadingBinary('MSG="a b" git status')).toBe("git");
  });

  test("unwraps rtk", () => {
    expect(leadingBinary("rtk git status")).toBe("git");
  });

  test("unwraps nested transparent wrappers", () => {
    expect(leadingBinary("nohup rtk kubectl get pods")).toBe("kubectl");
  });

  test("refuses to look inside a subshell", () => {
    expect(leadingBinary("(cat /etc/hosts)")).toBeNull();
  });

  test("returns null for an empty segment", () => {
    expect(leadingBinary("   ")).toBeNull();
  });
});

describe("hasOpaqueConstruct — expansion the segment scan cannot see", () => {
  test.each([
    ["bare substitution", "kubectl get $(cat ~/.kube/config)"],
    ["bare backtick", "kubectl get `cat /tmp/verb`"],
    ["substitution inside double quotes", 'git commit -m "$(cat ~/.ssh/id_ed25519)"'],
    ["backtick inside double quotes", 'git commit -m "fix `cat ~/.ssh/id_ed25519`"'],
    ["escaped backslash then substitution", 'git commit -m "path\\\\$(cat /etc/hosts)"'],
    ["process substitution in", "kubectl apply -f <(cat ~/.kube/config)"],
    ["process substitution out", "git log > >(cat)"],
    ["zsh file substitution", "git diff =(cat ~/.ssh/id_ed25519)"],
    ["zsh glob qualifier execution", "kubectl /tmp/*(e:cat ~/.kube/config:)"],
    ["zsh glob qualifier alternate delimiter", "kubectl /tmp/*(e{cat ~/.kube/config})"],
    ["zsh explicit glob qualifier", "kubectl /tmp/*(#qe:cat ~/.kube/config:)"],
    ["zsh parameter flag evaluation", "kubectl ${(@e):-'cat ~/.kube/config'}"],
    ["quoted zsh parameter flag evaluation", "kubectl get \"${(e):-\\$(cat ~/.kube/config)}\""],
    ["substitution after a single-quoted run", "git commit -m 'literal' && git log $(x)"],
  ])("%s", (_label, command) => {
    expect(hasOpaqueConstruct(command)).toBe(true);
  });

  test.each([
    ["backtick inside single quotes", "git commit -m 'fix `2>&1` handling'"],
    ["escaped backtick inside double quotes", 'git commit -m "fix \\`2>&1\\` handling"'],
    ["escaped dollar inside double quotes", 'git commit -m "costs \\$(5)"'],
    ["substitution inside single quotes", "git commit -m 'use $(cmd) here'"],
    ["process substitution is literal in double quotes", 'git commit -m "see <(x) form"'],
    ["a lone dollar", 'git commit -m "costs $5"'],
    ["parentheses in prose", 'git commit -m "bump (1.60.0 -> 1.61.0)"'],
    ["the word eval", 'git commit -m "refactor eval handling"'],
    ["the word exec", 'git commit -m "document exec semantics"'],
    ["a branch named source-maps", "git push origin source-maps"],
    ["a sentence-ending dot", 'git commit -m "done . next"'],
  ])("%s", (_label, command) => {
    expect(hasOpaqueConstruct(command)).toBe(false);
  });
});

describe("resolveGroup — relaxation applies", () => {
  test.each([
    ["kubectl get pods", "kube"],
    ["helm list", "kube"],
    ["git push --dry-run", "ssh"],
    ["rtk git status", "ssh"],
    ["aws sts get-caller-identity", "aws"],
    ["kubectl --kubeconfig ~/.kube/config version", "kube"],
    ["git fetch && git rebase origin/main", "ssh"],
    ["terraform init && tofu plan", "aws"],
    ["cd /tmp/repo && git commit -F msg.txt", "ssh"],
    ["cd /tmp/repo; git push && cd -", "ssh"],
    ["git push 2>&1", "ssh"],
    ["git log 2>&1 | tail -30", "ssh"],
    ["kubectl get pods | head -5", "kube"],
    ["git log | cat", "ssh"],
    ["git log | wc -l", "ssh"],
    ["git log | tail -n 30", "ssh"],
    ["git log | sort -u | uniq -c", "ssh"],
    ["git log | rtk tail -30", "ssh"],
    ["cd /tmp/repo && rtk git commit -m x 2>&1 | rtk tail -30", "ssh"],
    ["kubectl get crd | rtk rg gateway.networking.k8s.io", "kube"],
    ["kubectl get pods |& rg gateway", "kube"],
    ["kubectl get pods |\n  rg gateway", "kube"],
    ["kubectl get pods | rg -i gateway", "kube"],
    ["kubectl get pods | rg 'gateway api'", "kube"],
    ["helm list | rg -A 3 name", "kube"],
    ["kubectl get pods | rg -e '^NAME'", "kube"],
    ["kubectl get pods | rg -efoo", "kube"],
    ["git log | grep foo", "ssh"],
    ["git log | grep -i fix", "ssh"],
    ["git log | rg fix | rg regex", "ssh"],
    ["kubectl get -o json | jq -r '.items[].name'", "kube"],
    ["kubectl get pods | jq --arg p x '.items[]'", "kube"],
    ["kubectl get crd | rg gateway | jq .", "kube"],
    ["aws s3 ls | jq -R .", "aws"],
    ["git commit -m 'fix `2>&1` handling'", "ssh"],
    ['git commit -m "fix \\`2>&1\\` handling"', "ssh"],
    ['git commit -m "refactor eval handling"', "ssh"],
    ["git push origin source-maps", "ssh"],
    ['git commit -m "line one\n\nline two"', "ssh"],
    ["git log --oneline -3 && echo done", "ssh"],
    ["git status || true", "ssh"],
    ["git fetch; printf '%s\\n' finished", "ssh"],
    ["kubectl get pods && :", "kube"],
    ["echo start && git push && echo end", "ssh"],
    ["sleep 45; kubectl -n finops get pods -o wide", "kube"],
    // The exact command reported as failing before `sleep` became inert. A
    // selector argument carries "/" and "=", which must not be mistaken for a
    // path operand: only the segment's binary decides the group.
    [
      "sleep 45; kubectl -n finops get pods -l app.kubernetes.io/name=finops-frontend -o wide",
      "kube",
    ],
  ])("%s -> %s", (command, expected) => {
    expect(group(command)).toBe(expected);
  });
});

describe("resolveGroup — falls back to strict", () => {
  test.each([
    ["a reader joins the chain", "kubectl version && cat ~/.kube/config"],
    ["a reader joins via semicolon", "git status; cat ~/.ssh/id_ed25519"],
    ["a reader joins via pipe", "kubectl get pods | tee out"],
    ["groups are mixed", "kubectl get pods && aws s3 ls"],
    ["command substitution is present", "kubectl get pods $(cat ~/.kube/config)"],
    ["a substitution hides in a double-quoted message", 'git commit -m "$(cat ~/.ssh/id_ed25519)"'],
    ["a backtick is present", "kubectl get `cat /tmp/verb`"],
    ["eval is present", "eval kubectl get pods"],
    ["exec is present", "exec kubectl get pods"],
    ["source is present", "source ~/.env && kubectl get pods"],
    ["dot-source is present", ". ~/.env && kubectl get pods"],
    ["process substitution is present", "kubectl apply -f <(cat ~/.kube/config)"],
    ["the binary belongs to no group", "cat README.md"],
    ["sudo is not transparent", "sudo kubectl get pods"],
    ["xargs hides the real command", "xargs kubectl get"],
    ["quoting is unbalanced", "kubectl get 'pods"],
    ["a subshell hides its contents", "(cat ~/.aws/credentials)"],
    ["an inert builtin alone grants nothing", "cd ~/.ssh"],
    ["echo alone grants nothing", "echo hello"],
    ["a redirection makes echo able to write", "echo x > ~/.ssh/config && git status"],
    ["a redirection makes an inert builtin able to write", "cd /tmp > ~/.ssh/config && git status"],
    ["a redirection makes sleep able to write", "sleep 1 > ~/.ssh/config && git status"],
    ["a heredoc body is scanned as commands", "git commit -F - <<'EOF'\nmessage body\nEOF"],
    ["a filter is given a path operand", "git log | cat ~/.ssh/id_ed25519"],
    ["a filter is given a relative operand", "git log | tail config"],
    ["a filter flag carries a path", "git log | sort -o/tmp/out"],
    ["a filter flag carries a path after =", "git log | tail --follow=~/.ssh/config"],
    ["a filter redirects into a granted path", "git log | cat > ~/.ssh/config"],
    ["a filter reads from a granted path", "git status && cat < ~/.ssh/id_ed25519"],
    ["a filter alone grants nothing", "tail -30"],
    ["a filter chain alone grants nothing", "cat | wc -l"],
    ["rg alone grants nothing", "rg foo"],
    ["grep alone grants nothing", "grep -r foo"],
    ["jq alone grants nothing", "jq ."],
    ["a pattern filter with a second operand", "kubectl get pods | rg x ~/.kube/config"],
    ["a pattern filter with a third operand", "git log | grep foo ~/.ssh/config"],
    ["a pattern filter reads an ordinary file", "kubectl get pods | rg x /tmp/pods.txt"],
    ["a pattern filter recursively searches a parent directory", "kubectl get pods | rg -uuu x ~"],
    ["a pattern filter follows a preceding cd", "cd ~/.kube && kubectl get pods | rg x config"],
    ["a pattern filter is not a pipe consumer", "kubectl get pods && rg --hidden x"],
    ["end-of-options keeps dash-leading patterns positional", "kubectl get pods | rg -- -x ~/.kube/config"],
    ["grep clustered -f reads a pattern file", "git log | grep -rf ~/.ssh/id_ed25519 ."],
    ["rg clustered -f reads a pattern file", "kubectl get pods | rg -uf ~/.kube/config"],
    ["jq clustered -f reads a filter file", "kubectl get pods | jq -nf ~/.kube/config"],
    ["a pattern filter has a leading environment assignment", "kubectl get pods | RIPGREP_CONFIG_PATH=/tmp/rg.conf rg x"],
    ["a group binary has a leading environment assignment", "GIT_SSH_COMMAND='cat ~/.ssh/id_ed25519' git fetch"],
    ["a kube binary has a leading environment assignment", "KUBECONFIG=/tmp/x kubectl get pods"],
    ["rg hostname command execution", "kubectl get pods | rg --hostname-bin=/tmp/steal --hyperlink-format=file://{host}/{path} x"],
    ["grep directories recurse mode", "kubectl get pods | grep --directories=recurse x"],
    ["jq test file mode", "kubectl get pods | jq --run-tests ~/.kube/config"],
    ["rg files mode searches the working tree", "kubectl get pods | rg --files"],
    ["grep recursive mode searches the working tree", "git log | grep -rn fix"],
    ["rg reads a pattern file", "git log | rg -f ~/.kube/config"],
    ["rg reads a pattern file attached", "git log | rg -f~/.kube/config"],
    ["grep reads a pattern file", "git log | grep --file=~/.kube/config x"],
    ["rg runs a preprocessor", "kubectl get pods | rg --pre 'cat ~/.kube/config'"],
    ["rg reads an ignore file", "kubectl get pods | rg --ignore-file ~/.kube/config x"],
    ["rg files mode operand is a path", "kubectl get pods | rg --files ~/.kube"],
    ["rg files-without-match operand is a path", "kubectl get pods | rg --files-without-match x ~/.kube"],
    ["grep reads an exclude-from file", "git log | grep --exclude-from=~/.kube/config x"],
    ["grep -e with a path operand", "git log | grep -e foo ~/.kube/config"],
    ["jq with a file operand", "kubectl get pods -o json | jq . ~/.kube/config"],
    ["a search of a secret path in a compound", "kubectl get pods > /tmp/agent-temporary-workspace/pods.txt && rg x /tmp/agent-temporary-workspace/pods.txt ~/.kube/config"],
    ["a jq secret operand in a compound", "kubectl get crd -o json > /tmp/agent-temporary-workspace/crds.json && jq . ~/.kube/config"],
    ["an env-var file operand", 'kubectl get pods | rg x "$HOME/.kube/config"'],
    ["a glob file operand", "kubectl get pods | rg x '*.txt'"],
    ["a brace-expanded file operand", "kubectl get pods | rg x '{a,b}'"],
    ["a tilde file operand", "kubectl get pods | rg x ~/.kube/config"],
    ["jq slurpfile", "kubectl get pods | jq --slurpfile s ~/.kube/config ."],
    ["jq rawfile", "kubectl get pods | jq --rawfile s ~/.kube/config ."],
    ["jq filter from a file", "kubectl get pods | jq -f ~/.kube/config"],
    ["jq library path", "kubectl get pods | jq -L ~/.kube/config ."],
    ["a pattern filter redirects into a granted path", "kubectl get pods | rg x > ~/.kube/config"],
    ["a pattern filter reads from a granted path", "kubectl get pods && rg < ~/.kube/config"],
    ["tee is not treated as an inert filter", "git log | tee out.txt"],
    ["sed is not treated as an inert filter", "git log | sed -n 1p"],
    ["awk is not treated as an inert filter", "git log | awk '{print}'"],
    ["less is not treated as an inert filter", "git log | less"],
    ["the command is empty", ""],
  ])("%s", (_label, command) => {
    expect(group(command)).toBeNull();
  });
});
