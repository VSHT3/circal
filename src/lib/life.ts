/* ------------------------------------------------------------------ *
 * The life grid: its span, its geometry, its arithmetic.
 *
 * One dot is one day, and the whole life is one viewport — which fixes the
 * layout more or less completely. A row is a calendar year; a column is a day
 * of that year, pushed right by the weekday January 1st fell on, so that any
 * seven adjacent columns are a real Monday-to-Sunday week. Weeks are groups,
 * months are a tonal band (they drift across the row, because a month is not
 * a whole number of weeks and pretending otherwise would misalign the weeks
 * that *are* whole), years are rows, decades are the labelled rules.
 *
 * Rows are calendar years rather than years of age so that every row starts
 * on January 1st: with birthday-aligned rows the first and last row would be
 * the only complete ones and no column would mean anything twice.
 *
 * Nothing here touches the DOM or a canvas — `LifeView` draws what this
 * returns, and `lifeCellAt` is the exact inverse of `lifeDotX`/`lifeDotY` so
 * that a pointer lands on the dot it is over.
 * ------------------------------------------------------------------ */

import { colorOf, occurrencesOn, type CalEvent, type Calendar } from "./events";
import { startsBetween } from "./recur";
import { MONTHS, addDays, dayKey, daysInMonth, fromDayKey, mondayOffset, startOfDay } from "./time";

const DAY_MS = 86_400_000;
const WEEK = 7;

/** Slots in one year: 366 days, plus the six leading blanks a Sunday 1 January
 *  costs when the week groups are to be real Monday-to-Sunday weeks. */
const YEAR_SLOTS = 6 + 366;
/** Week groups in a year — `YEAR_SLOTS / 7`, rounded up. */
const YEAR_WEEKS = Math.ceil(YEAR_SLOTS / WEEK);

/**
 * How many weeks a line of the grid holds, best first.
 *
 * A year on one line is 372 columns wide, which in a landscape window makes a
 * cell twice as wide as it is tall: the dots merge sideways into dashes and
 * the rows stand apart, and the thing stops reading as days at all. Splitting
 * the year across two or three lines trades width for height until a cell is
 * roughly square, which is the only shape a circle fits in.
 *
 * The split is chosen per box by `lifeLayout` rather than fixed, so a phone
 * gets four lines a year and a wide monitor gets one, and neither gets dots it
 * cannot see. Always a whole number of weeks, so a week is never cut in half.
 */
const SPLITS = [YEAR_WEEKS, 27, 18, 14, 11, 9] as const;

/**
 * The gap between week groups, and the tallest a line may be, both as
 * multiples of the horizontal dot pitch. The pitch ceiling is what stops a
 * short life (a small expectancy, few lines) from being drawn as a handful of
 * widely spaced stripes.
 */
const WEEK_GAP = 0.5;
const LINE_PITCH = 1.6;

/**
 * Room for the age rules on the left and the year they fall in on the right.
 * Fixed, because both are one `.label` string wide and neither grows.
 */
export const LIFE_GUTTER = { left: 26, right: 38 } as const;

/**
 * Height of the readout strip above the field, and the one number the shell
 * and the view have to agree on: `App.tsx` subtracts it to work out where a
 * day's dot lands on screen, because that point is the origin of the zoom
 * between the dial and this grid. The strip is given exactly this height in
 * CSS rather than left to its content — a strip that grows by two pixels would
 * put the dial's landing point two pixels off every dot in the field.
 */
export const LIFE_META_H = 28;

export interface LifePoint {
  x: number;
  y: number;
}

export interface LifeSpan {
  /** Local midnight of the birthday. */
  birth: Date;
  /** Local midnight of the day the expectancy runs out — an estimate, and
   *  drawn as one: the grid simply stops there. */
  death: Date;
  /** Days in `[birth, death]`, both ends included. */
  days: number;
  /** Calendar years the span touches. Each one is `linesPerYear` lines tall. */
  years: number;
}

