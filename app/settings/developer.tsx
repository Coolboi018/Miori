// Developer — who made this, where it lives, and how to add sources.
//
// Last screen in Settings, and the only one written as prose rather than rows:
// nobody changes a preference here, they read it once. It still goes through
// `SettingsPage` so the back chevron, title and safe-area padding are identical
// to every other detail page.
//
// All three link URLs are derived from the handle below. A rename is one edit
// here, not a find-and-replace across the app — and the avatar is deliberately
// NOT derived from it, so a rename cannot break the picture (see `AVATAR_URL`).
//
// ═══════════════════════════════════════════════════════════════════════════
// THE ENTRANCE IS A RISE, NEVER A FADE — AND THAT IS NOT A STYLE CHOICE
// ═══════════════════════════════════════════════════════════════════════════
//
// Every block on this page rises 14px into place, staggered down the page, using
// the same shape as `app/anime/[id].tsx`'s `rowEntering` — and for the reason
// recorded there: a `FadeInDown` starts at opacity 0, and when that animation
// did not fire the list was left invisible-but-present. `opacity: 1` is in
// `initialValues` here, so the WORST case for a missed animation is a page that
// sits 14px low. A missed fade would be a page that is gone.
//
// Reduce motion gets no entering builder at all — the page is simply there. That
// is not a rare branch: `useReducedMotion()` is true whenever Android's animator
// duration scale is 0, which is BATTERY SAVER, not just the accessibility toggle
// (see `components/AnimatedSplash.tsx`). So on a low-end phone this page is
// static by design, and the layout has to carry it alone. It does — nothing here
// is decoration-only.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT CHANGED FROM THE FIRST VERSION, AND WHY
// ═══════════════════════════════════════════════════════════════════════════
//
//   - THE BUTTON ROW COULD NOT FIT. Three pills, each with an icon, a label and
//     `spacing.lg` of horizontal padding, needed ~360dp of text alone. They are
//     now one full-width primary and a two-up row beneath it, which is both
//     narrower and a real hierarchy instead of three equal shouts.
//   - THE AVATAR GOT A GRADIENT RING AND THE CARD A HAIRLINE. On OLED the card
//     is #0a0a0a on #000000, so an unbordered card's edge is invisible; the
//     hairline is what makes it a card rather than a paragraph.
//   - THE STEPS GOT A CONNECTOR. Four numbered circles in a column read as a
//     list; a line through them reads as a sequence, which is what a setup
//     walkthrough is.
//   - THE HERO GOT A STAT STRIP. It repeats nothing (the old Details card
//     listed the same version and SDK as plain rows) — see `Details` below,
//     which now carries only what the strip does not.

import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as WebBrowser from 'expo-web-browser';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useReducedMotion,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
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
const MAIN_REPO = 'Miori';
const MAIN_URL = `${PROFILE_URL}/${MAIN_REPO}`;
const ISSUES_URL = `${EXTENSIONS_URL}/issues`;
/**
 * The account's avatar, by immutable user id rather than by handle, so a rename
 * cannot break it. Pinned to the URL as given, deliberately: this is the one
 * asset on the page that comes from off the device, and the CDN serves it
 * cache-first, so the picture is whatever GitHub last published — which is the
 * point. (The endpoint also accepts `&s=<px>` if the 460px default ever needs
 * shrinking for a 104dp ring.)
 *
 * FIXED, NOT FOLLOWED. This was briefly a once-a-day API check that rolled the
 * image's cache key; it was dropped again on request because the owner is not
 * changing the picture, and a fixed URL means no request, no cache-key dance and
 * no day of latency. The trade is real and worth knowing: change the pfp now and
 * the app keeps drawing the old one until a new build ships with a new URL here.
 */
const AVATAR_URL = 'https://avatars.githubusercontent.com/u/211121102?v=4';

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

/**
 * Staggered rise. `withDelay` is capped at `MAX_STAGGER` so the last block on a
 * long page never trails the first by more than a beat — the stagger is there
 * to make the page read top-to-bottom, not to make the reader wait for it.
 */
const STAGGER_MS = 45;
const MAX_STAGGER = 8;

