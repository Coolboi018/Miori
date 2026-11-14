// Extension template — copy this folder to create a new source.
//
// Rules (do not simplify — see progress.md "Traps"):
//  - An empty episode list is a FAILURE, never an answer. Throw on empty.
//  - Dedupe episodes by number (first occurrence wins).
//  - Never cache an empty result.
//  - Use fetchTimed/fetchText/fetchJson for every request (whole-body deadline).
//  - Assert container ('hls'/'mp4') when the URL is silent; never derive it.
//  - Signed URLs must carry a refresh() closure.
//  - Subtitle tracks that need headers (e.g. Referer) must carry them.
//  - Map stills to the w500 tier when the host offers it.
//  - Probe + rank sources; never drop on doubt.

import type { EpisodeInfo, Extension, ExtensionMatch, WatchSource } from '../types';
import { fetchJson, fetchText, probeSource } from '../fetch';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function createTemplateExtension(): Extension {
  return {
    id: 'template',
    label: 'Template Source',
    version: '0.1.0',
    contractVersion: 1,
    capabilities: { subtitles: false, skipMarkers: false, thumbnails: false },

    async match(anilistId: number): Promise<ExtensionMatch> {
      // TODO: probe whether this source has the title.
      return { available: false };
    },

    async episodes(anilistId: number): Promise<EpisodeInfo[]> {
      // TODO: fetch + map episode list. Throw on empty.
      return [];
    },

    async resolve(anilistId: number, ep: number): Promise<WatchSource[]> {
      // TODO: fetch stream url, probe, return best-first list.
      return [];
    },
  };
}