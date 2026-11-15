// The character info sheet — who this is, in as much detail as AniList actually
// has.
//
// WHY A SHEET AND NOT A SCREEN. This is the same argument as `ListEntrySheet`,
// and for the same reason: the user's intent is "tell me about this and get back
// to what I was doing." A push in each direction plus a back gesture to undo a
// mis-tap is a lot of navigation for a read-only panel. So: a real `Modal`, a
// fading scrim, a sheet that slides, swipe-down to dismiss, and a dismiss that
// ANIMATES OUT before unmounting — a hard `visible={false}` cuts the sheet off
// mid-flight and reads as a glitch.
//
// IT IS A SHEET RATHER THAN A SCREEN ALSO BECAUSE IT OPENS FROM TWO PLACES. The
// detail page's character strip and the cast page's cards are both lists the user
// is partway through, and taking them to a route and back for a portrait's worth
// of information is a worse trade than covering what they were reading.
//
// THE LAYOUT IS ONE HERO AND THREE SECTIONS, and that is the whole redesign. The
// previous version stacked the name, then the native name, then a portrait, then
// a stray favourites row, then the description, then a row of five bordered
// boxes — every element its own band, with a gap between bands and nothing else
// holding it together. It read as a settings screen rather than a person.
//
// Now the portrait sits BESIDE the name instead of below it, so identity is one
// glance: who this is, what they are called, and what they look like are a
// single object at the top of the sheet. Below that, three labelled sections with
// hairline rules: the description, the sparse facts, and where they turn up. The
// eye has three places to go and no fourth.
//
// THE DESIGN IS BUILT AROUND WHAT ANILIST DOES NOT HAVE, which is the whole
// problem. Measured across a sample of real characters:
//
//   description   16/17     native name   15/17     gender      12/17
//   favourites    14/17     age            7/17     bloodType     6/17
//   dateOfBirth    2/17
//
// So more than half of them have no age and nearly none have a birthday. A sheet
// that renders a fixed "Age / Birthday / Blood type" table would show two to four
// empty rows for most characters and read as broken rather than sparse. So the
// facts are ROWS THAT RENDER ONLY WHEN ANILIST HAS THE VALUE — a character with
// only a gender gets one line, a character with everything gets four, and both
// look deliberate. (The earlier chips were right about omission and wrong about
// shape: five bordered boxes is a card grid for data that is usually two items.)
//
// AND THE DESCRIPTION IS NOT GUARANTEED EITHER — 1 in 17 has none, and it is the
// one field someone opened this sheet for. So it has its own empty state that
// says so plainly, instead of the sheet silently ending after the name.
//
// THE LIKE BUTTON IS THE ONE WRITE IN THE SHEET. It is here rather than in a
// menu because liking someone is the reaction you have in the moment you read
// them, and burying it one level down means most people never do it. It lives
// directly under the hero, OUTSIDE the scroll — not as an afterthought but
// because a control that scrolls away is a control you cannot reach once you have
// read far enough to want it.
//
// IT WRITES TO ANILIST, which this file previously claimed was impossible. It is
// bound to `Character.isFavourite` — a boolean riding on the request below — and
// saves through `ToggleFavourite(characterId:)`. An earlier version kept a local
// store on the belief that no such mutation existed, and it could not see anything
// the user had already favourited on the website. See
// `lib/anilist/characterFavourite.ts`, which keeps that mistake on the record.
//
// WHAT IS NOT HERE, and why. Height, weight and occupations are on every
// character-profile UI ever built and NONE of them exist on AniList's `Character`
// type — introspection confirms it, and requesting them is a hard `400`, not a
// null. A profile that showed "Height —" forever would be worse than one that
// doesn't ask. AniList's own staff descriptions (`modNotes`) are moderation
// internals and are not surfaced.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { openAnime, pushOnce } from '@/lib/nav/pushOnce';
import {
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/ui/useTheme';
import { font, motion, radii, spacing } from '@/lib/ui/tokens';
import { mediaTitle, type CharacterDetail, type MediaItem } from '@/lib/anilist';
import { useCharacter } from '@/lib/query/hooks';
import { qk } from '@/lib/query/keys';
import {
  useToggleCharacterFavourite,
  useCharacterSignedIn,
  useToggleCharacterFavouriteSignedIn,
} from '@/lib/query/characterFavourites';
import {
  forgetLike,
  isLikelyUndo,
  paceDelay,
  retryInSeconds,
} from '@/lib/anilist/favouritePacing';
import { useUserId } from '@/lib/auth/session';
import { formatLabel } from '@/components/anime/format';
import { AppIcon } from './AppIcon';
import { SignInGate } from './SignInGate';
import type { CharacterSheetTarget } from '@/lib/anime/characterSheet';

const DISMISS_AT = 96;
const FLICK_V = 0.6;

/** One breath of the skeleton pulse. Slow reads as calm, fast reads as panic. */
const BREATH_MS = 1100;
/** The floor — plates never vanish, they just dim. */
const MIN_OPACITY = 0.45;

/** How many description lines the sheet shows before it offers the rest. */
const CLAMP_LINES = 5;

export function CharacterSheet({
  visible,
  target,
  onClose,
}: {
  visible: boolean;
  target: CharacterSheetTarget | null;
  onClose: () => void;
}) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const progress = useSharedValue(0);
  const dragY = useSharedValue(0);
  const sheetHeight = useSharedValue(600);
  const startY = useSharedValue(0);

  /**
   * THE SHEET'S OWN REQUEST, keyed on the tapped character's id.
   *
   * It is enabled by `visible` AND the id being real, so a closed sheet — which is
   * what this component is, for the whole session — never fires anything. That is
   * the same reason `ListSheetHost` gates its entry query: the host is mounted at
   * the root and must be free until something is actually tapped.
   *
   * Re-keying on a different character is what makes tapping a second portrait
   * work without closing anything: the query moves to the new id and the sheet
   * shows that person. `placeholderData` is NOT used, because holding the previous
   * character's description on screen under the next character's name is a lie.
   */
  const userId = useUserId();
  const signedIn = userId != null;
  // Signed-in visitors get detail + favourite in ONE request; signed-out
  // visitors get the public (cached, persisted) detail only.
  const publicChar = useCharacter(target?.id ?? 0, {
    enabled: visible && target != null && !signedIn,
  });
  const signedChar = useCharacterSignedIn(target?.id ?? 0, {
    enabled: visible && target != null && signedIn,
  });
  const data = signedIn ? signedChar.data : publicChar.data;
  const isPending = signedIn ? signedChar.loading : publicChar.isPending;
  const isError = publicChar.isError;
  const refetch = signedIn ? signedChar.refetch : publicChar.refetch;
  const characterId = target?.id ?? 0;
  const favIsFavourite = signedIn ? signedChar.isFavourite : undefined;
  const toggleSigned = useToggleCharacterFavouriteSignedIn(characterId);
  const togglePublic = useToggleCharacterFavourite(characterId);
  const favToggle = signedIn ? toggleSigned : togglePublic;

  /**
   * A CHARACTER WITH NO ID IS NOT LOADING, AND MUST NOT LOOK LIKE IT.
   *
   * `useCharacter` is gated on `id > 0`, so a target without one leaves the query
   * permanently disabled — and `isPending` stays `true` forever, which put a sheet
   * on screen showing a skeleton that would never resolve. That is the failure
   * mode this line exists to prevent, and it is not hypothetical: it is what a
   * restored cache written before `MediaCharacter` carried an `id` produced.
   *
   * The fix at the time was `CACHE_VERSION` (see `lib/query/persister.ts`), which
   * discards such a cache. This is the second half: even with the version bumped,
   * an id-less target should say so rather than spin. So it is reported as an
   * error and gets the same retry affordance, which cannot fix it but is honest
   * about the state — and a retry would succeed if the id arrives from a later
   * payload.
   *
   * The like control checks the id itself, on the press, rather than taking this as
   * a prop: there is no id to write `ToggleFavourite` against, so a button that
   * looked live and did nothing would be a worse lie than one that is visibly
   * unavailable.
   */
  const unusable = visible && target != null && !(target.id > 0);

  /**
   * THE SIGN-IN GATE, because the favourite lives on the account and not here.
   *
   * `useUserId` is `undefined` while the session is still being read and `null` for
   * a guest, so this is `false` until the answer is known — which is the safe
   * direction: the button asks rather than firing a request that would 401.
   */
  const [gateOpen, setGateOpen] = useState(false);
  const openSignInGate = useCallback(() => setGateOpen(true), []);
  const closeSignInGate = useCallback(() => setGateOpen(false), []);
  const goSignIn = useCallback(() => {
    setGateOpen(false);
    onClose();
    pushOnce('/login');
  }, [onClose]);

  useEffect(() => {
    if (visible) {
      progress.value = withTiming(1, { duration: motion.normal });
      // Back to zero on the way IN too, not just out. If a swipe-dismiss left
      // `dragY` at screen height, the next open would animate `progress` to 1 with
      // the sheet already dragged off the bottom — invisible, and it reads as a
      // dead button rather than as a bug.
      dragY.value = 0;
    }
  }, [visible, progress, dragY]);

  const dismiss = useCallback(() => {
    dragY.value = withTiming(0, { duration: motion.fast });
    progress.value = withTiming(0, { duration: motion.fast }, (finished) => {
      if (finished) runOnJS(onClose)();
    });
  }, [dragY, progress, onClose]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  /**
   * SWIPE DOWN TO DISMISS — the same gesture contract as `ListEntrySheet`, and the
   * same `PanResponder` rather than `react-native-gesture-handler`, which is not a
   * dependency and would need a development build.
   *
   * The drag zone is the GRABBER AND HERO ONLY. The body is a `ScrollView`, and a
   * pan responder on an ancestor of a ScrollView competes with it for the same
   * vertical gesture — which is the reason it is bounded rather than applied to the
   * container. It is also the convention: you pull a sheet by its handle, because
   * the content in front of you might want to scroll.
   *
   * TRANSLATE ONLY. An earlier draft also shrank the sheet's HEIGHT as you pulled
   * it, which is what a platform sheet does and what reads best in theory. It does
   * not work here, for a reason worth writing down so nobody tries it again: the
   * sheet's height is discovered by `onLayout`, so an animated height feeds its
   * own measurement back in and every frame shrinks it a little further until it
   * hits the floor. The only way out is to pin the height, and then the sheet can
   * never discover its own natural size in the first place. A sheet that is
   * dragged rather than resized is also the established contract in this app —
   * `ListEntrySheet` behaves the same way — and matching it is worth more than
   * the extra half-second of physics.
   */
  const finishDrag = useCallback(
    (dy: number, velocity: number) => {
      const h = sheetHeight.value;
      const far = dy > Math.max(DISMISS_AT, h * 0.25);
      if (far || velocity > FLICK_V) {
        // Drive it off and unmount WHEN THAT FINISHES. Setting `progress` alone
        // would animate back up from 28px instead of continuing the drag, which
        // reads as the sheet bouncing rather than leaving.
        //
        // `runOnJS` on the completion rather than a `setTimeout`, which would fire
        // after an unmount and race a reopen.
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
        // button is still a tap.
        onMoveShouldSetPanResponder: (_e, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderGrant: () => {
          startY.value = dragY.value;
        },
        onPanResponderMove: (_e, g) => {
          const next = startY.value + g.dy;
          // Downward only. An upward drag is clamped rather than allowed, because a
          // sheet that can be pulled off the top of the screen is a sheet with a
          // second, undocumented behaviour.
          dragY.value = next > 0 ? next : 0;
        },
        onPanResponderRelease: (_e, g) => finishDrag(dragY.value, g.vy),
        onPanResponderTerminate: (_e, g) => finishDrag(dragY.value, g.vy),
      }),
    [dragY, startY, finishDrag]
  );

  // The scrim fades WITH the drag rather than at the end of it, so the gesture
  // reads as one continuous motion.
  const scrimDragStyle = useAnimatedStyle(() => ({
    opacity: progress.value * Math.max(0, 1 - dragY.value / 240),
  }));

  const sheetStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 28 + dragY.value }],
  }));

  const detail = data ?? null;
  const name = target?.name ?? '';

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
              paddingBottom: insets.bottom + spacing.md,
            },
            sheetStyle,
          ]}
          onLayout={(e) => {
            // Measured so the dismiss threshold scales with the sheet rather than
            // being a pixel count that means different things on a short and a
            // tall character.
            sheetHeight.value = e.nativeEvent.layout.height;
          }}
        >
          <View {...pan.panHandlers}>
            <View style={[styles.grabber, { backgroundColor: color.border.strong }]} />

            {/* THE HERO. Portrait and identity as one object — the portrait is
                left of the words rather than above them, so nothing is read
                before the thing it describes is seen. */}
            <View style={styles.hero}>
              <Portrait uri={target?.image} />

              <View style={styles.heroText}>
                <Text style={[styles.kicker, { color: color.text.muted }]}>
                  {target?.role ? roleLabel(target.role) : 'Character'}
                </Text>
                <Text style={[styles.title, { color: color.text.primary }]} numberOfLines={2}>
                  {name}
                </Text>
                {detail?.nativeName ? (
                  <Text style={[styles.native, { color: color.text.secondary }]} numberOfLines={1}>
                    {detail.nativeName}
                  </Text>
                ) : null}
                {detail?.alternativeName ? (
                  <Text style={[styles.native, { color: color.text.muted }]} numberOfLines={1}>
                    {detail.alternativeName}
                  </Text>
                ) : null}
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

          {/* THE ONE WRITE. Outside the scroll on purpose — see the header note. */}
          <View style={styles.actionBar}>
            <LikeButton
              characterId={target?.id ?? 0}
              name={name}
              signedIn={signedIn}
              onNeedSignIn={openSignInGate}
              isFavourite={favIsFavourite}
              toggle={{
                mutate: () => favToggle.mutate(),
                isPending: favToggle.isPending,
                error: favToggle.error,
              }}
            />
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyInner}
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            {(isPending || unusable) && !detail ? (
              // The sheet's geometry rather than a spinner, matching the rule every
              // screen here already follows: nothing that says "working" on top of
              // empty space. `unusable` is in this branch because an id-less target
              // leaves the query disabled forever, so `isPending` alone would be a
              // promise this sheet cannot keep — see the note on `unusable`.
              <CharacterSkeleton />
            ) : null}

            {(isError || unusable) && !detail ? (
              <View style={styles.errorBox}>
                <Text style={[styles.error, { color: color.status.danger }]}>
                  {unusable
                    ? 'This character could not be looked up.'
                    : 'Could not load this character.'}
                </Text>
                <Pressable
                  onPress={() => void refetch()}
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    styles.retry,
                    { backgroundColor: color.accent.muted, opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <Text style={{ color: color.text.primary, fontFamily: font.semibold }}>
                    Try again
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {detail ? <Description text={detail.description} /> : null}

            {detail ? <Facts detail={detail} /> : null}

            {detail?.media?.length ? (
              <Appearances media={detail.media} currentAnime={target?.animeTitle} onOpen={onClose} />
            ) : null}
          </ScrollView>
        </Animated.View>

        {/* Mounted OUTSIDE the sheet's own Modal. `SignInGate` is a Modal of its
            own, and a Modal inside a Modal on Android does not reliably stack — the
            inner one renders behind the outer one and the gate becomes an
            undismissable black screen. Closing the sheet first, as `goSignIn` does,
            sidesteps the question entirely: there is only ever one window open. */}
        <SignInGate
          visible={gateOpen}
          title={name}
          onClose={closeSignInGate}
          onSignIn={goSignIn}
        />
      </View>
    </Modal>
  );
}

/**
 * THE PORTRAIT, which is the one thing here that can be missing.
 *
 * `CharacterSheetTarget.image` is `null` for a character AniList has no art for,
 * which happens, so the plate holds the user's placeholder rather than collapsing
 * the hero's layout. Source is the TARGET and not `CharacterDetail`, because the
 * target has it on the first frame and the sheet must never open to a hole where
 * the face should be while a request it already answered from memory is in
 * flight.
 */
function Portrait({ uri }: { uri?: string | null }) {
  const { color } = useTheme();
  return (
    <View style={[styles.portrait, { backgroundColor: color.bg.surface }]}>
      {uri ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={200}
          cachePolicy="memory-disk"
          // The portrait is the first thing in the sheet and it is also the image
          // the user was already looking at, so it is very likely warm in the disk
          // cache — and if not, it should beat anything else the sheet might want.
          priority="high"
        />
      ) : (
        <AppIcon name="user" size={26} color={color.text.muted} />
      )}
    </View>
  );
}

