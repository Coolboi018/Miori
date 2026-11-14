// Turning a player failure into something a person can act on.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS IS NOT JUST `String(e.message)`
//
// expo-video's only failure signal is `StatusChangeEventPayload.error`, which
// is a single `{ message: string }` with nothing else — no code, no category,
// no HTTP status. The player was discarding it entirely and rendering one fixed
// sentence for every possible cause:
//
//     if (p.status === 'error') failoverRef.current();
//
// …and if the rounds ran out, "No source could play this episode."
//
// So a 403 from a CDN whose signed URL expired, a DNS failure in a lift, a
// codec the device cannot decode and a server that is simply down were four
// indistinguishable outcomes and one message. That is not a cosmetic problem.
// It is the difference between the viewer choosing "pick another source" and
// "wait for the tunnel", and the difference between a support report that says
// "HTTP 403" and one that says "it didn't work".
//
// The rule this file exists to hold: **the engine's own words always survive.**
// Whatever is guessed is added to the message, never substituted for it. A
// heuristic that silently replaced the raw text would be worse than no
// heuristic at all, because it would replace a fact with a guess and look
// confident doing it.
//
// NO IMPORTS, for the same reason as `health.ts` — `scripts/check-player-health.ts`
// runs this under plain `tsx`.

/** How a failure was classified. `'unknown'` is a normal result, not a failure. */
export type FailureKind =
  /** The request never completed: no route, DNS, timeout, TLS. */
  | 'offline'
  /** The server answered, and the answer was no. */
  | 'rejected'
  /** The URL was signed or time-limited and is no longer valid. */
  | 'expired'
  /** Bytes arrived but the device could not play them. */
  | 'unsupported'
  /** The server sent HTML or an empty body where media was expected. */
  | 'badResponse'
  /** No usable classification. The raw message is all we have. */
  | 'unknown';

export interface FailureReport {
  kind: FailureKind;
  /** One short line, second person, naming the cause. Never empty. */
  headline: string;
  /**
   * The engine's message, verbatim, so the classification above can be checked
   * against the thing it was derived from. Truncated only for display.
   */
  detail: string;
}

/**
 * Classification table.
 *
 * Order matters and is the design: `expired` is tested before `rejected`
 * because an expired signed URL is reported as a 403 and would otherwise be
 * filed as a plain rejection, which sends the viewer to a source that will fail
 * identically. Every entry is an exact token rather than a loose substring, so
 * an unrelated message cannot be swept into a bucket by containing a word.
 */
const RULES: { kind: Exclude<FailureKind, 'unknown'>; tokens: RegExp }[] = [
  {
    kind: 'expired',
    tokens:
      /(\bexpired\b|expir(?:ation|y)|token (?:is )?(?:invalid|expired)|signature (?:mismatch|invalid)|invalid_?token|403\s*forbidden)/i,
  },
  {
    kind: 'offline',
    tokens:
      /(\b(?:offline|no internet|network is unreachable|network ?lost|connection (?:reset|refused|timed? ?out|failed)|unable to (?:resolve|connect)|could not connect|unknownhost|timed out|timeout|ERROR_CODE_IO_NETWORK)\b|\bdns\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bECONNRESET\b)/i,
  },
  {
    kind: 'rejected',
    tokens:
      /(\b(?:4\d\d|5\d\d)\b|forbidden|not found|access denied|unauthorized|http ?error|status ?code)/i,
  },
  {
    kind: 'unsupported',
    tokens:
      /(\bcodec\b|decoder|decoderinit|mediacodec|unsupported (?:format|type|codec|stream)|decoder failed|ExoPlaybackException.*?(?:audio|video) ?renderer|source error)/i,
  },
  {
    kind: 'badResponse',
    tokens: /(\bhtml\b|<!doctype|empty (?:response|body)|malformed|parse(?:d)? (?:error|exception)|not a valid)/i,
  },
];

/**
 * Long enough to be worth reading on a phone in landscape, short enough that a
 * multi-paragraph native stack trace does not push the Retry button off-screen.
 */
const DETAIL_MAX = 220;

/**
 * Classify and phrase a failure. Never returns an empty headline.
 *
 * An absent or blank message is a normal input, not an edge case: `statusChange`
 * carries `error` as optional, and a media item that simply ends with no error
 * at all reaches here as `undefined`. That case gets the same treatment as an
 * unrecognised one — say plainly that nothing is known, rather than rendering an
 * empty line in the middle of an error card.
 */
export function describeFailure(message?: string | null): FailureReport {
  const raw = typeof message === 'string' ? message.trim() : '';
  const detail = truncate(raw);

  if (!raw) {
    return {
      kind: 'unknown',
      headline: 'Playback stopped without a reason the player could report.',
      detail: 'No further detail was returned by the device.',
    };
  }

  for (const rule of RULES) {
    if (rule.tokens.test(raw)) {
      return { kind: rule.kind, headline: HEADLINES[rule.kind], detail };
    }
  }

  return { kind: 'unknown', headline: HEADLINES.unknown, detail };
}

/**
 * Second person, cause first, remedy where there is an obvious one.
 *
 * These are chosen to be things the viewer can do something about rather than
 * restatements of the classification — "the source failed" helps nobody, "this
 * mirror is offline" tells them the next tap will not help but another will.
 */
const HEADLINES: Record<FailureKind, string> = {
  offline: 'Lost the connection. Waiting for the network — try another source if it does not come back.',
  rejected: 'The server refused this stream. It may be rate-limited, or the link may be restricted in this region.',
  expired: 'This playback link has expired. Picking a source again gets a fresh one.',
  unsupported: 'This device could not decode the stream. A different source usually resolves it.',
  badResponse: 'The server sent something that is not a video. The source is misbehaving.',
  unknown: 'The stream stopped for a reason the player could not identify.',
};

/**
 * Keep the first line, clipped.
 *
 * First LINE and not the first N characters: a native message is conventionally
 * `Header: context\n  at frame 1\n  at frame 2`, and the useful part is always
 * the header. Slicing by character count cuts mid-word and throws away the very
 * structure that makes it readable.
 */
function truncate(raw: string): string {
  const firstLine = raw.split('\n')[0].trim() || raw.trim();
  if (firstLine.length <= DETAIL_MAX) return firstLine;
  return `${firstLine.slice(0, DETAIL_MAX - 1).trimEnd()}…`;
}