{ pkgs, package }:

let
  testSource = pkgs.runCommand "secret-guard-integration-source" { } ''
    mkdir -p "$out/node_modules"
    cp -r ${../src} "$out/src"
    cp -r ${../tests} "$out/tests"
    cp -r ${../policy} "$out/policy"
    mkdir -p "$out/bin"
    ln -s ${package}/bin/path-lookup "$out/bin/path-lookup"
    cp ${../bin/opencode-secret-guard} "$out/bin/opencode-secret-guard"
    ln -s ${package}/lib/node_modules/zod "$out/node_modules/zod"
  '';
  testPolicy = import ./test-policy.nix { inherit pkgs; };
in
# Kernel-level tests. A sandbox cannot be applied inside an existing one, so
# this cannot be a check and must not run from a guarded shell.
pkgs.writeShellApplication {
  name = "test-secret-guard";
  runtimeInputs = [
    pkgs.bun
    pkgs.git
    pkgs.ripgrep
  ];
  text = ''
    REPO_ROOT="''${REPO_ROOT:-${testSource}}"
    export REPO_ROOT
    export OPENCODE_SECRET_GUARD_CONFIG="''${OPENCODE_SECRET_GUARD_CONFIG:-${testPolicy}}"
    export SECRET_GUARD_SHELL=${package}/bin/opencode-secret-guard

    # Probe first: the fixtures this suite writes (a .env, ignored trees) are
    # exactly what an outer guard sandbox denies, so without this the run fails
    # during fixture setup as an unexplained EPERM.
    probe_directory="$(mktemp -d)"
    trap 'rm -rf "$probe_directory"' EXIT
    if ! XDG_CACHE_HOME="$probe_directory/cache" bun "$REPO_ROOT/tests/gen-profile.ts" \
      "$OPENCODE_SECRET_GUARD_CONFIG" "$probe_directory" "$probe_directory" - > "$probe_directory/probe.cmd"; then
      echo "test-secret-guard: could not generate a sandbox command; the error above says why." >&2
      exit 2
    fi
    mapfile -t sandbox < "$probe_directory/probe.cmd"
    if ((''${#sandbox[@]} == 0)) || ! "''${sandbox[@]}" true 2>/dev/null; then
      echo "test-secret-guard: cannot apply a sandbox." >&2
      echo "  Run this outside opencode's guarded shell, from a plain terminal." >&2
      exit 2
    fi

    bun test "$REPO_ROOT"/tests/*.test.ts "$REPO_ROOT/tests/cleanup.integration.ts"
    bash "$REPO_ROOT/tests/sandbox.test.sh"
  '';
}