/**
 * THE LIKE BUTTON — AniList's favourite flag for one character.
 *
 * A labelled pill rather than a bare heart in the corner, because "is this liked"
 * is a state and a bare glyph makes you read the glyph to learn it. Labelled, the
 * state is the text — and the text is also what a screen reader announces, which a
 * heart with no label does not do.
 *
 * IT IS ANILIST'S OWN FLAG, not a local opinion. The button is bound to
 * `CharacterDetail.isFavourite`, which is one boolean riding on the request this
 * sheet was making anyway, and the write is `ToggleFavourite(characterId:)`. So a
 * character you favourited on the website is already `Liked` when this sheet opens,
 * and the same heart appears on the cast cards behind you. See
 * `lib/anilist/characterFavourite.ts` — which also records that a local-only
 * version of this used to exist, could not see the user's real favourites, and was
 * therefore wrong.
 *
 * RED WHEN ON. `color.like.base`, a dedicated palette role rather than
 * `status.danger` (which means error) or a hex in this file. The fill is what makes
 * the state read at a glance — an outlined-versus-filled heart is legible in
 * greyscale only if you already know what it means — and the app is otherwise
 * monochrome, so this is the one place colour carries meaning rather than
 * decoration.
 *
 * THE POP. A like is a reaction, so it answers immediately: the glyph springs on
 * the press, on the UI thread, so the acknowledgement survives the JS work the
 * mutation's optimistic write triggers. `useReducedMotion` makes it a straight
 * state change with no scale, which is the same contract every other animation here
 * honours.
 */
