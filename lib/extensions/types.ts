// Miori extension contract.
// Every scrapper (filmu, mega, future ones) MUST follow this shape.
// The player + UI only talk to this interface, never to a source directly.
//
// v1: extensions are compiled inside the app (one folder per source).
// v2: same files loaded from a repo URL / Supabase — loader changes,
//     this interface stays the same.

export type Container = 'hls' | 'mp4';

export interface SubtitleTrack {
  label: string;
  lang?: string;
  url: string;
  /** Fetch headers needed for this sub file (e.g. Referer-gated hosts). */
  headers?: Record<string, string>;
}

export interface WatchSource {
  url: string;
  container: Container;
  quality?: string;
  /**
   * Which extension minted this row — tagged by the REGISTRY at resolve time,
   * not by the extension itself (the registry is the one place that knows).
   * The player uses it to remember the last source that actually played for
   * this anime (`miori:srcPref:{id}`) so a return visit starts where the
   * viewer left off instead of always at the top of the ranked list.
   * Optional because the contract is additive and extensions never set it.
   */
  extId?: string;
  /** Headers the player must send (Referer / Origin / UA). */
  headers?: Record<string, string>;
  /**
   * Re-issue this source with fresh upstream state. Used when a source is
   * SIGNED — its url is valid at resolve time (it probed) but dies minutes
   * later with the viewer still in the room, and the player's failover walk
   * would otherwise bury it under the next source without a second chance.
   * Returns the refreshed source, or null for "this source is genuinely gone;
   * stop trying it". Throwing is also an out. Extensions whose urls do not
   * expire leave this undefined.
   */
  refresh?: () => Promise<WatchSource | null>;
  subtitles?: SubtitleTrack[];
  /** Skip markers (MegaPlay returns these). */
  intro?: { start: number; end: number } | null;
  outro?: { start: number; end: number } | null;
}

export interface EpisodeInfo {
  number: number;
  title?: string;
  poster?: string | null;
  /** One line of description, where a provider offers it. */
  synopsis?: string | null;
  /** Runtime in SECONDS, from the provider. */
  duration?: number | null;
}

export interface ExtensionMatch {
  /** This extension can serve this title. */
  available: boolean;
  /** Extension's own id for the title (if different from AniList id). */
  externalId?: string | number;
}

/**
 * Additive-optional caller hint (contract rule 3). Some sources can only map
 * anilist id -> their ids via keyword SEARCH (the anikoto catalog has no
 * ani/mal-keyed lookup route), so the caller — which already holds the
 * AniList title — passes candidates. Extensions that don't need them ignore
 * this entirely; old manifests never see it.
 */
export interface ResolveHint {
  /** Title candidates for keyword mapping, best first (romaji, english…). */
  titles?: string[];
}

/** What a source can do. Optional and additive — old manifests/old extensions
 *  that omit it are assumed to support nothing beyond streaming. UI uses this
 *  to show/hide affordances (subs picker, skip buttons, thumbnails) without
 *  probing. */
export interface ExtensionCapabilities {
  subtitles?: boolean;
  skipMarkers?: boolean;
  thumbnails?: boolean;
  dub?: boolean;
}

export interface Extension {
  id: string;
  label: string;
  version: string;
  /** Contract version this extension targets. Defaults to 1. The loader refuses
   *  manifests whose contractVersion exceeds what the engine understands. */
  contractVersion?: number;
  /** Optional capability flags. See ExtensionCapabilities. */
  capabilities?: ExtensionCapabilities;

  /** Can this extension serve this AniList id? (gates the chip in UI) */
  match(anilistId: number, idMal?: number | null, hint?: ResolveHint): Promise<ExtensionMatch>;

  /** Episode list for a title. */
  episodes(anilistId: number, idMal?: number | null, hint?: ResolveHint): Promise<EpisodeInfo[]>;

  /** Playable sources for one episode, best first. Player fails over down the list. */
  resolve(
    anilistId: number,
    episode: number,
    idMal?: number | null,
    hint?: ResolveHint
  ): Promise<WatchSource[]>;
}
