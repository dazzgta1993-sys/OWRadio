/**
 * @file services/musicbrainz.ts
 * @description Authoritative MusicBrainz API service (https://musicbrainz.org/ws/2).
 * Sole authority for canonical studio album vs single/EP/live/compilation taxonomy,
 * barcode (UPC) lookup, and track ISRC verification.
 */

import { getApiCache, setApiCache } from '../db/store.js';
import { getArtistGenres } from './itunes.js';

const MB_BASE = 'https://musicbrainz.org/ws/2';
const CAA_BASE = 'https://coverartarchive.org/release-group';
const MB_UA = 'OWRadioStudio/3.0 (https://github.com/owradio)';

let lastMbRequestTime = 0;

async function rateLimitedMbFetch(url: string): Promise<any | null> {
  const cached = getApiCache(url);
  if (cached) return cached;

  const now = Date.now();
  const elapsed = now - lastMbRequestTime;
  if (elapsed < 1100) {
    await new Promise((r) => setTimeout(r, 1100 - elapsed));
  }
  lastMbRequestTime = Date.now();

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': MB_UA,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data) {
      setApiCache(url, data, 86400 * 14, 'musicbrainz');
      return data;
    }
  } catch {}
  return null;
}

/**
 * Strict Studio Album Gate & Release Group Classifier.
 * A release is only classified as 'Studio Albums' if primaryType == 'Album'
 * and it has ZERO secondary types (Compilation, Live, Remix, Soundtrack, Demo, Mixtape, DJ-mix).
 */
export function classifyReleaseGroup(
  primaryType: string,
  secondaryTypes: string[] = [],
  title = '',
  isCollab = false
): string {
  const p = (primaryType || '').trim().toLowerCase();
  const sSet = new Set((secondaryTypes || []).map((s) => s.toLowerCase()));
  const tLow = (title || '').toLowerCase();

  if (sSet.has('live') || /\b(live at|live in|live from|unplugged)\b/i.test(tLow)) {
    return 'Live Albums';
  }
  if (sSet.has('remix') || /\b(remixes|remixed)\b/i.test(tLow)) {
    return 'Remixes';
  }
  if (sSet.has('soundtrack') || /\b(soundtrack|ost|original score|motion picture)\b/i.test(tLow)) {
    return 'Soundtracks';
  }
  if (
    sSet.has('compilation') ||
    /\b(greatest hits|best of|anthology|essential|definitive collection|singles collection)\b/i.test(tLow)
  ) {
    return 'Compilations';
  }
  if (sSet.has('demo') || sSet.has('mixtape/street') || sSet.has('dj-mix') || sSet.has('bootleg')) {
    return 'Other';
  }
  if (p === 'ep') return 'EPs';
  if (p === 'single') return 'Singles';
  if (p === 'album' && sSet.size === 0) {
    return isCollab ? 'Collaborative / Duets' : 'Studio Albums';
  }
  return 'Other';
}

/**
 * Resolves a physical commercial barcode (UPC) on MusicBrainz to its canonical category & release year.
 */
export async function lookupReleaseByBarcode(upc: string): Promise<{
  mbid: string;
  title: string;
  primaryType: string;
  secondaryTypes: string[];
  category: string;
  year: string;
} | null> {
  const cleanUpc = (upc || '').replace(/[^\d]/g, '');
  if (cleanUpc.length < 6) return null;

  const cacheKey = `mb_barcode:${cleanUpc}`;
  const cached = getApiCache<any>(cacheKey);
  if (cached) return cached;

  const url = `${MB_BASE}/release?query=barcode:${cleanUpc}&fmt=json&limit=5`;
  const data = await rateLimitedMbFetch(url);
  const rel = data?.releases?.[0];
  if (!rel) return null;

  const rg = rel['release-group'] || {};
  const pType = String(rg['primary-type'] || 'Album');
  const sTypes: string[] = Array.isArray(rg['secondary-types']) ? rg['secondary-types'] : [];
  const title = String(rel.title || rg.title || '');
  const year = String(rel.date || '').slice(0, 4);
  const result = {
    mbid: String(rg.id || rel.id || ''),
    title,
    primaryType: pType,
    secondaryTypes: sTypes,
    category: classifyReleaseGroup(pType, sTypes, title),
    year,
  };
  setApiCache(cacheKey, result, 86400 * 30, 'mb_barcode');
  return result;
}

/**
 * Resolves a track ISRC code on MusicBrainz to verify official studio recording metadata.
 */