function LikeButton({
  characterId,
  name,
  signedIn,
  onNeedSignIn,
  isFavourite,
  toggle,
}: {
  characterId: number;
  name: string;
  signedIn: boolean;
  onNeedSignIn: () => void;
  isFavourite: boolean | undefined;
  toggle: { mutate: () => void; isPending: boolean; error: unknown };
}) {
  const { color } = useTheme();
  const queryClient = useQueryClient();
  const reduced = useReducedMotion();
  const pop = useSharedValue(0);

  /**
   * THE FLAG IS ITS OWN QUERY, not a field on the character payload.
   *
   * It was a field, and it reported `Like` on characters that were already
   * favourited — because that payload is cached on disk for seven days, so the value
   * came back from a signed-out session. See `lib/query/characterFavourites.ts`.
   *
   * `undefined` is a real third state and the button has to survive it: during the
   * first frame of the sheet there is genuinely no answer yet. Printing a confident
   * `Like` there is precisely the bug that made this look broken, so an unknown
   * state renders a dimmed, non-committal control instead.
   */
  // isFavourite and toggle are passed in from the parent, which owns the
  // (combined, when signed in) query. Nothing is fetched here.

  /**
   * THE TWO-LAYER ABUSE GUARD. See `lib/anilist/favouritePacing.ts` for why this
   * exists and why it is stricter than the app's other write paths — `favourites`
   * is a public counter other people can see, so churn here is not private.
   *
   * `throttled` is read on every render rather than captured once, because both
   * conditions are time-based and the button has to recover on its own once the
   * window passes. A tap inside it is simply refused rather than queued: the user
   * did not ask to wait, and a like that lands ten seconds after they gave up on
   * it is worse than one that did not happen.
   */
  const [throttleMsg, setThrottleMsg] = useState<string | null>(null);
  const coolingRef = useRef(false);
  coolingRef.current = throttleMsg != null;

  /**
   * The cooling flag has to expire on its own, because the window it is waiting for
   * is in ANOTHER module and nothing re-renders when it passes. One second is
   * deliberately shorter than the 900ms floor: by the time the user could look at
   * the button and tap again, the guard has already lifted and the refusal is
   * invisible. It exists to absorb a burst of taps, not to be read.
   */
  useEffect(() => {
    if (!throttleMsg) return;
    const t = setTimeout(() => setThrottleMsg(null), 1000);
    return () => clearTimeout(t);
  }, [throttleMsg]);

  const glyph = useAnimatedStyle(() => ({ transform: [{ scale: 1 + pop.value * 0.2 }] }));

  /**
   * A FAILED WRITE SAYS SO, AND SAYS IT LOUDLY.
   *
   * `onError` restores the previous value, so without this the heart fills, empties
   * again a moment later, and the user is told absolutely nothing — which is
   * indistinguishable from a button that is broken, and is how this presented. A
   * small line of muted red under a pill is still easy to miss while a finger is on
   * the screen, so this is a full-width row with the reason in it.
   *
   * The message is AniList's own, passed through verbatim. An expired session is the
   * common failure and it has a real remedy, so inventing a vaguer sentence here
   * would throw away the one piece of information that tells the user what to do.
   */
  const failure = toggle.error instanceof Error ? toggle.error.message : null;

  /**
   * UN-LIKING RIGHT AFTER LIKING IS A MIS-TAP, and it is answered locally.
   *
   * The heart visibly fills, so the instant un-like is almost always "that was not
   * what I meant" rather than a decision — and it is the one direction that churns
   * a shared, public counter. So it is treated as an undo: the local state flips
   * back and no request goes out at all. An un-like more than six seconds later is
   * a decision and behaves normally.
   *
   * Nothing here is hidden. If AniList was never told, this app's heart is a lie
   * until the next read reconciles it — and the five-minute `staleTime` plus
   * `refetchStaleOnForeground` is what does, which is a few minutes of a
   * divergence traded for not touching a counter everyone can see. The alternative
   * is spending a request on every thumb spasm.
   */
  const undo = useCallback(() => {
    queryClient.setQueryData<boolean>(qk.characterFavourite(characterId), (prev) =>
      prev === undefined ? prev : !prev
    );
    forgetLike(characterId);
  }, [characterId, queryClient]);

  const onPress = useCallback(() => {
    // A signed-out tap must not reach AniList to be told 401 — that is a request
    // spent to learn something `getToken` already knows. The gate answers the real
    // question instead, which is the one worth asking.
    if (!signedIn) {
      onNeedSignIn();
      return;
    }
    // Same guard on the id: an id-less target cannot be written against, and a
    // button that looked live and did nothing would be a worse lie than one that is
    // visibly unavailable.
    if (!(characterId > 0)) return;
    if (coolingRef.current) return;

    // Layer 1 — the undo window. Checked BEFORE pacing, because it costs nothing
    // and removes the request outright.
    if (isFavourite === true && isLikelyUndo(characterId)) {
      undo();
      return;
    }

    // Layer 2 — pacing. A refusal, never a queue: a like that lands ten seconds
    // after the user gave up on it is worse than one that never happened.
    const wait = paceDelay();
    if (wait > 0) {
      // Two different waits with two different meanings, and conflating them would
      // be a lie. The floor is sub-second — a thumb was too fast, and saying
      // nothing is right. The per-window ceiling is up to a minute, and a user
      // genuinely cannot write right now, so it is named with the real number.
      setThrottleMsg(
        wait > 5000
          ? `AniList is rate-limiting favourite changes — try again in ${retryInSeconds()}s`
          : 'Easy — that was too fast'
      );
      return;
    }

    if (!reduced) {
      pop.value = 0;
      pop.value = withSequence(
        withTiming(1, { duration: 110, easing: Easing.out(Easing.quad) }),
        withSpring(0, { damping: 9, stiffness: 320 })
      );
    }
    toggle.mutate();
    // `cooling` is deliberately absent: the guard reads it through `coolingRef`, so
    // including it would rebuild this callback on every flag flip for no behavioural
    // change — and a `useCallback` that changes identity mid-gesture is exactly the
    // kind of thing that makes a touch handler feel unreliable.
  }, [characterId, isFavourite, onNeedSignIn, pop, reduced, signedIn, toggle, undo]);

  const on = isFavourite === true;
  // Signed out is not "unknown" — there is no account to hold a favourite, so an
  // unliked heart is the honest and stable answer there.
  const known = isFavourite !== undefined || !signedIn;

  return (
    <View style={styles.likeWrap}>
      <Pressable
        onPress={onPress}
        // Disabled only while the WRITE is in flight, and that is load-bearing
        // rather than tidy: `ToggleFavourite` is a toggle, so two mutations racing
        // would invert the account's truth and leave the heart right and AniList
        // wrong.
        disabled={toggle.isPending}
        accessibilityRole="button"
        accessibilityState={{ disabled: toggle.isPending, selected: on }}
        accessibilityLabel={
          on ? `Remove ${name} from your favourites` : `Add ${name} to your favourites`
        }
        android_ripple={{ color: color.accent.glow }}
        style={({ pressed }) => [
          styles.like,
          on
            ? { backgroundColor: color.like.base, borderColor: color.like.base }
            : { backgroundColor: color.bg.surface, borderColor: color.border.muted },
          !known ? styles.likePending : null,
          { opacity: toggle.isPending ? 0.7 : pressed ? 0.7 : 1 },
        ]}
      >
        <Animated.View style={glyph}>
          <AppIcon
            name="heart"
            size={17}
            strokeWidth={2.2}
            color={on ? color.like.on : known ? color.text.secondary : color.text.muted}
            fill={on ? color.like.on : undefined}
          />
        </Animated.View>
        <Text style={[styles.likeLabel, { color: on ? color.like.on : color.text.primary }]}>
          {on ? 'Liked' : 'Like'}
        </Text>
      </Pressable>

      {/*
        THROTTLED IS SHOWN, NOT SILENTLY DROPPED. A tap that is refused by the
        pacing guard and gives no feedback reads as a broken button — the same
        failure the error banner exists to prevent. It is a quiet line rather than
        the red plate because nothing is wrong: the guard is working.
      */}
      {throttleMsg ? (
        <Text style={[styles.likeThrottled, { color: color.text.muted }]}>{throttleMsg}</Text>
      ) : failure ? (
        <View style={[styles.likeError, { backgroundColor: color.status.danger, borderColor: color.status.danger }]}>
          <AppIcon name="info" size={13} color={color.text.primary} />
          <Text style={[styles.likeErrorText, { color: color.text.primary }]}>{failure}</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * THE DESCRIPTION, or an honest absence of one.
 *
 * Clamped rather than expanded, because the median is ~440 characters and the
 * longest is ~2800 — long enough that a sheet which always expands pushes its
 * appearance rail off the bottom.
 *
 * THE CONTROL APPEARS ONLY IF THERE IS SOMETHING TO REVEAL, measured rather than
 * assumed: a character whose description fits in the clamp gets no "Read more",
 * which is the difference between a disclosure and a lie. The previous version
 * always rendered it, so most characters carried a "Read more" that expanded four
 * lines into four. See the note on the measurer below for how that measurement has
 * to be taken — the obvious way to take it does not work.
 *
 * The empty state matters more than it looks. 1 character in 17 has no description
 * at all, and the description is the reason most people open this. A sheet that
 * just ends after the name reads as though the sheet failed to load; one that says
 * so plainly reads as the answer being "AniList doesn't have one".
 */
function Description({ text }: { text?: string | null }) {
  const { color } = useTheme();
  const [expanded, setExpanded] = useState(false);
  /**
   * How many lines the description takes with NO clamp applied, or 0 before the
   * first measure. See the note on the measurer below for why this cannot come
   * from the visible text.
   */
  const [fullLines, setFullLines] = useState(0);

  const clean = cleanDescription(text);

  useEffect(() => {
    // Re-clamp when the sheet is pointed at a different character, or the next
    // person's description opens fully expanded because the last one was. The line
    // count goes with it: a tall description's overflow says nothing about the
    // short one now on screen.
    setExpanded(false);
    setFullLines(0);
  }, [text]);

  const overflows = fullLines > CLAMP_LINES;

  return (
    <View style={styles.section}>
      <SectionLabel>About</SectionLabel>
      {clean ? (
        <>
          {/* THE MEASURER — invisible, unclamped, and the only way to answer "is
              there anything below the fold".

              `onTextLayout` CANNOT do this on the visible text. It reports the lines
              the text was LAID OUT as, and `numberOfLines` caps the layout itself:
              on iOS the text container is built with `maximumNumberOfLines` before
              a single line is measured, and Android truncates in the same pass. So
              a clamped Text reports at most `CLAMP_LINES` lines and can never
              report one more. Measuring it and comparing against the clamp is not
              "slightly off", it is a comparison that is unsatisfiable — which is
              how this shipped with no Read more button on any character.

              So the string is laid out once, unclamped, off-screen: absolutely
              positioned so it takes no space, transparent so it draws nothing,
              and hidden from both touch and assistive tech. Same width and same
              style as the real text, so the line breaks are identical. One extra
              text layout per sheet open, which is the price of the control being
              right rather than absent. */}
          <View
            style={styles.measure}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Text
              style={[styles.description, { color: 'transparent' }]}
              onTextLayout={(e) => setFullLines(e.nativeEvent.lines.length)}
            >
              {clean}
            </Text>
          </View>

          <Text
            style={[styles.description, { color: color.text.secondary }]}
            numberOfLines={expanded ? undefined : CLAMP_LINES}
          >
            {clean}
          </Text>

          {expanded || overflows ? (
            <Pressable
              onPress={() => setExpanded((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={expanded ? 'Collapse the description' : 'Read the full description'}
              hitSlop={6}
              style={({ pressed }) => [
                styles.disclosure,
                { backgroundColor: color.accent.muted, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Text style={[styles.disclosureText, { color: color.text.primary }]}>
                {expanded ? 'Show less' : 'Read more'}
              </Text>
              <AppIcon
                name={expanded ? 'chevronUp' : 'chevronDown'}
                size={13}
                color={color.text.secondary}
              />
            </Pressable>
          ) : null}
        </>
      ) : (
        <View style={[styles.emptyBox, { borderColor: color.border.muted }]}>
          <Text style={[styles.emptyTitle, { color: color.text.secondary }]}>
            No description on AniList
          </Text>
          <Text style={[styles.emptyBody, { color: color.text.muted }]}>
            Plenty of characters have none recorded — it is not a loading failure.
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * THE SPARSE FACTS, as rows that render only when they have something to say.
 *
 * This is the shape decision the whole sheet turns on. AniList has no height, no
 * weight and no occupations at all, and of the four fields it does have, more than
 * half are missing on any given character. A fixed grid of rows would therefore be
 * mostly dashes — and a row of dashes does not read as "sparse data", it reads as
 * "broken".
 *
 * So each fact renders only when AniList has the value, and the section is omitted
 * entirely when there are none. A character with only a gender gets one line. A
 * character with everything gets four. Both look deliberate, which is the whole
 * requirement.
 *
 * `alternativeName` is NOT here even though it is on 17/17 characters: it is a
 * name, not a fact, so it sits under the real name in the hero where a reader is
 * already looking for names.
 *
 * `birthday` is formatted rather than shown raw because AniList stores it as a
 * `FuzzyDate` — every part independently optional, and in practice most characters
 * have a year or nothing at all (2/17 in the sample).
 */
function Facts({ detail }: { detail: CharacterDetail }) {
  const { color } = useTheme();

  const birthday = useMemo(() => formatBirthday(detail.dateOfBirth), [detail.dateOfBirth]);

  const facts: { label: string; value: string }[] = [];
  if (detail.gender) facts.push({ label: 'Gender', value: titleCase(detail.gender) });
  if (detail.age) facts.push({ label: 'Age', value: detail.age });
  if (birthday) facts.push({ label: 'Born', value: birthday });
  if (detail.bloodType) facts.push({ label: 'Blood type', value: detail.bloodType });
  // Structured facts embedded in the description (e.g. "__Height:__ 190 cm")
  // are pulled out of the bio paragraph and shown here as grid cells.
  for (const f of extractStructuredFacts(detail.description)) {
    if (!facts.some((x) => x.label.toLowerCase() === f.label.toLowerCase())) {
      facts.push(f);
    }
  }

  if (!facts.length) return null;

  return (
    <View style={styles.section}>
      <SectionLabel>Details</SectionLabel>
      <View style={styles.factsGrid}>
        {facts.map((f) => (
          <View key={f.label} style={styles.factCell}>
            <Text style={[styles.factLabel, { color: color.text.muted }]}>{f.label}</Text>
            <Text style={[styles.factValue, { color: color.text.primary }]}>{f.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * WHERE THEY TURN UP — the one part of the sheet that is not biography.
 *
 * Six appearances, popularity-ordered, on a horizontal rail. The cell is a bare
 * poster with its caption underneath and NO border: the previous version boxed
 * each cell in a hairline, which put six identical rectangles in a row and made a
 * list of links look like a table. Only the anime the user arrived from is
 * marked, and it is marked with an accent ring on the art plus a quiet badge
 * beside it — the title itself says nothing about why that one is different.
 */
function Appearances({
  media,
  currentAnime,
  onOpen,
}: {
  media: MediaItem[];
  currentAnime?: string | null;
  onOpen: () => void;
}) {
  const { color } = useTheme();

  return (
    <View style={styles.section}>
      <SectionLabel>Appears in</SectionLabel>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.appearRail}
        // A nested horizontal rail inside the sheet's vertical ScrollView is the
        // one orientation pairing RN does not object to.
      >
        {media.map((m) => {
          const title = mediaTitle(m.title);
          const isCurrent = currentAnime != null && title === currentAnime;
          return (
            <Pressable
              key={m.id}
              onPress={() => {
                // Close first, then navigate. A `Modal` is its own window, so
                // pushing a route with one still open leaves it floating over the
                // new screen until something clears it.
                onOpen();
                // Guarded — see `lib/nav/pushOnce.ts`.
                openAnime(m.id);
              }}
              accessibilityRole="button"
              accessibilityLabel={isCurrent ? `${title}, the anime you are viewing` : title}
              style={({ pressed }) => [styles.appearCell, { opacity: pressed ? 0.7 : 1 }]}
            >
              <View
                style={[
                  styles.appearArt,
                  {
                    backgroundColor: color.bg.surface,
                    // The ring is ON the art, not around the cell, so it points at
                    // the picture rather than at the caption below it.
                    borderColor: isCurrent ? color.accent.base : 'transparent',
                    borderWidth: isCurrent ? 1.5 : 0,
                  },
                ]}
              >
                {m.coverImage?.large ? (
                  <Image
                    source={{ uri: m.coverImage.large }}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                    transition={150}
                    cachePolicy="memory-disk"
                  />
                ) : (
                  <AppIcon name="tv" size={18} color={color.text.muted} />
                )}
              </View>
              <Text
                style={[styles.appearTitle, { color: color.text.secondary }]}
                numberOfLines={2}
              >
                {title}
              </Text>
              <Text style={[styles.appearMeta, { color: color.text.muted }]} numberOfLines={1}>
                {[formatLabel(m.format), m.seasonYear].filter(Boolean).join(' · ')}
              </Text>
              {isCurrent ? (
                <Text style={[styles.appearHere, { color: color.accent.base }]}>
                  You&rsquo;re here
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/**
 * A section heading. One definition so "About", "Details" and "Appears in" are
 * literally the same thing — they are a typographic system, and three hand-tuned
 * variants of the same 10px caps is how they drift apart.
 */
function SectionLabel({ children }: { children: React.ReactNode }) {
  const { color } = useTheme();
  return <Text style={[styles.sectionLabel, { color: color.text.muted }]}>{children}</Text>;
}

/**
 * THE WAITING STATE, and it BREATHES — same reason `HomeSkeleton` breathes and for
 * the same reason, which is that a request is in flight and the JS thread is about
 * to be busy.
 *
 * Shaped like the real sections — a couple of text lines and a ruled row — rather
 * than as three bars floating in space, so the layout does not visibly rearrange
 * itself when the data lands. Three static bars was also wrong twice over: it was
 * static, so a request that took a moment left the sheet looking frozen rather than
 * working; and it was ON THE JS THREAD, so it could not have animated anyway. The
 * pulse is a Reanimated shared value looping on the UI thread, which means it keeps
 * breathing through exactly the JS work this sheet is waiting on. That is the whole
 * reason this file is allowed to use Reanimated rather than RN's `Animated`.
 *
 * `useReducedMotion` parks it at full strength with no loop, which is the same
 * contract every other skeleton in the app honours.
 */
function CharacterSkeleton() {
  const { color } = useTheme();
  const breath = useSharedValue(MIN_OPACITY);
  const reduced = useReducedMotion();

  // Started in an EFFECT rather than during render — writing a shared value while
  // React renders is what Reanimated's strict mode warns about, and this mounts
  // once per loading state.
  useEffect(() => {
    if (reduced) {
      breath.value = 1;
      return;
    }
    breath.value = withRepeat(
      withTiming(1, { duration: BREATH_MS, easing: Easing.inOut(Easing.quad) }),
      -1,
      true
    );
  }, [breath, reduced]);

  const pulse = useAnimatedStyle(() => ({ opacity: breath.value }));

  return (
    <Animated.View
      style={pulse}
      pointerEvents="none"
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
    >
      <View style={styles.section}>
        <View style={[styles.skelLine, { backgroundColor: color.bg.surface, height: 9, width: 54 }]} />
        <View style={styles.skeletonStack}>
          <View style={[styles.skelLine, { backgroundColor: color.bg.surface, width: '96%' }]} />
          <View style={[styles.skelLine, { backgroundColor: color.bg.surface, width: '100%' }]} />
          <View style={[styles.skelLine, { backgroundColor: color.bg.surface, width: '72%' }]} />
        </View>
      </View>
      <View style={[styles.rule, { backgroundColor: color.border.muted }]} />
      <View style={[styles.skeletonStack, { paddingTop: spacing.lg }]}>
        <View style={[styles.skelLine, { backgroundColor: color.bg.surface, height: 12, width: '42%' }]} />
        <View style={[styles.skelLine, { backgroundColor: color.bg.surface, height: 12, width: '58%' }]} />
      </View>
    </Animated.View>
  );
}

/* --- helpers ---------------------------------------------------------- */

/**
 * AniList's description, as prose.
 *
 * `asHtml: false` is requested, but AniList still emits the occasional tag, and
 * this renders plain `Text` — so the same strip the detail page's synopsis does
 * rather than trusting the flag.
 *
 * The other three are on nearly EVERY row and are not prose:
 *
 *  - `(Source: Manga)` / `(Source: Anime)` — a provenance stamp on almost every
 *    fan description, and the reason a paragraph so often ends mid-sentence on
 *    someone else's citation.
 *  - `**bold**` — markdown emphasis, used for epithets. The asterisks are noise in
 *    a face that has no bold to show them in.
 *  - Runs of newlines, which survive the tag strip and render as dead space.
 */
function extractStructuredFacts(raw?: string | null): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (!raw) return out;
  for (const line of raw.split(/\n/)) {
    const m = line.trim().match(/^__([^_]+?):__\s*(.+)$/);
    if (!m) continue;
    const label = m[1].trim();
    const value = m[2]
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/~!([\s\S]*?)!~/g, '$1')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (label && value) out.push({ label, value });
  }
  return out;
}

function cleanDescription(raw?: string | null): string {
  // Drop the structured "__Label:__ value" lines — they are shown as facts in
  // the Details grid instead of being left in the bio paragraph.
  const withoutStructured = (raw ?? '')
    .split(/\n/)
    .filter((line) => !/^__[^_]+:__/.test(line.trim()))
    .join('\n');
  return withoutStructured
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/~!([\s\S]*?)!~/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\s*\(Source:[^)]*\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function roleLabel(role: string): string {
  if (role === 'MAIN') return 'Main character';
  if (role === 'SUPPORTING') return 'Supporting';
  if (role === 'BACKGROUND') return 'Background';
  return role.charAt(0) + role.slice(1).toLowerCase();
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * `FuzzyDate` is three independently optional numbers, so there is no single
 * "correct" rendering — only three useful ones. Returned as '' when the year is
 * missing, because a month and a day with no year is not a birthday, it is a
 * fragment, and showing "March 14" under "Born" would be a claim AniList is not
 * making.
 *
 * Month names in full, because this is the one field in the sheet with room to
 * breathe: "14 September 2005" reads as a date and "14 Sep 2005" reads as a
 * database column.
 */
function formatBirthday(d?: { year?: number | null; month?: number | null; day?: number | null } | null): string {
  if (!d?.year) return '';
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const month = d.month ? months[d.month - 1] : null;
  if (month && d.day) return `${d.day} ${month} ${d.year}`;
  if (month) return `${month} ${d.year}`;
  return String(d.year);
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radii.xl + 4,
    borderTopRightRadius: radii.xl + 4,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    // Taller than the list sheet's 86% because this one is a read: the description
    // is the point, and a character with a long one plus a facts block plus an
    // appearance rail needs the room.
    maxHeight: '92%',
  },
  grabber: {
    width: 38,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: spacing.md,
  },

  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  portrait: {
    width: 84,
    height: 84,
    borderRadius: radii.lg,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroText: { flex: 1, gap: 2 },
  kicker: {
    fontSize: 10,
    lineHeight: 13,
    fontFamily: font.bold,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  title: { fontSize: 20, lineHeight: 25, fontFamily: font.bold },
  native: { fontSize: 12, lineHeight: 16, fontFamily: font.medium },
  close: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },

  actionBar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  /** Wraps the button so a failure message can appear under it without
   *  reflowing the sections below, which are inside a ScrollView. */
  likeWrap: { gap: spacing.xs },
  /**
   * A failed write is shown as a filled plate rather than a line of coloured text,
   * because it is the difference between the user knowing the tap failed and
   * thinking the button is broken — and this is the one control in the sheet that
   * can fail for reasons outside the app's control.
   */
  likeError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  likeErrorText: { flex: 1, fontSize: 12, lineHeight: 16, fontFamily: font.medium },
  likeThrottled: {
    fontSize: 11.5,
    lineHeight: 15,
    fontFamily: font.medium,
    textAlign: 'center',
  },
  like: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md - 1,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  likeDisabled: { opacity: 0.4 },
  /** No heart state yet — the query has not resolved. Quiet, not confidently off. */
  likePending: { opacity: 0.55 },
  likeLabel: { fontSize: 14, lineHeight: 18, fontFamily: font.semibold, letterSpacing: 0.2 },

  /**
   * `flexShrink: 1` is load-bearing. The sheet is capped by `maxHeight`, and a
   * ScrollView that cannot shrink reports its full content height to the layout —
   * so a long description would be CLIPPED at the bottom of the sheet instead of
   * scrolling, with no scrollbar and nothing to say why the last line was missing.
   * Shrinking is what hands the overflow back to the ScrollView.
   *
   * `flexGrow: 0` is the other half: without it the ScrollView claims the sheet's
   * whole budget and a character with a one-line description gets a tall sheet with
   * an empty bottom. Together they mean the sheet is exactly as tall as its content
   * until that content hits the cap.
   */
  body: { flexGrow: 0, flexShrink: 1 },
  bodyInner: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },

  section: { gap: spacing.sm, paddingBottom: spacing.xl },
  sectionLabel: {
    fontSize: 10,
    lineHeight: 13,
    fontFamily: font.bold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  /** The one divider, between sections. A single hairline does the separating. */
  rule: { height: StyleSheet.hairlineWidth },

  skeletonStack: { gap: spacing.sm },
  skelLine: { height: 11, borderRadius: 4 },

  errorBox: { gap: spacing.sm, alignItems: 'flex-start', paddingBottom: spacing.xl },
  error: { fontFamily: font.regular, fontSize: 13 },
  retry: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.full,
  },

  description: { fontSize: 14.5, lineHeight: 23, fontFamily: font.regular },
  /**
   * The unclamped measure. Absolute so it occupies no space in the section's
   * `gap` flow, and `left/right: 0` so it is exactly as wide as the real text —
   * which is the whole trick, because the line breaks it measures have to be the
   * ones the visible text would have made.
   */
  measure: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 2,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radii.full,
  },
  disclosureText: { fontSize: 12, lineHeight: 16, fontFamily: font.semibold },

  emptyBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: 3,
  },
  emptyTitle: { fontSize: 13, lineHeight: 18, fontFamily: font.semibold },
  emptyBody: { fontSize: 12, lineHeight: 17, fontFamily: font.regular },

  factsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -spacing.sm,
  },
  factCell: {
    width: '50%',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm + 2,
    gap: 2,
  },
  factLabel: {
    fontSize: 11,
    lineHeight: 14,
    fontFamily: font.medium,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  factValue: {
    fontSize: 13.5,
    lineHeight: 18,
    fontFamily: font.semibold,
  },

  appearRail: { gap: spacing.md, paddingRight: spacing.lg },
  appearCell: { width: 88, gap: 5 },
  appearArt: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: radii.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  appearTitle: { fontSize: 11, lineHeight: 14, fontFamily: font.semibold },
  appearMeta: { fontSize: 10, lineHeight: 13, fontFamily: font.medium },
  appearHere: { fontSize: 9, lineHeight: 12, fontFamily: font.bold, letterSpacing: 0.4 },
});