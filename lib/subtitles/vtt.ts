// Minimal WebVTT parser for the subtitle overlay.
// expo-video only exposes embedded subs; our sources ship sidecar .vtt,
// so we fetch + parse + render cues ourselves.
//
// Parsing and LOOKING are deliberately separate. This file answers "which words
// are on screen at time t" and nothing about how big or how high they sit; that
// lives in `lib/subtitles/style.ts` so it can be checked without React Native.
//
// ═══════════════════════════════════════════════════════════════════════════
// MORE THAN ONE CUE CAN BE SPEAKING AT ONCE (22 Nov)
// ═══════════════════════════════════════════════════════════════════════════
// A track routinely has two or three cues OPEN at the same instant: a sign or
// on-screen-text translation running beside a line of dialogue, two characters
// talking over each other, a song lyric under a spoken line. `cueAt` returns
// ONE of them, and the player used it as the whole subtitle line — so whatever
// was authored second (or first in track order) was the only thing the viewer
// ever saw. That is the entire "sign translation hides the voice" report: the
// voice cue was parsed correctly and then discarded by the lookup.
//
// `cuesAt` is the answer to "everything on screen at t", and `cueAt` is now
// literally its first element so the single-cue callers (the settings preview's
// sample, the check suite) cannot drift from the layered one.

export interface Cue {
  start: number; // seconds
  end: number; // seconds
  text: string;
  /**
   * Where the TRACK says this cue belongs, when it says anything.
   *
   * Only `'top'` changes any decision: it is the platform's own way of marking
   * a sign/label/on-screen-text translation, and `lib/subtitles/frame.ts`
   * honours it over every heuristic. `'bottom'` is recorded for completeness
   * and treated as dialogue. Undefined means "the track stayed silent", which
   * is the common case for the plain `.vtt` files our sources ship.
   */
  placement?: CuePlacement;
}

export type CuePlacement = 'top' | 'bottom';

