// Developer — who made this, where it lives, and how to add sources.
//
// Last screen in Settings, and the only one written as prose rather than rows:
// nobody changes a preference here, they read it once. It still goes through
// `SettingsPage` so the back chevron, title and safe-area padding are identical
// to every other detail page.
//
// All three URLs are derived from the two handles below. A rename is one edit
// here, not a find-and-replace across the app — and the avatar is GitHub's own
// stable avatar path for the account, so it never goes stale like a copied CDN
// link would.

import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as WebBrowser from 'expo-web-browser';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { AppIcon, type AppIconName } from '@/components/ui/AppIcon';
import { RoundedPressable } from '@/components/ui/RoundedPressable';
import { alpha } from '@/lib/ui/color';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { useTheme } from '@/lib/ui/useTheme';

const HANDLE = 'Coolboi018';
const PROFILE_URL = `https://github.com/${HANDLE}`;
const EXTENSIONS_REPO = 'Miori-Extensions';
const EXTENSIONS_URL = `${PROFILE_URL}/${EXTENSIONS_REPO}`;
const ISSUES_URL = `${EXTENSIONS_URL}/issues`;
/** GitHub redirects this to the account's current avatar; `size` is the CDN's own resize. */
const AVATAR_URL = `${PROFILE_URL}.png?size=240`;

/** Out of the app and into the browser — the in-app WebView is for logins, not reading. */
function openLink(url: string) {
  void WebBrowser.openBrowserAsync(url);
}

const STEPS = [
  'Open the repository below and copy its link.',
  'In Miori: Settings → Extensions → Sources.',
  'Paste the link, tap Add, then Check for updates.',
  'Install the sources you want — the player picks them up on the next episode.',
];

const STACK = ['Expo SDK 58', 'React Native 0.88', 'TypeScript', 'expo-video', 'Reanimated 4', 'AniList GraphQL'];

export default function DeveloperSettings() {
  const { color } = useTheme();
  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <SettingsPage title="Developer">
      {/* Hero — the one saturated surface in Settings, and it is a gradient
          built from the theme's own accent (not a hardcoded purple), so it
          still reads as Miori in light and OLED. */}
      <View style={styles.heroWrap}>
        <LinearGradient
          colors={[alpha(color.accent.base, 0.16), alpha(color.accent.base, 0.02)]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.hero, { borderColor: color.border.muted }]}
        >
          <View style={[styles.avatarRing, { borderColor: alpha(color.accent.base, 0.22) }]}>
            <Image
              source={{ uri: AVATAR_URL }}
              style={styles.avatar}
              contentFit="cover"
              cachePolicy="memory-disk"
              accessibilityIgnoresInvertColors
            />
          </View>

          <Text style={[styles.name, { color: color.text.primary }]}>Ishu</Text>
          <Text style={[styles.handle, { color: color.text.secondary }]}>@{HANDLE}</Text>

          <View style={[styles.badge, { backgroundColor: color.accent.muted }]}>
            <AppIcon name="sparkles" size={13} color={color.text.primary} />
            <Text style={[styles.badgeText, { color: color.text.primary }]}>vibe coded</Text>
          </View>

          <Text style={[styles.tagline, { color: color.text.muted }]}>
            One person, one phone, no server. Every screen in this app was argued with on a real
            device until it behaved.
          </Text>

          <View style={styles.heroButtons}>
            <LinkButton label="GitHub profile" icon="account" primary onPress={() => openLink(PROFILE_URL)} />
            <LinkButton label="Extensions" icon="database" onPress={() => openLink(EXTENSIONS_URL)} />
          </View>
        </LinearGradient>
      </View>

      <Card>
        <CardTitle icon="info" text="What Miori is" />
        <Text style={[styles.body, { color: color.text.secondary }]}>
          An anime tracker and player for one person’s phone. It reads your AniList list, plays
          episodes straight from community sources through installable extensions, and keeps the
          rest out of the way: no ads, no analytics, no account on anybody’s server.
        </Text>
        <Text style={[styles.body, { color: color.text.muted }]}>
          Miori ships no video of its own. Streams come from the sources you install, and your
          phone talks to them directly.
        </Text>
      </Card>

      <Card>
        <CardTitle icon="database" text="Add the extension repo" />
        <Row onPress={() => openLink(EXTENSIONS_URL)}>
          <Text style={[styles.mono, { color: color.text.primary }]} numberOfLines={1}>
            {EXTENSIONS_REPO}
          </Text>
          <AppIcon name="external" size={15} color={color.text.muted} />
        </Row>

        <View style={styles.steps}>
          {STEPS.map((step, i) => (
            <View key={step} style={styles.step}>
              <View style={[styles.stepNum, { backgroundColor: color.accent.muted }]}>
                <Text style={[styles.stepNumText, { color: color.text.primary }]}>{i + 1}</Text>
              </View>
              <Text style={[styles.stepText, { color: color.text.secondary }]}>{step}</Text>
            </View>
          ))}
        </View>

        <Text style={[styles.body, { color: color.text.muted }]}>
          A repo is a set of JSON manifests plus the shared toolbox, so a new source is a pull
          request — not a new app build. Miori validates a repo before it installs anything from it.
        </Text>

        <Row onPress={() => openLink(ISSUES_URL)}>
          <Text style={[styles.rowText, { color: color.accent.base }]}>
            Broken source? Open an issue
          </Text>
          <AppIcon name="external" size={15} color={color.text.muted} />
        </Row>
      </Card>

      <Card>
        <CardTitle icon="sparkles" text="How it was made" />
        <Text style={[styles.body, { color: color.text.secondary }]}>
          Miori is vibe coded: built in conversation with an AI, one screen at a time, then tested
          on the actual phone. No team, no design handoff, no sprint board — an idea, a build, and
          “that feels wrong” until it didn’t.
        </Text>
        <Text style={[styles.body, { color: color.text.muted }]}>
          The part worth knowing: nothing shipped on “looks fine”. The player chrome, the subtitle
          band, the extension loader and the foreground refresh were each rebuilt after a real
          verdict from the device. If you find a rough edge, it’s mine — not the model’s.
        </Text>

        <View style={styles.chips}>
          {STACK.map((chip) => (
            <View key={chip} style={[styles.chip, { backgroundColor: color.bg.elevated }]}>
              <Text style={[styles.chipText, { color: color.text.secondary }]}>{chip}</Text>
            </View>
          ))}
        </View>
      </Card>

      <Card>
        <CardTitle icon="settings" text="Details" />
        <Detail label="App version" value={version} />
        <Detail label="Expo SDK" value="58" />
        <Detail label="Platforms" value="Android-first · iOS builds" />
        <Detail label="Made by" value="Ishu (@Coolboi018)" />
        <Detail label="Source repos" value="Extensions are public · app repo soon" last />
      </Card>

      <Text style={[styles.footer, { color: color.text.muted }]}>
        Built by Ishu · 2026{'\n'}Miori is Japanese for “beautiful”.
      </Text>
    </SettingsPage>
  );
}

