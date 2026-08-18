#!/usr/bin/env bash
# Kernel-level tests for the generated sandbox profile.
#
# Every "deny" case asserts that the secret marker never reaches stdout/stderr,
# which is the property that actually matters — stronger and less brittle than
# checking exit codes, since tools such as grep exit non-zero for their own
# reasons. Every "allow" case asserts the public marker does come through.
#
# Must run outside the nix build sandbox: sandbox-exec is unavailable there.
set -uo pipefail

SECRET="S3CRET-LEAK-CANARY"
PUBLIC="PUBLIC-OK-MARKER"

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CONFIG="${OPENCODE_SECRET_GUARD_CONFIG:?OPENCODE_SECRET_GUARD_CONFIG must be set}"
GUARD_SHELL="${SECRET_GUARD_SHELL:?SECRET_GUARD_SHELL must be set}"

pass=0
fail=0
declare -a failures=()

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
scratch="$(cd "$scratch" && pwd -P)"
export XDG_CACHE_HOME="$scratch/cache"

# Nested sandboxes are refused by the kernel, and an outer guard profile denies
# the fixtures below. Probe before writing anything, so the failure names its
# cause instead of surfacing as EPERM during fixture setup.
printf '(version 1)\n(allow default)\n' > "$scratch/probe.sb"
if ! /usr/bin/sandbox-exec -f "$scratch/probe.sb" /usr/bin/true 2>/dev/null; then
  echo "FATAL: cannot apply a sandbox profile." >&2
  echo "  Run this suite outside opencode's guarded shell, from a plain terminal." >&2
  exit 2
fi

fixture="$scratch/repo"
public_fixture="$scratch/public-repo"
fakehome="$scratch/home"

# --- fixture -----------------------------------------------------------------
mkdir -p "$fixture"/{secrets,node_modules/pkg,dist,build,private-notes/nested,docs,infra,.opencode/node_modules/pkg}
# The vault lives outside the repo, as it does in production.
vault="$scratch/vault"
mkdir -p "$vault"/{memory,private}
mkdir -p "$fakehome"/{.ssh,.gnupg,.kube,.aws}
fakebin="$scratch/bin"
mkdir -p "$fakebin"

printf 'TOKEN=%s\n' "$SECRET" > "$fixture/.env"
printf 'TOKEN=%s\n' "$PUBLIC" > "$fixture/.env.example"
printf '%s\n' "$SECRET"       > "$fixture/id_rsa"
printf '%s\n' "$PUBLIC"       > "$fixture/id_rsa.pub"
printf '%s\n' "$SECRET"       > "$fixture/secrets/token"
printf '%s\n' "$SECRET"       > "$fixture/infra/prod.tfvars"
printf '%s\n' "$SECRET"       > "$fixture/node_modules/pkg/.env"
printf '%s\n' "$PUBLIC"       > "$fixture/node_modules/pkg/index.js"
printf '%s\n' "$PUBLIC"       > "$fixture/dist/app.js"
printf '%s\n' "$PUBLIC"       > "$fixture/build/out.txt"
printf '*\n'                   > "$fixture/.opencode/.gitignore"
printf '%s\n' "$PUBLIC"       > "$fixture/.opencode/node_modules/pkg/index.js"
printf '%s\n' "$SECRET"       > "$fixture/.opencode/node_modules/pkg/.env"
printf '%s\n' "$SECRET"       > "$fixture/.opencode/private.md"
printf '%s\n' "$SECRET"       > "$fixture/private-notes/note.md"
printf '%s\n' "$SECRET"       > "$fixture/private-notes/nested/deep.md"
printf '%s\n' "$SECRET"       > "$fixture/local.conf"
printf '%s\n' "$PUBLIC"       > "$fixture/README.md"
printf '%s\n' "$PUBLIC"       > "$fixture/docs/secret-rotation.md"
printf '%s\n' "$PUBLIC"       > "$vault/memory/index.md"
printf '%s\n' "$PUBLIC"       > "$vault/memory/.env"
printf '%s\n' "$SECRET"       > "$vault/private/journal.md"
ln -s "$fixture/.env" "$fixture/link-to-env"

printf '%s\n' "$SECRET" > "$fakehome/.ssh/id_ed25519"
printf '%s\n' "$SECRET" > "$fakehome/.gnupg/private-keys-v1.d"
printf '%s\n' "$SECRET" > "$fakehome/.kube/config"
printf '%s\n' "$SECRET" > "$fakehome/.aws/credentials"