export function lifeSpan(birth: Date, expectancyYears: number): LifeSpan {
  const from = startOfDay(birth);
  const to = startOfDay(
    new Date(from.getFullYear() + expectancyYears, from.getMonth(), from.getDate()),
  );
  return {
    birth: from,
    death: to,
    // Rounded, not floored: a DST change inside the span leaves the difference
    // an hour short of a whole number of days.
    days: Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1,
    years: to.getFullYear() - from.getFullYear() + 1,
  };
}

/* -------------------------------- geometry -------------------------------- */

export interface LifeLayout {
  birthYear: number;
  years: number;
  /** Lines one year is drawn on, and the columns each of those lines holds. */
  linesPerYear: number;
  colsPerLine: number;
  /** Lines in the whole field — `years * linesPerYear`. */
  rows: number;
  /** Distance between two days across, and between two lines down. */
  pitchX: number;
  pitchY: number;
  /** Black between week groups. */
  weekGap: number;
  /** Dot radius. Floored, so a cramped window stipples rather than vanishes. */
  radius: number;
  /** The dot field's own size, and where it sits in the measured box. */
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

/** What a given split costs and buys, before anything is committed to it. */
function fit(boxWidth: number, boxHeight: number, years: number, weeksPerLine: number) {
  const colsPerLine = weeksPerLine * WEEK;
  const groups = weeksPerLine;
  const linesPerYear = Math.ceil(YEAR_WEEKS / weeksPerLine);
  const rows = years * linesPerYear;

  const inner = Math.max(1, boxWidth - LIFE_GUTTER.left - LIFE_GUTTER.right);
  const pitchX = inner / (colsPerLine + (groups - 1) * WEEK_GAP);
  const pitchY = Math.min(boxHeight / rows, pitchX * LINE_PITCH);
  return {
    colsPerLine,
    linesPerYear,
    rows,
    inner,
    pitchX,
    pitchY,
    weekGap: pitchX * WEEK_GAP,
    width: colsPerLine * pitchX + (groups - 1) * pitchX * WEEK_GAP,
    height: rows * pitchY,
    // What the choice is actually made on: a dot can be no wider than the
    // narrower of the two pitches, whichever direction is the tight one.
    room: Math.min(pitchX, pitchY),
  };
}

/**
 * Fit `span` into a box, picking the split that leaves the biggest dot.
 *
 * Ties go to the earlier candidate — fewer lines per year is easier to read,
 * so the split only gets finer when it actually buys legibility.
 */
function lifeLayout(boxWidth: number, boxHeight: number, span: LifeSpan): LifeLayout {
  let best = fit(boxWidth, boxHeight, span.years, SPLITS[0]);
  for (const weeks of SPLITS.slice(1)) {
    const candidate = fit(boxWidth, boxHeight, span.years, weeks);
    if (candidate.room > best.room) best = candidate;
  }

  return {
    birthYear: span.birth.getFullYear(),
    years: span.years,
    linesPerYear: best.linesPerYear,
    colsPerLine: best.colsPerLine,
    rows: best.rows,
    pitchX: best.pitchX,
    pitchY: best.pitchY,
    weekGap: best.weekGap,
    radius: Math.max(0.8, best.room * 0.4),
    width: best.width,
    height: best.height,
    offsetX: LIFE_GUTTER.left + (best.inner - best.width) / 2,
    offsetY: (boxHeight - best.height) / 2,
  };
}

export interface LifeStage {
  span: LifeSpan;
  layout: LifeLayout;
  /** The field's own box: the panel, less the readout strip above it. */
  box: { width: number; height: number };
}

/**
 * The life a panel of this size would draw, or `null` when there is nothing to
 * draw — no birth date yet, or a box too small to be a field.
 *
 * Resolved by the *shell* rather than by the view, because the zoom between the
 * dial and this grid needs a day's dot in screen coordinates while the grid may
 * not be mounted yet. One layout, computed once, read by both.
 */
export function lifeStage(
  birth: string,
  expectancyYears: number,
  panelWidth: number,
  panelHeight: number,
): LifeStage | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return null;
  const start = fromDayKey(birth);
  if (Number.isNaN(start.getTime())) return null;

  const box = { width: panelWidth, height: panelHeight - LIFE_META_H };
  if (box.width < 1 || box.height < 1) return null;

