/**
 * @file services/searchService.ts
 * @description Unified 100% real search & URL resolution router.
 * Handles:
 * 1. Spotify URLs (track / album / playlist) via zero-key embed + oEmbed + Deezer duration enrichment.
 * 2. YouTube / YouTube Music URLs (single video or playlist).
 * 3. Studio Track Search combining YouTube Music (WEB_REMIX ATV/Topic studio masters) + Deezer + iTunes.
 */

import AudioTrack from '../player/AudioTrack.js';
import { matchSpotifyUrl, resolveSpotifyUrl } from './spotify.js';
import { searchYtMusicSongs } from './ytmusic.js';
import { searchDeezerTracks, getDeezerAlbumDetails } from './deezer.js';
import { searchItunesTracks } from './itunes.js';
import { searchYouTubeBasic } from './youtube.js';
import { isUnwantedVariant, isSkitOrIntro } from './streamFilters.js';
import { normalizeTrackKey } from '../utils/artistNormalizer.js';

const YOUTUBE_URL_REGEX =
  /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|playlist\?list=)|youtu\.be\/)([a-zA-Z0-9_-]+)/i;

/**
 * Resolves a user query (text search, Spotify link, or YouTube link) into one or more AudioTracks.
 */
export async function resolveQueryToTracks(
  query: string,
  requestedBy = 'Listener'
): Promise<{ tracks: AudioTrack[]; collectionName?: string }> {
  const q = (query || '').trim();
  if (!q) return { tracks: [] };

  // 1. Check Spotify URL (Track / Album / Playlist)
  if (matchSpotifyUrl(q)) {
    const sp = await resolveSpotifyUrl(q);
    if (sp && sp.tracks.length > 0) {
      const tracks = sp.tracks.map(
        (t) =>
          new AudioTrack({
            title: t.title,
            artist: t.artist,
            album: t.album,
            duration: t.durationSeconds,
            artworkUrl: t.cover || sp.cover,
            source: 'spotify',
            requestedBy,
          })
      );
      return {
        tracks,
        collectionName: sp.type !== 'track' ? `${sp.name} (${tracks.length} tracks)` : undefined,
      };
    }
  }

  // 2. Check YouTube / YouTube Music URL
  if (YOUTUBE_URL_REGEX.test(q)) {
    const basicHits = await searchYouTubeBasic(q, 50);
    if (basicHits.length > 0) {
      const tracks = basicHits.map(
        (h) =>
          new AudioTrack({
            videoId: h.id,
            title: h.title,
            artist: h.artist,
            duration: h.duration,
            artworkUrl: h.cover,
            releaseYear: h.releaseYear,
            source: 'youtube',
            requestedBy,
          })
      );
      return {
        tracks,
        collectionName: tracks.length > 1 ? `YouTube Playlist (${tracks.length} tracks)` : undefined,
      };
    }
  }

  // 3. Check Deezer Album URL
  const dzAlbumMatch = /deezer\.com\/(?:\w+\/)?album\/(\d+)/i.exec(q);
  if (dzAlbumMatch) {
    const alb = await getDeezerAlbumDetails(dzAlbumMatch[1]);
    if (alb && Array.isArray(alb.tracks)) {
      const tracks = alb.tracks.map(
        (t: any) =>
          new AudioTrack({
            deezerId: t.id,
            title: t.title,
            artist: t.artist,
            artistId: t.artistId,
            album: alb.title,
            duration: t.duration,
            artworkUrl: t.cover || alb.cover,
            isrc: t.isrc,
            upc: alb.upc,
            releaseYear: alb.year,
            source: 'deezer',
            requestedBy,
          })
      );
      return { tracks, collectionName: `${alb.artist} - ${alb.title}` };
    }
  }

  // 4. Text Query -> Search Studio Catalogs
  const results = await searchStudioCatalog(q, 5, requestedBy);
  return { tracks: results.slice(0, 1) };
}

/**
 * Multi-Catalog Studio Search for the Web Dashboard & Discord autocomplete.
 * Combines Deezer (high-res studio metadata + exact durations) and YouTube Music (WEB_REMIX official songs),
 * filtering out 99% of YouTube junk unless the user explicitly searched for a remix/live/cover.
 */
export async function searchStudioCatalog(
  query: string,
  limit = 15,
  requestedBy = 'Listener'
): Promise<AudioTrack[]> {
  const q = (query || '').trim();
  if (!q) return [];

  const [dzTracks, ytmTracks] = await Promise.all([
    searchDeezerTracks(q, limit),
    searchYtMusicSongs(q, true, limit),
  ]);

  const results: AudioTrack[] = [];
  const seenKeys = new Set<string>();

  // Map YouTube Music studio videoIds by normalized track key so Deezer results get instant videoIds
  const ytmByKey = new Map<string, string>();
  for (const yt of ytmTracks) {
    if (isUnwantedVariant(yt.title, q, yt.channel)) continue;
    const k = normalizeTrackKey(yt.channel, yt.title);
    if (!ytmByKey.has(k)) {
      ytmByKey.set(k, yt.id);
    }
  }

  // 1. Primary Studio Catalog (Deezer verified tracks paired with YouTube Music ATV videoId if matched)
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
        videoId: matchedVid,
        deezerId: dz.id,
        title: dz.title,
        artist: dz.artist,
        artistId: dz.artistId,
        album: dz.album,
        duration: dz.duration,
        artworkUrl: dz.cover,
        isrc: dz.isrc,
        explicit: dz.explicit,
        source: 'deezer',
        requestedBy,
      })
    );
    if (results.length >= limit) return results;
  }

  // 2. YouTube Music WEB_REMIX Official Studio Songs (for tracks/remixes not in top Deezer hits)
  for (const yt of ytmTracks) {
    if (isUnwantedVariant(yt.title, q, yt.channel)) continue;
    const k = normalizeTrackKey(yt.channel, yt.title);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);

    results.push(
      new AudioTrack({
        id: `yt_${yt.id}`,
        videoId: yt.id,
        title: yt.title,
        artist: yt.channel,
        album: yt.album,
        duration: yt.durationSeconds,
        artworkUrl: yt.thumbnail,
        source: 'ytmusic',
        requestedBy,
      })
    );
    if (results.length >= limit) return results;
  }

  // 3. iTunes fallback if both were empty
  if (results.length === 0) {
    const itTracks = await searchItunesTracks(q, limit);
    for (const it of itTracks) {
      results.push(
        new AudioTrack({
          id: it.id,
          title: it.title,
          artist: it.artist,
          album: it.album,
          duration: it.duration,
          artworkUrl: it.cover,
          releaseYear: it.year,
          genre: it.genre,
          source: 'apple',
          requestedBy,
        })
      );
    }
  }

  return results.slice(0, limit);
}
