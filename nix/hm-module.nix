self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.opencode-secret-guard;
  inherit (lib)
    literalExpression
    mkEnableOption
    mkIf
    mkOption
    types
    ;

  package = self.packages.${pkgs.stdenv.hostPlatform.system}.opencode-secret-guard;

  defaultPolicy = builtins.fromJSON (builtins.readFile ../policy/default.json);

  policy = pkgs.writeText "opencode-secret-guard-policy.json" (
    builtins.toJSON (
      defaultPolicy
      // {
        inherit (cfg) mode;
      }
      // cfg.settings
    )
  );
in
{
  options.programs.opencode-secret-guard = {
    enable = mkEnableOption "the OpenCode secret guard";

    package = mkOption {
      type = types.package;
      default = package;
      defaultText = literalExpression "inputs.opencode-secret-guard.packages.\${system}.opencode-secret-guard";
      description = "The package providing the plugin and its shell wrapper.";
    };

    mode = mkOption {
      type = types.enum [
        "shell+files"
        "files-only"
      ];
      default = "shell+files";
      description = ''
        `shell+files` enforces the boundary in the kernel and requires macOS
        with `sandbox-exec`. `files-only` keeps the portable file-tool layer and
        leaves the bash tool unguarded, so it must be chosen deliberately.
      '';
    };

    settings = mkOption {
      type = types.attrsOf types.anything;
      default = { };
      example = literalExpression ''
        {
          denyRoots = [ "~/.config/secrets" ];
          exemptRoots = [ "~/notes/agent-memory" ];
          secretEnvironment = [ "CONTEXT7_API_KEY" ];
        }
      '';
      description = ''
        Policy overrides merged over the shipped default. Roots may start with
        `~`, which the plugin expands at runtime.
      '';
    };

    # Read-only outputs. The module deliberately does not write into
    # programs.opencode: consumers assemble their own opencode settings, and
    # reaching into another module's option tree invites merge conflicts over
    # values this module cannot see.
    #
    # Both are null when they do not apply, so a consumer that wires them
    # unconditionally fails at evaluation instead of producing a configuration
    # that looks installed and aborts every command.
    shellPath = mkOption {
      type = types.nullOr types.str;
      readOnly = true;
      default =
        if cfg.enable && cfg.mode == "shell+files" then
          "${cfg.package}/bin/opencode-secret-guard"
        else
          null;
      defaultText = literalExpression ''"''${package}/bin/opencode-secret-guard", or null'';
      description = ''
        Set this as `programs.opencode.settings.shell`.

        Null unless the guard is enabled in `shell+files` mode: the wrapper
        refuses to run under `files-only`, so configuring it as the shell there
        would break every command.
      '';
    };

    pluginPath = mkOption {
      type = types.nullOr types.str;
      readOnly = true;
      default = if cfg.enable then "file://${cfg.package}/lib/plugin.ts" else null;
      defaultText = literalExpression ''"file://''${package}/lib/plugin.ts", or null'';
      description = "Add this to `programs.opencode.settings.plugin`.";
    };

    policyFile = mkOption {
      type = types.path;
      readOnly = true;
      default = policy;
      defaultText = literalExpression "a generated JSON file";
      description = "The generated policy, linked into the opencode config directory.";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.mode != "shell+files" || pkgs.stdenv.hostPlatform.isDarwin;
        message = ''
          programs.opencode-secret-guard.mode = "shell+files" needs macOS, because
          the boundary is enforced by sandbox-exec. Set mode = "files-only" to run
          with the weaker file-tool layer alone.
        '';
      }
    ];

    # The plugin resolves this path at runtime, so no environment plumbing into
    # the OpenCode process is needed.
    xdg.configFile."opencode/secret-guard.json".source = cfg.policyFile;
  };
}
