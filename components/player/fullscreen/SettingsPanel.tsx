// The player's SETTINGS PANEL — the floating sibling of the episode panel.
//
// DESIGN (14 Nov, second pass — the first right panel read as a big flat dark
// slab: no hierarchy, no icons, rows floating like loose pills, every edge
// glued to the screen). This pass is a floating CARD with an inset-grouped
// list, which is the shape every serious settings UI converges on:
//
//  - THE CARD FLOATS. It docks to the right edge but keeps breathing room
//    (10pt clear of the notch, top and bottom), rounded on ALL corners, a
//    bright top hairline (light catching the edge), and a deep shadow — a
//    surface lifted off the video, not a wall bolted to it.
//  - ROWS LIVE IN GROUPS. One rounded container per group, hairline dividers
//    between rows, a micro-caps label above it. The root view groups by
//    domain ("Playback", "Subtitles"); every row carries its value on the
//    right. This is what makes five rows glanceable instead of a wall.
//  - ICONS, IN TILES. Each root row opens with its icon in a soft rounded
//    tile — the scannability that was missing.
//  - The content is still the YouTube-style DRILL-IN: the panel opens on the
//    root list, a tap slides that section in over it, the header's back
//    chevron returns. The bottom-bar trigger chips open the panel directly
//    AT their section; the settings chip opens at the root, where
//    "Subtitle settings" lives (size/position/style, mid-episode).
//
// WHY A RIGHT PANEL AND NOT A BOTTOM SHEET: same reason the episode panel is
// one (see its header) — a landscape sheet eats the bottom half of a ~400pt
// window; a panel takes the right third and leaves the playhead visible.
//
// MOTION, all Reanimated (UI thread):
//  - the card springs in on translateX (off-screen right → seated) with a
//    slight 0.97→1 scale, opacity on its own timing value so the spring
//    overshoot never overshoots the fade;
//  - every list staggers its rows in ~35ms apart;
//  - ONE selection band sits behind the selected row inside its group and
//    springs to it — selection is a place, not a per-row paint (snaps on
//    first placement);
//  - the check icon pops with its own spring; speed chips fill white and
//    lift slightly on selection;
//  - a drill-in slides the new view in from the right with a short fade;
//  - the card follows a swipe RIGHT from the header 1:1 and dismisses past
//    ~120pt or on a fling. The drag lives on the HEADER only — a whole-card
//    responder would fight the subtitle sliders (both horizontal) and the
//    list scroll. Backdrop tap and the X cover the rest.
//
// ALWAYS MOUNTED, driven by `visible`: a pick sets the view to null while the
// card must still animate out, and the open content is latched because the
// screen's prop ternaries fall through to the subtitles rows once `visible`
// is null.
//
// Expo-Go-safe: no gesture-handler, no blur — scrim only, per the house rule.

import { memo, useCallback, useEffect, useRef, type ReactNode } from 'react';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { AppIcon } from '@/components/ui/AppIcon';
import { Slider } from '@/components/ui/Slider';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { font } from '@/lib/ui/tokens';
import type { MenuRow } from './Menu';
import {
  SUBTITLE_BACKGROUNDS,
  SUBTITLE_COLORS,
  SUBTITLE_POSITIONS,
  SUBTITLE_SIZES,
  type SubtitleBackgroundKey,
  type SubtitleColorKey,
  type SubtitlePositionKey,
  type SubtitleSizeKey,
} from '@/lib/settings/store';
import { SUBTITLE_TYPEGRAPHY } from '@/lib/subtitles/style';

/** The views the panel can show. The screen's `menu` state is this union. */
export type PanelView = 'root' | 'speed' | 'quality' | 'source' | 'subs' | 'subsSettings';

export interface SubsStyleValue {
  size: SubtitleSizeKey;
  position: SubtitlePositionKey;
  positionFrac: number;
  background: SubtitleBackgroundKey;
  color: SubtitleColorKey;
}

/** The custom-value row the screen appends to the speed rows. */
const CUSTOM_SPEED_KEY = '__custom';