const rise = (index: number) => (values: any) => {
  'worklet';
  const delay = Math.min(index, MAX_STAGGER) * STAGGER_MS;
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 14 }] },
    animations: {
      opacity: withTiming(1, { duration: 200 }),
      transform: [
        {
          translateY: withDelay(
            delay,
            withTiming(0, { duration: 280, easing: Easing.out(Easing.cubic) })
          ),
        },
      ],
    },
  };
};

/** One staggered block. `index` is its position down the page. */
function Rise({ index, children }: { index: number; children: ReactNode }) {
  const reduced = useReducedMotion();
  return <Animated.View entering={reduced ? undefined : rise(index)}>{children}</Animated.View>;
}

export default function DeveloperSettings() {
  const { color } = useTheme();
  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <SettingsPage title="Developer">
      <Rise index={0}>
        {/* Hero — the one saturated surface in Settings, and it is a gradient
            built from the theme's own accent (not a hardcoded purple), so it
            still reads as Miori in light and OLED. The second stop goes to
            fully transparent rather than to a low alpha, so the wash thins out
            toward the bottom-right instead of ending on a visible seam. */}
        <View style={styles.heroWrap}>
          <LinearGradient
            colors={[alpha(color.accent.base, 0.17), alpha(color.accent.base, 0.02), 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 0.85, y: 1 }}
            style={[styles.hero, { borderColor: color.border.muted }]}
          >
            <LinearGradient
              colors={[alpha(color.accent.base, 0.5), alpha(color.accent.base, 0.06)]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.avatarRing}
            >
              <Image
                source={{ uri: AVATAR_URL }}
                style={[styles.avatar, { backgroundColor: color.bg.elevated }]}
                contentFit="cover"
                cachePolicy="memory-disk"
                transition={200}
                accessibilityIgnoresInvertColors
              />
            </LinearGradient>

            <Text style={[styles.name, { color: color.text.primary }]}>Ishu</Text>
            <Text style={[styles.handle, { color: color.text.secondary }]}>@{HANDLE}</Text>

            <View style={[styles.badge, { backgroundColor: color.accent.muted }]}>
              <AppIcon name="sparkles" size={13} color={color.text.primary} />
              <Text style={[styles.badgeText, { color: color.text.primary }]}>Miori</Text>
            </View>

            <Text style={[styles.tagline, { color: color.text.muted }]}>
              One person, one phone, no server. Every screen in this app was argued with on a real
              device until it behaved.
            </Text>

            <View style={styles.heroButtons}>
              <LinkButton
                label="GitHub profile"
                icon="account"
                primary
                onPress={() => openLink(PROFILE_URL)}
              />
              <View style={styles.buttonRow}>
                <LinkButton label="App repo" icon="external" onPress={() => openLink(MAIN_URL)} grow />
                <LinkButton label="Extensions" icon="database" onPress={() => openLink(EXTENSIONS_URL)} grow />
              </View>
            </View>

            {/* Vitals, not a repeat of the Details card below: the strip is what
                you see without scrolling, the card is what is left over. */}
            <View style={[styles.stats, { borderTopColor: color.border.muted }]}>
              <Stat value="58" label="Expo SDK" />
              <Stat value="Android" label="Platform" divider />
              <Stat value={`v${version}`} label="Version" divider />
            </View>
          </LinearGradient>
        </View>
      </Rise>

      <Rise index={1}>
        <Card>
          <CardTitle icon="info" text="What Miori is" />
          <Text style={[styles.body, { color: color.text.secondary }]}>
            An anime tracker and player for one person’s phone. It reads your AniList list, plays
            episodes straight from community sources through installable extensions, and keeps the
            rest out of the way: no ads, no analytics, no account on anybody’s server.
          </Text>
          <Text style={[styles.body, styles.bodyLast, { color: color.text.muted }]}>
            Miori ships no video of its own. Streams come from the sources you install, and your
            phone talks to them directly.
          </Text>
        </Card>
      </Rise>

      <Rise index={2}>
        <Card>
          <CardTitle icon="database" text="Add the extension repo" />
          <Row onPress={() => openLink(EXTENSIONS_URL)}>
            <Text style={[styles.mono, { color: color.text.primary }]} numberOfLines={1}>
              {EXTENSIONS_REPO}
            </Text>
            <AppIcon name="external" size={15} color={color.text.muted} />
          </Row>

          <View style={styles.steps}>
            {STEPS.map((step, i) => {
              const last = i === STEPS.length - 1;
              return (
                <View key={step} style={styles.step}>
                  <View style={styles.stepGutter}>
                    <View style={[styles.stepNum, { backgroundColor: color.accent.muted }]}>
                      <Text style={[styles.stepNumText, { color: color.text.primary }]}>{i + 1}</Text>
                    </View>
                    {/* The connector. Same gutter, so it lands dead-centre under
                        every circle; `flex: 1` means its length is whatever the
                        step's text needs, with no measuring. */}
                    {!last && <View style={[styles.stepLine, { backgroundColor: color.border.muted }]} />}
                  </View>
                  <Text
                    style={[
                      styles.stepText,
                      !last && styles.stepTextGap,
                      { color: color.text.secondary },
                    ]}
                  >
                    {step}
                  </Text>
                </View>
              );
            })}
          </View>

          <Text style={[styles.body, styles.bodyLast, { color: color.text.muted }]}>
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
      </Rise>

      <Rise index={3}>
        <Card>
          <CardTitle icon="sparkles" text="How it was made" />
          <Text style={[styles.body, { color: color.text.secondary }]}>
            Miori is vibe coded: built in conversation with an AI, one screen at a time, then tested
            on the actual phone. No team, no design handoff, no sprint board — an idea, a build, and
            “that feels wrong” until it didn’t.
          </Text>
          <Text style={[styles.body, styles.bodyLast, { color: color.text.muted }]}>
            The part worth knowing: nothing shipped on “looks fine”. The player chrome, the subtitle
            band, the extension loader and the foreground refresh were each rebuilt after a real
            verdict from the device. If you find a rough edge, it’s mine — not the model’s.
          </Text>

          <View style={styles.chips}>
            {STACK.map((chip) => (
              <View
                key={chip}
                style={[
                  styles.chip,
                  { backgroundColor: color.bg.elevated, borderColor: color.border.muted },
                ]}
              >
                <Text style={[styles.chipText, { color: color.text.secondary }]}>{chip}</Text>
              </View>
            ))}
          </View>
        </Card>
      </Rise>

      <Rise index={4}>
        <Card>
          <CardTitle icon="settings" text="Details" />
          <Detail label="Made by" value="Ishu (@Coolboi018)" />
          <Detail label="Fonts" value="Montserrat · Space Mono" />
          <Detail label="Source" value="Both repos are public" last />
        </Card>
      </Rise>

      <Rise index={5}>
        <Text style={[styles.footer, { color: color.text.muted }]}>
          Built by Ishu · 2026{'\n'}Miori is Japanese for “beautiful”{'\n'}Open source · Android only
        </Text>
      </Rise>
    </SettingsPage>
  );
}

