{
  description = "secret-guard — keeps secrets out of an OpenCode agent's context";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      # The file-tool layer is portable; "shell+files" mode needs a shell sandbox
      # backend, and only macOS has one so far. Linux is offered so "files-only"
      # installs are buildable and tested there.
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      inherit (nixpkgs) lib;
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      isDarwin = system: lib.hasSuffix "darwin" system;
    in
    {
      packages = forAllSystems (pkgs: rec {
        opencode-secret-guard = pkgs.callPackage ./nix/package.nix {
          revision = self.shortRev or self.dirtyShortRev or null;
        };
        default = opencode-secret-guard;
      });

      checks = forAllSystems (
        pkgs:
        import ./nix/checks.nix {
          inherit pkgs;
          package = self.packages.${pkgs.stdenv.hostPlatform.system}.opencode-secret-guard;
        }
      );

      # The kernel suite cannot apply a sandbox inside the Nix build sandbox, so
      # it is an app rather than a check. It is offered where a backend exists.
      apps = lib.genAttrs (lib.filter isDarwin systems) (system: {
        integration =
          let
            pkgs = nixpkgs.legacyPackages.${system};
          in
          {
            type = "app";
            meta.description = "Kernel-level sandbox tests; must run outside a sandbox";
            program = "${
              import ./nix/integration.nix {
                inherit pkgs;
                package = self.packages.${system}.opencode-secret-guard;
              }
            }/bin/test-secret-guard";
          };
      });

      homeManagerModules = rec {
        opencode-secret-guard = import ./nix/hm-module.nix self;
        default = opencode-secret-guard;
      };

      # Home Manager renamed the attribute; both names refer to one module.
      homeModules = self.homeManagerModules;

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
