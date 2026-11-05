/**
 * @file services/searchService.ts
 * @description Unified 100% real search & URL resolution router.
 * Supports source-specific or Multi-Engine Auto search across:
 * - YouTube Music (WEB_REMIX ATV/Topic studio masters)
 * - Deezer Studio Catalog (exact durations, ISRC, XL covers)
 * - Apple Music / iTunes (1000x1000 covers & release years)
 * - YouTube Basic (yt-dlp for live concerts, remixes & direct video links)
 * - Spotify & Deezer Album URLs
 */

import AudioTrack from '../player/AudioTrack.js';
import { matchSpotifyUrl, resolveSpotifyUrl } from './spotify.js';
import { searchYtMusicSongs } from './ytmusic.js';
import {
  searchDeezerTracks,
  searchDeezerAlbums,
  getDeezerAlbumDetails,
  resolvePrimaryDeezerArtist,
} from './deezer.js';
import { searchItunesTracks } from './itunes.js';
import { searchYouTubeBasic } from './youtube.js';
import { getArtistCategorizedDiscography, getMusicBrainzReleaseGroupTracks } from './musicbrainz.js';
import { isUnwantedVariant, isSkitOrIntro } from './streamFilters.js';
import { normalizeTrackKey } from '../utils/artistNormalizer.js';

const YOUTUBE_URL_REGEX =
  /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|playlist\?list=)|youtu\.be\/)([a-zA-Z0-9_-]+)/i;

export async function resolveQueryToTracks(
  query: string,
  requestedBy = 'Listener',
  source = 'auto'
): Promise<{ tracks: AudioTrack[]; collectionName?: string }> {
  const q = (query || '').trim();
  if (!q) return { tracks: [] };

  if (matchSpotifyUrl(q)) {
    const sp = await resolveSpotifyUrl(q);
    if (sp && sp.tracks.length > 0) {
      const tracks = sp.tracks.map(
        (t) =>
          new AudioTrack({
            title: t.title, artist: t.artist, album: t.album,
            duration: t.durationSeconds, artworkUrl: t.cover || sp.cover,
            source: 'spotify', requestedBy,
          })
      );
      return {
        tracks,
        collectionName: sp.type !== 'track' ? `${sp.name} (${tracks.length} tracks)` : undefined,
      };
    }
  }

  if (YOUTUBE_URL_REGEX.test(q)) {
    const basicHits = await searchYouTubeBasic(q, 50);
    if (basicHits.length > 0) {
      const tracks = basicHits.map(
        (h) =>
          new AudioTrack({
            videoId: h.id, title: h.title, artist: h.artist,
            duration: h.duration, artworkUrl: h.cover,
            releaseYear: h.releaseYear, source: 'youtube', requestedBy,
          })
      );
      return {
        tracks,
        collectionName: tracks.length > 1 ? `YouTube Playlist (${tracks.length} tracks)` : undefined,
      };
    }
  }

  const dzAlbumMatch = /deezer\.com\/(?:\w+\/)?album\/(\d+)/i.exec(q);
  if (dzAlbumMatch) {
    const alb = await getDeezerAlbumDetails(dzAlbumMatch[1]);
    if (alb && Array.isArray(alb.tracks)) {
      const tracks = alb.tracks.map(
        (t: any) =>
          new AudioTrack({
            deezerId: t.id, title: t.title, artist: t.artist, artistId: t.artistId,
            album: alb.title, duration: t.duration, artworkUrl: t.cover || alb.cover,
            isrc: t.isrc, upc: alb.upc, releaseYear: alb.year, source: 'deezer', requestedBy,
          })
      );
      return { tracks, collectionName: `${alb.artist} - ${alb.title}` };
    }
  }

  const results = await searchStudioCatalog(q, 5, requestedBy, source);
  return { tracks: results.slice(0, 1) };
}