cat > "$fakebin/kubectl" <<EOF
#!/bin/sh
printf '%s\n' '$PUBLIC' >&2
if [ "\$#" -gt 0 ] && [ -f "\$1" ]; then
  cat "\$1"
else
  cat "\$HOME/.kube/config"
fi
EOF
chmod +x "$fakebin/kubectl"

cat > "$fixture/.gitignore" <<'EOF'
.env
local.conf
private-notes/
node_modules/
dist/
build/
EOF

git init -q "$fixture"
git -C "$fixture" add -A >/dev/null 2>&1
ln -s "$fixture/.gitignore" "$fixture/.ignored-link"
printf '.ignored-link\n' >> "$fixture/.git/info/exclude"
mkdir -p "$public_fixture"
printf '%s\n' "$PUBLIC" > "$public_fixture/local.conf"
printf '%s\n' "$SECRET" > "$public_fixture/.env"
git init -q "$public_fixture"

# --- profiles ----------------------------------------------------------------
gen_profile() {
  SG_EXEMPT_ROOTS="$vault/memory" \
  SG_DENY_ROOTS="$vault" \
    bun "$REPO_ROOT/tests/secret-guard/gen-profile.ts" \
      "$CONFIG" "$fixture" "$fakehome" "$1"
}

strict="$scratch/strict.sb"
gen_profile - > "$strict" || { echo "FATAL: could not generate strict profile"; exit 1; }
for g in kube ssh aws; do
  gen_profile "$g" > "$scratch/$g.sb" || { echo "FATAL: could not generate $g profile"; exit 1; }
done

# --- harness -----------------------------------------------------------------
# $1 description, $2 command, $3 profile (default: strict)
expect_denied() {
  local description="$1" command="$2" profile="${3:-$strict}" output
  output="$(cd "$fixture" && HOME="$fakehome" sandbox-exec -f "$profile" \
    /bin/zsh -c "$command; cat README.md" 2>&1)"
  if [[ "$output" != *"$SECRET"* && "$output" == *"$PUBLIC"* ]]; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$description"
  else
    fail=$((fail + 1)); failures+=("DENIAL FAILED: $description -- $output")
    printf '  FAIL  %s -- %s\n' "$description" "$output"
  fi
}

expect_allowed() {
  local description="$1" command="$2" profile="${3:-$strict}" output
  output="$(cd "$fixture" && HOME="$fakehome" sandbox-exec -f "$profile" /bin/zsh -c "$command" 2>&1)"
  if [[ "$output" == *"$PUBLIC"* ]]; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$description"
  else
    fail=$((fail + 1)); failures+=("BLOCKED: $description -- $output")
    printf '  FAIL  %s -- %s\n' "$description" "$output"
  fi
}

# A relaxed profile must actually hand the credential over.
expect_readable() {
  local description="$1" command="$2" profile="$3" output
  output="$(cd "$fixture" && HOME="$fakehome" sandbox-exec -f "$profile" /bin/zsh -c "$command" 2>&1)"
  if [[ "$output" == *"$SECRET"* ]]; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$description"
  else
    fail=$((fail + 1)); failures+=("NOT RELAXED: $description -- $output")
    printf '  FAIL  %s -- %s\n' "$description" "$output"
  fi
}

# Denied files must still be stat-able: `ls` erroring on every secret would be
# a constant, useless nuisance.
expect_quiet() {
  local description="$1" command="$2" profile="${3:-$strict}" output
  output="$(cd "$fixture" && HOME="$fakehome" sandbox-exec -f "$profile" /bin/zsh -c "$command" 2>&1 >/dev/null)"
  if [[ -z "$output" ]]; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$description"
  else
    fail=$((fail + 1)); failures+=("NOISY: $description -- $output")
    printf '  FAIL  %s -- %s\n' "$description" "$output"
  fi
}

expect_shell_denied() {
  local description="$1" command="$2" output
  output="$(cd "$fixture" && HOME="$fakehome" PATH="$fakebin:$PATH" \
    "$GUARD_SHELL" -c "$command; cat README.md" 2>&1)"
  if [[ "$output" != *"$SECRET"* && "$output" == *"$PUBLIC"* ]]; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$description"
  else
    fail=$((fail + 1)); failures+=("SHELL DENIAL FAILED: $description -- $output")
    printf '  FAIL  %s -- %s\n' "$description" "$output"
  fi
}

