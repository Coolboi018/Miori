// Per-episode metadata from Kitsu — thumbnails, titles, synopses, runtime.
//
// WHY A SECOND PROVIDER, AND WHY IT IS NOT THE PRIMARY ONE.
//
// The playable sources come from the extensions (FilmU, MegaPlay). Those are
// scrapers of video hosts: they know which episode files exist and roughly what
// they are called, and they have no reason to have illustrated any of them. In
// practice FilmU returns `poster: null` for nearly every episode, which is why
// `EpisodeRow` falls back to a bare number chip for so many titles — the number
// chip is not a loading state, it is the permanent fallback for a thumbnail that
// was never there.
//
// AniList cannot help. Its API has no episode entity at all: `episodes` is a
// COUNT, and there is nothing to select per episode. So the per-episode data has
// to come from somewhere else, and Kitsu has it — measured across five titles,
// every episode returned a thumbnail, a real title and a synopsis.
//
// THIS IS A FILL-IN, NOT A REPLACEMENT. FilmU remains the source of truth for
// WHICH episodes exist, because it is the thing that can actually play them. This
// module only supplies presentation for rows that are already decided. If Kitsu
// disagrees about the count, Kitsu loses — it must never add or remove a row,
// only decorate one.
//
// PAGED AND ON DEMAND — the reason this is not one `fetchAll`.
//
// The first version walked every page of a title on open, and that was wrong in
// two ways that only show up on a long series:
//
//   1. IT TRUNCATED SILENTLY. Kitsu serves 20 episodes per page, so a 1,000
//      episode title is FIFTY pages. The loop was capped at 6 — 120 episodes —
//      which for anything longer than that meant the tail of the list quietly had
//      no artwork and nothing anywhere said so. A cap that hides itself is worse
//      than no cap, because the fallback chip looks like a fact about the title
//      rather than a fact about our request budget.
//   2. IT PAID FOR INVISIBLE EPISODES. The screen shows `EPISODES_PER_PAGE` rows
//      at a time. Fetching 120 episodes to decorate 10 spends twelve requests on
//      artwork nobody is looking at, on the one screen that most needs to open
//      fast.
//
// So the fetch is keyed on the page the user is actually looking at, and nothing
// else. The screen hands over the episode numbers currently rendered and this
// module works out which Kitsu page(s) cover them. Walking the pager fetches one
// more page per step, and never the other forty-nine.
//
// THE ORDERING CONSEQUENCE, because it is not obvious. The default sort is
// `desc`, so page one of a 1,000-episode show is episodes 991-1000 — which live
// on Kitsu page FIFTY, not page one. This module therefore fetches by the
// numbers it is given rather than by "the next unread page", and that is the only
// thing that makes paging work in descending order at all.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { EpisodeInfo } from '@/lib/extensions/types';

const KITSU = 'https://kitsu.io/api/edge';
const HEADERS = { Accept: 'application/vnd.api+json' };

const STORE_KEY = 'miori:kitsu-episodes';
const CACHE_MAX = 200;
/** How long a title cools down after a 429 (ms). Global, per-title, in-memory. */
const COOLDOWN_MS = 90_000;
/** anilistId -> timestamp until which requests are suspended. */
const cooldownUntil = new Map<number, number>();

/** Kitsu rejects `page[limit]` above 20 (HTTP 400, code 118 — verified). */
const PAGE_LIMIT = 20;

/**
 * Most pages fetched in one pass.
 *
 * A bound, not a policy: one screen normally needs exactly one. The case it
 * exists for is the episode SEARCH — typing "1" matches episodes 1, 10-19, 21,
 * 31 and so on, scattered across the whole catalogue, and without a ceiling one
 * keystroke would fan out into dozens of requests. When the ceiling bites the
 * rest are simply not fetched until the user narrows the search, which is the
 * right failure: rows show the number chip, and there is nothing broken.
 */
const MAX_PAGES_PER_PASS = 4;

/** One episode's worth of presentation, keyed by episode number. */
export interface KitsuEpisodeMeta {
  title?: string;
  poster?: string | null;
  synopsis?: string | null;
  /** Per-episode runtime in minutes. */
  length?: number | null;
}

/** anilistId -> episode number -> meta. */
const cache = new Map<number, Record<number, KitsuEpisodeMeta>>();
/** anilistId -> Kitsu's own id, once resolved. `null` means there is no mapping. */
const kitsuIds = new Map<number, string | null>();
/** anilistId -> Kitsu page numbers already fetched, so a revisit is free. */
const fetchedPages = new Map<number, Set<number>>();

