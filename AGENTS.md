# Development

## Tests

Run the full repository check with:

```sh
nix flake check -L
```

This runs the typecheck, unit tests, default-policy validation, package layout
checks, and shell checks. The unit tests provide their pinned `zod` dependency
inside the Nix build, so `nix-shell -p bun` alone is not sufficient.

Run the macOS kernel integration suite separately from a plain terminal:

```sh
nix run .#integration
```

For direct Bun test runs, install the locked npm dependencies first:

```sh
npm ci
nix-shell -p bun --run "bun test tests/group.test.ts tests/predicate.test.ts tests/tamper.test.ts tests/cleanup.test.ts"
```

The integration suite cannot run inside an existing sandbox because
`sandbox-exec` refuses to apply a nested profile.
