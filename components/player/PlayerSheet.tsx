// The player's settings drawer — slides in from the RIGHT edge of the video,
// opened by any of the top-bar buttons (quality / speed / source / subtitles).
//
// WHY A SIDE DRAWER AND NOT A CENTERED DIALOG: the point of changing speed or
// switching quality mid-episode is to keep watching while you do it. A card in
// the middle of the frame blocks the action entirely; a drawer anchored to one
// edge covers only ~45% of the video, leaves the frame itself visible (no dim
// scrim), and playback NEVER pauses. Tap the video area outside the drawer to
// dismiss and it slides away.
//
// WHY ONE PANEL: a menu per button is four surfaces to keep in step and four
// places to look wrong; one panel whose CONTENT changes per button keeps every
// option in the same place, animated the same way. Everything renders over the
// video, never below it.
//
// WHY THE OPTION LIST SCROLLS AND NOTHING ELSE DOES. Two independent rules
// hold this up, and on their own NEITHER is enough:
//
//  1. THE DRAWER IS NOT INSIDE A SCROLL VIEW. The watch page scrolls, and a
//     parent ScrollView on Android takes the gesture away before the child ever
//     sees it: `ReactScrollView.onInterceptTouchEvent` runs on the way DOWN from
//     the root and returns true the moment the drag passes touch slop, which
//     cancels the child and scrolls the page instead of the list.
//     `nestedScrollEnabled` does NOT rescue this — RN's ScrollView extends
//     `android.widget.ScrollView`, so the prop is only
//     `ViewCompat.setNestedScrollingEnabled`, and a plain ScrollView is not a
//     nested-scrolling parent, so there is nothing to join. (The androidx
//     NestedScrollView variant that WOULD make it work sits behind
//     `useNestedScrollViewAndroid`, which ships false.) The drawer is therefore
//     mounted as a SIBLING of the page scroll view, in a box the size of the
//     video — see `app/watch/[id]/[ep].tsx`. The useful side effect: with no
//     scrollable ancestor there is also nothing for the list to hand its
//     overscroll to when it hits an end, so it simply stops.
//
//  2. THE LIST MUST SHRINK TO ITS BOX. `listWrap` is `flex: 1` (a definite
//     height), and a React Native ScrollView defaults to `flexShrink: 0`, so it
//     reports its CONTENT height instead, overflows the panel and is clipped by
//     the panel's `overflow: hidden` — the rows past the fold are unreachable
//     with no scrollbar to explain it. `flexShrink: 1` is what makes it a
//     scroller at all; `flexGrow: 0` alongside it keeps a short list short.
//
// Expo-Go-safe: no gesture-handler — the entrance/exit is a Reanimated timing
// animation on translateX + opacity, which the project already ships.

import { useEffect, useMemo, useRef, useState } from 'react';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { font, radii, spacing } from '@/lib/ui/tokens';
import { AppIcon } from '@/components/ui/AppIcon';

export type SheetTab = 'quality' | 'speed' | 'source' | 'subs' | null;

export interface SheetOption {
  key: string;
  label: string;
  /** Right-side annotation, e.g. "(current)" or a resolution hint. */
  hint?: string;
  disabled?: boolean;
}

export interface PlayerSheetProps {
  tab: SheetTab;
  /** Which option is active, by key, per tab. */
  selected: Partial<Record<Exclude<SheetTab, null>, string>>;
  options: Partial<Record<Exclude<SheetTab, null>, SheetOption[]>>;
  onSelect: (tab: Exclude<SheetTab, null>, key: string) => void;
  onClose: () => void;
}

const TITLES: Record<Exclude<SheetTab, null>, string> = {
  quality: 'Quality',
  speed: 'Playback speed',
  source: 'Source',
  subs: 'Subtitles',
};

const SPEEDS = ['0.5', '0.75', '1', '1.25', '1.5', '2'];

/** Slide distance for the exit/enter travel — larger than the panel can ever
 *  be wide so the card fully leaves the frame when progress hits 0. */
const SLIDE = 360;
/** How long the slide-out runs before the panel unmounts. */
const EXIT_MS = 180;

