# Secret-guard path policy

Terminology for deciding access when paths have filesystem case aliases.

## Language

**Case alias**:
A different case spelling that filesystem lookup resolves to the same directory
entry. Distinct case-sensitive entries are not case aliases, even when they are
hardlinks to the same inode.
_Avoid_: Same-inode path

**Lookup sensitivity**:
Whether one directory distinguishes entry names by case. It belongs to that
directory, not necessarily to the whole operating system or mounted volume.
_Avoid_: Windows case mode

**Canonical spelling**:
The physical directory-entry spelling of an existing resolved path. A suffix
that does not exist has no canonical entry spelling yet.

**Root exemption**:
An explicit allowance for a literal path and its descendants. It is not a
case-insensitive text-prefix match.

**Pattern exception**:
A naming-based allowance, distinct from an entire permitted subtree.

**Protected entry**:
A directory entry that a deny rule protects after higher-priority exemptions
are accounted for. Changing the caller's case spelling must not unprotect it.
