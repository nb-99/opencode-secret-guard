import { hasAliasLookup, hasUnknownLookup, type PathEvidence } from "./paths.ts";

/** A bounded subset of path regexes, evaluated over filesystem case aliases. */
export type PatternPath = PathEvidence;

type Edge = { to: number; kind: "empty" | "start" | "end" | "literal" | "punctuation" | "component"; value?: string };
type Machine = { states: Edge[][]; start: number; end: number; prefilterSafe: boolean };
type Fragment = { start: number; end: number };
const MAX_STATES = 256;
const MAX_BRANCHES = 256;
const MAX_STEPS = 100_000;
const compiled = new Map<string, Machine | null>();

/** Literal deny roots use the same per-character lookup evidence, not global folding. */
function compareLiteral(target: PatternPath, literal: string): "equal" | "different" | "unknown" {
  for (let index = 0; index < Math.min(target.canonical.length, literal.length); index++) {
    const actual = target.canonical[index]!;
    const expected = literal[index]!;
    if (actual === expected) continue;
    const alias = target.insensitive[index] || index >= target.knownPrefixLength;
    if (alias && /[^\x20-\x7e]/.test(actual + expected)) return "unknown";
    if (!target.insensitive[index] || !/[a-z]/i.test(actual) || actual.toLowerCase() !== expected.toLowerCase()) return "different";
  }
  return target.canonical.length === literal.length ? "equal" : "different";
}

export function mayEqualPath(target: PatternPath, literal: string): boolean {
  return compareLiteral(target, literal) !== "different";
}

export function mayBeInside(target: PatternPath, root: string): boolean {
  const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
  const prefix = { ...target, canonical: target.canonical.slice(0, normalized.length) };
  const comparison = compareLiteral(prefix, normalized);
  if (comparison === "different") return false;
  if (comparison === "unknown") return true;
  return target.canonical.length === normalized.length || target.canonical[normalized.length] === "/";
}

