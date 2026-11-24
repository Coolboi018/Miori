// The player sheet's rows, built in one place.
//
// Split out of `PlayerScreen.tsx` (24 Nov): the rows are pure derivations of
// existing state — no effects, no player writes — and they were a third of the
// screen's render body. Keeping them here means the reasoning that decides what
// a row says (why a faded source is still tappable, why the quality sheet must
// never be blank, why "Playing at 720p" exists) sits next to the row it decides,
// and the screen keeps only the state they read.
//
// `menuTitle` and `heightOf` moved with them: the title is the sheet's, and the
// height parser is what orders the quality rows from best to worst.

import { useMemo } from 'react';

import type { HlsVariant } from '@/lib/extensions/hls';
import type { SubtitleTrack, WatchSource } from '@/lib/extensions/types';
import { effectiveRate, formatRate, SPEED_STEPS, type SpeedState } from '@/lib/player/speed';
import { readSourceTrip, sourceSkipHint } from '@/lib/player/sourceLedger';

import type { MenuId } from './Chrome';
import type { MenuRow } from './Menu';

/** The cross-source quality gather's phase. */
export type QualityPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'failed';

export interface PlayerMenuRowsInput {
  speed: SpeedState;
  sources: WatchSource[];
  srcIndex: number;
  failedSources: { id: string; reason: string }[];
  /** Bumped when the session ledger changes; read so the memo re-runs. */
  ledgerTick: number;
  resolving: boolean;
  qualitySel: { src: number; v: number } | null;
  qualityPhase: QualityPhase;
  liveHeight: number | null;
  variantsBySource: Record<number, HlsVariant[]>;
  tracks: SubtitleTrack[];
  trackIndex: number;
}

