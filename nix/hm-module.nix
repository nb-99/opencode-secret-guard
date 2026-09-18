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

  # Additions merge into the shipped default before `settings` is applied, so a
  # consumer carries only its deltas and still receives upstream policy fixes.
  # `settings` remains a whole-key override for anything else.
  mergePolicy = import ./merge-policy.nix { inherit lib; };

  policy = pkgs.writeText "opencode-secret-guard-policy.json" (
    builtins.toJSON (mergePolicy {
      inherit defaultPolicy;
      inherit (cfg)
        mode
        extraSecretPatterns
        extraSecretExceptions
        extraArtifactAllowlist
        extraSecretPrintingCommands
        removeSecretPrintingCommands
        extraRelaxationGroups
        settings
        ;
      # A store path, so the guard never resolves git through PATH.
      gitPath = "${cfg.gitPackage}/bin/git";
    })
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

    gitPackage = mkOption {
      type = types.package;
      default = pkgs.git;
      defaultText = literalExpression "pkgs.git";
      description = ''
        The git the guard itself spawns to enumerate ignored files. Written to
        the policy as a store path so it is never resolved through PATH.
      '';
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
        Policy keys that replace the shipped default wholesale, applied after
        the `extra*` additions are merged (so a key named here discards those
        additions for that key). `mode` and `tools` are rejected here; use
        their options. Roots may start with `~`, which the plugin expands at
        runtime. Prefer the `extra*` options for additions, so upstream
        changes to the default still apply.
      '';
    };

    extraSecretPatterns = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "/api-specs/private/" ];
      description = "Regexes appended to the default `secretPatterns`.";
    };

    extraSecretExceptions = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "/pkg/store/secrets/obfuscator\\.go$" ];
      description = "Regexes appended to the default `secretExceptions`.";
    };

    extraArtifactAllowlist = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ ".zig-cache" ];
      description = "Path components appended to the default `artifactAllowlist`.";
    };

    extraSecretPrintingCommands = mkOption {
      type = types.listOf (
        types.submodule {
          options = {
            binary = mkOption {
              type = types.str;
              description = "Program name, without a path.";
            };
            args = mkOption {
              type = types.listOf types.str;
              default = [ ];
              description = "Regexes each matched in full against some word of the invocation.";
            };
          };
        }
      );
      default = [ ];
      example = literalExpression ''
        [ { binary = "pass"; args = [ "show" ]; } ]
      '';
      description = "Invocations appended to the default `secretPrintingCommands`.";
    };

    removeSecretPrintingCommands = mkOption {
      type = types.listOf (
        types.submodule {
          options = {
            binary = mkOption {
              type = types.str;
              description = "Program name of the shipped rule to drop.";
            };
            args = mkOption {
              type = types.listOf types.str;
              default = [ ];
              description = ''
                The shipped rule's `args`, matched exactly. Empty drops every
                shipped rule for the binary.
              '';
            };
          };
        }
      );
      default = [ ];
      example = literalExpression ''
        [ { binary = "terraform"; args = [ "show" "-json" ]; } ]
      '';
      description = ''
        Shipped `secretPrintingCommands` entries this host does not want,
        removed before `extraSecretPrintingCommands` is appended — so a rule can
        be replaced with a narrower one while the rest of the default list, and
        upstream additions to it, still apply. A refusal exists because the
        invocation's output is a credential; removing one is a decision to let
        that output reach the agent's context.
      '';
    };

    extraRelaxationGroups = mkOption {
      type = types.attrsOf (
        types.submodule {
          options = {
            binaries = mkOption {
              type = types.listOf types.str;
              default = [ ];
              description = "Binaries added to the group.";
            };
            allowPaths = mkOption {
              type = types.listOf types.str;
              default = [ ];
              description = "`$HOME`-relative paths the group may additionally read.";
            };
            allowEnvironment = mkOption {
              type = types.listOf types.str;
              default = [ ];
              description = "Variable-name regexes the group's binaries keep despite the scrub.";
            };
          };
        }
      );
      default = { };
      example = literalExpression ''
        {
          oci.binaries = [ "ko" ];
          vault = { binaries = [ "vault" ]; allowPaths = [ ".vault-token" ]; };
        }
      '';
      description = ''
        Per-group additions merged into the default `relaxationGroups`. A name
        that is not a default group defines a new one.
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
