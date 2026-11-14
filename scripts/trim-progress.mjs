import { readFileSync, writeFileSync } from 'fs';

const path = 'mds/progress.md';
let s = readFileSync(path, 'utf8').replace(/\r?\n/g, '\n');

// ---- Part 1: collapse the "Where the app stands" streaming layer ----
const whereStart = s.indexOf('## Where the app stands — device-confirmed 2 Nov 2026');
const whereEndMarker = '\n\n---\n\n## Traps';
let whereEnd = s.indexOf(whereEndMarker, whereStart);
if (whereEnd < 0) whereEnd = s.indexOf('\n---\n', whereStart + 100);
if (whereEnd < 0) throw new Error('MISS where-end');

const newWhere = [
  '## Where the app stands — device-confirmed 2 Nov 2026',
  '',
  '- **Streaming works end to end.** Katana (Bingr) and Mega both play, **with',
  '  qualities, subtitles, auto failover, resume, skip intro/outro.**',
  '- **Details page thumbnails work** (episode stills, TMDB `w500` tier).',
  '- List tracking, favourites, character sheets, explore/schedule/search,',
  '  Discord presence — all working (device passes 4–14 Oct).',
  '- Timeline/scrub bar device-confirmed 27 Oct (fill, knob, seek-load window).',
  '',
  'The streaming contract, filmu/Kitsu/Mega internals, subtitle decoder,',
  'failover and buffer-health logic are all documented in `scrapper.md` and',
  'the `lib/extensions/`/`lib/player/` files — not repeated here.',
  '',
  '---',
  ''
].join('\n') + '\n';

s = s.slice(0, whereStart) + newWhere + s.slice(whereEnd);

// ---- Part 2: shorten long known-problems rows ----
function findReplace(oldArr, newText) {
  const old = oldArr.join('\n');
  if (!s.includes(old)) return false;
  s = s.replace(old, newText);
  return true;
}

// Row 1
findReplace([
  "1. `[x]` Discord sign-out's full-access token leak in `pendingPatch` — FIXED 5 Nov.",
  "   `pendingPatch` (and the whole REST pacing state: `queuedKey`, `confirmedKey`,",
  "   `attempts`, `blockedUntil`, the armed retry timer) is unwound inside",
  "   `clearDiscordToken` AND `saveDiscordToken` (re-login without logout), and",
  "   `flushPatch`'s failure path stamps its epoch so a catch running ACROSS a",
  "   sign-out cannot re-queue the dead session's PATCH. Three device-independent",
  "   mutations all watched failing (`check-signout.ts` Discord section).",
  "   Gateway side needed nothing: every restart path re-reads the token and bails",
  "   on null."
], "1. `[x]` Discord sign-out token leak — FIXED 5 Nov. `pendingPatch` unwinds on both `clearDiscordToken` and `saveDiscordToken`; `flushPatch` failure stamps its epoch so a catch across a sign-out cannot re-queue the dead session. Three mutations watched failing in `check-signout.ts`.");

// Row 2
findReplace([
  "2. `[x]` Cross-device AniList edits — FIXED 5 Nov. On every ring to the foreground,",
  "   `refreshUserListOnForeground()` now force-fetches the externally-mutable",
  "   slice with `staleTime` bypassed: user-keyed `['home']`, `['viewer']`, and",
  "   MOUNTED `['listEntry', …]` only. The guest rails (`['home', 'anon', …]`),",
  "   generic `['media']` and unmounted entries are untouched — the sweep's",
  "   restraint is kept for everything that is not another device's write. The",
  "   pairing is one request, not two: the sweep joins an in-flight refresh.",
  "   `check-foreground-list.ts` drives the real function; three mutations",
  "   (anon leak, unmounted leak, slice leak) all watched failing."
], "2. `[x]` Cross-device AniList edits — FIXED 5 Nov. `refreshUserListOnForeground` force-refetches `['home']`, `['viewer']`, and mounted `['listEntry', …]` on every ring to active, scoped to exclude anon rails / generic media / unmounted entries. One request joins an in-flight refresh. `check-foreground-list.ts` 7/7.");

// Row 9
findReplace([
  "9. `[x]` Declarative extension loader — Level 1 DONE. All five sources (filmu, mega,",
  "   anikoto, zoko, example) load from the Miori-Extensions repo; built-ins off by",
  "   default (`SHIP_BUILTIN_SOURCES=false`); multi-source parity preserved; static-parity",
  "   check `scripts/check-extensions-parity.ts` (5/5). Level 2 (decouple logic — generic",
  "   codecs + multi-step flows) remains — see roadmap.md A.",
  "   Section grids for home \"See all\"; profile area; downloads/offline; dub toggle remain."
], "9. `[x]` Declarative extension loader — Level 1 DONE. All five sources (filmu/mega/anikoto/zoko/example) load from the Miori-Extensions repo; built-ins off by default (`SHIP_BUILTIN_SOURCES=false`). `check-extensions-parity.ts` 5/5. Level 2 (decouple logic — generic codecs + multi-step flows) remains — see roadmap.md A.");

