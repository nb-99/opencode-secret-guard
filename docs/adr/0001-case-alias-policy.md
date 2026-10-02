# Case-alias policy matching

Status: locally implemented and reviewed; not activated or published.

## Problem

DrvFS may return the caller's spelling from `realpathSync`. Normalizing to a
physical entry name closes one bypass but can erase a denial when that physical
name uses another case. Lowercasing all paths would conflate distinct Linux
entries and could broaden root exemptions.

## Decision

Keep filesystem evidence separate from pattern matching. Inspect the resolved
path and obtain lookup sensitivity for each component's parent directory.
Use authoritative metadata where the platform exposes it. Unknown metadata
must not be interpreted as case sensitivity.

On known-sensitive paths, retain JavaScript regex behavior. On insensitive or
unknown paths, evaluate a small positive regex grammar over possible ASCII
case spellings. A deny pattern applies if any spelling can match. A pattern
exception applies only if every spelling matches and lookup evidence is known.
Resource exhaustion and unsupported syntax mean possible denial, never a grant.
An exception matched completely before the first unknown component can still
grant access; uncertain descendants cannot invalidate an already established
prefix match.

The grammar supports ASCII literals, escaped punctuation, concatenation,
groups and alternatives, optional literal characters, `[-_.]`, `[^/]*`, and
outer anchors. It covers the shipped file patterns. Opaque alternatives at
case-variable ASCII positions prevent exceptions from relying on incomplete
Unicode casing tables. It deliberately excludes
lookaround, backreferences, arbitrary classes, general repetition, and Unicode
case rules. Environment and command regexes keep their existing semantics.

Root exemptions remain explicit directory capabilities. They require an
existing directory and exact canonical containment, not a folded string prefix.
Their persistent file-tool identities are bound separately as described in
[the exemption identity decision](0002-file-tool-exemption-identities.md).
Cache and tamper protection take precedence. Missing deny-root suffixes use
conservative lookup matching.

Git remains responsible for ignore-pattern syntax. For alias-bearing paths,
every case-folded rule hit, including a negation, is protected.
Name-based artifact allowances and tracked
Helm-template exceptions do not grant alias-wide access. Sensitive paths retain
their existing behavior.

## Consequences

The fix may refuse legitimate files on unknown or known-insensitive filesystems,
including default macOS APFS. In particular, `.env.example` cannot use its
case-sensitive pattern exception across all case aliases.
A deliberately permitted subtree can use an existing explicit root exemption.
The guard must not silently create such an exemption or widen one.

The current WSL mount does not expose `system.wsl_case_sensitive`. Its metadata
is unknown. This implementation must not claim authoritative WSL directory-mode
detection. The kernel sandbox's regex policy is unchanged; this decision governs
the file-tool classifier, not a new shell-security guarantee.

Plain `realpath` resolution does not launch a helper. Only classified targets and
explicit exemption roots need lookup evidence. Batch classification inspects each
target once, verifies pinned exemptions once per batch, and asks Git once per
repository. No filesystem grant is cached between calls. Simple supported
patterns use a negative regex prefilter; complex patterns use only the bounded
state machine.

## Required evidence

- Both physical casing directions remain protected, including custom uppercase
  deny rules over lowercase entries.
- Ext4 case-distinct entries and hardlinks remain distinct.
- Mixed directory modes, missing descendants, root exemptions, symlinks, and
  tamper paths preserve their boundaries.
- Bounded pattern results agree with exhaustive regex evaluation of small case
  domains. Unsupported syntax and budget limits cannot grant access.
- Native read and patch on synthetic Windows fixtures refuse both aliases and
  leave denied files unchanged.
