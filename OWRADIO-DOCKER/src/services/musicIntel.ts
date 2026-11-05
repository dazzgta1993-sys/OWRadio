/**
 * @file musicIntel.ts
 * @description Advanced Music Intelligence Service.
 * Combines dynamic database taste mining, live Deezer artist graphs, Wikipedia metadata,
 * and live web search trends to feed rich, sophisticated intelligence into LLM curation.
 */

import { sqlite } from '../db/index.js';
import deezer from './deezer.js';

export interface ListenerTasteDossier {
  userId: string;
  displayName: string;
  topArtists: Array<{ name: string; score: number; sampleTracks?: string[] }>;
  dormantFavorites: string[];
  dislikedArtists: string[];
}

export interface SessionTrajectory {
  recentTracks: Array<{
    title: string;
    artist: string;
    album?: string;
    releaseYear?: number;
    playedAt: number;
  }>;
  genreVibe: string;
}

export interface LiveMusicIntel {
  seedEra: string;
  adjacentArtists: string[];
  liveTrends: string[];
  artistContexts: string[];
  eraStaples: string[];
}

/**
 * Searches the catalog or user preferences for real, verified sample tracks by an artist.
 */
export function getArtistSampleTracks(artistName: string): string[] {
  try {
    const rows = sqlite.prepare(`
      SELECT title FROM songs
      WHERE LOWER(artist) LIKE ?
      ORDER BY id DESC
      LIMIT 2
    `).all(`%${artistName.toLowerCase()}%`) as Array<{ title: string }>;

    if (rows.length > 0) {
      return rows.map((r) => r.title.replace(/\s*\(.*?\)\s*/g, '').trim()).filter(Boolean);
    }

    const prefSongs = sqlite.prepare(`
      SELECT display_name FROM user_preferences
      WHERE target_type = 'song' AND LOWER(display_name) LIKE ?
      LIMIT 2
    `).all(`%${artistName.toLowerCase()}%`) as Array<{ display_name: string }>;

    if (prefSongs.length > 0) {
      return prefSongs.map((r) => r.display_name.replace(/\s*\(.*?\)\s*/g, '').trim()).filter(Boolean);
    }
  } catch {}
  return [];
}

/**
 * Searches the live web for contemporary music trends, underground scene reports, and adjacent artists.
 */
export async function searchMusicWeb(query: string, maxResults = 3): Promise<string[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!response.ok) return [];

    const html = await response.text();
    const matches = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
    const snippets = matches
      .slice(0, maxResults)
      .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").trim())
      .filter((s) => s.length > 20);

    return snippets;
  } catch {
    return [];
  }
}

/**
 * Fetches Wikipedia brief summary for musical artists.
 */
