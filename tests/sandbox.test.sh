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

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CONFIG="${OPENCODE_SECRET_GUARD_CONFIG:?OPENCODE_SECRET_GUARD_CONFIG must be set}"
GUARD_SHELL="${SECRET_GUARD_SHELL:?SECRET_GUARD_SHELL must be set}"

# Name a missing helper directly. Resolved through REPO_ROOT, one that has moved
# otherwise surfaces far below as "could not generate strict profile", which
# points at the generator rather than at the path.
for helper in gen-profile.ts classify.ts; do
  if [[ ! -f "$REPO_ROOT/tests/$helper" ]]; then
    echo "FATAL: missing $REPO_ROOT/tests/$helper" >&2
    echo "  REPO_ROOT is $REPO_ROOT -- set it to the repository root." >&2
    exit 2
  fi
done

pass=0
fail=0
declare -a failures=()

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
scratch="$(cd "$scratch" && pwd -P)"
export XDG_CACHE_HOME="$scratch/cache"
# The tamper-protection rules name OpenCode's own configuration directory, so
# point it at a fixture rather than at the developer's real one.
export XDG_CONFIG_HOME="$scratch/config"
mkdir -p "$XDG_CONFIG_HOME/opencode"

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
mkdir -p "$fakehome"/{.ssh,.gnupg,.kube,.aws,.config/gcloud,.config/gh,.config/github-copilot,.local/share/opencode,.terraform.d}
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
printf '%s\n' "$SECRET" > "$fakehome/.config/gcloud/credentials.db"
printf '%s\n' "$SECRET" > "$fakehome/.config/gh/hosts.yml"
printf '%s\n' "$PUBLIC" > "$fakehome/.config/gh/config.yml"
printf '%s\n' "$SECRET" > "$fakehome/.config/github-copilot/apps.json"
printf '%s\n' "$SECRET" > "$fakehome/.local/share/opencode/auth.json"
printf '%s\n' "$PUBLIC" > "$fakehome/.local/share/opencode/opencode.db"
printf '%s\n' "$SECRET" > "$fakehome/.terraform.d/credentials.tfrc.json"

cat > "$fakebin/kubectl" <<EOF
#!/bin/sh
printf '%s\n' '$PUBLIC' >&2
if [ "\$1" = env ]; then
  printenv KUBE_CANARY_TOKEN OTHER_CANARY_TOKEN
elif [ "\$#" -gt 0 ] && [ -f "\$1" ]; then
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
    bun "$REPO_ROOT/tests/gen-profile.ts" \
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

# A command that tries to plant TAMPER at $2 must leave the file without it.
# Whether the write fails loudly is irrelevant; only the resulting content is.
# $1 description, $2 target path, $3 command, $4 profile (default: strict)
expect_unwritable() {
  local description="$1" target="$2" command="$3" profile="${4:-$strict}" after
  (cd "$fixture" && HOME="$fakehome" sandbox-exec -f "$profile" /bin/zsh -c "$command" >/dev/null 2>&1)
  after="$(cat "$target" 2>/dev/null || true)"
  if [[ "$after" != *TAMPER* ]]; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$description"
  else
    fail=$((fail + 1)); failures+=("TAMPERED: $description -- $target")
    printf '  FAIL  %s -- %s now contains TAMPER\n' "$description" "$target"
  fi
}

# Same through the configured shell, whose resolver sees the caller's PATH.
expect_shell_unwritable() {
  local description="$1" target="$2" command="$3" after
  (cd "$fixture" && HOME="$fakehome" PATH="$fakebin:$PATH" "$GUARD_SHELL" -c "$command" >/dev/null 2>&1)
  after="$(cat "$target" 2>/dev/null || true)"
  if [[ "$after" != *TAMPER* ]]; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$description"
  else
    fail=$((fail + 1)); failures+=("TAMPERED: $description -- $target")
    printf '  FAIL  %s -- %s now contains TAMPER\n' "$description" "$target"
  fi
}

