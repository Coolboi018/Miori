// The centred "update available" card.
//
// One host for the whole app, mounted next to the other app-wide overlays in
// `app/_layout.tsx`, so the launch check and the Settings row open the SAME
// card. A Modal because it has to survive a screen change underneath: the
// launch check fires while the user may already be pushing into a detail page.
//
// Three exits, all deliberate:
//   - Download & install → fetches the APK and opens Android's installer;
//   - Skip <version>     → persisted; this release never asks again;
//   - Later / backdrop   → this launch only.

import { useMemo } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '@/lib/ui/useTheme';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { AppIcon } from '@/components/ui/AppIcon';
import {
  dismissUpdatePrompt,
  installUpdate,
  installedVersion,
  skipCurrentRelease,
} from '@/lib/updates/store';
import { useUpdateState } from '@/lib/updates/useUpdate';

/**
 * How tall the notes box may get before it scrolls.
 *
 * A number rather than a percentage because it is the CARD's design: roughly
 * ten lines of body text, enough to read a changelog's shape without pushing
 * the buttons toward the screen edge. Past this the release body scrolls inside
 * the box — and on a short screen the box gives height back first.
 */
const NOTES_PREVIEW_MAX_H = 220;

/** Bytes → "42 MB". Null when the release did not report a size. */
function formatSize(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function UpdatePrompt() {
  const { color } = useTheme();
  const state = useUpdateState();
  const release = state.release;
  const notes = useMemo(() => release?.notes ?? '', [release]);

  if (!release) return null;

  const downloading = state.install === 'downloading';
  const percent = Math.round(Math.min(1, Math.max(0, state.progress)) * 100);
  const size = formatSize(release.apk?.size ?? null);
  const installLabel = downloading
    ? `Downloading ${percent}%`
    : !release.apk
      ? 'Open release page'
      : Platform.OS === 'android'
        ? 'Download & install'
        : 'Open release page';

  return (
    <Modal
      visible={state.open}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={dismissUpdatePrompt}
    >
      <View style={[styles.backdrop, { backgroundColor: color.bg.overlay }]}>
        <View style={[styles.card, { backgroundColor: color.bg.surface }]}>
          <Pressable
            onPress={dismissUpdatePrompt}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close update prompt"
            style={styles.close}
          >
            <AppIcon name="close" size={18} color={color.text.muted} />
          </Pressable>

          <View style={[styles.pill, { backgroundColor: color.accent.muted }]}>
            <Text style={[styles.pillText, { color: color.text.primary }]}>
              UPDATE AVAILABLE
            </Text>
          </View>

          <Text style={[styles.title, { color: color.text.primary }]}>Miori {release.version}</Text>
          <Text style={[styles.sub, { color: color.text.muted }]}>
            You are on {installedVersion()}
            {size ? ` · ${size}` : ''}
          </Text>

          {/* A release body is arbitrary length, so the notes are the ONE
              flexible part of this card: capped at NOTES_PREVIEW_MAX_H so a short
              changelog does not float in empty space, shrinking (`flexShrink`) when
              the screen itself is short (the player is landscape), and scrolling
              inside that box. The title, buttons and progress bar never move —
              the exits are always on screen, which is the whole protection. */}
          {notes ? (
            <ScrollView
              style={[
                styles.notes,
                // An INSET WELL, not a floating block of text: a hairline outline
                // plus the page colour behind it is what tells the eye "this area
                // scrolls" before anything moves. Themed inline because a raw grey
                // would be wrong in light mode.
                { borderColor: color.border.strong, backgroundColor: color.bg.primary },
              ]}
              contentContainerStyle={styles.notesBody}
              showsVerticalScrollIndicator
              nestedScrollEnabled
            >
              <Text style={[styles.notesText, { color: color.text.secondary }]}>{notes}</Text>
            </ScrollView>
          ) : null}

          {downloading ? (
            <View style={styles.progressWrap}>
              <View style={[styles.progressTrack, { backgroundColor: color.bg.elevated }]}>
                <View
                  style={[styles.progressFill, { backgroundColor: color.accent.base, width: `${percent}%` }]}
                />
              </View>
              <Text style={[styles.progressText, { color: color.text.muted }]}>
                Keep the app open while it downloads.
              </Text>
            </View>
          ) : null}

          {state.installError ? (
            <Text style={[styles.error, { color: color.status.danger }]}>{state.installError}</Text>
          ) : null}

          <Pressable
            onPress={() => void installUpdate()}
            disabled={downloading}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.primary,
              {
                backgroundColor: color.accent.base,
                opacity: downloading ? 0.6 : pressed ? 0.85 : 1,
              },
            ]}
          >
            {downloading ? (
              <ActivityIndicator size="small" color={color.bg.primary} />
            ) : null}
            <Text style={[styles.primaryText, { color: color.bg.primary }]}>{installLabel}</Text>
          </Pressable>

          {/* Two REAL buttons, not text links. They are the exits from a card
              whose whole purpose is one action, so they sit side by side, equal
              width, outlined — a tap target you can see without hunting for it. */}
          <View style={styles.secondaryRow}>
            <Pressable
              onPress={skipCurrentRelease}
              disabled={downloading}
              accessibilityRole="button"
              accessibilityLabel={`Skip version ${release.version}`}
              style={({ pressed }) => [
                styles.secondaryBtn,
                {
                  borderColor: color.border.strong,
                  backgroundColor: color.bg.elevated,
                  opacity: downloading ? 0.45 : pressed ? 0.65 : 1,
                },
              ]}
            >
              <Text style={[styles.secondaryText, { color: color.text.secondary }]}>
                Skip {release.version}
              </Text>
            </Pressable>
            <Pressable
              onPress={dismissUpdatePrompt}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.secondaryBtn,
                {
                  borderColor: color.border.strong,
                  backgroundColor: color.bg.elevated,
                  opacity: pressed ? 0.65 : 1,
                },
              ]}
            >
              <Text style={[styles.secondaryText, { color: color.text.primary }]}>Later</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: radii.xl,
    padding: spacing.xl,
    gap: spacing.sm,
    // The card never outgrows the screen, and clips the scrolled notes to its
    // own rounded corners (without this a long changelog paints square corners
    // over the radius while scrolling).
    maxHeight: '100%',
    overflow: 'hidden',
  },
  close: { position: 'absolute', top: spacing.md, right: spacing.md, zIndex: 1, padding: spacing.xs },
  pill: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radii.full,
    marginTop: spacing.sm,
  },
  pillText: { fontSize: 10, fontFamily: font.bold, letterSpacing: 1 },
  title: { fontSize: 22, fontFamily: font.bold, marginTop: spacing.xs },
  sub: { fontSize: 13, fontFamily: font.regular, marginBottom: spacing.xs },
  notes: {
    maxHeight: NOTES_PREVIEW_MAX_H,
    flexShrink: 1,
    borderWidth: 1,
    borderRadius: radii.md,
  },
  notesBody: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  notesText: { fontSize: 13, lineHeight: 20, fontFamily: font.regular },
  progressWrap: { gap: spacing.xs, marginTop: spacing.xs },
  progressTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: 4, borderRadius: 2 },
  progressText: { fontSize: 11, fontFamily: font.regular },
  error: { fontSize: 12, fontFamily: font.regular, lineHeight: 17 },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radii.lg,
    marginTop: spacing.sm,
  },
  primaryText: { fontSize: 15, fontFamily: font.semibold },
  secondaryRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xxs },
  secondaryBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { fontSize: 13, fontFamily: font.semibold },
});
