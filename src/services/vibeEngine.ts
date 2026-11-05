/**
 * @file services/vibeEngine.ts
 * @description Port of Album Discovery Bot's Multi-Platform Vibe Engine (vibe_engine.py).
 * 100% real curation across Deezer Artist Radio, Deezer Related Artists (nb_fan >= 3000),
 * YouTube Music Algorithmic Radio, Apple Music/iTunes, MusicBrainz Studio Discography,
 * and UK/US Official Charts. Zero fake BPMs, zero random genre strings.
 */

import AudioTrack from '../player/AudioTrack.js';
import { getTasteProfile } from '../db/store.js';
import {
  splitCollabArtists,
  extractPrimaryArtist,
  normalizeTrackKey,
} from '../utils/artistNormalizer.js';
import {
  isSkitOrIntro,
  isUnwantedVariant,
  isJunkAlbumTitle,
} from './streamFilters.js';
import {
  resolvePrimaryDeezerArtist,
  getDeezerArtistRadio,
  getDeezerRelatedArtists,
  getDeezerArtistTopTracks,
  searchDeezerTracks,
} from './deezer.js';
import { getYtMusicRelatedTracks } from './ytmusic.js';
import { searchItunesTracks, getOfficialCharts } from './itunes.js';
import { getArtistCategorizedDiscography } from './musicbrainz.js';

export type VibeMode = 'balanced' | 'deep_dive' | 'collabs' | 'discovery';
export type VibeEngineSource = 'auto' | 'deezer' | 'ytmusic' | 'apple' | 'charts' | 'musicbrainz';

export interface VibeStateContext {
  guildId: string;
  vibeMode: VibeMode;
  vibeEngineSource: VibeEngineSource;
  vibeAnchorArtist: string;
  vibeAnchorTrack?: AudioTrack | null;
  consecutiveAutoplayCount: number;
  currentTrack: AudioTrack | null;
  queue: AudioTrack[];
  history: AudioTrack[];
  deck2Track: AudioTrack | null;
  deck3Track: AudioTrack | null;
  failedKeys: Set<string>;
}

