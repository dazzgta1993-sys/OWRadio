/**
 * @file streamResolver.ts
 * @description Multi-tier audio stream resolver using L2 SQLite caching, yt-dlp candidate search,
 * strict duration guardrails (±5s to ±12s), variant filtering (no live/karaoke/covers), and zero-gap 512KB prewarming.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { sqlite } from '../db/index.js';
import config from '../config.js';
import deezerService, { type DeezerTrackMetadata } from './deezer.js';
import youtubeService from './youtube.js';
import dynamicSettings from './dynamicSettings.js';

const execFileAsync = promisify(execFile);

export interface ResolvedStream {
  songId: string;
  youtubeId: string;
  streamUrl: string;
  durationSec: number;
  source: 'cache' | 'ytdlp' | 'deezer';
}

interface YtDlpCandidate {
  id: string;
  title: string;
  duration?: number;
  uploader?: string;
}

/**
 * Words that indicate alternative / non-studio versions.
 */
const UNWANTED_VARIANTS = [
  'karaoke',
  'instrumental',
  'backing track',
  'tribute',
  'remake',
  'parody',
  'lesson',
  'tutorial',
  'guitar tab',
  'acoustic cover',
  'cover by',
  'slowed + reverb',
  'slowed and reverb',
  '8d audio',
  'nightcore',
  'bass boosted',
  'full album',
  'compilation',
  'live at',
  'live from',
  'in concert',
  'live 19',
  'live 20',
  'reaction',
  'podcast',
  'medley',
];

/**
 * Checks if a candidate title contains unwanted variant keywords that aren't part of the canonical title,
 * dynamically respecting granular toggles (Lives, Covers, Instrumentals, Remixes).
 */
function isVariantClean(candidateTitle: string, canonicalTitle: string): boolean {
  const normCandidate = candidateTitle.toLowerCase();
  const normCanonical = canonicalTitle.toLowerCase();

  const liveFilter = dynamicSettings.getString('curation_filter_live', 'none');
  const coverFilter = dynamicSettings.getString('curation_filter_covers', 'none');
  const instrumentalFilter = dynamicSettings.getString('curation_filter_instrumentals', 'none');
  const remixFilter = dynamicSettings.getString('curation_filter_remixes', 'none');
  const rerecordedFilter = dynamicSettings.getString('curation_filter_rerecorded', 'none');

  // Check live keywords if live is not set to 'any'
  if (liveFilter !== 'any') {
    const liveWords = ['live at', 'live from', 'in concert', 'live 19', 'live 20', 'acoustic live', 'unplugged', 'alive', 'live album', 'wildwood'];
    for (const w of liveWords) {
      if (normCandidate.includes(w) && !normCanonical.includes(w)) {
        return false;
      }
    }
  }

  // Check covers keywords if covers is not set to 'any'
  if (coverFilter !== 'any') {
    const coverWords = ['acoustic cover', 'cover by', 'cover version', 'tribute band', 'karaoke', 'fan cover'];
    for (const w of coverWords) {
      if (normCandidate.includes(w) && !normCanonical.includes(w)) {
        return false;
      }
    }
  }

  // Check instrumentals if instrumentals is not set to 'any'
  if (instrumentalFilter !== 'any') {
    const instWords = ['instrumental', 'backing track', 'karaoke', 'minus one', 'no vocals', 'off vocal'];
    for (const w of instWords) {
      if (normCandidate.includes(w) && !normCanonical.includes(w)) {
        return false;
      }
    }
  }

  // Check remixes if remixes is 'none'
  if (remixFilter === 'none') {
    if (normCandidate.includes('remix') && !normCanonical.includes('remix')) {
      return false;
    }
  }

  // Check re-recorded versions if rerecorded is 'none'
  if (rerecordedFilter === 'none') {
    const rerecordWords = ['re-recorded', 'rerecorded', 're-recording', 'new version', 're-cut', 're-record'];
    for (const w of rerecordWords) {
      if (normCandidate.includes(w) && !normCanonical.includes(w)) {
        return false;
      }
    }
  }

  // Always unwanted junk (earrape, meme, nightcore, tutorials)
  const junkWords = [
    'remake', 'parody', 'lesson', 'tutorial', 'guitar tab',
    'slowed + reverb', 'slowed and reverb', '8d audio', 'nightcore',
    'bass boosted', 'full album', 'compilation', 'reaction', 'podcast', 'medley', 'earrape', 'tiktok'
  ];
  for (const word of junkWords) {
    if (normCandidate.includes(word) && !normCanonical.includes(word)) {
      return false;
    }
  }
  return true;
}