export async function getWikipediaArtistExtract(artistName: string): Promise<string | null> {
  try {
    const slug = encodeURIComponent(artistName.replace(/\s+/g, '_'));
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'OWRadio/2.1.0 (music curation assistant)' },
      signal: AbortSignal.timeout(2500),
    });

    if (!response.ok) return null;
    const data = (await response.json()) as any;
    if (data.extract) {
      return data.extract.slice(0, 180) + '...';
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Mines database intelligence for all listeners currently active in the room.
 */
export function getActiveListenersDossier(activeUserIds: string[]): ListenerTasteDossier[] {
  if (activeUserIds.length === 0) {
    // If empty room, look at top global listeners from recent activity
    const topGlobal = sqlite.prepare(`
      SELECT p.user_id, COALESCE(u.display_name, u.username, 'Listener ' || SUBSTR(p.user_id, -4)) as user_name, p.target_key, p.affinity_score
      FROM user_preferences p
      LEFT JOIN users u ON u.id = p.user_id
      WHERE p.target_type = 'artist' AND p.affinity_score > 2.0
      ORDER BY p.affinity_score DESC
      LIMIT 15
    `).all() as Array<{ user_id: string; user_name: string; target_key: string; affinity_score: number }>;

    if (topGlobal.length === 0) return [];

    const grouped: Record<string, ListenerTasteDossier> = {};
    for (const row of topGlobal) {
      if (!grouped[row.user_id]) {
        grouped[row.user_id] = {
          userId: row.user_id,
          displayName: row.user_name,
          topArtists: [],
          dormantFavorites: [],
          dislikedArtists: [],
        };
      }
      if (grouped[row.user_id].topArtists.length < 4) {
        grouped[row.user_id].topArtists.push({
          name: row.target_key,
          score: row.affinity_score,
          sampleTracks: getArtistSampleTracks(row.target_key),
        });
      }
    }
    return Object.values(grouped).slice(0, 3);
  }

  const dossiers: ListenerTasteDossier[] = [];
  const now = Math.floor(Date.now() / 1000);
  const cutoff7Days = now - 7 * 86400;

  for (const uid of activeUserIds) {
    const userRow = sqlite.prepare('SELECT display_name, username FROM users WHERE id = ?').get(uid) as any;
    const displayName = userRow?.display_name || userRow?.username || `Listener ${uid.slice(-4)}`;

    const rows = sqlite.prepare(`
      SELECT target_key, affinity_score, likes, dislikes, full_plays
      FROM user_preferences
      WHERE user_id = ? AND target_type = 'artist'
      ORDER BY affinity_score DESC
    `).all(uid) as Array<{
      target_key: string;
      affinity_score: number;
      likes: number;
      dislikes: number;
      full_plays: number;
    }>;

    const topArtists = rows
      .filter((r) => r.affinity_score > 0)
      .slice(0, 4)
      .map((r) => ({
        name: r.target_key,
        score: r.affinity_score,
        sampleTracks: getArtistSampleTracks(r.target_key),
      }));

    const dislikedArtists = rows
      .filter((r) => r.affinity_score < -2.0 || r.dislikes > 0)
      .slice(0, 6)
      .map((r) => r.target_key);

    // Dormant favorites: top artists not played in playback_history for the last 7 days
    const dormantFavorites: string[] = [];
    for (const a of topArtists) {
      const recent = sqlite.prepare(`
        SELECT 1 FROM playback_history
        WHERE LOWER(artist_name) = LOWER(?) AND played_at > ?
        LIMIT 1
      `).get(a.name, cutoff7Days);

      if (!recent) {
        dormantFavorites.push(a.name);
      }
    }

    dossiers.push({
      userId: uid,
      displayName,
      topArtists,
      dormantFavorites: dormantFavorites.slice(0, 2),
      dislikedArtists,
    });
  }

  return dossiers;
}

/**
 * Gathers recent session trajectory (musical flow & narrative) from the last 4 played songs.
 */
export function getRecentSessionTrajectory(limit = 4): SessionTrajectory {
  try {
    const rows = sqlite.prepare(`
      SELECT s.title, ph.artist_name as artist, s.album, s.release_year as releaseYear, ph.played_at as playedAt
      FROM playback_history ph
      JOIN songs s ON s.id = ph.song_id
      ORDER BY ph.played_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      title: string;
      artist: string;
      album?: string;
      releaseYear?: number;
      playedAt: number;
    }>;

    return {
      recentTracks: rows.reverse(),
      genreVibe: rows.length > 0 ? `${rows[0].artist} era` : 'Fresh Session',
    };
  } catch {
    return { recentTracks: [], genreVibe: 'Eclectic' };
  }
}

/**
 * Gathers live external music intelligence (Deezer related artists, Wikipedia background, live web trends).
 */
export async function gatherLiveMusicIntel(
  seedEra: string,
  keyArtists: string[]
): Promise<LiveMusicIntel> {
  const adjacentArtists: Set<string> = new Set();
  const artistContexts: string[] = [];
  const liveTrends: string[] = [];

  // 1. Fetch related artist graph from Deezer for the top primary artist
  if (keyArtists.length > 0) {
    const primaryArtist = keyArtists[0];
    try {
      const artistMeta = await deezer.searchArtist(primaryArtist);
      const artistId = artistMeta?.id;
      if (artistId) {
        const related = await deezer.getRelatedArtists(artistId, 5);
        for (const r of related) {
          adjacentArtists.add(r.name);
        }
      }

      // Fetch brief Wikipedia context (capped to 110 chars)
      const wiki = await getWikipediaArtistExtract(primaryArtist);
      if (wiki) {
        artistContexts.push(`${primaryArtist}: ${wiki.slice(0, 110).trim()}`);
      }
    } catch (err) {
      console.warn('[MusicIntel] Deezer/Wiki live intel error:', (err as Error).message);
    }
  }

  // 2. Query DuckDuckGo web search for contemporary scene intel on the seed era
  try {
    const searchSnippets = await searchMusicWeb(`best underground albums artists ${seedEra}`, 1);
    for (const snip of searchSnippets) {
      const clean = snip.replace(/\s+/g, ' ').slice(0, 110).trim();
      if (clean) liveTrends.push(clean);
    }
  } catch (err) {
    console.warn('[MusicIntel] Web search error:', (err as Error).message);
  }

  // 3. Fetch real staple tracks for the seed era to guide wildcards
  const eraStaples: string[] = [];
  try {
    const eraTracks = await deezer.searchTracks(seedEra, 3);
    for (const t of eraTracks) {
      eraStaples.push(`${t.artist} - "${t.title}"`);
    }
  } catch (err) {
    console.warn('[MusicIntel] Era staples fetch error:', (err as Error).message);
  }

  return {
    seedEra,
    adjacentArtists: Array.from(adjacentArtists),
    liveTrends,
    artistContexts,
    eraStaples,
  };
}

export default {
  searchMusicWeb,
  getWikipediaArtistExtract,
  getActiveListenersDossier,
  getRecentSessionTrajectory,
  gatherLiveMusicIntel,
};
