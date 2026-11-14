// Shared settings detail wrapper: back chevron + title + grouped sections.
// Lives outside app/ so it never becomes a route.

import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/ui/useTheme';
import { font, spacing } from '@/lib/ui/tokens';
import { AppIcon } from '@/components/ui/AppIcon';

export function SettingsPage({ title, children }: { title: string; children: ReactNode }) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View style={[styles.container, { backgroundColor: color.bg.primary }]}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back to settings"
          hitSlop={10}
          style={styles.backHit}
        >
          <AppIcon name="back" size={22} color={color.accent.base} />
        </Pressable>
        <Text style={[styles.title, { color: color.text.primary }]}>{title}</Text>
        <View style={styles.backSpacer} />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.giant }}>
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  backHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backSpacer: { width: 44 },
  title: { flex: 1, fontSize: 17, fontFamily: font.semibold, textAlign: 'center' },
});
