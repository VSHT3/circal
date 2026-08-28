# Roadmap

**Status:** ordered plan, agreed 2026-08-27. `TODO.md` holds loose ends, `IDEAS.md` the
brainstorm, `TASKS.md` one full spec; this file holds the _order_ and the items that
belong to no other file. When something ships it leaves here, `TODO.md`'s own rule.

Context the older files predate: the MCP server grew a second transport
(`circal-mcp --cloud` — the encrypted Supabase row, decrypted only on the user's
machine; `mcp/README.md`), `circal-mcp login` discovers the project from the site's
own `/mcp.json`, `circal-mcp@0.3.0` is published, and `/assistant/` teaches both
routes. The mirror file is no longer the only door an assistant has. Domain
posture (2026-08-27): DMARC moved to `p=quarantine` (SPF, DKIM and the Resend
records on `bounce.send.circal.day` were verified aligned first) and DNSSEC is
enabled — `circal.day` sits on Cloudflare Registrar, so the DS record reaches
the parent zone by itself.

---

## Tier 2 · Verbs in the palette (days) — IDEAS #9

`move standup to 10`, `push lunch 30m`. Moved up because the MCP made it load-bearing:
the assistant's tools and the palette should speak one grammar, and this makes the
fastest interaction in the app not need the AI at all. `parseQuickAdd`'s
right-to-left scanner grows verb heads; targets resolve through `fuzzyScore`;
the scope question reuses `ScopeChoices`. One grammar, three inputs: tap, type, ask.

## Tier 3 · Tasks (weeks) — TASKS.md, staged as written

The big rock and the "proper calendar" gap: deadline, estimate and planned time as
three numbers, drag a row onto the rim, auto-schedule into free gaps. Ship in the
spec's five stages; 1–3 (model, sidebar + editor, face) are the value, 4–5 (drag,
auto-schedule) the delight. Two amendments to the spec:

- §11's MCP tools route through the `Store` seam, so they serve the file and the
  cloud row alike without knowing which.
- IDEAS #3 (day-shape templates) folds into stage 5 rather than shipping alone —
  it exists to feed auto-schedule's `freeGaps`, and building it earlier is building
  an input with no consumer.

## Tier 4 · Spread the product (parallel-friendly)

- **IDEAS #14, Save this face.** SVG/PNG export of a day or year. Screenshots of
  dials are already how circal spreads; give them a verb. `window.__circalSave`
  answers the WKWebView half already. Build first in this tier: its output is the
  next item's artwork.
- **`/tour/` — the missing page.** The site answers _why_ (`/manifesto/`) and _how
  to wire an AI_ (`/assistant/`) and never _what_. One static page in the same
  voice: the four views, AI access, sync, the mac app, the keyboard table — each
  illustrated with a real exported face from #14, not screenshots that rot. Also
  the whole of circal's SEO surface: the app is `client:only`, so today a crawler
  sees nearly nothing. Linked from Settings beside the manifesto, and the future
  onboarding card's "show me around" points here. **Not** a separate marketing
  site, no hero section, no pricing page: `/` opening into a working dial is the
  strongest landing page a local-first product can have, and a brochure would
  concede the manifesto's argument.
- **A `.mcpb` desktop extension.** One-click circal in Claude Desktop's connector
  directory with the promise intact: the bundle runs the MCP server _locally_
  (no terminal, no Node install, no JSON), sensitive config lands in the OS
  keychain, and the emailed sign-in code arrives through MCP elicitation as an
  in-chat question. The hosted-connector route (ChatGPT, Perplexity) stays
  refused: a server that can answer "what's on Thursday" is a server holding the
  key, and that is the one door the product is built to keep shut.