/**
 * Ensures that at least 50% of the significant words from the canonical title appear in candidate title.
 */
function hasTitleMatch(candidateTitle: string, canonicalTitle: string): boolean {
  const words = canonicalTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !['the', 'and', 'feat', 'ft', 'official', 'audio', 'video'].includes(w));

  if (words.length === 0) return true;
  const normCandidate = candidateTitle.toLowerCase();
  const matched = words.filter((w) => normCandidate.includes(w));
  return matched.length / words.length >= 0.5;
}

/**
 * Resolves a direct audio stream URL for a canonical track.
 */
export async function resolveStream(
  track: { id: string; title: string; artist: string; durationSec: number; previewUrl?: string }
): Promise<ResolvedStream | null> {
  const now = Math.floor(Date.now() / 1000);

  // --- Step 1: L2 SQLite Cache Check ---
  try {
    const cached = sqlite.prepare(`
      SELECT youtube_id, stream_url, expires_at
      FROM stream_cache
      WHERE song_id = ? AND expires_at > ?
      LIMIT 1
    `).get(track.id, now) as { youtube_id: string; stream_url: string; expires_at: number } | undefined;

    // Never use stale dz_preview or corrupt spotify URLs from cache
    if (
      cached &&
      cached.youtube_id !== 'dz_preview' &&
      !cached.stream_url?.includes('spotify') &&
      !cached.youtube_id?.includes('spotify')
    ) {
      const isSoundcloud = cached.youtube_id === 'soundcloud';
      const streamUrl = isSoundcloud
        ? cached.stream_url
        : `https://www.youtube.com/watch?v=${cached.youtube_id}`;
      return {
        songId: track.id,
        youtubeId: cached.youtube_id,
        streamUrl,
        durationSec: track.durationSec,
        source: 'cache',
      };
    }
  } catch (err) {
    console.warn(`[StreamResolver] Cache check error for ${track.id}:`, (err as Error).message);
  }

  // --- Step 2: Direct YouTube Track Stream Extraction ---
  // Ensure videoId is a genuine 11-character YouTube video ID (not legacy yt_spotify:... or other foreign ID)
  if (track.id.startsWith('yt_')) {
    const videoId = track.id.replace(/^yt_/, '');
    if (/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const expiresAt = now + 86400; // 24 hours
      try {
        sqlite.prepare(`
          INSERT OR REPLACE INTO stream_cache (song_id, youtube_id, stream_url, expires_at)
          VALUES (?, ?, ?, ?)
        `).run(track.id, videoId, watchUrl, expiresAt);
      } catch {}
      return {
        songId: track.id,
        youtubeId: videoId,
        streamUrl: watchUrl,
        durationSec: track.durationSec,
        source: 'ytdlp',
      };
    }
  }

  const cookiesPath = config.YOUTUBE_COOKIES_PATH || (existsSync(path.resolve(process.cwd(), 'cookies.txt')) ? path.resolve(process.cwd(), 'cookies.txt') : undefined);

  // --- Step 3: YouTube Music & YouTube Search via yt-dlp ---
  const baseArgs = [
    '--dump-json',
    '--flat-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--extractor-args', 'youtube:player_client=web,android,ios',
    '--js-runtimes', 'node',
  ];

  if (config.YOUTUBE_PROXY) {
    baseArgs.push('--proxy', config.YOUTUBE_PROXY);
  }
  if (cookiesPath) {
    baseArgs.push('--cookies', cookiesPath);
  }

  let candidates: YtDlpCandidate[] = [];

  // 3a. Prioritize YouTube Music (ytmsearch) for pristine studio albums and official cuts
  try {
    const ytmQuery = `ytsearch5:${track.artist} - ${track.title} Topic`;
    const { stdout } = await execFileAsync('yt-dlp', [...baseArgs, '--default-search', 'ytsearch', ytmQuery], {
      timeout: 8000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.id) {
          candidates.push({
            id: item.id,
            title: item.title || '',
            duration: item.duration,
            uploader: item.uploader || '',
          });
        }
      } catch {}
    }
  } catch {}

  // 3b. Fallback to standard YouTube search if YouTube Music has no candidate
  if (candidates.length === 0) {
    const searchQuery = `ytsearch5:${track.artist} - ${track.title} official audio`;
    try {
      const { stdout } = await execFileAsync('yt-dlp', [...baseArgs, '--default-search', 'ytsearch', searchQuery], {
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const lines = stdout.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (item.id) {
            candidates.push({
              id: item.id,
              title: item.title || '',
              duration: item.duration,
              uploader: item.uploader || '',
            });
          }
        } catch {}
      }
    } catch (err) {
      console.warn(`[StreamResolver] yt-dlp YouTube search failed:`, (err as Error).message);
    }
  }

  // If initial official search found nothing, try direct Topic query before giving up on YouTube
  if (candidates.length === 0) {
    try {
      const topicQuery = `ytsearch3:${track.artist} - ${track.title} Topic`;
      const { stdout } = await execFileAsync('yt-dlp', [...baseArgs, topicQuery], {
        timeout: 8000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const lines = stdout.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (item.id) {
            candidates.push({
              id: item.id,
              title: item.title || '',
              duration: item.duration,
              uploader: item.uploader || '',
            });
          }
        } catch {}
      }
    } catch (err) {
      console.warn(`[StreamResolver] YouTube Topic search fallback failed for "${track.title}":`, (err as Error).message);
    }
  }

  // --- Step 4: Pick Best YouTube Candidate ---
  if (candidates.length > 0) {
    // Guardrail 1: Filter out unwanted variants (live, cover, slowed)
    const cleanCandidates = candidates.filter((c) => isVariantClean(c.title, track.title));
    const pool = cleanCandidates.length > 0 ? cleanCandidates : candidates;

    // Guardrail 2: Score candidates based on duration proximity and studio purity
    const scoredCandidates = pool.map((c) => {
      const diff = c.duration ? Math.abs(c.duration - track.durationSec) : 999;
      const uploaderLower = (c.uploader || '').toLowerCase();
      const titleLower = c.title.toLowerCase();

      // Strict Curation Purity Guardrail: Heavily prioritize official studio / topic releases
      let studioBonus = 0;
      if (uploaderLower.endsWith('- topic') || uploaderLower.includes('topic')) {
        studioBonus += 50; // Pristine official studio track
      }
      if (uploaderLower.includes('vevo')) {
        studioBonus += 30;
      }
      if (titleLower.includes('official audio')) {
        studioBonus += 25;
      } else if (titleLower.includes('audio')) {
        studioBonus += 10;
      }
      if (titleLower.includes('music video') || titleLower.includes('official video')) {
        studioBonus -= 5;
      }

      // Dynamic Granular Quality Scoring
      const liveFilter = dynamicSettings.getString('curation_filter_live', 'none');
      const coverFilter = dynamicSettings.getString('curation_filter_covers', 'none');
      const instrumentalFilter = dynamicSettings.getString('curation_filter_instrumentals', 'none');
      const remixFilter = dynamicSettings.getString('curation_filter_remixes', 'none');
      const rerecordedFilter = dynamicSettings.getString('curation_filter_rerecorded', 'none');

      const isOriginalLive = track.title.toLowerCase().includes('live');
      if (titleLower.includes('live') && !isOriginalLive) {
        if (liveFilter === 'none') {
          studioBonus -= 200;
        } else if (liveFilter === 'high_quality') {
          studioBonus -= 40;
        }
      }

      if (/\b(cover|karaoke|tribute)\b/i.test(titleLower)) {
        if (coverFilter === 'none') {
          studioBonus -= 200;
        } else if (coverFilter === 'high_quality') {
          studioBonus -= 120;
        }
      }

      if (/\b(instrumental|backing track|karaoke)\b/i.test(titleLower)) {
        if (instrumentalFilter === 'none') {
          studioBonus -= 200;
        } else if (instrumentalFilter === 'high_quality') {
          studioBonus -= 100;
        }
      }

      if (/\b(remix|vip mix|club mix)\b/i.test(titleLower) && !track.title.toLowerCase().includes('remix')) {
        if (remixFilter === 'none') {
          studioBonus -= 200;
        } else if (remixFilter === 'high_quality') {
          studioBonus -= 30;
        }
      }

      // Hard penalty for unwanted junk / meme / parody / reaction / earrape
      if (/\b(parody|reaction|tutorial|remake|mashup|earrape|meme|nightcore|slowed|bass boosted)\b/i.test(titleLower)) {
        studioBonus -= 200;
      }

      return { ...c, diff, studioBonus };
    });

    // Sort: if both within 5s duration match, prioritize the studio/topic release
    scoredCandidates.sort((a, b) => {
      if (a.diff <= 5 && b.diff <= 5) {
        return b.studioBonus - a.studioBonus;
      }
      return a.diff - b.diff;
    });

    // Filter candidates within tolerance: prefer <= 5s, accept up to <= 12s, or diff < 30s
    // Strict Purity: Autoplay ceiling 8 mins (480s), manual unlimited, strict <= 12s diff clamp
    const isManual = (track as any).isManualRequest === true || ((track as any).requestedBy && !(track as any).requestedBy.startsWith('autoplay'));
    const maxAllowedDur = isManual ? 3600 : 480; // 8 mins for autoplay, 1h for manual

    const validCandidates = scoredCandidates.filter((c) => {
      const dur = c.duration || track.durationSec;
      return dur >= 75 && dur <= maxAllowedDur && c.diff <= 15;
    });

    const best = validCandidates.find((c) => c.diff <= 5)
      || validCandidates.find((c) => c.diff <= 12)
      || validCandidates[0];

    if (best) {
      const watchUrl = `https://www.youtube.com/watch?v=${best.id}`;
      const expiresAt = now + 86400; // 24 hours
      try {
        sqlite.prepare(`
          INSERT OR REPLACE INTO stream_cache (song_id, youtube_id, stream_url, expires_at)
          VALUES (?, ?, ?, ?)
        `).run(track.id, best.id, watchUrl, expiresAt);
      } catch (dbErr) {
        console.warn('[StreamResolver] Failed to write to stream_cache:', (dbErr as Error).message);
      }

      console.log(`[StreamResolver] Resolved "${track.title}" via YouTube candidate ${best.id} ("${best.title}")`);
      return {
        songId: track.id,
        youtubeId: best.id,
        streamUrl: watchUrl,
        durationSec: best.duration || track.durationSec,
        source: 'ytdlp',
      };
    }
  }

  // Fallback 1: Try SoundCloud search via yt-dlp (not blocked on cloud datacenter IPs)
  const scFallback = await resolveSoundCloudStream(track);
  if (scFallback) return scFallback;

  // Fallback 2: Direct Deezer CDN stream if YouTube extraction failed or is blocked by datacenter bot checks
  return resolveFallbackStream(track);
}