  const span = lifeSpan(start, expectancyYears);
  return { span, layout: lifeLayout(box.width, box.height, span), box };
}

/** 0 for 1 January. Rounded for the same DST reason as `lifeSpan`. */
function dayOfYear(date: Date): number {
  return Math.round(
    (startOfDay(date).getTime() - new Date(date.getFullYear(), 0, 1).getTime()) / DAY_MS,
  );
}

/**
 * A day's place in the grid. The slot is its position in the year's 372, and
 * the split turns that into a line and a column.
 */
function lifeCell(layout: LifeLayout, date: Date): { row: number; col: number } {
  const slot = mondayOffset(new Date(date.getFullYear(), 0, 1)) + dayOfYear(date);
  const line = Math.floor(slot / layout.colsPerLine);
  return {
    row: (date.getFullYear() - layout.birthYear) * layout.linesPerYear + line,
    col: slot - line * layout.colsPerLine,
  };
}

/**
 * A day's dot, in the field's own coordinates — `null` for a day outside the
 * life. Every caller that needs a *point* rather than a cell goes through
 * this: the hover ring, the selection ring, today's halo, and the zoom, which
 * has to land the dial on exactly the dot the field draws.
 */
export function lifeDot(layout: LifeLayout, span: LifeSpan, date: Date): LifePoint | null {
  if (date < span.birth || date > span.death) return null;
  const { row, col } = lifeCell(layout, date);
  return { x: lifeDotX(layout, col), y: lifeDotY(layout, row) };
}

/**
 * One year's worth of calendar facts for the drawing loop: how far right its
 * 1 January sits, and the first and last day-of-year inside the span. The
 * clipping to birth and death lives here — a component has no business
 * deciding which days a year has.
 */
export interface LifeYearRange {
  year: number;
  /** Leading blank slots: the Monday-first weekday of 1 January. */
  offset: number;
  /** Inclusive, 0-based day-of-year bounds. */
  from: number;
  to: number;
}

export function lifeYearRange(span: LifeSpan, index: number): LifeYearRange {
  const year = span.birth.getFullYear() + index;
  return {
    year,
    offset: mondayOffset(new Date(year, 0, 1)),
    from: year === span.birth.getFullYear() ? dayOfYear(span.birth) : 0,
    to:
      year === span.death.getFullYear() ? dayOfYear(span.death) : dayOfYear(new Date(year, 11, 31)),
  };
}

export function lifeDotX(layout: LifeLayout, col: number): number {
  const group = Math.floor(col / WEEK);
  return layout.offsetX + col * layout.pitchX + group * layout.weekGap + layout.pitchX / 2;
}

export function lifeDotY(layout: LifeLayout, row: number): number {
  return layout.offsetY + row * layout.pitchY + layout.pitchY / 2;
}

/** Top edge of a line, for the decade rules. */
export function lifeRowTop(layout: LifeLayout, row: number): number {
  return layout.offsetY + row * layout.pitchY;
}

/**
 * The day under a point in the measured box, or `null` for a point outside the
 * span — before the birthday, after the estimate, or in a year's leading
 * blanks. Snaps to the nearest dot rather than requiring a hit inside it: at
 * four pixels a dot is smaller than the pointer's own uncertainty.
 */
export function lifeCellAt(layout: LifeLayout, span: LifeSpan, x: number, y: number): Date | null {
  const row = Math.floor((y - layout.offsetY) / layout.pitchY);
  if (row < 0 || row >= layout.rows) return null;

  const groupPitch = WEEK * layout.pitchX + layout.weekGap;
  const local = x - layout.offsetX;
  if (local < 0) return null;
  const group = Math.floor(local / groupPitch);
  const withinGroup = Math.min(
    WEEK - 1,
    Math.max(0, Math.floor((local - group * groupPitch) / layout.pitchX)),
  );
  const col = group * WEEK + withinGroup;
  if (col >= layout.colsPerLine) return null;

  const year = layout.birthYear + Math.floor(row / layout.linesPerYear);
  const line = row % layout.linesPerYear;
  const offset = line * layout.colsPerLine + col - mondayOffset(new Date(year, 0, 1));
  if (offset < 0) return null;
  const date = new Date(year, 0, 1 + offset);
  if (date.getFullYear() !== year) return null;
  if (date < span.birth || date > span.death) return null;
  return date;
}

