import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent, type WebViewRef, type WebViewErrorEvent, type WebViewHttpErrorEvent } from 'react-native-webview';
import { getDiscordToken, isPresenceEnabled, setPresenceEnabled, subscribeDiscordCredentials } from '@/lib/presence/discord';
import { applyAccountStatus } from '@/lib/presence/accountStatus';
import { subscribeSettings, readSetting } from '@/lib/settings/store';
import {
  _bridgePending,
  _onGatewayEvent,
  _registerPush,
  gatewayAttach,
  gatewayResume,
  gatewayRest,
  gatewayStop,
  gatewaySetStatus,
} from '@/lib/presence/gateway';

// Invisible gateway socket host. Real Chromium networking survives what raw RN
// sockets couldn't.
//
// MOUNTED EXACTLY ONCE for the life of the app — never conditionally. This
// used to `return null` when no Discord token was present, and that was the
// cause of duplicate activity cards: the credential check re-runs on every
// navigation, so one slow or empty read unmounted the WebView and the next
// navigation remounted it. Every remount builds a new page with a new socket,
// and Android tears an unmounted WebView's socket down asynchronously — so the
// old connection was routinely still alive when the new one opened. Two live
// sessions for one account means two activity cards, each overwriting the
// other. The socket is cheap (1x1px, and it only opens once a token arrives),
// so we keep the page mounted and control the connection purely by message.

const UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

