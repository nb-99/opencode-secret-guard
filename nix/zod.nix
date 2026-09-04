{ fetchurl, runCommand }:
let
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);
  source = fetchurl {
    url = "https://registry.npmjs.org/zod/-/zod-${packageJson.dependencies.zod}.tgz";
    hash = "sha512-rftlrkhHZOcjDwkGlnUtZZkvaPHCsDATp4pGpuOOMDaTdDDXF91wuVDJoWoPsKX/3YPQ5fHuF3STjcYyKr+Qhg==";
  };
in
runCommand "secret-guard-zod-${packageJson.dependencies.zod}" { } ''
  mkdir -p "$out"
  tar -xzf ${source} -C "$out" --strip-components=1
''
