# The shipped default names /usr/bin/git, which the Nix build sandbox does not
# have. Tests run against the default policy with only that path replaced, the
# same substitution the Home Manager module makes for a real install.
{ pkgs }:

let
  defaultPolicy = builtins.fromJSON (builtins.readFile ../policy/default.json);
in
pkgs.writeText "opencode-secret-guard-test-policy.json" (
  builtins.toJSON (
    defaultPolicy
    // {
      tools = {
        git = "${pkgs.git}/bin/git";
      };
    }
  )
)