// --- local pieces -----------------------------------------------------------

function Card({ children }: { children: ReactNode }) {
  const { color } = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: color.bg.surface, borderColor: color.border.muted },
      ]}
    >
      {children}
    </View>
  );
}

/**
 * Section label. The rule is the point: in a card this wide a lone short label
 * floats, and the hairline running out to the edge is what anchors it to the
 * section it names.
 */
function CardTitle({ icon, text }: { icon: AppIconName; text: string }) {
  const { color } = useTheme();
  return (
    <View style={styles.cardHead}>
      <AppIcon name={icon} size={15} color={color.text.muted} />
      <Text style={[styles.cardTitle, { color: color.text.muted }]}>{text.toUpperCase()}</Text>
      <View style={[styles.cardRule, { backgroundColor: color.border.muted }]} />
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

function Stat({ value, label, divider }: { value: string; label: string; divider?: boolean }) {
  const { color } = useTheme();
  return (
    <View
      style={[
        styles.stat,
        divider && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: color.border.muted },
      ]}
    >
      <Text style={[styles.statValue, { color: color.text.primary }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: color.text.muted }]} numberOfLines={1}>
        {label.toUpperCase()}
      </Text>
    </View>
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

/**
 * Two weights, not three. `primary` is the filled plate and `grow` lets a
 * secondary share the row evenly — without it, two buttons of different label
 * lengths end up different widths and the pair reads as broken.
 */
function LinkButton({
  label,
  icon,
  primary,
  grow,
  onPress,
}: {
  label: string;
  icon: AppIconName;
  primary?: boolean;
  grow?: boolean;
  onPress: () => void;
}) {
  const { color } = useTheme();
  const bg = primary ? color.accent.base : color.accent.muted;
  const fg = primary ? color.bg.primary : color.text.primary;
  const style: StyleProp<ViewStyle> = [
    styles.linkButton,
    grow && styles.linkButtonGrow,
    { backgroundColor: bg, borderColor: primary ? 'transparent' : color.border.muted },
  ];
  return (
    <RoundedPressable
      onPress={onPress}
      radius={radii.full}
      tint={primary ? '#ffffff55' : alpha(color.accent.base, 0.14)}
      style={style}
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
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  avatarRing: {
    width: 104,
    height: 104,
    borderRadius: 52,
    padding: 3,
  },
  avatar: { flex: 1, borderRadius: 9999 },
  name: { fontSize: 26, lineHeight: 32, fontFamily: font.bold, letterSpacing: -0.4, marginTop: spacing.lg },
  handle: { fontSize: 13, lineHeight: 18, fontFamily: font.medium, marginTop: 2 },
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
    lineHeight: 18,
    fontFamily: font.regular,
    textAlign: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  heroButtons: { alignSelf: 'stretch', gap: spacing.sm, marginTop: spacing.xl },
  buttonRow: { flexDirection: 'row', gap: spacing.sm },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: 11,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  linkButtonGrow: { flex: 1 },
  linkButtonText: { fontSize: 13, lineHeight: 17, fontFamily: font.semibold },

  stats: { flexDirection: 'row', alignSelf: 'stretch', marginTop: spacing.xl, borderTopWidth: StyleSheet.hairlineWidth },
  stat: { flex: 1, alignItems: 'center', paddingVertical: spacing.md },
  statValue: { fontSize: 15, lineHeight: 20, fontFamily: font.semibold },
  statLabel: { fontSize: 10, lineHeight: 14, fontFamily: font.bold, letterSpacing: 1, marginTop: 1 },

  card: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.md },
  cardTitle: { fontSize: 11, lineHeight: 14, fontFamily: font.bold, letterSpacing: 1.1 },
  cardRule: { flex: 1, height: StyleSheet.hairlineWidth, marginLeft: spacing.xs },
  body: { fontSize: 13, lineHeight: 20, fontFamily: font.regular, marginBottom: spacing.sm },
  bodyLast: { marginBottom: 0 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.lg,
  },
  rowText: { fontSize: 13, lineHeight: 18, fontFamily: font.semibold },
  mono: { flex: 1, fontSize: 13, lineHeight: 18, fontFamily: font.mono },

  steps: { marginBottom: spacing.md },
  step: { flexDirection: 'row', gap: spacing.sm, alignItems: 'stretch' },
  stepGutter: { width: 20, alignItems: 'center' },
  stepNum: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumText: { fontSize: 11, lineHeight: 14, fontFamily: font.bold },
  stepLine: { width: StyleSheet.hairlineWidth, flex: 1, minHeight: 6, marginVertical: 3 },
  stepText: { flex: 1, fontSize: 13, lineHeight: 19, fontFamily: font.regular },
  /** The gap lives on the text, not the row, so the connector above can span it. */
  stepTextGap: { paddingBottom: spacing.md },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.md },
  chip: { paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: radii.full, borderWidth: StyleSheet.hairlineWidth },
  chipText: { fontSize: 11, lineHeight: 14, fontFamily: font.medium },

  detail: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: 10,
  },
  detailLabel: { fontSize: 13, lineHeight: 18, fontFamily: font.regular },
  detailValue: { flexShrink: 1, fontSize: 13, lineHeight: 18, fontFamily: font.medium, textAlign: 'right' },

  footer: {
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 18,
    fontFamily: font.regular,
    marginTop: spacing.xxl,
    paddingHorizontal: spacing.lg,
  },
});
