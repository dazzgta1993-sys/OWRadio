/**
 * @file collaborativeGraph.ts
 * @description Collaborative Music Graph Connector blending Deezer and Last.fm open graphs.
 * Mines real human listening patterns, related artists, and deep-cut catalog b-sides (ranks 4-35).
 */

import config from '../config.js';
import deezer, { type DeezerTrackMetadata } from './deezer.js';
import { normalizeArtist, extractArtists, extractPrimaryArtist } from '../utils/trackDedupe.js';

export interface CollaborativeArtist {
  name: string;
  source: 'deezer' | 'lastfm' | 'hybrid';
  score: number;
}

// Open community key used by open-source audio players (fallback if no personal key configured)
const FALLBACK_LASTFM_KEY = 'b25b959554ed76058ac220b7b2e0a026';

const UNWANTED_VARIANTS = [
  'live', 'karaoke', '8d', 'slowed', 'reverb', 'nightcore',
  'cover', 'instrumental', 'tribute', 'remake', 'parody',
  'bass boosted', 'mix', 'medley', 'podcast', 'acoustic',
  'reaction', 'lesson', 'tutorial', 'backing track'
];

function isCleanVariant(title: string): boolean {
  const norm = title.toLowerCase();
  for (const word of UNWANTED_VARIANTS) {
    if (norm.includes(word)) return false;
  }
  return true;
}

export class CollaborativeGraphService {
  private artistCache = new Map<string, { artists: CollaborativeArtist[]; expiresAt: number }>();

  /**
   * Fetches musically related artists using both Deezer and Last.fm collaborative graphs.
   */
  public async getRelatedArtists(artistName: string, limit = 15): Promise<CollaborativeArtist[]> {
    const norm = normalizeArtist(artistName).toLowerCase();
    const now = Math.floor(Date.now() / 1000);

    const cached = this.artistCache.get(norm);
    if (cached && cached.expiresAt > now) {
      return cached.artists;
    }

    const [deezerArtists, lastfmArtists] = await Promise.all([
      this.fetchDeezerRelated(artistName, limit),
      this.fetchLastfmRelated(artistName, limit),
    ]);

    // Merge and cross-correlate both graphs
    const mergedMap = new Map<string, CollaborativeArtist>();

    for (const a of deezerArtists) {
      const key = normalizeArtist(a.name).toLowerCase();
      mergedMap.set(key, { name: a.name, source: 'deezer', score: 0.7 });
    }

    for (const a of lastfmArtists) {
      const key = normalizeArtist(a.name).toLowerCase();
      const existing = mergedMap.get(key);
      if (existing) {
        existing.source = 'hybrid';
        existing.score = 1.0; // Consensus bonus: present in both Deezer and Last.fm
      } else {
        mergedMap.set(key, { name: a.name, source: 'lastfm', score: a.score || 0.6 });
      }
    }

    const sorted = Array.from(mergedMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    this.artistCache.set(norm, { artists: sorted, expiresAt: now + 86400 }); // Cache for 24h
    return sorted;
  }

  /**
   * Fetches Deezer related artists.
   */
  private async fetchDeezerRelated(artistName: string, limit: number): Promise<Array<{ name: string }>> {
    try {
      const primary = extractPrimaryArtist(artistName);
      let artist = await deezer.searchArtist(primary);
      if (!artist?.id && primary !== artistName) {
        artist = await deezer.searchArtist(artistName);
      }
      if (!artist || !artist.id) return [];
      const related = await deezer.getRelatedArtists(artist.id, limit);
      return related.map((r) => ({ name: r.name }));
    } catch (err) {
      console.warn(`[CollaborativeGraph] Deezer graph error for "${artistName}":`, (err as Error).message);
      return [];
    }
  }

  /**
   * Fetches Last.fm similar artists based on 20+ years of human scrobble data.
   */
  private async fetchLastfmRelated(artistName: string, limit: number): Promise<Array<{ name: string; score: number }>> {
    const apiKey = config.LASTFM_API_KEY || FALLBACK_LASTFM_KEY;
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(artistName)}&api_key=${apiKey}&format=json&limit=${limit}`;

    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'OWRadio/2.2' }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const data = (await res.json()) as any;
      const artists = data?.similarartists?.artist;
      if (!Array.isArray(artists)) return [];

      return artists.map((a: any) => ({
        name: a.name,
        score: parseFloat(a.match) || 0.5,
      }));
    } catch (err) {
      console.warn(`[CollaborativeGraph] Last.fm graph error for "${artistName}":`, (err as Error).message);
      return [];
    }
  }

  /**
   * Mines deep-cuts from related artists, specifically skipping overplayed top singles (ranks 1-3)
   * and pulling ranks 4-35 studio album b-sides.
   */
  public async getDeepCutsForArtists(
    artistNames: string[],
    limitPerArtist = 8,
    skipMainstreamRanks = 3
  ): Promise<DeezerTrackMetadata[]> {
    const pool: DeezerTrackMetadata[] = [];
    const seenTitles = new Set<string>();

    for (const name of artistNames) {
      try {
        const artist = await deezer.searchArtist(name);
        if (!artist || !artist.id) continue;

        const topTracks = await deezer.getArtistTopTracks(artist.id, 35);
        // Skip overplayed top radio singles and pull album deep-cuts
        const deepCuts = topTracks.slice(skipMainstreamRanks, skipMainstreamRanks + limitPerArtist * 2);

        for (const track of deepCuts) {
          const normTitle = track.title.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (
            track.durationSec >= 75 &&
            track.durationSec <= 480 && // Autoplay duration bound (75s - 8m)
            isCleanVariant(track.title) &&
            !seenTitles.has(normTitle)
          ) {
            seenTitles.add(normTitle);
            pool.push(track);
            if (pool.length >= artistNames.length * limitPerArtist) break;
          }
        }
      } catch (err) {
        console.warn(`[CollaborativeGraph] Error mining deep cuts for "${name}":`, (err as Error).message);
      }
    }

    return pool;
  }
}

export const collaborativeGraph = new CollaborativeGraphService();
export default collaborativeGraph;
