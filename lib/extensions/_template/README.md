# Extension template checklist

Copy `_template/` to a new folder (e.g. `lib/extensions/mysite/`) and replace every `TODO`.

- [ ] `id` — unique, lowercase, stable (used in UI and cache keys)
- [ ] `label` — human name shown in the source sheet
- [ ] `version` — bump on any behavior change
- [ ] `capabilities` — subtitles / skipMarkers / thumbnails / dub
- [ ] `match()` — returns `{ available }`; never throws (catch inside)
- [ ] `episodes()` — returns `EpisodeInfo[]`; throws on empty (never cache empty)
- [ ] dedupe by number; sort ascending
- [ ] map stills to w500 tier
- [ ] `resolve()` — returns `WatchSource[]` best first; probe + rank
- [ ] assert container when URL is silent
- [ ] signed URLs carry `refresh()`
- [ ] sub tracks carry their fetch headers (Referer etc.)
- [ ] every request goes through `fetchTimed`/`fetchText`/`fetchJson`
- [ ] add to `scripts/test-extensions.ts` (golden title) before phone test
- [ ] add to your extension repo's `index.json` when publishing
