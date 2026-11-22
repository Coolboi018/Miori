// The session's source ledger — which providers PROVED themselves, and which
// are burned for the rest of this launch.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS (22 Nov)
// ═══════════════════════════════════════════════════════════════════════════
// Resolve probes EVERY installed extension for every episode, and the failover
// walk then tries each row. When a provider is blocked by the ISP, rate-limited
// or serving 5xx, that opinion does not change between episode 3 and episode 4 —
// but the app asked again anyway, on every single open. The costs are real:
// a probe that waits out its deadline delays the list, a blocked host can throw
// the whole device's next requests into the same wall, and the viewer watches a
// spinner for a source the session already knows is dead.
//
// So the app remembers, FOR THIS LAUNCH ONLY:
//
//   • a source that fails for an ENVIRONMENTAL reason is skipped for the rest
//     of the session (the resolved rows stay visible, faded, with the reason);
//   • a source that RENDERS A FRAME is the session's proven source and is tried
//     first for every episode afterwards (proof outranks every guess);
//   • proof CLEARS a skip — a provider that recovers mid-session is welcome
//     back the moment it plays one frame, with no timer and no manual reset.
//
// WHAT DOES **NOT** TRIP A SOURCE, and why — this is the load-bearing part:
//
//   • "no mapping" / "no episodes" — that is a fact about THIS TITLE, not about
//     the host. Tripping on it would hide a perfectly good provider from the
//     next anime because it happened not to carry this one.
//   • "expired" — a signed URL dying is a property of the mint, and `refresh()`
//     plus the next resolve are the fixes. The source is fine.
//   • "offline" — the device has no network. That is not an opinion about a
//     server, and the player has its own offline path for it.
//   • "unknown" — no evidence, so no verdict. The walk moves on regardless.
//
// SCOPE. Module state, so it dies with the process: a restart is the reset, by
// design (the user asked for "until the app is restarted"). Nothing is written
// to disk — a provider blocked on a hotel Wi-Fi must not poison the next launch.
//
// NO REACT NATIVE IMPORTS: `scripts/check-source-pref.ts` drives this module
// under plain `tsx`, and the classification table is exactly the kind of rule
// that must be asserted rather than eyeballed.

import { describeFailure } from './failure';

export type SourceTripKind =
  | 'blocked'
  | 'rate-limited'
  | 'network'
  | 'server'
  | 'not-video'
  | 'unsupported';

export interface SourceTrip {
  kind: SourceTripKind;
  /** Short provider-facing phrase, safe for a one-line menu hint. */
  reason: string;
  /** When it was marked, ms since epoch. Diagnostics only. */
  at: number;
}

/** What the picker says about a skipped row. Shorter than a sentence on purpose. */
const TRIP_LABELS: Record<SourceTripKind, string> = {
  blocked: 'blocked',
  'rate-limited': 'rate limited',
  network: 'no connection',
  server: 'server error',
  'not-video': 'not video',
  unsupported: "can't decode",
};

const trips = new Map<string, SourceTrip>();

/**
 * The last extension to RENDER A FRAME this session — the strongest evidence
 * the app ever gets. `null` until something has played.
 */
let proven: string | null = null;

function key(extId: string | null | undefined): string {
  return (extId ?? '').trim().toLowerCase();
}

/** Mark a source as skipped for the rest of the session. */
export function tripSource(
  extId: string | null | undefined,
  kind: SourceTripKind,
  reason?: string,
  now = Date.now()
): SourceTrip | null {
  const id = key(extId);
  if (!id) return null;
  const trip: SourceTrip = { kind, reason: (reason ?? '').trim() || TRIP_LABELS[kind], at: now };
  trips.set(id, trip);
  return trip;
}

/** The standing skip for an extension, or null. */
export function readSourceTrip(extId: string | null | undefined): SourceTrip | null {
  const id = key(extId);
  return id ? trips.get(id) ?? null : null;
}

/** Is this extension skipped for this session? */
export function isSourceSkipped(extId: string | null | undefined): boolean {
  return readSourceTrip(extId) != null;
}

/**
 * Clear a skip WITHOUT pretending the source played.
 *
 * Used by the in-player picker: tapping a faded row is the viewer saying "try
 * it once now". It must not mark the source proven — nothing has played yet —
 * and if the attempt fails, the walk trips it again.
 */
export function clearSourceTrip(extId: string | null | undefined): void {
  const id = key(extId);
  if (id) trips.delete(id);
}

