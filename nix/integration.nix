{ pkgs, package }:

let
  testSource = pkgs.runCommand "secret-guard-integration-source" { } ''
    mkdir -p "$out/node_modules"
    cp -r ${../src} "$out/src"
    cp -r ${../tests} "$out/tests"
    ln -s ${package}/lib/node_modules/zod "$out/node_modules/zod"
  '';
in
# Kernel-level tests. sandbox-exec refuses to apply a profile inside an existing
# sandbox, so this cannot be a check and must not run from a guarded shell.
pkgs.writeShellApplication {
  name = "test-secret-guard";
  runtimeInputs = [
    pkgs.bun
    pkgs.git
    pkgs.ripgrep
  ];
  text = ''
    # Probe first: the fixtures this suite writes (a .env, ignored trees) are
    # exactly what an outer guard profile denies, so without this the run fails
    # during fixture setup as an unexplained EPERM.
    probe_directory="$(mktemp -d)"
    trap 'rm -rf "$probe_directory"' EXIT
    probe="$probe_directory/probe.sb"
    printf '(version 1)\n(allow default)\n' > "$probe"
    if ! /usr/bin/sandbox-exec -f "$probe" /usr/bin/true 2>/dev/null; then
      echo "test-secret-guard: cannot apply a sandbox profile." >&2
      echo "  Run this outside opencode's guarded shell, from a plain terminal." >&2
      exit 2
    fi

    REPO_ROOT="''${REPO_ROOT:-${testSource}}"
    export REPO_ROOT
    export OPENCODE_SECRET_GUARD_CONFIG="''${OPENCODE_SECRET_GUARD_CONFIG:-${../policy/default.json}}"
    export SECRET_GUARD_SHELL=${package}/bin/opencode-secret-guard

    bun test "$REPO_ROOT/tests/group.test.ts" "$REPO_ROOT/tests/predicate.test.ts" "$REPO_ROOT/tests/cleanup.test.ts" "$REPO_ROOT/tests/cleanup.integration.ts"
    bash "$REPO_ROOT/tests/sandbox.test.sh"
  '';
}