export async function searchStudioCatalog(
  query: string,
  limit = 15,
  requestedBy = 'Listener',
  source = 'auto'
): Promise<AudioTrack[]> {
  const q = (query || '').trim();
  if (!q) return [];

  // Source-specific: YouTube Basic (Live concerts, remixes, covers, DJ sets)
  if (source === 'youtube') {
    const basic = await searchYouTubeBasic(q, limit);
    return basic.map(
      (h) =>
        new AudioTrack({
          id: `yt_${h.id}`, videoId: h.id, title: h.title, artist: h.artist,
          duration: h.duration, artworkUrl: h.cover, releaseYear: h.releaseYear,
          source: 'youtube', requestedBy,
        })
    );
  }

  // Source-specific: Apple Music / iTunes
  if (source === 'apple') {
    const itTracks = await searchItunesTracks(q, limit);
    return itTracks.map(
      (it) =>
        new AudioTrack({
          id: it.id, title: it.title, artist: it.artist, album: it.album,
          duration: it.duration, artworkUrl: it.cover, releaseYear: it.year,
          genre: it.genre, source: 'apple', requestedBy,
        })
    );
  }

  // Source-specific: YouTube Music WEB_REMIX only
  if (source === 'ytmusic') {
    const ytm = await searchYtMusicSongs(q, true, limit);
    return ytm
      .filter((yt) => !isUnwantedVariant(yt.title, q, yt.channel))
      .map(
        (yt) =>
          new AudioTrack({
            id: `yt_${yt.id}`, videoId: yt.id, title: yt.title, artist: yt.channel,
            album: yt.album, duration: yt.durationSeconds, artworkUrl: yt.thumbnail,
            source: 'ytmusic', requestedBy,
          })
      );
  }

  // Multi-Engine Auto or Deezer Studio
  const [dzTracks, ytmTracks] = await Promise.all([
    searchDeezerTracks(q, limit),
    source === 'deezer' ? Promise.resolve([]) : searchYtMusicSongs(q, true, limit),
  ]);

  const results: AudioTrack[] = [];
  const seenKeys = new Set<string>();
  const ytmByKey = new Map<string, string>();

  for (const yt of ytmTracks) {
    if (isUnwantedVariant(yt.title, q, yt.channel)) continue;
    const k = normalizeTrackKey(yt.channel, yt.title);
    if (!ytmByKey.has(k)) ytmByKey.set(k, yt.id);
  }

  for (const dz of dzTracks) {
    if (isUnwantedVariant(dz.title, q, dz.artist)) continue;
    if (isSkitOrIntro(dz.title, dz.duration) && !q.toLowerCase().includes(dz.title.toLowerCase())) continue;
    const k = normalizeTrackKey(dz.artist, dz.title);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);

    const matchedVid = ytmByKey.get(k) || '';
    results.push(
      new AudioTrack({
        id: matchedVid ? `yt_${matchedVid}` : `dz_${dz.id}`,
        videoId: matchedVid, deezerId: dz.id, title: dz.title, artist: dz.artist,
        artistId: dz.artistId, album: dz.album, duration: dz.duration,
        artworkUrl: dz.cover, isrc: dz.isrc, explicit: dz.explicit,
        source: 'deezer', requestedBy,
      })
    );
    if (results.length >= limit) return results;
  }

  for (const yt of ytmTracks) {
    if (isUnwantedVariant(yt.title, q, yt.channel)) continue;
    const k = normalizeTrackKey(yt.channel, yt.title);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    results.push(
      new AudioTrack({
        id: `yt_${yt.id}`, videoId: yt.id, title: yt.title, artist: yt.channel,
        album: yt.album, duration: yt.durationSeconds, artworkUrl: yt.thumbnail,
        source: 'ytmusic', requestedBy,
      })
    );
    if (results.length >= limit) return results;
  }

  return results.slice(0, limit);
}

/**
 * Fetches an artist's categorized discography combining MusicBrainz canonical taxonomy + Deezer albums.
 */
export async function searchArtistDiscography(artistQuery: string) {
  const dzArtist = await resolvePrimaryDeezerArtist(artistQuery);
  const canonicalName = dzArtist?.name || artistQuery.trim();
  const [mbAlbums, dzAlbums] = await Promise.all([
    getArtistCategorizedDiscography(canonicalName, 40),
    searchDeezerAlbums(canonicalName, 25),
  ]);

  for (const alb of mbAlbums) {
    const dzMatch = dzAlbums.find(
      (d) =>
        d.title.toLowerCase() === alb.title.toLowerCase() ||
        d.title.toLowerCase().includes(alb.title.toLowerCase()) ||
        alb.title.toLowerCase().includes(d.title.toLowerCase())
    );
    if (dzMatch) {
      alb.deezerAlbumId = dzMatch.id;
      if (dzMatch.cover) alb.cover = dzMatch.cover;
    }
  }
  return {
    artist: canonicalName,
    picture: dzArtist?.picture || '',
    fans: dzArtist?.fans || 0,
    albums: mbAlbums,
  };
}

export async function getAlbumTracklist(artist: string, album: string, mbid = '', deezerAlbumId = '') {
  let dzId = deezerAlbumId;
  if (!dzId && artist && album) {
    const dzAlbs = await searchDeezerAlbums(`${artist} ${album}`, 5);
    const match = dzAlbs.find(
      (a) => a.title.toLowerCase().includes(album.toLowerCase()) || album.toLowerCase().includes(a.title.toLowerCase())
    );
    if (match) dzId = match.id;
  }
  if (dzId) {
    const details = await getDeezerAlbumDetails(dzId);
    if (details?.tracks?.length) {
      return details.tracks.map((t: any, i: number) => ({
        trackNumber: i + 1,
        deezerId: t.id,
        title: t.title,
        artist: t.artist || artist,
        album: details.title || album,
        duration: t.duration || 0,
        cover: t.cover || details.cover || '',
        isrc: t.isrc || '',
        source: 'deezer',
      }));
    }
  }
  if (mbid) {
    const mbTracks = await getMusicBrainzReleaseGroupTracks(mbid, artist);
    if (mbTracks.length > 0) return mbTracks.map((t) => ({ ...t, album }));
  }
  const itTracks = await searchItunesTracks(`${artist} ${album}`, 20);
  const filtered = itTracks.filter(
    (t) => t.album.toLowerCase().includes(album.toLowerCase()) || album.toLowerCase().includes(t.album.toLowerCase())
  );
  return (filtered.length ? filtered : itTracks.slice(0, 12)).map((t, i) => ({
    trackNumber: i + 1,
    title: t.title,
    artist: t.artist || artist,
    album: t.album || album,
    duration: t.duration || 0,
    cover: t.cover || '',
    source: 'apple',
  }));
}
