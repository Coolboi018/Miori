import { useEffect, useRef, useState } from 'react';
import { font } from '@/lib/ui/tokens';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WebView, type WebViewMessageEvent, type WebViewNavigation, type WebViewRef } from 'react-native-webview';
import { fetchDiscordUser, getLastDiscordUserId, rememberDiscordUserId, saveDiscordToken, setPresenceEnabled } from '@/lib/presence/discord';
import { AppIcon } from '@/components/ui/AppIcon';

// Desktop UA — the proven ShonenX prototype captured with this on device.
// The port below once shipped a MOBILE UA and capture died: Discord's
// mobile-web build is a different surface that none of the grab strategies
// were proven against. Desktop web renders fine (responsively) in the
// phone-sized webview.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// THE capture mechanism (document-start, re-installed on every page load —
// the `__mioriHooked` flag makes re-runs no-ops in the same document). This is
// what the proven prototype actually did and what the first port DROPPED,
// leaving only the fragile fallbacks: hook `fetch` + `XMLHttpRequest` and
// take the token from (a) the `Authorization` header of any request and (b)
// the `token` field of any /api/ JSON response — the login POST itself is
// such a response, so a successful login hands us the token the same second.
// Not dependent on localStorage layout or webpack internals, which is why it
// survives Discord's client rebuilds.
const HOOK_EARLY = `(function(){
try{
if(window.__mioriHooked) return;
window.__mioriHooked=true;
function post(o){try{window.ReactNativeWebView.postMessage(JSON.stringify(o));}catch(e){}}
function clean(t){
try{t=String(t==null?'':t).replace(/^Bearer\\s+/i,'').replace(/"/g,'').trim();}catch(e){return null;}
return t&&t.length>=30?t:null;
}
function send(t){
var c=clean(t);
if(!c||window.__mioriToken)return;
var ok=false;
try{window.ReactNativeWebView.postMessage(JSON.stringify({type:'discord-token',token:c}));ok=true;}catch(e){}
if(ok)window.__mioriToken=c;
}
// A session may already exist (returning user, back-navigation): take it now.
try{var t0=window.localStorage.getItem('token')||window.sessionStorage.getItem('token');if(t0)send(t0);}catch(e){}
try{
var of=window.fetch;
if(of){
window.fetch=function(){
var args=arguments;
var url='';
try{url=String((args[0]&&args[0].url)||args[0]||'');}catch(e){}
try{
var hs=[];
if(args[1]&&args[1].headers)hs.push(args[1].headers);
if(args[0]&&args[0].headers)hs.push(args[0].headers);
for(var i=0;i<hs.length;i++){
var h=hs[i];
if(!h)continue;
if(typeof h.get==='function'){send(h.get('Authorization'));}
else{send(h.Authorization||h.authorization);}
}
}catch(e){}
var p=of.apply(this,args);
try{
if(url.indexOf('/api/')!==-1){
p.then(function(res){
try{res.clone().json().then(function(j){if(j&&j.token)send(j.token);}).catch(function(){});}catch(e){}
}).catch(function(){});
}
}catch(e){}
return p;
};
}
}catch(e){}
try{
var _set=XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.setRequestHeader=function(n,v){
try{if(n&&String(n).toLowerCase()==='authorization')send(v);}catch(e){}
return _set.apply(this,arguments);
};
var _open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(){
try{this.addEventListener('load',function(){
try{
if(!this.responseText)return;
var j=JSON.parse(this.responseText);
if(j&&j.token)send(j.token);
}catch(e){}
});}catch(e){}
return _open.apply(this,arguments);
};
}catch(e){}
}catch(e){}
})();`;

// Fallback poll from the RN side (ref timer survives SPA navigations).
// Strategy 1: localStorage/sessionStorage `token`. Strategy 2: Discord's own
// webpack getToken (module CACHE values only — never calling req() on
// factories, which can run side-effectful modules). EVERY strategy is
// failure-isolated and a `discord-nothing` report is ALWAYS posted at the
// end: the first port wrapped everything in one try/catch on the webview
// side, so a webpack throw killed the script before the report and the
// status line stuck on "grabbing…" forever with nothing on screen telling
// us why.
const GRAB_ONCE = `(function(){
function post(o){try{window.ReactNativeWebView.postMessage(JSON.stringify(o));}catch(e){}}
function clean(t){
try{t=String(t==null?'':t).replace(/"/g,'').trim();}catch(e){return null;}
return t&&t.length>=30?t:null;
}
try{
try{
var t=window.localStorage.getItem('token')||window.sessionStorage.getItem('token');
t=clean(t);
if(t){post({type:'discord-token',token:t});return;}
}catch(e){}
try{
var w=window.webpackChunkdiscord_app;
if(w&&w.push){
var found=null;
w.push([[Symbol()],{},function(req){
try{
var mods=Object.values(req.c||{});
for(var i=0;i<mods.length;i++){
try{
var ex=mods[i]&&mods[i].exports;
if(ex&&ex.default&&ex.default.getToken){found=ex.default.getToken();break;}
if(ex&&ex.getToken){found=ex.getToken();break;}
}catch(e){}
}
}catch(e){}
}]);
try{w.pop();}catch(e){}
var f=clean(found);
if(f){post({type:'discord-token',token:f});return;}
}
}catch(e){}
var keys=[];
try{keys=Object.keys(window.localStorage).slice(0,12);}catch(e){}
post({type:'discord-nothing',url:String(location.href||''),keys:keys,hook:!!window.__mioriHooked});
}catch(e){}
})();`;

