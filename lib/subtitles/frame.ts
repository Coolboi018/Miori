// The FRAME — everything a subtitle track wants on screen at one playhead,
// arranged into at most two blocks.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THE PLAYER CANNOT DRAW "THE CUE" ANY MORE (22 Nov)
// ═══════════════════════════════════════════════════════════════════════════
// A track is not a queue of one line at a time. At any given second it can carry
//   • a sign / on-screen-text translation running beside a spoken line,
//   • two characters talking over each other,
//   • a song lyric under dialogue,
//   • a screen plastered with signs while someone speaks.
//
// The old lookup returned the FIRST of those and the overlay drew it. So the
// dialogue cue was not missing or mistimed — it was parsed, active, and thrown
// away because a sign cue happened to come first (or because the voice cue came
// first and the sign was thrown away). Which one survived depended on authoring
// order, which is why it looked random from the couch.
//
// THE ANSWER IS TWO BLOCKS, NOT A PILE OF ROWS.
//
//   sign block      ← on-screen text / translations, ALWAYS ABOVE
//   dialogue block  ← voices, ALWAYS at the viewer's configured position
//
// Dialogue keeps the place the viewer chose in Settings and never moves because
// a sign appeared: the voice line is the thing being followed, and a subtitle
// that jumps up when a shop sign is translated is a subtitle nobody can read.
// Signs sit directly above it, with `SUBTITLE_STACK_GAP` between them, so both
// are legible and neither covers the picture's lower third twice.
//
// WHY NOT HONOUR THE SAME KIND OF PLACEMENT FOR SIGNS AS THE SETTING? Because
// the position slider answers "where do I want the words I am listening to".
// Signs are a different question, and their answer is "up, out of the way" —
// the convention in every player that bothers to distinguish them.
//
// NO REACT NATIVE IMPORTS: `scripts/check-subtitles.ts` runs this under `tsx`,
// and the whole classification is invisible in a screenshot, so it has to be
// asserted rather than looked at.

import { cuesAtSync, type Cue } from './vtt';

export type SubtitleKind = 'sign' | 'dialogue';

export interface SubtitleBlock {
  kind: SubtitleKind;
  /** One or more lines, already joined with `\n`. */
  text: string;
}

export interface SubtitleFrame {
  /** Top to bottom: the sign block (if any), then the dialogue block. */
  blocks: SubtitleBlock[];
}

/**
 * How many overlapping cues one block will show.
 *
 * Small on purpose. These are *simultaneous* cues, so the realistic maximum is
 * a sign plus two voices; anything past that is a broken track (or a karaoke
 * file split per syllable) and a screen full of text is precisely the mess this
 * module exists to avoid.
 */
export const SUBTITLE_MAX_SIGN_CUES = 2;
export const SUBTITLE_MAX_DIALOGUE_CUES = 3;

/**
 * Lines per block, across all its cues.
 *
 * A hard ceiling rather than a scroll: the block is anchored to the picture, so
 * its only growth direction is over the video. At the 20pt default this is four
 * lines ≈ 108pt — a third of a landscape phone — which is the most that can be
 * added to the dialogue without swallowing the frame.
 */
export const SUBTITLE_MAX_BLOCK_LINES = 4;

/**
 * Is this cue a translation of something ON SCREEN rather than a voice line?
 *
 * Three signals, strongest first:
 *
 *   1. THE TRACK SAID SO. `line:` at the top of the frame, or a `<v Sign>`-style
 *      voice tag. Parsed by `vtt.ts` into `cue.placement` / detected here from
 *      the tag's leftovers. Never second-guessed.
 *
 *   2. ALL CAPS, SHORT, AND NOT A SENTENCE. This is the convention softsub
 *      tracks use for signs when they carry no metadata: `OPEN 24 HOURS`,
 *      `NO ENTRY`, `3 DAYS EARLIER`. The punctuation rule is what keeps
 *      shouting dialogue — `I SAID NO!` — where it belongs.
 *
 *   3. Everything else is dialogue. Guessing "sign" wrong is much worse than
 *      guessing "dialogue" wrong: a sign block sits above the picture where a
 *      mis-filed voice line is still readable, while a sign filed as dialogue
 *      occupies the listening position and pushes the real line up.
 *
 * Deliberately NOT treated as signs: bracketed lines like `[door slams]` and
 * `(sighs)`. Those are part of the dialogue track's texture and belong with the
 * voices they describe, not floating at the top of the frame.
 */
