// App update check — state + actions, no React.
//
// WHAT THIS IS: the newest release of the public Miori repo, straight from
// GitHub's releases API, compared with the version this build was made from.
// No server, no manifest file to keep in sync, no store review: publishing a
// release with an `.apk` attached IS publishing the update.
//
// WHAT IT IS NOT: an OTA system. It replaces the whole app, and only when the
// user taps through Android's installer. `expo-updates` (JS-only fixes) is a
// separate, later thing — see mds/notifications-and-updates.md.
//
// TWO RULES KEEP IT FREE AND UNANNOYING:
//   - one check per launch (plus whatever the user asks for), never a poll.
//     GitHub allows 60 unauthenticated requests an hour per IP;
//   - a skipped version stays skipped until a NEWER release appears, and a
//     dismissed prompt stays dismissed until the next launch (memory only).

import Constants from 'expo-constants';
import { fetchJson } from '@/lib/extensions/fetch';
import { readSetting, setSetting } from '@/lib/settings/store';
import { isUpdateAvailable, parseRelease, shouldPrompt, type UpdateRelease } from './release';
import { downloadAndInstallApk } from './install';

/** The app repo whose releases are the update channel. */
export const MIORI_REPO = 'Coolboi018/Miori';

const LATEST_RELEASE_URL = `https://api.github.com/repos/${MIORI_REPO}/releases/latest`;

/**
 * Short on purpose. An update check that hangs is not allowed to sit on a
 * connection the first screen needs; `fetchJson` covers the body read too, so a
 * stalled response cannot outlive this.
 */
const CHECK_TIMEOUT_MS = 12_000;

/**
 * When the launch check runs. Same reasoning as the extension sweep's delay:
 * the first seconds belong to the home rails and the cache restore, and an
 * update check is never the thing a user opened the app for.
 */
export const AUTO_CHECK_DELAY_MS = 6_000;

const GITHUB_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Miori-Android',
};

export type UpdateCheckStatus = 'idle' | 'checking' | 'current' | 'available' | 'error';
export type UpdateInstallStatus = 'idle' | 'downloading' | 'error';

export interface UpdateState {
  status: UpdateCheckStatus;
  /** The newer release, when there is one. Cleared when up to date. */
  release: UpdateRelease | null;
  error: string | null;
  /** Is the centred prompt on screen? */
  open: boolean;
  install: UpdateInstallStatus;
  /** Download progress, 0..1. */
  progress: number;
  installError: string | null;
}

const INITIAL: UpdateState = {
  status: 'idle',
  release: null,
  error: null,
  open: false,
  install: 'idle',
  progress: 0,
  installError: null,
};

let state: UpdateState = INITIAL;
/**
 * Is the card currently showing `previewUpdateCard()`'s fake release?
 *
 * Module-scope, not in `UpdateState`, on purpose: it never draws anything, and
 * adding it to the snapshot would make every consumer re-render for a fact none
 * of them render. It exists so the dev preview can rehearse the DOWNLOAD UI
 * (label, progress) without fetching a file — see `installUpdate`.
 */
let previewMode = false;
const listeners = new Set<() => void>();

function patch(next: Partial<UpdateState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function subscribeUpdates(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function readUpdates(): UpdateState {
  return state;
}

/**
 * The version of THIS build.
 *
 * `expoConfig.version` first, deliberately: it is the version written in
 * `app.json` at build time, which is also what the release tag is compared
 * against. In Expo Go, `nativeApplicationVersion` reports EXPO GO's version —
 * comparing against that would say the app is 58.x and never prompt at all.
 */
export function installedVersion(): string {
  return (Constants.expoConfig?.version ?? '0.0.0').trim();
}

/** A rate-limited or missing release is a sentence, not a stack trace. */
function checkFailureMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/\bHTTP (403|429)\b/.test(msg)) return 'GitHub refused the check — try again in an hour.';
  if (/\bHTTP 404\b/.test(msg)) return 'No releases found on GitHub yet.';
  return msg || 'Could not reach GitHub.';
}

/**
 * Ask GitHub for the newest release.
 *
 * `auto: true` is the launch check — it respects "Skip this version" and it is
 * the only caller that does. Everything else is a user asking, and an answer
 * the user asked for is always shown.
 */
export async function checkForUpdate(options: { auto?: boolean } = {}): Promise<void> {
  if (state.status === 'checking') return;
  // A real check always leaves preview behind; otherwise a later install tap
  // would run the simulation against a real release.
  previewMode = false;
  patch({ status: 'checking', error: null, install: 'idle', installError: null, progress: 0 });

  let release: UpdateRelease | null;
  try {
    const raw = await fetchJson<unknown>(
      LATEST_RELEASE_URL,
      CHECK_TIMEOUT_MS,
      { headers: GITHUB_HEADERS },
      'GitHub releases'
    );
    release = parseRelease(raw);
  } catch (e) {
    patch({ status: 'error', error: checkFailureMessage(e), release: null, open: false });
    return;
  }

  if (!release) {
    patch({
      status: 'error',
      error: 'The newest GitHub release has no version tag this app can read.',
      release: null,
      open: false,
    });
    return;
  }

  const local = installedVersion();
  if (!isUpdateAvailable(release, local)) {
    patch({ status: 'current', release: null, error: null, open: false });
    return;
  }

  patch({
    status: 'available',
    release,
    error: null,
    open: shouldPrompt(release, {
      auto: options.auto === true,
      skipped: readSetting('updates.skippedVersion'),
      localVersion: local,
    }),
  });
}

