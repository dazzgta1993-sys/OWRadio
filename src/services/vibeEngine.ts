/**
 * @file services/vibeEngine.ts
 * @description True Multi-Cloud Vibe Engine rotating across YouTube Music (WEB_REMIX),
 * Deezer Studio Radio & Related Circle (3,000+ Fans), MusicBrainz Canonical Studio Albums,
 * Apple Music / iTunes, and Official UK/US Charts.
 */

import AudioTrack from '../player/AudioTrack.js';
import { getTasteProfile } from '../db/store.js';
import {
  splitCollabArtists,
  extractPrimaryArtist,
  extractAllTrackArtists,
  normalizeTrackKey,
} from '../utils/artistNormalizer.js';
import { isSkitOrIntro, isUnwantedVariant, isJunkAlbumTitle } from './streamFilters.js';
import {
  resolvePrimaryDeezerArtist,
  getDeezerArtistRadio,
  getDeezerRelatedArtists,
  getDeezerArtistTopTracks,
  getDeezerChartTracks,
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

let autoEngineRotationIdx = 0;

export function isVibeWorthy(
  cand: { title: string; artist: string; album?: string; duration?: number; rank?: number },
  artistFans = 0,
  dislikedArtists = new Set<string>(),
  dislikedTracks = new Set<string>()
): boolean {
  const title = (cand.title || '').trim();
  const artist = (cand.artist || '').trim();
  if (!title || !artist) return false;

  const artCreds = extractAllTrackArtists(artist, title).map((a) => a.toLowerCase());
  if (artCreds.some((a) => dislikedArtists.has(a))) return false;
  if (dislikedTracks.has(`${artist.toLowerCase()} - ${title.toLowerCase()}`)) return false;
  if (isJunkAlbumTitle(title, artist) || isSkitOrIntro(title, cand.duration || 0)) return false;
  if (isUnwantedVariant(title, '', artist)) return false;

  // Reject short TikTok edits/covers (<110s) and marathon DJ mixes (>540s)
  const dur = cand.duration || 0;
  if (dur > 0 && (dur < 110 || dur > 540)) return false;
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
  const { likedArtists, dislikedArtists, dislikedTracks } = getTasteProfile(ctx.guildId);

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
      for (const cred of extractAllTrackArtists(t.artist, t.title)) {
        recentArtists.add(cred.toLowerCase().trim());
      }
    }
  }

  const isCandidateFresh = (artist: string, title: string): boolean => {
    const tLow = (title || '').toLowerCase().trim();
    if (!tLow || seenTitles.has(tLow)) return false;
    const nKey = normalizeTrackKey(artist, title);
    if (seenKeys.has(nKey) || ctx.failedKeys.has(nKey)) return false;
    if (ctx.vibeMode !== 'deep_dive') {
      const creds = extractAllTrackArtists(artist, title).map((c) => c.toLowerCase());
      if (creds.some((c) => recentArtists.has(c))) return false;
    }
    return true;
  };

  const anchorPrimary = extractPrimaryArtist(ctx.vibeAnchorArtist || '');
  const seedPrimary = extractPrimaryArtist(effectiveSeed?.artist || anchorPrimary || '');
  const lovedList = Array.from(likedArtists);
  const lovedAnchor = lovedList.length > 0 ? pickRandomTop(lovedList, 3) : '';
  const targetArtist = ctx.vibeMode === 'discovery' ? seedPrimary || anchorPrimary : anchorPrimary || lovedAnchor || seedPrimary;
  const src = ctx.vibeEngineSource || 'auto';
  const poolCap = ctx.vibeMode === 'discovery' ? 10 : 6;
  const anchorSong = ctx.vibeAnchorTrack || effectiveSeed;

  // 1. DEEP DIVE MODE (100% Same Artist Studio Catalog)
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
          isrc: p.isrc, source: 'deezer', isAutoplay: true,
          requestedBy: 'Vibe DJ (Deep Dive)', vibeReason: 'Artist Deep Dive Catalog',
        });
      }
    }
  }

  // Define the 4 Studio Curation Engines so 'auto' rotates across all services fairly
  const tryYtMusicSongRadio = async (): Promise<AudioTrack | null> => {
    if (!targetArtist) return null;
    const primaryVid = anchorSong?.videoId || effectiveSeed?.videoId || '';
    const primaryQuery = `${targetArtist} ${anchorSong?.title || effectiveSeed?.title || ''}`.trim();
    const ytmRadio = await getYtMusicRelatedTracks(primaryVid, primaryQuery, 25);
    let worthyYtm = ytmRadio.filter(
      (t) =>
        isCandidateFresh(t.channel, t.title) &&
        isVibeWorthy({ title: t.title, artist: t.channel, album: t.album, duration: t.durationSeconds }, 5000, dislikedArtists, dislikedTracks)
    );
    if (worthyYtm.length < 3 && effectiveSeed?.videoId && effectiveSeed.videoId !== primaryVid) {
      const sec = await getYtMusicRelatedTracks(effectiveSeed.videoId, `${effectiveSeed.artist} ${effectiveSeed.title}`, 20);
      worthyYtm.push(...sec.filter((t) => isCandidateFresh(t.channel, t.title) && isVibeWorthy({ title: t.title, artist: t.channel, album: t.album, duration: t.durationSeconds }, 5000, dislikedArtists, dislikedTracks)));
    }
    const topPool = worthyYtm.slice(0, poolCap).sort(() => Math.random() - 0.5);
    for (const p of topPool) {
      const dzVerify = await searchDeezerTracks(`${extractPrimaryArtist(p.channel)} ${p.title}`, 4);
      const dzMatch = dzVerify.find(
        (d) =>
          (d.rank || 0) >= 120000 &&
          d.duration >= 110 &&
          !isUnwantedVariant(d.title, p.title, d.artist) &&
          isCandidateFresh(d.artist, d.title)
      );
      if (dzMatch) {
        const dzArt = await resolvePrimaryDeezerArtist(dzMatch.artist);
        if (dzArt && dzArt.fans < 3000) continue;
        return new AudioTrack({
          videoId: p.id, deezerId: dzMatch.id, title: dzMatch.title, artist: dzMatch.artist,
          album: dzMatch.album || p.album, duration: dzMatch.duration, artworkUrl: dzMatch.cover || p.thumbnail,
          isrc: dzMatch.isrc, source: 'ytmusic', isAutoplay: true,
          requestedBy: 'Vibe DJ (YouTube Music)', vibeReason: 'YouTube Music Studio Radio',
        });
      }
    }
    return null;
  };

  const tryDeezerArtistRadio = async (): Promise<AudioTrack | null> => {
    if (!targetArtist) return null;
    const dzArtist = await resolvePrimaryDeezerArtist(targetArtist);
    if (!dzArtist) return null;
    if (ctx.vibeMode !== 'collabs') {
      const radio = await getDeezerArtistRadio(dzArtist.id, 35);
      const worthyRadio = radio.filter(
        (t) => (t.rank || 0) >= 100000 && isCandidateFresh(t.artist, t.title) && isVibeWorthy(t, 5000, dislikedArtists, dislikedTracks)
      );
      if (worthyRadio.length > 0) {
        worthyRadio.sort((a, b) => (b.rank || 0) - (a.rank || 0));
        const p = pickRandomTop(worthyRadio, poolCap);
        return new AudioTrack({
          deezerId: p.id, title: p.title, artist: p.artist, artistId: p.artistId,
          album: p.album, duration: p.duration, artworkUrl: p.cover, isrc: p.isrc,
          source: 'deezer', isAutoplay: true,
          requestedBy: 'Vibe DJ (Deezer Radio)', vibeReason: 'Deezer Studio Radio',
        });
      }
    }
    const related = await getDeezerRelatedArtists(dzArtist.id, 15);
    const worthyRel = related.filter(
      (r) => r.fans >= 3000 && !splitCollabArtists(r.name).some((c) => recentArtists.has(c.toLowerCase())) && !dislikedArtists.has(r.name.toLowerCase())
    );
    if (worthyRel.length > 0) {
      const relPick = pickRandomTop(worthyRel, 5);
      const relTop = await getDeezerArtistTopTracks(relPick.id, 8);
      const worthyTop = relTop.filter((t) => isCandidateFresh(relPick.name, t.title) && isVibeWorthy(t, relPick.fans, dislikedArtists, dislikedTracks));
      if (worthyTop.length > 0) {
        const p = pickRandomTop(worthyTop, 3);
        return new AudioTrack({
          deezerId: p.id, title: p.title, artist: relPick.name, artistId: relPick.id,
          album: p.album, duration: p.duration, artworkUrl: p.cover || relPick.picture,
          isrc: p.isrc, source: 'deezer', isAutoplay: true,
          requestedBy: 'Vibe DJ (Deezer Related)', vibeReason: 'Deezer Related Circle (3k+ Fans)',
        });
      }
    }
    return null;
  };

  const tryMusicBrainzAndApple = async (): Promise<AudioTrack | null> => {
    if (!targetArtist) return null;
    const dzArtist = await resolvePrimaryDeezerArtist(targetArtist);
    const related = dzArtist ? await getDeezerRelatedArtists(dzArtist.id, 10) : [];
    const validRel = related.filter((r) => r.fans >= 5000 && !splitCollabArtists(r.name).some((c) => recentArtists.has(c.toLowerCase())));
    const lookupArtist = validRel.length > 0 ? pickRandomTop(validRel, 4).name : targetArtist;

    if (src === 'musicbrainz' || (src === 'auto' && autoEngineRotationIdx % 2 === 0)) {
      const mbAlbums = await getArtistCategorizedDiscography(lookupArtist, 15);
      const studios = mbAlbums.filter((a) => a.category === 'Studio Albums');
      if (studios.length > 0) {
        const albPick = pickRandomTop(studios, 4);
        const itTracks = await searchItunesTracks(`${lookupArtist} ${albPick.title}`, 8);
        const worthyMb = itTracks.filter((t) => isCandidateFresh(t.artist, t.title) && isVibeWorthy(t, 5000, dislikedArtists, dislikedTracks));
        if (worthyMb.length > 0) {
          const p = pickRandomTop(worthyMb, 3);
          return new AudioTrack({
            title: p.title, artist: p.artist, album: p.album || albPick.title, duration: p.duration,
            artworkUrl: p.cover || albPick.cover, releaseYear: p.year || albPick.year,
            source: 'musicbrainz', isAutoplay: true, requestedBy: 'Vibe DJ (MusicBrainz)', vibeReason: 'MusicBrainz Studio Discography',
          });
        }
      }
    }
    const appleTracks = await searchItunesTracks(lookupArtist, 15);
    const worthyApple = appleTracks.filter((t) => isCandidateFresh(t.artist, t.title) && isVibeWorthy(t, 5000, dislikedArtists, dislikedTracks));
    if (worthyApple.length > 0) {
      const p = pickRandomTop(worthyApple, 5);
      return new AudioTrack({
        title: p.title, artist: p.artist, album: p.album, duration: p.duration,
        artworkUrl: p.cover, releaseYear: p.year, genre: p.genre, source: 'apple',
        isAutoplay: true, requestedBy: 'Vibe DJ (Apple Music)', vibeReason: 'Apple Music Studio Catalog',
      });
    }
    return null;
  };

  // Execute according to selected source OR rotate across all engines in 'auto' mode
  if (src === 'ytmusic') { const r = await tryYtMusicSongRadio(); if (r) return r; }
  else if (src === 'deezer' || ctx.vibeMode === 'collabs') { const r = await tryDeezerArtistRadio(); if (r) return r; }
  else if (src === 'musicbrainz' || src === 'apple') { const r = await tryMusicBrainzAndApple(); if (r) return r; }
  else if (src === 'auto' && targetArtist) {
    const engines = [tryYtMusicSongRadio, tryDeezerArtistRadio, tryMusicBrainzAndApple];
    const startIdx = autoEngineRotationIdx++ % engines.length;
    for (let i = 0; i < engines.length; i++) {
      const track = await engines[(startIdx + i) % engines.length]();
      if (track) return track;
    }
  }

  // Cold-start / Charts rotation across Apple UK/US Official Charts & Deezer Global Top
  if (src === 'deezer' || (src === 'auto' && autoEngineRotationIdx % 2 === 1)) {
    const dzCharts = await getDeezerChartTracks(35);
    const worthyDz = dzCharts.filter((c) => isCandidateFresh(c.artist, c.title) && isVibeWorthy(c, 10000, dislikedArtists, dislikedTracks));
    if (worthyDz.length > 0) {
      const p = pickRandomTop(worthyDz, 10);
      return new AudioTrack({
        deezerId: p.id, title: p.title, artist: p.artist, album: p.album, duration: p.duration,
        artworkUrl: p.cover, source: 'deezer', isAutoplay: true,
        requestedBy: 'Vibe DJ (Deezer Top)', vibeReason: 'Deezer Global Top Rotation',
      });
    }
  }

  const charts = await getOfficialCharts('gb', 40);
  const worthyCharts = charts.filter((c) => isCandidateFresh(c.artist, c.title) && isVibeWorthy(c, 10000, dislikedArtists, dislikedTracks));
  if (worthyCharts.length > 0) {
    const p = pickRandomTop(worthyCharts, 10);
    return new AudioTrack({
      title: p.title, artist: p.artist, album: p.album, duration: p.duration,
      artworkUrl: p.cover, releaseYear: p.year, source: 'apple', isAutoplay: true,
      requestedBy: 'Vibe DJ (Official Charts)', vibeReason: 'Apple / UK Official Top 40',
    });
  }
  return null;
}
