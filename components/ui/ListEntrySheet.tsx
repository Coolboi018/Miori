// The "add to your list" sheet — everything AniList lets you say about a title,
// in one modal.
//
// WHY A SHEET AND NOT A SCREEN. Every field here is a small, bounded choice, and
// the user's intent is "set this and get back to what I was doing". A route
// would cost a push animation in each direction and a back gesture to undo a
// mis-tap, for something that is a form. The house pattern for this is
// `FilterDropdown`'s: a real `Modal`, a fading scrim, a sheet that slides, and a
// dismiss that ANIMATES OUT before unmounting — a hard `visible={false}` cuts the
// sheet off mid-flight and reads as a glitch.
//
// WHAT IS HERE, and why each earns its row:
//
//   STATUS      the whole point of the button.
//   PROGRESS    "how far am I", and the field people come back to update most.
//               A stepper for ±1, but the number is also a field: tap it and
//               type, or hold +/− to run. See `Stepper` for why the buttons
//               alone were not enough.
//   SCORE       what the title was worth, on AniList's own 0-10 scale.
//   REPEAT      only shown for REPEATING, because that is the only status where
//               it means anything.
//   PRIVATE     affects who sees the entry on their public list.
//
// NO PRIORITY CONTROL, and that is a correction rather than an omission. AniList
// has the field and documents it in full as "Priority of planning" — a bare `Int`
// with no published value mapping. Introspection returns nothing for it, and there
// is no `MediaListPriority` enum to read (AniList suggests `MediaListSort`,
// `MediaListGroup`, `MediaListStatus` instead), so the numbers behind Low /
// Normal / High cannot be established from outside.
//
// An earlier version of this sheet offered it with an invented mapping, which is
// worse than not offering it: a mislabelled control writes a wrong integer to
// someone's real AniList account and nothing tells them. Omitting the field from
// the mutation is safe — AniList's save is a partial update, so an entry's
// existing priority survives a save from this sheet untouched.
//
// WHAT IS DELIBERATELY ABSENT: notes and dates. Both are real AniList fields and
// both are a text input and a date picker respectively — a keyboard and a
// calendar inside a bottom sheet on a phone is two more screens wearing a sheet's
// clothes. They belong on the profile area that the home rails are also waiting
// on, where there is room to do them properly.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/ui/useTheme';
import { font, motion, radii, spacing } from '@/lib/ui/tokens';
import { AppIcon, type AppIconName } from './AppIcon';
import type { MediaListStatus } from '@/lib/anilist/lists';
import type { EntryDraft } from '@/lib/query/listEntries';

/**
 * The statuses AniList accepts, in the order a person thinks about them.
 *
 * `REPEATING` is placed last rather than next to `COMPLETED` because reaching it
 * is a deliberate act — you rewatch something, then come back and say so — and
 * putting it high would make it look like a default choice.
 */
const STATUSES: { key: MediaListStatus; label: string; icon: AppIconName }[] = [
  { key: 'CURRENT', label: 'Watching', icon: 'play' },
  { key: 'PLANNING', label: 'Planning', icon: 'hourglass' },
  { key: 'COMPLETED', label: 'Completed', icon: 'check' },
  { key: 'PAUSED', label: 'On hold', icon: 'bookmark' },
  { key: 'DROPPED', label: 'Dropped', icon: 'close' },
  { key: 'REPEATING', label: 'Rewatching', icon: 'reset' },
];

/** AniList's default for a new entry, and the state a sheet opens in for a
 *  title that is not on the list. `PLANNING` because "I am going to watch this"
 *  is what the button's press means when nothing is known. */
const BLANK: EntryDraft = {
  status: 'PLANNING',
  progress: 0,
  score: 0,
  private: false,
  repeat: 0,
};