export async function lookupReleaseByIsrc(isrc: string): Promise<{
  recordingId: string;
  title: string;
  artist: string;
  durationSeconds: number;
  year: string;
} | null> {
  const cleanIsrc = (isrc || '').trim().toUpperCase();
  if (cleanIsrc.length < 10) return null;

  const cacheKey = `mb_isrc:${cleanIsrc}`;
  const cached = getApiCache<any>(cacheKey);
  if (cached) return cached;

  const url = `${MB_BASE}/recording?query=isrc:${encodeURIComponent(cleanIsrc)}&fmt=json&limit=3`;
  const data = await rateLimitedMbFetch(url);
  const rec = data?.recordings?.[0];
  if (!rec) return null;

  const durSecs = rec.length ? Math.round(Number(rec.length) / 1000) : 0;
  const artist = rec?.['artist-credit']?.[0]?.name || 'Unknown Artist';
  const year = String(rec['first-release-date'] || '').slice(0, 4);
  const result = {
    recordingId: String(rec.id || ''),
    title: String(rec.title || ''),
    artist,
    durationSeconds: durSecs,
    year,
  };
  setApiCache(cacheKey, result, 86400 * 30, 'mb_isrc');
  return result;
}

/**
 * Fetches an artist's canonical categorized discography from MusicBrainz.
 * Uses dynamic year validation (currentYear + 1) and live Apple/Deezer genre lookup.
 */
export async function getArtistCategorizedDiscography(artistName: string, limit = 40): Promise<any[]> {
  const cleanArtist = (artistName || '').trim();
  if (!cleanArtist) return [];

  const cacheKey = `mb_disco_v2:${cleanArtist.toLowerCase()}`;
  const cached = getApiCache<any[]>(cacheKey);
  if (cached) return cached.slice(0, limit);

  const artistUrl = `${MB_BASE}/artist?query=${encodeURIComponent(`artist:"${cleanArtist}"`)}&fmt=json&limit=3`;
  const artistData = await rateLimitedMbFetch(artistUrl);
  const topArtist = artistData?.artists?.[0];
  if (!topArtist?.id) return [];

  const mbid = String(topArtist.id);
  const canonicalName = String(topArtist.name || cleanArtist);
  const genres = await getArtistGenres(canonicalName);
  const primaryGenre = genres[0] || 'Music';

  const rgUrl = `${MB_BASE}/release-group?artist=${mbid}&type=album|ep&limit=100&inc=artist-credits&fmt=json`;
  const rgData = await rateLimitedMbFetch(rgUrl);
  const rgs = rgData?.['release-groups'] || [];

  const maxValidYear = String(new Date().getFullYear() + 1);
  const albums: any[] = [];
  const seen = new Set<string>();

  for (const rg of rgs) {
    const rgId = String(rg?.id || '');
    const title = String(rg?.title || '').trim();
    if (!rgId || !title) continue;

    const pType = String(rg['primary-type'] || '');
    const sTypes: string[] = Array.isArray(rg['secondary-types']) ? rg['secondary-types'] : [];
    const key = `${title.toLowerCase()}:::${pType.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const credits = Array.isArray(rg['artist-credit']) ? rg['artist-credit'] : [];
    const isCollab = credits.length > 1;
    const relDate = String(rg['first-release-date'] || '');
    const year = relDate.slice(0, 4);
    let category = classifyReleaseGroup(pType, sTypes, title, isCollab);
    if (category === 'Studio Albums' && year && year > maxValidYear) {
      category = 'Other';
    }

    albums.push({
      id: `mb_${rgId}`,
      mbid: rgId,
      title,
      artist: canonicalName,
      genre: primaryGenre,
      cover: `${CAA_BASE}/${rgId}/front-500`,
      year,
      releaseDate: relDate,
      category,
      primaryType: pType,
      source: 'musicbrainz',
    });
  }

  albums.sort((a, b) => {
    const aStudio = a.category === 'Studio Albums' ? 0 : 1;
    const bStudio = b.category === 'Studio Albums' ? 0 : 1;
    if (aStudio !== bStudio) return aStudio - bStudio;
    return String(b.releaseDate || '').localeCompare(String(a.releaseDate || ''));
  });
  if (albums.length > 0) {
    setApiCache(cacheKey, albums, 86400 * 14, 'musicbrainz');
  }
  return albums.slice(0, limit);
}

export async function getMusicBrainzReleaseGroupTracks(mbid: string, artistName = ''): Promise<any[]> {
  if (!mbid) return [];
  const url = `${MB_BASE}/release?release-group=${encodeURIComponent(mbid)}&inc=recordings&fmt=json&limit=3`;
  const data = await rateLimitedMbFetch(url);
  const releases = data?.releases || [];
  let bestMedia: any = null;
  for (const r of releases) {
    const m = r?.media?.[0];
    if (m?.tracks?.length > (bestMedia?.tracks?.length || 0)) bestMedia = m;
  }
  if (!bestMedia?.tracks) return [];
  return bestMedia.tracks.map((t: any, i: number) => ({
    trackNumber: t.position || i + 1,
    title: String(t.title || t.recording?.title || '').trim(),
    artist: artistName || 'Unknown Artist',
    duration: t.length ? Math.round(Number(t.length) / 1000) : 0,
    source: 'musicbrainz',
  })).filter((t: any) => t.title);
}