/** Re-open the prompt for the release already found (Settings → About). */
export function openUpdatePrompt(): void {
  if (state.status === 'available' && state.release && !state.open) patch({ open: true });
}

/**
 * DEV ONLY — show the card with a fake release, no network, no published tag.
 *
 * The payload goes through the REAL `parseRelease`, so what you are looking at
 * is the shipped card rendering the shipped parser's output. The only thing it
 * cannot rehearse is a real `.apk` download: with no asset attached the primary
 * button correctly degrades to "Open release page". To see the download half in
 * Expo Go, attach an `.apk` to a real release instead.
 *
 * Guarded by `__DEV__` rather than merely hidden in the UI: a production build
 * that somehow reached this function still does nothing.
 */
export type PreviewFlavour = 'normal' | 'long';

/** A changelog deliberately longer than the card: six sections, thirty bullets. */
function longPreviewNotes(): string {
  return Array.from({ length: 6 }, (_, s) =>
    `## Section ${s + 1}\n\n${Array.from(
      { length: 5 },
      (_, b) =>
        `- **Change ${s + 1}.${b + 1}** — a release-note line long enough to wrap on a phone screen, which is the point of this preview.`
    ).join('\n')}`
  ).join('\n\n');
}

export function previewUpdateCard(flavour: PreviewFlavour = 'normal'): void {
  if (!__DEV__) return;
  // A fake ASSET is part of the payload so the primary button shows its real
  // "Download & install" label and size line. The URL is never fetched:
  // `installUpdate` simulates the download while `previewMode` is on.
  const release = parseRelease({
    tag_name: 'v9.9.9',
    name: 'Miori 9.9.9 (preview)',
    html_url: `https://github.com/${MIORI_REPO}/releases`,
    published_at: new Date().toISOString(),
    assets: [
      {
        name: 'miori-arm64-v8a.apk',
        size: 49_000_000,
        browser_download_url: `https://github.com/${MIORI_REPO}/releases`,
      },
    ],
    body:
      flavour === 'long'
        ? longPreviewNotes()
        : '## What is new\n\n' +
          '- **Per-source** extension installs\n' +
          '- Faster home rails and a fixed schedule clock\n' +
          '- Subtitles keep their place after a quality switch\n\n' +
          '### Fixes\n\n' +
          '- The player no longer raises the error card over working playback\n' +
          '- One Piece episode list no longer repeats rows',
  });
  if (!release) return;
  previewMode = true;
  patch({
    status: 'available',
    release,
    error: null,
    open: true,
    install: 'idle',
    installError: null,
    progress: 0,
  });
}

/**
 * DEV ONLY — the download's LOOK without a file.
 *
 * Same state transitions the real path produces (downloading → progress ticks →
 * card closes as the installer would cover it), so the progress bar and the
 * "Downloading NN%" label can be judged on a device in seconds.
 */
async function simulatePreviewDownload(): Promise<void> {
  patch({ install: 'downloading', progress: 0, installError: null });
  for (let step = 1; step <= 10; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 130));
    patch({ progress: step / 10 });
  }
  patch({ install: 'idle', progress: 1, open: false });
}

/** "Later" — the popup closes and the launch check does not fire again. */
export function dismissUpdatePrompt(): void {
  if (state.open) patch({ open: false });
}

/**
 * "Skip this version" — persisted, because it has to outlive the launch it was
 * pressed in. A newer release overwrites the interest: the equality test in
 * `shouldPrompt` is what makes the skip expire by itself.
 */
export function skipCurrentRelease(): void {
  const release = state.release;
  if (!release) return;
  setSetting('updates.skippedVersion', release.version);
  patch({ open: false });
}

/**
 * Download the APK, then hand it to Android's installer.
 *
 * The promise resolves when the user comes BACK from the installer, not when
 * they finish installing — there is no callback for that, and guessing one
 * would be a lie on the next launch anyway (the version check answers it then).
 */
export async function installUpdate(): Promise<void> {
  const release = state.release;
  if (!release) return;
  if (state.install === 'downloading') return;

  if (previewMode && __DEV__) {
    await simulatePreviewDownload();
    return;
  }

  // A release with no APK is still worth announcing: the notes are real, and
  // the release page is where the owner put whatever they did attach.
  if (!release.apk) {
    if (release.pageUrl) {
      await downloadAndInstallApk(release.pageUrl).catch(() => undefined);
      return;
    }
    patch({ install: 'error', installError: 'This release has nothing to download.' });
    return;
  }

  patch({ install: 'downloading', progress: 0, installError: null });
  try {
    await downloadAndInstallApk(release.apk.url, (fraction) => patch({ progress: fraction }));
    // The installer was opened; leaving the card up would sit under it.
    patch({ install: 'idle', progress: 1, open: false });
  } catch (e) {
    patch({
      install: 'error',
      installError: e instanceof Error ? e.message : 'The download failed.',
    });
  }
}