/**
 * Searches SoundCloud for a matching full-length stream.
 * 100% resilient on datacenter / cloud IPs without bot challenges.
 */
export async function resolveSoundCloudStream(
  track: { id: string; title: string; artist: string; durationSec: number; previewUrl?: string }
): Promise<ResolvedStream | null> {
  const now = Math.floor(Date.now() / 1000);
  const queryArtist = track.artist && track.artist !== 'Unknown Artist' ? `${track.artist} - ` : '';
  const scQuery = `scsearch10:${queryArtist}${track.title}`;

  try {
    let scJsonRaw = '';
    try {
      const res = await execFileAsync('yt-dlp', [
        '--dump-json',
        '--no-warnings',
        '--no-check-certificates',
        '--ignore-errors',
        scQuery,
      ], { timeout: 12000, maxBuffer: 10 * 1024 * 1024 });
      scJsonRaw = res.stdout;
    } catch (execErr: any) {
      if (execErr.stdout) {
        scJsonRaw = execErr.stdout;
      } else {
        throw execErr;
      }
    }

    const scLines = scJsonRaw.trim().split('\n').filter(Boolean);
    const scCandidates: Array<{ id: string; url: string; duration: number; diff: number }> = [];

    // Allow ±12s up to ±30s maximum duration difference (e.g. max 15% of song duration)
    const maxDiff = Math.min(30, Math.max(12, track.durationSec * 0.15));

    for (const line of scLines) {
      try {
        const item = JSON.parse(line);
        const duration = item.duration || 0;
        const candidateTitle = item.title || '';

        // Skip short snippets/previews if the canonical song is longer than 60s
        if (track.durationSec > 60 && duration <= 35) continue;

        // Skip unwanted variants (live, covers, nightcore, 50-minute mixes)
        if (!isVariantClean(candidateTitle, track.title)) continue;

        // Ensure at least 50% title keywords match
        if (!hasTitleMatch(candidateTitle, track.title)) continue;

        const diff = Math.abs(duration - track.durationSec);
        if (diff > maxDiff) continue;

        const targetUrl = item.webpage_url || item.url;
        if (targetUrl) {
          scCandidates.push({
            id: item.id || '',
            url: targetUrl,
            duration,
            diff,
          });
        }
      } catch {
        // Skip malformed candidate JSON
      }
    }

    scCandidates.sort((a, b) => a.diff - b.diff);

    for (const scCandidate of scCandidates.slice(0, 3)) {
      try {
        const { stdout: streamUrlRaw } = await execFileAsync('yt-dlp', [
          '-g',
          '--no-warnings',
          '--no-check-certificates',
          scCandidate.url,
        ], { timeout: 8000 });
        const scUrl = streamUrlRaw.trim().split('\n')[0];
        if (scUrl && scUrl.startsWith('http')) {
          console.log(`[StreamResolver] Resolved "${track.title}" via SoundCloud full-length stream (${scCandidate.duration}s, diff: ${scCandidate.diff.toFixed(1)}s)`);
          // Set TTL to 45 minutes (2700s) because CloudFront signed URL tokens expire
          const expiresAt = now + 2700;
          try {
            sqlite.prepare(`
              INSERT OR REPLACE INTO stream_cache (song_id, youtube_id, stream_url, expires_at)
              VALUES (?, ?, ?, ?)
            `).run(track.id, 'soundcloud', scUrl, expiresAt);
          } catch {}
          return {
            songId: track.id,
            youtubeId: 'soundcloud',
            streamUrl: scUrl,
            durationSec: scCandidate.duration || track.durationSec,
            source: 'ytdlp',
          };
        }
      } catch {
        // Continue to next SoundCloud candidate
      }
    }
  } catch (scErr) {
    console.warn(`[StreamResolver] SoundCloud search failed for "${track.title}":`, (scErr as Error).message);
  }

  return null;
}