/* ---------------------------------- loupe --------------------------------- */

/**
 * The loupe: one year of the field, at a size you can read, held over the
 * field rather than replacing it. Thirty thousand dots at four pixels is the
 * whole argument and also the whole problem — the picture is legible and the
 * individual day is not.
 *
 * It is the grid's own cell arithmetic with `colsPerLine` fixed at seven, and
 * then transposed: a column *is* a week, and the week runs down it instead of
 * across a row. That is arithmetic rather than taste. At the desktop split one
 * line of the field already spans the whole width, so a year magnified in the
 * field's own orientation gains nothing horizontally and has nowhere vertical
 * to go; turned on its side the same year is fifty-four columns rather than
 * three hundred and seventy-two, and the pitch comes out four or five times
 * the field's. There is no week gap either, for the same reason: the field's
 * gap groups seven columns that are a week, and here one column already is.
 */

/**
 * Columns, on every year. A year needs 53 or 54 depending on where its
 * 1 January falls, and the loupe draws all of them at the wider — a strip that
 * changes width as the pointer crosses into the next year is a wobble in the
 * one thing on this screen meant to hold still.
 */
export const LOUPE_COLS = YEAR_WEEKS;

/** Below this multiple of the field's own dot the loupe is not a magnifier,
 *  and a second picture the size of the first is worth none of the room. */
const LOUPE_MIN_GAIN = 1.8;
/** Below this it is stippling too, whatever the gain says. */
const LOUPE_MIN_PITCH = 5;
/** Past this the dots are beads. A year is to be taken in at a glance rather
 *  than walked, and the rest of the room is better spent on the field. */
const LOUPE_MAX_PITCH = 18;

export interface LoupeLayout {
  cols: number;
  /** One cell, square. */
  pitch: number;
  radius: number;
  width: number;
  height: number;
}

/**
 * The loupe an inner box of this size would hold, or `null` when it is not
 * worth drawing. `fieldRadius` is the dot it has to beat.
 */
export function loupeLayout(
  boxWidth: number,
  boxHeight: number,
  fieldRadius: number,
): LoupeLayout | null {
  const pitch = Math.min(LOUPE_MAX_PITCH, boxWidth / LOUPE_COLS, boxHeight / WEEK);
  const radius = pitch * 0.4;
  if (pitch < LOUPE_MIN_PITCH || radius < fieldRadius * LOUPE_MIN_GAIN) return null;
  return { cols: LOUPE_COLS, pitch, radius, width: LOUPE_COLS * pitch, height: WEEK * pitch };
}

/** A day's cell in the loupe. Monday is row 0 — the same week the field's own
 *  groups are cut on, so the two pictures agree about where a week starts. */
export function loupeCell(date: Date): { col: number; row: number } {
  const slot = mondayOffset(new Date(date.getFullYear(), 0, 1)) + dayOfYear(date);
  return { col: Math.floor(slot / WEEK), row: slot % WEEK };
}

/**
 * The day under a point in the loupe's own cell box, and the exact inverse of
 * `loupeCell` through `layout.pitch`. `null` for the leading blanks of the
 * year's first week, the trailing blanks of its last, and any day the span
 * does not reach.
 */
export function loupeCellAt(
  layout: LoupeLayout,
  span: LifeSpan,
  year: number,
  x: number,
  y: number,
): Date | null {
  const col = Math.floor(x / layout.pitch);
  const row = Math.floor(y / layout.pitch);
  if (col < 0 || col >= layout.cols || row < 0 || row >= WEEK) return null;
  const offset = col * WEEK + row - mondayOffset(new Date(year, 0, 1));
  if (offset < 0) return null;
  const date = new Date(year, 0, 1 + offset);
  if (date.getFullYear() !== year) return null;
  if (date < span.birth || date > span.death) return null;
  return date;
}

/**
 * Where the month labels hang, in columns. A month is not a whole number of
 * weeks, so a label sits at the column of its first *drawn* day — which is
 * what keeps the birth year's first label on the birthday's own week instead
 * of off the left of a strip that does not begin in January.
 */
