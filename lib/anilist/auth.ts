// AniList OAuth — implicit grant (no client secret can live in an app).
// CLIENT_ID is public by design (it sits in plain sight in the login URL).
// Per AniList docs the authorize URL takes ONLY client_id + response_type.
// The redirect target comes from your app settings:
//   anilist.co → Settings → Developer → your app → Redirect Url
// Paste the URI shown on the Account screen there. If that field only
// holds ONE url and the website uses it, make a SECOND AniList app for
// Miori and swap its client ID below (website keeps working untouched).
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';

export const ANILIST_CLIENT_ID = "52154";
const TOKEN_KEY = 'miori_anilist_token';
const USER_KEY = 'miori_anilist_user';

export function redirectUri(): string {
  // Expo Go -> exp://... ; standalone APK -> miori://auth
  return Linking.createURL('auth');
}

export function buildAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: ANILIST_CLIENT_ID,
    response_type: 'token',
  });
  return `https://anilist.co/api/v2/oauth/authorize?${params}`;
}

function tokenFromUrl(url: string): string | null {
  const frag = url.split('#')[1] ?? '';
  const m = /(?:^|&)access_token=([^&]+)/.exec(frag);
  if (m) return decodeURIComponent(m[1]);
  const q = /(?:\?|&)access_token=([^&]+)/.exec(url);
  if (q) return decodeURIComponent(q[1]);
  return null;
}

/** Accept a raw token OR a full pasted URL (fragment or query). */
export function extractToken(input: string): string {
  const t = input.trim();
  if (!t) throw new Error('Empty token');
  if (/^https?:\/\//i.test(t) || t.includes('access_token=')) {
    const found = tokenFromUrl(t);
    if (!found) throw new Error('No access_token found in that URL');
    return found;
  }
  return t;
}

/** Open AniList login, return the token (throws on cancel/error). */
export async function login(): Promise<string> {
  const url = buildAuthUrl();
  const result = await WebBrowser.openAuthSessionAsync(url, redirectUri());
  if (result.type !== 'success' || !result.url) {
    throw new Error(result.type === 'cancel' ? 'Login cancelled' : 'Login failed');
  }
  const token = tokenFromUrl(result.url);
  if (!token) throw new Error('No token in redirect (register this redirect URI in your AniList app settings)');
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  return token;
}

export async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Remove the stored credential.
 *
 * THROWS if the token could not be deleted, and that is the whole point of the
 * function. It used to `catch {}` and resolve, so `completeSignOut` went on to
 * `setUserId(null)` and announce a sign-out that had not happened: the app
 * presented as a guest while a valid full-access token sat in the keychain, and
 * the next launch signed itself back in. That is the exact outcome
 * `completeSignIn`'s comment says a failed sign-in must not create, reached from
 * the other direction — and on a shared device it is the one that matters, since
 * the user's belief that they signed out is the only thing protecting the account.
 *
 * NOT thrown for the user id. That key is a cached label, not a credential: it
 * carries no access on its own and the next sign-in overwrites it. Reporting a
 * logout as failed over a stale label would be its own lie, and would push the
 * caller into a retry that could not help.
 */
export async function logout(): Promise<void> {
  let tokenRemoved = true;
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    tokenRemoved = false;
  }
  try {
    await SecureStore.deleteItemAsync(USER_KEY);
  } catch {
    /* stale label — harmless, and not a reason to claim the logout failed */
  }
  if (!tokenRemoved) {
    throw new Error(
      'Could not remove the AniList token from this device. Still signed in.'
    );
  }
}

/** Save a user-pasted token (manual fallback when the app can't
 * catch the browser redirect, e.g. Expo Go on Android). */
export async function saveToken(token: string): Promise<void> {
  const t = token.trim();
  if (!t) throw new Error('Empty token');
  await SecureStore.setItemAsync(TOKEN_KEY, t);
}

export async function saveUserId(id: number): Promise<void> {
  try {
    await SecureStore.setItemAsync(USER_KEY, String(id));
  } catch {
    /* ignore */
  }
}

export async function getUserId(): Promise<number | null> {
  try {
    const raw = await SecureStore.getItemAsync(USER_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
