import { describe, expect, it } from "vitest";
import {
  dim,
  formatAge,
  formatCount,
  formatLifeDate,
  lifeCellAt,
  lifeDensity,
  lifeDot,
  lifeDotX,
  lifeDotY,
  lifeFraction,
  lifeMilestones,
  lifeRowTop,
  lifeSpan,
  lifeStage,
  lifeStats,
  lifeYearRange,
  type LifeSpan,
} from "@/lib/life";
import { LIFE_EXPECTANCY_RANGE } from "@/lib/store";
import { addDays } from "@/lib/time";
import { calendar, day, event, ms, show } from "./helpers";

/* ------------------------------ lifeCellAt ------------------------------ */

describe("lifeCellAt is the exact inverse of lifeDotX/lifeDotY", () => {
  // A realistic desktop panel — wide enough that the split algorithm has
  // room to breathe.
  const stage = lifeStage("1990-01-01", 40, 1400, 900);
  if (!stage) throw new Error("stage must resolve for a normal desktop box");
  const { span, layout } = stage;

  it("round-trips every day of several representative years", () => {
    // 1990: birth year, 1 Jan is a Monday (offset 0, no leading blanks).
    // 2023: 1 Jan is a Sunday — the widest leading gap a row can have.
    // 2024: a leap year, so the row carries the extra day.
    // 2028: a leap year whose 1 Jan also falls late in the week (Saturday).
    // 2030: death year — birth + 40 years lands on 1 Jan, so only its first
    //       day is actually inside the span.
    const years = [1990, 2023, 2024, 2028, 2030];
    const failures: string[] = [];

    for (const year of years) {
      for (let d = new Date(year, 0, 1); d.getFullYear() === year; d = addDays(d, 1)) {
        if (d < span.birth || d > span.death) continue;
        const dot = lifeDot(layout, span, d);
        if (!dot) {
          failures.push(`${show(d)}: lifeDot returned null for a day inside the span`);
          continue;
        }
        const back = lifeCellAt(layout, span, dot.x, dot.y);
        if (!back || +back !== +d) {
          failures.push(`${show(d)} -> ${back ? show(back) : "null"}`);
        }
      }
    }

    // Report the first few, not thousands of individual assertions.
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it("snaps to the nearest dot inside the gap between week groups", () => {
    // Column 6 is the Sunday of the birth week (1 Jan 1990 was a Monday, so
    // this is 7 Jan). A point in the middle of the gap that follows it — not
    // over any dot at all — must still resolve, to that same day.
    const sundayDot = { x: lifeDotX(layout, 6), y: lifeDotY(layout, 0) };
    const gapX = layout.offsetX + 7 * layout.pitchX + layout.weekGap / 2;
    const inGutter = lifeCellAt(layout, span, gapX, sundayDot.y);
    const onTheDot = lifeCellAt(layout, span, sundayDot.x, sundayDot.y);
    expect(inGutter).not.toBeNull();
    expect(+inGutter!).toBe(+onTheDot!);
    expect(inGutter).toBeSameInstantAs("1990-01-07");
  });

  it.each([
    {
      name: "x left of the field",
      x: () => layout.offsetX - 10,
      y: () => lifeDotY(layout, 0),
    },
    {
      name: "y above the field",
      x: () => lifeDotX(layout, 0),
      y: () => layout.offsetY - 10,
    },
    {
      name: "y past the last row",
      x: () => lifeDotX(layout, 0),
      y: () => layout.offsetY + layout.height + 100,
    },
    {
      name: "x past the last column",
      x: () => layout.offsetX + layout.width + layout.pitchX * 10,
      y: () => lifeDotY(layout, 0),
    },
    {
      // 1 Jan 1991 is a Tuesday (offset 1): column 0 of that year's first
      // line is a leading blank, not a day at all.
      name: "a year's leading blank column",
      x: () => lifeDotX(layout, 0),
      y: () => lifeDotY(layout, (1991 - layout.birthYear) * layout.linesPerYear),
    },
  ])("returns null for $name", ({ x, y }) => {
    expect(lifeCellAt(layout, span, x(), y())).toBeNull();
  });
});

/* -------------------------------- lifeSpan -------------------------------- */

describe("lifeSpan", () => {
  it.each([
    {
      name: "a leap-day birth, one year of expectancy: 2001 has no 29 Feb, so it rolls to 1 Mar",
      birth: "2000-02-29",
      years: 1,
      wantDeath: "2001-03-01",
      wantDays: 367,
      wantYears: 2,
    },
    {
      name: "a leap-day birth, four years of expectancy: 2004 is leap, so it lands back on 29 Feb",
      birth: "2000-02-29",
      years: 4,
      wantDeath: "2004-02-29",
      wantDays: 1462,
      wantYears: 5,
    },
  ])("$name", ({ birth, years, wantDeath, wantDays, wantYears }) => {
    const span = lifeSpan(day(birth), years);
    // The readout's own end date and the day count are pinned independently
    // (not re-derived with the function's own formula) so this can actually
    // fail on a plausible off-by-one.
    expect(span.death).toBeSameInstantAs(wantDeath);
    expect(span.days).toBe(wantDays);
    expect(span.years).toBe(wantYears);
  });
});

/* -------------------------------- lifeStage -------------------------------- */

describe("lifeStage", () => {
  it.each([
    { name: "an empty birth date", birth: "" },
    { name: "a birth date that fails the YYYY-MM-DD shape", birth: "not-a-date" },
  ])("returns null for $name", ({ birth }) => {
    expect(lifeStage(birth, 80, 1400, 900)).toBeNull();
  });

  it.each([
    { name: "zero width", w: 0, h: 900 },
    { name: "height no taller than the readout strip", w: 1400, h: 28 },
  ])("returns null for a box too small to be a field ($name)", ({ w, h }) => {
    expect(lifeStage("1990-01-01", 80, w, h)).toBeNull();
  });

  it("draws more lines per year on a phone-shaped panel than a desktop one", () => {
    // A wide window can smear a year's dots sideways into dashes if it is
    // forced onto one line — this is the split existing to prevent that.
    const phone = lifeStage("1990-01-01", 40, 390, 844);
    const desktop = lifeStage("1990-01-01", 40, 1728, 1000);
    if (!phone || !desktop) throw new Error("both boxes should resolve to a stage");
    expect(phone.layout.linesPerYear).toBeGreaterThan(desktop.layout.linesPerYear);
  });

  it.each([
    { name: "phone", w: 390, h: 844 },
    { name: "desktop", w: 1728, h: 1000 },
    { name: "ultra-wide monitor", w: 3440, h: 900 },
    { name: "square-ish tablet", w: 900, h: 900 },
  ])("the chosen split for a $name box always divides into whole weeks", ({ w, h }) => {
    const stage = lifeStage("1990-01-01", 40, w, h);
    if (!stage) throw new Error("stage should resolve");
    expect(stage.layout.colsPerLine % 7).toBe(0);
  });
});

/* -------------------------------- lifeDensity ------------------------------ */

describe("lifeDensity", () => {
  const cal = calendar();
  const span = lifeSpan(day("2026-01-01"), 1); // 2026-01-01 .. 2027-01-01

  it("marks every day a dated event spans, but not the day its exclusive end lands on", () => {
    const e = event({
      calendarId: cal.id,
      color: "#ff0000",
      start: "2026-03-06 20:00",
      end: "2026-03-09 00:00", // exclusive midnight: last marked day is the 8th, not the 9th
    });
    const density = lifeDensity([e], [cal], span);
    expect([...density.keys()].sort()).toEqual(["2026-03-06", "2026-03-07", "2026-03-08"]);
    expect(density.get("2026-03-06")).toBe("#ff0000");
  });

  it("a one-day event ending exactly at the next midnight marks only that one day", () => {
    const e = event({ color: "#00ff00", start: "2026-03-08 20:00", end: "2026-03-09 00:00" });
    const density = lifeDensity([e], [cal], span);
    expect([...density.keys()]).toEqual(["2026-03-08"]);
  });

  it("an unbounded daily or weekly rule contributes nothing", () => {
    // Deliberate: left unbounded, either would paint every remaining day of
    // the life one colour and say nothing.
    const daily = event({ repeat: "daily", start: "2026-02-01 09:00" });
    const weekly = event({ repeat: "weekly", start: "2026-02-02 09:00" });
    const density = lifeDensity([daily, weekly], [cal], span);
    expect(density.size).toBe(0);
  });

  it("a bounded daily or weekly rule earns its place, since the engine can say where it stops", () => {
    const daily = event({
      repeat: "daily",
      start: "2026-02-01 09:00",
      until: ms("2026-02-03 23:59"),
    });
    const density = lifeDensity([daily], [cal], span);
    expect([...density.keys()].sort()).toEqual(["2026-02-01", "2026-02-02", "2026-02-03"]);
  });

  it("a yearly rule marks its anniversary in every year of the span, from its own seed onward", () => {
    const longSpan = lifeSpan(day("1998-01-01"), 5); // 1998-01-01 .. 2003-01-01
    const yearly = event({
      color: "#123456",
      repeat: "yearly",
      start: "2000-07-04 10:00",
      end: "2000-07-04 11:00",
    });
    const density = lifeDensity([yearly], [cal], longSpan);
    expect(density.get("2000-07-04")).toBe("#123456");
    expect(density.get("2001-07-04")).toBe("#123456");
    expect(density.get("2002-07-04")).toBe("#123456");
    expect(density.has("1998-07-04")).toBe(false); // before the rule's own seed
    expect(density.has("1999-07-04")).toBe(false);
    expect(density.has("2003-07-04")).toBe(false); // span ends 2003-01-01, before this anniversary
  });

  it("gives precedence to the earliest-starting event's colour, not input order", () => {
    const late = event({ color: "#0000ff", start: "2026-05-01 18:00", end: "2026-05-01 19:00" });
    const early = event({ color: "#ff00ff", start: "2026-05-01 08:00", end: "2026-05-01 09:00" });
    const density = lifeDensity([late, early], [cal], span); // `late` is listed first
    expect(density.get("2026-05-01")).toBe("#ff00ff");
  });

  it("excludes events on a hidden calendar", () => {
    const hidden = calendar({ id: "cal-hidden", visible: false });
    const e = event({
      calendarId: "cal-hidden",
      color: "#abcdef",
      start: "2026-04-01 08:00",
      end: "2026-04-01 09:00",
    });
    const density = lifeDensity([e], [hidden], span);
    expect(density.size).toBe(0);
  });

  it("clips a rule's own bounds to the span, even when they run well past it", () => {
    const shortSpan = lifeSpan(day("2026-06-01"), 1); // 2026-06-01 .. 2027-06-01
    const monthly = event({
      repeat: "monthly",
      start: "2025-01-15 09:00", // seeded a year before the span
      until: ms("2030-01-15 09:00"), // bounded years past the span's own end
    });
    const density = lifeDensity([monthly], [cal], shortSpan);
    expect(density.has("2026-06-15")).toBe(true); // first occurrence inside the span
    expect(density.has("2025-06-15")).toBe(false); // before the span's birth
    expect(density.has("2027-06-15")).toBe(false); // after the span's death (2027-06-01)
  });
});

/* ------------------------------- lifeYearRange ------------------------------ */

describe("lifeYearRange", () => {
  const span = lifeSpan(day("1985-06-15"), 5); // death: 1990-06-15

  it("clips the birth year's range to the birthday, with 1 January's real weekday offset", () => {
    const yr = lifeYearRange(span, 0);
    expect(yr.year).toBe(1985);
    expect(yr.offset).toBe(1); // 1 Jan 1985 was a Tuesday
    expect(yr.from).toBe(165); // 15 June is day 165 (0-based) of a non-leap year
    expect(yr.to).toBe(364); // 31 December, non-leap
  });

  it("gives an ordinary in-between year its full range", () => {
    const yr = lifeYearRange(span, 3); // 1988, a leap year
    expect(yr.year).toBe(1988);
    expect(yr.offset).toBe(4);
    expect(yr.from).toBe(0);
    expect(yr.to).toBe(365); // 31 December, leap year
  });

  it("clips the death year's range to the death day", () => {
    const yr = lifeYearRange(span, 5);
    expect(yr.year).toBe(1990);
    expect(yr.offset).toBe(0); // 1 Jan 1990 was a Monday
    expect(yr.from).toBe(0);
    expect(yr.to).toBe(165);
  });

  it("agrees with lifeDot on where a year's 1 January lands", () => {
    const stage = lifeStage("1985-06-15", 5, 1400, 900);
    if (!stage) throw new Error("stage must resolve");
    const yr = lifeYearRange(stage.span, 3); // 1988
    const jan1Dot = lifeDot(stage.layout, stage.span, new Date(1988, 0, 1));
    expect(jan1Dot).not.toBeNull();
    expect(jan1Dot!.x).toBeCloseTo(lifeDotX(stage.layout, yr.offset));
  });

  it("lifeRowTop sits exactly half a line above the dot centre lifeDotY draws", () => {
    const stage = lifeStage("1985-06-15", 5, 1400, 900);
    if (!stage) throw new Error("stage must resolve");
    const { layout } = stage;
    expect(lifeDotY(layout, 2) - lifeRowTop(layout, 2)).toBeCloseTo(layout.pitchY / 2);
    expect(lifeRowTop(layout, 3) - lifeRowTop(layout, 2)).toBeCloseTo(layout.pitchY);
  });
});

/* --------------------------------- lifeStats -------------------------------- */

describe("lifeStats / formatAge", () => {
  const span = lifeSpan(day("2000-01-01"), 1); // death: 2001-01-01, total 367 days

  it("at the birth instant: nothing lived, nothing elapsed", () => {
    const stats = lifeStats(span, day("2000-01-01"));
    expect(stats.daysLived).toBe(0);
    expect(stats.daysLeft).toBe(367);
    expect(stats.fraction).toBe(0);
    expect(stats.age).toEqual({ years: 0, months: 0, days: 0 });
    expect(formatAge(stats.age)).toBe("0y 0m 0d");
  });

  it("at the start of the very last day: one day left, fraction just short of 1", () => {
    const stats = lifeStats(span, day("2001-01-01"));
    expect(stats.daysLived).toBe(366);
    expect(stats.daysLeft).toBe(1);
    expect(stats.fraction).toBeCloseTo(366 / 367, 5);
    expect(stats.fraction).toBeLessThan(1);
    expect(formatAge(stats.age)).toBe("1y 0m 0d");
  });

  it("once the last day has fully elapsed: daysLeft and fraction saturate", () => {
    const stats = lifeStats(span, day("2001-01-02"));
    expect(stats.daysLived).toBe(367);
    expect(stats.daysLeft).toBe(0);
    expect(stats.fraction).toBe(1);
    expect(formatAge(stats.age)).toBe("1y 0m 1d");
  });
});

describe("formatCount", () => {
  it.each([
    { name: "zero", n: 0, want: "0" },
    { name: "just under a thousand", n: 999, want: "999" },
    { name: "crossing the thousands separator", n: 1827, want: "1,827" },
  ])("$name -> $want", ({ n, want }) => {
    expect(formatCount(n)).toBe(want);
  });
});

describe("formatLifeDate", () => {
  it("prints day, three-letter month, full year", () => {
    expect(formatLifeDate(day("1990-03-12"))).toBe("12 Mar 1990");
  });

  it("does not zero-pad a single-digit day", () => {
    expect(formatLifeDate(day("1990-03-05"))).toBe("5 Mar 1990");
  });
});

/* ----------------------------------- dim ------------------------------------ */

describe("dim", () => {
  it("level 1 leaves the colour unchanged, as an opaque rgb() triple", () => {
    // The dots never use alpha (per the source's own note): this is
    // `rgb(r g b)`, never `rgba(...)` and never the original hex string.
    expect(dim("#a3d9e4", 1)).toBe("rgb(163 217 228)");
  });

  it("level 0 is the canvas colour, black", () => {
    expect(dim("#a3d9e4", 0)).toBe("rgb(0 0 0)");
  });

  it("is monotonic between the two endpoints", () => {
    const levels = [0, 0.25, 0.5, 0.75, 1];
    const reds = levels.map((l) => Number(/rgb\((\d+) /.exec(dim("#ff0000", l))![1]));
    for (let i = 1; i < reds.length; i++) {
      expect(reds[i]).toBeGreaterThanOrEqual(reds[i - 1]);
    }
  });

  it.each([
    { name: "a short 3-digit hex", hex: "#fff" },
    { name: "not a hex colour at all", hex: "not-a-colour" },
  ])("falls back to white for $name, at any level", ({ hex }) => {
    expect(dim(hex, 1)).toBe("rgb(255 255 255)");
    expect(dim(hex, 0.5)).toBe("rgb(128 128 128)");
  });
});

/* ------------------------------ lifeMilestones ------------------------------ */

describe("lifeMilestones", () => {
  const eighty = lifeSpan(day("1990-03-12"), 80);

  it("names the round days a normal span reaches, in day order", () => {
    expect(lifeMilestones(eighty).map((m) => m.title)).toEqual([
      "Day 10,000",
      "Halfway",
      "Day 20,000",
    ]);
  });

  it("puts a mark on the dot its day number names, counting the birthday as day 1", () => {
    const ten = lifeMilestones(eighty).find((m) => m.key === "d10000")!;
    expect(ten.day).toBe(10_000);
    // Day 1 is the birthday itself, so day 10,000 is 9,999 days after it.
    expect(ten.date.getTime()).toBe(addDays(eighty.birth, 9_999).getTime());
  });

  it("drops the round days that fall past the last dot", () => {
    // Twenty years is about 7,305 days: no round day is reachable, so the
    // midpoint is the only mark left.
    expect(lifeMilestones(lifeSpan(day("1990-03-12"), 20)).map((m) => m.key)).toEqual(["half"]);
  });

  it("puts the midpoint where the half you can still spend starts shrinking", () => {
    for (const years of [20, 40, 79, 80, 100]) {
      const span = lifeSpan(day("1990-03-12"), years);
      const half = lifeMilestones(span).find((m) => m.key === "half")!;
      const behind = half.day - 1;
      const ahead = span.days - half.day;
      // Either side of the mark within one dot, and never with more ahead
      // than behind after it: that is the claim the card's prose makes.
      expect(Math.abs(ahead - behind)).toBeLessThanOrEqual(1);
      expect(ahead).toBeLessThanOrEqual(behind);
    }
  });

  it("reaches thirty thousand only on a span long enough to hold it", () => {
    // 30,000 days is a shade over 82 years, so an 82-year life misses it and
    // an 83-year one does not.
    expect(lifeMilestones(lifeSpan(day("1990-03-12"), 82)).some((m) => m.key === "d30000")).toBe(
      false,
    );
    expect(lifeMilestones(lifeSpan(day("1990-03-12"), 83)).some((m) => m.key === "d30000")).toBe(
      true,
    );
  });

  it("never puts two marks on one dot", () => {
    // A span whose midpoint lands exactly on a round day: 19,999 days either
    // side of day 10,000 needs a life of 19,999 days, and the collision must
    // cost the midpoint rather than produce an unclickable double mark.
    for (let years = 1; years <= 150; years++) {
      const marks = lifeMilestones(lifeSpan(day("1990-03-12"), years));
      const days = marks.map((m) => m.day);
      expect(new Set(days).size).toBe(days.length);
    }
  });

  it("gives every mark prose and a stable key", () => {
    for (const mark of lifeMilestones(lifeSpan(day("1990-03-12"), 150))) {
      expect(mark.key).toMatch(/^(d\d+|half)$/);
      expect(mark.note.length).toBeGreaterThan(0);
      for (const paragraph of mark.note) {
        expect(paragraph.trim()).not.toBe("");
        // The house rule for this app's user-facing prose.
        expect(paragraph).not.toContain("—");
      }
    }
  });
});

/* ------------------------------- lifeFraction ------------------------------- */

describe("lifeFraction", () => {
  const span = lifeSpan(day("1990-03-12"), 80);

  it("is 0 at the first instant of the birthday and 1 at the end of the last day", () => {
    expect(lifeFraction(span, span.birth)).toBe(0);
    expect(lifeFraction(span, addDays(span.death, 1))).toBe(1);
  });

  it("clamps outside the span rather than going negative or past one", () => {
    expect(lifeFraction(span, addDays(span.birth, -500))).toBe(0);
    expect(lifeFraction(span, addDays(span.death, 500))).toBe(1);
  });

  it("is what lifeStats reports, so the strip and the stats cannot disagree", () => {
    const at = new Date(2026, 7, 8, 13, 47, 12);
    expect(lifeFraction(span, at)).toBe(lifeStats(span, at).fraction);
  });

  /**
   * The strip prints seven decimals, and seven is derived rather than chosen:
   * one step of the last digit is `span / 10^9`, which has to stay inside a
   * few seconds for the widest life the app will draw. These pin the bound,
   * not the arithmetic — `PERCENT_DECIMALS` in `LifeView.tsx` carries the
   * table.
   */
  const printedAt = (s: LifeSpan, d: Date, decimals: number) =>
    (lifeFraction(s, d) * 100).toFixed(decimals);
  /** Halfway along, so the sample is inside every span regardless of length. */
  const midway = (s: LifeSpan) => new Date((s.birth.getTime() + s.death.getTime()) / 2);

  it.each([20, 40, 60, 80, 100, 120, LIFE_EXPECTANCY_RANGE.max])(
    "moves the last printed digit inside five seconds on a %iy span",
    (years) => {
      const s = lifeSpan(day("1990-03-12"), years);
      const at = midway(s);
      expect(printedAt(s, at, 7)).not.toBe(printedAt(s, new Date(at.getTime() + 5_000), 7));
    },
  );

  it("moves inside three seconds on the default span", () => {
    const at = midway(span);
    expect(printedAt(span, at, 7)).not.toBe(printedAt(span, new Date(at.getTime() + 3_000), 7));
  });

  it("would sit still for five seconds at six decimals, which is why it is not six", () => {
    const at = midway(span);
    expect(printedAt(span, at, 6)).toBe(printedAt(span, new Date(at.getTime() + 5_000), 6));
  });

  it("does not outrun the one-second clock that renders it", () => {
    // At eight decimals the digit steps several times per tick and three in
    // four values would never be drawn. Seven stays slower than the clock.
    const at = midway(span);
    expect(printedAt(span, at, 7)).toBe(printedAt(span, new Date(at.getTime() + 1_000), 7));
  });
});
