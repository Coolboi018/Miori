import { useCallback, useEffect, useState } from 'react';
import { font } from '@/lib/ui/tokens';
import {
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { openAnime } from '@/lib/nav/pushOnce';
import { fetchByGenre, mediaTitle, type MediaItem } from '@/lib/anilist';
import { updateBrowsing } from '@/lib/presence/discord';
import { prefetchAnime } from '@/lib/query/prefetch';
import { NavBar } from '@/components/nav/NavBar';
import { GridSkeleton } from '@/components/anime/GridSkeleton';
import { useTabBarClearance } from '@/lib/ui/tabBar';

export default function GenreScreen() {

  const params = useLocalSearchParams<{ genre: string }>();
  const tabBarSpace = useTabBarClearance();
  const { width: screenW } = useWindowDimensions();
  const genre = params.genre;

  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(true);

  const openMedia = useCallback(
    (m: MediaItem) => {
      // Same tap-warms-the-payload the tabs do — the request the next screen
      // was going to make, started a frame earlier.
      prefetchAnime(m.id);
      openAnime(m.id);
    },
    []
  );

  const load = useCallback(
    async (pageNum: number, isRefresh = false) => {
      try {
        if (isRefresh) {
          setPage(1);
          setHasNextPage(true);
        }
        const res = await fetchByGenre(genre, pageNum, 24);
        if (isRefresh || pageNum === 1) {
          setItems(res.media);
        } else {
          setItems((prev) => [...prev, ...res.media]);
        }
        setHasNextPage(res.hasNextPage);
        if (!isRefresh) setPage(pageNum);
      } catch {
        // Error handled by empty state
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [genre]
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(1, true);
  }, [load]);

  const onEndReached = useCallback(() => {
    if (!loading && !refreshing && hasNextPage) {
      load(page + 1);
    }
  }, [loading, refreshing, hasNextPage, page, load]);

  useEffect(() => {
    load(1);
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      updateBrowsing(`Genre: ${genre}`);
    }, [genre])
  );

  if (loading && items.length === 0) {
    // The grid at its real geometry, not a spinner — same policy as home and
    // the detail screen. The NavBar is part of the loading state so the
    // chrome does not jump when the tiles land.
    return (
      <View style={styles.container}>
        <NavBar title={genre} />
        <GridSkeleton columns={3} screenW={screenW} tileStyle="clean" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <NavBar title={genre} />
      <FlatList
        data={items}
        keyExtractor={(m) => String(m.id)}
        numColumns={3}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.grid, { paddingBottom: tabBarSpace }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />
        }
        onEndReached={onEndReached}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No anime found for {genre}</Text>
            </View>
          ) : undefined
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.card}
            onPress={() => openMedia(item)}
          >
            <Image
              source={{ uri: item.coverImage.large ?? item.coverImage.extraLarge }}
              style={styles.cover}
              resizeMode="cover"
            />
            <Text style={styles.title} numberOfLines={2}>
              {mediaTitle(item.title)}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b10' },
  grid: { paddingHorizontal: 8, paddingTop: 8, paddingBottom: 24 },
  card: { flex: 1 / 3, margin: 4, maxWidth: '33%' },
  cover: { width: '100%', aspectRatio: 2 / 3, borderRadius: 8, backgroundColor: '#1a1a22' },
  title: { color: '#eee', fontFamily: font.regular, fontSize: 11, marginTop: 4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { color: '#666', fontSize: 14, fontFamily: font.regular, textAlign: 'center' },
});