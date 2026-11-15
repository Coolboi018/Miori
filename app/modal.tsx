import { useCallback, useEffect, useState } from 'react';
import { font } from '@/lib/ui/tokens';
import { ActivityIndicator, Button, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useFocusEffect } from 'expo-router';
import { pushOnce } from '@/lib/nav/pushOnce';
import {
  ANILIST_CLIENT_ID,
  buildAuthUrl,
  extractToken,
  redirectUri,
} from '@/lib/anilist/auth';
import { completeSignIn, completeSignOut } from '@/lib/auth/actions';
import { useViewer } from '@/lib/auth/queries';
import {
  clearDiscordToken,
  clearPresence,
  fetchDiscordUser,
  gatewayStatus,
  getDiscordToken,
  isPresenceEnabled,
  setPresenceEnabled,
  type DiscordUser,
  type GatewayStatus,
} from '@/lib/presence/discord';

export default function AccountScreen() {
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uri] = useState(() => redirectUri());
  const [paste, setPaste] = useState('');
  const [loginUrl] = useState(() => buildAuthUrl());
  const [duser, setDuser] = useState<DiscordUser | null>(null);
  const [presenceOn, setPresenceOn] = useState(false);
  const [gw, setGw] = useState<GatewayStatus | null>(null);


  /**
   * The shared entry, not a fetch of its own.
   *
   * This screen is where signing in and out happens, so it is also the screen most
   * likely to be showing a stale account: it used to hold its own `viewer` state and
   * refresh it on focus, which meant signing in from the Settings link left this
   * screen — if it were still mounted behind it — showing the old name.
   *
   * `completeSignIn` and `completeSignOut` write this key, so the value here is
   * always the one the rest of the app believes.
   */
  const { viewer } = useViewer();

  const refresh = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const dtoken = await getDiscordToken();
      setDuser(dtoken ? await fetchDiscordUser(dtoken) : null);
      setPresenceOn(await isPresenceEnabled());
      setGw(gatewayStatus());
    } catch {
      setDuser(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  async function onLogout() {
    // Caught, because `completeSignOut` throws when the keychain refuses to drop
    // the token — it must not be able to announce a sign-out that did not happen.
    // Unhandled, that rejection would leave this screen showing a signed-in
    // account with no message, and the user tapping Log out again for a reason
    // nobody explains.
    setError(null);
    try {
      await completeSignOut();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function onDiscordLogout() {
    // true = close the connection too. This is a deliberate sign-off, not a
    // screen change, so there is nothing to keep alive.
    //
    // Best-effort, then unconditional — same reason as the accounts screen: the
    // presence frame is cosmetic and the token is not, so a failure on the first
    // call must not leave the second one unrun.
    await clearPresence(true).catch(() => {});
    await clearDiscordToken();
    await setPresenceEnabled(false);
    setDuser(null);
    setPresenceOn(false);
    setGw(gatewayStatus());
  }

  async function onTogglePresence(on: boolean) {
    setPresenceOn(on);
    await setPresenceEnabled(on);
    if (!on) {
      await clearPresence(true);
      setGw(gatewayStatus());
    }
  }

  async function onSavePaste() {
    setBusy(true);
    setError(null);
    try {
      // `completeSignIn` seeds the shared viewer key, so this screen's own `useViewer`
      // re-renders with the new name on its own — no local state to set.
      await completeSignIn(extractToken(paste));
      setPaste('');
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.header}>Account</Text>
      {viewer ? (
        <View style={styles.card}>
          <Text style={styles.name}>{viewer.name}</Text>
          <Text style={styles.hint}>ID {viewer.id} — progress syncs to your list</Text>
          <View style={styles.gap} />
          <Button title="Log out" onPress={onLogout} />
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.hint}>Login with AniList to sync episode progress.</Text>
          <View style={styles.gap} />
          <Button title="Login inside the app" onPress={() => pushOnce('/login')} />
        </View>
      )}
      {!!error && <Text style={styles.error}>{error}</Text>}
      <Text style={[styles.header, styles.section]}>Discord status</Text>
      {duser ? (
        <View style={styles.card}>
          <Text style={styles.name}>{duser.global_name ?? duser.username}</Text>
          <Text style={styles.hint}>Shows Watching status while you play</Text>
          {!!gw && (
            <Text style={styles.hint}>
              socket: {gw.ready ? 'online  →' : gw.phase}
              {gw.lastCode != null ? ` (code ${gw.lastCode})` : ''}
              {gw.lastError ? ` ${gw.lastError}` : ''}
            </Text>
          )}
          <View style={styles.switchRow}>
            <Text style={styles.hint}>Enable</Text>
            <Switch value={presenceOn} onValueChange={onTogglePresence} />
          </View>
          <View style={styles.gap} />
          <Button
            title="Test presence now"
            onPress={async () => {
              const { updateBrowsing } = await import('@/lib/presence/discord');
              await updateBrowsing('Presence self-test');
              setTimeout(() => setGw(gatewayStatus()), 3000);
            }}
          />
          <View style={styles.gap} />
          <Button title="Log out Discord" onPress={onDiscordLogout} />
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.hint}>Login with Discord to show what you&apos;re watching.</Text>
          <View style={styles.gap} />
          <Button title="Login with Discord" onPress={() => pushOnce('/discord-login')} />
        </View>
      )}
      {!viewer && (
        <View style={styles.setup}>
          <Text style={styles.setupTitle}>Option B — paste token (works right now)</Text>
          <Text style={styles.hint}>
            Tap to open AniList, Authorize, then copy the access_token
            from the address bar back here:
          </Text>
          <View style={styles.gap} />
          <Button
            title="Open AniList login"
            onPress={() => WebBrowser.openBrowserAsync(loginUrl)}
          />
          <Text style={styles.uri} selectable>
            {loginUrl}
          </Text>
          <TextInput
            style={styles.input}
            placeholder="paste token or full address-bar URL here"
            placeholderTextColor="#555"
            value={paste}
            onChangeText={setPaste}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button title={busy ? 'Checking…' : 'Save token'} onPress={onSavePaste} disabled={busy || !paste.trim()} />
        </View>
      )}
      <View style={styles.setup}>
        <Text style={styles.setupTitle}>One-time setup (client {ANILIST_CLIENT_ID})</Text>
        <Text style={styles.hint}>
          anilist.co → Settings → Developer → your app → Redirect Url → set exactly:
        </Text>
        <Text style={styles.uri} selectable>
          {uri}
        </Text>
        <Text style={styles.hint}>
          Note: your PC&apos;s IP can change between WiFis — if login suddenly
          fails, re-check this URI matches settings. APK builds later use
          miori://auth (stable, register once).
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b10' },
  content: { paddingTop: 48, padding: 16, paddingBottom: 32 },
  section: { marginTop: 20 },
  center: { flex: 1, backgroundColor: '#0b0b10', alignItems: 'center', justifyContent: 'center' },
  header: { color: '#fff', fontSize: 18, fontFamily: font.bold, marginBottom: 12 },
  card: { backgroundColor: '#15151d', borderRadius: 10, padding: 14 },
  name: { color: '#fff', fontSize: 18, fontFamily: font.bold },
  hint: { color: '#888', fontFamily: font.regular, fontSize: 12, marginTop: 4 },
  gap: { height: 10 },
  error: { color: '#ff6b6b', fontFamily: font.regular, fontSize: 13, marginTop: 12 },
  setup: { marginTop: 20, backgroundColor: '#101016', borderRadius: 10, padding: 14 },
  setupTitle: { color: '#ccc', fontFamily: font.bold, fontSize: 13, marginBottom: 4 },
  uri: { color: '#7dd3fc', fontSize: 12, marginVertical: 6, fontFamily: font.mono },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  input: {
    backgroundColor: '#0b0b10',
    color: '#fff',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    padding: 10,
    marginVertical: 8,
    fontFamily: font.regular,
    fontSize: 12,
  },
});