- **WebMCP, natively.** A new browser standard (`document.modelContext`,
  experimental in Chrome 146): a page registers tools an _in-browser_ agent can
  call, so the agent drives the app instead of guessing at its DOM. This is the
  fourth assistant door and the most circal-shaped of all of them — the agent,
  the tools and the calendar are all in the same browser, so nothing new leaves
  it and no key moves anywhere. One feature-detected module in the island,
  registering the domain layer the MCP server already exposes (list a day,
  quick-add, free slots; writes keep the same scope-question refusals). Costs a
  lazy chunk and a careful think about which write verbs an in-page agent gets.
  Deliberately **not** Cloudflare's dashboard toggle: that injects an
  edge-served script into every page — a third party's code inside an
  end-to-end-encrypted app — and its two packs (C2PA images, a same-origin
  `/mcp` proxy) fit a product circal is not. Native or nothing.
- **`/mac/`** — only when the app bundle is actually distributed; one page, one
  download, the four bridges in a sentence each.

## Tier 5 · Ink-earners (small; between big things)

- **IDEAS #12, daylight across the year ring.** Day length over a year is one
  picture only a circular year draws; `sun.ts` ships already. Rim _background_
  tint, so it survives the no-new-rings rule.
- **IDEAS #2, travel time.** A hand-typed "leave by" pip ahead of an arc — the most
  clock-face-native feature on any of these lists, one `CalEvent` field through
  the `readEvent` checklist, and reminders get it for free.
- **Typical-weekday ghost** (TODO.md). Past instances of the viewed weekday, faint,
  on the same lanes. The one idea that says something the calendar does not
  literally contain.
- **Onboarding's teaching half** (TODO.md). One `BirthPrompt`-shaped card: ⌘P, the
  four views, the drag. The intro animation seduces; nothing yet teaches.

## Tier 6 · Chores basket

Settings cleanup pass · mark pinning · the dial's `sr-only` listbox for ended
events (the third listbox; a real a11y gap) · IDEAS #10 day notes, re-evaluated
after tasks land (a task's own notes may eat the demand) · **a sitemap**
(`@astrojs/sitemap`, four pages — worthless alone, worth one line when `/tour/`
gives crawlers something to find) · a hand-crafted-blob crash: valid JSON in
`circal.v1` with fields no real build ever omitted takes the dial into the
error boundary — the boundary behaves (backup offered, data whole) and the
shape needs a hand edit, so it is a hardening note, not a bug. Gone from this
basket, verified rather than built: the all-day drag reachability fix (a draw's
sweep has been unbounded since the midnight-crossing drag — a whole turn from
any start already lands an all-day draft, driven in a browser to confirm) and
the `AGENTS.md` mcp/ refresh (done — the row now names both transports, the
`Store` seam, `login` and the thirteen tools).

## Parked, with reasons

- **IDEAS #19, Google write-back.** Months (foreign data model, sync tokens,
  OAuth verification), and its own entry already says: deferred until demand
  shows up after launch. The plaintext-in-Google trade is the travel prompt's
  conversation to have then.
- **Whole calendar as a link** — TODO.md's arithmetic already killed it.
- **Mirror findability** (TODO.md) — superseded whole: the cloud copy is the sync
  people were looking for, `/assistant/` teaches both routes, and the Mirror and
  Cloud cards print their own terminal commands (the trust patches, shipped
  2026-08-27 along with the empty-slot caption and the disconnect toasts).
- **Cloudflare's agent-readiness checklist, the rest of it.** Managed robots.txt
  and AI-crawler rules are on (the dashboard's own toggles). Markdown
  negotiation is a Pro-plan feature for a site whose whole text is four prose
  pages; the Level 2–3 items (API catalog, OAuth discovery, A2A agent card,
  Web Bot Auth) describe a product with a public API, which circal is not —
  its agent surface is MCP, deliberately. Commerce: no.
- **IDEAS #6 jog-wheel, #16 editable palette, #17 density presets** — delight
  without a driving complaint; cheap to add later, cheap to skip now.
- **Moon position/text, a map for `location`, pomodoro** — TODO.md's own tiers,
  unchanged.

## The through-line

Tier 2 makes circal the calendar that is fastest to _act on_: tap a slot, type a
verb, ask an assistant — three inputs, one grammar, no server able to read any of
it. That is a positioning no grid calendar can copy, and every later tier
(tasks, the tour, the connector) compounds it.