const EXIT_MS = 220;
const DISMISS_DRAG = 120;
/** Upper bound on the card width — the entrance travel, a CONSTANT. The card
 *  floats ~10pt clear of the right edge, so anything past its own width plus
 *  the margin is fully off-screen; a constant means the interpolation never
 *  has to be rebuilt mid-flight when the first layout arrives. */
const PANEL_W = 420;

const ENTER_SPRING = { damping: 24, stiffness: 300, mass: 0.9 };
const BAND_SPRING = { damping: 26, stiffness: 380, mass: 0.8 };
const CHECK_SPRING = { damping: 16, stiffness: 320, mass: 0.6 };

/** Mount-time stagger: row i waits i*35ms, capped so long lists never crawl. */
const stagger = (index: number) => Math.min(index * 35, 245);

/** Icons for the root drill-in rows, keyed by row key. */
const ROOT_ICONS: Record<string, 'speed' | 'quality' | 'layers' | 'subtitles' | 'filters'> = {
  speed: 'speed',
  quality: 'quality',
  source: 'layers',
  subs: 'subtitles',
  subsSettings: 'filters',
};

/**
 * The one shared entrance every animated child rides. Runs ONCE per mount —
 * rows are keyed, so prop updates re-render but never replay the stagger.
 *
 * ⚠️ TRANSLATE ONLY — opacity is NEVER gated here. The empty-card bug on
 * device (see `styles.panel`) taught the rule: an entrance whose resting
 * state is `opacity: 0` turns any animation hiccup into a card that draws
 * with nothing inside it. A translate-lift at full opacity can only ever
 * look slightly different, never MISSING — if the animation never runs the
 * rows just sit 10pt low, still readable.
 */
function useEnter(index: number) {
  const enter = useSharedValue(0);
  useEffect(() => {
    enter.value = withDelay(
      stagger(index),
      withTiming(1, { duration: 220, easing: Easing.out(Easing.cubic) })
    );
  }, [enter, index]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - enter.value) * 10 }],
  }));
  return style;
}

const SheetRow = memo(function SheetRow({
  row,
  index,
  onPick,
  onNavigate,
  onMeasure,
  divider = false,
  showIcon = false,
}: {
  row: MenuRow;
  index: number;
  onPick: (key: string) => void;
  onNavigate: (to: string) => void;
  onMeasure: (key: string, y: number, height: number) => void;
  /** Hairline under this row — every row in a group but its last. */
  divider?: boolean;
  /** Draw the icon tile (root drill-in rows only). */
  showIcon?: boolean;
}) {
  const enterStyle = useEnter(index);
  // Starts at 0 unconditionally so the check POPS (spring from 0) on mount for
  // already-selected rows — a static checkmark reads as dead chrome.
  const check = useSharedValue(0);
  useEffect(() => {
    check.value = row.selected
      ? withSpring(1, CHECK_SPRING)
      : withTiming(0, { duration: 130 });
  }, [check, row.selected]);
  const checkStyle = useAnimatedStyle(() => ({
    transform: [{ scale: check.value }],
    opacity: check.value,
  }));
  const navigates = row.to != null;
  const icon = showIcon ? ROOT_ICONS[row.key] : undefined;

  return (
    // The wrapper carries the stagger AND the layout report: `onLayout` here
    // reads y relative to the group container — exactly the space the
    // selection band is positioned in (the Pressable inside would report y=0).
    <Animated.View
      style={enterStyle}
      onLayout={(e) =>
        onMeasure(row.key, e.nativeEvent.layout.y, e.nativeEvent.layout.height)
      }
    >
      <Pressable
        onPress={() => {
          if (row.disabled) return;
          if (navigates && row.to) onNavigate(row.to);
          else onPick(row.key);
        }}
        disabled={row.disabled}
        accessibilityRole={navigates ? 'button' : 'menuitem'}
        accessibilityState={{ selected: !!row.selected, disabled: !!row.disabled }}
        style={({ pressed }) => [
          styles.item,
          divider ? styles.itemDivider : null,
          row.selected && !navigates ? styles.itemSelected : null,
          pressed && !row.disabled ? styles.itemPressed : null,
          row.disabled ? styles.itemDisabled : null,
        ]}
      >
        {icon ? (
          <View style={styles.iconTile}>
            <AppIcon name={icon} size={17} color="#fff" strokeWidth={2.1} />
          </View>
        ) : null}
        <Text
          style={[
            styles.itemLabel,
            row.selected && !navigates ? styles.itemLabelSelected : null,
            row.disabled ? styles.disabled : null,
          ]}
          numberOfLines={1}
        >
          {row.label}
        </Text>
        {row.hint ? (
          <Text
            style={[styles.itemHint, row.disabled ? styles.disabled : null]}
            numberOfLines={1}
          >
            {row.hint}
          </Text>
        ) : null}
        {navigates ? (
          <AppIcon name="chevron" size={16} color="rgba(255,255,255,0.4)" strokeWidth={2.25} />
        ) : row.selected ? (
          <Animated.View style={checkStyle}>
            <AppIcon name="check" size={16} color="#fff" strokeWidth={2.75} />
          </Animated.View>
        ) : null}
      </Pressable>
    </Animated.View>
  );
});

