// The app's root error boundary.
//
// Expo Router renders the `ErrorBoundary` export of a layout INSTEAD of that
// layout when a child throws during render. The default export it re-exported
// was the library's dev screen: a stack trace, and (in a production build) a
// message with no route out. On a phone, where this app has a hidden header on
// several routes and no browser chrome, that is a dead end — the same failure
// shape the player's error card was rebuilt to avoid.
//
// Two exits, and they are genuinely different:
//   - Try again re-mounts the failed subtree. Right for a transient render or
//     a bad value from a fetch.
//   - Go home replaces the route with the tab root. Right when the failing
//     SCREEN is the problem, because retrying a deterministic throw loops.
//
// The raw message is shown only in development. In release it is the one line
// a support report needs, but it is also the line most likely to contain
// internals, and the user's action ("try again" or "go home") does not change
// based on it.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, type ErrorBoundaryProps } from 'expo-router';
import { AppIcon } from './AppIcon';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii } from '@/lib/ui/tokens';

export function RootErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const { color } = useTheme();
  const [busy, setBusy] = useState(false);

  const onRetry = () => {
    if (busy) return;
    setBusy(true);
    void Promise.resolve()
      .then(() => retry())
      .catch(() => {
        /* the boundary stays up; retry may throw the same error again */
      })
      .finally(() => setBusy(false));
  };

  const onHome = () => {
    try {
      router.replace('/(tabs)');
    } catch {
      // The navigator may not exist if the root layout itself failed. Retry is
      // still available; nothing useful is gained by throwing from here.
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: color.bg.primary }]}>
      <View style={styles.card}>
        <AppIcon name="alert" size={34} color={color.status.danger} strokeWidth={2} />
        <Text style={[styles.title, { color: color.text.primary }]}>
          Something went wrong
        </Text>
        <Text style={[styles.body, { color: color.text.muted }]}>
          Miori hit an unexpected error. Your watch progress and settings are safe.
        </Text>
        {__DEV__ ? (
          <Text style={[styles.detail, { color: color.text.muted }]} numberOfLines={5}>
            {error?.message || String(error)}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Pressable
            onPress={onRetry}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Try again"
            style={({ pressed }) => [
              styles.btn,
              { backgroundColor: color.bg.elevated },
              pressed || busy ? styles.pressed : null,
            ]}
          >
            <Text style={[styles.btnText, { color: color.text.primary }]}>
              {busy ? 'Trying…' : 'Try again'}
            </Text>
          </Pressable>
          <Pressable
            onPress={onHome}
            accessibilityRole="button"
            accessibilityLabel="Go home"
            style={({ pressed }) => [
              styles.btn,
              styles.ghost,
              pressed ? styles.pressed : null,
            ]}
          >
            <Text style={[styles.btnText, { color: color.text.muted }]}>Go home</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  card: {
    alignItems: 'center',
    gap: 10,
    maxWidth: 380,
  },
  title: {
    fontFamily: font.bold,
    fontSize: 19,
    textAlign: 'center',
  },
  body: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  detail: {
    fontFamily: font.mono,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    opacity: 0.8,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  btn: {
    minHeight: 42,
    paddingHorizontal: 20,
    justifyContent: 'center',
    borderRadius: radii.full,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
  btnText: {
    fontFamily: font.semibold,
    fontSize: 14,
  },
  pressed: {
    opacity: 0.65,
  },
});
