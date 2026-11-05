/**
 * @file services/deezer.ts
 * @description Live Deezer Open Catalog API service.
 * Provides artist/track search, multi-artist collaboration resolution (preventing 0-fan stub traps),
 * Artist Radio (/artist/{id}/radio), Related Artists (/artist/{id}/related), UPC & ISRC extraction,
 * and complete album tracklists.
 */

import { getApiCache, setApiCache } from '../db/store.js';
import { splitCollabArtists, normalizeNameForMatch } from '../utils/artistNormalizer.js';
import { isJunkAlbumTitle } from './streamFilters.js';

const DEEZER_BASE = 'https://api.deezer.com';

export interface DeezerTrack {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  album: string;
  albumId: string;
  duration: number;
  cover: string;
  explicit: boolean;
  rank: number;
  isrc?: string;
}

export interface DeezerArtist {
  id: string;
  name: string;
  picture: string;
  fans: number;
  albumsCount: number;
}

async function fetchDeezerJson(url: string, ttlSeconds = 1800): Promise<any | null> {
  const cached = getApiCache(url);
  if (cached) return cached;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'OWRadio/3.0 (https://github.com/owradio)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    if (data && !data.error) {
      setApiCache(url, data, ttlSeconds, 'deezer');
      return data;
    }
  } catch {}
  return null;
}

function mapTrackItem(item: any, fallbackArtist = '', fallbackAlbum = '', fallbackCover = ''): DeezerTrack | null {
  const tid = String(item?.id || '').trim();
  const title = String(item?.title || item?.title_short || '').trim();
  if (!tid || !title) return null;

  const artObj = item?.artist || {};
  const albObj = item?.album || {};
  const artist = String(artObj?.name || fallbackArtist || 'Unknown Artist').trim();
  if (isJunkAlbumTitle(title, artist)) return null;

  const cover =
    albObj?.cover_xl ||
    albObj?.cover_big ||
    albObj?.cover_medium ||
    albObj?.cover ||
    fallbackCover ||
    '';

  return {
    id: tid,
    title,
    artist,
    artistId: String(artObj?.id || ''),
    album: String(albObj?.title || fallbackAlbum || '').trim(),
    albumId: String(albObj?.id || ''),
    duration: Number(item?.duration || 0),
    cover,
    explicit: Boolean(item?.explicit_lyrics),
    rank: Number(item?.rank || 0),
    isrc: item?.isrc ? String(item.isrc).trim().toUpperCase() : undefined,
  };
}

export async function searchDeezerTracks(query: string, limit = 15): Promise<DeezerTrack[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const url = `${DEEZER_BASE}/search/track?q=${encodeURIComponent(q)}&limit=${Math.max(limit * 2, 25)}`;
  const data = await fetchDeezerJson(url, 900);
  if (!data?.data) return [];

  const tracks: DeezerTrack[] = [];
  for (const item of data.data) {
    const mapped = mapTrackItem(item);
    if (mapped) tracks.push(mapped);
    if (tracks.length >= limit) break;
  }
  return tracks;
}

export async function searchDeezerArtists(query: string, limit = 8): Promise<DeezerArtist[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const url = `${DEEZER_BASE}/search/artist?q=${encodeURIComponent(q)}&limit=${Math.max(limit * 3, 20)}`;
  const data = await fetchDeezerJson(url, 1800);
  if (!data?.data) return [];

  const qNorm = normalizeNameForMatch(q);
  const artists: DeezerArtist[] = [];
  for (const a of data.data) {
    const id = String(a?.id || '');
    const name = String(a?.name || '').trim();
    if (!id || !name || isJunkAlbumTitle(name)) continue;
    artists.push({
      id,
      name,
      picture: a?.picture_xl || a?.picture_big || a?.picture_medium || a?.picture || '',
      fans: Number(a?.nb_fan || 0),
      albumsCount: Number(a?.nb_album || 0),
    });
  }

  artists.sort((a, b) => {
    const aExact = normalizeNameForMatch(a.name) === qNorm ? 1 : 0;
    const bExact = normalizeNameForMatch(b.name) === qNorm ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    return b.fans - a.fans;
  });

  return artists.slice(0, limit);
}

/**
 * Resolves a real Deezer Artist profile from potentially composite artist strings
 * ("Calvin Harris, Ellie Goulding", "Daft Punk feat. Pharrell").
 * Guarantees we never select a 0-fan composite stub profile!
 */
export async function resolvePrimaryDeezerArtist(artistQuery: string): Promise<DeezerArtist | null> {
  const parts = splitCollabArtists(artistQuery);
  const candidatesToTry = parts.length > 1 ? [...parts, artistQuery.trim()] : [artistQuery.trim()];

  for (const cand of candidatesToTry) {
    if (!cand) continue;
    const found = await searchDeezerArtists(cand, 5);
    const verified = found.find((a) => a.fans >= 500);
    if (verified) return verified;
    if (found.length > 0 && parts.length === 1) return found[0];
  }
  return null;
}

