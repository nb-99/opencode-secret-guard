import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { matchPathPattern, mayBeInside, supportsAliasPattern, type PatternPath } from "../src/path-pattern.ts";

function evidence(text: string, foldFrom = text.length, uncertain = false): PatternPath {
  return { canonical: text, insensitive: [...text].map((_, index) => index >= foldFrom), knownPrefixLength: uncertain ? foldFrom : text.length };
}

function spellings(text: string, mask: boolean[]): string[] {
  let results = [""];
  for (let index = 0; index < text.length; index++) {
    const letter = text[index]!;
    const choices = mask[index] && /[a-z]/i.test(letter)
      ? [...new Set([letter.toLowerCase(), letter.toUpperCase()])] : [letter];
    results = results.flatMap((prefix) => choices.map((choice) => prefix + choice));
  }
  return results;
}

describe("lookup-aware path patterns", () => {
  test("default deny and exception patterns fit the bounded grammar", () => {
    const policy = JSON.parse(fs.readFileSync(new URL("../policy/default.json", import.meta.url), "utf8"));
    for (const pattern of [...policy.secretPatterns, ...policy.secretExceptions]) {
      expect(supportsAliasPattern(pattern)).toBe(true);
    }
  });

  test("possible and universal matches agree with exhaustive legacy regex evaluation", () => {
    const patterns = ["/\\.env$", "/\\.ENV$", "^/x/", "/secret\\.(json|ya?ml)$", "[-_.]a[-_.][^/]*$",
      "/\\.env\\.(example|sample)$", "a?b", "a|b", "[^/]*", "/\\.kube/"];
    for (const text of ["/x/.env", "/x/.ENV", "/x/a.yml", "/X/.kube/a", "/x/-a-b", "/x/ab", "/x/.env.sample"]) {
      for (const from of [0, 3, text.length]) {
        const target = evidence(text, from);
        for (const pattern of patterns) {
          const expected = spellings(text, target.insensitive).map((spelling) => new RegExp(pattern).test(spelling));
          const result = matchPathPattern(pattern, target);
          expect(result.mayMatch).toBe(expected.some(Boolean));
          if (result.mustMatch) expect(expected.every(Boolean)).toBe(true);
          if (!target.insensitive.some(Boolean)) expect(result.mustMatch).toBe(expected.every(Boolean));
        }
      }
    }
  });

  test("both stored case directions remain possibly protected", () => {
    expect(matchPathPattern("/\\.env$", evidence("/x/.ENV", 3)).mayMatch).toBe(true);
    expect(matchPathPattern("/\\.ENV$", evidence("/x/.env", 3)).mayMatch).toBe(true);
  });

  test("ASCII-complete exceptions cannot grant access through unmodelled Unicode aliases", () => {
    for (const prefix of ["(k|K)", "(s|S)", "(f|F)(f|F)"]) {
      const literal = prefix === "(f|F)(f|F)" ? "ff" : prefix[1]!;
      const target = evidence(`/x/${literal}-1.pem`, 3);
      const pattern = `/${prefix}-1\\.(p|P)(e|E)(m|M)$`;
      expect(matchPathPattern(pattern, target)).toEqual({ mayMatch: true, mustMatch: false });
    }
  });

  test("Unicode alias spellings remain possible denials", () => {
    expect(matchPathPattern("/secrets/", evidence("/x/ſecrets/key", 3, true)).mayMatch).toBe(true);
    expect(matchPathPattern("/\\.kube/", evidence("/x/.Kube/config", 3, true)).mayMatch).toBe(true);
  });

  test("evaluation budget exhaustion cannot become an exception", () => {
    const pattern = "a?".repeat(60) + "z$";
    expect(supportsAliasPattern(pattern)).toBe(true);
    expect(matchPathPattern(pattern, evidence("a".repeat(3000), 0))).toEqual({ mayMatch: true, mustMatch: false });
  });

  test("sensitive child names stay distinct even beneath insensitive ancestors", () => {
    const target = evidence("/X/.ENV");
    target.insensitive[1] = true;
    expect(matchPathPattern("/\\.env$", target).mayMatch).toBe(false);
    expect(matchPathPattern("^/x/", target).mayMatch).toBe(true);
  });

  test("a case-sensitive pattern exception cannot erase a denial through another alias", () => {
    const target = evidence("/x/.env.example", 3);
    expect(matchPathPattern("/\\.env\\.[^/]*$", target).mayMatch).toBe(true);
    expect(matchPathPattern("/\\.env\\.example$", target).mustMatch).toBe(false);
  });

  test("unsupported expressions keep legacy behavior on sensitive paths only", () => {
    for (const pattern of ["(?=a)a", "(a)\\1", "[a-z]", "a+", "a{2}", "\\p{L}", "(?:a)", ".*"]) {
      expect(supportsAliasPattern(pattern)).toBe(false);
      expect(matchPathPattern(pattern, evidence("/x/aa"))).toEqual({
        mayMatch: new RegExp(pattern).test("/x/aa"), mustMatch: new RegExp(pattern).test("/x/aa"),
      });
      expect(matchPathPattern(pattern, evidence("/x/aa", 3))).toEqual({ mayMatch: true, mustMatch: false });
    }
  });

  test("case-insensitive JavaScript evaluation is not a denial overapproximation", () => {
    const pattern = "^/x/(?!SECRET$)[^/]+$";
    expect(new RegExp(pattern).test("/x/secret")).toBe(true);
    expect(new RegExp(pattern, "i").test("/x/secret")).toBe(false);
    expect(matchPathPattern(pattern, evidence("/x/secret", 3)).mayMatch).toBe(true);
    expect(new RegExp("/secrets/", "i").test("/x/ſecrets/key")).toBe(false);
    expect(matchPathPattern("/secrets/", evidence("/x/ſecrets/key", 3, true)).mayMatch).toBe(true);
  });

  test("wildcards can prove exceptions over known-insensitive descendants", () => {
    expect(matchPathPattern("^/x/[^/]*$", evidence("/x/Name", 3)))
      .toEqual({ mayMatch: true, mustMatch: true });
  });

  test("uncertainty, Unicode, newlines, and resource limits never grant exceptions", () => {
    for (const target of [evidence("/x/A", 3, true), evidence("/x/Ä", 3), evidence("/x/a\n", 3),
      evidence("/x/" + "a".repeat(5000), 3)]) {
      expect(matchPathPattern("a$", target).mustMatch).toBe(false);
    }
    expect(matchPathPattern("a".repeat(513), evidence("/x/A", 3))).toEqual({ mayMatch: true, mustMatch: false });
  });

  test("an anchored known-prefix exception does not depend on uncertain descendants", () => {
    const target = evidence("/nix/store/missing/deeper/.env", 19, true);
    target.knownPrefixLength = 19;
    expect(matchPathPattern("^/nix/store/", target)).toEqual({ mayMatch: true, mustMatch: true });
    expect(matchPathPattern("/\\.env$", target).mustMatch).toBe(false);
  });

  test("uncertain letter-free suffixes cannot grant exceptions", () => {
    const target = evidence("/x/.-", 1, true);
    target.knownPrefixLength = 3;
    expect(matchPathPattern("/\\.-$", target)).toEqual({ mayMatch: true, mustMatch: false });
  });

  test("a prefix exception must end before the first unknown character", () => {
    const target = evidence("/x/.y", 4, true);
    target.knownPrefixLength = 3;
    expect(matchPathPattern("^/x/\\.", target).mustMatch).toBe(false);
    target.knownPrefixLength = 4;
    expect(matchPathPattern("^/x/\\.", target).mustMatch).toBe(true);
  });

  test("uncertain Unicode descendants cannot erase a proved different root prefix", () => {
    const target = evidence("/mnt/c/allowed/Ä", 7, true);
    expect(mayBeInside(target, "/home/cache")).toBe(false);
    expect(mayBeInside(target, "/mnt/c/allowed")).toBe(true);
    expect(mayBeInside(evidence("/mnt/c/SS/child", 7, true), "/mnt/c/ß")).toBe(true);
    expect(mayBeInside(evidence("/mnt/c/SS/child", 7), "/mnt/c/ß")).toBe(true);
  });
});
