{
  lib,
  runCommand,
  makeWrapper,
  bash,
  bun,
  callPackage,
  stdenv,
  # The flake's source revision, recorded in the decision log; null when unknown.
  revision ? null,
}:

let
  zod = callPackage ./zod.nix { };
  # A literal string, so the revision cannot inject code into the plugin.
  buildInfo = builtins.toFile "build-info.ts" ''
    /** The guard's source revision, for the decision log. Written by nix/package.nix. */
    export const GUARD_REVISION: string | null = ${builtins.toJSON revision};
  '';
in
# The plugin and its shell wrapper install as one package. The wrapper locates
# the resolver relative to itself and the plugin verifies that opencode's shell
# is this package's own bin/, so neither file is substituted and the same layout
# works from a checkout.
runCommand "opencode-secret-guard"
  {
    nativeBuildInputs = [
      makeWrapper
      bash
      stdenv.cc
    ];

    meta = {
      description = "Keeps secrets out of an OpenCode agent's context";
      platforms = lib.platforms.unix;
      mainProgram = "opencode-secret-guard";
    };
  }
  ''
    mkdir -p "$out/lib" "$out/bin" "$out/share/opencode-secret-guard"
    cc -std=c11 -O2 -Wall -Wextra -Werror ${../native/path-lookup.c} -o "$out/bin/path-lookup"
    cp ${../src}/*.ts "$out/lib/"
    install -m644 ${buildInfo} "$out/lib/build-info.ts"
    mkdir -p "$out/lib/node_modules"
    ln -s ${zod} "$out/lib/node_modules/zod"
    cp ${../policy/default.json} "$out/share/opencode-secret-guard/default-policy.json"

    install -m755 ${../bin/opencode-secret-guard} "$out/bin/opencode-secret-guard"
    # A store-path interpreter: the wrapper must not resolve bash through PATH.
    patchShebangs "$out/bin/opencode-secret-guard"
    # --set-default so a caller can still point at another interpreter.
    wrapProgram "$out/bin/opencode-secret-guard" \
      --set-default SECRET_GUARD_BUN ${bun}/bin/bun
  ''