/**
 * Put every skip back on trial without clearing the proof.
 *
 * The explicit "Refresh sources" tap is the one place the user overrides the
 * session's verdicts wholesale — a provider blocked by a captive portal can be
 * worth one more probe. The walk's own wrap does NOT call this: that would
 * hammer a dead host once per round, which is the bug this file exists to fix.
 */
export function clearSourceTrips(): void {
  trips.clear();
}

/**
 * A frame rendered on this source. This is PROOF: it clears any skip and makes
 * the source the session's first choice.
 *
 * The write rule matches `sourcePref`'s: a frame, never a hop. A source that was
 * walked past rendered nothing and must not be promoted.
 */
export function noteSourcePlayed(extId: string | null | undefined): boolean {
  const raw = (extId ?? '').trim();
  const id = key(raw);
  if (!id) return false;
  const changed = trips.has(id) || proven !== raw;
  trips.delete(id);
  // The ORIGINAL spelling, not the lowercased trip key: `pickStartIndex`
  // compares this against `WatchSource.extId` exactly as the registry minted
  // it, and a case-folding mismatch would silently lose the priority.
  proven = raw;
  return changed;
}

/** The session's proven source, or null. */
export function sessionProvenSource(): string | null {
  return proven;
}

/** What to show beside a skipped row. */
export function tripHint(trip: SourceTrip): string {
  return `Skipped \u00b7 ${TRIP_LABELS[trip.kind]}`;
}

/** The picker's hint for an extension, or undefined when it is healthy. */
export function sourceSkipHint(extId: string | null | undefined): string | undefined {
  const trip = readSourceTrip(extId);
  return trip ? tripHint(trip) : undefined;
}

/** Test seam / hard reset. Also what a process restart does for free. */
export function resetSourceLedger(): void {
  trips.clear();
  proven = null;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * A resolve failed — is that the SOURCE's fault for the rest of the session?
 *
 * The strings here are `registry.ts`'s own `shortReason()` vocabulary
 * ("blocked", "network blocked", "no mapping", …) plus whatever a provider
 * threw, so the matching is deliberately token-based. ORDER MATTERS: "network
 * blocked" must be read as a network problem before the `blocked` rule sees the
 * word "blocked", and a 429 is a rate limit before it is a 4xx.
 */
export function tripKindForResolveFailure(reason: string | null | undefined): SourceTripKind | null {
  const msg = (reason ?? '').toLowerCase();
  if (!msg.trim()) return null;
  if (/429|rate.?limit|too many requests/.test(msg)) return 'rate-limited';
  if (/network|timeout|timed out|econn|enotfound|eai_again|unreachable|\bdns\b|fetch failed|reset/.test(msg)) {
    return 'network';
  }
  if (/\b5\d\d\b|bad gateway|gateway|server error|service unavailable/.test(msg)) return 'server';
  if (/blocked|403|forbidden|geo|region|access denied/.test(msg)) return 'blocked';
  if (/not video|html|malformed|empty (?:response|body)/.test(msg)) return 'not-video';
  // 'no mapping', 'no episodes', 'no sources' and a bare 'unavailable' are
  // title-level facts. They must not hide a provider from another anime.
  return null;
}

/**
 * A PLAYBACK failure — the same question for the engine's own message.
 *
 * `describeFailure` already classifies the raw native text, and this leans on it
 * rather than duplicating the table. The two cases it has to pre-empt are:
 *
 *   • a 403 that is really an EXPIRED signed URL (the classifier files it as
 *     'expired', which is correct) — no trip, `refresh()` and a re-resolve are
 *     the remedy, and the source is not at fault;
 *   • a plain 403/429/5xx — a real verdict.
 */
export function tripKindForPlaybackFailure(message: string | null | undefined): SourceTripKind | null {
  const msg = (message ?? '').trim();
  if (!msg) return null;
  if (/429|rate.?limit|too many requests/i.test(msg)) return 'rate-limited';
  if (/\b5\d\d\b|bad gateway|gateway timeout|server error|service unavailable/i.test(msg)) return 'server';

  const signature = /\bexpired\b|expir(?:ation|y)|token (?:is )?(?:invalid|expired)|signature|invalid_?token/i.test(msg);
  if (!signature && /forbidden|403|access denied|geo.?block|region/i.test(msg)) return 'blocked';

  switch (describeFailure(msg).kind) {
    case 'rejected':
      return 'blocked';
    case 'badResponse':
      return 'not-video';
    case 'unsupported':
      return 'unsupported';
    default:
      // 'expired' → the URL, not the source. 'offline' → the device, not the
      // source. 'unknown' → no evidence.
      return null;
  }
}
