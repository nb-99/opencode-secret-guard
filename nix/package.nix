{
  lib,
  runCommand,
  makeWrapper,
  bun,
}:

# The plugin and its shell wrapper install as one package. The wrapper locates
# the resolver relative to itself and the plugin verifies that opencode's shell
# is this package's own bin/, so neither file is substituted and the same layout
# works from a checkout.
runCommand "opencode-secret-guard"
  {
    nativeBuildInputs = [ makeWrapper ];

    meta = {
      description = "Keeps secrets out of an OpenCode agent's context";
      platforms = lib.platforms.unix;
      mainProgram = "opencode-secret-guard";
    };
  }
  ''
    mkdir -p "$out/lib" "$out/bin" "$out/share/opencode-secret-guard"
    cp ${../src}/*.ts "$out/lib/"
    cp ${../policy/default.json} "$out/share/opencode-secret-guard/default-policy.json"

    install -m755 ${../bin/opencode-secret-guard} "$out/bin/opencode-secret-guard"
    # --set-default so a caller can still point at another interpreter.
    wrapProgram "$out/bin/opencode-secret-guard" \
      --set-default SECRET_GUARD_BUN ${bun}/bin/bun
  ''
