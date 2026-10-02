# File-tool exemption directory identities

Status: locally implemented and reviewed; not activated or published.

## Problem

A running file-tool plugin keeps its loaded policy. Resolving an exemption anew
for every request lets a replaced directory or retargeted symlink move that
authority to another subtree. This weakness predates case-alias matching, but
would invalidate the claim that root exemptions remain precise capabilities.

## Decision

Pin each exemption's canonical directory and filesystem identity when validating
the policy. Keep that runtime binding private to the config object, not in the
serialized policy. Verify the declared entry and pinned directory on every use;
drop the grant if their identities or targets change.

An initially declared symlink may name a validated directory, but cannot later
retarget the grant. A missing root has no directory identity and cannot become
an exemption without loading a new policy. Validated production policies bind
at load; trusted programmatic configs bind on first use.

This immutable authority record is not a cached filesystem allow verdict. Every
grant still requires fresh filesystem checks. There are no watchers, retained
file descriptors, new dependencies, or policy-format fields.

## Scope

This change protects the persistent file-tool classifier. The macOS kernel
profile is unchanged; its CLI loads and validates a fresh policy for each shell
command. Binding kernel rules across commands would need a separate design and
real macOS execution evidence. Existing filesystem check/use races are not
claimed to be eliminated.
