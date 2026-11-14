// Download an APK and hand it to Android's package installer.
//
// The one honest limit of a sideloaded app: it can fetch the new build itself,
// but the INSTALL is the system's. Android shows its own installer screen and
// the user taps through it (and allows "install unknown apps" for Miori once).
// That is by design — silent self-install is not something a normal app gets.
//
// THE MODULES ARE LOADED LAZILY, ON ANDROID ONLY. `expo-intent-launcher` has no
// web implementation and its import throws where there is no native module, and
// this file is reachable from a shared store. Requiring it inside the Android
// branch means the web build never evaluates it.

import { Linking, Platform } from 'react-native';

/** `Intent.FLAG_GRANT_READ_URI_PERMISSION` — the installer must be able to read our file://. */
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
/** `Intent.FLAG_ACTIVITY_NEW_TASK` — launched from a non-activity context. */
const FLAG_ACTIVITY_NEW_TASK = 0x10000000;

const APK_MIME = 'application/vnd.android.package-archive';

/**
 * `file://` in the app's cache is unreadable to the installer, which is a
 * DIFFERENT app. `getContentUriAsync` exposes it through Expo's FileProvider as
 * `content://`, and the grant flag above is what lets the installer read it.
 * Skipping either half raises `FileUriExposedException` on Android 7+.
 */
export async function downloadAndInstallApk(
  url: string,
  onProgress?: (fraction: number) => void
): Promise<void> {
  if (Platform.OS !== 'android') {
    // No installer to hand it to — opening the link is the whole story.
    await Linking.openURL(url);
    return;
  }

  const FileSystem = await import('expo-file-system/legacy');
  const IntentLauncher = await import('expo-intent-launcher');

  const dir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
  if (!dir) throw new Error('No writable storage is available for the download');

  const target = `${dir}miori-update.apk`;
  // A failed download can leave a partial file behind; the downloader replaces
  // an existing file, but removing it first makes a retry start from zero rather
  // than resume a truncated APK.
  await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);

  const job = FileSystem.createDownloadResumable(url, target, {}, (p) => {
    const total = p.totalBytesExpectedToWrite;
    if (total > 0 && onProgress) onProgress(Math.min(1, p.totalBytesWritten / total));
  });
  const result = await job.downloadAsync();
  if (!result?.uri) throw new Error('The download was cancelled');

  const contentUri = await FileSystem.getContentUriAsync(result.uri);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: APK_MIME,
    flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
  });
}
