# BANNED: ADDENDUM — WIT SUBSTITUTES

Companion to `BANNED - THE DEFINITIVE GUIDE.md`. Read both. Numbering continues from PART 1 / PART 2 of the main guide so the two can be merged later without collision.

**Core of this addendum:** the main guide catches _emotion_ substitutes — form standing in for feeling. This one catches _wit_ substitutes — syntax standing in for intelligence. Every pattern below is a construction the model reaches for when the narrator has nothing left to report but the paragraph is still running. They cluster wherever the prose is coasting.

**Discriminator:** these patterns evade the main guide by inflation. §2.5 bans `said flatly`; §4.1 below is `said flatly` in fourteen words. §1.2 bans nominal `something`; §4.6 is its adverbial twin. Banning the short form and missing the long form trains the model to write the long form.

---

## PART 4: WIT-SUBSTITUTE CONSTRUCTIONS

### 4.1 Laundered Adverb (Hypothetical-You Simile)

**Banned:** `the way you'd [ordinary social act]`, `the tone you'd use [gerund]`, `the way one would`, `the way a [occupation] does`, `the way you do when [situation]`.

Three diagnostic parts: generic second person (nobody in the scene); vehicle is a _social micro-genre_ rather than an image; an over-specified trivial decoration buying credibility.

> "He said it without any argument in it, the way you'd correct a child about the number of legs on a spider."
> "She said the next part the way you hold up a wet sock."
> "Ten people said it back the way you would read a company name off an invoice."
> "the way you'd agree about a bus timetable" · "the way you deal with a flyer" · "the way you walk round a car" · "the way you do a rucksack" · "the way sailors read a barometer"

**Why:** it is a dialogue-tag adverb, banned at §2.5, inflated past the length where the ban triggers. It glosses tone the dialogue failed to carry. `you` means the narrator has stepped out of her own head to address a stranger.