export function loupeMonths(span: LifeSpan, year: number): { month: number; col: number }[] {
  const { offset, from, to } = lifeYearRange(span, year - span.birth.getFullYear());
  const out: { month: number; col: number }[] = [];
  for (let month = 0; month < 12; month++) {
    const first = dayOfYear(new Date(year, month, 1));
    if (first + daysInMonth(year, month) - 1 < from || first > to) continue;
    out.push({ month, col: Math.floor((offset + Math.max(first, from)) / WEEK) });
  }
  return out;
}

/* --------------------------------- events --------------------------------- */

/** Frequencies fast enough to fire more often in a year than a life-sized
 *  dot can tell apart. Left unbounded they would paint every remaining day
 *  of the life one colour; bounded by `until`, the engine can say exactly
 *  where they stop, and that is honest to draw. */
const FAST_REPEATS: Record<CalEvent["repeat"], boolean> = {
  never: false,
  secondly: true,
  minutely: true,
  hourly: true,
  daily: true,
  weekly: true,
  monthly: false,
  yearly: false,
};

/** How many starts one event may still add before its rule stops being
 *  walked further — a floor under `startsBetween`'s own 512-per-call cap,
 *  for a window long enough that a life asks it for more than one call's
 *  worth. A decade of dailies already makes whatever point the rule was
 *  drawn to make. */
const MAX_MARKS_PER_EVENT = 3660;

/**
 * `event`'s starts inside `[from, to)`, walked a calendar year at a time.
 * `startsBetween` returns at most 512 instants, earliest first — asked for
 * decades in one call, a daily rule would hand back a few months near its
 * seed and nothing from every year after. A year is short enough that no
 * frequency this file still draws (monthly, yearly, or a bounded
 * daily/weekly) can fill it, so slicing by year keeps every year honest.
 */
function yearlyStarts(event: CalEvent, from: number, to: number): number[] {
  const out: number[] = [];
  let cursor = from;
  while (cursor < to && out.length < MAX_MARKS_PER_EVENT) {
    const nextYear = new Date(cursor).getFullYear() + 1;
    const sliceEnd = Math.min(new Date(nextYear, 0, 1).getTime(), to);
    out.push(...startsBetween(event, event.start, cursor, sliceEnd));
    cursor = sliceEnd;
  }
  return out;
}

/**
 * Which days carry something, and in what colour — the first event of the
 * day wins, because a dot this size has room for one.
 *
 * A dated event marks every day it spans. A repeating one is now drawn
 * through `startsBetween`, the same engine every other face reads, rather
 * than by hand — which is what fixes 29 February, and gets interval,
 * BYMONTH and BYSETPOS right for free. `FAST_REPEATS` still keeps a *bare*
 * daily or weekly rule off the grid: it fires more often than a dot this
 * size can distinguish and would paint every remaining day one colour and
 * say nothing. A *bounded* one (`until > 0`) earns its place, because the
 * engine can say exactly where it stops; monthly and yearly rules are
 * included whether bounded or not, since a life is exactly the scale a
 * birthday or a deadline is drawn at. Each included rule is clipped to
 * `[max(seed, birth), min(until, death)]` before it is walked, so a rule
 * bounded decades past the grid's own end is never asked for years the grid
 * cannot show, and `yearlyStarts` caps what even a rule inside that window
 * can add.
 */