function compile(source: string): Machine | null {
  if (source.length > 512) return null;
  const states: Edge[][] = [];
  let offset = 0;
  let depth = 0;
  const state = () => {
    if (states.length >= MAX_STATES) throw new Error("Pattern too large");
    states.push([]);
    return states.length - 1;
  };
  const edge = (from: number, to: number, kind: Edge["kind"], value?: string) => states[from]!.push({ to, kind, value });
  const atom = (): Fragment => {
    const start = state();
    const end = state();
    const character = source[offset++];
    if (character === "(") {
      if (++depth > 16) throw new Error("Pattern nesting too deep");
      const inner = expression();
      if (source[offset++] !== ")") throw new Error("Unclosed group");
      depth--;
      edge(start, inner.start, "empty");
      edge(inner.end, end, "empty");
    } else if (character === "[") {
      if (source.slice(offset - 1, offset + 4) === "[-_.]") {
        offset += 4;
        edge(start, end, "punctuation");
      } else if (source.slice(offset - 1, offset + 4) === "[^/]*") {
        offset += 4;
        edge(start, end, "empty");
        edge(start, start, "component");
      } else throw new Error("Unsupported character class");
    } else if (character === "\\") {
      const literal = source[offset++];
      if (!literal || !"\\.^$|?*+()[]{}-/".includes(literal)) throw new Error("Unsupported escape");
      edge(start, end, "literal", literal);
    } else if (character === "^" && offset === 1) edge(start, end, "start");
    else if (character === "$" && offset === source.length) edge(start, end, "end");
    else {
      if (!character || /[.^$|?*+()\[\]{}]/.test(character) || character.charCodeAt(0) > 127) {
        throw new Error("Unsupported regex syntax");
      }
      edge(start, end, "literal", character);
    }
    if (source[offset] === "?") {
      if (states[start]!.length !== 1 || states[start]![0]!.kind !== "literal") throw new Error("Unsupported optional group");
      offset++;
      edge(start, end, "empty");
    }
    return { start, end };
  };
  const sequence = (): Fragment => {
    const start = state();
    let end = start;
    while (offset < source.length && source[offset] !== "|" && source[offset] !== ")") {
      const next = atom();
      edge(end, next.start, "empty");
      end = next.end;
    }
    return { start, end };
  };
  const expression = (): Fragment => {
    const start = state();
    const end = state();
    for (;;) {
      const branch = sequence();
      edge(start, branch.start, "empty");
      edge(branch.end, end, "empty");
      if (source[offset] !== "|") break;
      offset++;
    }
    return { start, end };
  };
  try {
    const result = expression();
    if (offset !== source.length) return null;
    // Keep the optional regex shortcut bounded too. More complex supported
    // patterns use only the budgeted state machine, not a backtracking regex.
    const prefilterSafe = states.flat().filter((edge) => edge.kind === "component").length <= 1 &&
      (source.match(/\|/g)?.length ?? 0) <= 8 && (source.match(/\?/g)?.length ?? 0) <= 8 &&
      (source.match(/\(/g)?.length ?? 0) <= 2;
    return { states, ...result, prefilterSafe };
  } catch {
    return null;
  }
}

export function supportsAliasPattern(source: string): boolean {
  return compile(source) !== null;
}

/** Denials use possible matches; exceptions require every case spelling to match. */
export function matchPathPattern(source: string, target: PatternPath): { mayMatch: boolean; mustMatch: boolean } {
  const text = target.canonical;
  if (!hasAliasLookup(target)) {
    const matches = new RegExp(source).test(text);
    return { mayMatch: matches, mustMatch: matches };
  }
  const unknown = { mayMatch: true, mustMatch: false };
  // Non-printable names and Unicode casing are outside this bounded grammar.
  if (text.length > 4096 || /[^\x20-\x7e]/.test(text)) return unknown;
  if (!compiled.has(source)) {
    if (compiled.size >= 256) compiled.clear();
    compiled.set(source, compile(source));
  }
  const machine = compiled.get(source);
  if (!machine) return unknown;
  // Every supported ASCII case spelling is covered by /i. A negative result
  // rules out a match cheaply; only potential hits need universal evaluation.
  if (machine.prefilterSafe && !new RegExp(source, "i").test(text)) return { mayMatch: false, mustMatch: false };
  let steps = 0;
  const closure = (initial: Iterable<number>, position: number): number[] => {
    const visited = new Set(initial);
    visited.add(machine.start); // Unanchored RegExp.test can begin anywhere.
    const pending = [...visited];
    while (pending.length) {
      const from = pending.pop()!;
      for (const edge of machine.states[from]!) {
        if (++steps > MAX_STEPS) throw new Error("Pattern evaluation limit");
        if (edge.kind !== "empty" && !(edge.kind === "start" && position === 0) &&
          !(edge.kind === "end" && position === text.length)) continue;
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          pending.push(edge.to);
        }
      }
    }
    return [...visited].sort((left, right) => left - right);
  };
  // Each branch is the NFA state set for one class of lookup-equivalent spellings.
  // Accepted branches remain accepted, as RegExp.test searches for any match.
  type Branch = { states: number[]; accepted: boolean; knownMatch: boolean };
  try {
    const initial = closure([], 0);
    let branches: Branch[] = [{ states: initial, accepted: initial.includes(machine.end), knownMatch: initial.includes(machine.end) }];
    for (let position = 0; position < text.length; position++) {
      const character = text[position]!;
      // A literal spelling that covers ASCII cases need not cover Unicode
      // aliases or expansions. The opaque choice matches component wildcards
      // only, so exceptions cannot rely on an incomplete casing table.
      const choices = target.insensitive[position] && /[a-z]/i.test(character)
        ? [...new Set([character.toLowerCase(), character.toUpperCase(), "\0"])] : [character];
      const next = new Map<string, Branch>();
      for (const branch of branches) {
        if (branch.accepted) {
          next.set(branch.knownMatch ? "known" : "accepted", { ...branch, states: [] });
          continue;
        }
        for (const choice of choices) {
          const reached = new Set<number>();
          for (const from of branch.states) {
            for (const edge of machine.states[from]!) {
              if (++steps > MAX_STEPS) throw new Error("Pattern evaluation limit");
              if ((edge.kind === "literal" && edge.value === choice) ||
                (edge.kind === "punctuation" && "-_.".includes(choice)) ||
                (edge.kind === "component" && choice !== "/")) reached.add(edge.to);
            }
          }
          const states = closure(reached, position + 1);
          const accepted = states.includes(machine.end);
          const knownMatch = accepted && position + 1 <= target.knownPrefixLength;
          next.set(accepted ? knownMatch ? "known" : "accepted" : states.join(","), { states, accepted, knownMatch });
          if (next.size > MAX_BRANCHES) return unknown;
        }
      }
      branches = [...next.values()];
    }
    return {
      mayMatch: branches.some((branch) => branch.accepted),
      mustMatch: branches.every((branch) => branch.accepted && (!hasUnknownLookup(target) || branch.knownMatch)),
    };
  } catch {
    return unknown;
  }
}