/**
 * anilistId -> page numbers currently IN FLIGHT.
 *
 * SEPARATE FROM `fetchedPages`, and that separation is the whole point. A page
 * can only be marked fetched once its response has been parsed, which is at least
 * one network round-trip after the request goes out — so between "sent" and
 * "landed" a page is in neither set, and every caller in that window decides to
 * fetch it. Mashing the pager produced exactly that: four taps, four effect runs,
 * and the same page going out up to four times inside a second, against a limit
 * of three.
 *
 * Marking it pending BEFORE the `await` closes the window. The first caller wins
 * and everyone behind it joins that request rather than starting another; the
 * entry is cleared in a `finally`, so a failure releases the page for a retry
 * instead of wedging it as permanently "in progress".
 */
const pendingPages = new Map<number, Set<number>>();

/** Titles whose mapping request is in flight, same reasoning as `pendingPages`. */
const pendingIds = new Set<number>();

let loaded: Promise<void> | null = null;

/**
 * Which Kitsu page holds a given episode.
 *
 * Episodes are served in order, 20 to a page, so a number maps to its page by
 * arithmetic rather than by counting anything the app has seen. That is what
 * makes random access work: page 50 can be fetched without pages 1-49.
 *
 * `?? a.number` in the parser below means a title whose `absoluteNumber` is
 * missing falls back to per-season numbering, which agrees with this for a
 * single-season title and is wrong by a constant offset for a multi-season one.
 * No better option exists without the absolute number, and being off by one page
 * costs a missing thumbnail, never a wrong one.
 */
export function kitsuPageFor(episodeNumber: number): number {
  return Math.ceil(episodeNumber / PAGE_LIMIT);
}

const POLL_MS = 40;

/**
 * THE MINIMUM GAP BETWEEN REQUESTS, and the reason there is one.
 *
 * Kitsu allows roughly three requests a second per IP. Nothing here needs that
 * many: one page of artwork per screenful is the design, and a warm title needs
 * none at all. The gap exists only so that the pathological cases — a user
 * walking the pager quickly, or the episode search fanning out across scattered
 * numbers — cannot add up to a burst that earns a 429.
 *
 * `>= 3/s` is deliberately at the limit rather than under it. `lib/net/gql.ts`
 * runs AniList under its 30/min on the reasoning that a limiter set exactly at a
 * documented limit has no margin for a retry; that argument does not transfer,
 * because there is no retry here. A 429 here costs one screen's artwork, and
 * nothing retries — so the honest trade is speed against a small chance of the
 * number chip, and 340ms keeps a five-page walk inside three requests a second
 * while never making a user wait on a single request they would not have made
 * anyway.
 */
const MIN_GAP_MS = 340;

/** Serialises every fetch in this module through one gate. */
let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run `task` after the gate opens, spacing it from whatever ran before.
 *
 * A promise CHAIN rather than a queue of timers, so ordering is guaranteed by
 * construction and a rejected link cannot strand the ones behind it — each link
 * resolves regardless of what the previous did.
 */
function gated<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastAt);
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      lastAt = Date.now();
    }
  });
  // Swallow on the CHAIN only: a caller still sees its own rejection, but the
  // gate stays open for the next task.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * AniList id -> Kitsu's own id, in ONE request.
 *
 * Kitsu does not accept MAL ids: `/anime/{malId}/episodes` 404s with "Record not
 * found" on a perfectly valid MAL number, because that path is Kitsu's primary
 * key and MAL is a different namespace. The mapping is AniList id -> Kitsu id.
 *
 * `include: 'item'` is what keeps this to one call. Without it the `item`
 * relationship comes back as LINKS ONLY — no `data` — so the Kitsu id does not
 * appear in the response at all and a follow-up request to `links.related` is
 * needed. With it the item is inlined into `included`.
 */