export function isSignCue(cue: Cue): boolean {
  if (cue.placement === 'top') return true;
  if (cue.placement === 'bottom') return false;

  const raw = (cue.text ?? '').trim();
  if (!raw) return false;

  // Bracketed sound descriptions stay with the dialogue.
  if (/^[\[(（【][\s\S]*[\])）】]$/.test(raw)) return false;

  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  // A frame-filling paragraph is a paragraph: it belongs where the viewer is
  // already reading, not stacked above the voice line.
  if (!lines.length || lines.length > 3 || raw.length > 90) return false;

  // Needs actual words: `…`, `♪`, `!!` carry no case and prove nothing.
  const letters = raw.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return false;

  // Any lowercase letter at all means it was authored as speech/prose.
  if (/[a-z]/.test(raw)) return false;

  // A sentence ending is speech even in caps: `I SAID NO!`, `GET OUT.`
  if (/[.!?…]["'”’)\]]*$/.test(raw)) return false;

  return true;
}

/**
 * Join the cues of one block into text, deduping what authors repeat.
 *
 * The line cap is applied HERE, after joining, because a cue can itself be
 * multi-line: three cues of two lines each would otherwise be six lines, and
 * checking cues rather than lines would let that through.
 */
function blockText(cues: Cue[], maxCues: number): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const c of cues) {
    const text = (c.text ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
    if (parts.length >= maxCues) break;
  }
  const lines = parts.join('\n').split('\n').filter(Boolean);
  if (lines.length <= SUBTITLE_MAX_BLOCK_LINES) return lines.join('\n');
  const kept = lines.slice(0, SUBTITLE_MAX_BLOCK_LINES);
  kept[kept.length - 1] = `${kept[kept.length - 1]}…`;
  return kept.join('\n');
}

/**
 * The frame to draw at playhead `t`, with the viewer's sync correction applied.
 *
 * Returns null when nothing is on screen — the same "no line" answer the single
 * cue lookup gave, so the overlay's empty state is unchanged.
 *
 * DIALOGUE IS THE PRIORITY, BY CONSTRUCTION. Signs are pushed first because
 * they are DRAWN first (top to bottom), but the caps mean a flood of signs can
 * only ever add two short lines above the voices; the voice block is always
 * assembled from the first three dialogue cues and always present if any
 * dialogue is. There is no branch in which a sign displaces a voice.
 */
export function buildSubtitleFrame(
  cues: Cue[],
  t: number,
  delayMs: number
): SubtitleFrame | null {
  const active = cuesAtSync(cues, t, delayMs);
  if (!active.length) return null;

  const signs: Cue[] = [];
  const dialogue: Cue[] = [];
  for (const c of active) (isSignCue(c) ? signs : dialogue).push(c);

  const blocks: SubtitleBlock[] = [];
  if (signs.length) {
    const text = blockText(signs, SUBTITLE_MAX_SIGN_CUES);
    if (text) blocks.push({ kind: 'sign', text });
  }
  if (dialogue.length) {
    const text = blockText(dialogue, SUBTITLE_MAX_DIALOGUE_CUES);
    if (text) blocks.push({ kind: 'dialogue', text });
  }
  return blocks.length ? { blocks } : null;
}

/**
 * A stable identity for a frame's CONTENT.
 *
 * The player rebuilds the frame on every 120ms tick, and `useSyncExternalStore`
 * needs the same object back when the words did not change or every tick would
 * re-render the overlay (and re-measure the plate) for nothing. Comparing this
 * signature in the store is the whole throttle — see `lib/player/cueStore.ts`.
 */
export function frameSignature(frame: SubtitleFrame | null): string {
  if (!frame || !frame.blocks.length) return '';
  return frame.blocks.map((b) => `${b.kind}\u001f${b.text}`).join('\u001e');
}
