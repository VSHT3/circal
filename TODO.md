# todo

Done work is not recorded here. The rationale that outlived it lives in `AGENTS.md`, next to the
code it constrains — so an item finishing means it leaves this file rather than gaining a strike.

The instrument is finished and the calendar under it is real: RFC 5545 in and out, four views of
one idea, a test suite in the gate. The mirror's four driven-out bugs and their residue are all
fixed; the rationale lives in `AGENTS.md` beside the code. Nothing below adds a screen — it is a
short list of things that finish something already started. The _ordering_ across this file,
`TASKS.md` and `IDEAS.md` lives in `ROADMAP.md`.

## open

**A whole calendar as a link — open question, not a decision.** Measured first: a thousand events
is ~32 KB gzipped, ~43 KB as base64url. That rules out the two carriers that make the one-event
link worth having (a chat message, a QR code — the latter caps at 2,953 bytes), and everything that
_can_ carry 43 KB of text can carry the `.json` file just as easily, so as it stands the encoding
adds a step rather than removing one. Two things would have to be answered before building it: what
carries it, and what stops a truncated paste. The second is not hypothetical — `shareCheck` exists
because a link cut on a base64 boundary decodes into a _plausible_ event with one field silently
wrong, and at this size being cut short is the common case rather than the edge one.

**Settings alone as a link is a separate, cheaper item.** ~842 characters of JSON, ~192 packed the
way `share.ts` already packs, against a `SHARE_MAX` of 1,600 — small enough to QR off one screen
and scan with the other machine. Three fields must not travel, by the rule `share.ts` and
`duplicateOf` already state: `deviceZone` (it is the only "before" the travel notice has),
`stampedZones` (what _this_ browser's answer stamped) and `defaultCalendar` (an id that does not
exist over there).

**Typical-weekday ghost.** Past instances of the viewed weekday drawn faint behind the real arcs,
on the same lanes so it costs no radius. The one idea here that would tell you something the
calendar does not already contain — what a Tuesday is usually like, rather than what this Tuesday
holds.

**Settings cleanup.** Thirty-eight fields across the panel's balanced columns. Worth a pass for
grouping and for rows that have drifted from the section they sit in.

**Moon: position and text.** The sidebar's moon has no controls beyond on/off. Where it sits and
whether it names the phase are both reasonable asks.

**Marks: pinning, and more of them.** 247 Phosphor glyphs, searchable, and no way to keep the six
you actually use at the top. Pinning is the cheaper half. Growing the set is allowed at ~180 gzipped
bytes an icon and may **not** grow back onto the first frame — `ui/marks.ts` has no static importer
and that is what took 42,936 bytes off the critical path.

## undecided

**A map for `location`.** Would need a tile provider, which is a network request to somebody else
on every event with an address — against "nothing leaves this browser". A link out to a map is the
version that costs nothing, and it is not obvious it is worth a row.

**Pomodoro / timer.** A timer is not a calendar, and the dial is a clock face rather than a
stopwatch. Filed because it keeps coming back, not because it has an argument yet.

## what not to do

- **No seven-column grid.** The circle is the argument and a grid concedes it. Seven _dials_ do not,
  which is what ⌘E is.
- **No anonymous relay, and still no second API route.** This entry forbade two things and only one
  of them shipped, so it now says which. What is still refused is the _relay_: anonymous storage
  keyed by a memorable passphrase, which needs a TTL, size caps, rate limits and somebody answering
  abuse mail, and whose ciphertext is fetchable by anyone holding a guess — offline-brute-forceable
  unless it runs a real PAKE, which is not something to hand-roll here. What shipped is not that.
  `cloudLink.ts` puts the ciphertext behind an authenticated session (`SYNC.md` Phase 2), so a guess
  is a guess against a row a stranger cannot fetch, and the passphrase stopped being the only thing
  between them and a calendar. "Nothing leaves this browser" is still the default and still the
  product: sync is off until somebody asks for it, and what leaves is a box sealed in the browser.
  The route half is untouched — `supabase-js` talks straight to `*.supabase.co`, so `/api/feed`
  remains the only thing the Worker serves.
- **Do not add a ring to the dial.** Every radius costs `PAD` and legibility, and that face carries
  four plus two bands. The room is in the interior. Anything that is not a fact about the _day_ goes
  to the sidebar, which is where the moon went.
- **Do not put a year-scale summary in the year ring's middle.** Busiest month, longest empty run —
  computable, and nobody opens a year to be told which month was busy. `settings.yearQuote` is a
  line the user writes, and it shows only at rest.
- **Do not bring back the hour detent.** It measured 1.3 dB in a stream against a click-to-click
  spread of 0.1 dB, went unnoticed for months, and retuning it to a real 4 dB proved the point
  rather than fixing it: the readout prints the whole span for the length of the drag, so an audible
  accent is a second answer to an answered question. If a drag ever needs a second signal, the
  readout is the one that already works.
- **Do not add a second search.** `scoreEvent` is the whole of "does this match" for the palette and
  for both lit faces. A second matcher means a day can light for a query the list would not find.
- **Do not rank the palette by recency.** The tiebreak it would replace is nearness to the day you
  are standing on, in an app whose thesis is that where you are in time is the organising fact.