# $1 description, $2 target path, $3 command: the write must land.
expect_writable() {
  local description="$1" target="$2" command="$3" profile="${4:-$strict}" after
  (cd "$fixture" && HOME="$fakehome" sandbox-exec -f "$profile" /bin/zsh -c "$command" >/dev/null 2>&1)
  after="$(cat "$target" 2>/dev/null || true)"
  if [[ "$after" == *"$PUBLIC"* ]]; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$description"
  else
    fail=$((fail + 1)); failures+=("WRITE BLOCKED: $description -- $target")
    printf '  FAIL  %s -- %s\n' "$description" "$target"
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
expect_denied "gh host token"               'cat "$HOME/.config/gh/hosts.yml"'
expect_denied "copilot app token"           'cat "$HOME/.config/github-copilot/apps.json"'
expect_denied "opencode provider tokens"    'cat "$HOME/.local/share/opencode/auth.json"'
expect_denied "terraform cloud token"       'cat "$HOME/.terraform.d/credentials.tfrc.json"'

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
expect_allowed "gh config without tokens"   'cat "$HOME/.config/gh/config.yml"'
expect_allowed "opencode session database"  'cat "$HOME/.local/share/opencode/opencode.db"'
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
expect_readable "aws profile reads terraform cloud token" 'cat "$HOME/.terraform.d/credentials.tfrc.json"' "$scratch/aws.sb"
expect_readable "ssh profile reads gh host token" 'cat "$HOME/.config/gh/hosts.yml"' "$scratch/ssh.sb"
expect_denied   "ssh profile still hides copilot" 'cat "$HOME/.config/github-copilot/apps.json"' "$scratch/ssh.sb"
expect_denied   "kube profile still hides .env"  'cat .env'                      "$scratch/kube.sb"
expect_denied   "kube profile still hides aws"   'cat "$HOME/.aws/credentials"'  "$scratch/kube.sb"
expect_denied   "ssh profile still hides kube"   'cat "$HOME/.kube/config"'      "$scratch/ssh.sb"

echo "== renaming cannot move a secret out from under its rule =="
# Path rules match the path at the time of the operation. Renaming the
# directory that carries the protected component leaves the file under a name
# no rule matches, so the directory node and its ancestors below $HOME must be
# unrenameable. Files are already covered: rename checks file-write* on the
# source path, which the pattern deny includes.
expect_denied "renaming a credential directory"   'mv "$HOME/.kube" "$HOME/k2" 2>/dev/null; cat "$HOME/k2/config" 2>/dev/null'
mv "$fakehome/k2" "$fakehome/.kube" 2>/dev/null || true
expect_denied "renaming a relaxation parent"      'mv "$HOME/.config" "$HOME/c2" 2>/dev/null; cat "$HOME/c2/gcloud/credentials.db" 2>/dev/null'
mv "$fakehome/c2" "$fakehome/.config" 2>/dev/null || true
expect_denied "renaming a deny root"              'mv "'"$vault"'" "'"$scratch"'/v2" 2>/dev/null; cat "'"$scratch"'/v2/private/journal.md" 2>/dev/null'
mv "$scratch/v2" "$vault" 2>/dev/null || true
expect_denied "renaming a secrets directory"      'mv secrets plain 2>/dev/null; cat plain/token 2>/dev/null'
mv "$fixture/plain" "$fixture/secrets" 2>/dev/null || true
expect_denied "hard-linking a secret"             'ln .env "'"$scratch"'/hl" 2>/dev/null; cat "'"$scratch"'/hl" 2>/dev/null'
expect_denied "hard-linking an ignored file"      'ln local.conf "'"$scratch"'/hl2" 2>/dev/null; cat "'"$scratch"'/hl2" 2>/dev/null'
expect_writable "creating a sibling under a protected ancestor" "$fakehome/.config/fresh/note" \
  'mkdir -p "$HOME/.config/fresh" && printf "%s" "'"$PUBLIC"'" > "$HOME/.config/fresh/note"'
expect_readable "kube profile may still rename its own directory" \
  'mv "$HOME/.kube" "$HOME/.kube-tmp" && mv "$HOME/.kube-tmp" "$HOME/.kube" && cat "$HOME/.kube/config"' "$scratch/kube.sb"

echo "== the guard's own configuration must be immutable from a command =="
# Anything OpenCode loads and executes at the next start — its config, plugin
# directories, package.json (bun install runs on startup), the npm plugin
# cache, and this policy — would let one command disable the guard for every
# later one. User-writable PATH directories are the same hole one hop removed:
# the resolver and OpenCode spawn `git` and `bash` by name.
opencode_config="$XDG_CONFIG_HOME/opencode"
expect_unwritable "global opencode.json"   "$opencode_config/opencode.json"  'printf TAMPER > "'"$opencode_config"'/opencode.json"'
expect_unwritable "global opencode.jsonc"  "$opencode_config/opencode.jsonc" 'printf TAMPER > "'"$opencode_config"'/opencode.jsonc"'
expect_unwritable "global plugin"          "$opencode_config/plugins/evil.ts" 'mkdir -p "'"$opencode_config"'/plugins" && printf TAMPER > "'"$opencode_config"'/plugins/evil.ts"'
expect_unwritable "global package.json"    "$opencode_config/package.json"   'printf TAMPER > "'"$opencode_config"'/package.json"'
expect_unwritable "project opencode.json"  "$fixture/opencode.json"          'printf TAMPER > opencode.json'
expect_unwritable "project plugin"         "$fixture/.opencode/plugins/evil.ts" 'mkdir -p .opencode/plugins && printf TAMPER > .opencode/plugins/evil.ts'
expect_unwritable "project package.json"   "$fixture/.opencode/package.json" 'printf TAMPER > .opencode/package.json'
expect_unwritable "npm plugin cache"       "$XDG_CACHE_HOME/opencode/node_modules/evil/index.js" \
  'mkdir -p "$XDG_CACHE_HOME/opencode/node_modules/evil" && printf TAMPER > "$XDG_CACHE_HOME/opencode/node_modules/evil/index.js"'
expect_unwritable "renamed config dir cannot be recreated" "$opencode_config/opencode.json" \
  'mv "'"$opencode_config"'" "'"$XDG_CONFIG_HOME"'/oc2" 2>/dev/null; mkdir -p "'"$opencode_config"'" && printf TAMPER > "'"$opencode_config"'/opencode.json"'
mv "$XDG_CONFIG_HOME/oc2" "$opencode_config" 2>/dev/null || true
expect_writable "project prompts stay editable" "$fixture/.opencode/command/x.md" \
  'mkdir -p .opencode/command && printf "%s" "'"$PUBLIC"'" > .opencode/command/x.md'
expect_writable "global skills stay editable" "$opencode_config/skills/x/SKILL.md" \
  'mkdir -p "'"$opencode_config"'/skills/x" && printf "%s" "'"$PUBLIC"'" > "'"$opencode_config"'/skills/x/SKILL.md"'
expect_shell_unwritable "writable PATH directory" "$fakebin/git" 'printf TAMPER > "'"$fakebin"'/git"'
rm -f "$fakebin/git"
tamper_config="$scratch/tamper-policy.json"
cp "$CONFIG" "$tamper_config"
(cd "$fixture" && OPENCODE_SECRET_GUARD_CONFIG="$tamper_config" HOME="$fakehome" PATH="$fakebin:$PATH" \
  "$GUARD_SHELL" -c 'printf TAMPER >> "'"$tamper_config"'"' >/dev/null 2>&1)
if [[ "$(cat "$tamper_config")" != *TAMPER* ]]; then
  pass=$((pass + 1))
  printf '  ok    policy file\n'
else
  fail=$((fail + 1)); failures+=("TAMPERED: policy file")
  printf '  FAIL  policy file -- %s now contains TAMPER\n' "$tamper_config"
fi

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
  bun "$REPO_ROOT/tests/classify.ts" "$CONFIG" "$fakehome" \
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
  bun "$REPO_ROOT/tests/classify.ts" "$CONFIG" "$fakehome" <<<"$cache_marker")"
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