const SpeedChip = memo(function SpeedChip({
  row,
  index,
  onPick,
}: {
  row: MenuRow;
  index: number;
  onPick: (key: string) => void;
}) {
  const enterStyle = useEnter(index);
  const sel = useSharedValue(0);
  useEffect(() => {
    sel.value = row.selected
      ? withSpring(1, CHECK_SPRING)
      : withTiming(0, { duration: 130 });
  }, [sel, row.selected]);
  // The selected chip lifts slightly — a filled chip at 1.06× reads as
  // "pressed in and live", and the spring gives the tap a tactile settle.
  const lift = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + sel.value * 0.06 }],
  }));

  return (
    // The wrapper carries the two animated styles: Pressable's style callback
    // does not accept Reanimated handles, so the motion lives on the parent
    // View and the press/selection paints stay plain.
    <Animated.View style={[enterStyle, lift, styles.chipCell]}>
      <Pressable
        onPress={() => {
          if (!row.disabled) onPick(row.key);
        }}
        disabled={row.disabled}
        accessibilityRole="radio"
        accessibilityState={{ selected: !!row.selected, disabled: !!row.disabled }}
        style={({ pressed }) => [
          styles.chip,
          row.selected ? styles.chipSelected : null,
          pressed && !row.disabled ? styles.chipPressed : null,
        ]}
      >
        <Text
          style={[styles.chipLabel, row.selected ? styles.chipLabelSelected : null]}
          numberOfLines={1}
        >
          {row.label}
        </Text>
      </Pressable>
    </Animated.View>
  );
});

/** A captioned group box — the unit every list on the card is built from. */
function Group({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.groupWrap}>
      {label ? <Text style={styles.groupLabel}>{label}</Text> : null}
      <View style={styles.group}>{children}</View>
    </View>
  );
}

/** One slider block inside a group box. */
function SliderBlock({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.sliderBlock}>
      <Text style={styles.sliderLabel} numberOfLines={1}>
        {label}
      </Text>
      {children}
    </View>
  );
}

/** What stays on screen through the exit frame, frozen from the last open render. */
interface Latch {
  view: PanelView;
  title: string;
  rows: MenuRow[];
  onPick: (key: string) => void;
  onNavigate: (to: string) => void;
  subsStyle: SubsStyleValue | null;
}

