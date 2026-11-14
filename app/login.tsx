import { useRef, useState } from 'react';
import { font } from '@/lib/ui/tokens';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { buildAuthUrl, extractToken } from '@/lib/anilist/auth';
import { completeSignIn } from '@/lib/auth/actions';
import { AppIcon } from '@/components/ui/AppIcon';

// In-app AniList login. Watches every navigation; the moment the
// access_token appears in the URL it saves it and closes —
// no copying, no address bar, no race with instant redirects.
export default function LoginScreen() {
  const router = useRouter();
  const [url] = useState(() => buildAuthUrl());
  const [status, setStatus] = useState('Loading AniList…');
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  async function finish(rawUrl: string) {
    if (done.current) return;
    let token: string;
    try {
      token = extractToken(rawUrl);
    } catch {
      return; // not the redirect yet — keep browsing
    }
    done.current = true;
    setStatus('Saving…');
    try {
      // `completeSignIn` rather than the three inline steps this used to be, so the
      // "tell the app" part cannot be left out of one of the three sign-in paths
      // again. See `lib/auth/actions.ts` for what goes wrong when it is.
      const v = await completeSignIn(token);
      setStatus(`Logged in as ${v.name}`);
      setTimeout(() => router.back(), 800);
    } catch (e: any) {
      done.current = false;
      setError(String(e?.message ?? e));
      setStatus('Login');
    }
  }

  function onNav(nav: WebViewNavigation) {
    if (!done.current) {
      setStatus(nav.loading ? 'Loading…' : nav.title || 'AniList');
      finish(nav.url);
    }
  }

  function onShouldStart(req: { url: string }) {
    // Fires before the redirect completes — full URL, fragment included.
    if (!done.current && req.url.includes('access_token=')) {
      finish(req.url);
      return false;
    }
    return true;
  }

  function onMessage(event: { nativeEvent: { data: string } }) {
    // injected JS reports window.location.href — fragments always visible.
    if (!done.current && event.nativeEvent.data.includes('access_token=')) {
      finish(event.nativeEvent.data);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.bar}>
        <Text style={styles.barText} numberOfLines={1}>
          {error ?? status}
        </Text>
        <Pressable style={styles.close} onPress={() => router.back()} hitSlop={8}>
          <AppIcon name="close" size={18} color="#fff" />
        </Pressable>
      </View>
      {done.current && status.startsWith('Logged in') ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" />
          <Text style={styles.ok}>{status}</Text>
        </View>
      ) : (
        <WebView
          source={{ uri: url }}
          onNavigationStateChange={onNav}
          onShouldStartLoadWithRequest={onShouldStart}
          onMessage={onMessage}
          injectedJavaScript="window.ReactNativeWebView.postMessage(window.location.href);true;"
          startInLoadingState
          style={styles.web}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b10', paddingTop: 48 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  barText: { color: '#888', fontFamily: font.regular, fontSize: 12, flex: 1 },
  close: { paddingHorizontal: 8, paddingVertical: 4 },
  web: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  ok: { color: '#4ade80', marginTop: 8 },
});
