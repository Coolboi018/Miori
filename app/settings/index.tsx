// Settings index — vertical category list like a real settings app.
//
// The profile row + grouped category rows push to sub-pages; every control
// lives on a sub-page so this screen renders almost nothing dynamic and stays
// instant to open. Row data is a flat array; adding a category is one entry.

import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { AppIcon, type AppIconName } from '@/components/ui/AppIcon';
import { useViewer } from '@/lib/auth/queries';
import { getDiscordToken, fetchDiscordUser, type DiscordUser } from '@/lib/presence/discord';
import { checkForUpdate, openUpdatePrompt } from '@/lib/updates/store';
import { updateActionLabel, updateStatusLine } from '@/lib/updates/statusLine';
import { useUpdateState } from '@/lib/updates/useUpdate';

interface Category {
  key: string;
  title: string;
  /** Grey status line under the title, like iOS settings subtitles. */
  hint: string;
  icon: AppIconName;
  /** iOS settings icon tiles are saturated, literal colours — kept literal. */
  tile: string;
  /**
   * A row that DOES something instead of pushing a page.
   *
   * Only the update check qualifies: everything else here opens a screen of its
   * own, and a control that lives on the list it is already on has nowhere to
   * push. Kept as one optional field rather than a `onPress` per entry so the
   * array stays plain data.
   */
  action?: 'checkUpdates';
}

interface Section {
  title: string;
  items: Category[];
}

const SECTIONS: Section[] = [
  {
    title: 'Preferences',
    items: [
      { key: 'appearance', title: 'Appearance', hint: 'Theme · tile design · tab bar', icon: 'settings', tile: '#5e5ce6' },
      { key: 'player', title: 'Player', hint: 'Speed · seeking · audio · buffer', icon: 'play', tile: '#0a84ff' },
      { key: 'subtitles', title: 'Subtitles', hint: 'Language · size · position', icon: 'subtitles', tile: '#bf5af2' },
      { key: 'extensions', title: 'Extensions', hint: 'Source repositories', icon: 'database', tile: '#ff6b6b' },
    ],
  },
  {
    title: 'Account',
    items: [
      { key: 'accounts', title: 'Accounts', hint: 'AniList · Discord', icon: 'account', tile: '#30d158' },
    ],
  },
  {
    title: 'Storage',
    items: [
      { key: 'data', title: 'Storage & Data', hint: 'Cache · diagnostics', icon: 'database', tile: '#ff9f0a' },
    ],
  },
  {
    title: 'About',
    items: [
      // First, because it is the only row here that ACTS — the rest open pages,
      // and this is the one people come to Settings for after a release.
      {
        key: 'updates',
        title: 'Check for updates',
        // Replaced at render time from the updater's own state; the array stays
        // static so ordering never depends on a network result.
        hint: '',
        icon: 'reset',
        tile: '#5e5ce6',
        action: 'checkUpdates',
      },
      { key: 'about', title: 'About', hint: 'Version · reset', icon: 'info', tile: '#8e8e93' },
      // Last on purpose: it is the page you read once, not a setting.
      { key: 'developer', title: 'Developer', hint: 'CoolBoi018 · extension repo · how it is made', icon: 'sparkles', tile: '#ff375f' },
    ],
  },
];

