/**
 * @file deezer.ts
 * @description Keyless client for the public Deezer REST API (https://api.deezer.com).
 * Provides track discovery, artist deep-cut exploration, chart scraping, and artwork normalization.
 */

export interface DeezerTrackMetadata {
  /** Canonical VEXO ID: e.g. "dz_3135556" */
  id: string;
  /** Raw numeric Deezer Track ID */
  deezerId: string;
  /** Song title */
  title: string;
  /** Primary artist name */
  artist: string;
  /** Deezer numeric Artist ID */
  artistId?: string;
  /** Album title */
  album?: string;
  /** Track duration in seconds */
  durationSec: number;
  /** High-resolution 1400x1400 artwork URL */
  artworkUrl: string;
  /** Low-overhead 250x250 thumbnail artwork URL */
  artworkThumbUrl: string;
  /** Primary genre string if known */
  genre?: string;
  /** Release year if known */
  releaseYear?: number;
  /** Direct 30-second Deezer preview MP3 stream URL */
  previewUrl?: string;
  /** Popularity rank (0-1,000,000) */
  rank?: number;
  /** International Standard Recording Code (e.g. "FRZ041800369") */
  isrc?: string;
}

export interface DeezerArtistMetadata {
  id: string;
  name: string;
  picture: string;
  pictureThumb: string;
  nbAlbums?: number;
}

export interface DeezerAlbumMetadata {
  id: string;
  title: string;
  cover: string;
  coverThumb: string;
  releaseDate?: string;
  recordType?: string;
}

const DEEZER_BASE = 'https://api.deezer.com';

/**
 * Normalizes a raw Deezer image URL to high-resolution (1400x1400) and thumbnail (250x250).
 */
export function normalizeDeezerArtwork(rawUrl?: string): { artworkUrl: string; artworkThumbUrl: string } {
  if (!rawUrl) {
    const fallback = 'https://e-cdn-images.dzcdn.net/images/cover/d41d8cd98f00b204e9800998ecf8427e/1400x1400-000000-80-0-0.jpg';
    return { artworkUrl: fallback, artworkThumbUrl: fallback };
  }
  // Replace size pattern like /250x250-000000-80-0-0.jpg or /500x500... with 1400x1400
  const artworkUrl = rawUrl.replace(/\/\d+x\d+-[^.]+\.jpg$/i, '/1400x1400-000000-80-0-0.jpg');
  const artworkThumbUrl = rawUrl.replace(/\/\d+x\d+-[^.]+\.jpg$/i, '/250x250-000000-80-0-0.jpg');
  return { artworkUrl, artworkThumbUrl };
}

/**
 * Sanitizes an ID string or number by stripping prefixes (such as "dz_").
 */
function cleanDeezerId(id: string | number): string {
  return String(id).replace(/^dz_/, '').trim();
}

/**
 * Normalizes a raw Deezer API track JSON object into DeezerTrackMetadata.
 */
function normalizeTrack(item: any): DeezerTrackMetadata {
  const rawCover = item.album?.cover_xl || item.album?.cover_medium || item.album?.cover || item.artist?.picture_xl || '';
  const { artworkUrl, artworkThumbUrl } = normalizeDeezerArtwork(rawCover);
  const releaseYear = item.release_date ? parseInt(item.release_date.split('-')[0], 10) : undefined;

  return {
    id: `dz_${item.id}`,
    deezerId: String(item.id),
    title: item.title,
    artist: item.artist?.name || 'Unknown Artist',
    artistId: item.artist?.id ? String(item.artist.id) : undefined,
    album: item.album?.title,
    durationSec: Number(item.duration) || 0,
    artworkUrl,
    artworkThumbUrl,
    releaseYear: Number.isNaN(releaseYear) ? undefined : releaseYear,
    previewUrl: item.preview || undefined,
    rank: item.rank,
    isrc: item.isrc || undefined,
  };
}

/**
 * Executes a resilient fetch against Deezer API with a 6-second timeout.
 */