async function resolveKitsuId(anilistId: number): Promise<string | null> {
  // Stand-down: a previous 429 means we do not even try until the cooldown ends.
  // The next user action (page, search) re-fires naturally after that.
  const cool = cooldownUntil.get(anilistId) ?? 0;
  if (cool > Date.now()) return null;

  if (kitsuIds.has(anilistId)) return kitsuIds.get(anilistId) ?? null;
  // Someone else is already asking. Waiting rather than firing a second request:
  // by the time this returns, the answer is in `kitsuIds` and the caller proceeds
  // normally.
  if (pendingIds.has(anilistId)) {
    while (pendingIds.has(anilistId)) await sleep(POLL_MS);
    return kitsuIds.get(anilistId) ?? null;
  }
  pendingIds.add(anilistId);

  const q = new URLSearchParams({
    'filter[externalSite]': 'anilist/anime',
    'filter[externalId]': String(anilistId),
  });
  try {
    const res = await fetch(`${KITSU}/mappings?${q}&include=item`, { headers: HEADERS });
    if (res.status === 429) {
      // Rate-limited: cool down the title, do NOT record a permanent "no mapping"
      // (that would make the title unreachable for the whole session).
      cooldownUntil.set(anilistId, Date.now() + COOLDOWN_MS);
      return null;
    }
    if (!res.ok) {
      kitsuIds.set(anilistId, null);
      return null;
    }
    const json = (await res.json()) as {
      data?: Array<{ relationships?: { item?: { data?: { id?: string } | null } } }>;
    };
    const id = json?.data?.[0]?.relationships?.item?.data?.id ?? null;
    kitsuIds.set(anilistId, id);
    return id;
  } catch {
    // NOT recorded as "no mapping" — a network failure is not a permanent fact
    // about the title, and caching one would make a title unreachable for the
    // rest of the session by a single dropped connection.
    return null;
  } finally {
    pendingIds.delete(anilistId);
  }
}

/**
 * Kitsu episode attributes, as they ACTUALLY arrive.
 *
 * Two shapes that both read as "no data" if guessed wrong, and both verified
 * against a live response:
 *
 *   thumbnail  NOT `{ large }` the way Kitsu POSTERS are shaped. An episode
 *              thumbnail is `{ original: url }` — one key. Reading `.large`
 *              yields undefined on every episode and makes a fully illustrated
 *              set look empty — which is exactly the wrong answer to give a
 *              fill-in that is supposed to ADD artwork.
 *   title      NOT `title`. It is `titles.{en_us,en_jp,ja_jp}` alongside a
 *              `canonicalTitle` that is already resolved and preferred.
 */
function toMeta(a: Record<string, unknown>): KitsuEpisodeMeta {
  const thumb = (a.thumbnail ?? {}) as { original?: string | null };
  const titles = (a.titles ?? {}) as { en_us?: string; en_jp?: string; ja_jp?: string };
  const title =
    (a.canonicalTitle as string | undefined) ??
    titles.en_us ??
    titles.en_jp ??
    titles.ja_jp ??
    undefined;
  const synopsis = typeof a.synopsis === 'string' && a.synopsis ? a.synopsis : undefined;
  const length = typeof a.length === 'number' ? a.length : null;
  return { title, poster: thumb.original ?? null, synopsis, length };
}

/**
 * ARTWORK ONLY EXISTS FOR THE EARLY EPISODES OF A LONG TITLE.
 *
 * Verified against Fairy Tail (Kitsu `anime/4676`, `meta.count: 175`):
 *
 *   episodes 1-20    12 of 20 have a thumbnail
 *   episodes 21-40    0
 *   episodes 161-175  0
 *
 * Kitsu indexes the whole series but only illustrated the first stretch of it.
 * So on a long title the artwork runs out and the rest of the list falls back to
 * the number chip — which is the CORRECT rendering of "this provider has no
 * image for this episode", not a bug in this module, and not something paging
 * can fix.
 *
 * What paging DOES fix is everything else: titles and synopsies are present for
 * the full run, so a long title's list gets real episode names throughout rather
 * than "Episode 47". Worth knowing before spending more effort here — the ceiling
 * is upstream, and the honest response is to let the chip stand.
 */

