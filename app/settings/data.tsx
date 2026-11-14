import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { SettingRow, SettingSection } from '@/components/ui/settings';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { gatewayStatus, type GatewayStatus } from '@/lib/presence/discord';
import { clearCache, queryClient } from '@/lib/query/client';
import { removePersistedCache } from '@/lib/query/persister';
import { clearKitsuEpisodeCache } from '@/lib/media/kitsuEpisodes';

import { budgetRemaining } from '@/lib/net/gql';

export default function DataSettings() {
  const { color } = useTheme();
  const [gw, setGw] = useState<GatewayStatus | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [budget, setBudget] = useState<number | null>(null);

  useFocusEffect(
    useCallback(() => {
      setGw(gatewayStatus());
      setBudget(budgetRemaining());
    }, [])
  );

  async function clearByPrefix(prefix: string, label: string) {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const mine = keys.filter((k) => k.startsWith(prefix));
      if (mine.length) await AsyncStorage.multiRemove(mine);
      setMsg(`${label}: cleared ${mine.length}`);
    } catch {
      setMsg(`${label}: failed`);
    }
  }

  /**
   * CLEAR EVERY CACHE THE APP NOW HAS.
   *
   * Worth being explicit about what this button wipes, because the answer changed
   * when the data layer moved to a persisted query cache. There is now a real
   * cache of AniList responses on disk, so the app's next launch paints from it
   * instantly instead of showing skeletons. Clearing it is the way to answer
   * "is this thing actually broken, or am I looking at a cached response?" —
   * which is a question worth being able to ask.
   *
   * The image caches are included because they are the largest thing on disk and
   * the most likely thing to have gone wrong. AniList's own images are keyed by
   * URL and expiring is AniList's business, so these clear instantly and refill.
   */
  const clearEverything = useCallback(async () => {
    try {
      clearCache();
      await removePersistedCache();
      // `miori:kitsu` (the hero's poster map) is deliberately NOT cleared. The
      // hero no longer resolves Kitsu posters, so nothing reads or writes that
      // key — but installs that ran the old hero still have mappings on disk.
      // They are inert and tiny, and this button is about making the NEXT launch
      // fetch from scratch, so leaving them is the honest behaviour.
      //
      // `miori:kitsu-episodes` IS cleared, because that one is live: it is what
      // fills in episode artwork and titles, so leaving it would mean "clear
      // everything" did not.
      await clearKitsuEpisodeCache();
      await Promise.all([Image.clearMemoryCache(), Image.clearDiskCache()]);
      setMsg('All caches cleared. Next launch will fetch everything again.');
      setBudget(budgetRemaining());
    } catch {
      setMsg('Failed to clear caches');
    }
  }, []);

  return (
    <SettingsPage title="Storage & Data">
      <SettingSection title="Storage">
        <SettingRow label="Resume positions" hint="Per-episode watch progress saved on this phone.">
          <Text
            style={{ color: color.status.danger, fontSize: 15, fontFamily: font.semibold }}
            onPress={() => void clearByPrefix('miori:pos:', 'Resume')}
            accessibilityRole="button"
          >
            Clear
          </Text>
        </SettingRow>
        <SettingRow label="Artwork cache" hint="Discord presence icons resolved for posters.">
          <Text
            style={{ color: color.status.danger, fontSize: 15, fontFamily: font.semibold }}
            onPress={() => void clearByPrefix('miori:art:', 'Artwork')}
            accessibilityRole="button"
          >
            Clear
          </Text>
        </SettingRow>
      </SettingSection>

      <SettingSection title="Offline cache">
        <SettingRow
          label="Everything"
          hint="Cached AniList responses and poster bitmaps. Clearing this makes the next launch fetch from scratch instead of painting from disk."
        >
          <Text
            style={{ color: color.status.danger, fontSize: 15, fontFamily: font.semibold }}
            onPress={() => void clearEverything()}
            accessibilityRole="button"
          >
            Clear
          </Text>
        </SettingRow>
      </SettingSection>

      <SettingSection title="Diagnostics">
        <SettingRow
          label="AniList requests"
          hint={
            budget == null
              ? 'Requests left in the current minute.'
              : `${budget} of 24 left in this minute. The client queues rather than exceeding the limit, so a 429 should never be the reason a screen is empty.`
          }
        >
          <Text style={{ color: color.text.secondary, fontSize: 15, fontFamily: font.semibold }}>
            {queryClient.getQueryCache().getAll().length} cached
          </Text>
        </SettingRow>
        <SettingRow
          label={gw?.ready ? 'Socket online' : `Socket ${gw?.phase ?? 'idle'}`}
          hint={
            gw?.lastCode != null
              ? `code ${gw.lastCode}${gw.lastError ? ` ${gw.lastError}` : ''}`
              : 'Presence socket state.'
          }
        >
          <Pressable
            onPress={async () => {
              const { updateBrowsing } = await import('@/lib/presence/discord');
              await updateBrowsing('Presence self-test');
              setTimeout(() => setGw(gatewayStatus()), 3000);
            }}
            accessibilityRole="button"
            style={{ backgroundColor: color.accent.muted, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radii.full }}
          >
            <Text style={{ color: color.text.primary, fontSize: 14, fontFamily: font.semibold }}>Test</Text>
          </Pressable>
        </SettingRow>
      </SettingSection>

      {msg ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm }}>
          <Text style={{ color: color.text.muted, fontSize: 13, fontFamily: font.medium }}>{msg}</Text>
        </View>
      ) : null}
    </SettingsPage>
  );
}
