{
  lib,
  fetchurl,
  runCommand,
}:
let
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);
  packageLock = builtins.fromJSON (builtins.readFile ../package-lock.json);

  # The version is declared once, in package.json; the hash that proves what
  # was fetched comes from the lockfile that declared it. The asserts keep a
  # hand-edited package.json from building a version nothing pinned.
  zodVersion = packageJson.dependencies.zod;
  zodLock = packageLock.packages."node_modules/zod";
  zodUrl = "https://registry.npmjs.org/zod/-/zod-${zodVersion}.tgz";

  source =
    assert lib.assertMsg (
      zodLock.version == zodVersion
    ) "zod versions in package.json and package-lock.json differ";
    assert lib.assertMsg (
      zodLock.resolved == zodUrl
    ) "zod in package-lock.json does not resolve from the npm registry";
    fetchurl {
      url = zodUrl;
      hash = zodLock.integrity;
    };
in
runCommand "secret-guard-zod-${zodVersion}" { } ''
  mkdir -p "$out"
  tar -xzf ${source} -C "$out" --strip-components=1
''
