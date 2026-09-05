{ pkgs, package }:

let
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);
  packageLock = builtins.fromJSON (builtins.readFile ../package-lock.json);
  zod = pkgs.callPackage ./zod.nix { };

  typesNodeVersion = packageJson.devDependencies."@types/node";
  typesNodeLock = packageLock.packages."node_modules/@types/node";
  typesNodeUrl = "https://registry.npmjs.org/@types/node/-/node-${typesNodeVersion}.tgz";

  # @opencode-ai/plugin is deliberately absent — see the comment in src/plugin.ts.
  typesNode =
    assert pkgs.lib.assertMsg (
      typesNodeLock.version == typesNodeVersion
    ) "@types/node versions in package.json and package-lock.json differ";
    assert pkgs.lib.assertMsg (
      typesNodeLock.resolved == typesNodeUrl
    ) "@types/node in package-lock.json does not resolve from the npm registry";
    pkgs.fetchurl {
      url = typesNodeUrl;
      hash = typesNodeLock.integrity;
    };
in
{
  # 40 KB of security-critical TypeScript, otherwise checked by nothing but the
  # tests that happen to execute a given branch.
  typecheck =
    pkgs.runCommand "secret-guard-typecheck"
      {
        nativeBuildInputs = [ pkgs.typescript ];
      }
      ''
        # nixpkgs is authoritative for the compiler; package.json names it so
        # `bun install && bun run typecheck` works outside Nix. Assert they
        # agree: unchecked, that field can claim any version — a Dependabot
        # bump to TypeScript 7 passed CI green while the build still used 5.9.
        expected="${packageJson.devDependencies.typescript}"
        actual="$(tsc --version | cut -d' ' -f2)"
        if [ "$expected" != "$actual" ]; then
          echo "package.json pins typescript $expected, but this build uses $actual." >&2
          echo "nixpkgs decides the version; set package.json to $actual." >&2
          exit 1
        fi

        cp -r ${../src} src
        cp ${../tsconfig.json} tsconfig.json
        mkdir -p node_modules/@types/node
        ln -s ${zod} node_modules/zod
        tar -xzf ${typesNode} -C node_modules/@types/node --strip-components=1
        tsc --noEmit
        touch $out
      '';

  # Pure unit tests. The kernel suite needs /usr/bin/sandbox-exec, which is
  # absent from the Nix build sandbox — run `nix run .#integration` for it.
  unit =
    pkgs.runCommand "secret-guard-unit"
      {
        nativeBuildInputs = [
          pkgs.bun
          pkgs.git
        ];
      }
      ''
        cp -r ${../src} src
        cp -r ${../tests} tests
        mkdir -p node_modules
        ln -s ${zod} node_modules/zod
        export HOME="$TMPDIR"
        export OPENCODE_SECRET_GUARD_CONFIG=${../policy/default.json}
        git config --global user.email test@example.com
        git config --global user.name test
        bun test tests/group.test.ts tests/predicate.test.ts tests/cleanup.test.ts
        touch $out
      '';

  # The shipped default policy must satisfy the validator it is written for.
  # Without this, a typo in a pattern would only surface on a user's machine.
  policy =
    pkgs.runCommand "secret-guard-default-policy"
      {
        nativeBuildInputs = [ pkgs.bun ];
      }
      ''
        cp -r ${../src} src
        bun -e '
          const { loadConfig } = await import("./src/policy.ts");
          const config = loadConfig("${../policy/default.json}", "/home/example");
          if (config.mode !== "shell+files") throw new Error("default policy must be shell+files");
          if (config.secretPatterns.length === 0) throw new Error("default policy has no patterns");
          for (const root of [...config.denyRoots, ...config.exemptRoots]) {
            if (!root.startsWith("/home/example")) {
              throw new Error("default policy must not name a real home: " + root);
            }
          }
        '
        touch $out
      '';

  shell = pkgs.runCommand "secret-guard-shellcheck" { nativeBuildInputs = [ pkgs.shellcheck ]; } ''
    shellcheck --severity=warning ${../bin/opencode-secret-guard} ${../tests/sandbox.test.sh}
    touch $out
  '';

  # The kernel suite cannot run in a Nix build, so a helper it resolves through
  # REPO_ROOT can go missing and only fail on a developer's machine — which is
  # exactly what happened when the tests moved out of tests/secret-guard/.
  # shellcheck does not resolve paths, so check them here.
  paths = pkgs.runCommand "secret-guard-test-paths" { nativeBuildInputs = [ pkgs.ripgrep ]; } ''
    cp -r ${../tests} tests
    missing=0
    while read -r reference; do
      if [[ ! -e "$reference" ]]; then
        echo "sandbox.test.sh references a missing path: $reference" >&2
        missing=1
      fi
    done < <(rg -o --no-filename '\$REPO_ROOT/[A-Za-z0-9_./-]+' tests/sandbox.test.sh |
      sed "s|\$REPO_ROOT/||" | sort -u)
    [[ "$missing" -eq 0 ]]
    touch $out
  '';

  # Proves the installed layout is what the plugin's own shell check expects:
  # <package>/bin/opencode-secret-guard beside <package>/lib.
  layout = pkgs.runCommand "secret-guard-layout" { nativeBuildInputs = [ pkgs.bun ]; } ''
    test -x ${package}/bin/opencode-secret-guard
    test -f ${package}/lib/plugin.ts
    test -f ${package}/lib/cli.ts
    test -f ${package}/lib/cleanup.ts
    test -f ${package}/lib/node_modules/zod/package.json
    export OPENCODE_SECRET_GUARD_CONFIG=${../policy/default.json}
    bun -e '
      const { expectedShell } = await import("${package}/lib/shell.ts");
      const expected = expectedShell("${package}/lib");
      if (expected !== "${package}/bin/opencode-secret-guard") {
        throw new Error("layout mismatch: " + expected);
      }
    '
    touch $out
  '';
}