export function usePlayerMenuRows({
  speed,
  sources,
  srcIndex,
  failedSources,
  ledgerTick,
  resolving,
  qualitySel,
  qualityPhase,
  liveHeight,
  variantsBySource,
  tracks,
  trackIndex,
}: PlayerMenuRowsInput) {
  /**
   * One entry per DISTINCT quality across every source, preferring the variant
   * owned by the active source so picking it needs no source switch.
   */
  const mergedQualities = useMemo(() => {
    const byLabel = new Map<string, { label: string; src: number; v: number; own: boolean }>();
    for (let si = 0; si < sources.length; si++) {
      const list = variantsBySource[si];
      if (!list?.length) continue;
      list.forEach((v, vi) => {
        const own = si === srcIndex;
        const cur = byLabel.get(v.label);
        if (!cur || (own && !cur.own)) {
          byLabel.set(v.label, { label: v.label, src: si, v: vi, own });
        }
      });
    }
    return [...byLabel.values()].sort((a, b) => {
      const ah = heightOf(a.label);
      const bh = heightOf(b.label);
      if (ah !== bh) return bh - ah;
      // A variant this source owns sorts first, so the common case is the
      // top row rather than buried by an equal height from another server.
      return Number(b.own) - Number(a.own);
    });
  }, [sources, variantsBySource, srcIndex]);
  const speedRows: MenuRow[] = useMemo(() => {
    const rows: MenuRow[] = SPEED_STEPS.map((s) => ({
      key: String(s),
      label: s === 1 ? 'Normal' : `${formatRate(s)}×`,
      selected: Math.abs(speed.committed - s) < 0.001,
    }));
    // A value the presets do not cover — show it as its own highlighted row so
    // the viewer can see (and re-open) what they set, rather than having the
    // selection silently fall through to the nearest preset.
    const isPreset = SPEED_STEPS.some((s) => Math.abs(s - speed.committed) < 0.001);
    rows.push({
      key: '__custom',
      label: 'Custom speed…',
      hint: isPreset ? undefined : `${formatRate(speed.committed)}× now`,
      selected: !isPreset,
    });
    return rows;
  }, [speed.committed]);

  const qualityRows: MenuRow[] = useMemo(() => {
    const rows: MenuRow[] = [
      {
        key: 'auto',
        label: 'Auto',
        hint:
          qualityPhase === 'loading'
            ? 'Loading…'
            : qualityPhase === 'failed'
              ? 'Could not read the list'
              : liveHeight != null
                ? // Auto IS a decision, and this says what it decided. Without
                  // it the sheet reads "Auto ✓" next to a chip that says 720p,
                  // which looks like the picker disagreeing with the picture.
                  `now ${liveHeight}p`
                : undefined,
        selected: qualitySel === null,
      },
    ];

    const isBusy = qualityPhase === 'loading' || qualityPhase === 'idle';

    if (isBusy && mergedQualities.length === 0) {
      rows.push({ key: '__loading', label: 'Loading qualities…', disabled: true });
      return rows;
    }

    if (qualityPhase === 'failed' && mergedQualities.length === 0) {
      rows.push({
        key: '__failed',
        label: 'Could not read qualities',
        hint: 'Tap Refresh below',
        disabled: true,
      });
    }

    /**
     * NEVER A BLANK SHEET WHILE SOMETHING IS PLAYING.
     *
     * The 24 Nov report — "the sheet got stuck" — was the sheet opened on a
     * stalled connection: the gather had failed, so the list held no rungs at
     * all, every row was a disabled placeholder, and the tap that was meant to
     * restore 720p had nothing to hit. The picture was still at a known height,
     * so say it: the viewer can see what is playing even when the LIST cannot be
     * read, and Closing stays obvious.
     */
    if (mergedQualities.length === 0 && liveHeight != null) {
      rows.push({
        key: '__current',
        label: `Playing at ${liveHeight}p`,
        hint: 'Quality list unavailable',
        selected: qualitySel === null,
        disabled: true,
      });
    }

    if (qualityPhase === 'empty' || (mergedQualities.length === 0 && !isBusy)) {
      rows.push({
        key: '__noq',
        label: 'No selectable qualities',
        hint: 'This episode plays as Auto',
        disabled: true,
      });
    }

    for (const q of mergedQualities) {
      const selected = !!qualitySel && qualitySel.src === q.src && qualitySel.v === q.v;
      /**
       * A CEILING IS NOT A GUARANTEE.
       *
       * On a separate-audio master a rung is applied as `maxResolution`, and
       * the decoder may still sit below it when the connection cannot carry it.
       * The label says what was ASKED for; this hint says what is PLAYING —
       * the "720p (now 540p)" honesty every other player gives, and the only
       * way a viewer can tell a pick from a pick that is being throttled
       * without opening a debug overlay.
       */
      const liveBelow = selected && liveHeight != null && heightOf(q.label) !== liveHeight;
      rows.push({
        key: `${q.src}:${q.v}`,
        label: q.label,
        hint: liveBelow
          ? `now ${liveHeight}p`
          : q.own
            ? mergedQualities.length === 1
              ? 'only option'
              : undefined
            : `source ${q.src + 1}`,
        selected,
      });
    }

    if (qualityPhase !== 'loading') {
      rows.push({
        key: '__retryq',
        label: 'Refresh quality list',
        hint:
          qualityPhase === 'failed'
            ? 'The last read failed'
            : mergedQualities.length < 2
              ? 'Try for more qualities'
              : undefined,
      });
    }

    return rows;
  }, [mergedQualities, qualitySel, qualityPhase, liveHeight]);

  const sourceRows: MenuRow[] = useMemo(() => {
    // READ, not merely listed: the ledger lives outside React, so a verdict
    // written by `failover` is invisible to this memo without the counter. The
    // reference is what makes the dependency real instead of a lint nit.
    void ledgerTick;
    const rows: MenuRow[] = sources.map((s, i) => ({
      key: String(i),
      label: s.quality ? `${s.quality} — source ${i + 1}` : `Source ${i + 1}`,
      hint: i === srcIndex ? 'playing' : sourceSkipHint(s.extId),
      selected: i === srcIndex,
      // Faded, not disabled: the session is skipping it, and one tap is the
      // explicit override (see `onPickSource`). A disabled row would strand a
      // provider that has recovered but has not played yet.
      muted: !!readSourceTrip(s.extId),
    }));
    // Providers that did not contribute sources (e.g. Katana/bingr blocked by
    // the network) still show up, faded, with the reason — so the sheet
    // explains WHY a source is missing instead of pretending it never existed.
    const nameFor = (id: string) =>
      id === 'filmu' ? 'Katana' : id === 'mega' ? 'Mega' : id;
    // ONE ROW PER PROVIDER. `MenuRow.key` becomes the panel list's React key,
    // so a provider reported twice is a duplicated key — React reports it as an
    // ERROR and blames the whole row list (device report, 22 Nov: opening
    // Source while an episode played showed "two children with the same key,
    // failed-filmu"). The registry dedupes by id as well; this is the picker
    // keeping its own promise rather than trusting a caller.
    const seenFailed = new Set<string>();
    failedSources.forEach((f) => {
      if (seenFailed.has(f.id)) return;
      seenFailed.add(f.id);
      rows.push({
        key: `failed-${f.id}`,
        label: nameFor(f.id),
        hint: f.reason,
        selected: false,
        disabled: true,
      });
    });
    // NOTHING TO PICK YET is a state, not an empty sheet. The picker used to
    // draw a title over a blank panel while the resolve was still in flight,
    // which reads as a provider outage rather than as a wait.
    if (sources.length === 0) {
      rows.push({
        key: '__resolving',
        label: resolving ? 'Finding sources…' : 'No sources',
        hint: resolving ? undefined : 'Tap Refresh once the episode is loaded',
        disabled: true,
      });
    }
    if (sources.length > 0) {
      rows.push({
        key: '__refresh',
        label: 'Refresh sources',
        hint: 'Re-check failed providers',
      });
    }
    return rows;
  }, [sources, srcIndex, failedSources, ledgerTick, resolving]);

  const subRows: MenuRow[] = useMemo(() => {
    const rows: MenuRow[] = [
      { key: 'off', label: 'Off', selected: tracks.length === 0 || trackIndex < 0 },
    ];
    tracks.forEach((t, i) => {
      rows.push({
        key: String(i),
        label: t.label || t.lang || `Track ${i + 1}`,
        selected: tracks.length > 0 && trackIndex === i,
      });
    });
    return rows;
  }, [tracks, trackIndex]);
  /**
   * What the quality chip says.
   *
   * Under Auto this now reports the resolution the pipeline ACTUALLY selected,
   * from `player.videoTrack`, rather than the word "Auto". "Auto" is a claim
   * about a mechanism; "1080p" is a statement about what is being downloaded,
   * and on a weak connection those are the only two facts a viewer actually
   * has. It is also the same observation the automatic downgrade steps down
   * from, so the label and the decision cannot disagree.
   *
   * Falls back to "Auto" whenever the pipeline will not say — an mp4 source has
   * no tracks to report, and a ladder that is still gathering has nothing to
   * compare against. Never invents a number.
   */
  const qualityLabel = useMemo(() => {
    if (!qualitySel) {
      return liveHeight ? `${liveHeight}p` : 'Auto';
    }
    const v = variantsBySource[qualitySel.src]?.[qualitySel.v];
    return v?.label ?? 'Auto';
  }, [qualitySel, variantsBySource, liveHeight]);

  const subsLabel = tracks.length === 0 || trackIndex < 0 ? 'Off' : (tracks[trackIndex]?.lang ?? tracks[trackIndex]?.label ?? 'On');

  // The panel's ROOT list — the drill-in entries, each carrying its live value
  // as the hint so the root doubles as an at-a-glance summary of the episode.
  const rootRows: MenuRow[] = useMemo(
    () => [
      { key: 'speed', label: 'Playback speed', hint: `${formatRate(effectiveRate(speed))}x`, to: 'speed', group: 'Playback' },
      { key: 'quality', label: 'Quality', hint: qualityLabel, to: 'quality', group: 'Playback' },
      {
        key: 'source',
        label: 'Source',
        hint: sources.length > 1 ? `${srcIndex + 1}/${sources.length}` : 'Auto',
        to: 'source',
        group: 'Playback',
      },
      { key: 'subs', label: 'Subtitles', hint: subsLabel, to: 'subs', group: 'Subtitles' },
      { key: 'subsSettings', label: 'Subtitle settings', hint: 'Size · position · style', to: 'subsSettings', group: 'Subtitles' },
    ],
    [speed, qualityLabel, sources.length, srcIndex, subsLabel]
  );

  return { speedRows, qualityRows, sourceRows, subRows, rootRows, qualityLabel, subsLabel };
}

export function menuTitle(m: MenuId): string {
  switch (m) {
    case 'root':
      return 'Player settings';
    case 'speed':
      return 'Playback speed';
    case 'quality':
      return 'Quality';
    case 'source':
      return 'Source';
    case 'subsSettings':
      return 'Subtitle settings';
    default:
      return 'Subtitles';
  }
}

function heightOf(label: string): number {
  const m = /(\d{3,4})p?/.exec(label);
  return m ? parseInt(m[1], 10) : 0;
}
