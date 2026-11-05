/**
 * @file youtube.ts
 * @description YouTube service providing native video metadata extraction, playlist resolution,
 * candidate audio search, and high-bitrate Opus stream extraction via yt-dlp.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import config from '../config.js';

const execFileAsync = promisify(execFile);

export interface YouTubeTrackMetadata {
  /** Canonical VEXO ID: e.g. "yt_F6_BSFHaCDU" */
  id: string;
  /** Raw 11-character YouTube Video ID */
  videoId: string;
  /** Song / Video Title */
  title: string;
  /** Artist or Channel Name */
  artist: string;
  /** Track duration in seconds */
  durationSec: number;
  /** High-resolution artwork URL */
  artworkUrl: string;
  /** Low-overhead thumbnail artwork URL */
  artworkThumbUrl: string;
}

/**
 * Words that indicate alternative / non-studio versions.
 */
const UNWANTED_VARIANTS = [
  'live',
  'karaoke',
  '8d',
  'slowed',
  'reverb',
  'nightcore',
  'cover',
  'instrumental',
  'tribute',
  'remake',
  'parody',
  'bass boosted',
  'mix',
  'medley',
  'podcast',
  'full album',
  'drop b',
  'tuning',
  'guitar',
  'backing track',
  'acoustic',
  'tutorial',
  'lesson',
  'reaction',
];

/**
 * Checks if a candidate title contains unwanted variant keywords that aren't part of the canonical title.
 */
export function isVariantClean(candidateTitle: string, canonicalTitle: string): boolean {
  const normCandidate = candidateTitle.toLowerCase();
  const normCanonical = canonicalTitle.toLowerCase();

  for (const word of UNWANTED_VARIANTS) {
    if (normCandidate.includes(word) && !normCanonical.includes(word)) {
      return false;
    }
  }
  return true;
}

/**
 * Parses raw YouTube video title and channel/uploader into clean artist and track title.
 */
export function parseYouTubeTitle(rawTitle: string, uploader: string): { title: string; artist: string } {
  // Strip common YouTube fluff suffixes
  const cleanedTitle = rawTitle
    .replace(/\s*[\(\[](?:Official\s*(?:Music\s*)?(?:Video|Audio|Lyric\s*Video|Visualizer|HD|4K)?|Lyrics?|Remaster(?:ed)?(?:\s*\d{4})?|Music\s*Video)[\)\]]/gi, '')
    .trim();

  // Look for standard "Artist - Title" separators
  const parts = cleanedTitle.split(/\s*[-–—:]\s*/);
  if (parts.length >= 2 && parts[0].trim().length > 0 && parts[1].trim().length > 0) {
    return {
      artist: parts[0].trim(),
      title: parts.slice(1).join(' - ').trim(),
    };
  }

  // Fallback: use uploader (stripping "- Topic" and "VEVO")
  const cleanUploader = (uploader || 'Unknown Artist')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .trim();

  return {
    artist: cleanUploader || 'Unknown Artist',
    title: cleanedTitle || rawTitle,
  };
}

/**
 * Builds base arguments for yt-dlp executions including proxy and cookie options.
 */
function getBaseYtDlpArgs(): string[] {
  const args = ['--no-warnings', '--no-check-certificates'];
  if (config.YOUTUBE_PROXY) {
    args.push('--proxy', config.YOUTUBE_PROXY);
  }
  const cookiesPath = config.YOUTUBE_COOKIES_PATH || (existsSync(path.resolve(process.cwd(), 'cookies.txt')) ? path.resolve(process.cwd(), 'cookies.txt') : undefined);
  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
  }
  return args;
}

/**
 * Search YouTube Music directly for official studio tracks matching a query.
 */
