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
  extraRelaxationGroups ? { },
  settings ? { },
}:
let
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
in
defaultPolicy
// {
  inherit mode;
  tools.git = gitPath;
  secretPatterns = defaultPolicy.secretPatterns ++ extraSecretPatterns;
  secretExceptions = defaultPolicy.secretExceptions ++ extraSecretExceptions;
  artifactAllowlist = defaultPolicy.artifactAllowlist ++ extraArtifactAllowlist;
  secretPrintingCommands = defaultPolicy.secretPrintingCommands ++ extraSecretPrintingCommands;
  relaxationGroups = extendedGroups // newGroups;
}
// settings
