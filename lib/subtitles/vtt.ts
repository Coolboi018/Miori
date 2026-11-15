// Minimal WebVTT parser for the subtitle overlay.
// expo-video only exposes embedded subs; our sources ship sidecar .vtt,
// so we fetch + parse + render cues ourselves.
//
// Parsing and LOOKING are deliberately separate. This file answers "which words
// are on screen at time t" and nothing about how big or how high they sit; that
// lives in `lib/subtitles/style.ts` so it can be checked without React Native.

export interface Cue {
  start: number; // seconds
  end: number;
  text: string;
}

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
    let i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseTimestamp(a);
    const end = parseTimestamp((b ?? '').trim().split(/\s+/)[0] ?? '');
    if (start == null || end == null || end <= start) continue;
    const textOut = lines
      .slice(i + 1)
      .map(cleanText)
      .filter(Boolean)
      .join('\n');
    if (textOut) cues.push({ start, end, text: textOut });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/**
 * Active cue at time t (linear scan is fine: a few hundred cues at 2Hz).
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
 * a boundary, and `cueAt` is re-evaluated on every sample. Any track whose cues
 * butt up against each other flickers — the old line for one sample, the new one
 * for the next — across the whole episode, not just at the transitions that
 * happen to be mis-timed.
 *
 * Making the end exclusive also makes the two cases disjoint, which is what
 * lets the `break` below be correct: a cue that starts after `t` can never be
 * the answer, and neither can anything behind it.
 */
export function cueAt(cues: Cue[], t: number): Cue | null {
  for (const c of cues) {
    if (t >= c.start && t < c.end) return c;
    if (c.start > t) break;
  }
  return null;
}

/**
 * The cue to show at playhead time `t`, corrected by the viewer's sync setting.
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
 * A zero (or non-finite) delay short-circuits to `cueAt`, so the default path
 * is exactly what it was before this setting existed. That matters: it is the
 * path every viewer who never opens the sync control is on.
 */
export function cueAtSync(cues: Cue[], t: number, delayMs: number): Cue | null {
  if (!delayMs || !Number.isFinite(delayMs)) return cueAt(cues, t);
  return cueAt(cues, t - delayMs / 1000);
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