**Fix:** the tell is `you`. If the comparison earns its place, ground it in _this_ narrator's specific experience — `the way Aubry says his line about the boy`, `the way my mother arranges hers in a préfecture waiting room`. Those are observations. `the way you'd correct a child` is a shrug. Otherwise cut and let the line stand naked.

**Budget:** one per chapter, and it must be first-person-grounded.

---

### 4.2 Retro-Adjudicating Relative Clause

**Banned:** sentence completes, then `, which [narrator's verdict on what she just said]`.

Three species — only two are banned:

| Species               | Example                                                                                                                                                                                                              | Verdict            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Restrictive / factual | "the system they put in for the Games"                                                                                                                                                                               | keep, load-bearing |
| **Appraisal**         | ", which is not nothing" · ", which under the circumstances was funny to precisely one of us" · ", which I have never once asked about" · ", which I have never fully understood, and which works every single time" | **cut**            |
| **Copular gloss**     | "an expression she had never seen on him, which was surprise" · "logged in at position 12, which was empty"                                                                                                          | **cut**            |

**Why:** the appraisal clause is a confession that the main clause didn't land, appended rather than fixed. The copular gloss is the narrator labelling her own image in case the reader missed it — §2.34 (Narrator-as-Analyst) wearing a relative pronoun.

**Fix:** promote to its own sentence or delete. **Target under 2.0 per 1000 words.** Measure:

```sh
python3 - <<'EOF'
import re, glob
for f in sorted(glob.glob('chapters/*.typ')):
    t = open(f).read(); w = len(t.split())
    n = len(re.findall(r',\s*which\b', t))
    print(f, n, f"{1000*n/w:.1f}/kw")
EOF
```

---

### 4.3 Deadpan Verdict Sentence

**Banned:** short copular declaration assigning totality. `That is the entire event.` `That's all it is.` `That is what did it.` `That is how she knows.` `It is the only honest thing in the room.` `That's the last of it.` `That is the part I have never been able to explain.`

Signature: `it is` / `that is` + `the only | whole | entire | last | first | point | all it is`.

**Why:** not covered by §1.24 — these are not fake profundities, they are **superlative bookkeeping**. The narrator stamps a scene as significant instead of making it significant, using the cheapest syntax available. Excellent once. A verbal tic at eight, and the reader starts hearing the author instead of the narrator.

**Fix:** **one per chapter.** Keep the one that lands hardest; the rest become ordinary sentences or vanish. Watch for two inside 150 lines — that is the failure mode.

---

### 4.4 Everybody/Nobody Antithesis (Borrowed Credential)

**Banned:** universal-quantifier couplets certifying the narrator's unique perception. `Everyone remembers X. Nobody remembers Y.` `Everybody watches the weather. Nobody keeps the ledger.` `which no sane person does.`

**Also banned, same engine, first person:** `That is what nobody tells you about —`, `Nobody ever guesses that part.`, `which is rarer than people think`, `which happens more than you'd like to know`, `because nobody ever does`, `a pattern she had never been able to follow`.

**Why:** distinct from §1.24. This is not a fake insight, it is a **credential** — authority borrowed by asserting everyone else's ignorance. It flattens first person into a lecture, and it pre-empts the reader's own noticing, which was the only thing the sentence had to offer.

**Fix:** show the thing nobody notices; never announce that nobody notices it. `There is no falling.` stands. `Nobody ever guesses that part.` is the tell and goes.

---

### 4.5 Definitional Self-Correction

**Banned:** rejecting a word and then defining the rejected word, mid-scene. `— not numbness, numbness is information —` · `forgiving in a way that isn't kindness` · `That's not charity. That's the ledger.` · `It's just geography with feelings attached.`

**Why:** sibling to §1.4 (`not X, but Y`) and not caught by it — the second beat is not an alternative, it is a **lexicographical ruling**. The narrator pauses the scene to adjudicate vocabulary. Reads as precision; is the performance of precision. Costs momentum at exactly the moment the scene was about to land.

**Fix:** pick the right word first. If the distinction genuinely matters, it belongs in dialogue, where a character can be pedantic on purpose and pay for it.

---

### 4.6 "In a way that" — the Undescribed Manner

**Banned:** `[verb/adj] in a way that [clause]` where the clause is negative or abstract. `tired in a way that's difficult to describe` (admits the dodge outright) · `silent in a way that got into the walls` · `worse in a way that did not turn around` · `in a way that was not pleasant at all` · `a way of squinting that suggested arithmetic`.

**Permitted:** concrete and consequential — `hurt in a way that needs a doctor`. That specifies.

**Why:** §1.2 bans nominal `something` as interiority placeholder. This is the **adverbial** placeholder — a promise to specify the manner, broken in the same breath. The main guide bans the noun form and misses this entirely.

**Fix:** grep it. Negative or abstract clause after it → cut back to the verb and describe the manner or don't raise it.

---

### 4.7 Grudge-Bearing Object

**Banned:** inanimate thing given a dated backstory plus a continuing attitude. `a van that had been white in the 1990s and had been arguing about it ever since` · `the gutter that had come loose in March and had spent the spring pointing accusingly at the ground` · `shadows lying down across the grass like something exhausted`.

Scaffold: **decade + "ever since"**, or object + editorial adverb (`accusingly`).

**Why:** not §2.27 (cinematic wallpaper) — that bans atmosphere, this is object-personification-as-joke. The model reaches for it whenever a prop needs to be charming, and the charm is always the same charm.

**Fix:** objects may be old, broken, and specific. They may not have opinions. `The television belonged to her grandmother and does not turn on.` — correct, no attitude, does more work.

---

### 4.8 Ironic Attribute Pair

**Banned:** `with [a/no] [attribute] and [a/no] [deflating second attribute]`. `built for one purpose by somebody with no sense of humour and an unlimited budget` · `a man with a private gym and a poor idea of what to do in it` · `a landlady who had opinions about everything and shared roughly half of them` · `with a borrowed auger and a theory about wind that had turned out to be wrong`.

**Why:** the default wit generator — one straight noun, one wry qualifier, delivered as a `with`-phrase. Fine once. At five per chapter it means a man and a room get characterized by the _same joke shape_, and the narrator's humour stops being hers.

**Fix:** one per chapter. Never two within a scene. If two characters need describing, the second one gets a different grammar.

---

### 4.9 Motif-Number Saturation

**Banned:** buying specificity with odd exact numbers, then reusing the same number as though it were a motif. Symptom: one number appearing 8+ times across unrelated referents — _eleven weeks, eleven hectares, eleven years, eleven days, eleven orchards, the eleventh of October, the eleventh year, the eleventh in the series_.

**Why:** the model has no memory of having already spent that number. Real prose distributes low numbers naturally (`one`, `two`, `four` dominate) and repeats a specific figure only when it is canon. A saturated number reads as portent and delivers nothing.

**Permitted:** canon repetition — _eleven seconds_ (ARIANE's window), _nine days_ (le rappel), _two years and one month_. That is a system, not decoration.

**Related, also banned: the numeric-correction dialogue beat.** `"That's nine days." / "Ten."` — number-pedantry as a substitute for characterization. Earned only when the correction _is_ the magic system (`"Payette." / "Payet. The t is silent."`). Decorative anywhere else, and never three times in one text.

**Fix:** count. Any number over 8 occurrences must be load-bearing canon or gets redistributed.

---

## QUICK-SCAN: WIT SUBSTITUTES

| Search Term                                                                 | Action                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `the way you` / `you'd` / `one would` / `the way a [occupation] does`       | Laundered adverb — cut, or reground in narrator's own experience                |
| `, which is` / `, which was`                                                | Keep restrictive only; delete appraisal + copular gloss. Target <2.0/1000 words |
| `That is the` / `It is the` + `only\|whole\|entire\|last\|point\|all it is` | Superlative bookkeeping — one per chapter                                       |
| `Nobody ` / `Everybody ` / `nobody tells you` / `nobody ever guesses`       | Delete the borrowed credential; show the perception                             |
| `not X, X is Y` / `in a way that isn't`                                     | Stop adjudicating vocabulary mid-scene                                          |
| `in a way that`                                                             | Adverbial placeholder — cut to the verb                                         |
| `had been ... ever since` / object + `accusingly`                           | Object-with-a-grudge — delete the attitude                                      |
| `with a ... and a ...` / `with no ... and an ...`                           | Ironic attribute pair — one per chapter, never two per scene                    |
| any single number 8+ occurrences                                            | Canon or cut                                                                    |
| `"[Question]."` punctuated as statement                                     | Flat-interrogative tic — see 4.10                                               |

---

### 4.10 Flat Interrogative (watch, not yet banned)

Questions punctuated as statements — `"How."` · `"Which is what."` · `"Would you think less of me."` · `"Am I."` — signal literary flatness cheaply and are contagious. Six instances in one generated sample; three in one drafted chapter. **Budget: two per chapter, and only where the asker genuinely is not asking.** Beyond that the whole cast starts talking like one bored person.

---

## MEASUREMENT

Run after drafting any chapter, alongside the polysyndeton/tails check in `nearest-name/AGENTS.md`:

```sh
python3 - <<'EOF'
import re, glob, collections
P = {
 'laundered adverb': r"the way (you|one|a \w+ (does|do)|nobody)|the tone you'?d",
 ', which':          r',\s*which\b',
 'verdict sentence':  r"(That|This|It)(?:'s| is| was) (the (whole|entire|only|last|first|point|same|arrangement)\b|what|how|why|all it is)",
 'borrowed credential': r"[Nn]obody (tells|ever|knows|guesses)|rarer than people think|more than you'?d like to know|never been able to",
 'in a way that':     r'in a way (that|which)\b',
 'attribute pair':    r'with (a|an|no) [\w -]{2,28} and (a|an|no) [\w -]{2,28}',
 'grudge object':     r'had been [^.]{0,60}ever since',
 'flat interrogative': r'"(How|Why|What|Where|Who|Which|Would|Do|Did|Does|Can|Could|Is|Are|Am|Was|Were|Have|Has|Will)\b[^"?!]*\.\s*"',
}
for f in sorted(glob.glob('chapters/*.typ')):
    t = open(f).read(); w = len(t.split())
    hits = {k: len(re.findall(p, t)) for k, p in P.items()}
    # low numbers dominating is healthy; only distinctive figures can saturate
    nums = collections.Counter(x.lower() for x in re.findall(
        r'\b(five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|'
        r'seventeen|nineteen|twenty-one|twenty-two|forty|sixty|hundred)\b', t, re.I))
    hot = [f"{n}x{c}" for n, c in nums.most_common(3) if c >= 8]
    print(f"{f:28} {w:5}w  " + "  ".join(f"{k} {v}" for k, v in hits.items()) +
          ("  NUM " + " ".join(hot) if hot else ""))
EOF
```

Reference figures from the audit that produced this addendum, all reproducible with the script above — the generated control sample (`tets.md`, 5,383 words) against six drafted chapters of _Conductance_:

|                                            | control                       | drafted chapters              |
| ------------------------------------------ | ----------------------------- | ----------------------------- |
| `, which` per 1000 words                   | 5.0                           | 1.0 – 3.2 (06 is the outlier) |
| verdict sentences per chapter              | 10                            | 0 – 7                         |
| laundered adverbs per chapter              | 3                             | 1 – 4                         |
| `in a way that`                            | 5                             | 0 – 1                         |
| flat interrogatives                        | 6                             | 0 – 3                         |
| grudge objects                             | 1                             | 0                             |
| number saturation (8+, excluding one–four) | eleven ×14, nine ×11, six ×10 | none but `forty ×8` in 01     |

The laundered-adverb regex counts only the generic-you core. It deliberately does not count the permitted grounded form — `the way my mother arranges hers in a préfecture waiting room`, `the way Aubry says his line about the boy` — so the true raw frequency of the construction is roughly double the figure printed. Read the matches, not just the count.

The drafted prose is not clean. It is _quieter_, and it fails in the same places: the tells concentrate in aftercare, breakfast, and post-coital beats — anywhere the scene has stopped having something to report and the paragraph is still running.

---

**Final principle of this addendum:** the main guide's patterns substitute form for feeling. These substitute syntax for thought. Both produce the same symptom — a sentence that sounds like prose and reports nothing. If a construction exists to make the narrator seem clever, cut it. If a clause adjudicates the sentence before it, the sentence before it was wrong. If nothing has happened, do not be witty about it — end the scene.