# A command expected to resolve strict must not receive a credential. Unlike
# expect_shell_denied, this does not append an unrelated segment that would
# force strict regardless of the command under test.
expect_shell_strict() {
  local description="$1" command="$2" output
  output="$(cd "$fixture" && HOME="$fakehome" PATH="$fakebin:$PATH" \
    "$GUARD_SHELL" -c "$command" 2>&1)"
  if [[ "$output" != *"$SECRET"* && "$output" == *"$PUBLIC"* ]]; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$description"
  else
    fail=$((fail + 1)); failures+=("SHELL RELAXED: $description -- $output")
    printf '  FAIL  %s -- %s\n' "$description" "$output"
  fi
}

expect_shell_allowed() {
  local description="$1" command="$2" output
  output="$(cd "$fixture" && HOME="$fakehome" PATH="$fakebin:$PATH" "$GUARD_SHELL" -c "$command" 2>&1)"
  if [[ "$output" == *"$PUBLIC"* ]]; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$description"
  else
    fail=$((fail + 1)); failures+=("SHELL BLOCKED: $description -- $output")
    printf '  FAIL  %s -- %s\n' "$description" "$output"
  fi
}

echo "== direct reads must be denied =="
expect_denied "cat .env"                    'cat .env'
expect_denied "variable expansion"          'F=.env; cat $F'
expect_denied "glob expansion"              'cat .en?'
expect_denied "command substitution"        'cat $(echo .env)'
expect_denied "input redirection"           'base64 < .env'
expect_denied "here-string via read"        'read -r line < .env; echo $line'
expect_denied "dd"                          'dd if=.env 2>/dev/null'
expect_denied "strings"                     'strings .env'
expect_denied "xxd"                         'xxd .env'
expect_denied "sed"                         'sed -n 1p .env'
expect_denied "awk"                         'awk 1 .env'
expect_denied "perl"                        'perl -ne "print" .env'
expect_denied "python3"                     'python3 -c "print(open(\".env\").read())"'
expect_denied "ruby"                        'ruby -e "puts File.read(\".env\")" 2>/dev/null'
expect_denied "rg targeted"                 'rg --no-messages . .env'
expect_denied "rg recursive"                'rg --no-messages -uuu TOKEN .'
expect_denied "grep recursive"              'grep -rn TOKEN . 2>/dev/null'
expect_denied "find -exec"                  'find . -name ".env" -exec cat {} + 2>/dev/null'
expect_denied "tar to stdout"               'tar cf - .env 2>/dev/null'
expect_denied "cp then read"                'cp .env "'"$scratch"'/copy" 2>/dev/null; cat "'"$scratch"'/copy" 2>/dev/null'
expect_denied "symlink indirection"         'cat link-to-env'
expect_denied "secrets directory"           'cat secrets/token'
expect_denied "ssh private key"             'cat id_rsa'
expect_denied "tfvars"                      'cat infra/prod.tfvars'
expect_denied "secret in allowlisted dir"   'cat node_modules/pkg/.env'
expect_denied "secret in nested allowlist"  'cat .opencode/node_modules/pkg/.env'
expect_denied "ordinary nested ignored file" 'cat .opencode/private.md'
expect_denied "gitignored directory"        'cat private-notes/note.md'
expect_denied "nested gitignored directory" 'cat private-notes/nested/deep.md'
expect_denied "gitignored file"             'cat local.conf'
expect_denied "home ssh key"                'cat "$HOME/.ssh/id_ed25519"'
expect_denied "home kubeconfig"             'cat "$HOME/.kube/config"'
expect_denied "home aws credentials"        'cat "$HOME/.aws/credentials"'

echo "== writes to secrets must be denied =="
expect_denied "overwrite .env then read"    'echo "'"$PUBLIC"'" > .env 2>/dev/null; cat .env 2>/dev/null'
expect_denied "append to id_rsa"            'echo x >> id_rsa 2>/dev/null; cat id_rsa'