export function isVibeWorthy(
  cand: { title: string; artist: string; album?: string; duration?: number; rank?: number },
  artistFans = 0,
  dislikedArtists = new Set<string>(),
  dislikedTracks = new Set<string>()
): boolean {
  const title = (cand.title || '').trim();
  const artist = (cand.artist || '').trim();
  if (!title || !artist) return false;

  const artCreds = splitCollabArtists(artist).map((a) => a.toLowerCase());
  if (artCreds.some((a) => dislikedArtists.has(a))) return false;
  if (dislikedTracks.has(`${artist.toLowerCase()} - ${title.toLowerCase()}`)) return false;
  if (isJunkAlbumTitle(title, artist) || isSkitOrIntro(title, cand.duration || 0)) return false;
  if (isUnwantedVariant(title, '', artist)) return false;

  const dur = cand.duration || 0;
  if (dur > 0 && (dur < 65 || dur > 540)) return false;
  if (artistFans > 0 && artistFans < 3000) return false;

  if (artist.toLowerCase() !== 'live') {
    const livePat =
      /\b(live at|live from|live in|live on|live version|live recording|live session)\b|[\(\[](?:19\d\d\/|20\d\d\/)?live\b|\s*-\s*live\b/i;
    if (livePat.test(title) || (cand.album && livePat.test(cand.album))) return false;
  }
  return true;
}

function pickRandomTop<T>(items: T[], poolSize = 6): T {
  const slice = items.slice(0, Math.max(1, Math.min(items.length, poolSize)));
  return slice[Math.floor(Math.random() * slice.length)];
}

export async function fetchNextVibeTrack(
  ctx: VibeStateContext,
  seedOverride?: AudioTrack | null
): Promise<AudioTrack | null> {
  const effectiveSeed =
    seedOverride || ctx.currentTrack || (ctx.history.length > 0 ? ctx.history[ctx.history.length - 1] : null);
  const { dislikedArtists, dislikedTracks } = getTasteProfile(ctx.guildId);

  const seenKeys = new Set<string>();
  const seenTitles = new Set<string>();
  const allActive = [
    ...ctx.history.slice(-40),
    ...(ctx.currentTrack ? [ctx.currentTrack] : []),
    ...ctx.queue,
    ...(ctx.deck2Track ? [ctx.deck2Track] : []),
    ...(ctx.deck3Track ? [ctx.deck3Track] : []),
    ...(seedOverride ? [seedOverride] : []),
  ];
  for (const t of allActive) {
    seenKeys.add(normalizeTrackKey(t.artist, t.title));
    seenTitles.add(t.title.toLowerCase().trim());
  }

  const recentArtists = new Set<string>();
  const recentWindow = [
    ...ctx.history.slice(-6),
    ...(ctx.currentTrack ? [ctx.currentTrack] : []),
    ...(ctx.deck2Track ? [ctx.deck2Track] : []),
    ...(ctx.deck3Track ? [ctx.deck3Track] : []),
  ];
  if (ctx.vibeMode !== 'deep_dive') {
    for (const t of recentWindow) {
      recentArtists.add(t.artist.toLowerCase().trim());
      for (const cred of splitCollabArtists(t.artist)) recentArtists.add(cred.toLowerCase().trim());
    }
  }

  const isCandidateFresh = (artist: string, title: string): boolean => {
    const tLow = (title || '').toLowerCase().trim();
    if (!tLow || seenTitles.has(tLow)) return false;
    const nKey = normalizeTrackKey(artist, title);
    if (seenKeys.has(nKey) || ctx.failedKeys.has(nKey)) return false;
    if (ctx.vibeMode !== 'deep_dive') {
      const creds = splitCollabArtists(artist).map((c) => c.toLowerCase());
      if (creds.some((c) => recentArtists.has(c))) return false;
    }
    return true;
  };

  const anchorPrimary = extractPrimaryArtist(ctx.vibeAnchorArtist || '');
  const seedPrimary = extractPrimaryArtist(effectiveSeed?.artist || anchorPrimary || '');
  const targetArtist =
    ctx.vibeMode === 'discovery' ? seedPrimary || anchorPrimary : anchorPrimary || seedPrimary;

  const src = ctx.vibeEngineSource || 'auto';
  const poolCap = ctx.vibeMode === 'discovery' ? 12 : 6;

  // 1. DEEP DIVE MODE
  if (ctx.vibeMode === 'deep_dive' && targetArtist) {
    const dzArtist = await resolvePrimaryDeezerArtist(targetArtist);
    if (dzArtist) {
      const topTracks = await getDeezerArtistTopTracks(dzArtist.id, 25);
      const worthy = topTracks.filter(
        (t) => isCandidateFresh(t.artist, t.title) && isVibeWorthy(t, dzArtist.fans, dislikedArtists, dislikedTracks)
      );
      if (worthy.length > 0) {
        const p = pickRandomTop(worthy, 8);
        return new AudioTrack({
          deezerId: p.id, title: p.title, artist: dzArtist.name, artistId: dzArtist.id,
          album: p.album, duration: p.duration, artworkUrl: p.cover || dzArtist.picture,
          isrc: p.isrc, source: 'autoplay', isAutoplay: true,
          requestedBy: 'Vibe DJ (Deep Dive)', vibeReason: `Deep Dive: ${dzArtist.name}`,
        });
      }
    }
  }

  // 2. SONG-EXACT YOUTUBE MUSIC ALGORITHMIC RADIO (WEB_REMIX)
  const anchorSong = ctx.vibeAnchorTrack || effectiveSeed;
  if ((src === 'auto' && ctx.vibeMode !== 'collabs') || src === 'ytmusic') {
    const seedVid = anchorSong?.videoId || effectiveSeed?.videoId || '';
    const ytmQuery = `${targetArtist} ${anchorSong?.title || effectiveSeed?.title || ''}`.trim();
    const ytmRadio = await getYtMusicRelatedTracks(seedVid, ytmQuery, 25);
    const worthyYtm = ytmRadio.filter(
      (t) =>
        isCandidateFresh(t.channel, t.title) &&
        isVibeWorthy({ title: t.title, artist: t.channel, album: t.album, duration: t.durationSeconds }, 5000, dislikedArtists, dislikedTracks)
    );
    const topPool = worthyYtm.slice(0, poolCap).sort(() => Math.random() - 0.5);
    for (const p of topPool) {
      const dzVerify = await searchDeezerTracks(`${extractPrimaryArtist(p.channel)} ${p.title}`, 2);
      const dzMatch = dzVerify.find((d) => (d.rank || 0) >= 80000);
      if (dzMatch || src === 'ytmusic') {
        return new AudioTrack({
          videoId: p.id, deezerId: dzMatch?.id, title: dzMatch?.title || p.title,
          artist: dzMatch?.artist || p.channel, album: dzMatch?.album || p.album,
          duration: dzMatch?.duration || p.durationSeconds, artworkUrl: dzMatch?.cover || p.thumbnail,
          isrc: dzMatch?.isrc, source: 'autoplay', isAutoplay: true,
          requestedBy: 'Vibe DJ (Song Radio)', vibeReason: `Song Vibe: ${anchorSong?.title || targetArtist}`,
        });
      }
    }
  }

  // 3. DEEZER SMART ARTIST RADIO & RELATED CIRCLE (nb_fan >= 3000)
  if (targetArtist && (src === 'auto' || src === 'deezer' || ctx.vibeMode === 'collabs')) {
    const dzArtist = await resolvePrimaryDeezerArtist(targetArtist);
    if (dzArtist) {
      if (ctx.vibeMode !== 'collabs') {
        const radio = await getDeezerArtistRadio(dzArtist.id, 35);
        const worthyRadio = radio.filter(
          (t) => isCandidateFresh(t.artist, t.title) && isVibeWorthy(t, 5000, dislikedArtists, dislikedTracks)
        );
        if (worthyRadio.length > 0) {
          worthyRadio.sort((a, b) => (b.rank || 0) - (a.rank || 0));
          const p = pickRandomTop(worthyRadio, poolCap);
          return new AudioTrack({
            deezerId: p.id, title: p.title, artist: p.artist, artistId: p.artistId,
            album: p.album, duration: p.duration, artworkUrl: p.cover, isrc: p.isrc,
            source: 'autoplay', isAutoplay: true,
            requestedBy: 'Vibe DJ (Deezer Radio)', vibeReason: `Deezer Artist Radio: ${dzArtist.name}`,
          });
        }
      }

      const related = await getDeezerRelatedArtists(dzArtist.id, 15);
      const worthyRel = related.filter(
        (r) =>
          r.fans >= 3000 &&
          !splitCollabArtists(r.name).some((c) => recentArtists.has(c.toLowerCase())) &&
          !dislikedArtists.has(r.name.toLowerCase())
      );
      if (worthyRel.length > 0) {
        const relPick = pickRandomTop(worthyRel, 5);
        const relTop = await getDeezerArtistTopTracks(relPick.id, 8);
        const worthyTop = relTop.filter(
          (t) => isCandidateFresh(relPick.name, t.title) && isVibeWorthy(t, relPick.fans, dislikedArtists, dislikedTracks)
        );
        if (worthyTop.length > 0) {
          const p = pickRandomTop(worthyTop, 3);
          return new AudioTrack({
            deezerId: p.id, title: p.title, artist: relPick.name, artistId: relPick.id,
            album: p.album, duration: p.duration, artworkUrl: p.cover || relPick.picture,
            isrc: p.isrc, source: 'autoplay', isAutoplay: true,
            requestedBy: 'Vibe DJ (Related Artist)', vibeReason: `Related to ${dzArtist.name}: ${relPick.name}`,
          });
        }
      }
    }
  }

  // 4. MUSICBRAINZ CANONICAL STUDIO DISCOGRAPHY
  if (src === 'musicbrainz' && targetArtist) {
    const mbAlbums = await getArtistCategorizedDiscography(targetArtist, 20);
    const studioAlbums = mbAlbums.filter((a) => a.category === 'Studio Albums');
    const pool = studioAlbums.length > 0 ? studioAlbums : mbAlbums;
    if (pool.length > 0) {
      const albPick = pickRandomTop(pool, 6);
      const itTracks = await searchItunesTracks(`${targetArtist} ${albPick.title}`, 10);
      const worthyMb = itTracks.filter(
        (t) => isCandidateFresh(t.artist, t.title) && isVibeWorthy(t, 5000, dislikedArtists, dislikedTracks)
      );
      if (worthyMb.length > 0) {
        const p = pickRandomTop(worthyMb, 4);
        return new AudioTrack({
          title: p.title, artist: p.artist, album: p.album || albPick.title,
          duration: p.duration, artworkUrl: p.cover || albPick.cover,
          releaseYear: p.year || albPick.year, source: 'autoplay', isAutoplay: true,
          requestedBy: 'Vibe DJ (MusicBrainz)', vibeReason: `MusicBrainz Studio LP: ${albPick.title}`,
        });
      }
    }
  }

  // 5. APPLE MUSIC & OFFICIAL UK/US CHARTS ROTATION
  if ((src === 'auto' || src === 'apple') && targetArtist) {
    const appleTracks = await searchItunesTracks(targetArtist, 15);
    const worthyApple = appleTracks.filter(
      (t) => !seenTitles.has(t.title.toLowerCase().trim()) && isVibeWorthy(t, 5000, dislikedArtists, dislikedTracks)
    );
    if (worthyApple.length > 0) {
      const p = pickRandomTop(worthyApple, 5);
      return new AudioTrack({
        title: p.title, artist: p.artist, album: p.album, duration: p.duration,
        artworkUrl: p.cover, releaseYear: p.year, genre: p.genre, source: 'autoplay',
        isAutoplay: true, requestedBy: 'Vibe DJ (Apple Music)', vibeReason: `Apple Music: ${targetArtist}`,
      });
    }
  }

  const charts = await getOfficialCharts('gb', 40);
  const worthyCharts = charts.filter(
    (c) => isCandidateFresh(c.artist, c.title) && isVibeWorthy(c, 10000, dislikedArtists, dislikedTracks)
  );
  if (worthyCharts.length > 0) {
    const p = pickRandomTop(worthyCharts, 10);
    return new AudioTrack({
      title: p.title, artist: p.artist, album: p.album, duration: p.duration,
      artworkUrl: p.cover, releaseYear: p.year, source: 'autoplay', isAutoplay: true,
      requestedBy: 'Vibe DJ (Official Charts)', vibeReason: 'Official Top 40 Rotation',
    });
  }

  if (anchorPrimary) {
    const dzTracks = await searchDeezerTracks(anchorPrimary, 15);
    const fresh = dzTracks.filter((t) => !seenTitles.has(t.title.toLowerCase()));
    if (fresh.length > 0) {
      const p = pickRandomTop(fresh, 5);
      return new AudioTrack({
        deezerId: p.id, title: p.title, artist: p.artist, album: p.album,
        duration: p.duration, artworkUrl: p.cover, source: 'autoplay',
        isAutoplay: true, requestedBy: 'Vibe DJ (Anchor)', vibeReason: `Anchor Catalog: ${anchorPrimary}`,
      });
    }
  }
  return null;
}