// --- local pieces -----------------------------------------------------------

function Card({ children }: { children: ReactNode }) {
  const { color } = useTheme();
  return <View style={[styles.card, { backgroundColor: color.bg.surface }]}>{children}</View>;
}

function CardTitle({ icon, text }: { icon: AppIconName; text: string }) {
  const { color } = useTheme();
  return (
    <View style={styles.cardHead}>
      <AppIcon name={icon} size={15} color={color.text.muted} />
      <Text style={[styles.cardTitle, { color: color.text.muted }]}>{text.toUpperCase()}</Text>
    </View>
  );
}

function Row({ children, onPress }: { children: ReactNode; onPress: () => void }) {
  const { color } = useTheme();
  return (
    <RoundedPressable
      onPress={onPress}
      radius={radii.md}
      tint={alpha(color.accent.base, 0.1)}
      style={[styles.row, { backgroundColor: color.bg.elevated }]}
    >
      {children}
    </RoundedPressable>
  );
}

function Detail({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const { color } = useTheme();
  return (
    <View
      style={[
        styles.detail,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border.muted },
      ]}
    >
      <Text style={[styles.detailLabel, { color: color.text.secondary }]}>{label}</Text>
      <Text style={[styles.detailValue, { color: color.text.primary }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function LinkButton({
  label,
  icon,
  primary,
  onPress,
}: {
  label: string;
  icon: AppIconName;
  primary?: boolean;
  onPress: () => void;
}) {
  const { color } = useTheme();
  const bg = primary ? color.accent.base : color.accent.muted;
  const fg = primary ? color.bg.primary : color.text.primary;
  return (
    <RoundedPressable
      onPress={onPress}
      radius={radii.full}
      tint={primary ? '#ffffff55' : alpha(color.accent.base, 0.14)}
      style={[styles.linkButton, { backgroundColor: bg }]}
      accessibilityLabel={label}
    >
      <AppIcon name={icon} size={15} color={fg} />
      <Text style={[styles.linkButtonText, { color: fg }]}>{label}</Text>
    </RoundedPressable>
  );
}

const styles = StyleSheet.create({
  heroWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  hero: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.lg,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  avatarRing: {
    width: 92,
    height: 92,
    borderRadius: 46,
    borderWidth: 2,
    padding: 3,
  },
  avatar: { width: '100%', height: '100%', borderRadius: 46, backgroundColor: '#222' },
  name: { fontSize: 24, lineHeight: 30, fontFamily: font.bold, marginTop: spacing.md },
  handle: { fontSize: 14, lineHeight: 20, fontFamily: font.medium, marginTop: 1 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radii.full,
    marginTop: spacing.md,
  },
  badgeText: { fontSize: 12, lineHeight: 15, fontFamily: font.semibold, letterSpacing: 0.2 },
  tagline: {
    fontSize: 12,
    lineHeight: 17,
    fontFamily: font.regular,
    textAlign: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  heroButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
  },
  linkButtonText: { fontSize: 13, lineHeight: 17, fontFamily: font.semibold },

  card: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.sm },
  cardTitle: { fontSize: 11, lineHeight: 14, fontFamily: font.bold, letterSpacing: 1.1 },
  body: { fontSize: 13, lineHeight: 19, fontFamily: font.regular, marginBottom: spacing.sm },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
  },
  rowText: { fontSize: 13, lineHeight: 18, fontFamily: font.semibold },
  mono: { flex: 1, fontSize: 13, lineHeight: 18, fontFamily: font.mono },

  steps: { marginBottom: spacing.sm },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: spacing.sm },
  stepNum: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumText: { fontSize: 11, lineHeight: 14, fontFamily: font.bold },
  stepText: { flex: 1, fontSize: 13, lineHeight: 19, fontFamily: font.regular },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.xs },
  chip: { paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: radii.full },
  chipText: { fontSize: 11, lineHeight: 14, fontFamily: font.medium },

  detail: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 9 },
  detailLabel: { fontSize: 13, lineHeight: 18, fontFamily: font.regular },
  detailValue: { flexShrink: 1, fontSize: 13, lineHeight: 18, fontFamily: font.medium, textAlign: 'right' },

  footer: {
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 17,
    fontFamily: font.regular,
    marginTop: spacing.xxl,
    paddingHorizontal: spacing.lg,
  },
});