export function lifeDensity(
  events: CalEvent[],
  calendars: Calendar[],
  span: LifeSpan,
): Map<string, string> {
  const hidden = new Set(calendars.filter((c) => !c.visible).map((c) => c.id));
  const out = new Map<string, string>();

  const mark = (date: Date, color: string) => {
    if (date < span.birth || date > span.death) return;
    const key = dayKey(date);
    if (!out.has(key)) out.set(key, color);
  };

  const ordered = events.filter((e) => !hidden.has(e.calendarId)).sort((a, b) => a.start - b.start);

  for (const event of ordered) {
    const color = colorOf(event, calendars);

    if (event.repeat === "never") {
      // `end` is exclusive, so an event finishing at midnight belongs to the
      // day before it — a one-day event would otherwise colour two dots.
      const last = startOfDay(new Date(Math.max(event.start, event.end - 1)));
      for (let d = startOfDay(new Date(event.start)); d <= last; d = addDays(d, 1)) {
        mark(d, color);
      }
      continue;
    }

    if (FAST_REPEATS[event.repeat] && event.until === 0) continue;

    const from = Math.max(event.start, span.birth.getTime());
    const untilCap =
      event.until > 0 ? Math.min(event.until, span.death.getTime()) : span.death.getTime();
    if (from > untilCap) continue;
    const to = addDays(startOfDay(new Date(untilCap)), 1).getTime();

    for (const at of yearlyStarts(event, from, to)) {
      mark(startOfDay(new Date(at)), color);
    }
  }

  return out;
}

/**
 * What a day carries: how many occurrences land on it, and the distinct
 * colours they wear, in the order `occurrencesOn` returns them.
 *
 * The one place that resolves "what is on this day, and what colour is it"
 * from a day's occurrences, so the life grid, the year ring and the year
 * ring's screen-reader labels all read the same answer — a hidden calendar,
 * an override or a colour-precedence rule then applies wherever a day is
 * drawn as a mark instead of as an agenda.
 *
 * `Tally` rather than `Load`: `CenterPanel` already has a `dayLoad`, and that
 * one answers a different question in different units — how many *minutes* of
 * a day are booked against free.
 */
export interface DayTally {
  count: number;
  colors: string[];
}

export function dayTally(events: CalEvent[], calendars: Calendar[], day: Date): DayTally {
  const colors: string[] = [];
  let count = 0;
  for (const occ of occurrencesOn(events, calendars, day)) {
    count += 1;
    const color = colorOf(occ.event, calendars);
    if (!colors.includes(color)) colors.push(color);
  }
  return { count, colors };
}

/* ---------------------------------- stats --------------------------------- */

export interface LifeStats {
  daysLived: number;
  daysLeft: number;
  total: number;
  /** Millisecond-precise, so the printed percentage actually moves. */
  fraction: number;
  age: { years: number; months: number; days: number };
}

/**
 * How far through the span `now` is, as a fraction of the whole. Its own
 * function because it is the only number in this file that moves faster than
 * once a day: at the seven decimals the strip prints, an eighty-year span
 * advances its last digit every two and a half seconds. That is finer than
 * the shell's minute and it is why the leaf that prints it keeps a clock of
 * its own — see `PERCENT_DECIMALS` in `LifeView.tsx` for why seven.
 * Everything else in `LifeStats` is day-granular.
 */
export function lifeFraction(span: LifeSpan, now: Date): number {
  const elapsed = now.getTime() - span.birth.getTime();
  const whole = span.death.getTime() + DAY_MS - span.birth.getTime();
  return Math.min(1, Math.max(0, elapsed / whole));
}