# The scrub list comes from the policy, and the shipped default deliberately
# names no variables — only a user knows theirs. Asserting the mechanism against
# whichever policy the run was handed would therefore pass or fail depending on
# the caller, so this derives a policy naming a canary of its own.
scrub_config="$scratch/scrub-policy.json"
SG_SRC="$CONFIG" SG_DEST="$scrub_config" bun -e '
  const fs = require("node:fs");
  const policy = JSON.parse(fs.readFileSync(process.env.SG_SRC, "utf8"));
  policy.secretEnvironment = ["SG_SCRUBBED_ENV"];
  policy.secretEnvironmentPatterns = ["_CANARY_TOKEN$"];
  policy.relaxationGroups.kube.allowEnvironment = ["^KUBE_"];
  fs.writeFileSync(process.env.SG_DEST, JSON.stringify(policy));
' || { echo "FATAL: could not derive the scrub policy" >&2; exit 1; }

shell_env_output="$(cd "$fixture" && OPENCODE_SECRET_GUARD_CONFIG="$scrub_config" \
  SG_SCRUBBED_ENV="$SECRET" SG_CANARY_ENV="$PUBLIC" \
  HOME="$fakehome" PATH="$fakebin:$PATH" "$GUARD_SHELL" -c \
  'printenv SG_SCRUBBED_ENV; printenv SG_CANARY_ENV' 2>&1)"