const GW_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:transparent"><script>
var ws=null,token=null,activity=null,seq=null,sessionId=null,attemptResume=false,connectTimer=null,hbTimer=null,retryTimer=null,retryCount=0,manual=false,ready=false,refreshTimer=null,lastRx=0,hbInterval=30000,gen=0;
function post(o){try{window.ReactNativeWebView.postMessage(JSON.stringify(o));}catch(e){}}
// Report the live session out to RN so it survives this page: a WebView
// renderer killed by Android comes back with no memory of the socket, and RN
// hands the session straight back (see the 'start' handler) so the new page
// RESUMEs instead of IDENTIFYing a second session — two cards.
function postSession(){if(sessionId)post({kind:'session',sessionId:sessionId,seq:seq});}
function payload(a){
  var act={name:(a&&a.name)||'Miori',type:(a&&a.type)||0,details:((a&&a.details)||'Browsing').slice(0,128),timestamps:{start:(a&&a.startTimestamp)||Date.now()}};
  var st=a&&a.state?String(a.state).slice(0,128):'';
  if(st)act.state=st;
  if(a&&a.endTimestamp)act.timestamps.end=a.endTimestamp;
  if(a&&(a.largeImage||a.smallImage)){
    act.assets={};
    if(a.largeImage){act.assets.large_image=a.largeImage;act.assets.large_text=String(a.largeText||'').slice(0,128);}
    if(a.smallImage){act.assets.small_image=a.smallImage;act.assets.small_text=String(a.smallText||'').slice(0,128);}
  }
  if(a&&a.applicationId)act.application_id=a.applicationId;
  if(a&&a.buttons&&a.buttons.length){
    act.buttons=a.buttons.slice(0,2).map(function(b){return b.label;});
    act.metadata={button_urls:a.buttons.slice(0,2).map(function(b){return b.url;})};
  }
  var s=(a&&a.status)||'';
  if(s==='auto'||s==='')s='';
  var out={since:null,activities:[act],afk:false};
  if(s)out.status=s;
  return out;
}
// An empty activity list, sent as a parting message. See retire() for why this
// has to exist.
var CLEAR={since:null,activities:[],status:'idle',afk:false};
// Orderly shutdown. Closing a socket does NOT tell Discord anything — it keeps
// displaying the last presence that socket sent, indefinitely, until its own
// timeout expires. That is what produced the duplicate cards: an old connection
// frozen on "Viewing details" while a newer one showed the episode, with
// nothing ever clearing the first. So before dropping a socket we tell Discord
// to drop the activity, and only close once that message has had time to flush.
function retire(sock,myGen,then){
  if(!sock){then&&then();return;}
  try{
    if(sock.readyState===1){
      sock.send(JSON.stringify({op:3,d:CLEAR}));
    }
  }catch(e){}
  try{sock.onopen=null;sock.onmessage=null;sock.onclose=null;sock.onerror=null;}catch(e){}
  setTimeout(function(){
    try{sock.close();}catch(e){}
    if(then&&myGen===gen)then();
  },200);
}
// Silent teardown — no clear, no goodbye. Used when we are about to RESUME the
// same session: clearing would blank the card for no reason, and the session
// must stay alive for the resume to re-attach to it.
function hardClose(sock){
  if(!sock)return;
  try{sock.onopen=null;sock.onmessage=null;sock.onclose=null;sock.onerror=null;}catch(e){}
  try{sock.close();}catch(e){}
}
function open(){
  // Generation guard. A socket closed while still handshaking does not always
  // die immediately, so an orphan can still deliver events. Everything below is
  // a no-op unless it belongs to the newest socket — one page, one connection,
  // one activity, always.
  var myGen=++gen;
  var dying=ws;
  ws=null;
  // RESUME whenever we still own a session id. This is the whole "one RPC"
  // rule: a reconnect must re-attach to the SAME Discord session. A fresh
  // IDENTIFY while Discord still holds the old session — a dropped socket keeps
  // it resumable for MINUTES, which is exactly why the duplicate "cleared after
  // a while" — registers a SECOND session, and Discord then shows BOTH
  // activities (the stale card plus the new one) until the old one times out.
  // Only identify when there is nothing to resume, or Discord has told us the
  // session is gone (op 9, d=false). A resume also needs the last sequence
  // number, so require both — otherwise a half-known session would send op 6
  // with a null seq and get bounced straight back.
  attemptResume=!!(sessionId&&seq!==null);
  if(attemptResume){
    hardClose(dying);
    spawn(myGen);
  }else{
    // Ending it for real: say goodbye to Discord so nothing is left frozen,
    // then let that flush BEFORE the new session identifies. The other order
    // lets the clear land on the new session and wipe the activity we just set.
    retire(dying,myGen,function(){spawn(myGen);});
  }
}
function spawn(myGen){
  if(myGen!==gen)return;
  try{ws=new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');}catch(e){schedule();return;}
  lastRx=Date.now();
  post({kind:'phase',phase:'connecting'});
  // A CONNECTING socket that never opens (dead network mid-handshake) has no
  // watchdog — the silence watchdog only arms after HELLO — so it would sit
  // forever. Bound the handshake here instead.
  if(connectTimer)clearTimeout(connectTimer);
  connectTimer=setTimeout(function(){
    connectTimer=null;
    if(ws&&ws.readyState===0&&!manual)reopen('connect-timeout');
  },12000);
  ws.onopen=function(){
    if(myGen!==gen)return;
    if(connectTimer){clearTimeout(connectTimer);connectTimer=null;}
    post({kind:'phase',phase:'socket-open'});
  };
  ws.onmessage=function(ev){
    if(myGen!==gen)return;
    lastRx=Date.now();
    var m;try{m=JSON.parse(ev.data);}catch(e){return;}
    if(typeof m.s==='number')seq=m.s;
    if(m.op===10){
      post({kind:'phase',phase:'hello'});
      hbInterval=m.d.heartbeat_interval||30000;
      if(hbTimer)clearInterval(hbTimer);
      hbTimer=setInterval(beat,hbInterval);
      // Silence watchdog: mobile drops the socket without a close event more
      // often than not, and a dead ws means Discord shows us offline.
      if(refreshTimer)clearInterval(refreshTimer);
      refreshTimer=setInterval(function(){
        if(ws&&ws.readyState===1){if(Date.now()-lastRx>hbInterval*2.5){reopen('watchdog');}else{sendOp3();postSession();}}
      },Math.max(5000,Math.floor(hbInterval/2)));
      beat();
      // Two ways in, and picking the wrong one is how "two cards" happens.
      //
      // RESUME re-attaches the SAME Discord session, so the activity Discord
      // is already showing simply continues — one session, one card. A dropped
      // socket does NOT end a session: Discord keeps it resumable for MINUTES,
      // which is exactly why the duplicate "cleared after a while" rather than
      // instantly. IDENTIFY here would register a SECOND session while the old
      // one is still alive, and Discord then shows BOTH. So identify only when
      // there is nothing to resume, or Discord has told us the session is gone
      // (op 9, d=false — see below).
      try{
        if(attemptResume&&sessionId&&seq!==null){
          ws.send(JSON.stringify({op:6,d:{token:token,session_id:sessionId,seq:seq}}));
          post({kind:'phase',phase:'resuming'});
        }else{
          // Discord 4009s a re-identify that lands too soon after a dirty close.
          // Identify is already delayed by schedule()'s backoff; identify now.
          ws.send(JSON.stringify({op:2,d:{token:token,capabilities:30717,properties:{os:'Android',browser:'Chrome',device:'',system_locale:'en-US',browser_user_agent:'${UA}',browser_version:'126.0',os_version:'14',referrer:'',referring_domain:'',referrer_current:'',referring_domain_current:'',release_channel:'stable',client_build_number:361372,client_event_source:null},presence:payload(activity),compress:false,client_state:{guild_versions:{}}}}));
          lastOp3Sent=Date.now();
          post({kind:'phase',phase:'identified'});
        }
      }catch(e){schedule();}
    }
    else if(m.op===0&&m.t==='READY'){
      ready=true;retryCount=0;attemptResume=false;
      // Remember the session so any future reconnect RESUMEs instead of
      // IDENTIFYing. Without this the very next blip starts a second session.
      sessionId=m.d&&m.d.session_id?m.d.session_id:null;
      postSession();
      post({kind:'phase',phase:'ready'});
    }
    else if(m.op===0&&m.t==='RESUMED'){
      // The op 6 landed on the SAME session, so the card Discord is already
      // showing just continues — no second session, no second card. Discord
      // replays the session's events but not the presence, so re-assert the
      // current activity now rather than waiting a refresh tick.
      ready=true;retryCount=0;attemptResume=false;
      postSession();
      sendOp3(true);
      post({kind:'phase',phase:'ready'});
    }
    else if(m.op===1){beat();}
    else if(m.op===7){try{ws.close();}catch(e){}schedule();}
    else if(m.op===9){
      // Invalid session. The old code set manual=true here, which meant a
      // single 4009 — routine after any unclean disconnect — left the client
      // permanently dead and the account showed offline forever. Re-identify
      // instead, with a randomised delay, and give up only on a real stop.
      //
      // m.d is the whole story: true means the session is still resumable, so
      // keep it and let the next connect resume. false means it is gone for
      // good — forget it, or op 6 would be bounced back forever and we would
      // never identify a working session.
      if(m.d!==true)sessionId=null;
      post({kind:'phase',phase:'closed',code:4009,error:'invalid session'});
      try{ws.close();}catch(e){}
      var d=1000+Math.floor(Math.random()*4000);
      if(retryTimer)clearTimeout(retryTimer);
      retryTimer=setTimeout(function(){retryTimer=null;if(!manual){retryCount=0;open();}},d);
    }
  };
  ws.onclose=function(e){if(myGen!==gen)return;ready=false;if(hbTimer){clearInterval(hbTimer);hbTimer=null;}if(refreshTimer){clearInterval(refreshTimer);refreshTimer=null;}if(manual)return;post({kind:'phase',phase:'closed',code:(e&&e.code)||null});schedule();};
  ws.onerror=function(){if(myGen!==gen)return;};
}
function beat(){try{if(ws&&ws.readyState===1)ws.send(JSON.stringify({op:1,d:seq}));}catch(e){}}
// Every presence frame the page sends goes through here.
//
// Two limits, and the second is the important one:
//  - soft: don't double up on a frame the app just sent (keepalive only)
//  - hard: a rolling window ceiling, enforced HERE rather than upstream. Not
//    everything reaching this page comes through the RN budget — an app
//    resume doesn't, and rapid background/foreground cycling would otherwise
//    send unbounded frames. This is the code actually talking to Discord, so
//    it's the right place for the last line of defence. Over the ceiling we
//    skip the frame and keep heartbeating: a slightly stale activity is
//    harmless, a rate-limited gateway session shows the account offline.
var lastOp3Sent=0,op3Log=[];
var OP3_WINDOW=60000,OP3_MAX=20;
function op3OverBudget(){
  var cut=Date.now()-OP3_WINDOW;
  while(op3Log.length&&op3Log[0]<cut)op3Log.shift();
  return op3Log.length>=OP3_MAX;
}
function sendOp3(force){
  try{
    if(!(ws&&ws.readyState===1))return;
    // Coalesce with a frame the app just sent rather than doubling up. A real
    // state change (force) skips the soft limit but never the hard one.
    if(!force&&Date.now()-lastOp3Sent<10000)return;
    if(op3OverBudget())return;
    ws.send(JSON.stringify({op:3,d:payload(activity)}));
    lastOp3Sent=Date.now();
    op3Log.push(lastOp3Sent);
  }catch(e){}
}
function schedule(){
  if(manual||!token)return;
  // A retry is already queued (e.g. the randomised 4009 delay) — let it run
  // instead of overwriting it with the plain backoff.
  if(retryTimer)return;
  var base=[2000,5000,15000,60000][Math.min(retryCount,3)];
  retryCount++;
  // Jitter, not a fixed ladder. Discord 4009s clients that reconnect on a
  // predictable cadence, so a deterministic backoff is the one shape most
  // likely to keep tripping it. 0.75x-1.25x of base keeps the escalation
  // while breaking the lockstep.
  var b=Math.floor(base*(0.75+Math.random()*0.5));
  retryTimer=setTimeout(function(){retryTimer=null;if(!manual)open();},b);
}
function reopen(why){
  retryCount=0;
  if(retryTimer){clearTimeout(retryTimer);retryTimer=null;}
  post({kind:'phase',phase:'closed',code:null,error:why});
  open();
}
// Deliberate close, used when the app itself is going away for good.
function shutdown(){
  var myGen=++gen;
  manual=true;
  if(connectTimer){clearTimeout(connectTimer);connectTimer=null;}
  if(hbTimer){clearInterval(hbTimer);hbTimer=null;}
  if(refreshTimer){clearInterval(refreshTimer);refreshTimer=null;}
  if(retryTimer){clearTimeout(retryTimer);retryTimer=null;}
  var dying=ws;ws=null;
  retire(dying,myGen,null);
}
function ensure(){
  if(manual||!token)return;
  if(ws&&ws.readyState===1){sendOp3(true);beat();return;}
  if(retryTimer){clearTimeout(retryTimer);retryTimer=null;}
  retryCount=0;
  open();
}
window.__miori=function(raw){
  var m;try{m=JSON.parse(raw);}catch(e){return;}
  if(m.t==='start'){
    manual=false;token=m.token;activity=m.activity;
    // A fresh page (Android killed the renderer) has no session of its own, but
    // RN remembered the one the previous page held. Adopt it so the very first
    // connect RESUMEs instead of IDENTIFYing a second session. Guarded: a page
    // that still owns a session is never overwritten by a stale copy.
    if(!sessionId&&m.sessionId){sessionId=m.sessionId;seq=(typeof m.seq==='number')?m.seq:null;}
    ensure();
  }else if(m.t==='presence'){
    activity=m.activity;
    ensure();
  }else if(m.t==='resume'){
    ensure();
  }else if(m.t==='rest'){
    // Going to the background. Drop the activity but KEEP the socket: if
    // Android freezes the page and the socket dies anyway, it dies having
    // already told Discord to show nothing, so no frozen card is left behind.
    // If it survives, resuming is instant.
    try{if(ws&&ws.readyState===1)ws.send(JSON.stringify({op:3,d:CLEAR}));}catch(e){}
  }else if(m.t==='stop'){
    // Same rule on the way out: say goodbye to Discord, or it keeps showing
    // this session's last activity as a frozen second card.
    var myGen=++gen;
    manual=true;if(connectTimer){clearTimeout(connectTimer);connectTimer=null;}if(hbTimer){clearInterval(hbTimer);hbTimer=null;}if(refreshTimer){clearInterval(refreshTimer);refreshTimer=null;}if(retryTimer){clearTimeout(retryTimer);retryTimer=null;}
    var dying=ws;ws=null;
    retire(dying,myGen,null);
  }
};
// Android freezes timers on a backgrounded WebView, so a resume signal from
// the RN side (AppState) is the only reliable way back online.
document.addEventListener('visibilitychange',function(){if(!document.hidden)ensure();});
post({kind:'wv-ready'});
</script></body></html>`;

export function GatewayView() {
  const [token, setToken] = useState<string | null>(null);
  const webref = useRef<WebViewRef>(null);

  // Push bridge: stable across renders.
  useEffect(() => {
    _registerPush((msg: string) => {
      try {
        // JSON.stringify output is dropped into a JS string literal here, and
        // it does not escape U+2028/U+2029 — legal in JSON, and illegal in a
        // pre-ES2019 string literal. An anime title containing one would
        // otherwise throw a SyntaxError inside the page and silently take the
        // whole socket script down with it.
        const lit = JSON.stringify(msg)
          .split(String.fromCharCode(0x2028)).join('\\u2028')
          .split(String.fromCharCode(0x2029)).join('\\u2029');
        webref.current?.injectJavaScript(
          `(function(){try{window.__miori(${lit});}catch(e){}})();true;`
        );
      } catch {
        /* ignore */
      }
    });
    return () => _registerPush(null);
  }, []);

  /**
   * Read the credentials ONCE, and again when the app returns to the foreground.
   *
   * This used to depend on `pathname`, which meant two native bridge reads —
   * `getDiscordToken` (SecureStore) and `isPresenceEnabled` (AsyncStorage) — on
   * EVERY navigation, i.e. on every tap of the tab bar. Both are async so neither
   * blocks, but they queue real native work on exactly the frame the user is
   * trying to switch on, and a login only ever completes by leaving the app for a
   * browser and coming back.
   *
   * So: on mount, and on every return to the foreground. That still catches
   * signing in and out — the only moments the token actually changes — while a
   * tab switch does zero.
   */
  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const t = await getDiscordToken();
        if (!t) { if (live) setToken(null); return; }
        // Auto-enable presence for any logged-in account: a saved token means
        // the user wants RPC. (Privacy opt-in proved too error-prone.)
        let on = await isPresenceEnabled();
        if (!on) { await setPresenceEnabled(true); on = true; }
        if (!live) return;
        setToken(on ? t : null);
      } catch {
        /* ignore */
      }
    };
    void read();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void read();
    });
    const unsub = subscribeDiscordCredentials(() => void read());
    return () => {
      live = false;
      sub.remove();
      unsub();
    };
  }, []);

  // Credentials appearing/vanishing open or close the connection. Never a
  // remount — see the note at the render. A forced status override re-asserts
  // here too: it is account-wide (settings proto), so every fresh session
  // starts by applying whatever the selector currently demands.
  useEffect(() => {
    if (token) {
      gatewayAttach(token);
      void applyAccountStatus(token, readSetting('presence.status'));
    } else gatewayStop();
  }, [token]);

  // Re-assert the Discord status the moment the user changes it, so the
  // setting takes effect on the current session rather than on the next
  // presence update. The override itself is account-wide (settings proto —
  // see lib/presence/accountStatus.ts): the OP3 alone only moves THIS
  // session's status, which Discord merges away while the user's real app is
  // also connected. 'auto' patches the default back, un-forcing the account.
  useEffect(() => {
    let last = readSetting('presence.status');
    const unsub = subscribeSettings(() => {
      const next = readSetting('presence.status');
      if (next !== last) {
        last = next;
        gatewaySetStatus(next);
        void (async () => {
          const t = await getDiscordToken();
          if (t) await applyAccountStatus(t, next);
        })();
      }
    });
    return () => unsub();
  }, []);

  // Android freezes the WebView's timers while the app is backgrounded, so the
  // page's own reconnect backoff never fires and Discord shows us offline the
  // moment you come back. Nudge it from the RN side instead.
  useEffect(() => {
    if (!token) return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') gatewayResume();
      // Leaving: clear the activity first. A page the OS freezes (and may then
      // kill) never gets to say goodbye, and Discord would keep showing its
      // last activity as a frozen second card.
      else gatewayRest();
    });
    return () => sub.remove();
  }, [token]);

  // Android can kill the WebView's own process under memory pressure. The page
  // comes back blank and re-announces itself, but the old socket died with the
  // process — put the bridge back into "queue" mode so the next frame waits for
  // the fresh page instead of being injected into nothing.
  const onTerminate = useCallback(() => {
    _bridgePending();
  }, []);

  return (
    <View style={styles.cage} pointerEvents="none">
      <WebView
        ref={webref}
        source={GW_SRC}
        userAgent={UA}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        onContentProcessDidTerminate={onTerminate}
        onError={(e: WebViewErrorEvent) => {
          // Surface WebView load failures — invisible otherwise, and the
          // gateway page is the whole presence mechanism.
          console.error('[gateway] WebView error:', e.nativeEvent?.description ?? e.nativeEvent);
          _bridgePending();
        }}
        onHttpError={(e: WebViewHttpErrorEvent) => {
          console.error('[gateway] WebView HTTP error:', e.nativeEvent?.statusCode, e.nativeEvent?.description);
        }}
        onRenderProcessGone={() => {
          console.error('[gateway] render process gone');
          _bridgePending();
        }}
        onMessage={(e: WebViewMessageEvent) => {
          try {
            _onGatewayEvent(JSON.parse(e.nativeEvent.data));
          } catch {
            /* ignore */
          }
        }}
        style={styles.inner}
      />
    </View>
  );
}

// Stable identity: a fresh source object per render can make the native side
// reload the page, which resets the socket and re-triggers wv-ready.
// A non-null baseUrl keeps the page on a real origin. Some Android WebView
// versions refuse to run inline scripts loaded from `about:blank` in release
// builds, which is exactly how the gateway page is delivered — and a dead
// page means a dead socket means a dead card.
const GW_SRC = { html: GW_HTML, baseUrl: 'https://miori.app' };

const styles = StyleSheet.create({
  // Double containment: even if the inner WebView mis-measures itself
  // (seen: grabbing half the screen), the 1px clipped cage can't leak.
  cage: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0,
    overflow: 'hidden',
  },
  inner: { width: 1, height: 1 },
});