export function lifeStats(span: LifeSpan, now: Date): LifeStats {
  const lived = Math.max(
    0,
    Math.round((startOfDay(now).getTime() - span.birth.getTime()) / DAY_MS),
  );
  const total = span.days;

  let years = now.getFullYear() - span.birth.getFullYear();
  let months = now.getMonth() - span.birth.getMonth();
  let days = now.getDate() - span.birth.getDate();
  if (days < 0) {
    months -= 1;
    days += daysInMonth(now.getFullYear(), now.getMonth() - 1);
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  return {
    daysLived: Math.min(lived, total),
    daysLeft: Math.max(0, total - lived),
    total,
    fraction: lifeFraction(span, now),
    age: { years: Math.max(0, years), months: Math.max(0, months), days: Math.max(0, days) },
  };
}

/* ------------------------------- milestones ------------------------------- */

/**
 * A day the grid names. Thirty thousand identical dots give the eye nothing
 * to land on between one decade rule and the next, and a landmark is what
 * turns a field into a picture you can navigate.
 *
 * `note` is paragraphs rather than one string so the popup never has to split
 * prose on a delimiter.
 */
export interface Milestone {
  key: string;
  /** Local midnight of the day it falls on. */
  date: Date;
  /** Which day of the life it is, counting the birthday as day 1. */
  day: number;
  title: string;
  note: string[];
}

/**
 * The round days. Ten thousand is about twenty-seven, twenty thousand about
 * fifty-five, thirty thousand about eighty-two, so a default span gets two of
 * them and a generous one gets three. A thousand and five thousand are on the
 * list of numbers that sound like milestones and are not: both land before
 * anybody has a memory of the day, and both are already behind every user.
 */
const ROUND_DAYS = [10_000, 20_000, 30_000] as const;

const ROUND_NOTES: Record<number, string[]> = {
  10_000: [
    "Ten thousand days, which is twenty-seven years and change. Round numbers are an accident of having ten fingers, and this one still tells you more than a birthday does.",
    "A birthday counts the loops. This counts the days, and the day is the unit you actually spend.",
  ],
  20_000: [
    "Twenty thousand. The stretch between here and the last mark was exactly as long as everything before it, and it did not feel that way.",
    "Nobody gets warned that the second ten thousand goes quicker. Consider this the warning.",
  ],
  30_000: [
    "Thirty thousand days is eighty-two years and a month, which sits past the number most people quietly use as the far edge of a life.",
    "The grid draws it because you asked for the span. Whether the day arrives is a separate question, and this view has never claimed to know.",
  ],
};

const HALFWAY_NOTE = [
  "The midpoint of the estimate. Behind it is a life you can remember, and ahead of it is roughly the same number of dots with nothing on them yet.",
  "The years are a guess, so the dot inherits the guess. What it is good for is the direction: past this one, the half you can still spend is the smaller half.",
];

/**
 * The marks, in day order, and only the ones that land inside the span: a
 * twenty-year expectancy gets the midpoint and nothing else, and a mark drawn
 * past the last dot would sit on black.
 *
 * The midpoint is `floor(days / 2) + 1` rather than the rounder-looking
 * `ceil(days / 2)`, because the card's second paragraph makes an arithmetic
 * claim: past this dot the half you can still spend is the smaller one. On an
 * even span `ceil` leaves one more day ahead than behind and the sentence is
 * false. It is dropped when it collides with a round day — two marks on one
 * dot is one mark that cannot be clicked.
 */
export function lifeMilestones(span: LifeSpan): Milestone[] {
  const marks: Milestone[] = [];

  for (const day of ROUND_DAYS) {
    if (day > span.days) break;
    marks.push({
      key: `d${day}`,
      date: addDays(span.birth, day - 1),
      day,
      title: `Day ${formatCount(day)}`,
      note: ROUND_NOTES[day],
    });
  }

  const middle = Math.floor(span.days / 2) + 1;
  if (!marks.some((mark) => mark.day === middle)) {
    marks.push({
      key: "half",
      date: addDays(span.birth, middle - 1),
      day: middle,
      title: "Halfway",
      note: HALFWAY_NOTE,
    });
  }

  return marks.sort((a, b) => a.day - b.day);
}

/** `35y 4m 22d` — the life view's own voice for a duration this long. */
export function formatAge(age: LifeStats["age"]): string {
  return `${age.years}y ${age.months}m ${age.days}d`;
}

/**
 * `12 Mar 1990` — a date at life scale. `formatDayHeader` leads with the
 * weekday and drops the year, which is exactly the wrong half of a date once
 * the span is eighty years wide.
 */
export function formatLifeDate(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)} ${date.getFullYear()}`;
}

/** `12,927` — grouped, because five digits of days is otherwise unreadable. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/* --------------------------------- colour --------------------------------- */

/**
 * A hex colour dimmed towards the canvas, opaquely. The grid's dots never
 * overlap, so this could have been alpha — it is not, because the same
 * function has to dim an event's colour and white by the same amount and
 * `rgba(255,255,255,0.1)` and a 10%-grey are only identical on true black.
 */
export function dim(hex: string, level: number): string {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const rgb = value ? parseInt(value[1], 16) : 0xffffff;
  const r = Math.round(((rgb >> 16) & 255) * level);
  const g = Math.round(((rgb >> 8) & 255) * level);
  const b = Math.round((rgb & 255) * level);
  return `rgb(${r} ${g} ${b})`;
}
