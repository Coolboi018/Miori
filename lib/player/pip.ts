// Transport policy for the two states that are NOT "the viewer is looking at the
// player": a picture-in-picture window, and a backgrounded app.
//
// THE THREE STATES, AND WHY THEY ARE THREE
//
//   foreground  the player screen is on screen and the app is active. Playback
//               is the viewer's to control; nothing here intervenes.
//
//   pip         the video is in a system PiP window. Playback MUST continue —
//               that is the whole point of the feature — even though React
//               Native reports the app as backgrounded on Android (the activity
//               is paused while the PiP window is up, so `AppState` says
//               'background'). If the background rule below did not know about
//               PiP, every handoff would pause the video the instant it started.
//
//   background  the app is away with no PiP window: the home screen, another
//               app, or — the report that produced this file — the screen
//               turned off and the phone locked.
//
// WHY A BACKGROUNDED PLAYER IS HELD RATHER THAN LEFT TO THE ENGINE
//
// `expo-video` already pauses on background when `staysActiveInBackground` is
// false, and this app never enables background playback. That is necessary and
// it is not sufficient. The engine keeps a media session alive for the player,
// so a headset's play button is a remote `play()` that arrives with no JS
// gesture behind it — the device report was audio starting from a locked phone
// after a single earbud tap. A video app without background playback should be
// silent and parked in that state, so this app treats "away without PiP" as a
// decision: pause, and drop the viewer's play intent so nothing later resumes
// what they did not ask for.
//
// THE HANDSOFF GRACE
//
// On Android 12+ and iOS the OS can enter PiP automatically as the app leaves
// the foreground, and the PiP callback is not synchronous with the `AppState`
// change. Pausing the moment 'background' arrives would therefore kill the very
// handoff `startsPictureInPictureAutomatically` exists to perform. The window
// below is the interval a handoff gets to prove itself; if PiP has not started
// when it closes, the app is genuinely away and playback is held.

/**
 * How long an automatic PiP handoff has to start after the app backgrounds.
 *
 * Long enough for a cold handoff on a busy device (the native side reports it
 * well inside half a second in practice), short enough that a locked phone is
 * quiet before the viewer's hand leaves the power button.
 */
export const PIP_HANDOFF_GRACE_MS = 1200;

export type PlaybackStage = 'foreground' | 'pip' | 'background';

/**
 * Which policy owns the transport, from the two facts React Native can see.
 *
 * `pipActive` is checked FIRST and not as an exception to `appActive`: PiP is
 * the state where the app is backgrounded and playing on purpose, so it has to
 * beat the background verdict rather than be folded into it.
 */
export function playbackStage(appActive: boolean, pipActive: boolean): PlaybackStage {
  if (pipActive) return 'pip';
  return appActive ? 'foreground' : 'background';
}

/**
 * Whether the video should hand itself to the system when the app is left.
 *
 * ONLY WHILE PLAYING. A paused episode must not appear in a floating window —
 * every real player behaves this way, and it is also what makes the grace
 * window safe: a paused player produces no handoff, so nothing is lost when the
 * background rule pauses a player that was already paused.
 */
export function shouldAutoEnterPip(supported: boolean, playing: boolean): boolean {
  return supported && playing;
}

/**
 * Whether playback must be held (paused, intent dropped) in this stage.
 *
 * PiP and foreground are both "keep playing"; only a background with no PiP
 * window is held.
 */
export function shouldHoldPlayback(stage: PlaybackStage): boolean {
  return stage === 'background';
}
