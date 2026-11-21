import { useCallback, useEffect, useRef, useState } from 'react';
import { Image } from 'expo-image';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { AppIcon } from '@/components/ui/AppIcon';

import { getToken } from '@/lib/anilist/auth';
import { updateBrowsing } from '@/lib/presence/discord';
import { pushOnce, openAnime as openAnimeNav } from '@/lib/nav/pushOnce';
import { openCharacterSheet } from '@/lib/anime/characterSheet';
import {
  fetchProfile,
  fetchMediaList,
  type ProfileData,
  type MediaListEntry,
  type FavouriteAnime,
  type FavouriteCharacter,
} from '@/lib/anilist/lists';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'CURRENT', label: 'Watching' },
  { key: 'PLANNING', label: 'Planning' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'PAUSED', label: 'On Hold' },
  { key: 'DROPPED', label: 'Dropped' },
  { key: 'REPEATING', label: 'Rewatching' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function ProfileScreen() {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string }>();
  const initialTab = (params.tab as TabKey) ?? 'overview';

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [list, setList] = useState<MediaListEntry[]>([]);
  const [listLoading, setListLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error('Not logged in');
        const p = await fetchProfile(token);
        if (alive) setProfile(p);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load profile');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Fade-in for the profile content once it arrives.
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const avatarScale = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    if (profile) {
      fadeAnim.setValue(0);
      avatarScale.setValue(0.6);
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 450, useNativeDriver: true }),
        Animated.spring(avatarScale, { toValue: 1, friction: 6, tension: 60, useNativeDriver: true }),
      ]).start();
    }
  }, [profile, fadeAnim, avatarScale]);

  // Discord presence: browsing the AniList profile. The focus callback runs while
  // `profile` may still be null (first load), so a second effect re-fires when it
  // arrives — same shape as the details page.
  //
  // When there is no logged-in account (or the fetch failed) we still assert a
  // card of our own instead of leaving the previous screen's card on the profile
  // — "Profile" with no artwork/button. A stale card lingering over a screen
  // that has its own identity is worse than a generic one.
  useFocusEffect(
    useCallback(() => {
      if (profile) {
        updateBrowsing(profile.name, {
          artKey: `u${profile.id}`,
          artUrl: profile.avatar ?? '',
          pageUrl: `https://anilist.co/user/${profile.name}`,
          buttonLabel: 'View Profile',
        });
      } else if (!loading) {
        updateBrowsing('Profile');
      }
    }, [profile, loading])
  );
  useEffect(() => {
    if (profile) {
      updateBrowsing(profile.name, {
        artKey: `u${profile.id}`,
        artUrl: profile.avatar ?? '',
        pageUrl: `https://anilist.co/user/${profile.name}`,
        buttonLabel: 'View Profile',
      });
    } else if (!loading) {
      updateBrowsing('Profile');
    }
  }, [profile, loading]);
  const loadList = useCallback(async (status: string) => {
    if (!profile) return;
    setListLoading(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Not logged in');
      const entries = await fetchMediaList(token, profile.id, status);
      setList(entries);
    } catch {
      setList([]);
    } finally {
      setListLoading(false);
    }
  }, [profile]);

  useEffect(() => {
    if (tab === 'overview') return;
    void loadList(tab);
  }, [tab, loadList]);

  const openAnime = useCallback((id: number) => {
    openAnimeNav(id);
  }, []);

  if (loading) {
    return (
      <View
        style={[
          styles.root,
          { backgroundColor: color.bg.primary, paddingTop: insets.top, alignItems: 'center', justifyContent: 'center' },
        ]}
      >
        <ActivityIndicator size="large" color={color.accent.base} />
        <Text style={[styles.loading, { color: color.text.muted, marginTop: spacing.md }]}>Loading profile…</Text>
      </View>
    );
  }

  if (error === 'Not logged in' || (!profile && !error)) {
    // Not-logged-in empty state — make it look like a destination, not a crash.
    return (
      <View style={[styles.root, { backgroundColor: color.bg.primary }]}>
        <View style={[styles.notLoggedIn, { paddingTop: insets.top + spacing.xxxl }]}>
          <Pressable onPress={() => router.back()} style={[styles.backBtn, { top: insets.top + spacing.sm }]}>
            <AppIcon name="back" size={22} color={color.text.primary} strokeWidth={2.5} />
          </Pressable>
          <View style={[styles.notLoggedInAvatar, { backgroundColor: color.accent.muted }]}>
            <AppIcon name="user" size={40} color={color.text.secondary} />
          </View>
          <Text style={[styles.notLoggedInTitle, { color: color.text.primary }]}>
            Your AniList profile
          </Text>
          <Text style={[styles.notLoggedInSub, { color: color.text.muted }]}>
            Log in to see your stats, favourites and lists — everything syncs to your
            AniList account.
          </Text>
          <Pressable
            onPress={() => pushOnce('/login')}
            style={({ pressed }) => [
              styles.notLoggedInBtn,
              { backgroundColor: color.accent.base, opacity: pressed ? 0.85 : 1 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Log in to AniList"
          >
            <AppIcon name="user" size={18} color={color.bg.primary} />
            <Text style={[styles.notLoggedInBtnText, { color: color.bg.primary }]}>
              Log in to AniList
            </Text>
          </Pressable>
          <Pressable
            onPress={() => pushOnce('/settings/accounts')}
            style={({ pressed }) => [styles.notLoggedInSecondary, { opacity: pressed ? 0.6 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel="Open accounts settings"
          >
            <Text style={[styles.notLoggedInSecondaryText, { color: color.text.muted }]}>
              Manage accounts in Settings
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (error || !profile) {
    return (
      <View style={[styles.root, { backgroundColor: color.bg.primary, paddingTop: insets.top }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <AppIcon name="back" size={22} color={color.text.primary} strokeWidth={2.5} />
        </Pressable>
        <Text style={[styles.error, { color: color.status.danger }]}>{error ?? 'No profile'}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: color.bg.primary }]}>
      <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.giant }}>
        {/* Hero */}
        <View style={styles.hero}>
          {profile.banner ? (
            <Image source={{ uri: profile.banner }} style={styles.banner} contentFit="cover" />
          ) : (
            <View style={[styles.banner, { backgroundColor: color.bg.surface }]} />
          )}
          {/* Bottom fade so the hero blends into the page instead of a hard cut. */}
          <View style={styles.heroFade} pointerEvents="none" />
          <View style={styles.heroOverlay} pointerEvents="none" />
          <Pressable onPress={() => router.back()} style={[styles.backBtn, { top: insets.top + spacing.sm }]}>
            <AppIcon name="back" size={22} color="#fff" strokeWidth={2.5} />
          </Pressable>
          <View style={[styles.heroContent, { paddingTop: insets.top + spacing.xl + spacing.lg }]}>
            <Animated.View style={[styles.avatarWrap, { transform: [{ scale: avatarScale }] }]}>
              {profile.avatar ? (
                <Image source={{ uri: profile.avatar }} style={styles.avatar} contentFit="cover" />
              ) : (
                <View style={[styles.avatar, { backgroundColor: color.accent.muted, alignItems: 'center', justifyContent: 'center' }]}>
                  <Text style={{ color: color.text.primary, fontSize: 28, fontFamily: font.bold }}>
                    {profile.name.charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
            </Animated.View>
            <Text style={styles.name}>{profile.name}</Text>
            <Text style={styles.handle}>AniList profile</Text>
          </View>
        </View>

        {/* Stats */}
        <View style={[styles.statsCard, { backgroundColor: color.bg.surface }]}>
          <Stat icon="tv" label="Anime" value={profile.stats.count} color={color} />
          <Stat icon="play" label="Episodes" value={profile.stats.episodesWatched} color={color} />
          <Stat icon="hourglass" label="Minutes" value={profile.stats.minutesWatched} color={color} />
          <Stat icon="star" label="Mean score" value={profile.stats.meanScore.toFixed(1)} color={color} />
        </View>

        {/* Tabs */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <Pressable
                key={t.key}
                onPress={() => setTab(t.key)}
                style={[
                  styles.tab,
                  active && {
                    borderBottomColor: color.accent.base,
                    borderBottomWidth: 2,
                    backgroundColor: color.accent.muted,
                    borderRadius: radii.sm,
                  },
                ]}
              >
                <Text style={[styles.tabText, { color: active ? color.text.primary : color.text.muted }]}>
                  {t.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {tab === 'overview' ? (
          <View style={{ paddingHorizontal: spacing.lg }}>
            <Section title="Favourite anime" color={color}>
              <HorizontalList items={profile.favourites.anime} onPress={openAnime} color={color} />
            </Section>
            <Section title="Favourite characters" color={color}>
              <CharacterList items={profile.favourites.characters} color={color} />
            </Section>
          </View>
        ) : listLoading ? (
          <View style={{ alignItems: 'center', marginTop: spacing.xl, gap: spacing.sm }}>
            <ActivityIndicator size="small" color={color.accent.base} />
            <Text style={[styles.loading, { color: color.text.muted }]}>Loading…</Text>
          </View>
        ) : list.length === 0 ? (
          <Text style={[styles.loading, { color: color.text.muted, marginTop: spacing.xl }]}>Nothing here yet.</Text>
        ) : (
          <View style={styles.grid}>
            {list.map((e, i) => {
              const dotColor =
                e.mediaStatus === 'RELEASING'
                  ? color.status.success
                  : e.mediaStatus === 'NOT_YET_RELEASED'
                    ? color.status.info
                    : color.text.muted;
              return (
              <Pressable key={`${e.id}-${i}`} onPress={() => openAnime(e.id)} style={({ pressed }) => [styles.gridItem, { opacity: pressed ? 0.7 : 1 }]}>
                {e.cover ? (
                  <Image source={{ uri: e.cover }} style={styles.gridCover} contentFit="cover" />
                ) : (
                  <View style={[styles.gridCover, { backgroundColor: color.bg.surface }]} />
                )}
                <Text style={[styles.gridTitle, { color: color.text.primary }]} numberOfLines={1}>
                  {e.title}
                </Text>
                <View style={styles.gridMetaRow}>
                  <View style={[styles.gridDot, { backgroundColor: dotColor }]} />
                  <Text style={[styles.gridMeta, { color: color.text.muted }]}>
                    {e.progress}
                    {e.episodes ? `/${e.episodes}` : ''} · {e.score ? e.score.toFixed(1) : '—'}
                  </Text>
                </View>
              </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
      </Animated.View>
    </View>
  );
}

function Stat({ icon, label, value, color }: { icon: string; label: string; value: any; color: any }) {
  return (
    <View style={styles.stat}>
      <AppIcon name={icon as any} size={16} color={color.text.muted} />
      <Text style={[styles.statValue, { color: color.text.primary }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: color.text.muted }]}>{label}</Text>
    </View>
  );
}

function Section({ title, color, children }: { title: string; color: any; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: spacing.lg }}>
      <Text style={[styles.sectionTitle, { color: color.text.muted }]}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

function HorizontalList({ items, onPress, color }: { items: FavouriteAnime[]; onPress: (id: number) => void; color: any }) {
  if (items.length === 0) {
    return <Text style={[styles.empty, { color: color.text.muted }]}>No favourites yet.</Text>;
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      {items.map((a, i) => {
    const dotColor =
      a.mediaStatus === 'RELEASING'
        ? color.status.success
        : a.mediaStatus === 'NOT_YET_RELEASED'
          ? color.status.info
          : color.text.muted;
    return (
        <Pressable key={`${a.id}-${i}`} onPress={() => onPress(a.id)} style={({ pressed }) => [styles.favCard, { opacity: pressed ? 0.7 : 1 }]}>
          {a.cover ? (
            <Image source={{ uri: a.cover }} style={styles.favCover} contentFit="cover" />
          ) : (
            <View style={[styles.favCover, { backgroundColor: color.bg.surface }]} />
          )}
          <View style={styles.favTitleRow}>
            <View style={[styles.favDot, { backgroundColor: dotColor }]} />
            <Text style={[styles.favTitle, { color: color.text.primary, flex: 1 }]} numberOfLines={1}>
              {a.title}
            </Text>
          </View>
        </Pressable>
    );
  })}
    </ScrollView>
  );
}

function CharacterList({ items, color }: { items: FavouriteCharacter[]; color: any }) {
  if (items.length === 0) {
    return <Text style={[styles.empty, { color: color.text.muted }]}>No favourite characters yet.</Text>;
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      {items.map((c, i) => (
        <Pressable
          key={`${c.id}-${i}`}
          onPress={() => openCharacterSheet({ id: c.id, name: c.name, image: c.image })}
          style={({ pressed }) => [styles.charCard, { opacity: pressed ? 0.7 : 1 }]}
        >
          {c.image ? (
            <Image source={{ uri: c.image }} style={styles.charImg} contentFit="cover" />
          ) : (
            <View style={[styles.charImg, { backgroundColor: color.bg.surface }]} />
          )}
          <Text style={[styles.charName, { color: color.text.primary }]} numberOfLines={2}>
            {c.name}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  loading: { textAlign: 'center', marginTop: 120, fontSize: 14, fontFamily: font.medium },
  error: { textAlign: 'center', marginTop: 120, fontSize: 14, fontFamily: font.medium },
  backBtn: {
    position: 'absolute',
    left: spacing.lg,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    zIndex: 2,
  },
  hero: { height: 240, position: 'relative' },
  banner: { ...StyleSheet.absoluteFill, opacity: 0.4 },
  heroOverlay: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.55)' },
  heroFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 120,
    experimental_backgroundImage: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.9) 100%)',
  },
  heroContent: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, alignItems: 'center' },
  avatarWrap: { marginBottom: spacing.xs },
  avatar: { width: 80, height: 80, borderRadius: 40, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.25)', overflow: 'hidden' },
  name: { color: '#fff', fontSize: 24, fontFamily: font.bold, marginTop: spacing.sm, letterSpacing: -0.3 },
  handle: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontFamily: font.medium, marginTop: 2, letterSpacing: 0.4, textTransform: 'uppercase' },
  statsCard: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    borderRadius: radii.lg,
    padding: spacing.md,
    justifyContent: 'space-around',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
  },
  stat: { alignItems: 'center', gap: 2 },
  statValue: { fontSize: 18, fontFamily: font.bold },
  statLabel: { fontSize: 10, fontFamily: font.medium, letterSpacing: 0.6, textTransform: 'uppercase' },
  tabs: { paddingHorizontal: spacing.lg, marginTop: spacing.lg, gap: spacing.sm },
  tab: { paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabText: { fontSize: 13, fontFamily: font.semibold },
  sectionTitle: { fontSize: 11, fontFamily: font.bold, letterSpacing: 1.2, marginBottom: spacing.sm, marginTop: spacing.md },
  empty: { fontSize: 13, fontFamily: font.regular, marginTop: spacing.sm },
  favCard: { width: 110, marginRight: spacing.md },
  favCover: { width: 110, height: 165, borderRadius: radii.md, marginBottom: spacing.xs },
  favTitle: { fontSize: 12, fontFamily: font.medium, lineHeight: 15 },
  favTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  favDot: { width: 6, height: 6, borderRadius: 3 },
  charCard: { width: 80, marginRight: spacing.md, alignItems: 'center' },
  charImg: { width: 72, height: 72, borderRadius: 36, marginBottom: spacing.xs },
  charName: { fontSize: 11, fontFamily: font.medium, textAlign: 'center', lineHeight: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: spacing.lg, gap: spacing.md, marginTop: spacing.md },
  gridItem: { width: '30%' },
  gridCover: { width: '100%', aspectRatio: 2 / 3, borderRadius: radii.md, marginBottom: spacing.xs },
  gridTitle: { fontSize: 12, fontFamily: font.medium, lineHeight: 15 },
  gridMeta: { fontSize: 10, fontFamily: font.regular },
  gridMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  gridDot: { width: 6, height: 6, borderRadius: 3 },
  notLoggedIn: { flex: 1, alignItems: 'center', paddingHorizontal: spacing.xxl },
  notLoggedInAvatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  notLoggedInTitle: { fontSize: 22, fontFamily: font.bold, textAlign: 'center' },
  notLoggedInSub: {
    fontSize: 14,
    fontFamily: font.regular,
    textAlign: 'center',
    lineHeight: 20,
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
    maxWidth: 320,
  },
  notLoggedInBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.full,
  },
  notLoggedInBtnText: { fontSize: 15, fontFamily: font.semibold },
  notLoggedInSecondary: { marginTop: spacing.md, paddingVertical: spacing.sm },
  notLoggedInSecondaryText: { fontSize: 13, fontFamily: font.medium },
});