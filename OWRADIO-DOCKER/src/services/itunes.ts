/**
 * @file services/itunes.ts
 * @description Zero-key Apple Music / iTunes service:
 * 1. Physical UPC barcode to uncompressed 1400x1400 studio cover art bridge.
 * 2. Live artist genre taxonomy (entity=musicArtist) with zero hardcoded genre lists.
 * 3. Track search and live UK Official Top 50 / US Hot 50 RSS charts.
 */

import { getApiCache, setApiCache } from '../db/store.js';
import { getDeezerChartTracks } from './deezer.js';

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const ITUNES_LOOKUP_URL = 'https://itunes.apple.com/lookup';

export interface ItunesTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  cover: string;
  year: string;
  genre: string;
  source: 'apple';
}

export function upgradeItunesArtwork(url: string, size = 1400): string {
  if (!url) return '';
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/i, `/${size}x${size}bb.$1`);
}

/**
 * Bridges a physical album UPC barcode from Deezer/MusicBrainz to Apple Music's
 * uncompressed 1400x1400 studio cover art and release metadata.
 */
export async function lookupAlbumByUpc(upc: string): Promise<{
  itunesId: string;
  title: string;
  artist: string;
  artworkUrl: string;
  year: string;
  genre: string;
} | null> {
  const rawUpc = (upc || '').replace(/[^\d]/g, '');
  if (rawUpc.length < 6) return null;

  const cacheKey = `itunes_upc:${rawUpc}`;
  const cached = getApiCache<any>(cacheKey);
  if (cached) return cached;

  const candidates = [rawUpc];
  const stripped = rawUpc.replace(/^0+/, '');
  if (stripped && stripped !== rawUpc) candidates.push(stripped);

  for (const cand of candidates) {
    try {
      const url = `${ITUNES_LOOKUP_URL}?upc=${encodeURIComponent(cand)}&entity=album`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!resp.ok) continue;
      const data: any = await resp.json();
      const item = data?.results?.[0];
      if (item) {
        const result = {
          itunesId: String(item.collectionId || ''),
          title: String(item.collectionName || '').replace(/\s+-\s+(Single|EP)$/i, '').trim(),
          artist: String(item.artistName || ''),
          artworkUrl: upgradeItunesArtwork(String(item.artworkUrl100 || ''), 1400),
          year: String(item.releaseDate || '').slice(0, 4),
          genre: String(item.primaryGenreName || ''),
        };
        setApiCache(cacheKey, result, 86400 * 7, 'itunes_upc');
        return result;
      }
    } catch {}
  }
  return null;
}

/**
 * Dynamically fetches an artist's real primary genre from Apple Music with zero hardcoding.
 */
export async function getArtistGenres(artistName: string): Promise<string[]> {
  const clean = (artistName || '').trim();
  if (!clean) return [];

  const cacheKey = `artist_genres:${clean.toLowerCase()}`;
  const cached = getApiCache<string[]>(cacheKey);
  if (cached) return cached;

  try {
    const url = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(clean)}&entity=musicArtist&limit=3`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (resp.ok) {
      const data: any = await resp.json();
      const genres: string[] = [];
      for (const r of data?.results || []) {
        const g = String(r?.primaryGenreName || '').trim();
        if (g && g.toLowerCase() !== 'music' && !genres.includes(g)) {
          genres.push(g);
        }
      }
      if (genres.length > 0) {
        setApiCache(cacheKey, genres, 86400 * 14, 'dna_genres');
        return genres;
      }
    }
  } catch {}
  return [];
}

export async function searchItunesTracks(query: string, limit = 15): Promise<ItunesTrack[]> {
  const q = (query || '').trim();
  if (!q) return [];

  const cacheKey = `itunes_song:${q.toLowerCase()}:${limit}`;
  const cached = getApiCache<ItunesTrack[]>(cacheKey);
  if (cached) return cached;

  try {
    const url = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(q)}&entity=song&limit=${limit}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!resp.ok) return [];
    const data: any = await resp.json();
    const tracks: ItunesTrack[] = (data?.results || []).map((r: any) => ({
      id: `it_${r.trackId}`,
      title: String(r.trackName || 'Unknown'),
      artist: String(r.artistName || 'Unknown'),
      album: String(r.collectionName || ''),
      duration: Math.round(Number(r.trackTimeMillis || 0) / 1000),
      cover: upgradeItunesArtwork(String(r.artworkUrl100 || ''), 1000),
      year: String(r.releaseDate || '').slice(0, 4),
      genre: String(r.primaryGenreName || ''),
      source: 'apple' as const,
    }));
    if (tracks.length > 0) {
      setApiCache(cacheKey, tracks, 3600, 'itunes_tracks');
    }
    return tracks;
  } catch {
    return [];
  }
}

/**
 * Fetches live UK Official Top 50 or US Hot 50 charts from Apple RSS feeds,
 * with automatic fallback to Deezer Global Charts.
 */
export async function getOfficialCharts(country: 'gb' | 'us' = 'gb', limit = 40): Promise<ItunesTrack[]> {
  const cacheKey = `official_charts:${country}:${limit}`;
  const cached = getApiCache<ItunesTrack[]>(cacheKey);
  if (cached && cached.length > 0) return cached;

  try {
    const rssUrl = `https://itunes.apple.com/${country}/rss/topsongs/limit=${Math.min(limit, 50)}/json`;
    const resp = await fetch(rssUrl, { signal: AbortSignal.timeout(7000) });
    if (resp.ok) {
      const data: any = await resp.json();
      const entries = data?.feed?.entry || [];
      const tracks: ItunesTrack[] = [];
      for (const e of entries) {
        const title = String(e?.['im:name']?.label || '').trim();
        const artist = String(e?.['im:artist']?.label || '').trim();
        const album = String(e?.['im:collection']?.['im:name']?.label || title).trim();
        const images = Array.isArray(e?.['im:image']) ? e['im:image'] : [];
        const rawImg = images.length > 0 ? String(images[images.length - 1]?.label || '') : '';
        const cover = upgradeItunesArtwork(rawImg, 1000);
        const relDate = String(e?.['im:releaseDate']?.label || '').slice(0, 4);
        const genre = String(e?.category?.attributes?.label || '');
        const id = String(e?.id?.attributes?.['im:id'] || `${artist}-${title}`);
        if (title && artist) {
          tracks.push({
            id: `chart_${id}`,
            title,
            artist,
            album,
            duration: 0,
            cover,
            year: relDate,
            genre,
            source: 'apple',
          });
        }
      }
      if (tracks.length > 0) {
        setApiCache(cacheKey, tracks, 1800, 'charts');
        return tracks.slice(0, limit);
      }
    }
  } catch {}

  const dzFallback = await getDeezerChartTracks(limit);
  return dzFallback.map((t) => ({
    id: `dz_${t.id}`,
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    cover: t.cover,
    year: '',
    genre: '',
    source: 'apple' as const,
  }));
}