export async function searchYouTubeMusic(query: string, limit = 5): Promise<YouTubeTrackMetadata[]> {
  const baseArgs = getBaseYtDlpArgs();
  const searchArg = `ytsearch${limit}:${query} Official Audio`;

  try {
    const { stdout } = await execFileAsync('yt-dlp', [
      ...baseArgs,
      '--dump-json',
      '--flat-playlist',
      '--default-search', 'ytsearch',
      searchArg,
    ], { timeout: 12000, maxBuffer: 10 * 1024 * 1024 });

    const lines = stdout.trim().split('\n').filter(Boolean);
    const results: YouTubeTrackMetadata[] = [];

    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (!item.id) continue;

        const duration = Number(item.duration) || 0;
        const rawTitle = item.title || 'Unknown Title';
        const uploader = item.uploader || item.channel || '';
        const { title, artist } = parseYouTubeTitle(rawTitle, uploader);

        results.push({
          id: `yt_${item.id}`,
          videoId: item.id,
          title,
          artist,
          durationSec: duration,
          artworkUrl: `https://i.ytimg.com/vi/${item.id}/maxresdefault.jpg`,
          artworkThumbUrl: `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
        });
      } catch {
        // Skip unparseable line
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Search tracks: tries YouTube Music (ytmsearch) for official studio audio first,
 * falling back to standard YouTube (ytsearch) for live or rare tracks.
 */
export async function searchTracks(query: string, limit = 5): Promise<YouTubeTrackMetadata[]> {
  // 1. Try YouTube Music first for official release quality
  const ytmResults = await searchYouTubeMusic(query, limit);
  if (ytmResults.length > 0) {
    return ytmResults;
  }

  // 2. Fallback to standard YouTube search
  const baseArgs = getBaseYtDlpArgs();
  const searchArg = `ytsearch${limit}:${query} Official Audio`;

  try {
    const { stdout } = await execFileAsync('yt-dlp', [
      ...baseArgs,
      '--dump-json',
      '--flat-playlist',
      '--default-search', 'ytsearch',
      searchArg,
    ], { timeout: 15000, maxBuffer: 10 * 1024 * 1024 });

    const lines = stdout.trim().split('\n').filter(Boolean);
    const results: YouTubeTrackMetadata[] = [];

    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (!item.id) continue;

        const duration = Number(item.duration) || 0;
        const rawTitle = item.title || 'Unknown Title';
        const uploader = item.uploader || item.channel || '';
        const { title, artist } = parseYouTubeTitle(rawTitle, uploader);

        results.push({
          id: `yt_${item.id}`,
          videoId: item.id,
          title,
          artist,
          durationSec: duration,
          artworkUrl: `https://i.ytimg.com/vi/${item.id}/maxresdefault.jpg`,
          artworkThumbUrl: `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
        });
      } catch {
        // Skip unparseable line
      }
    }

    return results;
  } catch (err) {
    console.warn(`[YouTube] Search failed for "${query}":`, (err as Error).message);
    return [];
  }
}

/**
 * Retrieve metadata for a single YouTube video by video ID or URL.
 */
export async function getTrack(videoIdOrUrl: string): Promise<YouTubeTrackMetadata | null> {
  const videoId = videoIdOrUrl.replace(/^yt_/, '').replace(/^https?:\/\/.*(?:watch\?v=|youtu\.be\/)/, '').split('&')[0];
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const baseArgs = getBaseYtDlpArgs();

  try {
    const { stdout } = await execFileAsync('yt-dlp', [
      ...baseArgs,
      '--dump-json',
      '--flat-playlist',
      url,
    ], { timeout: 10000 });

    const item = JSON.parse(stdout.trim().split('\n')[0]);
    if (!item.id) return null;

    const duration = Number(item.duration) || 0;
    const rawTitle = item.title || 'Unknown Title';
    const uploader = item.uploader || item.channel || '';
    const { title, artist } = parseYouTubeTitle(rawTitle, uploader);

    return {
      id: `yt_${item.id}`,
      videoId: item.id,
      title,
      artist,
      durationSec: duration,
      artworkUrl: `https://i.ytimg.com/vi/${item.id}/maxresdefault.jpg`,
      artworkThumbUrl: `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
    };
  } catch (err) {
    console.warn(`[YouTube] Failed to get video metadata for "${videoIdOrUrl}":`, (err as Error).message);
    return null;
  }
}

/**
 * Retrieve all tracks from a YouTube playlist (up to limit, default 50).
 */
export async function getPlaylistTracks(playlistIdOrUrl: string, limit = 50): Promise<YouTubeTrackMetadata[]> {
  const playlistId = playlistIdOrUrl.includes('list=')
    ? playlistIdOrUrl.split('list=')[1].split('&')[0]
    : playlistIdOrUrl;
  const url = `https://www.youtube.com/playlist?list=${playlistId}`;
  const baseArgs = getBaseYtDlpArgs();

  try {
    const { stdout } = await execFileAsync('yt-dlp', [
      ...baseArgs,
      '--flat-playlist',
      '--dump-json',
      '--playlist-items', `1-${limit}`,
      url,
    ], { timeout: 20000, maxBuffer: 15 * 1024 * 1024 });

    const lines = stdout.trim().split('\n').filter(Boolean);
    const tracks: YouTubeTrackMetadata[] = [];

    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (!item.id) continue;

        const duration = Number(item.duration) || 0;
        const rawTitle = item.title || 'Unknown Title';
        const uploader = item.uploader || item.channel || '';
        const { title, artist } = parseYouTubeTitle(rawTitle, uploader);

        tracks.push({
          id: `yt_${item.id}`,
          videoId: item.id,
          title,
          artist,
          durationSec: duration,
          artworkUrl: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
          artworkThumbUrl: `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
        });
      } catch {
        // Skip malformed candidate
      }
    }

    return tracks;
  } catch (err) {
    console.warn(`[YouTube] Failed to fetch playlist tracks for "${playlistIdOrUrl}":`, (err as Error).message);
    return [];
  }
}

/**
 * Extracts the direct Opus / bestaudio audio stream URL for a YouTube video.
 */
export async function getStreamUrl(videoId: string): Promise<string | null> {
  const cleanId = videoId.replace(/^yt_/, '');
  const url = `https://www.youtube.com/watch?v=${cleanId}`;
  const baseArgs = getBaseYtDlpArgs();

  try {
    const { stdout } = await execFileAsync('yt-dlp', [
      ...baseArgs,
      '-g',
      '-f', 'bestaudio[acodec=opus]/bestaudio',
      url,
    ], { timeout: 10000 });

    const streamUrl = stdout.trim().split('\n')[0];
    if (streamUrl && streamUrl.startsWith('http')) {
      return streamUrl;
    }
    return null;
  } catch (err) {
    console.warn(`[YouTube] Stream extraction failed for "${cleanId}":`, (err as Error).message);
    return null;
  }
}

export default {
  searchTracks,
  searchYouTubeMusic,
  getTrack,
  getPlaylistTracks,
  getStreamUrl,
  isVariantClean,
  parseYouTubeTitle,
};