export const SettingsPanel = memo(function SettingsPanel({
  visible,
  title,
  rows,
  onPick,
  onNavigate,
  onClose,
  insets,
  subsStyle = null,
  onSubsSize,
  onSubsPosition,
  onSubsPositionFrac,
  onSubsBackground,
  onSubsColor,
}: {
  /** The open view, or null. ALWAYS MOUNTED — see the header comment. */
  visible: PanelView | null;
  title: string;
  rows: MenuRow[];
  onPick: (key: string) => void;
  onNavigate: (to: string) => void;
  onClose: () => void;
  insets: EdgeInsets;
  subsStyle: SubsStyleValue | null;
  onSubsSize: (key: SubtitleSizeKey) => void;
  onSubsPosition: (key: SubtitlePositionKey) => void;
  onSubsPositionFrac: (frac: number) => void;
  onSubsBackground: (key: SubtitleBackgroundKey) => void;
  onSubsColor: (key: SubtitleColorKey) => void;
}) {
  // Latch the open content: while `visible` is non-null the card renders the
  // live props; once it goes null the screen's prop ternaries fall through,
  // so the exit renders the frozen last-open bundle instead.
  const latchRef = useRef<Latch | null>(null);
  useEffect(() => {
    if (visible) {
      latchRef.current = { view: visible, title, rows, onPick, onNavigate, subsStyle };
    }
  });

  const shown: Latch | null = visible
    ? { view: visible, title, rows, onPick, onNavigate, subsStyle }
    : latchRef.current;

  const onDismissRef = useRef(onClose);
  useEffect(() => {
    onDismissRef.current = onClose;
  });

  const motionSv = useSharedValue(0); // entrance translate/scale
  const fadeSv = useSharedValue(0); // opacity, its own timing so the spring
  // overshoot on translate never overshoots the fade
  const dragX = useSharedValue(0);

  const backdropAnim = useAnimatedStyle(() => ({
    // The dim tracks the drag so the layer feels lifted with the card.
    opacity: fadeSv.value * Math.max(0, 1 - dragX.value / 420),
  }));
  const cardAnim = useAnimatedStyle(() => ({
    opacity: fadeSv.value,
    transform: [
      { translateX: (1 - motionSv.value) * (PANEL_W + 80) + dragX.value },
      { scale: 0.97 + 0.03 * motionSv.value },
    ],
  }));

  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const beginExit = useCallback(() => {
    if (exitTimer.current) return; // already leaving — never stack a second timer
    motionSv.value = withTiming(0, { duration: EXIT_MS, easing: Easing.in(Easing.cubic) });
    fadeSv.value = withTiming(0, { duration: EXIT_MS, easing: Easing.in(Easing.quad) });
    exitTimer.current = setTimeout(() => {
      exitTimer.current = null;
      onDismissRef.current();
    }, EXIT_MS + 30);
  }, [motionSv, fadeSv]);

  useEffect(() => {
    if (visible) {
      // A quick re-open during the exit must win: kill the pending unmount
      // and spring back in from wherever the card currently sits.
      if (exitTimer.current) {
        clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
      dragX.value = 0;
      motionSv.value = withSpring(1, ENTER_SPRING);
      fadeSv.value = withTiming(1, { duration: 180, easing: Easing.out(Easing.quad) });
    } else if (latchRef.current) {
      beginExit();
    }
  }, [visible, beginExit, motionSv, fadeSv, dragX]);

  // Swipe RIGHT from the header dismisses. Header-only on purpose: a
  // whole-card responder would fight the subtitle sliders (horizontal) and
  // the list scroll for the same gesture.
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, gs) =>
        Math.abs(gs.dx) > Math.abs(gs.dy) && gs.dx > 6,
      onPanResponderMove: (_e, gs) => {
        dragX.value = Math.max(0, gs.dx);
      },
      onPanResponderRelease: (_e, gs) => {
        if (gs.dx > DISMISS_DRAG || gs.vx > 0.5) {
          dragX.value = 0; // the exit animation owns the travel from here
          beginExit();
        } else {
          dragX.value = withSpring(0, BAND_SPRING);
        }
      },
      onPanResponderTerminate: () => {
        dragX.value = withSpring(0, BAND_SPRING);
      },
    })
  ).current;

  // -------------------------------------------------------------------------
  // The selection band (option-list views)
  // -------------------------------------------------------------------------
  const bandY = useSharedValue(0);
  const bandH = useSharedValue(52);
  const bandOn = useSharedValue(0);
  const placed = useRef(false);
  const rowPos = useRef(new Map<string, { y: number; h: number }>()).current;
  // The section list's scroll position — reset on a view change so a new
  // section never opens mid-way through the previous one's scroll.
  const scrollOffsetRef = useRef(0);

  const view = shown?.view ?? null;
  const isSpeed = view === 'speed';
  const isSubsSettings = view === 'subsSettings';
  const isRoot = view === 'root';
  const selectedKey =
    shown && !isSpeed && !isRoot && !isSubsSettings
      ? (shown.rows.find((r) => r.selected && !r.disabled)?.key ?? null)
      : null;
  const selectedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    selectedKeyRef.current = selectedKey;
  });

  const applySelection = useCallback(
    (snap: boolean) => {
      const key = selectedKeyRef.current;
      if (!key) {
        bandOn.value = withTiming(0, { duration: 140 });
        return;
      }
      const pos = rowPos.get(key);
      if (!pos) return; // the row has not laid out yet; its measure will place it
      if (snap || !placed.current) {
        // First placement snaps — a band flying in from y=0 on open is noise.
        bandY.value = pos.y;
        bandH.value = pos.h;
        placed.current = true;
        bandOn.value = withTiming(1, { duration: 180 });
      } else {
        bandY.value = withSpring(pos.y, BAND_SPRING);
        bandH.value = pos.h;
      }
    },
    [rowPos, bandY, bandH, bandOn]
  );

  const measureRow = useCallback(
    (key: string, y: number, h: number) => {
      rowPos.set(key, { y, h });
      if (key === selectedKeyRef.current) applySelection(true);
    },
    [rowPos, applySelection]
  );

  // A view change means a different list — the old measurements are lies.
  // Declared BEFORE the selection effect so the re-place wins the same pass.
  const shownView = shown?.view ?? null;
  useEffect(() => {
    rowPos.clear();
    placed.current = false;
    bandOn.value = 0;
    scrollOffsetRef.current = 0;
  }, [shownView, rowPos, bandOn]);

  useEffect(() => {
    applySelection(false);
  }, [selectedKey, applySelection]);

  const bandAnim = useAnimatedStyle(() => ({
    opacity: bandOn.value * 0.92,
    top: bandY.value,
    height: bandH.value,
  }));

  // Drill-in motion: every view change re-runs a short slide so moving
  // root → section and back feels like a page turn, not a hard swap.
  // TRANSLATE ONLY (see `useEnter`) — the body is never opacity-gated, so a
  // stalled animation can blur the entrance but never blank the view.
  const drillSv = useSharedValue(0);
  useEffect(() => {
    if (visible) {
      drillSv.value = 0;
      drillSv.value = withTiming(1, { duration: 220, easing: Easing.out(Easing.cubic) });
    }
  }, [shownView, visible, drillSv]);
  const drillAnim = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - drillSv.value) * 24 }],
  }));

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------
  const { width: winW } = useWindowDimensions();
  // ~42% of the frame, clamped: narrow enough to leave the episode readable,
  // wide enough for chip rows of three and the subtitle sliders.
  const cardW = Math.min(400, Math.max(320, winW * 0.42));

  const isSpeedShown = shown?.view === 'speed';
  const presetRows = isSpeedShown
    ? (shown?.rows ?? []).filter((r) => r.key !== CUSTOM_SPEED_KEY)
    : [];
  const customRow = isSpeedShown
    ? (shown?.rows ?? []).find((r) => r.key === CUSTOM_SPEED_KEY)
    : undefined;
  const listRows =
    shown && shown.view !== 'speed' && shown.view !== 'subsSettings'
      ? shown.rows
      : [];
  const chipGroups: MenuRow[][] = [];
  for (let i = 0; i < presetRows.length; i += 3) chipGroups.push(presetRows.slice(i, i + 3));

  // Root rows arrive in domain order; consecutive rows sharing a `group`
  // render as one captioned box (the screen owns the order, the panel owns
  // the boxes).
  const rootChunks: { label?: string; rows: MenuRow[] }[] = [];
  if (isRoot) {
    for (const row of shown?.rows ?? []) {
      const last = rootChunks[rootChunks.length - 1];
      if (last && last.label === row.group) last.rows.push(row);
      else rootChunks.push({ label: row.group, rows: [row] });
    }
  }

  const style = shown?.subsStyle ?? null;
  let staggerI = 0;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={visible ? 'auto' : 'none'}>
      <Animated.View style={[styles.backdrop, backdropAnim]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={beginExit}
          accessibilityRole="button"
          accessibilityLabel="Close settings"
        />
      </Animated.View>
      {shown ? (
        <Animated.View
          style={[
            styles.panel,
            cardAnim,
            {
              width: cardW,
              top: insets.top + 10,
              bottom: insets.bottom + 10,
              marginRight: insets.right + 10,
            },
          ]}
        >
          <View style={styles.header} {...pan.panHandlers}>
            {shown.view !== 'root' ? (
              <Pressable
                onPress={() => shown.onNavigate('root')}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Back to settings"
                style={styles.headerBtn}
              >
                <AppIcon name="back" size={19} color="rgba(255,255,255,0.9)" strokeWidth={2.25} />
              </Pressable>
            ) : (
              <View style={[styles.headerBtn, styles.headerBtnGhost]} />
            )}
            <Text style={styles.title} numberOfLines={1}>
              {shown.title}
            </Text>
            <Pressable
              onPress={beginExit}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close settings"
              style={styles.headerBtn}
            >
              <AppIcon name="close" size={19} color="rgba(255,255,255,0.9)" strokeWidth={2.25} />
            </Pressable>
          </View>

          <Animated.View style={[styles.body, drillAnim]}>
            {isSpeedShown ? (
              <ScrollView
                style={styles.list}
                contentContainerStyle={styles.content}
                bounces={false}
                showsVerticalScrollIndicator={false}
                onScroll={(e) => {
                  scrollOffsetRef.current = e.nativeEvent.contentOffset.y;
                }}
                scrollEventThrottle={16}
              >
                <Group>
                  <View style={styles.chipWrap}>
                    {chipGroups.map((group, gi) => (
                      <View key={gi} style={styles.chipRow}>
                        {group.map((row, ri) => (
                          <SpeedChip
                            key={row.key}
                            row={row}
                            index={gi * 3 + ri}
                            onPick={shown.onPick}
                          />
                        ))}
                      </View>
                    ))}
                  </View>
                </Group>
                {customRow ? (
                  <Group>
                    <SheetRow
                      row={customRow}
                      index={presetRows.length}
                      onPick={shown.onPick}
                      onNavigate={shown.onNavigate}
                      onMeasure={measureRow}
                    />
                  </Group>
                ) : null}
              </ScrollView>
            ) : isSubsSettings && style ? (
              <ScrollView
                style={styles.list}
                contentContainerStyle={styles.content}
                bounces={false}
                showsVerticalScrollIndicator={false}
                onScroll={(e) => {
                  scrollOffsetRef.current = e.nativeEvent.contentOffset.y;
                }}
                scrollEventThrottle={16}
              >
                <Group label="Text size">
                  <View style={styles.padBox}>
                    <SliderBlock
                      label={`${SUBTITLE_SIZES.find((s) => s.key === style.size)?.label ?? ''} · ${SUBTITLE_TYPEGRAPHY[style.size].fontSize}pt`}
                    >
                      <Slider
                        value={SUBTITLE_SIZES.findIndex((s) => s.key === style.size)}
                        onValueChange={(v) => {
                          const opt = SUBTITLE_SIZES[Math.round(v)];
                          if (opt) onSubsSize(opt.key);
                        }}
                        minimumValue={0}
                        maximumValue={SUBTITLE_SIZES.length - 1}
                        step={1}
                        marks={SUBTITLE_SIZES.map((s, i) => ({
                          frac: i / (SUBTITLE_SIZES.length - 1),
                          label: String(SUBTITLE_TYPEGRAPHY[s.key].fontSize),
                        }))}
                      />
                    </SliderBlock>
                  </View>
                </Group>

                <Group label="Position">
                  <View style={styles.padBox}>
                    <View style={styles.segRow}>
                      {SUBTITLE_POSITIONS.map((p) => (
                        <Pressable
                          key={p.key}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: style.position === p.key }}
                          onPress={() => onSubsPosition(p.key)}
                          style={({ pressed }) => [
                            styles.seg,
                            style.position === p.key ? styles.segSelected : null,
                            pressed && style.position !== p.key ? styles.chipPressed : null,
                          ]}
                        >
                          <Text
                            style={[
                              styles.segLabel,
                              style.position === p.key ? styles.segLabelSelected : null,
                            ]}
                            numberOfLines={1}
                          >
                            {p.label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                    <SliderBlock
                      label={
                        style.position === 'default'
                          ? 'Default — near the bottom edge'
                          : `${Math.round(style.positionFrac * 100)}% from bottom`
                      }
                    >
                      <Slider
                        value={style.positionFrac}
                        onValueChange={onSubsPositionFrac}
                        minimumValue={0}
                        maximumValue={1}
                        step={0.01}
                      />
                    </SliderBlock>
                  </View>
                </Group>

                <Group label="Behind the text">
                  <View style={styles.padBox}>
                    <View style={styles.segRow}>
                      {SUBTITLE_BACKGROUNDS.map((b) => (
                        <Pressable
                          key={b.key}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: style.background === b.key }}
                          onPress={() => onSubsBackground(b.key)}
                          style={({ pressed }) => [
                            styles.seg,
                            style.background === b.key ? styles.segSelected : null,
                            pressed && style.background !== b.key ? styles.chipPressed : null,
                          ]}
                        >
                          <Text
                            style={[
                              styles.segLabel,
                              style.background === b.key ? styles.segLabelSelected : null,
                            ]}
                            numberOfLines={1}
                          >
                            {b.label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                </Group>

                <Group label="Text colour">
                  <View style={styles.padBox}>
                    <View style={styles.segRow}>
                      {SUBTITLE_COLORS.map((c) => (
                        <Pressable
                          key={c.key}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: style.color === c.key }}
                          onPress={() => onSubsColor(c.key)}
                          style={({ pressed }) => [
                            styles.seg,
                            style.color === c.key ? styles.segSelected : null,
                            pressed && style.color !== c.key ? styles.chipPressed : null,
                          ]}
                        >
                          <Text
                            style={[
                              styles.segLabel,
                              style.color === c.key ? styles.segLabelSelected : null,
                            ]}
                            numberOfLines={1}
                          >
                            {c.label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                </Group>
              </ScrollView>
            ) : isRoot ? (
              <ScrollView
                style={styles.list}
                contentContainerStyle={styles.content}
                bounces={false}
                showsVerticalScrollIndicator={false}
                onScroll={(e) => {
                  scrollOffsetRef.current = e.nativeEvent.contentOffset.y;
                }}
                scrollEventThrottle={16}
              >
                {rootChunks.map((chunk, ci) => (
                  <Group key={ci} label={chunk.label}>
                    {chunk.rows.map((row, ri) => (
                      <SheetRow
                        key={row.key}
                        row={row}
                        index={staggerI++}
                        onPick={shown.onPick}
                        onNavigate={shown.onNavigate}
                        onMeasure={measureRow}
                        divider={ri < chunk.rows.length - 1}
                        showIcon
                      />
                    ))}
                  </Group>
                ))}
              </ScrollView>
            ) : (
              <ScrollView
                style={styles.list}
                contentContainerStyle={styles.content}
                bounces={false}
                showsVerticalScrollIndicator={false}
                onScroll={(e) => {
                  scrollOffsetRef.current = e.nativeEvent.contentOffset.y;
                }}
                scrollEventThrottle={16}
              >
                <Group>
                  <Animated.View style={[styles.band, bandAnim]} pointerEvents="none" />
                  {listRows.map((row, i) => (
                    <SheetRow
                      key={row.key}
                      row={row}
                      index={i}
                      onPick={shown.onPick}
                      onNavigate={shown.onNavigate}
                      onMeasure={measureRow}
                      divider={i < listRows.length - 1}
                    />
                  ))}
                </Group>
              </ScrollView>
            )}
          </Animated.View>
        </Animated.View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  // A floating card: rounded on ALL corners, ~10pt clear of the screen edges
  // (the insets are applied at the mount site), deep shadow, and a bright top
  // hairline that reads as light catching the top edge.
  //
  // ⚠️ NO `overflow: 'hidden'`, NO `elevation`, OPAQUE background. This exact
  // combination shipped twice with EMPTY cards on device (the two "not
  // looking good" verdicts were both this): Android clips an elevated,
  // overflow-hidden, rounded, translucent view's CHILDREN to the elevation
  // outline and culls them — the card draws, everything inside vanishes. The
  // episode panel (which always had content) uses none of the four. Nothing
  // here needs the clip: children are inset ≥10pt from every edge, and the
  // group boxes clip themselves. iOS shadow props stay (no-ops on Android).
  panel: {
    position: 'absolute',
    // THE ANCHOR — without this the card is unanchored and Yoga seats it at
    // the parent's START, i.e. the LEFT edge (shipped and seen on device).
    // `marginRight` at the mount site only means anything once the card is
    // pinned here: margin then pushes it 10pt clear of the edge it is
    // anchored to, which is the floating gap.
    right: 0,
    backgroundColor: '#0E0E14',
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.24)',
    borderLeftColor: 'rgba(255,255,255,0.14)',
    borderRightColor: 'rgba(255,255,255,0.14)',
    borderBottomColor: 'rgba(255,255,255,0.1)',
    shadowColor: '#000',
    shadowOffset: { width: -6, height: 14 },
    shadowOpacity: 0.55,
    shadowRadius: 34,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 8,
    minHeight: 54,
  },
  headerBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  // The root view has no back to go to — the slot stays so the title holds
  // its place between two equal buttons.
  headerBtnGhost: {
    backgroundColor: 'transparent',
  },
  title: {
    flex: 1,
    color: '#fff',
    fontFamily: font.semibold,
    fontSize: 16,
    lineHeight: 21,
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  body: {
    flex: 1,
  },
  // THE SCROLL RULE, in PlayerSheet's proven two-layer shape: the body above
  // (`flex: 1`, definite height) owns the space; the ScrollView is CONTENT-
  // SIZED (no flex basis) and only SHRINKS when its content overflows it.
  //
  // ⚠️ `flex: 1` ON THE SCROLLER ITSELF IS THE EMPTY-CARD BUG (shipped twice,
  // seen on device): the shorthand sets flexBasis 0, and with `flexGrow: 0`
  // in the same object the scroller resolves to zero height — header shows,
  // nothing inside. Never combine them.
  list: {
    flexGrow: 0,
    flexShrink: 1,
  },
  content: {
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 16,
    gap: 14,
  },
  groupWrap: {
    gap: 8,
  },
  groupLabel: {
    color: 'rgba(255,255,255,0.45)',
    fontFamily: font.semibold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    paddingHorizontal: 6,
  },
  // One rounded surface per group; rows live INSIDE it with dividers, which
  // is what makes a list of five look organised instead of scattered.
  group: {
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.055)',
    overflow: 'hidden',
  },
  // The selection band — one surface that slides behind whichever row is
  // selected, inside its group's box.
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: 56,
    paddingHorizontal: 12,
  },
  itemDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  itemSelected: {
    backgroundColor: 'transparent',
  },
  itemPressed: {
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  itemDisabled: {
    opacity: 0.4,
  },
  iconTile: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.09)',
  },
  itemLabel: {
    flexShrink: 1,
    color: 'rgba(255,255,255,0.9)',
    fontFamily: font.medium,
    fontSize: 15,
    lineHeight: 19,
    minWidth: 0,
  },
  itemLabelSelected: {
    fontFamily: font.semibold,
    color: '#fff',
  },
  itemHint: {
    flexShrink: 1,
    color: 'rgba(255,255,255,0.45)',
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 16,
    maxWidth: '46%',
    textAlign: 'right',
  },
  disabled: {
    opacity: 0.4,
  },
  chipWrap: {
    padding: 10,
    gap: 10,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 10,
  },
  chipCell: {
    flex: 1,
  },
  chip: {
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  chipSelected: {
    backgroundColor: '#fff',
  },
  chipPressed: {
    opacity: 0.8,
  },
  chipLabel: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 18,
  },
  chipLabelSelected: {
    color: '#101014',
    fontFamily: font.semibold,
  },
  padBox: {
    padding: 12,
    gap: 10,
  },
  segRow: {
    flexDirection: 'row',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 14,
    padding: 5,
  },
  seg: {
    flex: 1,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segSelected: {
    backgroundColor: '#fff',
  },
  segLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 17,
  },
  segLabelSelected: {
    color: '#101014',
    fontFamily: font.semibold,
  },
  sliderBlock: {
    gap: 6,
  },
  sliderLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 16,
  },
});
