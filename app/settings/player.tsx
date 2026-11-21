// Player settings — stream defaults, skip, buffer, cache.
//
// This screen was deliberately TRIMMED. It used to also offer Playback speed,
// Seeking precision, Audio mixing and Video surface; those were removed on
// 14 Nov not because they stopped working but because none of them is a
// setting most viewers should ever touch. The keys all still exist in
// `lib/settings/store.ts` and still run at their defaults — the best value of
// each was already the default (speed 1× is chosen in the player's own
// overlay; `seekPrecision` exact; `audioMixing` auto; `engine` auto) — they
// are just no longer offered as knobs, because a screen full of technical
// radios buries the two things viewers actually ask for: WHICH source plays,
// and WHICH quality. A removed setting that still works at its default is
// also the cheap rollback: restoring a section is a copy-paste from git.
//
// Every remaining option still maps to a property that EXISTS in the SDK 57
// expo-video player and is read somewhere. That rule is stated here because
// this screen used to break it: "Engine" once offered a `compat` preset that
// differed from `auto` in no field at all, and "Decoder" offered Hardware /
// Software / Auto, all three of which produced a byte-identical
// `PlayerTuning`. `scripts/check-player-scrub.ts` pins the absence.

import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { clearVideoCacheAsync, setVideoCacheSizeAsync } from 'expo-video';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { useTheme } from '@/lib/ui/useTheme';
import { font, spacing } from '@/lib/ui/tokens';
import {
  PLAYER_BUFFERS,
  PLAYER_CACHES,
  PLAYER_DEFAULT_QUALITIES,
  PLAYER_ENGINES,
  PLAYER_SWIPE_SIDES,
  PLAYER_TRIGGER_IDS,
  type PlayerBufferKey,
  type PlayerCacheKey,
} from '@/lib/settings/store';
import { useSetting, useSetSetting } from '@/lib/settings/useSetting';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingRow, SettingSection } from '@/components/ui/settings';
import { clearAllResume } from '@/lib/progress';
import { createRegistry } from '@/lib/extensions/registry';

/** Words for the hideable bottom-bar chips, keyed by `PLAYER_TRIGGER_IDS`. */
const TRIGGER_WORDS: Record<(typeof PLAYER_TRIGGER_IDS)[number], { label: string; hint: string }> = {
  speed: { label: 'Speed chip', hint: 'Playback speed in the bottom bar' },
  quality: { label: 'Quality chip', hint: 'Resolution picker in the bottom bar' },
  source: { label: 'Source chip', hint: 'Stream source switcher' },
  subs: { label: 'Subtitles chip', hint: 'Subtitle track picker' },
};