echo "== ordinary work must be unaffected =="
expect_allowed ".env.example exception"     'cat .env.example'
expect_allowed "system CA bundle exception" 'cat /etc/ssl/cert.pem >/dev/null && cat README.md'
expect_allowed "public key"                 'cat id_rsa.pub'
expect_allowed "readme"                     'cat README.md'
expect_allowed "listing the tree"           'ls -la >/dev/null && cat README.md'
expect_quiet   "ls -la produces no errors"  'ls -la'
expect_quiet   "listing an ignored directory" 'ls -la private-notes'
expect_quiet   "listing below an ignored directory" 'ls -la private-notes/nested'
expect_quiet   "find produces no errors"    'find . -type f'
expect_allowed "node_modules source"        'cat node_modules/pkg/index.js'
expect_allowed "dist artefact"              'cat dist/app.js'
expect_allowed "build artefact"             'cat build/out.txt'
expect_allowed "nested .gitignore"           'cat .opencode/.gitignore; cat README.md'
expect_allowed "nested node_modules source"  'cat .opencode/node_modules/pkg/index.js'
expect_allowed "filename containing secret" 'cat docs/secret-rotation.md'
expect_allowed "git works"                  'git status >/dev/null && cat README.md'
expect_quiet   "git status produces no errors" 'git status --short'
expect_allowed "writing a normal file"      'echo "'"$PUBLIC"'" > scratch.txt && cat scratch.txt'
expect_allowed "exempt root read"           'cat "'"$vault"'/memory/index.md"'
expect_allowed "exempt root overrides deny" 'cat "'"$vault"'/memory/.env"'
expect_allowed "exempt root write"          'echo "'"$PUBLIC"'" > "'"$vault"'/memory/new.md" && cat "'"$vault"'/memory/new.md"'
expect_denied  "deny root hides the vault"  'cat "'"$vault"'/private/journal.md"'
expect_denied  "deny root resists grep"     'grep -rn . "'"$vault"'" 2>/dev/null'
expect_denied  "deny root resists find"     'find "'"$vault"'" -name "*.md" -exec cat {} + 2>/dev/null'

echo "== recursive search must skip secrets but keep public hits =="
expect_allowed "rg still finds public"      'rg --no-messages -uuu "'"$PUBLIC"'" README.md'

echo "== relaxation profiles =="
expect_readable "kube profile reads kubeconfig"  'cat "$HOME/.kube/config"'      "$scratch/kube.sb"
expect_readable "ssh profile reads private key"  'cat "$HOME/.ssh/id_ed25519"'   "$scratch/ssh.sb"
expect_readable "ssh profile reads signing key"  'cat "$HOME/.gnupg/private-keys-v1.d"' "$scratch/ssh.sb"
expect_readable "aws profile reads credentials"  'cat "$HOME/.aws/credentials"'  "$scratch/aws.sb"
expect_denied   "kube profile still hides .env"  'cat .env'                      "$scratch/kube.sb"
expect_denied   "kube profile still hides aws"   'cat "$HOME/.aws/credentials"'  "$scratch/kube.sb"
expect_denied   "ssh profile still hides kube"   'cat "$HOME/.kube/config"'      "$scratch/ssh.sb"

echo "== the file-tool predicate and the kernel must agree =="
# classifyPath mirrors buildProfile by hand. Every other test in this suite
# exercises one layer or the other, so the two could drift apart without a
# single failure — leaving a secret guarded where the agent reads files and
# exposed where it runs commands, or the reverse. This compares them directly.
drift_paths="$scratch/drift-paths"
find "$fixture" "$public_fixture" "$vault" "$fakehome" \
  \( -name .git -type d -prune \) -o -type f -print | sort > "$drift_paths"

drift_verdicts="$scratch/drift-verdicts"
if ! SG_EXEMPT_ROOTS="$vault/memory" SG_DENY_ROOTS="$vault" HOME="$fakehome" \
  bun "$REPO_ROOT/tests/secret-guard/classify.ts" "$CONFIG" "$fakehome" \
  < "$drift_paths" > "$drift_verdicts"; then
  echo "FATAL: could not classify fixture paths" >&2
  exit 1
fi

drift=0
while read -r predicate target; do
  if HOME="$fakehome" sandbox-exec -f "$strict" /bin/cat "$target" >/dev/null 2>&1; then
    kernel="allow"
  else
    kernel="deny"
  fi
  if [[ "$predicate" != "$kernel" ]]; then
    drift=$((drift + 1))
    failures+=("DRIFT: predicate=$predicate kernel=$kernel $target")
    printf '  FAIL  drift: predicate=%s kernel=%s %s\n' "$predicate" "$kernel" "$target"
  fi
done < "$drift_verdicts"

if ((drift == 0)); then
  pass=$((pass + 1))
  printf '  ok    both layers agree on %s files\n' "$(wc -l < "$drift_verdicts" | tr -d ' ')"
else
  fail=$((fail + drift))
fi