async function deezerGet<T = any>(endpoint: string): Promise<T | null> {
  const url = `${DEEZER_BASE}${endpoint}`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as any;
    if (data.error) {
      console.warn(`[Deezer] API warning on ${endpoint}:`, data.error);
      return null;
    }
    return data as T;
  } catch (err) {
    console.warn(`[Deezer] Network error fetching ${url}:`, (err as Error).message);
    return null;
  }
}

/**
 * Search Deezer catalog for an artist by name.
 */
export async function searchArtist(query: string): Promise<DeezerArtistMetadata | null> {
  const data = await deezerGet<{ data: any[] }>(`/search/artist?q=${encodeURIComponent(query)}&limit=5`);
  if (!data?.data || data.data.length === 0) return null;

  // Sort candidates by fan count so verified international artists take priority
  const sorted = [...data.data].sort((a: any, b: any) => (b.nb_fan || 0) - (a.nb_fan || 0));
  const exact = sorted.find((a: any) => a.name.toLowerCase() === query.toLowerCase().trim());
  const artist = exact || sorted[0];

  const rawPic = artist.picture_xl || artist.picture_big || artist.picture_medium || artist.picture || '';
  const { artworkUrl, artworkThumbUrl } = normalizeDeezerArtwork(rawPic);

  return {
    id: String(artist.id),
    name: artist.name,
    picture: artworkUrl,
    pictureThumb: artworkThumbUrl,
    nbAlbums: artist.nb_album,
  };
}

/**
 * Search Deezer catalog by freeform query with optional pagination offset.
 */
export async function searchTracks(query: string, limit = 10, index = 0): Promise<DeezerTrackMetadata[]> {
  const indexParam = index > 0 ? `&index=${index}` : '';
  const data = await deezerGet<{ data: any[] }>(`/search?q=${encodeURIComponent(query)}&limit=${limit}${indexParam}`);
  if (!data?.data) return [];
  return data.data.map(normalizeTrack);
}

/**
 * Search Deezer catalog with a randomized pagination offset to explore deep cuts.
 */
export async function searchTracksRandomized(
  query: string,
  limit = 25,
  maxOffset = 150
): Promise<DeezerTrackMetadata[]> {
  const offset = Math.floor(Math.random() * maxOffset);
  return searchTracks(query, limit, offset);
}

/**
 * Retrieve detailed metadata for a single Deezer track by numeric ID.
 */
export async function getTrack(trackId: string | number): Promise<DeezerTrackMetadata | null> {
  const cleanId = cleanDeezerId(trackId);
  const data = await deezerGet<any>(`/track/${cleanId}`);
  if (!data || data.error) return null;
  return normalizeTrack(data);
}

/**
 * Retrieve all tracks from an album by album ID.
 */
export async function getAlbumTracks(albumId: string | number): Promise<DeezerTrackMetadata[]> {
  const cleanId = cleanDeezerId(albumId);
  const albumData = await deezerGet<any>(`/album/${cleanId}`);
  if (!albumData?.tracks?.data) return [];
  return albumData.tracks.data.map((item: any) => ({
    ...normalizeTrack(item),
    album: albumData.title,
    artworkUrl: normalizeDeezerArtwork(albumData.cover_xl || albumData.cover_medium).artworkUrl,
    artworkThumbUrl: normalizeDeezerArtwork(albumData.cover_xl || albumData.cover_medium).artworkThumbUrl,
  }));
}

/**
 * Search Deezer public playlists by title or theme.
 */
export async function searchPlaylists(query: string, limit = 10): Promise<Array<{ id: string; title: string; nbTracks: number; picture: string }>> {
  const data = await deezerGet<{ data: any[] }>(`/search/playlist?q=${encodeURIComponent(query)}&limit=${limit}`);
  if (!data?.data) return [];
  return data.data.map((pl: any) => ({
    id: String(pl.id),
    title: pl.title,
    nbTracks: Number(pl.nb_tracks) || 0,
    picture: pl.picture_medium || pl.picture || '',
  }));
}