export default function SettingsIndex() {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [duser, setDuser] = useState<DiscordUser | null>(null);
  // Subscribed once for the whole list: the row's hint and its right-hand word
  // both come from this, and neither should be a second subscription.
  const update = useUpdateState();

  /**
   * The one row on this screen that runs something. A known update re-opens the
   * card (the same host the launch check uses) instead of re-asking GitHub; a
   * fresh check fires the request and lets the updater decide whether to open
   * it.
   */
  const onCategoryPress = (cat: Category) => {
    if (cat.action === 'checkUpdates') {
      if (update.status === 'available') openUpdatePrompt();
      else void checkForUpdate();
      return;
    }
    router.push(`/settings/${cat.key}` as never);
  };

  // The shared entry, not a fetch of its own. Three screens were each calling
  // `fetchViewer` on mount for one answer, and none of them would notice an account
  // changing while it was open.
  const { viewer } = useViewer();

  // Only the Discord half needs a request, so it is the only half left in here. The
  // profile row is what reads both.
  const refresh = useCallback(async () => {
    try {
      const dtoken = await getDiscordToken();
      setDuser(dtoken ? await fetchDiscordUser(dtoken).catch(() => null) : null);
    } catch {
      setDuser(null);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );

  const profileSub = viewer
    ? duser
      ? 'AniList · Discord connected'
      : 'AniList connected'
    : 'Log in to sync progress';

  return (
    <View style={[styles.container, { backgroundColor: color.bg.primary }]}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.lg }]}>
        <Text style={[styles.back, { color: color.accent.base }]} onPress={() => router.back()}>
          ‹ Back
        </Text>
        <Text style={[styles.title, { color: color.text.primary }]}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.giant }}>
        {/* Profile card — the Apple-ID row at the top of iOS settings. */}
        <Pressable
          onPress={() => router.push('/settings/accounts')}
          accessibilityRole="button"
          accessibilityLabel="Open accounts"
          style={({ pressed }) => [
            styles.profile,
            { backgroundColor: color.bg.surface, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <View style={[styles.avatar, { backgroundColor: color.accent.muted }]}>
            {viewer?.avatar?.large ? (
              <Image
                source={{ uri: viewer.avatar.large }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                cachePolicy="memory-disk"
              />
            ) : (
              <AppIcon name="user" size={26} color={color.text.secondary} />
            )}
          </View>
          <View style={styles.profileText}>
            <Text style={[styles.profileName, { color: color.text.primary }]} numberOfLines={1}>
              {viewer ? viewer.name : 'Guest'}
            </Text>
            <Text style={[styles.profileSub, { color: color.text.muted }]} numberOfLines={1}>
              {profileSub}
            </Text>
          </View>
          <AppIcon name="chevron" size={16} color={color.text.muted} />
        </Pressable>

        {SECTIONS.map((section) => (
          <View key={section.title} style={styles.section}>
            <Text style={[styles.sectionTitle, { color: color.text.muted }]}>{section.title.toUpperCase()}</Text>
            <View style={[styles.card, { backgroundColor: color.bg.surface }]}>
              {section.items.map((cat, i) => (
                <Pressable
                  key={cat.key}
                  onPress={() => onCategoryPress(cat)}
                  accessibilityRole="button"
                  accessibilityLabel={cat.title}
                  style={({ pressed }) => [
                    styles.row,
                    i < section.items.length - 1 && styles.rowBorder,
                    { opacity: pressed ? 0.6 : 1 },
                  ]}
                >
                  <View style={[styles.tile, { backgroundColor: cat.tile }]}>
                    <AppIcon name={cat.icon} size={17} color="#fff" />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={[styles.rowTitle, { color: color.text.primary }]}>{cat.title}</Text>
                    <Text style={[styles.rowHint, { color: color.text.muted }]} numberOfLines={2}>
                      {cat.action === 'checkUpdates' ? updateStatusLine(update) : cat.hint}
                    </Text>
                  </View>
                  {/* The action row says what a tap will do, and stops saying
                      "Check" the moment there is something to install. The
                      others keep the disclosure chevron. */}
                  {cat.action === 'checkUpdates' ? (
                    <Text
                      style={[
                        styles.rowAction,
                        {
                          color:
                            update.status === 'available'
                              ? color.accent.base
                              : color.text.muted,
                        },
                      ]}
                    >
                      {updateActionLabel(update)}
                    </Text>
                  ) : (
                    <AppIcon name="chevron" size={15} color={color.text.muted} />
                  )}
                </Pressable>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  back: { fontSize: 15, fontFamily: font.medium },
  title: { fontSize: 30, fontFamily: font.bold, marginTop: spacing.xs },
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: radii.lg,
  },
  avatar: { width: 52, height: 52, borderRadius: 26, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  profileText: { flex: 1, minWidth: 0 },
  profileName: { fontSize: 18, fontFamily: font.semibold },
  profileSub: { fontFamily: font.regular, fontSize: 13, marginTop: 2 },
  section: { marginTop: spacing.lg },
  sectionTitle: { fontSize: 11, fontFamily: font.bold, letterSpacing: 1.2, marginHorizontal: spacing.lg + 4, marginBottom: spacing.xs },
  card: { marginHorizontal: spacing.lg, borderRadius: radii.lg, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(128,128,128,0.18)' },
  tile: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 16, fontFamily: font.medium },
  rowHint: { fontFamily: font.regular, fontSize: 12, marginTop: 1 },
  rowAction: { fontSize: 13, fontFamily: font.semibold },
});