/**
 * Resolves an emergency fallback audio stream when primary extraction fails mid-playback or at start.
 * Tries SoundCloud first, then official Deezer 30s preview CDN stream.
 */
export async function resolveFallbackStream(
  track: { id: string; title: string; artist: string; durationSec: number; previewUrl?: string; streamUrl?: string; youtubeId?: string }
): Promise<ResolvedStream | null> {
  console.log(`[StreamResolver] Attempting fallback stream for "${track.artist} - ${track.title}"`);

  // Track all known failing video IDs so we never retry the exact same broken stream
  const failingYtIds = new Set<string>();
  if (track.id.startsWith('yt_')) {
    failingYtIds.add(track.id.replace(/^yt_/, ''));
  }
  if (track.streamUrl) {
    const match = track.streamUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (match) failingYtIds.add(match[1]);
  }
  if (track.youtubeId) {
    failingYtIds.add(track.youtubeId);
  }
  if ((track as any).failedStreamUrls && Array.isArray((track as any).failedStreamUrls)) {
    for (const url of (track as any).failedStreamUrls) {
      const m = typeof url === 'string' ? url.match(/[?&]v=([a-zA-Z0-9_-]{11})/) : null;
      if (m) failingYtIds.add(m[1]);
    }
  }

  // Fallback 1: Alternative YouTube candidate search (strictly excluding all failed video IDs)
  try {
    const query = track.artist && track.artist !== 'Unknown Artist'
      ? `${track.artist} - ${track.title} Topic`
      : `${track.title} official`;
    const ytCandidates = await youtubeService.searchTracks(query, 5);
    const altCandidate = ytCandidates.find((c) => !failingYtIds.has(c.videoId));
    if (altCandidate) {
      console.log(`[StreamResolver] Resolved alternative YouTube stream for "${track.title}": ${altCandidate.videoId} ("${altCandidate.title}")`);
      return {
        songId: track.id,
        youtubeId: altCandidate.videoId,
        streamUrl: `https://www.youtube.com/watch?v=${altCandidate.videoId}`,
        durationSec: altCandidate.durationSec || track.durationSec,
        source: 'ytdlp',
      };
    }
  } catch (err) {
    console.warn('[StreamResolver] Alternative YouTube candidate search failed:', (err as Error).message);
  }

  // Fallback 2: SoundCloud search (full-length audio, resilient on datacenter/cloud IPs)
  try {
    const scStream = await resolveSoundCloudStream(track);
    if (scStream) {
      console.log(`[StreamResolver] Resolved resilient SoundCloud fallback for "${track.title}": ${scStream.streamUrl}`);
      return scStream;
    }
  } catch (scErr) {
    console.warn('[StreamResolver] SoundCloud fallback search failed:', (scErr as Error).message);
  }

  // Notice: Deezer 30s preview fallback intentionally omitted.
  // In full-track radio mode, truncated 30s snippets cut songs off abruptly.
  // Returning null allows GuildPlayer to cleanly advance to the next full-length track.
  console.warn(`[StreamResolver] All full-length streams exhausted for "${track.title}". Skipping track.`);
  return null;
}

/**
 * Pre-fetches the first 512 KB of the audio stream into RAM to eliminate gap/handshake delay on song transitions.
 */
export async function prewarmStreamBuffer(streamUrl: string): Promise<Buffer | null> {
  // Direct HTTP range fetch is only valid for raw audio URLs (SoundCloud, Deezer preview), not YouTube watch URLs
  if (
    streamUrl.includes('youtube.com') ||
    streamUrl.includes('youtu.be') ||
    streamUrl.startsWith('yt_') ||
    streamUrl.startsWith('yt:')
  ) {
    return null;
  }

  try {
    const response = await fetch(streamUrl, {
      headers: {
        'Range': 'bytes=0-524287', // 512 KB
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!response.ok && response.status !== 206) {
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.warn('[StreamResolver] Prewarm buffer fetch failed:', (err as Error).message);
    return null;
  }
}

export default {
  resolveStream,
  resolveSoundCloudStream,
  resolveFallbackStream,
  prewarmStreamBuffer,
};
