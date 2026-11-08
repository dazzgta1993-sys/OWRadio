/**
 * @file services/youtube.ts
 * @description 6-Pass Studio Stream Resolver + yt-dlp extractor.
 * Pre-enriches canonical track duration & ISRC from Deezer when duration <= 0.
 * Extracts direct audio stream URLs via yt-dlp with L1 memory + L2 SQLite caching.
 * Every single file strictly under 300 lines of code.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import config from '../config.js';
import { getStreamResolution, setStreamResolution, StreamResolutionRecord } from '../db/store.js';
import { cleanTargetTitle, isDurationValid, isUnwantedVariant, isTitleMatch, isArtistMatch } from './streamFilters.js';
import { searchYtMusicSongs, YtMusicCandidate } from './ytmusic.js';
import { searchDeezerTracks, getDeezerTrackIsrc } from './deezer.js';

const execFileAsync = promisify(execFile);
const streamUrlCache = new Map<string, { url: string; headers: Record<string, string>; expiresAt: number; duration?: number }>();

function getYtDlpBaseArgs(): string[] {
  const args = ['--no-playlist', '--no-warnings', '--quiet', '--geo-bypass'];
  if (config.YOUTUBE_COOKIES_PATH && fs.existsSync(config.YOUTUBE_COOKIES_PATH)) args.push('--cookies', config.YOUTUBE_COOKIES_PATH);
  else if (fs.existsSync('./cookies.txt')) args.push('--cookies', './cookies.txt');
  if (config.YOUTUBE_PROXY) args.push('--proxy', config.YOUTUBE_PROXY);
  return args;
}

export async function resolveTrackStream(params: {
  artist: string; title: string; album?: string; duration?: number; trackId?: string; isrc?: string; forceFresh?: boolean;
}): Promise<StreamResolutionRecord | null> {
  let cleanArtist = (params.artist || '').trim();
  const cleanTitle = (params.title || '').trim();
  let cleanAlbum = (params.album || '').trim();
  const cleanCore = cleanTargetTitle(cleanTitle);
  let cleanIsrc = (params.isrc || '').trim().toUpperCase();
  let duration = Math.max(0, Math.floor(Number(params.duration) || 0));
  let trackId = (params.trackId || '').trim();
  if (!cleanTitle) return null;

  if (duration <= 0) {
    try {
      const artPart = ['youtube', 'youtube search', 'direct query', 'unknown', 'unknown artist'].includes(cleanArtist.toLowerCase()) ? '' : cleanArtist;
      const dzHits = await searchDeezerTracks(`${artPart} ${cleanCore}`.trim(), 3);
      for (const hit of dzHits) {
        if (isTitleMatch(hit.title, cleanTitle) && (!artPart || isArtistMatch({ channel: hit.artist, artists: [hit.artist] }, artPart))) {
          if (hit.duration >= 45) duration = hit.duration;
          if (!artPart && hit.artist) cleanArtist = hit.artist;
          if (!cleanAlbum && hit.album) cleanAlbum = hit.album;
          if (!trackId && hit.id) trackId = hit.id;
          if (!cleanIsrc && hit.isrc) cleanIsrc = hit.isrc;
          break;
        }
      }
    } catch {}
  }

  const cacheKey = `${cleanArtist.toLowerCase()}:::${cleanTitle.toLowerCase()}:::${cleanAlbum.toLowerCase()}`;
  if (!params.forceFresh) {
    const dbRes = getStreamResolution(cacheKey);
    if (dbRes && isDurationValid(dbRes.duration, duration, 5) && !isUnwantedVariant(dbRes.title, cleanTitle, dbRes.channel || '')) return dbRes;
  }

  const candidates: Array<{ score: number; item: YtMusicCandidate }> = [];
  const seenIds = new Set<string>();

  const evaluateItems = (items: YtMusicCandidate[], toleranceSecs = 5, matchTarget = cleanTitle) => {
    for (const item of items) {
      if (!item.id || seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      if (!isDurationValid(item.durationSeconds, duration, toleranceSecs, duration <= 0)) continue;
      if (isUnwantedVariant(item.title, matchTarget, item.channel)) continue;
      if (!isTitleMatch(item.title, matchTarget) || !isArtistMatch(item, cleanArtist)) continue;

      let score = 0; const chLow = (item.channel || '').toLowerCase();
      if (item.videoType === 'MUSIC_VIDEO_TYPE_UGC') score -= 60;
      if (item.videoType === 'MUSIC_VIDEO_TYPE_ATV' || chLow.includes('topic')) score += 50;
      else if (chLow.includes('vevo')) score += 35;
      else if (cleanArtist && chLow.includes(cleanArtist.toLowerCase())) score += 25;

      const normCand = item.title.toLowerCase().replace(/[^\w\s]/g, '').trim();
      const normTarget = cleanCore.toLowerCase().replace(/[^\w\s]/g, '').trim();
      if (normCand === normTarget) score += 30; else if (normCand.includes(normTarget)) score += 15;
      if (cleanAlbum && item.album && item.album.toLowerCase().includes(cleanAlbum.toLowerCase())) score += 20;

      if (duration > 0 && item.durationSeconds > 0) {
        const diff = Math.abs(item.durationSeconds - duration);
        if (diff <= 1) score += 25; else if (diff <= 3) score += 15;
      }
      const tLow = item.title.toLowerCase();
      if (tLow.includes('official audio') || tLow.includes('(audio)')) score += 35;
      if (tLow.includes('lyrics') || tLow.includes('lyric video')) score -= 20;
      candidates.push({ score, item });
    }
  };

  // Pass 1: Direct Clean Studio Queries on YouTube Music WEB_REMIX
  const fastQueries = [`${cleanArtist} ${cleanCore}`.trim(), `${cleanArtist} - ${cleanCore}`.trim()];
  if (cleanAlbum) fastQueries.splice(1, 0, `${cleanArtist} ${cleanAlbum} ${cleanCore}`.trim());
  for (const q of fastQueries) {
    const items = await searchYtMusicSongs(q, true, 12);
    evaluateItems(items, 5);
    if (candidates.some((c) => c.score >= 50)) break;
  }

  // Pass 2: Specific Quoted Official Audio Match
  if (candidates.length === 0) {
    const quoted = [`"${cleanArtist} - ${cleanCore} (Official Audio)"`, `"${cleanArtist}" "${cleanCore}"`];
    for (const q of quoted) {
      const items = await searchYtMusicSongs(q, true, 10);
      evaluateItems(items, 5);
      if (candidates.some((c) => c.score >= 50)) break;
    }
  }

  // Pass 3: Exact ISRC Lookup
  if (candidates.length === 0) {
    if (!cleanIsrc && trackId && /^\d+$/.test(trackId)) cleanIsrc = await getDeezerTrackIsrc(trackId);
    if (cleanIsrc) {
      const isrcItems = await searchYtMusicSongs(cleanIsrc, true, 8);
      evaluateItems(isrcItems, 6);
    }
  }

  // Pass 4: Stripped Core Title with +/-8s relaxed tolerance
  if (candidates.length === 0) {
    const items = await searchYtMusicSongs(`${cleanArtist} ${cleanCore}`.trim(), true, 15);
    evaluateItems(items, 8, cleanCore);
  }

  // Pass 5: Unfiltered YouTube Music catalog (includes official videos)
  if (candidates.length === 0) {
    const items = await searchYtMusicSongs(`${cleanArtist} ${cleanCore} official audio`.trim(), false, 12);
    evaluateItems(items, 10, cleanCore);
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0].item;
    const resolved: StreamResolutionRecord = {
      id: best.id, title: best.title || cleanTitle, artist: cleanArtist || best.channel,
      album: best.album || cleanAlbum, duration: best.durationSeconds || duration,
      channel: best.channel, matchType: best.isOfficialStudio ? 'ytmusic_atv_topic' : 'ytmusic_verified',
    };
    setStreamResolution(cacheKey, resolved);
    return resolved;
  }

  // Pass 6: Direct yt-dlp search fallback
  const ytdlpHits = await searchYouTubeBasic(`${cleanArtist} - ${cleanCore} Official Audio`.trim(), 3);
  if (ytdlpHits.length > 0) {
    const top = ytdlpHits[0];
    const resolved: StreamResolutionRecord = {
      id: top.id, title: top.title || cleanTitle, artist: cleanArtist || top.artist,
      album: cleanAlbum, duration: top.duration || duration, channel: top.artist, matchType: 'ytdlp_fallback',
    };
    setStreamResolution(cacheKey, resolved);
    return resolved;
  }
  return null;
}

export async function extractStreamInfo(videoId: string): Promise<{ url: string; headers: Record<string, string>; duration?: number } | null> {
  const cleanVid = (videoId || '').replace(/^yt_/, '').trim();
  if (!cleanVid) return null;

  const cached = streamUrlCache.get(cleanVid);
  if (cached && cached.expiresAt > Date.now()) return { url: cached.url, headers: cached.headers, duration: cached.duration };

  const targetUrl = cleanVid.startsWith('http') ? cleanVid : `https://www.youtube.com/watch?v=${cleanVid}`;
  const args = [...getYtDlpBaseArgs(), '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best', '--dump-single-json', targetUrl];

  try {
    const { stdout } = await execFileAsync('yt-dlp', args, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 });
    const info = JSON.parse(stdout);
    const streamUrl = String(info?.url || '');
    if (!streamUrl) return null;

    const headers: Record<string, string> = {};
    if (info?.http_headers && typeof info.http_headers === 'object') {
      for (const [k, v] of Object.entries(info.http_headers)) headers[k] = String(v);
    }
    const duration = info?.duration ? Math.round(Number(info.duration)) : undefined;
    streamUrlCache.set(cleanVid, { url: streamUrl, headers, duration, expiresAt: Date.now() + 3 * 3600 * 1000 });
    return { url: streamUrl, headers, duration };
  } catch (err) {
    console.warn(`⚠️ [yt-dlp] Stream extraction failed for ${cleanVid}:`, (err as Error).message);
    return null;
  }
}

export async function searchYouTubeBasic(query: string, limit = 5): Promise<Array<{ id: string; title: string; artist: string; duration: number; cover: string; releaseYear: string }>> {
  const q = (query || '').trim();
  if (!q) return [];
  const searchSpec = /^https?:\/\//i.test(q) ? q : `ytsearch${limit}:${q}`;
  const args = [...getYtDlpBaseArgs(), '--flat-playlist', '--dump-single-json', searchSpec];

  try {
    const { stdout } = await execFileAsync('yt-dlp', args, { timeout: 12000, maxBuffer: 10 * 1024 * 1024 });
    const data = JSON.parse(stdout);
    const entries = Array.isArray(data?.entries) ? data.entries : [data];
    const results: Array<{ id: string; title: string; artist: string; duration: number; cover: string; releaseYear: string }> = [];

    for (const e of entries) {
      const id = String(e?.id || '').trim();
      const rawTitle = String(e?.title || '').trim();
      if (!id || !rawTitle) continue;
      let artist = String(e?.channel || e?.uploader || 'YouTube').replace(/\s*-\s*Topic$/i, '').trim();
      let title = rawTitle;
      if (rawTitle.includes(' - ')) {
        const [p1, p2] = rawTitle.split(' - ', 2);
        artist = p1.trim(); title = p2.trim();
      }
      const duration = Math.round(Number(e?.duration || 0));
      const releaseYear = String(e?.release_year || e?.upload_date || '').slice(0, 4);
      results.push({ id, title, artist, duration, cover: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, releaseYear: /^\d{4}$/.test(releaseYear) ? releaseYear : '' });
      if (results.length >= limit) break;
    }
    return results;
  } catch {
    return [];
  }
}
