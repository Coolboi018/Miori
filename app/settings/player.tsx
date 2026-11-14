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

import { Platform, Pressable, StyleSheet, Text } from 'react-native';
import { setVideoCacheSizeAsync } from 'expo-video';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { useTheme } from '@/lib/ui/useTheme';
import { font, spacing } from '@/lib/ui/tokens';
import {
  PLAYER_BUFFERS,
  PLAYER_CACHES,
  PLAYER_DEFAULT_QUALITIES,
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
        >
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: defaultSource === 'auto' }}
            onPress={() => setSetting('player.defaultSource', 'auto')}
            hitSlop={8}
            style={styles.pick}
          >
            <Text
              style={[
                styles.pickText,
                { color: defaultSource === 'auto' ? color.accent.base : color.text.muted },
              ]}
            >
              {defaultSource === 'auto' ? 'On' : 'Use'}
            </Text>
          </Pressable>
        </SettingRow>
        {sourceOptions.map((s) => (
          <SettingRow key={s.id} label={s.label} hint={`Start every episode on ${s.label} when it has one`}>
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: defaultSource === s.id }}
              onPress={() => setSetting('player.defaultSource', s.id)}
              hitSlop={8}
              style={styles.pick}
            >
              <Text
                style={[
                  styles.pickText,
                  { color: defaultSource === s.id ? color.accent.base : color.text.muted },
                ]}
              >
                {defaultSource === s.id ? 'On' : 'Use'}
              </Text>
            </Pressable>
          </SettingRow>
        ))}
      </SettingSection>

      <SettingSection title="Default quality">
        <Text style={[styles.bufferHint, { color: color.text.muted }]}>
          Locked when a source offers it; otherwise the player stays in Auto. The quality menu in the player still overrides it per episode.
        </Text>
        {PLAYER_DEFAULT_QUALITIES.map((q) => (
          <SettingRow key={q.key} label={q.label} hint={q.hint}>
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: defaultQuality === q.key }}
              onPress={() => setSetting('player.defaultQuality', q.key)}
              hitSlop={8}
              style={styles.pick}
            >
              <Text
                style={[
                  styles.pickText,
                  { color: defaultQuality === q.key ? color.accent.base : color.text.muted },
                ]}
              >
                {defaultQuality === q.key ? 'On' : 'Use'}
              </Text>
            </Pressable>
          </SettingRow>
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
        >
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: autoSkipIntro }}
            onPress={() => setSetting('player.autoSkipIntro', !autoSkipIntro)}
            hitSlop={8}
            style={styles.pick}
          >
            <Text
              style={[
                styles.pickText,
                { color: autoSkipIntro ? color.accent.base : color.text.muted },
              ]}
            >
              {autoSkipIntro ? 'On' : 'Off'}
            </Text>
          </Pressable>
        </SettingRow>
        <SettingRow
          label="Auto-skip outro"
          hint={
            autoSkipOutro
              ? 'Jumps past the ending when it starts. Watch out for post-credits tags.'
              : 'Endings play in full. The manual Skip button still works.'
          }
        >
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: autoSkipOutro }}
            onPress={() => setSetting('player.autoSkipOutro', !autoSkipOutro)}
            hitSlop={8}
            style={styles.pick}
          >
            <Text
              style={[
                styles.pickText,
                { color: autoSkipOutro ? color.accent.base : color.text.muted },
              ]}
            >
              {autoSkipOutro ? 'On' : 'Off'}
            </Text>
          </Pressable>
        </SettingRow>
      </SettingSection>

      <SettingSection title="Buffer">
        <Text style={[styles.bufferHint, { color: color.text.muted }]}>Controls video buffered ahead of playback. Higher settings use more memory; earlier timeline seeks may still need to load.</Text>
        {PLAYER_BUFFERS.map((b) => (
          <SettingRow key={b.key} label={b.label} hint={b.hint}>
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: buffer === b.key }}
              onPress={() => setSetting('player.buffer', b.key as PlayerBufferKey)}
              hitSlop={8}
              style={styles.pick}
            >
              <Text
                style={[
                  styles.pickText,
                  { color: buffer === b.key ? color.accent.base : color.text.muted },
                ]}
              >
                {buffer === b.key ? 'On' : 'Use'}
              </Text>
            </Pressable>
          </SettingRow>
        ))}
      </SettingSection>

      {Platform.OS === 'android' ? (
        <SettingSection title="Episode cache">
          <Text style={[styles.bufferHint, { color: color.text.muted }]}>Keeps stream data on this device while watching, then clears it when you leave. Higher limits use more storage; they don’t guarantee a fixed rewind duration. Changes while watching apply after you leave the player.</Text>
          {PLAYER_CACHES.map((profile) => (
            <SettingRow key={profile.key} label={profile.label} hint={profile.hint}>
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: cache === profile.key }}
                onPress={() => {
                  setSetting('player.cache', profile.key as PlayerCacheKey);
                  void setVideoCacheSizeAsync(profile.bytes).catch(() => {
                    // An existing player prevents changing Expo's global cache
                    // limit; the selected value is applied on the next launch.
                  });
                }}
                hitSlop={8}
                style={styles.pick}
              >
                <Text style={[styles.pickText, { color: cache === profile.key ? color.accent.base : color.text.muted }]}>
                  {cache === profile.key ? 'On' : 'Use'}
                </Text>
              </Pressable>
            </SettingRow>
          ))}
        </SettingSection>
      ) : null}

      <SettingSection title="Player controls">
        <Text style={[styles.bufferHint, { color: color.text.muted }]}>
          Hide the bottom-bar chips you never use. Hidden chips come back the moment you turn them on — nothing is removed from the player itself.
        </Text>
        {PLAYER_TRIGGER_IDS.map((id) => (
          <SettingRow key={id} label={TRIGGER_WORDS[id].label} hint={TRIGGER_WORDS[id].hint}>
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ selected: !hiddenIds.has(id) }}
              onPress={() => toggleHidden(id)}
              hitSlop={8}
              style={styles.pick}
            >
              <Text
                style={[
                  styles.pickText,
                  { color: hiddenIds.has(id) ? color.text.muted : color.accent.base },
                ]}
              >
                {hiddenIds.has(id) ? 'Hidden' : 'Shown'}
              </Text>
            </Pressable>
          </SettingRow>
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
            <Text style={[styles.pickText, { color: color.status.danger }]}>Clear</Text>
          </Pressable>
        </SettingRow>
      </SettingSection>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  pick: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  pickText: { fontFamily: font.semibold, fontSize: 14 },
  bufferHint: { fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
});