if [[ "$shell_env_output" == "$PUBLIC" ]]; then
  pass=$((pass + 1))
  printf '  ok    shell scrubs inherited secret environment\n'
else
  fail=$((fail + 1)); failures+=("SHELL ENV LEAKED: $shell_env_output")
  printf '  FAIL  shell scrubs inherited secret environment\n'
fi

# Pattern-derived scrubbing: a name nobody listed, matched by shape, is gone
# under the strict profile and kept for the group whose binaries need it.
shell_pattern_output="$(cd "$fixture" && OPENCODE_SECRET_GUARD_CONFIG="$scrub_config" \
  KUBE_CANARY_TOKEN="$SECRET" OTHER_CANARY_TOKEN="$SECRET" SG_CANARY_ENV="$PUBLIC" \
  HOME="$fakehome" PATH="$fakebin:$PATH" "$GUARD_SHELL" -c \
  'printenv KUBE_CANARY_TOKEN; printenv OTHER_CANARY_TOKEN; printenv SG_CANARY_ENV' 2>&1)"
if [[ "$shell_pattern_output" == "$PUBLIC" ]]; then
  pass=$((pass + 1))
  printf '  ok    shell scrubs environment by pattern under the strict profile\n'
else
  fail=$((fail + 1)); failures+=("SHELL PATTERN ENV LEAKED: $shell_pattern_output")
  printf '  FAIL  shell scrubs environment by pattern under the strict profile -- %s\n' "$shell_pattern_output"
fi
shell_group_env_output="$(cd "$fixture" && OPENCODE_SECRET_GUARD_CONFIG="$scrub_config" \
  KUBE_CANARY_TOKEN="KEPT-FOR-GROUP" OTHER_CANARY_TOKEN="$SECRET" \
  HOME="$fakehome" PATH="$fakebin:$PATH" "$GUARD_SHELL" -c 'kubectl env' 2>&1)"
if [[ "$shell_group_env_output" == *"KEPT-FOR-GROUP"* && "$shell_group_env_output" != *"$SECRET"* ]]; then
  pass=$((pass + 1))
  printf '  ok    a group keeps the variables its binaries need\n'
else
  fail=$((fail + 1)); failures+=("SHELL GROUP ENV: $shell_group_env_output")
  printf '  FAIL  a group keeps the variables its binaries need -- %s\n' "$shell_group_env_output"
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
