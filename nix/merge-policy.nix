# Merges a consumer's additions into the shipped default policy. Pure, so the
# checks can evaluate it without Home Manager; the module calls it with its
# option values.
{ lib }:
{
  defaultPolicy,
  mode,
  gitPath,
  extraSecretPatterns ? [ ],
  extraSecretExceptions ? [ ],
  extraArtifactAllowlist ? [ ],
  extraSecretPrintingCommands ? [ ],
  removeSecretPrintingCommands ? [ ],
  extraRelaxationGroups ? { },
  extraWriteProtectedRoots ? [ ],
  # The module's typed review settings; unset (null) blocks are left out.
  permissionReview ? { },
  settings ? { },
}:
let
  # Removals apply to the shipped defaults only, so a consumer can drop a rule
  # and add a narrower one for the same binary in the same configuration. An
  # empty `args` removes every default rule for that binary.
  keptPrintingCommands = builtins.filter (
    rule:
    !(lib.any (
      removal:
      let
        args = removal.args or [ ];
      in
      removal.binary == rule.binary && (args == [ ] || args == rule.args)
    ) removeSecretPrintingCommands)
  ) defaultPolicy.secretPrintingCommands;
  extendedGroups = lib.mapAttrs (
    name: group:
    let
      extra = extraRelaxationGroups.${name} or { };
    in
    group
    // {
      binaries = group.binaries ++ (extra.binaries or [ ]);
      allowPaths = group.allowPaths ++ (extra.allowPaths or [ ]);
      allowEnvironment = group.allowEnvironment ++ (extra.allowEnvironment or [ ]);
    }
  ) defaultPolicy.relaxationGroups;
  newGroups = lib.mapAttrs (
    _: group:
    {
      binaries = [ ];
      allowPaths = [ ];
      allowEnvironment = [ ];
    }
    // group
  ) (lib.filterAttrs (name: _: !(defaultPolicy.relaxationGroups ? ${name})) extraRelaxationGroups);
  # `mode`, `tools.git` and `permissionReview` have their own options, which the
  # module validates and wires up; a `settings` value for any of them would
  # silently disagree with what the module assumed.
  reserved = lib.intersectLists [ "mode" "tools" "permissionReview" ] (lib.attrNames settings);
in
assert lib.assertMsg (reserved == [ ])
  "opencode-secret-guard: set ${lib.concatStringsSep ", " reserved} through the module option, not through settings";
defaultPolicy
// {
  secretPatterns = defaultPolicy.secretPatterns ++ extraSecretPatterns;
  secretExceptions = defaultPolicy.secretExceptions ++ extraSecretExceptions;
  artifactAllowlist = defaultPolicy.artifactAllowlist ++ extraArtifactAllowlist;
  secretPrintingCommands = keptPrintingCommands ++ extraSecretPrintingCommands;
  relaxationGroups = extendedGroups // newGroups;
  writeProtectedRoots = (defaultPolicy.writeProtectedRoots or [ ]) ++ extraWriteProtectedRoots;
}
// settings
// {
  inherit mode;
  tools = defaultPolicy.tools // {
    git = gitPath;
  };
  permissionReview =
    (defaultPolicy.permissionReview or { })
    // lib.filterAttrs (_: value: value != null) permissionReview;
}
