/**
 * PiP must survive the background report, and a locked phone must be silent.
 *
 * THE TWO REPORTS THIS PINS
 *
 *   1. "PiP button does nothing." The button was wired, the JS called
 *      `startPictureInPicture()`, and the native call threw — because the
 *      `expo-video` config plugin was registered with no options, so the
 *      Android manifest never gained `android:supportsPictureInPicture`. The
 *      catch below kept that out of the UI, which is right for a runtime
 *      refusal and wrong for a build that was never configured for the feature.
 *      A source assertion on `app.json` is the only thing that can catch it:
 *      the JS is perfectly correct on a build that cannot do PiP.
 *
 *   2. "Screen off, tapped my earbud, audio started like music." Background
 *      playback is deliberately NOT enabled, so the engine pauses when the app
 *      is left — but it keeps a media session, and a headset play button is a
 *      remote `play()` with no gesture behind it. The app therefore holds
 *      playback while it is away without a PiP window, and undoes any play that
 *      arrives in that state.
 *
 * THE TRAP
 *
 * PiP is the case where the app IS backgrounded and playing on purpose. Android
 * pauses the activity while the PiP window is up, so `AppState` reports
 * 'background' for exactly the state that must not be paused. A background rule
 * that does not know about PiP breaks the feature it was added for, so the
 * model below is run with a naive "background means pause" variant and must
 * fail there.
 *
 * Run with:  npx tsx scripts/check-background-policy.ts
 */

import {
  PIP_HANDOFF_GRACE_MS,
  playbackStage,
  shouldAutoEnterPip,
  shouldHoldPlayback,
} from '../lib/player/pip';

declare const require: (id: string) => {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const { readFileSync } = require('node:fs');

declare const process: { cwd(): string; exit(code: number): never };

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(`${ROOT}/${rel}`, 'utf8');

const screenSrc = read('components/player/fullscreen/PlayerScreen.tsx');
const appJson = JSON.parse(read('app.json')) as {
  expo: { plugins?: (string | [string, Record<string, unknown>])[] };
};

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  pass  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// The policy model
// ---------------------------------------------------------------------------

console.log('\nbackground policy — model');

check('foreground is not held', playbackStage(true, false) === 'foreground' && !shouldHoldPlayback('foreground'));
check('away without PiP is held', playbackStage(false, false) === 'background' && shouldHoldPlayback('background'));
check(
  'PiP beats the background report',
  playbackStage(false, true) === 'pip' && !shouldHoldPlayback('pip'),
  'Android pauses the activity behind a PiP window, so AppState says background'
);
check('PiP in the foreground is still PiP', playbackStage(true, true) === 'pip');
check('auto PiP only while playing', shouldAutoEnterPip(true, true) === true);
check('auto PiP never for a paused episode', shouldAutoEnterPip(true, false) === false);
check('auto PiP never on an unsupported device', shouldAutoEnterPip(false, true) === false);
check('the handoff window is short but not zero', PIP_HANDOFF_GRACE_MS >= 300 && PIP_HANDOFF_GRACE_MS <= 3000);

// The up-next countdown is a timer that CHANGES THE EPISODE, so it is held to
// the same rule as playback: time spent away from the app is not time spent
// deciding. Android throttles background timers and then delivers them in a
// burst, which advances the queue the moment the viewer comes back.
{
  const card = read('components/player/fullscreen/NextEpisodeCard.tsx');
  check(
    'the up-next countdown does not tick while the app is away',
    /AppState\.currentState !== 'active'\) return;/.test(card),
    'a backgrounded countdown fires late, or on return, against a playhead that is no longer at the end'
  );
}

// The naive rule this app must NOT implement: every background is a pause.
const naiveHold = (appActive: boolean) => !appActive;
check(
  'a naive "background means pause" rule fails on PiP',
  naiveHold(true) === shouldHoldPlayback('foreground') && naiveHold(false) !== shouldHoldPlayback('pip'),
  'if this ever passes, the model above has stopped testing the thing that broke'
);

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

console.log('\nbackground policy — wiring');

const videoPlugin = (appJson.expo.plugins ?? []).find((p) =>
  Array.isArray(p) ? p[0] === 'expo-video' : p === 'expo-video'
);
const videoOptions = Array.isArray(videoPlugin) ? videoPlugin[1] : null;

check(
  'the expo-video plugin enables PiP in the native manifest',
  videoOptions !== null && videoOptions.supportsPictureInPicture === true,
  'a bare "expo-video" entry leaves android:supportsPictureInPicture unset and makes startPictureInPicture throw'
);

check(
  'background playback stays disabled',
  videoOptions !== null && videoOptions.supportsBackgroundPlayback !== true,
  'audio must not outlive the screen; that is the earbud report'
);

check(
  'the player states staysActiveInBackground = false',
  /p\.staysActiveInBackground\s*=\s*false/.test(screenSrc),
  'the native half of the same rule'
);

check(
  'the video view auto-enters PiP while playing',
  /startsPictureInPictureAutomatically=\{shouldAutoEnterPip\(pipSupported, playing\)\}/.test(screenSrc),
  'without the prop, leaving the app pauses instead of floating'
);

check(
  'PiP start/stop are observed',
  /onPictureInPictureStart=\{onPipStart\}/.test(screenSrc) &&
    /onPictureInPictureStop=\{onPipStop\}/.test(screenSrc),
  'the policy cannot tell PiP from a locked phone without them'
);

check(
  'the handoff window exists and is used',
  /PIP_HANDOFF_GRACE_MS/.test(screenSrc) && /pipHandoffTimerRef/.test(screenSrc),
  'acting on background immediately would kill the handoff'
);

check(
  'only a real background starts the hold',
  /next\s*!==\s*'background'/.test(screenSrc),
  "'inactive' is a pulled-down shade on iOS, not the app being away"
);

check(
  'the hold drops the play intent',
  /backgroundHoldRef\.current = true;[\s\S]{0,200}?desiredPlayingRef\.current = false/.test(screenSrc),
  'otherwise a failover or the return to foreground presses play again'
);

check(
  'a remote play is undone while held',
  /addListener\('playingChange', \(\{ isPlaying \}\) => \{[\s\S]{0,400}?backgroundHoldRef\.current[\s\S]{0,300}?player\.pause\(\)/.test(
    screenSrc
  ),
  'the earbud button resumes through the media session, not through JS'
);

check(
  'closing the PiP window does not leave invisible audio',
  // ANCHORED TO THE DECLARATION, not to the first mention of the name. The old
  // pattern started at any `onPipStop` — including the doc comment above the
  // timer refs — so unrelated code added between that comment and the handler
  // could fail this check without the rule changing at all (24 Nov: two blocks
  // of player refs pushed the distance from 564 to 935 characters). The rule is
  // about the HANDLER, so the pattern starts at the handler.
  /const onPipStop = useCallback[\s\S]{0,1400}?player\.pause\(\)/.test(screenSrc),
  'an expand must not pause; a close must'
);

console.log(failures === 0 ? '\nall background-policy checks passed\n' : `\n${failures} failed\n`);
if (failures > 0) process.exit(1);