export function PlayerSheet({ tab, selected, options, onSelect, onClose }: PlayerSheetProps) {
  const open = tab !== null;
  const progress = useSharedValue(0);
  // The panel must stay mounted through the exit animation (otherwise you'd
  // never SEE it slide away), so it tracks a latched copy of the last tab.
  const [latched, setLatched] = useState<Exclude<SheetTab, null> | null>(tab);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      if (unmountTimer.current) clearTimeout(unmountTimer.current);
      if (tab) setLatched(tab);
      progress.value = withTiming(1, { duration: 260, easing: Easing.out(Easing.cubic) });
    } else {
      progress.value = withTiming(0, { duration: EXIT_MS, easing: Easing.in(Easing.cubic) });
      unmountTimer.current = setTimeout(() => setLatched(null), EXIT_MS + 20);
    }
  }, [open, tab, progress]);

  const panel = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateX: (1 - progress.value) * SLIDE }],
  }));
  // The left-side option list slides in slightly after the card edge — a
  // staggered feel without a second animation driver.
  const list = useAnimatedStyle(() => ({
    opacity: Math.max(0, (progress.value - 0.35) / 0.65),
    transform: [{ translateX: (1 - progress.value) * 24 }],
  }));

  // Per-tab option lists, materialised once per open/tab change so the render
  // below stays a flat map.
  const opts = useMemo<SheetOption[]>(() => {
    if (!latched) return [];
    if (latched === 'speed') {
      return SPEEDS.map((s) => ({
        key: s,
        label: s === '1' ? 'Normal' : `${s}×`,
      }));
    }
    return options[latched] ?? [];
  }, [latched, options]);

  const activeKey = latched ? selected[latched] : undefined;

  /**
   * Does the list have anything to scroll to? The drawer is only as tall as the
   * video (~140pt of list under the header), and a subtitle track list is
   * routinely taller than that — so the indicator is shown only when it has
   * something to indicate. `onLayout` reports the VIEWPORT and
   * `onContentSizeChange` the content; measuring either off the other is how a
   * scrollbar ends up blank.
   */
  const viewportRef = useRef(0);
  const contentRef = useRef(0);
  const [overflows, setOverflows] = useState(false);
  const measure = () => {
    setOverflows(viewportRef.current > 0 && contentRef.current > viewportRef.current + 1);
  };

  return (
    // The full-area wrapper is only the tap-catcher (no dim): taps anywhere on
    // the video outside the drawer dismiss it. pointerEvents only when open,
    // so the video stays tappable while the drawer is hidden.
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? 'auto' : 'none'}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close settings" />
      {latched ? (
        <View style={styles.drawerWrap} pointerEvents="box-none">
          <Animated.View style={[styles.panel, panel]}>
            <View style={styles.header}>
              <Text style={styles.title}>{TITLES[latched]}</Text>
              <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close">
                <AppIcon name="close" size={18} color="#fff" />
              </Pressable>
            </View>
            <Animated.View style={[styles.listWrap, list]}>
              <ScrollView
                style={styles.list}
                bounces={false}
                showsVerticalScrollIndicator={overflows}
                onLayout={(e) => {
                  viewportRef.current = e.nativeEvent.layout.height;
                  measure();
                }}
                onContentSizeChange={(_w, h) => {
                  contentRef.current = h;
                  measure();
                }}
              >
                {opts.length === 0 ? (
                  <Text style={styles.empty}>Nothing available</Text>
                ) : (
                  opts.map((opt) => {
                    const active = opt.key === activeKey;
                    return (
                      <Pressable
                        key={opt.key}
                        disabled={opt.disabled}
                        onPress={() => onSelect(latched, opt.key)}
                        style={({ pressed }) => [
                          styles.row,
                          pressed && !active && styles.rowPressed,
                          active && styles.rowActive,
                          opt.disabled && styles.rowDisabled,
                        ]}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: active }}
                      >
                        <Text style={[styles.rowText, active && styles.rowTextActive]} numberOfLines={1}>
                          {opt.label}
                        </Text>
                        {opt.hint ? <Text style={styles.rowHint}>{opt.hint}</Text> : null}
                        {active ? (
                          <AppIcon name="check" size={16} color="#fff" strokeWidth={2.5} />
                        ) : null}
                      </Pressable>
                    );
                  })
                )}
                <View style={styles.tailPad} />
              </ScrollView>
            </Animated.View>
          </Animated.View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Docked to the screen's right edge. Only a small breathing inset at
  // top/bottom keeps the video frame hinted around the panel.
  drawerWrap: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingVertical: spacing.sm,
  },
  panel: {
    width: 250,
    maxWidth: '62%',
    height: '100%',
    // Overdraw the last pixel: a semi-transparent edge column blends with
    // video and can read as a 1px seam — bleed past the screen edge by 1px
    // so the flush side is genuinely flush.
    marginRight: -1,
    // Semi-transparent so the episode keeps playing visibly behind the panel.
    backgroundColor: 'rgba(12,12,18,0.72)',
    // Rounded on the open (left) side only; the docked edge is square so it
    // meets the screen edge with no seam.
    borderRadius: radii.lg,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    overflow: 'hidden',
    // A hairline edge so the card separates from bright video frames; the
    // docked side goes borderless since the screen edge is its border.
    borderWidth: StyleSheet.hairlineWidth,
    borderRightWidth: 0,
    borderColor: 'rgba(255,255,255,0.18)',
    // Soft shadow pulls the panel off the video on its open side.
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: -4, height: 0 },
    elevation: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  title: {
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 15,
    letterSpacing: 0.2,
  },
  listWrap: {
    flex: 1,
  },
  // THE rule that makes the list scroll: without a shrink the ScrollView keeps
  // its content height, overflows the panel and is clipped. See the header.
  list: {
    flexGrow: 0,
    flexShrink: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 13,
  },
  rowPressed: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  rowActive: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  rowDisabled: {
    opacity: 0.35,
  },
  rowText: {
    flex: 1,
    color: 'rgba(255,255,255,0.85)',
    fontFamily: font.medium,
    fontSize: 14,
    minWidth: 0,
  },
  rowTextActive: {
    color: '#fff',
    fontFamily: font.semibold,
  },
  rowHint: {
    color: 'rgba(255,255,255,0.45)',
    fontFamily: font.regular,
    fontSize: 12,
  },
  empty: {
    color: 'rgba(255,255,255,0.5)',
    fontFamily: font.regular,
    fontSize: 13,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  tailPad: { height: spacing.sm },
});
