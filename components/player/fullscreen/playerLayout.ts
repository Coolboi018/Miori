// The two measured offsets the player's floating chrome agrees on.
//
// Both used to be local to `PlayerScreen.tsx`, and both are now read by a
// component that lives outside it (`PlayerOverlays.tsx`), so they live in one
// module rather than being restated. Two literals that have to agree is exactly
// how a control ends up seated somewhere nobody intended.

/**
 * How far the chrome's generic skip button jumps, in seconds.
 *
 * The intro/outro button answers a MARKER — "this stretch is an opening, end
 * it" — and shows whenever the playhead is inside one, chrome or not. The
 * +85s button answers the NO-MARKER case: with no source-supplied window the
 * button keeps its seat but changes its job, jumping a fixed 85s. 85 is the
 * length of a typical opening-plus-recap (90s openings are the long tail; 85
 * lands inside even those), so one tap usually clears whatever unmarked
 * preamble the source baked into the file. Overlay-mode only: without a
 * marker there is nothing persistent to react to, and a permanent button on
 * the gesture surface is one more thing a pocket can find.
 */
export const SKIP_FORWARD_S = 85;

/**
 * How far a floating control sits above the bottom bar's own top edge, in px.
 *
 * The bar measures 157pt, and its inner column starts 22pt below that edge —
 * that padding is the gradient's headroom, drawn above the timeline on purpose.
 * So a control seated at `barHeight` is already 22pt clear of the timeline, and
 * the extra 12pt on top of it read as detached: the up-next card and the skip
 * pill floated visibly higher than the transport they belong to. 2pt is the
 * hairline that says "overlay, not part of the bar"; the headroom does the rest.
 *
 * One constant for both, because they share that edge — two literals would drift
 * apart on the next tweak and look like two accidents.
 */
export const ABOVE_BAR_GAP = 2;