export function ListEntrySheet({
  visible,
  title,
  totalEpisodes,
  initial,
  entryId,
  onClose,
  onSubmit,
  onRemove,
  busy = false,
  error,
}: {
  visible: boolean;
  /** Shown in the header so it is obvious which title is being edited. */
  title: string;
  /** AniList's episode count, or null when it has not indexed one. Progress
   *  falls back to a free number entry in that case rather than a capped stepper
   *  with no ceiling. */
  totalEpisodes: number | null;
  initial: EntryDraft | null;
  entryId?: number;
  onClose: () => void;
  onSubmit: (draft: EntryDraft & { entryId?: number }) => void;
  /**
   * Delete the entry entirely. OMIT IT and the remove button does not render, which
   * is what a title that is not on the list should show — there is nothing there
   * to remove, and a button that can only fail is worse than no button.
   *
   * NO CONFIRMATION, deliberately. An earlier version asked first, and that was
   * friction on a reversible action: re-adding a title takes one tap, and the
   * progress and score lost are two fields the user was unlikely to want restored
   * anyway. A dialog to delete one row out of a list of hundreds asks the user to
   * approve the obvious. The button itself is the warning — outlined in the danger
   * colour, beside Save rather than under it, and absent entirely for a title that
   * is not tracked.
   */
  onRemove?: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const progress = useSharedValue(0);

  /**
   * The form's state is LOCAL, seeded from `initial` when the sheet opens.
   *
   * Local rather than written straight through to the mutation, because this is a
   * form and the user is going to change four things and then press one button.
   * A control that fires a request per tap would spend AniList's rate limit on
   * intermediate states nobody meant to keep.
   */
  const [draft, setDraft] = useState<EntryDraft>(initial ?? BLANK);

  useEffect(() => {
    if (visible) setDraft(initial ?? BLANK);
  }, [visible, initial]);

  /**
   * The vertical drag offset, the sheet's own height, and where the current drag
   * started. All three exist before `dismiss` and the open effect, because both
   * of those reset or read them.
   */
  const dragY = useSharedValue(0);
  const sheetHeight = useSharedValue(600);
  const startY = useSharedValue(0);
  const scrollOffset = useRef(0);

  useEffect(() => {
    if (visible) {
      progress.value = withTiming(1, { duration: motion.normal });
      // The drag offset back to zero on the way IN as well as the way out. Belt
      // and braces against the reset in `dismiss` being skipped on some path — a
      // sheet that opens already dragged off the bottom is invisible, and reads as
      // a dead button rather than as a bug.
      dragY.value = 0;
    }
  }, [visible, progress, dragY]);

  const dismiss = useCallback(() => {
    // Reset on the way OUT too. A swipe-dismiss leaves `dragY` at screen height,
    // and without this the next open would animate `progress` to 1 with the sheet
    // already dragged off the bottom.
    dragY.value = withTiming(0, { duration: motion.fast });
    progress.value = withTiming(0, { duration: motion.fast }, (finished) => {
      if (finished) runOnJS(onClose)();
    });
  }, [dragY, progress, onClose]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  /**
   * SWIPE DOWN TO DISMISS.
   *
   * `PanResponder` rather than `react-native-gesture-handler`, which is not a
   * dependency (`progress.md` lists it as not-yet) and would need a development
   * build to install. `HeroCarousel` already drives its pan this way, so this is
   * the house answer rather than a new one.
   *
   * TWO WRITERS ON THE SHEET, AND THEY ADD. `progress` is the open/close animation
   * and `dragY` is the finger. They are summed in the transform rather than
   * fighting over it, which is what lets a swipe-dismiss work during the opening
   * animation without either one clobbering the other — a shared value that both
   * wrote would mean a drag that started before the sheet finished sliding
   * cancelled the slide, or worse, restarted it.
   *
   * DOWNWARD ONLY. An upward drag is clamped to zero rather than allowed to move
   * the sheet: there is nothing above it, and a sheet that can be pulled up off
   * the top of the screen is a sheet with a second, undocumented behaviour.
   *
   * The scrim fades WITH the drag, not at the end of it — so the gesture reads as
   * one continuous motion rather than a drag that stops and then an animation that
   * starts.
   */
  /** Past this, a release dismisses. ~40% of a tall sheet, ~25% of a short one. */
  const DISMISS_AT = 96;
  /** Or a flick, regardless of distance — a fast short swipe should still go. */
  const FLICK_V = 0.6;

  const finishDrag = useCallback(
    (dy: number, velocity: number) => {
      const h = sheetHeight.value;
      const far = dy > Math.max(DISMISS_AT, h * 0.25);
      if (far || velocity > FLICK_V) {
        // Drive it the rest of the way off and unmount WHEN THAT FINISHES.
        // Setting `progress` alone would animate back up from 28px rather than
        // continuing the drag the finger just made, which reads as the sheet
        // bouncing rather than leaving.
        //
        // `runOnJS` on the completion, the same shape `dismiss` uses — not a
        // `setTimeout`, which would still fire after an unmount and would race a
        // reopen.
        dragY.value = withTiming(h + 40, { duration: motion.fast }, (finished) => {
          if (finished) runOnJS(onClose)();
        });
        progress.value = withTiming(0, { duration: motion.fast });
      } else {
        dragY.value = withSpring(0, { damping: 20, stiffness: 240 });
      }
    },
    [dragY, progress, sheetHeight, onClose]
  );

  const pan = useMemo(
    () =>
      PanResponder.create({
        // Only claim the gesture once it is clearly a drag, so a tap on the close
        // button or a chip in the header is still a tap and not the start of a
        // swipe that ends up doing nothing.
        onMoveShouldSetPanResponder: (_e, g) =>
          g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx) && scrollOffset.current <= 2,
        onPanResponderGrant: () => {
          startY.value = dragY.value;
        },
        onPanResponderMove: (_e, g) => {
          const next = startY.value + g.dy;
          dragY.value = next > 0 ? next : 0;
        },
        onPanResponderRelease: (_e, g) => finishDrag(dragY.value, g.vy),
        onPanResponderTerminate: (_e, g) => finishDrag(dragY.value, g.vy),
      }),
    [dragY, startY, finishDrag]
  );

  const scrimDragStyle = useAnimatedStyle(() => ({
    // Fades out as the sheet is dragged away, so the gesture is one motion.
    opacity: progress.value * Math.max(0, 1 - dragY.value / 240),
  }));

  const sheetStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 28 + dragY.value }],
  }));

  const patch = useCallback((p: Partial<EntryDraft>) => setDraft((d) => ({ ...d, ...p })), []);

  /**
   * Progress is CAPPED at the episode count when there is one, and that cap is
   * the reason the total matters: AniList accepts any integer, so a title with 12
   * episodes can be marked 40 watched and the site will hold that forever. A
   * stepper cannot overshoot by accident; the free-text fallback below is the only
   * way to, and it is deliberately two taps away.
   */
  const known = totalEpisodes != null && totalEpisodes > 0;
  const maxProgress = known ? (totalEpisodes as number) : 999;
  const progressTooHigh = known && draft.progress > (totalEpisodes as number);

  const progressText = useMemo(() => {
    if (!known) return `${draft.progress} ep`;
    return `${draft.progress} / ${totalEpisodes}`;
  }, [draft.progress, known, totalEpisodes]);

  const scoreRow = useMemo(() => Array.from({ length: 10 }, (_, i) => i + 1), []);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={dismiss}
    >
      <View style={styles.root}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: color.bg.overlay },
            scrimStyle,
            scrimDragStyle,
          ]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={dismiss}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: color.bg.elevated,
              borderColor: color.border.muted,
              paddingBottom: insets.bottom + spacing.lg,
            },
            sheetStyle,
          ]}
          {...pan.panHandlers}
          // Measured so the dismiss threshold can scale with the sheet rather
          // than being a fixed number of pixels that means different things on a
          // short form and a tall one.
          onLayout={(e) => {
            sheetHeight.value = e.nativeEvent.layout.height;
          }}
        >
          {/* THE DRAG ZONE IS THE GRABBER AND THE HEADER, not the whole sheet.
              The body is a ScrollView, and a pan responder on an ancestor of a
              ScrollView competes with it for the same vertical gesture — which is
              why this is bounded rather than applied to the container. It is also
              the convention every mobile sheet uses: you pull a sheet by its
              handle, because the content in front of you might want to scroll. */}
          <View>
            <View style={[styles.grabber, { backgroundColor: color.border.strong }]} />

            <View style={styles.head}>
              <View style={styles.headText}>
                <Text style={[styles.headTitle, { color: color.text.muted }]}>LIST</Text>
                <Text style={[styles.title, { color: color.text.primary }]} numberOfLines={1}>
                  {title}
                </Text>
              </View>
              <Pressable
                onPress={dismiss}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={10}
                android_ripple={{ color: color.accent.glow, borderless: false }}
                style={({ pressed }) => [
                  styles.close,
                  { backgroundColor: color.accent.muted, opacity: pressed ? 0.6 : 1 },
                ]}
              >
                <AppIcon name="close" size={15} color={color.text.secondary} />
              </Pressable>
            </View>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyInner}
            showsVerticalScrollIndicator={false}
            bounces={false}
            // A tap on Save while the number field is open must land as a tap on
            // Save, not as the tap that closes the keyboard. Without this the
            // first press is swallowed and the sheet looks unresponsive.
            keyboardShouldPersistTaps="handled"
            onScroll={(e) => {
              scrollOffset.current = e.nativeEvent.contentOffset.y;
            }}
            scrollEventThrottle={16}
          >
            {/* ---- STATUS ---- */}
            <Field label="Status">
              <View style={styles.statusGrid}>
                {STATUSES.map((s) => {
                  const active = s.key === draft.status;
                  return (
                    <Pressable
                      key={s.key}
                      onPress={() => patch({ status: s.key })}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      style={({ pressed }) => [
                        styles.statusCell,
                        {
                          backgroundColor: active ? color.accent.muted : color.bg.surface,
                          borderColor: active ? color.accent.base : color.border.muted,
                          opacity: pressed ? 0.7 : 1,
                        },
                      ]}
                    >
                      <AppIcon
                        name={s.icon}
                        size={15}
                        color={active ? color.accent.base : color.text.secondary}
                      />
                      <Text
                        style={[
                          styles.statusLabel,
                          { color: active ? color.text.primary : color.text.secondary },
                        ]}
                        numberOfLines={1}
                      >
                        {s.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </Field>

            {/* ---- PROGRESS ---- */}
            <Field label="Episodes watched" hint={progressText}>
              <Stepper
                value={draft.progress}
                min={0}
                max={maxProgress}
                warn={progressTooHigh}
                onChange={(n) => patch({ progress: n })}
              />
              {!known ? (
                <Text style={[styles.help, { color: color.text.muted }]}>
                  AniList has no episode count for this title, so type any
                  number.
                </Text>
              ) : null}
            </Field>

            {/* ---- REPEAT, only where it means something ---- */}
            {draft.status === 'REPEATING' ? (
              <Field label="Times rewatched" hint={String(draft.repeat)}>
                <Stepper
                  value={draft.repeat}
                  min={0}
                  max={99}
                  onChange={(n) => patch({ repeat: n })}
                />
              </Field>
            ) : null}

            {/* ---- SCORE ---- */}
            <Field label="Score" hint={draft.score > 0 ? `${draft.score} / 10` : 'Not rated'}>
              <View style={styles.scoreRow}>
                {scoreRow.map((n) => {
                  const active = draft.score === n;
                  return (
                    <Pressable
                      key={n}
                      onPress={() => patch({ score: active ? 0 : n })}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`Score ${n} out of 10`}
                      // Every cell but the selected one reads as filled up to the
                      // score, so the bar reads as a level rather than as ten
                      // separate targets.
                      style={({ pressed }) => [
                        styles.scoreCell,
                        {
                          backgroundColor:
                            n <= draft.score ? color.accent.base : color.bg.surface,
                          borderColor:
                            n <= draft.score ? color.accent.base : color.border.muted,
                          borderWidth: StyleSheet.hairlineWidth,
                          opacity: pressed ? 0.7 : 1,
                        },
                        active && { borderColor: color.text.primary, borderWidth: 1.5 },
                      ]}
                    >
                      <Text
                        style={[
                          styles.scoreCellText,
                          { color: n <= draft.score ? color.bg.primary : color.text.muted },
                        ]}
                      >
                        {n}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {draft.score > 0 ? (
                <Pressable onPress={() => patch({ score: 0 })} hitSlop={8}>
                  <Text style={[styles.clear, { color: color.text.muted }]}>Clear score</Text>
                </Pressable>
              ) : null}
            </Field>

            {/* ---- PRIVATE ---- */}
            <Toggle
              label="Private"
              help="Hidden from your public list. Only you see this entry."
              value={draft.private}
              onChange={(v) => patch({ private: v })}
            />

            {error ? (
              <Text style={[styles.error, { color: color.status.danger }]}>{error}</Text>
            ) : null}
          </ScrollView>

          {/* ---- SUBMIT ROW ----
               *
               * TWO BUTTONS, SAVE ON THE RIGHT — and the left one is REMOVE, not a
               * cancelled action. "I do not want this in my list at all" is a
               * different thing from every status in the grid above it: Dropped
               * still counts, still shows on your list, still follows the title
               * around. Only this removes it, and there is nowhere else in the app
               * to do that from — the detail page's bookmark toggles between "on the
               * list" and "not", it never removes.
               *
               * SPLIT IN TWO, save on the right, because the alternative is burying
               * a destructive action behind an overflow menu on a form whose other
               * six controls are all one tap. Equal halves: a narrow destructive
               * button beside a wide primary one reads as a dialog asking for
               * permission, and this row is not that.
               *
               * REMOVE ONLY WHEN THERE IS SOMETHING TO REMOVE. For a title that is
               * not on the list, Save takes the whole row — an empty half there
               * would be a button that can do nothing.
               */}
          <View style={styles.actions}>
            {onRemove ? (
              <Pressable
                onPress={onRemove}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Remove from your list"
                style={({ pressed }) => [
                  styles.action,
                  styles.removeBtn,
                  {
                    borderColor: color.status.danger,
                    opacity: busy ? 0.4 : pressed ? 0.6 : 1,
                  },
                ]}
              >
                <AppIcon name="ban" size={15} color={color.status.danger} />
                <Text style={[styles.actionText, { color: color.status.danger }]}>Remove</Text>
              </Pressable>
            ) : null}

            <Pressable
              onPress={() => onSubmit({ ...draft, entryId })}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Save to list"
              style={({ pressed }) => [
                styles.action,
                styles.saveBtn,
                {
                  backgroundColor: color.accent.base,
                  opacity: busy ? 0.5 : pressed ? 0.85 : 1,
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator size="small" color={color.bg.primary} />
              ) : (
                <Text style={[styles.actionText, styles.saveText, { color: color.bg.primary }]}>
                  Save
                </Text>
              )}
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

/** A labelled block. `hint` is the right-hand current value. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const { color } = useTheme();
  return (
    <View style={styles.field}>
      <View style={styles.fieldHead}>
        <Text style={[styles.fieldLabel, { color: color.text.muted }]}>{label.toUpperCase()}</Text>
        {hint ? <Text style={[styles.fieldHint, { color: color.text.secondary }]}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

/**
 * Minus / value / plus — where the value is ALSO a field.
 *
 * WHY THE BUTTONS WERE NOT ENOUGH. A stepper is the right control for "I watched
 * one more", and the wrong one for the rest: reaching episode 1,100 of a long
 * runner is 1,100 taps, so the only way to use it on a long series was to not
 * use it. Three ways in now, one per size of jump:
 *
 *   tap +/−     one episode, the common case.
 *   hold +/−    a run, accelerating out of the ~0.3s long-press delay at ~11/s
 *               — so it keeps going for as long as the finger is down, and a
 *               "+12" never needs the keyboard.
 *   tap the     any value at all, in one gesture. The number is drawn as a
 *   number      bordered field, not bare text, because a value that can be
 *               edited has to look like one.
 *
 * TYPED KEYS GO STRAIGHT TO `onChange`, per keystroke rather than on submit.
 * That keeps the sheet's draft always current, so Save can never read a number
 * the user just typed and has not "committed" — there is no commit step to miss,
 * and no blur ordering to get wrong. It costs nothing: the draft is local, so
 * nothing leaves the phone until Save.
 *
 * THE CEILING HOLDS ON EVERY PATH — buttons, hold, and keystrokes alike. That is
 * the reason AniList is not handed the number directly: it accepts any integer,
 * so a 12-episode title can be marked 40 watched and the site will keep that
 * forever.
 *
 * `warn` is for a value that is over the count ANYWAY — an entry set past the
 * total on the website. It is drawn in the danger colour rather than clamped
 * away, so opening the sheet shows the state AniList actually holds instead of
 * quietly "fixing" it.
 */
function Stepper({
  value,
  min,
  max,
  warn,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  warn?: boolean;
  onChange: (n: number) => void;
}) {
  const { color } = useTheme();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');

  /**
   * The repeat: the interval, and the value it is running from.
   *
   * `live` exists because the prop is not safe to read inside the interval. The
   * timer runs at ~11/s, faster than React is obliged to re-render, so a tick
   * that read `value` could step from a render the previous tick has already
   * outrun and write the same number twice. The ref is the running total; the
   * prop re-syncs it once the finger is up, when it is the authority again.
   */
  const hold = useRef<ReturnType<typeof setInterval> | null>(null);
  const live = useRef(value);
  if (!hold.current) live.current = value;

  const clamp = (n: number) => Math.min(Math.max(n, min), max);

  /** Only ever called with a reason to: an unmount, a release, or a bound. */
  const stopHold = useCallback(() => {
    if (hold.current) clearInterval(hold.current);
    hold.current = null;
  }, []);

  // A hold that outlives the sheet would keep writing to a dead draft.
  useEffect(() => stopHold, [stopHold]);

  const nudge = (dir: -1 | 1) => {
    const next = clamp(live.current + dir);
    if (next === live.current) {
      stopHold(); // Hit min or max — nothing left to run toward.
      return;
    }
    live.current = next;
    onChange(next);
  };

  const startHold = (dir: -1 | 1) => {
    stopHold();
    live.current = value; // The prop is the authority at press time.
    nudge(dir);
    hold.current = setInterval(() => nudge(dir), 90);
  };

  /**
   * Sanitised per keystroke: digits only, four of them (nothing AniList has
   * indexed needs a fifth), clamped to the range, and written BACK to the field
   * so the cap is visible while typing rather than a surprise on blur.
   *
   * An empty field holds the draft where it is — it is a half-typed number, not
   * a request to write zero — and the blur below puts the number back.
   */
  const type = (raw: string) => {
    const digits = raw.replace(/[^0-9]/g, '').slice(0, 4);
    if (digits === '') {
      setText('');
      return;
    }
    const n = clamp(parseInt(digits, 10));
    setText(String(n));
    onChange(n);
  };

  const valueColor = warn ? color.status.danger : color.text.primary;

  const btn = (dir: -1 | 1, label: string, enabled: boolean) => (
    <Pressable
      onPress={() => enabled && onChange(clamp(value + dir))}
      // A long press REPLACES the tap rather than repeating it — React Native
      // suppresses `onPress` once `onLongPress` has fired, so there is no
      // double-count at the start of a run.
      onLongPress={() => enabled && startHold(dir)}
      onPressOut={stopHold}
      delayLongPress={300}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Hold to repeat"
      // Bordered rather than a bare glyph so the tappable area is obvious.
      style={({ pressed }) => [
        styles.stepBtn,
        {
          backgroundColor: color.bg.elevated,
          borderColor: color.border.muted,
          opacity: !enabled ? 0.3 : pressed ? 0.6 : 1,
        },
      ]}
    >
      <Text style={[styles.stepGlyph, { color: color.text.primary }]}>
        {dir === -1 ? '−' : '+'}
      </Text>
    </Pressable>
  );

  return (
    <View style={styles.stepRow}>
      {btn(-1, 'Decrease', value > min)}
      {editing ? (
        <TextInput
          value={text}
          onChangeText={type}
          onBlur={() => setEditing(false)}
          onSubmitEditing={() => setEditing(false)}
          autoFocus
          selectTextOnFocus
          keyboardType="number-pad"
          returnKeyType="done"
          maxLength={4}
          accessibilityLabel="Episodes watched"
          style={[
            styles.stepField,
            styles.stepInput,
            {
              backgroundColor: color.bg.surface,
              borderColor: color.accent.base,
              color: valueColor,
            },
          ]}
        />
      ) : (
        <Pressable
          onPress={() => {
            stopHold();
            setText(String(value));
            setEditing(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={`${value}. Tap to type a number`}
          style={({ pressed }) => [
            styles.stepField,
            {
              backgroundColor: color.bg.surface,
              borderColor: color.border.muted,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <Text style={[styles.stepValue, { color: valueColor }]}>{value}</Text>
          {/* The pencil IS the "you can type here" signal — a number that just
              sits in a box reads as a readout, however it is bordered. Pinned to
              the right edge rather than laid out beside the digits so the number
              stays centred in the field for any number of digits. */}
          <View style={styles.stepPen}>
            <AppIcon name="edit" size={13} color={color.text.secondary} />
          </View>
        </Pressable>
      )}
      {btn(1, 'Increase', value < max)}
    </View>
  );
}

/** A labelled on/off row. */
function Toggle({
  label,
  help,
  value,
  onChange,
}: {
  label: string;
  help: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const { color } = useTheme();
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleText}>
        <Text style={[styles.toggleLabel, { color: color.text.primary }]}>{label}</Text>
        <Text style={[styles.toggleHelp, { color: color.text.muted }]}>{help}</Text>
      </View>
      <Pressable
        onPress={() => onChange(!value)}
        accessibilityRole="switch"
        accessibilityState={{ checked: value }}
        accessibilityLabel={label}
        style={[
          styles.track,
          {
            backgroundColor: value ? color.accent.base : color.bg.elevated,
            borderColor: value ? color.accent.base : color.border.muted,
          },
        ]}
      >
        <View
          style={[
            styles.knob,
            {
              backgroundColor: value ? color.bg.primary : color.text.secondary,
              alignSelf: value ? 'flex-end' : 'flex-start',
            },
          ]}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radii.xl + 4,
    borderTopRightRadius: radii.xl + 4,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    maxHeight: '86%',
  },
  grabber: {
    width: 38,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: spacing.md,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  headText: { flex: 1, gap: 1 },
  headTitle: {
    fontSize: 10,
    fontFamily: font.bold,
    letterSpacing: 1.6,
  },
  title: { fontSize: 16, fontFamily: font.semibold, lineHeight: 21 },
  close: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  body: { flexGrow: 0 },
  bodyInner: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.lg },

  field: { gap: spacing.sm },
  fieldHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fieldLabel: { fontSize: 10, fontFamily: font.bold, letterSpacing: 1.3 },
  fieldHint: { fontSize: 12, fontFamily: font.medium, fontVariant: ['tabular-nums'] },

  // Three across on a phone: two would leave labels truncating, one would be a
  // list taller than the sheet.
  statusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  statusCell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    // 30% + two 8px gaps lands just under a third of a 393dp screen, so three
    // fit and `Rewatching` has room.
    flexBasis: '30%',
    flexGrow: 1,
    height: 38,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  statusLabel: { fontSize: 12.5, fontFamily: font.medium, flexShrink: 1 },

  stepRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stepBtn: {
    width: 44,
    height: 38,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepGlyph: { fontSize: 19, fontFamily: font.medium, lineHeight: 22 },
  // The number is dressed as a field between the two buttons — a value you can
  // tap and edit has to look like one, or the type path is undiscoverable.
  // `flex: 1` so the three controls split the row and the number stays centred.
  stepField: {
    flex: 1,
    height: 38,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepValue: {
    fontSize: 17,
    fontFamily: font.semibold,
    fontVariant: ['tabular-nums'],
  },
  // Absolute so the digits do not have to shift to make room for it.
  stepPen: {
    position: 'absolute',
    right: 7,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  // The same box, as an input: `paddingVertical: 0` because Android adds its own
  // and it would push the number off-centre otherwise.
  stepInput: {
    paddingVertical: 0,
    paddingHorizontal: spacing.sm,
    textAlign: 'center',
    fontSize: 17,
    fontFamily: font.semibold,
    fontVariant: ['tabular-nums'],
  },
  help: { fontSize: 11.5, fontFamily: font.regular, lineHeight: 16 },

  scoreRow: { flexDirection: 'row', gap: 4 },
  scoreCell: {
    flex: 1,
    height: 34,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreCellText: {
    fontSize: 11,
    fontFamily: font.bold,
    fontVariant: ['tabular-nums'],
  },
  clear: { fontSize: 11.5, fontFamily: font.medium, textAlign: 'center', marginTop: 2 },

  // `segRow` / `seg` / `segText` went with the priority control — see the header.

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  toggleText: { flex: 1, gap: 2 },
  toggleLabel: { fontSize: 14.5, fontFamily: font.semibold },
  toggleHelp: { fontSize: 11.5, fontFamily: font.regular, lineHeight: 16 },
  track: {
    width: 46,
    height: 28,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 3,
    justifyContent: 'center',
  },
  knob: { width: 22, height: 22, borderRadius: 11 },

  error: { fontSize: 12.5, fontFamily: font.medium, lineHeight: 17 },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  // `flex: 1` on both halves, so with no Remove the Save button spans the row and
  // with one they are equal. Nothing here is a fixed width — a narrow Remove beside
  // a wide Save reads as a prompt for permission rather than as a row of actions.
  action: {
    flex: 1,
    height: 48,
    borderRadius: radii.full,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  // Outlined rather than filled: it sits a centimetre from Save and must not
  // compete with it. Danger is carried by the border and the label, not by a
  // filled red pill that would out-weigh the action people came here to take.
  removeBtn: { borderWidth: StyleSheet.hairlineWidth },
  saveBtn: {},
  actionText: { fontSize: 15, fontFamily: font.semibold, letterSpacing: 0.2 },
  saveText: { fontFamily: font.bold },
});