/**
 * Retrieve tracks from a public Deezer playlist.
 */
export async function getPlaylistTracks(playlistId: string | number, limit = 50): Promise<DeezerTrackMetadata[]> {
  const cleanId = cleanDeezerId(playlistId);
  const data = await deezerGet<{ data: any[] }>(`/playlist/${cleanId}/tracks?limit=${limit}`);
  if (!data?.data) return [];
  return data.data.map(normalizeTrack);
}

/**
 * Retrieve an artist's top tracks for deep-cut discovery (up to 50 tracks).
 */
export async function getArtistTopTracks(artistId: string | number, limit = 50): Promise<DeezerTrackMetadata[]> {
  const cleanId = cleanDeezerId(artistId);
  const data = await deezerGet<{ data: any[] }>(`/artist/${cleanId}/top?limit=${limit}`);
  if (!data?.data) return [];
  return data.data.map(normalizeTrack);
}

/**
 * Retrieve an artist's albums for discography browsing.
 */
export async function getArtistAlbums(artistId: string | number, limit = 20): Promise<DeezerAlbumMetadata[]> {
  const cleanId = cleanDeezerId(artistId);
  const data = await deezerGet<{ data: any[] }>(`/artist/${cleanId}/albums?limit=${limit}`);
  if (!data?.data) return [];
  return data.data.map((alb: any) => {
    const rawCover = alb.cover_xl || alb.cover_big || alb.cover_medium || alb.cover || '';
    const { artworkUrl, artworkThumbUrl } = normalizeDeezerArtwork(rawCover);
    return {
      id: String(alb.id),
      title: alb.title,
      cover: artworkUrl,
      coverThumb: artworkThumbUrl,
      releaseDate: alb.release_date || undefined,
      recordType: alb.record_type || undefined,
    };
  });
}

/**
 * Retrieve related artists for dynamic taste walks.
 */
export async function getRelatedArtists(artistId: string | number, limit = 20): Promise<Array<{ id: string; name: string; nbFan?: number }>> {
  const cleanId = cleanDeezerId(artistId);
  const data = await deezerGet<{ data: any[] }>(`/artist/${cleanId}/related?limit=${limit}`);
  if (!data?.data) return [];
  return data.data.map((a: any) => ({
    id: String(a.id),
    name: a.name,
    nbFan: typeof a.nb_fan === 'number' ? a.nb_fan : undefined,
  }));
}

/**
 * Fetch top chart tracks, optionally filtered by Deezer genre ID.
 * Genre IDs: 0 = All, 132 = Pop, 152 = Rock, 116 = Rap/Hip-Hop, 106 = Electro, 165 = R&B, 85 = Alternative, 129 = Jazz.
 */
export async function getRandomChartTracks(genreId = 0, limit = 50): Promise<DeezerTrackMetadata[]> {
  const data = await deezerGet<{ data?: any[]; tracks?: { data: any[] } }>(`/chart/${genreId}/tracks?limit=${limit}`);
  const items = data?.tracks?.data || data?.data;
  if (!items) return [];
  return items.map(normalizeTrack);
}

/**
 * Advanced search by year range or decade roulette for the 30% dynamic fallback.
 */
export async function searchByYearRange(yearStart: number, yearEnd: number, genre?: string, limit = 30): Promise<DeezerTrackMetadata[]> {
  const query = genre ? `${genre} ${yearStart}` : `${yearStart} classics`;
  const data = await deezerGet<{ data: any[] }>(`/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  if (!data?.data) return [];
  return data.data.map(normalizeTrack);
}

export default {
  searchArtist,
  searchTracks,
  searchTracksRandomized,
  getTrack,
  getAlbumTracks,
  searchPlaylists,
  getPlaylistTracks,
  getArtistTopTracks,
  getArtistAlbums,
  getRelatedArtists,
  getRandomChartTracks,
  searchByYearRange,
  normalizeDeezerArtwork,
};
