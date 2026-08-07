import { describe, expect, it } from "vitest";
import { fuzzyScore } from "@/lib/fuzzy";

/** The winner of a field of candidates, which is all the palette ever asks. */
function best(query: string, candidates: string[]): string | null {
  const ranked = candidates
    .map((text) => ({ text, score: fuzzyScore(text, query) }))
    .filter((hit): hit is { text: string; score: number } => hit.score !== null)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.text ?? null;
}

describe("fuzzyScore matches", () => {
  it.each([
    { query: "review", text: "Design review" },
    { query: "design rev", text: "Design review" },
    // The gap case the old `includes` could not answer.
    { query: "dsgn rev", text: "Design review" },
    { query: "dr", text: "Design review" },
    { query: "DESIGN", text: "design review" },
    { query: "  review  ", text: "Design review" },
  ])("finds $query in $text", ({ query, text }) => {
    expect(fuzzyScore(text, query)).not.toBeNull();
  });

  it.each([
    { query: "xyz", text: "Design review" },
    // Order is part of the query: the letters are all there, backwards.
    { query: "weiver", text: "Design review" },
    { query: "reviewer", text: "review" },
    { query: "anything", text: "" },
  ])("refuses $query in $text", ({ query, text }) => {
    expect(fuzzyScore(text, query)).toBeNull();
  });

  it("scores an empty query at zero rather than refusing it", () => {
    expect(fuzzyScore("Design review", "")).toBe(0);
    expect(fuzzyScore("Design review", "   ")).toBe(0);
  });
});

describe("fuzzyScore forgives one character", () => {
  it.each([
    { query: "reveiw", note: "a transposition" },
    { query: "reveiew", note: "a doubled letter" },
    { query: "revuew", note: "a wrong letter" },
    { query: "desgin", note: "a transposition earlier in the word" },
  ])("still finds $note ($query)", ({ query }) => {
    expect(fuzzyScore("Design review", query)).not.toBeNull();
  });

  it("does not forgive two", () => {
    expect(fuzzyScore("Design review", "rvewie")).toBeNull();
  });

  // Below four characters, dropping one leaves too little of a query to mean
  // anything — `xy` would match half the calendar.
  it("does not forgive a character in a short query", () => {
    expect(fuzzyScore("Design review", "rv")).not.toBeNull();
    expect(fuzzyScore("Design review", "xv")).toBeNull();
  });

  it("ranks a clean match above a forgiven one", () => {
    const clean = fuzzyScore("Design review", "review");
    const typo = fuzzyScore("Design review", "reveiw");
    expect(clean).not.toBeNull();
    expect(typo).not.toBeNull();
    expect(clean!).toBeGreaterThan(typo!);
  });
});

describe("fuzzyScore ranks the way a person reads", () => {
  it("puts a word start above the middle of a word", () => {
    expect(best("des", ["Predesign sync", "Design review"])).toBe("Design review");
  });

  it("puts consecutive letters above scattered ones", () => {
    expect(best("run", ["Roll up now", "Morning run"])).toBe("Morning run");
  });

  it("prefers the shorter of two equal matches", () => {
    expect(best("run", ["Run", "Running club committee"])).toBe("Run");
  });

  it("prefers a match at the very start", () => {
    expect(best("call", ["Weekly call", "Call home"])).toBe("Call home");
  });

  it("treats a query's spaces as free, not as text breaks", () => {
    expect(fuzzyScore("Designreview", "design rev")).not.toBeNull();
  });

  it("is stable across case", () => {
    expect(fuzzyScore("DESIGN REVIEW", "design review")).toBe(
      fuzzyScore("design review", "DESIGN REVIEW"),
    );
  });
});