# The one divergence that is deliberate: a command must be able to read the
# profile it is running under, while an agent has no reason to see it. The
# profile therefore makes the cache read-only rather than unreadable, and the
# predicate hides it outright. Asserted so the exclusion above cannot rot.
cache_marker="$XDG_CACHE_HOME/opencode-secret-guard/drift-marker.sb"
mkdir -p "$(dirname "$cache_marker")"
printf '%s\n' "$PUBLIC" > "$cache_marker"
expect_allowed "kernel lets a command read its own profile cache" "cat '$cache_marker'"
cache_verdict="$(SG_EXEMPT_ROOTS="$vault/memory" SG_DENY_ROOTS="$vault" HOME="$fakehome" \
  bun "$REPO_ROOT/tests/secret-guard/classify.ts" "$CONFIG" "$fakehome" <<<"$cache_marker")"
if [[ "$cache_verdict" == deny\ * ]]; then
  pass=$((pass + 1))
  printf '  ok    file tools hide the profile cache\n'
else
  fail=$((fail + 1))
  failures+=("CACHE VISIBLE TO FILE TOOLS: $cache_verdict")
  printf '  FAIL  file tools hide the profile cache -- %s\n' "$cache_verdict"
fi

echo "== configured shell integration =="
expect_shell_denied  "shell denies explicit secret" 'cat .env'
expect_shell_denied  "shell uses command working directory" 'cat local.conf'
expect_shell_allowed "shell permits ordinary reads" 'cat README.md'
expect_shell_allowed "ignored symlink cannot hide tracked target" 'cat .gitignore; cat README.md'
expect_shell_strict "shell keeps compound credential access strict" \
  'kubectl; cat "$HOME/.kube/config"'
expect_shell_strict "shell keeps rg with a path operand strict" \
  'kubectl | rg S3CRET "$HOME/.kube/config"'
expect_shell_strict "shell keeps jq with a file operand strict" \
  'kubectl | jq -R . "$HOME/.kube/config"'
expect_shell_strict "shell keeps write-then-search strict" \
  "kubectl > '$scratch/pods-rg.txt'; rg S3CRET '$scratch/pods-rg.txt'"
expect_shell_strict "shell keeps write-then-jq strict" \
  "kubectl > '$scratch/pods-jq.txt'; jq -R . '$scratch/pods-jq.txt'"
expect_shell_strict "shell blocks recursive parent-directory searches" \
  'kubectl | rg -uuu S3CRET "$HOME"'
expect_shell_strict "shell blocks relative operands after cd" \
  'cd "$HOME/.kube" && kubectl | rg S3CRET config'
expect_shell_strict "shell blocks zsh file substitution" \
  'kubectl =(cat "$HOME/.kube/config")'
expect_shell_allowed "shell survives attempted profile-cache poisoning" \
  'for profile in "$XDG_CACHE_HOME"/opencode-secret-guard/*.sb; do printf "(version 1)\n(allow default)\n" > "$profile"; done; cat README.md'
expect_shell_denied "profile cache remains protected" 'cat .env'

public_cwd_output="$(cd "$public_fixture" && HOME="$fakehome" PATH="$fakebin:$PATH" \
  "$GUARD_SHELL" -c 'cat local.conf' 2>&1)"
if [[ "$public_cwd_output" == *"$PUBLIC"* ]]; then
  pass=$((pass + 1))
  printf '  ok    shell does not reuse another working directory profile\n'
else
  fail=$((fail + 1)); failures+=("SHELL WRONG CWD: $public_cwd_output")
  printf '  FAIL  shell does not reuse another working directory profile -- %s\n' "$public_cwd_output"
fi
public_cwd_secret="$(cd "$public_fixture" && HOME="$fakehome" PATH="$fakebin:$PATH" \
  "$GUARD_SHELL" -c 'cat .env; cat local.conf' 2>&1)"
if [[ "$public_cwd_secret" != *"$SECRET"* && "$public_cwd_secret" == *"$PUBLIC"* ]]; then
  pass=$((pass + 1))
  printf '  ok    shell enforces static secrets in the second working directory\n'
else
  fail=$((fail + 1)); failures+=("SHELL SECOND CWD SECRET: $public_cwd_secret")
  printf '  FAIL  shell enforces static secrets in the second working directory -- %s\n' "$public_cwd_secret"
fi

shell_output="$(cd "$fixture" && HOME="$fakehome" PATH="$fakebin:$PATH" "$GUARD_SHELL" -c kubectl 2>&1)"
if [[ "$shell_output" == *"$SECRET"* ]]; then
  pass=$((pass + 1))
  printf '  ok    shell applies credential relaxation\n'