export async function getDeezerArtistRadio(artistId: string, limit = 30): Promise<DeezerTrack[]> {
  const aid = (artistId || '').trim();
  if (!/^\d+$/.test(aid)) return [];
  const data = await fetchDeezerJson(`${DEEZER_BASE}/artist/${aid}/radio`, 1800);
  if (!data?.data) return [];

  const tracks: DeezerTrack[] = [];
  for (const item of data.data) {
    const mapped = mapTrackItem(item);
    if (mapped) tracks.push(mapped);
    if (tracks.length >= limit) break;
  }
  return tracks;
}

export async function getDeezerRelatedArtists(artistId: string, limit = 15): Promise<DeezerArtist[]> {
  const aid = (artistId || '').trim();
  if (!/^\d+$/.test(aid)) return [];
  const data = await fetchDeezerJson(`${DEEZER_BASE}/artist/${aid}/related?limit=${limit}`, 3600);
  if (!data?.data) return [];

  return data.data
    .map((a: any) => ({
      id: String(a?.id || ''),
      name: String(a?.name || '').trim(),
      picture: a?.picture_xl || a?.picture_big || a?.picture_medium || '',
      fans: Number(a?.nb_fan || 0),
      albumsCount: Number(a?.nb_album || 0),
    }))
    .filter((a: DeezerArtist) => a.id && a.name);
}

export async function getDeezerArtistTopTracks(artistId: string, limit = 15): Promise<DeezerTrack[]> {
  const aid = (artistId || '').trim();
  if (!/^\d+$/.test(aid)) return [];
  const data = await fetchDeezerJson(`${DEEZER_BASE}/artist/${aid}/top?limit=${limit}`, 3600);
  if (!data?.data) return [];

  const tracks: DeezerTrack[] = [];
  for (const item of data.data) {
    const mapped = mapTrackItem(item);
    if (mapped) tracks.push(mapped);
  }
  return tracks.slice(0, limit);
}

export async function getDeezerTrackIsrc(trackId: string): Promise<string> {
  const tid = (trackId || '').trim();
  if (!/^\d+$/.test(tid)) return '';
  const data = await fetchDeezerJson(`${DEEZER_BASE}/track/${tid}`, 86400 * 7);
  return data?.isrc ? String(data.isrc).trim().toUpperCase() : '';
}

export async function getDeezerAlbumDetails(albumId: string): Promise<any | null> {
  const aid = (albumId || '').trim();
  if (!/^\d+$/.test(aid)) return null;
  const data = await fetchDeezerJson(`${DEEZER_BASE}/album/${aid}`, 3600);
  if (!data?.id) return null;

  const artistName = data?.artist?.name || 'Unknown Artist';
  const cover = data?.cover_xl || data?.cover_big || data?.cover_medium || '';
  const rawTracks = data?.tracks?.data || [];
  const tracks: DeezerTrack[] = [];
  for (const t of rawTracks) {
    const mapped = mapTrackItem(t, artistName, data.title, cover);
    if (mapped) tracks.push(mapped);
  }

  return {
    id: String(data.id),
    title: String(data.title || ''),
    artist: artistName,
    artistId: String(data?.artist?.id || ''),
    cover,
    releaseDate: String(data.release_date || ''),
    year: String(data.release_date || '').slice(0, 4),
    upc: String(data.upc || ''),
    recordType: String(data.record_type || 'album'),
    tracks,
  };
}

export async function getDeezerChartTracks(limit = 30): Promise<DeezerTrack[]> {
  const data = await fetchDeezerJson(`${DEEZER_BASE}/chart/0/tracks?limit=${limit}`, 1800);
  if (!data?.data) return [];
  const tracks: DeezerTrack[] = [];
  for (const item of data.data) {
    const mapped = mapTrackItem(item);
    if (mapped) tracks.push(mapped);
  }
  return tracks.slice(0, limit);
}

export async function searchDeezerAlbums(query: string, limit = 15): Promise<{ id: string; title: string; artist: string; cover: string }[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const data = await fetchDeezerJson(`${DEEZER_BASE}/search/album?q=${encodeURIComponent(q)}&limit=${limit}`, 3600);
  if (!data?.data) return [];
  return data.data.map((a: any) => ({
    id: String(a.id || ''),
    title: String(a.title || '').trim(),
    artist: String(a?.artist?.name || ''),
    cover: a.cover_xl || a.cover_big || a.cover_medium || '',
  })).filter((a: any) => a.id && a.title);
}