export default function PlayerSettings() {
  const { color } = useTheme();
  const router = useRouter();
  const setSetting = useSetSetting();
  const buffer = useSetting('player.buffer');
  const autoSkipIntro = useSetting('player.autoSkipIntro');
  const autoSkipOutro = useSetting('player.autoSkipOutro');
  const cache = useSetting('player.cache');
  const defaultSource = useSetting('player.defaultSource');
  const defaultQuality = useSetting('player.defaultQuality');
  const hiddenControls = useSetting('player.hiddenControls');
  const swipeSides = useSetting('player.swipeSides');
  const engine = useSetting('player.engine');
  const surfaceHintDismissed = useSetting('player.surfaceHintDismissed');

  /** The hidden chip ids, parsed — the store's validator guarantees the shape. */
  const hiddenIds = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(hiddenControls);
      return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
    } catch {
      return new Set<string>();
    }
  }, [hiddenControls]);
  const toggleHidden = (id: string) => {
    const next = new Set(hiddenIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSetting('player.hiddenControls', JSON.stringify([...next]));
  };

  // The source picker's options are the extensions that would ACTUALLY be
  // in the player's registry — built-ins plus whatever repos the user has
  // loaded. The factories are cheap object constructors (no network), so
  // building them here is free. A repo added mid-session shows up next time
  // this screen mounts.
  const sourceOptions = useMemo(
    () => createRegistry().map((e) => ({ id: e.id, label: e.label })),
    []
  );

  return (
    <SettingsPage title="Player">
      {!surfaceHintDismissed ? (
        <View style={[styles.hintCard, { backgroundColor: color.bg.surface, borderColor: color.border.muted }]}>
          <Text style={[styles.hintTitle, { color: color.text.primary }]}>
            Low-end device? Try Native surface
          </Text>
          <Text style={[styles.hintBody, { color: color.text.muted }]}>
            Native surface (SurfaceView) can be smoother on weak hardware. If you see
            subtitle/chrome glitches or wrong layering afterwards, switch back to Auto here.
          </Text>
          <View style={styles.hintActions}>
            <Pressable
              onPress={() => {
                setSetting('player.engine', 'native');
                setSetting('player.surfaceHintDismissed', true);
              }}
              style={[styles.hintBtn, { backgroundColor: color.accent.base }]}
            >
              <Text style={styles.hintBtnText}>Try it</Text>
            </Pressable>
            <Pressable
              onPress={() => setSetting('player.surfaceHintDismissed', true)}
              style={styles.hintBtnGhost}
            >
              <Text style={[styles.hintBtnGhostText, { color: color.text.muted }]}>
                Don&apos;t show again
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* The two settings viewers actually ask for, in their own sections like
          Buffer below. Both are preferences, not requirements: a source that
          does not answer this episode, or a rung the episode does not offer,
          falls back to exactly the auto walk the player has always done — a
          default must never cost a watchable episode. */}
      <SettingSection title="Default source">
        <Text style={[styles.bufferHint, { color: color.text.muted }]}>
          Where every episode starts. A source that is down for this episode falls back to Auto — it remembers where you watched each anime.
        </Text>
        <SettingRow
          label="Auto"
          hint="Remember where you watched each anime and start there (default)"
          selected={defaultSource === 'auto'}
          onSelect={() => setSetting('player.defaultSource', 'auto')}
        />
        {sourceOptions.map((s) => (
          <SettingRow
            key={s.id}
            label={s.label}
            hint={`Start every episode on ${s.label} when it has one`}
            selected={defaultSource === s.id}
            onSelect={() => setSetting('player.defaultSource', s.id)}
          />
        ))}
      </SettingSection>

      <SettingSection title="Default quality">
        <Text style={[styles.bufferHint, { color: color.text.muted }]}>
          Locked when a source offers it; otherwise the player stays in Auto. The quality menu in the player still overrides it per episode.
        </Text>
        {PLAYER_DEFAULT_QUALITIES.map((q) => (
          <SettingRow
            key={q.key}
            label={q.label}
            hint={q.hint}
            selected={defaultQuality === q.key}
            onSelect={() => setSetting('player.defaultQuality', q.key)}
          />
        ))}
      </SettingSection>

      <SettingSection title="Skip">
        <SettingRow
          label="Auto-skip intro"
          hint={
            autoSkipIntro
              ? 'Jumps past the opening once per episode. Turn off to watch every intro.'
              : 'Openings play in full. The manual Skip button still works.'
          }
          toggle={{
            value: autoSkipIntro,
            onChange: (v) => setSetting('player.autoSkipIntro', v),
          }}
        />
        <SettingRow
          label="Auto-skip outro"
          hint={
            autoSkipOutro
              ? 'Jumps past the ending when it starts. Watch out for post-credits tags.'
              : 'Endings play in full. The manual Skip button still works.'
          }
          toggle={{
            value: autoSkipOutro,
            onChange: (v) => setSetting('player.autoSkipOutro', v),
          }}
        />
      </SettingSection>

      <SettingSection title="Buffer">
        <Text style={[styles.bufferHint, { color: color.text.muted }]}>Controls video buffered ahead of playback. Higher settings use more memory; earlier timeline seeks may still need to load.</Text>
        {PLAYER_BUFFERS.map((b) => (
          <SettingRow
            key={b.key}
            label={b.label}
            hint={b.hint}
            selected={buffer === b.key}
            onSelect={() => setSetting('player.buffer', b.key as PlayerBufferKey)}
          />
        ))}
      </SettingSection>

      {Platform.OS === 'android' ? (
        <SettingSection title="Episode cache">
          <Text style={[styles.bufferHint, { color: color.text.muted }]}>Keeps stream data on this device for rewinds and replays. Off writes nothing to disk; choosing it also clears what is already cached. Higher limits use more storage. Changes apply the next time the player loads.</Text>
          {PLAYER_CACHES.map((profile) => (
            <SettingRow
              key={profile.key}
              label={profile.label}
              hint={profile.hint}
              selected={cache === profile.key}
              onSelect={() => {
                setSetting('player.cache', profile.key as PlayerCacheKey);
                if (profile.key === 'off') {
                  // There is no size to set here: the player simply stops
                  // writing. Reclaim whatever an earlier profile left behind.
                  void clearVideoCacheAsync().catch(() => {
                    // A live player refuses the clear; the setting still takes
                    // effect on the next load, and the files stay until then.
                  });
                  return;
                }
                void setVideoCacheSizeAsync(profile.bytes).catch(() => {
                  // An existing player prevents changing Expo's global cache
                  // limit; the selected value is applied on the next launch.
                });
              }}
            />
          ))}
        </SettingSection>
      ) : null}

      {/* The gesture's own preference, kept next to the chips because both are
          "how the player behaves under my thumb". Two rows, not a swap switch:
          a switch says "the other one" without ever naming either half. */}
      <SettingSection title="Swipe sides">
        <Text style={[styles.bufferHint, { color: color.text.muted }]}>
          Slide up or down on the video to change volume or brightness. Volume moves the media volume of the phone (the same one the hardware keys move); brightness only changes this player. Which one you get depends on the half you start the slide on. Swiping up always raises.
        </Text>
        {PLAYER_SWIPE_SIDES.map((s) => (
          <SettingRow
            key={s.key}
            label={s.label}
            hint={s.hint}
            selected={swipeSides === s.key}
            onSelect={() => setSetting('player.swipeSides', s.key)}
          />
        ))}
      </SettingSection>

      <SettingSection title="Player controls">
        <Text style={[styles.bufferHint, { color: color.text.muted }]}>
          Hide the bottom-bar chips you never use. Hidden chips come back the moment you turn them on — nothing is removed from the player itself.
        </Text>
        {PLAYER_TRIGGER_IDS.map((id) => (
          <SettingRow
            key={id}
            label={TRIGGER_WORDS[id].label}
            hint={TRIGGER_WORDS[id].hint}
            // The stored value is the list of HIDDEN ids, so the switch reads the
            // inverse — "on" means the chip is shown, which is what the row says.
            toggle={{ value: !hiddenIds.has(id), onChange: () => toggleHidden(id) }}
          />
        ))}
      </SettingSection>

      <SettingSection title="Advanced">
        <Text style={[styles.bufferHint, { color: color.text.muted }]}>
          Video surface. Native (SurfaceView) can be smoother on weak hardware but may glitch
          overlays; Auto (TextureView) is the safe default.
        </Text>
        {PLAYER_ENGINES.map((e) => (
          <SettingRow
            key={e.key}
            label={e.label}
            hint={e.hint}
            selected={engine === e.key}
            onSelect={() => setSetting('player.engine', e.key)}
          />
        ))}
      </SettingSection>

      <SettingSection title="Playback data">
        <SettingRow label="Reset resume positions" hint="Forget where you left off in every anime.">
          <Pressable
            onPress={async () => {
              await clearAllResume();
              router.replace('/settings/player');
            }}
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text style={[styles.clearText, { color: color.status.danger }]}>Clear</Text>
          </Pressable>
        </SettingRow>
      </SettingSection>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  bufferHint: { fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  clearText: { fontFamily: font.semibold, fontSize: 14 },
  hintCard: {
    margin: spacing.md,
    padding: spacing.md,
    borderRadius: 12,
    borderWidth: 1,
    gap: spacing.sm,
  },
  hintTitle: { fontFamily: font.semibold, fontSize: 14 },
  hintBody: { fontSize: 13, lineHeight: 18 },
  hintActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  hintBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: 8 },
  hintBtnText: { color: '#000', fontFamily: font.semibold, fontSize: 13 },
  hintBtnGhost: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  hintBtnGhostText: { fontSize: 13 },
});