export default function DiscordLoginScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ fresh?: string }>();
  const fresh = params.fresh === '1';
  // In "switch account" mode, drop Discord's cached token from storage BEFORE
  // the capture hook runs, so the old session can't be re-grabbed.
  const hookEarly = fresh
    ? `(function(){try{window.localStorage.removeItem('token');window.sessionStorage.removeItem('token');}catch(e){}})();${HOOK_EARLY}`
    : HOOK_EARLY;
  const [status, setStatus] = useState(
    fresh ? 'Switching account — log in with the new one.' : 'Loading Discord… (log in below)'
  );
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const captured = useRef(false);
  const lastWatch = useRef('');
  const webref = useRef<WebViewRef>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Switch-account mode: drop Discord's cached session so the webview does not
  // silently re-log-in as the previous account. localStorage alone is not
  // enough — the session cookie survives and re-authenticates on its own.
  useEffect(() => {
    if (!fresh) return;
    try {
      (webref.current as any)?.clearCache?.(true);
      (webref.current as any)?.clearFormData?.();
    } catch {
      /* best-effort */
    }
    try {
      webref.current?.injectJavaScript(
        `(function(){try{document.cookie.split(';').forEach(function(c){var e=c.split('=')[0].trim();document.cookie=e+'=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.discord.com';});}catch(e){}})();true;`
      );
    } catch {
      /* best-effort */
    }
  }, [fresh]);

  async function finishToken(token: string) {
    if (done.current) return;
    const t = token.trim().replace(/^"|"$/g, '');
    if (t.length < 20) return;
    done.current = true;
    if (timer.current) clearInterval(timer.current);
    setStatus('Saving…');
    try {
      const u = await fetchDiscordUser(t); // validates too
      // Switch-account guard: if the captured token resolves to the account we
      // just wiped, the logout/cookie cleanup failed and the webview silently
      // re-authenticated as the OLD account. Saving it would make "switch"
      // land right back where it started — refuse and tell the user why.
      if (fresh) {
        const prev = await getLastDiscordUserId();
        if (prev && prev === u.id) {
          done.current = false;
          setError(
            `Still logged in as ${u.global_name ?? u.username} — the old session survived the wipe. Log out below, then log in with the other account.`
          );
          setStatus('Switch account');
          return;
        }
      }
      await saveDiscordToken(t);
      await rememberDiscordUserId(u.id);
      // A successful login means the user wants presence to work. Enable it so
      // the gateway connects and the RPC card shows without a manual toggle.
      await setPresenceEnabled(true);
      setStatus(`Logged in as ${u.global_name ?? u.username}`);
      setTimeout(() => router.back(), 800);
    } catch (e: any) {
      done.current = false;
      setError(String(e?.message ?? e));
      setStatus('Login');
    }
  }

  function grab() {
    try {
      webref.current?.injectJavaScript(GRAB_ONCE);
    } catch {
      /* ignore */
    }
  }

  // Fallback poll every 2s until captured — the hook above is the instant
  // path; this only has to win if the hook somehow missed the request burst.
  useEffect(() => {
    timer.current = setInterval(() => {
      if (!done.current && !captured.current) grab();
    }, 2000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  function onMessage(raw: string) {
    if (done.current) return;
    let msg: any = null;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg?.type === 'discord-token' && msg.token) {
      captured.current = true;
      finishToken(String(msg.token));
    } else if (msg?.type === 'discord-nothing') {
      const keys = msg.keys?.length ? ' keys:[' + msg.keys.join(',') + ']' : '';
      const line = 'Watching: ' + String(msg.url || '').slice(0, 60) + keys;
      if (line !== lastWatch.current) {
        lastWatch.current = line;
        setStatus(line);
      }
    }
  }

  function onNav(nav: WebViewNavigation) {
    // Login success lands on /channels -> grab immediately.
    if (!done.current && !captured.current && nav.url?.includes('discord.com/channels')) {
      setStatus('Login detected, grabbing token…');
      grab();
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.bar}>
        <Text style={styles.barText} numberOfLines={4}>
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
          ref={webref}
          source={{ uri: 'https://discord.com/login' }}
          onNavigationStateChange={onNav}
          onMessage={(e: WebViewMessageEvent) => onMessage(e.nativeEvent.data)}
          injectedJavaScriptBeforeContentLoaded={hookEarly}
          injectedJavaScript={hookEarly}
          domStorageEnabled
          javaScriptEnabled
          sharedCookiesEnabled={!fresh}
          thirdPartyCookiesEnabled={!fresh}
          cacheEnabled={!fresh}
          userAgent={UA}
          startInLoadingState
          style={styles.web}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b10', paddingTop: 48 },
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  barText: { color: '#888', fontFamily: font.regular, fontSize: 12, flex: 1 },
  close: { paddingHorizontal: 8, paddingVertical: 4 },
  web: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  ok: { color: '#4ade80', marginTop: 8 },
});
