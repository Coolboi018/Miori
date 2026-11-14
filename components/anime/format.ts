// Formatting helpers shared by the episode list and the detail screen.

/** Seconds → "24m" / "1h 08m". Mirrors the runtime badge in the reference. */
export function fmtDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/** AniList `duration` is minutes-per-episode. */
export function minutesToSeconds(mins?: number | null): number | null {
  return typeof mins === 'number' && mins > 0 ? mins * 60 : null;
}

/** AniList averageScore is 0–100. Mirrors the site's scoreDisplay. */
export function scoreDisplay(score?: number | null): string {
  if (score == null) return '—';
  return `${score}%`;
}

/** "RELEASING" / "FINISHED" / "Not yet aired" from AniList's enum. */
export function statusLabel(status?: string | null): string | null {
  switch (status) {
    case 'RELEASING':
      return 'Airing';
    case 'FINISHED':
      return 'Finished';
    case 'NOT_YET_RELEASED':
      return 'Upcoming';
    case 'CANCELLED':
      return 'Cancelled';
    case 'HIATUS':
      return 'Hiatus';
    default:
      return null;
  }
}

/** "TV" / "Movie" / "OVA" — AniList's short format enum. */
export function formatLabel(format?: string | null): string | null {
  if (!format) return null;
  return format
    .replace('TV_SHORT', 'TV Short')
    .replace('_', ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** AniList relation types, as short display labels. */
export function relationLabel(type: string): string {
  switch (type) {
    case 'PREQUEL':
      return 'Prequel';
    case 'SEQUEL':
      return 'Sequel';
    case 'PARENT':
      return 'Parent';
    case 'SIDE_STORY':
      return 'Side story';
    case 'SUMMARY':
      return 'Summary';
    case 'ALTERNATIVE':
      return 'Alternative';
    case 'SPIN_OFF':
      return 'Spin-off';
    case 'CHARACTER':
      return 'Character';
    case 'OTHER':
      return 'Other';
    case 'SOURCE':
      return 'Source';
    case 'ADAPTATION':
      return 'Adaptation';
    default:
      return type
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}