function parseTimestamp(t: string): number | null {
  const m = t.trim().match(/^(?:(\d+):)?([0-5]?\d):([0-5]?\d)[.,](\d{1,3})$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const ms = parseInt((m[4] + '000').slice(0, 3), 10);
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + ms / 1000;
}

function cleanText(s: string): string {
  return (
    s
      .replace(/<[^>]*>/g, '') // <i>, <ruby><rt>, <v voice> etc.
      .replace(/\{[^}]*\}/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim()
  );
}

/**
 * A voice tag that names a non-speech role.
 *
 * `<v Sign>` / `<v Translator>` do appear in fan and provider tracks, and when
 * one does the cue's role is stated, not guessed — so it outranks every
 * heuristic in `frame.ts`.
 */
const SIGN_VOICE = /\b(sign|signs|translator|translation|note|notes|sfx)\b/i;

/**
 * The cue's placement, read from the settings block and any voice tag.
 *
 * WebVTT puts settings after the end timestamp (`…-->…  line:10% align:middle`)
 * and this parser used to throw that text away with the rest of the timestamp
 * split. The only setting that changes a rendering decision here is `line`,
 * because it is how a converted ASS file (`\an8`, top-anchored signs) survives
 * the conversion:
 *
 *   - a percentage at most a third of the way down → top
 *   - a bare line index 0..3 → top ("the first few lines of the frame")
 *   - a NEGATIVE line counts up from the bottom → bottom (dialogue)
 *   - anything else says nothing; guessing from a percentage in the middle
 *     would be worse than leaving it to the heuristics in `frame.ts`
 */
function placementFrom(settingsRaw: string, rawText: string): CuePlacement | undefined {
  const voice = /<v[ .]([^>]+)>/.exec(rawText)?.[1];
  if (voice && SIGN_VOICE.test(voice)) return 'top';

  const line = /(?:^|\s)line:([^\s]+)/.exec(settingsRaw)?.[1];
  if (!line) return undefined;

  const pct = /^(\d+(?:\.\d+)?)%$/.exec(line);
  if (pct) {
    const v = parseFloat(pct[1]);
    if (!Number.isFinite(v)) return undefined;
    if (v <= 33) return 'top';
    if (v >= 67) return 'bottom';
    return undefined;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(line)) {
    const v = parseFloat(line);
    if (!Number.isFinite(v)) return undefined;
    if (v >= 0 && v <= 3) return 'top';
    if (v < 0) return 'bottom';
  }
  return undefined;
}

export function parseVTT(text: string): Cue[] {
  const cues: Cue[] = [];
  const norm = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = norm.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    if (/^WEBVTT/.test(lines[0])) lines.shift();
    if (!lines.length) continue;
    if (/^(NOTE|STYLE|REGION)/.test(lines[0])) continue;
    // Optional cue identifier line sits above the timestamp line.
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseTimestamp(a);
    const after = (b ?? '').trim();
    const end = parseTimestamp(after.split(/\s+/)[0] ?? '');
    if (start == null || end == null || end <= start) continue;
    const rawLines = lines.slice(i + 1);
    const textOut = rawLines
      .map(cleanText)
      .filter(Boolean)
      .join('\n');
    if (!textOut) continue;
    // Settings live after the end timestamp, in the same token run.
    const settingsRaw = after.split(/\s+/).slice(1).join(' ');
    const placement = placementFrom(settingsRaw, rawLines.join('\n'));
    cues.push(placement ? { start, end, text: textOut, placement } : { start, end, text: textOut });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/**
 * EVERY cue open at time t, in track order.
 *
 * ⚠️ HALF-OPEN — `t >= start && t < end` — AND THE `end` SIDE IS THE FIX.
 *
 * The closed interval `t >= c.start && t <= c.end` has a real boundary case:
 * consecutive cues routinely meet exactly (`A.end === B.start === 10.000`), and
 * at `t === 10.000` the closed form matches A FIRST and returns it, because it
 * scans in order and stops at the first hit. So the last frame of every cue and
 * the first frame of its successor belong to the cue that is already over.
 *
 * The reason that is visible rather than theoretical: `timeUpdate` fires at
 * 2Hz, so the playhead is routinely sampled within half a second either side of
 * a boundary, and the lookup is re-evaluated on every sample. Any track whose
 * cues butt up against each other flickers — the old line for one sample, the
 * new one for the next — across the whole episode, not just at the transitions
 * that happen to be mis-timed.
 *
 * Making the end exclusive also makes the two cases disjoint, which is what
 * lets the `break` below be correct: a cue that starts after `t` can never be
 * in the answer, and neither can anything behind it. Overlap does not change
 * that rule — it only means more than one cue passes it.
 */
export function cuesAt(cues: Cue[], t: number): Cue[] {
  const out: Cue[] = [];
  for (const c of cues) {
    if (c.start > t) break;
    if (t < c.end) out.push(c);
  }
  return out;
}

/**
 * The FIRST cue open at t, or null.
 *
 * Kept for the single-line callers (the settings preview's sample cue, the
 * layer checks). The player does NOT use this: it goes through
 * `buildSubtitleFrame`, which needs all of them.
 */
export function cueAt(cues: Cue[], t: number): Cue | null {
  return cuesAt(cues, t)[0] ?? null;
}

/**
 * The cues to show at playhead time `t`, corrected by the viewer's sync setting.
 *
 * `delayMs` uses the convention every desktop player uses, so it is the one
 * people already expect: POSITIVE delays the subtitles (they appear later than
 * the track asks for), NEGATIVE advances them (earlier).
 *
 * The correction is applied to the LOOKUP TIME, never to the cues. The parsed
 * track stays byte-identical to the file, so changing the value costs one
 * subtraction, there is nothing to re-parse, and a bug here can only ever
 * misplace a line — never corrupt the track it came from.
 *
 * A zero (or non-finite) delay short-circuits to `cuesAt`, so the default path
 * is exactly what it was before this setting existed. That matters: it is the
 * path every viewer who never opens the sync control is on. It also means a
 * correction can never make one layer's boundary disagree with another's — the
 * subtraction happens once, for the whole frame.
 */
export function cuesAtSync(cues: Cue[], t: number, delayMs: number): Cue[] {
  if (!delayMs || !Number.isFinite(delayMs)) return cuesAt(cues, t);
  return cuesAt(cues, t - delayMs / 1000);
}

/** The first cue at `t` with the sync correction — see `cuesAtSync`. */
export function cueAtSync(cues: Cue[], t: number, delayMs: number): Cue | null {
  return cuesAtSync(cues, t, delayMs)[0] ?? null;
}

/**
 * The sync value as a viewer-facing phrase — `0.50s earlier`, `0.25s later`, or
 * `In sync` at zero.
 *
 * The DIRECTION is carried by the words, not by the number. A control labelled
 * only `-500` makes the viewer work out which way that points, and half of them
 * will guess wrong and slide the wrong way. One formatter for the two places
 * the value is shown (the settings page and the player's subtitle panel) keeps
 * them from drifting into two different phrasings over time.
 */
export function formatSubtitleDelay(ms: number): string {
  const v = Number.isFinite(ms) ? ms : 0;
  if (Math.round(v) === 0) return 'In sync';
  return `${(Math.abs(v) / 1000).toFixed(2)}s ${v < 0 ? 'earlier' : 'later'}`;
}
