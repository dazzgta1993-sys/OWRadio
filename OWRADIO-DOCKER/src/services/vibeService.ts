/**
 * @file vibeService.ts
 * @description 4-Pillar native vibe playlist generator that resolves natural language vibe prompts
 * (e.g. "80s synthwave", "lofi chill study", "french electro", "daft punk style")
 * into verified diverse tracks across Deezer, MusicBrainz, YouTube Music, and YouTube.
 */

import deezer from './deezer.js';
import youtube from './youtube.js';
import musicbrainz from './musicbrainz.js';
import { normalizeArtist, normalizeTrackTitle } from '../utils/trackDedupe.js';

export interface VibeItem {
  artist: string;
  title: string;
  reason?: string;
}

/**
 * Resolves a natural language vibe prompt into a list of verified, distinct-artist tracks.
 */
export async function generateVibePlaylist(userPrompt: string, count = 6): Promise<VibeItem[]> {
  const cleanPrompt = userPrompt.trim();
  if (!cleanPrompt) return [];

  const items: VibeItem[] = [];
  const seenArtists = new Set<string>();
  const seenTitles = new Set<string>();

  const tryAddTrack = (artist: string, title: string, source: string): boolean => {
    const normA = normalizeArtist(artist).replace(/\s+/g, '');
    const normT = normalizeTrackTitle(title, artist);
    if (!normA || !normT || seenArtists.has(normA) || seenTitles.has(normT)) return false;

    seenArtists.add(normA);
    seenTitles.add(normT);
    items.push({
      artist,
      title,
      reason: `Matches vibe "${cleanPrompt}" (${source})`,
    });
    return true;
  };

  // Pillar 1: Deezer Catalog & Genre Search (lossless metadata & global popularity)
  try {
    const deezerResults = await deezer.searchTracks(cleanPrompt, count * 3);
    for (const t of deezerResults) {
      tryAddTrack(t.artist, t.title, 'Deezer');
      if (items.length >= count) break;
    }
  } catch (err) {
    console.warn('[VibeService] Deezer vibe search warning:', (err as Error).message);
  }

  // Pillar 2: YouTube Music (Official Studio Audio & Topic releases)
  if (items.length < count) {
    try {
      const needed = count - items.length;
      const ytmResults = await youtube.searchYouTubeMusic(cleanPrompt, needed * 2);
      for (const y of ytmResults) {
        tryAddTrack(y.artist, y.title, 'YouTube Music');
        if (items.length >= count) break;
      }
    } catch (err) {
      console.warn('[VibeService] YouTube Music vibe search warning:', (err as Error).message);
    }
  }

  // Pillar 3: MusicBrainz Encyclopedia (Official Discography & Recording verification)
  if (items.length < count) {
    try {
      const needed = count - items.length;
      const mbResults = await musicbrainz.searchRecordings(cleanPrompt, needed * 2);
      for (const m of mbResults) {
        tryAddTrack(m.artist, m.title, 'MusicBrainz');
        if (items.length >= count) break;
      }
    } catch (err) {
      console.warn('[VibeService] MusicBrainz search warning:', (err as Error).message);
    }
  }

  // Pillar 4: Standard YouTube (Catch-all for rare/indie tracks)
  if (items.length < count) {
    try {
      const needed = count - items.length;
      const ytResults = await youtube.searchTracks(`${cleanPrompt} music`, needed * 2);
      for (const y of ytResults) {
        tryAddTrack(y.artist, y.title, 'YouTube');
        if (items.length >= count) break;
      }
    } catch (err) {
      console.warn('[VibeService] Standard YouTube search warning:', (err as Error).message);
    }
  }

  return items;
}

export default {
  generateVibePlaylist,
};
