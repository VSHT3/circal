/* ------------------------------------------------------------------ *
 * Fuzzy matching, for the palette's ranking.
 *
 * The palette matched with `includes`, which means the letters have to be
 * consecutive: `design rev` found "Design review" and `dsgn rev` found
 * nothing, though only one of those is a sentence anybody types into a
 * search box in a hurry.
 *
 * So: a subsequence match with a score, and one wrong character forgiven.
 * `fuzzyScore` returns higher for the match a person means — letters at the
 * starts of words, letters in a run, a short title rather than a long note —
 * and `null` when the query simply is not in there. Nothing here knows about
 * events; it takes two strings.
 *
 * Greedy on purpose: each query character takes the *first* place it fits,
 * rather than the best. An optimal alignment is a dynamic program over every
 * candidate on every keystroke, and the ordering it buys is not visible at the
 * eight rows this list shows.
 * ------------------------------------------------------------------ */

/** Every match earns this, so a longer match beats a shorter one. */
const MATCH = 10;

/**
 * Straight after the previous match, and *rising* through a run: the second
 * consecutive letter earns `RUN`, the third `2 × RUN`. Flat, three letters in a
 * row scored the same as three letters at the starts of three words, so `run`
 * ranked "Roll up now" over "Morning run". A whole word is not an initialism.
 */
const RUN = 9;

/** At the start of a word — the letters a person actually types. */
const WORD_START = 12;

/** At the very start of the text, on top of the word-start bonus. */
const LEAD = 6;

/** Per character skipped to reach a match, up to `GAP_CAP` of them. */
const GAP = 1;
const GAP_CAP = 12;

/** Length costs a little, so `Run` outranks `Running club` for `run`. */
const LENGTH = 0.2;

/** What forgiving one query character costs. Always worse than a clean match. */
const TYPO = 40;

/** Shorter than this, a forgiven character would match almost anything. */
const TYPO_MIN = 4;

const WORD_BREAK = /[\s\-_/:.,(–—]/;

/**
 * `query`'s characters in order inside `text` from `start`, greedily. `null`
 * when they are not all there. Spaces in the query are ignored rather than
 * matched, so `design rev` and `designrev` score the same — a query's word
 * breaks are how people type, not a claim about where the text's breaks are.
 */
function scan(text: string, query: string, start = 0): number | null {
  let score = 0;
  let at = start;
  let previous = -2;
  let run = 0;

  for (const character of query) {
    if (character === " ") continue;
    const found = text.indexOf(character, at);
    if (found === -1) return null;

    score += MATCH;
    if (found === previous + 1) score += RUN * ++run;
    else {
      run = 0;
      score -= Math.min(found - at, GAP_CAP) * GAP;
    }
    if (found === 0) score += WORD_START + LEAD;
    else if (WORD_BREAK.test(text[found - 1])) score += WORD_START;

    previous = found;
    at = found + 1;
  }

  return score - text.length * LENGTH;
}

/**
 * The best greedy scan, tried from the first occurrence of the query's first
 * letter and from every later one that starts a word.
 *
 * Greedy alone is blind in one specific way: the first letter takes the
 * earliest place it fits, so `run` matched the `r` inside "Morning" and then
 * had to reach for the rest. Restarting at word starts costs a handful of
 * scans of a title and buys the alignment a person means — without a dynamic
 * program over every candidate on every keystroke.
 */
function bestScan(text: string, query: string): number | null {
  const first = query.replace(/\s+/g, "")[0];
  if (!first) return null;

  let best: number | null = null;
  let tried = false;
  for (let i = text.indexOf(first); i !== -1; i = text.indexOf(first, i + 1)) {
    // Every word start, plus the first occurrence wherever it happens to sit —
    // a title with no word starts at all must still match.
    if (tried && i !== 0 && !WORD_BREAK.test(text[i - 1])) continue;
    tried = true;
    const score = scan(text, query, i);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

/**
 * How well `text` answers `query`. Higher is better, `null` is no match, and
 * an empty query matches everything at `0` — which leaves whatever order the
 * caller had.
 *
 * One character of the query may be dropped, which covers a wrong letter
 * (`desgin`) and a transposition (`reveiw`) alike, since both leave a correct
 * subsequence behind once the offending character is gone. Only from four
 * characters up: below that, forgiving one leaves too little of a query to
 * mean anything.
 */
export function fuzzyScore(text: string, query: string): number | null {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return 0;
  if (!text) return null;

  const haystack = text.toLowerCase();
  const clean = bestScan(haystack, wanted);
  if (clean !== null) return clean;

  const letters = wanted.replace(/\s+/g, "");
  if (letters.length < TYPO_MIN) return null;

  let best: number | null = null;
  for (let i = 0; i < wanted.length; i++) {
    if (wanted[i] === " ") continue;
    const score = bestScan(haystack, wanted.slice(0, i) + wanted.slice(i + 1));
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best === null ? null : best - TYPO;
}