/** Fetch ONE page of episodes for a Kitsu title and merge it into the cache. */
async function fetchPage(
  anilistId: number,
  kitsuId: string,
  page: number
): Promise<void> {
  const cool = cooldownUntil.get(anilistId) ?? 0;
  if (cool > Date.now()) return;

  const q = new URLSearchParams({
    'page[limit]': String(PAGE_LIMIT),
    // `page[offset]`, NOT `page[number]`. Both are documented Kitsu params and
    // only one of them works here: `page[number]=2` returns page ONE again, on
    // this endpoint, silently and with a 200 — verified against a 175-episode
    // title, where every page number returned episodes 1-20.
    //
    // That failure is nastier than an error, because the first version of this
    // loop paged with `page[number]` and cached page 1's rows under page 2, 3, 4…
    // So every episode past 20 was marked "fetched" while holding no data, and
    // the list looked permanently un-artworked past the twentieth row with
    // nothing anywhere reporting a problem.
    'page[offset]': String((page - 1) * PAGE_LIMIT),
  });

  // Claim the page BEFORE anything is awaited. Everything after this line can
  // suspend, and a page that is not yet claimed is a page a second caller will
  // also decide to fetch.
  const pending = pendingPages.get(anilistId) ?? new Set<number>();
  if (pending.has(page)) return;
  pending.add(page);
  if (!pendingPages.has(anilistId)) pendingPages.set(anilistId, pending);

  try {
    let res: Response;
    try {
      res = await gated(() =>
        fetch(`${KITSU}/anime/${kitsuId}/episodes?${q}`, { headers: HEADERS })
      );
    } catch {
      return;
    }
    if (res.status === 429) {
      cooldownUntil.set(anilistId, Date.now() + COOLDOWN_MS);
      return;
    }
    if (!res.ok) return;
    const json = (await res.json()) as { data?: Array<{ attributes?: Record<string, unknown> }> };
    const rows = json?.data ?? [];
    if (!rows.length) return;

    // A NEW object per page, because this is the identity the screen's memo
    // compares against. Mutating in place would leave `mergeKitsuMeta` memoised on
    // an unchanged reference and the rows would never pick the artwork up.
    const merged = { ...(cache.get(anilistId) ?? {}) };
    for (const row of rows) {
      const a = (row.attributes ?? {}) as Record<string, unknown>;
      // `absoluteNumber` is preferred and it is NOT available: verified against a
      // 175-episode title, Kitsu omits it from every episode row even when asked
      // for explicitly via `fields[episode]`. So this falls to `number` in
      // practice.
      //
      // That is correct for a title Kitsu stores as ONE entry — Fairy Tail is
      // `anime/4676` with `meta.count: 175` and `number` running 1..175 unbroken,
      // which is how these long series are modelled. It would be wrong for a
      // title split into seasons, where `number` restarts at 1 and two episodes
      // would collide onto one key. Nothing better is reachable from this API,
      // and the failure is one wrong key rather than a crash.
      const key = Number(a.absoluteNumber ?? a.number);
      if (!Number.isFinite(key) || key <= 0) continue;
      merged[key] = toMeta(a);
    }
    cache.set(anilistId, merged);
    fetchedPages.get(anilistId)?.add(page);
    schedulePersist();
  } finally {
    // Released on failure too, so a 429 or a dropped connection leaves the page
    // fetchable again rather than permanently stuck as "in progress".
    pending.delete(page);
  }
}

/**
 * Fetch the Kitsu pages that cover a set of episode numbers.
 *
 * THE SCREEN'S ONLY ENTRY POINT, and it takes episode NUMBERS rather than a page
 * index because the screen knows which rows it rendered and this module knows how
 * they are stored. Deduped, already-fetched pages are skipped, and the whole
 * thing is capped at `MAX_PAGES_PER_PASS`.
 *
 * NEVER rejects. A second provider being unreachable must not be able to break a
 * screen whose primary source already answered — every failure resolves with the
 * rows untouched, which is the number-chip fallback, i.e. exactly what the screen
 * looked like before this existed.
 */
export async function resolveKitsuEpisodes(
  anilistId: number,
  episodeNumbers: readonly number[]
): Promise<void> {
  await ensureLoaded();
  if (!episodeNumbers.length) return;
  const cool = cooldownUntil.get(anilistId) ?? 0;
  if (cool > Date.now()) return;

  const done = fetchedPages.get(anilistId) ?? new Set<number>();
  if (!fetchedPages.has(anilistId)) fetchedPages.set(anilistId, done);
  const pending = pendingPages.get(anilistId) ?? new Set<number>();
  if (!pendingPages.has(anilistId)) pendingPages.set(anilistId, pending);

  // A page is wanted if it is neither already stored nor already in flight. The
  // in-flight half is what collapses a burst of pager taps into one request.
  const wanted: number[] = [];
  for (const n of episodeNumbers) {
    const page = kitsuPageFor(n);
    if (done.has(page) || pending.has(page)) continue;
    if (!wanted.includes(page)) wanted.push(page);
    if (wanted.length >= MAX_PAGES_PER_PASS) break;
  }
  if (!wanted.length) return;

  const kitsuId = await resolveKitsuId(anilistId);
  // No mapping is a permanent fact, so it IS recorded — unlike a network failure
  // above. Without it every visit re-asks for a title that will never have one.
  if (!kitsuId) {
    kitsuIds.set(anilistId, null);
    schedulePersist();
    return;
  }

  // Sequential rather than parallel: these are all for one title and the pager
  // only ever needs the first page immediately. Fanning out would put the page
  // the user is LOOKING at behind the three that a broad search also matched.
  for (const page of wanted) {
    try {
      await fetchPage(anilistId, kitsuId, page);
    } catch {
      /* one page failing must not abandon the rest */
    }
  }
}

