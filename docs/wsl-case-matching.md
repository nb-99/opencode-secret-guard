# WSL case-alias matching investigation

Status: the replacement on `fix/wsl-case-normalization` is published as
[PR #18](https://github.com/nb-99/opencode-secret-guard/pull/18), not activated.
The previous normalization-only candidate was unsafe and has been replaced.

Node and OpenCode's embedded Bun preserve caller casing in `realpathSync` on
case-insensitive DrvFS. With an actual `.env`, the installed guard refuses
`.env` but permits read and patch through `.ENV`.

The first candidate resolved existing aliases to their physical directory-entry
spelling using bigint device/inode identity. It preserves case-distinct ext4
entries, canonicalizes existing ancestors of missing descendants, and fails
closed when a proven alias cannot be resolved. Those improvements are not
sufficient for policy matching.

## Regressions that drove the replacement

The tests in `tests/paths.test.ts` exposed three denial regressions:

- An actual `.ENV` no longer matches the default lowercase `.env` deny pattern,
  even through the lowercase alias that the old implementation refused.
- An actual `.KUBE/config` similarly loses the lowercase credential-directory
  denial.
- A custom uppercase deny expression loses protection when the physical entry
  is lowercase.

All three now pass. The replacement separates filesystem evidence from bounded
pattern matching, rather than treating physical spelling as policy authority.
See [the decision](adr/0001-case-alias-policy.md) for its supported semantics.

Earlier live fixture checks covered a physically lowercase `.env`. Their
successful alias refusals do not clear these regressions.

## Verification

- Package compilation and TypeScript checks pass on Linux.
- The path suite covers the former regressions and inaccessible sibling files. The matcher compares results against
  exhaustive small case domains, and Git ignore tests cover folded negations.
- The initial reviewed Linux Nix checks had 705 pass, 12 skip, and 30 fail. The same
  30 failures occur in the unchanged baseline and concern macOS-only tests and
  a sandbox path assumption. No new failing test remains.
- Live native Windows checks refuse six separate protected reads, including
  both stored case directions, `.KUBE/config`, and a case-spelled deny root.
  An explicit nested exemption and an ordinary read succeed. Two denied native
  patches leave the fixtures unchanged and create no destination; an allowed
  patch succeeds. Each refusal names its own input path.
- The native helper cross-compiles for Apple Silicon macOS with warnings treated
  as errors. The pre-follow-up PR passed macOS flake checks and real kernel
  integration. Actual ext4 casefold directories remain untested. Filesystem
  metadata tests cover injected directory modes.
- Initial performance re-checks confirmed one helper per classified target, no helper
  calls for ordinary resolution or profile generation, and one Git call per
  repository in case-aware batches. A 100-path batch measured about 99 ms on
  ext4 and 123 ms on tmpfs, down from 449 ms and 1,025 ms. Single-path writes
  with Windows entries on `PATH` complete without the sibling-permission error.

## Review follow-up

- Linux `nix flake check --keep-going -L` reports 746 pass, 12 skip, and 30
  failures. Failure names and multiplicities match the initial baseline exactly.
  Package, TypeScript, policy, merge, shell, layout, and test-path checks pass.
- The installed-layout check runs the real C batch protocol, compares it with
  single-path metadata, rejects malformed input, and accepts full path-count
  and input-byte chunks. On Darwin it requires known root-volume metadata.
- A local packaged-helper probe reports known-sensitive lookup for the ordinary
  tmpfs `/dev/shm` directory. Actual casefolded tmpfs directories remain untested.
- Plugin startup names unsupported path expressions and their denial or
  exception consequences on stderr. Valid JavaScript expressions still work
  on known-sensitive paths; warnings do not weaken alias-path refusals.
- Artifact and tracked Helm allowances use universal component or filename
  matches. Component names on case-sensitive directories can qualify beneath
  insensitive ancestors. Secret patterns still take precedence over artifact
  allowances.
- Native lookup now batches at most 256 paths and 64 KiB input per process.
  A regression test verifies one metadata process for 100 classified paths.
  Malformed results, inaccessible paths, and missing metadata fail closed.
- Tmpfs lookup uses its per-directory casefold flag rather than guessing from
  its filesystem type. Btrfs, XFS, OverlayFS, and DrvFS remain unknown until
  their lookup semantics can be established authoritatively.
- Exemption validation checks namespace and body ancestry separately and
  reports unresolved ancestry explicitly. It does not mutate a traversal list
  or accept unverified containment.

## Compatibility limits

This WSL mount does not expose the documented directory case attribute, so its
mode remains unknown. The guard overapproximates denials instead of guessing
case sensitivity. Case-sensitive `.env.example` exceptions, Helm-template
allowances, and name-based artifact allowances can therefore be refused on
Windows. Existing explicit directory exemptions remain precise capabilities.
They are broader than artifact allowances because they precede secret patterns;
they are not an equivalent workaround for ignored build files.
The naming-exception restriction also applies to known-insensitive volumes,
including default macOS APFS. It is not limited to unknown DrvFS metadata.
Known-sensitive paths keep their previous regex and allowance semantics.
An exception matched entirely within a known prefix, such as `^/nix/store/`,
can still apply despite uncertain missing descendants.

Validated file-tool exemptions pin their directory identities. Replacing a root
or retargeting its ancestor removes the grant; creating a root that was missing
at policy load requires reloading the policy. See
[the separate identity decision](adr/0002-file-tool-exemption-identities.md).

This is a file-tool improvement. It does not change the macOS kernel regex
profile or turn WSL files-only mode into shell isolation.
The pre-existing shell-side exemption-retargeting issue remains outside this
change. File identity checks do not eliminate inode reuse or check/use races.
