// Full cast page — every character of one anime, with their voice actor.
//
// Design: two-column cards, each card a mirrored pair — character portrait
// on the left with name/role, voice actor portrait on the right with name
// and language, a thin link between the two. Main characters carry an
// accent-tinted role chip; supporting stay quiet.
//
// Reached from the detail screen's Characters tab via "View all".

import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCharacters } from '@/lib/query/hooks';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { AppIcon } from '@/components/ui/AppIcon';
import { CastSkeleton } from '@/components/anime/CastSkeleton';
import { openCharacterSheet } from '@/lib/anime/characterSheet';

/** AniList role enum → display label. */
function roleLabel(role: string): string {
  if (role === 'MAIN') return 'Main';
  if (role === 'SUPPORTING') return 'Supporting';
  if (role === 'BACKGROUND') return 'Background';
  return role.charAt(0) + role.slice(1).toLowerCase();
}

export default function CharactersScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const router = useRouter();
  const animeId = Number(id);
  const { color } = useTheme();
  const insets = useSafeAreaInsets();

  /**
   * The full cast, through the cache.
   *
   * This was the last request in the app with no caching at all — a bare effect
   * and a `useState`, so every visit to a title's cast page spent a fresh request
   * on fifty characters and their voice actors. Now it is a query keyed on the
   * anime id, so the second visit is free and it works offline, and the detail
   * screen's "View all" arrives with it already there.
   */
  const { data: cast, error, refetch } = useCharacters(animeId);

  const accentChip = (role: string) => role === 'MAIN';

  return (
    <View style={[styles.container, { backgroundColor: color.bg.primary }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm, borderBottomColor: color.border.muted }]}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={8}
          style={[styles.back, { backgroundColor: color.bg.surface }]}
        >
          <AppIcon name="back" size={20} color={color.text.primary} strokeWidth={2.5} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={[styles.headerTitle, { color: color.text.primary }]} numberOfLines={1}>
            Characters
          </Text>
          {title ? (
            <Text style={[styles.headerSub, { color: color.text.muted }]} numberOfLines={1}>
              {title}
            </Text>
          ) : null}
        </View>
      </View>

      {error && !cast ? (
        <View style={styles.center}>
          <Text style={[styles.errorText, { color: color.status.danger }]}>{error.message}</Text>
          <Pressable
            onPress={() => void refetch()}
            style={[styles.errorBtn, { backgroundColor: color.accent.muted }]}
            accessibilityRole="button"
          >
            <Text style={{ color: color.text.primary, fontFamily: font.semibold }}>Try again</Text>
          </Pressable>
        </View>
      ) : !cast ? (
        // The page at its real geometry, not a spinner — same policy as the
        // detail screen. Cards' plates become portraits in place.
        <CastSkeleton />
      ) : (
        <FlatList
          data={cast}
          keyExtractor={(c) => String(c.id)}
          // Two columns of cast cards. Small, flat views — virtualisation
          // does the rest, no window tuning needed at 50 items.
          numColumns={2}
          columnWrapperStyle={styles.col}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}
          renderItem={({ item }) => (
            <View
              style={[
                styles.card,
                { backgroundColor: color.bg.surface, borderColor: color.border.muted },
              ]}
            >
              {/* Character side. Tappable — the whole side, because the portrait
                  and the name are both what identifies the target. Same
                  module-scope target as every other character surface, so this
                  page does not hold a sheet or a query of its own. */}
              <Pressable
                onPress={() =>
                  openCharacterSheet({
                    id: item.id,
                    name: item.name,
                    image: item.image,
                    role: item.role,
                    animeTitle: title ?? null,
                  })
                }
                accessibilityRole="button"
                accessibilityLabel={`${item.name}, ${roleLabel(item.role)}. Open character details`}
                style={({ pressed }) => [styles.side, { opacity: pressed ? 0.7 : 1 }]}
              >
                <View style={[styles.portrait, { backgroundColor: color.bg.elevated }]}>
                  {item.image ? (
                    <Image
                      source={{ uri: item.image }}
                      style={StyleSheet.absoluteFill}
                      contentFit="cover"
                      transition={150}
                      cachePolicy="memory-disk"
                    />
                  ) : null}
                </View>
                <Text style={[styles.name, { color: color.text.primary }]} numberOfLines={2}>
                  {item.name}
                </Text>
                <View
                  style={[
                    styles.roleChip,
                    {
                      backgroundColor: accentChip(item.role) ? color.accent.muted : 'transparent',
                      borderColor: color.border.muted,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.roleText,
                      {
                        color: accentChip(item.role) ? color.text.primary : color.text.muted,
                        fontFamily: accentChip(item.role) ? font.bold : font.medium,
                      },
                    ]}
                  >
                    {roleLabel(item.role)}
                  </Text>
                </View>
              </Pressable>

              {/* The link between the two portraits. */}
              <View style={[styles.link, { backgroundColor: color.border.muted }]} />

              {/* Voice actor side. */}
              <View style={styles.side}>
                {item.vaImage || item.vaName ? (
                  <>
                    <View style={[styles.portrait, styles.portraitVa, { backgroundColor: color.bg.elevated }]}>
                      {item.vaImage ? (
                        <Image
                          source={{ uri: item.vaImage }}
                          style={StyleSheet.absoluteFill}
                          contentFit="cover"
                          transition={150}
                          cachePolicy="memory-disk"
                        />
                      ) : (
                        <AppIcon name="user" size={20} color={color.text.muted} />
                      )}
                    </View>
                    <Text style={[styles.name, { color: color.text.secondary }]} numberOfLines={2}>
                      {item.vaName}
                    </Text>
                    <Text style={[styles.lang, { color: color.text.muted }]} numberOfLines={1}>
                      {item.language}
                    </Text>
                  </>
                ) : (
                  <View style={styles.noVa}>
                    <AppIcon name="user" size={18} color={color.text.muted} />
                    <Text style={[styles.lang, { color: color.text.muted }]}>No VA listed</Text>
                  </View>
                )}
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: {
    width: 36,
    height: 36,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: { flex: 1 },
  headerTitle: { fontSize: 17, lineHeight: 22, fontFamily: font.bold },
  headerSub: { fontSize: 12, lineHeight: 15, fontFamily: font.medium, marginTop: 1 },
  errorText: { fontFamily: font.regular, fontSize: 14, textAlign: 'center' },
  errorBtn: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.full,
  },

  col: { gap: spacing.md, marginBottom: spacing.md },
  card: {
    flex: 1,
    flexDirection: 'row',
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
    overflow: 'hidden',
  },
  side: {
    flex: 1,
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.xs,
  },
  portrait: {
    width: 56,
    height: 56,
    borderRadius: radii.full,
    overflow: 'hidden',
  },
  portraitVa: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    fontSize: 12,
    lineHeight: 15,
    fontFamily: font.semibold,
    textAlign: 'center',
  },
  roleChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  roleText: {
    fontSize: 9.5,
    lineHeight: 12,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  lang: {
    fontSize: 10,
    lineHeight: 13,
    fontFamily: font.medium,
    textAlign: 'center',
  },
  link: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    marginVertical: spacing.sm,
  },
  noVa: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
});
