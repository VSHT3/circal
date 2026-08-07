/* ------------------------------------------------------------------ *
 * The app's timing, in one place.
 *
 * Two beats and one curve. Every duration in the interface is one of
 * these, because a change that arrives in two speeds reads as two
 * changes — the centre used to grow into ambient in 140 ms while the
 * chrome took 240, and what you saw was a snap followed by a crawl.
 *
 * The curve is `var(--ease)` in CSS; the numbers are repeated here
 * because a CSS variable cannot be handed to `motion`.
 * ------------------------------------------------------------------ */

/**
 * The one curve. Matches `--ease` in `global.css`, and must keep matching.
 *
 * A mutable 4-tuple rather than `as const`: `motion` types a cubic bézier as
 * exactly four numbers, and a readonly tuple of literals is neither.
 */
export const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

/**
 * A pointer being answered: an arc thickening under the cursor, the readout
 * shrinking into that arc's span, a lane repacking around a dragged event.
 *
 * Fast enough to feel like a response and slow enough not to bang — at 140 ms
 * the readout dropping from 54 units to 32 read as a jolt rather than as a
 * change of mind, and it happens on every arc the pointer crosses.
 */
export const MOOD_MS = 260;

/**
 * A mode being changed: ambient arriving or leaving, and everything that goes
 * with it — the chrome withdrawing, the face growing into the window, the
 * numerals thinning to four, the rim crossfading between the band and the
 * elapsed trail.
 *
 * Deliberately long. It is the one transition nobody is waiting on the far
 * side of, it moves the whole window, and a room-scale object that snaps into
 * place is a webpage doing an animation.
 */
export const MODE_MS = 600;

/**
 * The year ring unrolling into its row of the life grid, and rolling back up.
 *
 * Long, like the day zoom, and for the same reason: it is a change of *shape*
 * rather than of state, and at half a second a circle becoming a line reads
 * as a glitch instead of as a move. Rolling up is shorter — arriving
 * somewhere is allowed to be brisker than leaving it.
 *
 * Both are here rather than in `YearView` because the shell has to hold the
 * leaving panel open for exactly as long as the canvas inside it is drawing.
 */
export const UNROLL_OUT_MS = 950;
export const UNROLL_IN_MS = 750;
