{
  fetchurl,
  runCommand,
  lib,
}:
let
  manifest = builtins.fromJSON (builtins.readFile ../package.json);
  lock = builtins.fromJSON (builtins.readFile ../package-lock.json);
  # Fetch declarations only. OpenCode supplies the shared UI runtime when it loads the plugin.
  declarations =
    name: archiveName:
    let
      version = manifest.devDependencies.${name};
      entry = lock.packages."node_modules/${name}";
      url = "https://registry.npmjs.org/${name}/-/${archiveName}-${version}.tgz";
      source =
        assert lib.assertMsg (
          entry.version == version && entry.resolved == url
        ) "${name} declaration version differs from package-lock.json";
        fetchurl {
          inherit url;
          hash = entry.integrity;
        };
    in
    runCommand "secret-guard-${archiveName}-types-${version}" { } ''
      mkdir -p "$out"
      tar -xzf ${source} -C "$out" --strip-components=1
    '';
in
{
  core = declarations "@opentui/core" "core";
  solid = declarations "@opentui/solid" "solid";
  solidJs = declarations "solid-js" "solid-js";
}