/**
 * The cached metadata for a title, or `null` if nothing has been fetched.
 *
 * Synchronous by design: the screen reads it during render, exactly like the
 * persisted AniList cache, so a warm title costs no await and no state.
 */
export function peekKitsuEpisodes(anilistId: number): Record<number, KitsuEpisodeMeta> | null {
  const hit = cache.get(anilistId);
  if (!hit) return null;
  return Object.keys(hit).length ? hit : null;
}

/** Bumped whenever a page lands, so a memo keyed on it re-runs. */
export function kitsuEpisodeVersion(anilistId: number): number {
  return cache.get(anilistId) ? (fetchedPages.get(anilistId)?.size ?? 0) : 0;
}

function ensureLoaded(): Promise<void> {
  if (!loaded) {
    loaded = AsyncStorage.getItem(STORE_KEY)
      .then((raw) => {
        if (!raw) return;
        const entries = JSON.parse(raw) as Array<[number, Record<number, KitsuEpisodeMeta>]>;
        for (const [id, meta] of entries) {
          cache.set(id, meta);
          // Restored pages are recorded as fetched so a warm title does not
          // re-request artwork it already has on disk. The page NUMBERS are
          // inferred from the keys rather than stored, which is why they are
          // derived through `kitsuPageFor` rather than trusted.
          const pages = new Set<number>();
          for (const key of Object.keys(meta)) pages.add(kitsuPageFor(Number(key)));
          fetchedPages.set(id, pages);
        }
      })
      .catch(() => {
        /* corrupt or unavailable — the lookups simply happen again */
      });
  }
  return loaded;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (cache.size > CACHE_MAX) {
      // Insertion order, and the oldest entry is the least likely to be asked
      // for again — it was resolved long ago.
      const excess = cache.size - CACHE_MAX;
      let dropped = 0;
      for (const key of cache.keys()) {
        cache.delete(key);
        kitsuIds.delete(key);
        fetchedPages.delete(key);
        if (++dropped >= excess) break;
      }
    }
    void AsyncStorage.setItem(STORE_KEY, JSON.stringify([...cache.entries()])).catch(() => {});
  }, 500);
}

/** Wipe the persisted episode metadata. The settings screen's cache reset uses this. */
export async function clearKitsuEpisodeCache(): Promise<void> {
  cache.clear();
  kitsuIds.clear();
  fetchedPages.clear();
  pendingPages.clear();
  pendingIds.clear();
  cooldownUntil.clear();
  await AsyncStorage.removeItem(STORE_KEY).catch(() => {});
}

/**
 * Merge Kitsu's metadata into rows a source already decided on.
 *
 * `base` is the source's list and it WINS on membership: a Kitsu episode with no
 * counterpart is dropped, and a source episode with no Kitsu counterpart is kept
 * exactly as it is. Only `title`, `poster` and `synopsis` are filled, and only
 * where the source left them empty — a source that supplied a real title keeps
 * it, because it is closer to the video the user is about to watch.
 *
 * `length` is applied when Kitsu has one and the source did not: it is a runtime
 * in minutes that no extension reports.
 */
export function mergeKitsuMeta(
  base: EpisodeInfo[],
  meta: Record<number, KitsuEpisodeMeta> | null
): EpisodeInfo[] {
  if (!meta || !Object.keys(meta).length) return base;
  const out: EpisodeInfo[] = [];
  for (const e of base) {
    const m = meta[e.number];
    if (!m) {
      out.push(e);
      continue;
    }
    out.push({
      number: e.number,
      title: e.title || m.title,
      poster: e.poster ?? m.poster ?? null,
      synopsis: e.synopsis ?? m.synopsis ?? null,
      duration: e.duration ?? (m.length ? m.length * 60 : null),
    });
  }
  return out;
}