/**
 * @file musicbrainz.ts
 * @description Official MusicBrainz REST API client (https://musicbrainz.org/ws/2).
 * Provides authoritative artist discographies, release dates, official recording verification,
 * and crowd-sourced genre taxonomy with built-in in-memory caching.
 */

export interface MusicBrainzRecording {
  id: string;
  title: string;
  artist: string;
  releaseYear?: number;
  genres: string[];
}

const MB_BASE = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'OWRadio/2.1.0 (https://github.com/dazzgta1993-sys/OWRadio)';
const cache = new Map<string, { data: any; expiresAt: number }>();

function getCached<T>(key: string): T | null {
  const item = cache.get(key);
  if (item && item.expiresAt > Date.now()) {
    return item.data as T;
  }
  return null;
}

function setCached(key: string, data: any, ttlSec = 3600): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlSec * 1000 });
}

/**
 * Searches MusicBrainz for official studio recordings matching a query.
 */
export async function searchRecordings(query: string, limit = 5): Promise<MusicBrainzRecording[]> {
  const cacheKey = `mb_rec_${query}_${limit}`;
  const cached = getCached<MusicBrainzRecording[]>(cacheKey);
  if (cached) return cached;

  const url = `${MB_BASE}/recording?query=${encodeURIComponent(query)}%20AND%20status:official&fmt=json&limit=${limit}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as any;
    const recordings: MusicBrainzRecording[] = [];

    if (Array.isArray(data.recordings)) {
      for (const r of data.recordings) {
        if (!r.title) continue;
        const artist = r['artist-credit']?.[0]?.artist?.name || r['artist-credit']?.[0]?.name || 'Unknown Artist';
        const dateStr = r.releases?.[0]?.date || r['first-release-date'] || '';
        const releaseYear = dateStr ? parseInt(dateStr.split('-')[0], 10) : undefined;
        const genres = Array.isArray(r.tags) ? r.tags.map((t: any) => t.name.toLowerCase()) : [];

        recordings.push({
          id: r.id,
          title: r.title,
          artist,
          releaseYear: Number.isNaN(releaseYear) ? undefined : releaseYear,
          genres,
        });
      }
    }

    setCached(cacheKey, recordings, 3600);
    return recordings;
  } catch (err) {
    console.warn(`[MusicBrainz] Recording search error for "${query}":`, (err as Error).message);
    return [];
  }
}

/**
 * Fetches verified official recordings by an artist.
 */
export async function getArtistTopRecordings(artistName: string, limit = 10): Promise<MusicBrainzRecording[]> {
  const cacheKey = `mb_artist_${artistName}_${limit}`;
  const cached = getCached<MusicBrainzRecording[]>(cacheKey);
  if (cached) return cached;

  const query = `artist:"${artistName}" AND status:official`;
  const recordings = await searchRecordings(query, limit);
  setCached(cacheKey, recordings, 7200);
  return recordings;
}

export default {
  searchRecordings,
  getArtistTopRecordings,
};