// Row 12
findReplace([
  "12. `[~]` **Re:ANIME extension (`reanime.to`) — research done, code not written,",
  "    parked 12 Nov at the user's call.** Full contract in `scrapper.md` Source 3.",
  "    Key facts: `.to` 301s web→`.wtf` but its `/api/*` serves HTML — the",
  "    extension needs real `.to`→`.wtf` host failover per call; anilist→slug via",
  "    their search API (returns both ids); `can_watch:false` titles have NO",
  "    streams (gate match() on it). Streams: `/api/flix/{anilist}/{ep}` →",
  "    flixcloud embeds → AES-256-CBC chain verified in Node to the last step —",
  "    blocked ONLY on their per-page-obfuscated wasm (constants rotate every page",
  "    load by design; a hardcoded port can never work). Remaining work: finish",
  "    the mini wasm interpreter (op vocabulary is stable, ~150 lines; the probe",
  "    harness had a pre-scan off-by-one — interpreter ran but wrote nothing),",
  "    then `lib/extensions/reanime/index.ts` against the standard contract",
  "    (match/episodes/resolve + subs + intro/outro from the embed blob)."
], "12. `[~]` **Re:ANIME extension (`reanime.to`) — research done, code not written, parked 12 Nov.** Full contract in `scrapper.md` Source 3. Verified live: search returns anilist_id+slug; `/api/flix/{anilist}/{ep}` → 5 flixcloud servers; embed page carries subs (SRT), intro/outro chapters, and an AES-256-CBC chain verified in Node to the last step — blocked ONLY on their per-page-obfuscated wasm (constants rotate every load; a hardcoded port is impossible). Next: finish the ~150-line wasm interpreter, then `lib/extensions/reanime/index.ts`.");

// Row 13
findReplace([
  "13. `[~]` **App updates: check → prompt → download → installer BUILT (14 Nov);",
  "    the bell/inbox and airing reminders are still not.**",
  "    Plan #1 is done, GitHub direct and server-free. `lib/updates/`: `version.ts`",
  "    + `release.ts` are PURE (tag parse, NUMERIC compare — `1.10.0` > `1.9.9` —,",
  "    release payload → normalised version/plain notes/ABI-ranked `.apk` pick, and",
  "    `shouldPrompt` where a skip only silences AUTO checks and expires on a newer",
  "    release; `scripts/check-updates.ts` 35/35), `store.ts` is ONE check per",
  "    launch (6s after fonts, `fetchJson` 12s) plus the manual one, `install.ts`",
  "    the `getContentUriAsync` + `expo-intent-launcher` handoff.",
  "    `components/updates/UpdatePrompt.tsx` is the centred card (notes, progress,",
  "    Download & install / Skip <version> / Later), mounted once in `_layout.tsx`;",
  "    Settings → About shows `expoConfig.version` (NOT `nativeApplicationVersion`,",
  "    which is Expo Go's own 58.x) and a Check row. New setting",
  "    `updates.skippedVersion`.",
  "    ⚠️ The download/install HALF IS NATIVE — expo-file-system +",
  "    expo-intent-launcher + `REQUEST_INSTALL_PACKAGES` in app.json — so it cannot",
  "    run in the current APK; it needs a new build, and no device pass has happened.",
  "    The rest of `notifications-and-updates.md` is the written plan and the",
  "    reason for its order — bell → in-app **Updates inbox** read from a JSON",
  "    manifest (no permission, no server), then **airing reminders as LOCAL",
  "    notifications** (AniList's",
  "    `nextAiringEpisode` is already fetched and cached, so the data is there),",
  "    then OTA via `expo-updates`, push last. The navbar bell's `onNotify`",
  "    (`components/nav/NavBar.tsx`) is still an honest Alert placeholder: replace",
  "    its body with a route, never with a permission prompt on first launch. Two",
  "    build-only constraints before any of it is testable: Android 13+ prompts for",
  "    notification permission, Expo Go has no push since SDK 53, and",
  "    `Updates.checkForUpdateAsync()` rejects in development mode and Expo Go."
], "13. `[~]` **App updates: check → prompt → download → installer BUILT (14 Nov).** `lib/updates/`: `version.ts`+`release.ts` pure (tag parse, NUMERIC compare `1.10.0`>`1.9.9`, release→normalised version/plain notes/ABI-ranked `.apk`, `shouldPrompt` where skip silences AUTO checks and expires on a newer release), `store.ts` one check/launch (6s after fonts), `install.ts` the `getContentUriAsync`+`expo-intent-launcher` handoff. `UpdatePrompt.tsx` centred card (notes, progress, Download&install/Skip<version>/Later), mounted once in `_layout.tsx`; Settings→About shows `expoConfig.version` (NOT `nativeApplicationVersion`, Expo Go's own 58.x) + Check row. New setting `updates.skippedVersion`. ⚠️ download/install HALF IS NATIVE — expo-file-system+`expo-intent-launcher`+`REQUEST_INSTALL_PACKAGES` — needs a new build; no device pass yet. Bell/inbox + airing reminders still not done (see `notifications-and-updates.md`). `check:updates` 35/35.");

// ---- Part 3: rebuild the history table compactly ----
const histHead = '## History (one line each; details in git + code comments)';
const histStartI = s.indexOf(histHead);
const histEndI = s.indexOf('\n---\n', histStartI + 50);
if (histStartI < 0 || histEndI < 0) throw new Error('MISS history');

const histBlock = s.slice(histStartI, histEndI).split('\n');

const rows = [];
for (const ln of histBlock) {
  const trimmed = ln.trim();
  if (trimmed && !trimmed.startsWith('---') && !trimmed.startsWith('| Date |')) {
    rows.push(trimmed);
  }
}

const newHist = ['| Date | What happened |', '|---|---|', ...rows].join('\n') + '\n';
s = s.slice(0, histStartI) + newHist + s.slice(histEndI);

// ---- Write back with CRLF ----
writeFileSync(path, s.replace(/\n/g, '\r\n'), 'utf8');
console.log('progress.md compressed. Final lines:', (s.match(/\n/g) || []).length + 1);