else
  fail=$((fail + 1)); failures+=("SHELL NOT RELAXED: kubectl -- $shell_output")
  printf '  FAIL  shell applies credential relaxation -- %s\n' "$shell_output"
fi

for tool in "rg" "grep" "jq"; do
  case "$tool" in
    rg)   command='kubectl | rg S3CRET-LEAK-CANARY' ;;
    grep) command='kubectl | grep S3CRET-LEAK-CANARY' ;;
    jq)   command='kubectl | jq -R .' ;;
  esac
  shell_pipe_output="$(cd "$fixture" && HOME="$fakehome" PATH="$fakebin:$PATH" \
    "$GUARD_SHELL" -c "$command" 2>&1)"
  if [[ "$shell_pipe_output" == *"$SECRET"* ]]; then
    pass=$((pass + 1))
    printf '  ok    shell relaxes a kube pipeline into %s\n' "$tool"
  else
    fail=$((fail + 1)); failures+=("SHELL $tool PIPE: $shell_pipe_output")
    printf '  FAIL  shell relaxes a kube pipeline into %s -- %s\n' "$tool" "$shell_pipe_output"
  fi
done

shell_cd_output="$(HOME="$fakehome" PATH="$fakebin:$PATH" \
  "$GUARD_SHELL" -c "cd '$fixture' && kubectl" 2>&1)"
if [[ "$shell_cd_output" == *"$SECRET"* ]]; then
  pass=$((pass + 1))
  printf '  ok    cd keeps the relaxation group\n'
else
  fail=$((fail + 1)); failures+=("SHELL CD LOST RELAXATION: $shell_cd_output")
  printf '  FAIL  cd keeps the relaxation group -- %s\n' "$shell_cd_output"
fi

expect_shell_strict "a redirected cd falls back to strict" \
  "cd '$fixture' > /dev/null && kubectl"

shell_env_output="$(cd "$fixture" && HOMEASSISTANT_TOKEN="$SECRET" SG_CANARY_ENV="$PUBLIC" \
  HOME="$fakehome" PATH="$fakebin:$PATH" "$GUARD_SHELL" -c \
  'printenv HOMEASSISTANT_TOKEN; printenv SG_CANARY_ENV' 2>&1)"
if [[ "$shell_env_output" == "$PUBLIC" ]]; then
  pass=$((pass + 1))
  printf '  ok    shell scrubs inherited secret environment\n'
else
  fail=$((fail + 1)); failures+=("SHELL ENV LEAKED: $shell_env_output")
  printf '  FAIL  shell scrubs inherited secret environment\n'
fi

"$GUARD_SHELL" -c true extra >/dev/null 2>&1
invalid_status=$?
"$GUARD_SHELL" -lc true >/dev/null 2>&1
invalid_flag_status=$?
if [[ "$invalid_status" -eq 1 && "$invalid_flag_status" -eq 1 ]]; then
  pass=$((pass + 1))
  printf '  ok    shell rejects invalid argv\n'
else
  fail=$((fail + 1)); failures+=("SHELL ACCEPTED INVALID ARGV")
  printf '  FAIL  shell rejects invalid argv -- statuses %s, %s\n' \
    "$invalid_status" "$invalid_flag_status"
fi

HOME="$fakehome" PATH="$fakebin:$PATH" "$GUARD_SHELL" -c 'exit 7' >/dev/null 2>&1
shell_status=$?
if [[ "$shell_status" -eq 7 ]]; then
  pass=$((pass + 1))
  printf '  ok    shell preserves exit status\n'
else
  fail=$((fail + 1)); failures+=("SHELL EXIT STATUS: expected 7, got $shell_status")
  printf '  FAIL  shell preserves exit status -- got %s\n' "$shell_status"
fi

HOME="$fakehome" PATH="$fakebin:$PATH" "$GUARD_SHELL" -c true >/dev/null 2>&1
if [[ "$?" -eq 0 ]]; then
  pass=$((pass + 1))
  printf '  ok    shell preserves successful exit status\n'
else
  fail=$((fail + 1)); failures+=("SHELL SUCCESS STATUS")
  printf '  FAIL  shell preserves successful exit status\n'
fi

echo
printf 'passed %d, failed %d\n' "$pass" "$fail"
if ((fail > 0)); then
  printf '\nfailures:\n'
  printf '  %s\n' "${failures[@]}"
  exit 1
fi
