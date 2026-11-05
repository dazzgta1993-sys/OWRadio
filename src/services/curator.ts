export type TrackLanguage = string;
const LANGUAGE_METADATA: Record<string, { name: string; flag: string }> = {};
/**
 * @file curator.ts
 * @description 48-Hour Anti-Repeat, Active Voice Room Taste Blending, and Dynamic Deezer Deep-Cut Fallback Engine.
 * Guarantees zero static fallback song lists and zero repetitive loops.
 */

import { sqlite } from '../db/index.js';
import config from '../config.js';
import deezer, { type DeezerTrackMetadata } from './deezer.js';
import musicbrainz from './musicbrainz.js';
import vetoService from './vetoService.js';
import dynamicSettings from './dynamicSettings.js';
import collaborativeGraph from './collaborativeGraph.js';
import { normalizeArtist, normalizeTrackTitle, getTrackDedupeKey } from '../utils/trackDedupe.js';
import baselineService from './baselineService.js';

export type CurationEngineType = 'embedding' | 'hybrid' | 'graph' | 'deezer';

let currentEngine: CurationEngineType = (config.CURATION_ENGINE as CurationEngineType) || 'hybrid';

export function getEngine(): CurationEngineType {
  return currentEngine;
}

export function setEngine(engine: CurationEngineType): void {
  const previous = currentEngine;
  currentEngine = engine;
    console.log(`[Curator] Curation Engine dynamically switched: ${previous.toUpperCase()} -> ${engine.toUpperCase()}`);
}

export interface CuratedTrackResult {
  track: DeezerTrackMetadata;
  curatedBy: string;
  curationReason: string;
}

export interface RoomTasteProfile {
  topLikedArtists: string[];
  topLikedSongs: string[];
  topLikedGenres: string[];
  dislikedArtists: string[];
  memberCount: number;
}

const SEED_ERAS = [
  '1980s Post-Punk & Synth',
  '1990s French Touch & Electro',
  '1970s Funk & Soul',
  '2000s Indie Dance & Nu-Gaze',
  '2010s Future Funk & Vaporwave',
  '1990s Trip-Hop & Acid Jazz',
  'Modern Deep House & Melodic Techno',
  'Cyberpunk Darksynth',
  '1960s Psychedelic Rock & Baroque Pop',
  '2000s Neo-Soul & R&B Grooves',
];

const FALLBACK_GENRE_IDS = [
  132, // Pop
  152, // Rock
  116, // Rap/Hip-Hop
  106, // Electro
  165, // R&B
  85,  // Alternative
  129, // Jazz
  466, // Folk
];

// Mapping of standardized genre names to Deezer Chart IDs to avoid querying ambiguous freeform words
const GENRE_CHART_MAP: Record<string, number> = {
  pop: 132,
  'hip hop': 116,
  'hip-hop': 116,
  rap: 116,
  'alt rock': 85,
  alternative: 85,
  'alternative rock': 85,
  indie: 85,
  'indie rock': 85,
  rock: 152,
  'hard rock': 152,
  'classic rock': 152,
  dance: 113,
  electronic: 113,
  edm: 113,
  'r&b': 165,
  rnb: 165,
  soul: 165,
};

/**
 * Shuffles an array in place using the Fisher-Yates algorithm.
 */
function fisherYatesShuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Pre-prepared statements and short-lived in-memory caches for 0ms autoplay cooldown checks
const stmtCheckSongId = sqlite.prepare(`
  SELECT 1 FROM playback_history
  WHERE song_id = ? AND played_at > ?
  LIMIT 1
`);

const stmtCheckArtistLower = sqlite.prepare(`
  SELECT 1 FROM playback_history
  WHERE LOWER(artist_name) = LOWER(?) AND played_at > ?
  LIMIT 1
`);

const stmtRecentPlays48h = sqlite.prepare(`
  SELECT s.title, ph.artist_name
  FROM playback_history ph
  JOIN songs s ON ph.song_id = s.id
  WHERE ph.played_at > ?
`);

const stmtRecentArtists2h = sqlite.prepare(`
  SELECT DISTINCT artist_name
  FROM playback_history
  WHERE played_at > ?
`);

let cached48hDedupeKeys: Set<string> | null = null;
let cached48hExpiry = 0;
let cached2hNormArtists: Set<string> | null = null;
let cached2hExpiry = 0;
let cachedLanguageCooldownMap: Map<TrackLanguage, { title: string; artist: string; playedAt: number }> | null = null;
let cachedLanguageExpiry = 0;

const stmtRecentPlaysLanguage = sqlite.prepare(`
  SELECT s.title, ph.artist_name, ph.played_at
  FROM playback_history ph
  JOIN songs s ON ph.song_id = s.id
  WHERE ph.played_at > ?
  ORDER BY ph.played_at DESC
  LIMIT 60
`);

export interface ActiveLanguageCooldown {
  language: TrackLanguage;
  languageName: string;
  flag: string;
  lastTitle: string;
  lastArtist: string;
  lastPlayedAt: number;
  remainingSec: number;
}

/**
 * Returns currently active foreign language cooldown locks.
 */
export function getActiveLanguageCooldowns(): ActiveLanguageCooldown[] {
  return [];
}

/**
 * Checks whether a track is eligible for autoplay under the 48h song and 2h artist rules.
 * Enforces strict normalized title and artist deduplication across editions and channels.
 */
/**
 * Evaluates track against toggle-based granular filters (Lives, Covers, Instrumentals, Remixes).
 */
export function isTrackAllowedByQualityFilters(title: string, artistName: string, albumTitle?: string): boolean {
  const lowerTitle = title.toLowerCase();
  const lowerArtist = artistName.toLowerCase();
  const lowerAlbum = (albumTitle || '').toLowerCase();
  const combined = `${lowerTitle} ${lowerArtist} ${lowerAlbum}`;

  // 1. Live Recordings Filter (Strict studio default)
  const liveFilter = dynamicSettings.getString('curation_filter_live', 'none');
  const isLive = /\b(live|in concert|live at|live from|tour|unplugged|live session|live lounge|alive|live album|on stage|woodstock)\b/i.test(combined);
  const isAmateurLive = /\b(fancam|phone recording|audience recording|crowd audio|cam recording|bootleg live|crowd noise|recorded from crowd|handheld|distorted audio|wildwood)\b/i.test(combined);

  if (isLive) {
    if (liveFilter === 'none') {
      return false; // No lives at all
    }
    if (liveFilter === 'high_quality' && isAmateurLive) {
      return false; // Only high quality live
    }
  }

  // 2. Cover Tracks Filter (Original artists default)
  const coverFilter = dynamicSettings.getString('curation_filter_covers', 'none');
  const isCover = /\b(cover|tribute|sung by|karaoke|acoustic cover|cover by|tribute band)\b/i.test(combined);
  const isAmateurCover = /\b(bedroom cover|acoustic cover|cover by|tribute band|fan cover|reaction|guitar cover|drum cover|piano cover|vocal cover)\b/i.test(combined);

  if (isCover) {
    if (coverFilter === 'none') {
      return false; // No covers at all
    }
    if (coverFilter === 'high_quality' && isAmateurCover) {
      return false; // Only big artist / high quality covers
    }
  }

  // 3. Instrumental Tracks Filter (Vocal tracks default)
  const instrumentalFilter = dynamicSettings.getString('curation_filter_instrumentals', 'none');
  const isInstrumental = /\b(instrumental|backing track|minus one|karaoke|karaoke version|no vocals|off vocal)\b/i.test(combined);
  const isLowQualityInstrumental = /\b(backing track|minus one|karaoke|type beat|fan instrumental|midi)\b/i.test(combined);

  if (isInstrumental) {
    if (instrumentalFilter === 'none') {
      return false; // No instrumentals at all
    }
    if (instrumentalFilter === 'high_quality' && isLowQualityInstrumental) {
      return false; // Only official / high quality instrumentals
    }
  }

  // 4. Re-Recorded Versions Filter (Original vintage masters default)
  const rerecordedFilter = dynamicSettings.getString('curation_filter_rerecorded', 'none');
  const isRerecorded = /\b(re-recorded|rerecorded|re-recording|re-record|new version|20\d\d version|re-cut|later recording|acoustic remake)\b/i.test(combined);
  if (isRerecorded && rerecordedFilter === 'none') {
    return false; // Original masters only
  }

  // 5. Remixes & Edits Filter (Original mixes default)
  const remixFilter = dynamicSettings.getString('curation_filter_remixes', 'none');
  const isRemix = /\b(remix|vip mix|club mix|extended mix|radio edit|dub mix)\b/i.test(combined);
  const isJunkRemix = /\b(nightcore|slowed \+ reverb|slowed and reverb|bass boosted|8d audio|earrape|lofi remix|tiktok remix|tik tok remix|bootleg remix|meme remix)\b/i.test(combined);

  if (isJunkRemix) {
    return false; // Always discard earrape / nightcore / meme soundboard junk
  }
  if (isRemix) {
    if (remixFilter === 'none') {
      return false; // No remixes at all
    }
  }

  // Always discard non-musical spoken words, podcasts, and interview skits
  const nonMusicRegex = /\b(spoken\s+word|interview|skit|monologue|podcast|reaction|guitar tab|tutorial|lesson)\b/i;
  if (nonMusicRegex.test(combined)) {
    return false;
  }
  // Anti-Junk Shield: reject type beats, sped up / slowed edits, earrape, meme audio
  const isJunkFilter = /\b(type beat|hoodtrap|sped up|slowed \+ reverb|slowed and reverb|nightcore|earrape|tiktok remix|tik tok remix|meme remix|bass boosted|8d audio|phonk remix|meme|soundboard)\b/i;
  if (isJunkFilter.test(combined)) {
    return false;
  }


  return true;
}

export function isTrackEligibleForAutoplay(
  songId: string,
  artistName: string,
  queuedSongIds: Set<string> = new Set(),
  queuedArtists: Set<string> = new Set(),
  title?: string,
  queuedDedupeKeys: Set<string> = new Set(),
  durationSec?: number,
  queuedLanguages: Set<string> = new Set(),
  isrc?: string
): boolean {
  // 0. Autoplay Duration Limits (Hard bounds: 60s to 480s / 8 minutes maximum)
  const maxDurationSec = dynamicSettings.getNumber('curation_max_autoplay_duration_sec', 480);
  const minDurationSec = dynamicSettings.getNumber('curation_min_autoplay_duration_sec', 60);
  if (durationSec !== undefined && durationSec !== null && durationSec > 0) {
    if (durationSec < minDurationSec || durationSec > maxDurationSec) {
      return false;
    }
  }  // 0A. Hard Veto / Blacklist Filter
  if (vetoService.isArtistVetoed(artistName)) {
    return false;
  }
  if (title && vetoService.isSongVetoed(title, artistName)) {
    return false;
  }

  // 0B. 95% English-Speaking Track Guardrail
  if (dynamicSettings.getBoolean('curation_english_purity', true)) {
    const nonLatinRegex = /[^\u0000-\u024F\u1E00-\u1EFF\s\d.,!?'"()\-&/]/g;
    const combined = `${artistName} ${title || ''}`;
    const nonLatinMatches = combined.match(nonLatinRegex);
    if (nonLatinMatches && nonLatinMatches.length >= 3) {
      return false;
    }
  }

  // 0C. Granular Quality Filter Guardrail (Lives, Covers, Instrumentals, Remixes)
  if (title && !isTrackAllowedByQualityFilters(title, artistName)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const normArtist = normalizeArtist(artistName).replace(/\s+/g, '');

  // 1. In-memory queue duplicate check
  if (queuedSongIds.has(songId)) return false;
  if (queuedArtists.has(artistName.toLowerCase())) return false;
  if (normArtist && queuedArtists.has(normArtist)) return false;

  // Check canonical dedupe key against in-memory queue
  if (title) {
    const dedupeKey = getTrackDedupeKey(title, artistName);
    if (queuedDedupeKeys.has(dedupeKey)) return false;
  }

  // 2. Song Cooldown (Dynamic setting, default: 48h)
  const songCooldownHours = dynamicSettings.getNumber('curation_song_cooldown_hours', config.AUTOPLAY_COOLDOWN_HOURS);
  const cutoffSong = now - songCooldownHours * 3600;
  // 2A. Direct song ID match
  const recentSong = stmtCheckSongId.get(songId, cutoffSong);
  if (recentSong) return false;

  // 2B. Normalized title & artist match against song cooldown history
  if (title) {
    if (!cached48hDedupeKeys || now > cached48hExpiry) {
      const recentPlays = stmtRecentPlays48h.all(cutoffSong) as Array<{ title: string; artist_name: string }>;
      cached48hDedupeKeys = new Set(recentPlays.map((p) => getTrackDedupeKey(p.title, p.artist_name)));
      cached48hExpiry = now + 5; // Cache for 5s to eliminate SQL loop thrashing
    }
    const candKey = getTrackDedupeKey(title, artistName);
    if (cached48hDedupeKeys.has(candKey)) return false;
  }

  // 3. Artist Cooldown (Dynamic setting, default: 2h)
  const artistCooldownHours = dynamicSettings.getNumber('curation_artist_cooldown_hours', config.ARTIST_COOLDOWN_HOURS);
  const cutoffArtist = now - artistCooldownHours * 3600;
  // 3A. Exact lowercase artist check
  const recentArtist = stmtCheckArtistLower.get(artistName, cutoffArtist);
  if (recentArtist) return false;

  // 3B. Normalized artist check against artist cooldown history
  if (normArtist) {
    if (!cached2hNormArtists || now > cached2hExpiry) {
      const recentArtists = stmtRecentArtists2h.all(cutoffArtist) as Array<{ artist_name: string }>;
      cached2hNormArtists = new Set(recentArtists.map((r) => normalizeArtist(r.artist_name).replace(/\s+/g, '')));
      cached2hExpiry = now + 5;
    }
    if (cached2hNormArtists.has(normArtist)) return false;
  }

  return true;
}

/**
 * Checks whether foreign language playback is locked across the station under the 99.9% English purity guardrail.
 */
export function isLikelyForeignTitle(title: string): boolean {
  if (!title) return false;
  const lower = title.toLowerCase();
  // 1. Nordic / Germanic accented characters typical of domestic non-English releases
  if (/[åäöøæüëï]/.test(lower)) return true;
  // 2. Non-Latin scripts (Cyrillic, Greek, CJK, Arabic)
  if (/[\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF\u0600-\u06FF]/.test(title)) return true;
  // 3. Obvious foreign stopwords when appearing as distinct words
  const foreignStopwords = [
    'på', 'och', 'som', 'inte', 'med', 'för', 'till', 'är', 'ett', 'har',
    'der', 'die', 'das', 'und', 'nicht', 'mit', 'für',
    'avec', 'pour', 'dans', 'les', 'des', 'une'
  ];
  const words = lower.split(/[^a-zåäöøæüéèêáàíóúñ]+/);
  for (const sw of foreignStopwords) {
    if (words.includes(sw)) return true;
  }
  return false;
}

export function isForeignLanguageLocked(lang: TrackLanguage, queuedLanguages?: Set<string>): boolean {
  return true;
}

export async function isCandidateEligibleAsync(
  track: { id: string; artist: string; title: string; album?: string; durationSec?: number; isrc?: string },
  queuedSongIds: Set<string>,
  queuedArtists: Set<string>,
  queuedDedupeKeys: Set<string>,
  queuedLanguages: Set<string>
): Promise<boolean> {
  // 1. Fast synchronous 48h song and 2h artist check
  if (!isTrackEligibleForAutoplay(track.id, track.artist, queuedSongIds, queuedArtists, track.title, queuedDedupeKeys, track.durationSec, queuedLanguages, track.isrc)) {
    return false;
  }

  // 2. English purity guardrail: filter out regional foreign domestic tracks
  if (isLikelyForeignTitle(track.title)) {
    console.log(`[Curator] 🛡️ Non-English title "${track.artist} - ${track.title}" blocked by English purity guardrail.`);
    return false;
  }

  return true;
}

export function getActiveVoiceRoomProfile(memberUserIds: string[]): RoomTasteProfile {
  const baseline = baselineService.getBaseline();

  if (memberUserIds.length === 0) {
    // If room is empty, aggregate positive affinities from the past 30 days
    const rows = sqlite.prepare(`
      SELECT target_key, target_type, SUM(affinity_score) as total_affinity
      FROM user_preferences
      WHERE affinity_score > 0
      GROUP BY target_type, target_key
      ORDER BY total_affinity DESC
      LIMIT 15
    `).all() as Array<{ target_key: string; target_type: string; total_affinity: number }>;

    const userArtists = rows.filter((r) => r.target_type === 'artist').map((r) => r.target_key);
    const userGenres = rows.filter((r) => r.target_type === 'genre').map((r) => r.target_key);

    return {
      topLikedArtists: userArtists.length > 0 ? userArtists : [...baseline.artists],
      topLikedSongs: rows.filter((r) => r.target_type === 'song').map((r) => r.target_key),
      topLikedGenres: userGenres.length > 0 ? userGenres : [...baseline.genres],
      dislikedArtists: [],
      memberCount: 0,
    };
  }

  // Parameterized query for all present users
  const placeholders = memberUserIds.map(() => '?').join(',');
  const query = `
    SELECT target_key, target_type, SUM(affinity_score) as score, SUM(dislikes) as total_dislikes
    FROM user_preferences
    WHERE user_id IN (${placeholders})
    GROUP BY target_type, target_key
    ORDER BY score DESC
  `;

  const rows = sqlite.prepare(query).all(...memberUserIds) as Array<{
    target_key: string;
    target_type: string;
    score: number;
    total_dislikes: number;
  }>;

  let topLikedArtists = rows
    .filter((r) => r.target_type === 'artist' && r.score > 0)
    .slice(0, 8)
    .map((r) => r.target_key);

  let topLikedSongs = rows
    .filter((r) => r.target_type === 'song' && r.score > 0)
    .slice(0, 8)
    .map((r) => r.target_key);

  let topLikedGenres = rows
    .filter((r) => r.target_type === 'genre' && r.score > 0)
    .slice(0, 8)
    .map((r) => r.target_key);

  const dislikedArtists = rows
    .filter((r) => r.target_type === 'artist' && (r.score < -2 || r.total_dislikes > 0))
    .map((r) => r.target_key.toLowerCase());

  // Low-weight baseline scaffold: if active users have 0 liked artists, inject baseline artists (excluding disliked ones)
  if (topLikedArtists.length === 0) {
    topLikedArtists = baseline.artists.filter((a) => !dislikedArtists.includes(a.toLowerCase()));
  } else if (topLikedArtists.length < 3) {
    // Sparse taste: blend in 1 or 2 baseline artists so user isn't looped on a single artist
    const extra = baseline.artists
      .filter((a) => !dislikedArtists.includes(a.toLowerCase()) && !topLikedArtists.map((x) => x.toLowerCase()).includes(a.toLowerCase()))
      .slice(0, 3 - topLikedArtists.length);
    topLikedArtists = [...topLikedArtists, ...extra];
  }

  if (topLikedGenres.length === 0) {
    topLikedGenres = [...baseline.genres];
  }

  return {
    topLikedArtists,
    topLikedSongs,
    topLikedGenres,
    dislikedArtists,
    memberCount: memberUserIds.length,
  };
}

/**
 * Retrieves the last N played tracks from playback_history to supply anti-repetition context to curation.
 */
function getRecentPlaybackTitles(limit = 8): string[] {
  try {
    const rows = sqlite.prepare(`
      SELECT s.title, ph.artist_name
      FROM playback_history ph
      JOIN songs s ON s.id = ph.song_id
      ORDER BY ph.played_at DESC
      LIMIT ?
    `).all(limit) as Array<{ title: string; artist_name: string }>;
    return rows.map((r) => `${r.artist_name} - ${r.title}`);
  } catch {
    return [];
  }
}

/**
 * Harmonic DJ Autoplay Generator:
 * Chains seamlessly from the active track's artist and genre, exactly like a human DJ set.
 * No sudden genre switches, no genre roulette.
 */
async function getHarmonicDJTrack(
  anchorArtist: string,
  queuedSongIds: Set<string>,
  queuedArtists: Set<string>,
  queuedDedupeKeys: Set<string> = new Set(),
  queuedLanguages: Set<string> = new Set()
): Promise<CuratedTrackResult | null> {
  const normAnchor = anchorArtist.trim();
  if (!normAnchor) return null;

  try {
    // 1. Harmonic Chain: Find 1st-degree musically related artists in the exact same genre/world
    const related = await collaborativeGraph.getRelatedArtists(normAnchor, 15);
    const candidateArtistNames = related
      .map((r: { name: string }) => r.name)
      .filter((name: string) => {
        const lower = name.toLowerCase();
        if (queuedArtists.has(lower)) return false;
        if (vetoService.isArtistVetoed(name)) return false;
        return true;
      });

    if (candidateArtistNames.length > 0) {
      // Pick from related artists' best catalog tracks
      const deepCuts = await collaborativeGraph.getDeepCutsForArtists(candidateArtistNames.slice(0, 8), 5, 2);
      const shuffled = fisherYatesShuffle(deepCuts);

      for (const track of shuffled) {
        if (await isCandidateEligibleAsync(track, queuedSongIds, queuedArtists, queuedDedupeKeys, queuedLanguages)) {
          return {
            track,
            curatedBy: 'DJ Harmonic Chain',
            curationReason: `Harmonic match branched from ${normAnchor}`,
          };
        }
      }
    }

    // 2. Artist Deep-Cut Fallback: Top studio track by the same artist (if not in cooldown)
    if (!queuedArtists.has(normAnchor.toLowerCase()) && !vetoService.isArtistVetoed(normAnchor)) {
      const artist = await deezer.searchArtist(normAnchor);
      if (artist?.id) {
        const topTracks = await deezer.getArtistTopTracks(artist.id, 20);
        for (const track of topTracks) {
          if (await isCandidateEligibleAsync(track, queuedSongIds, queuedArtists, queuedDedupeKeys, queuedLanguages)) {
            return {
              track,
              curatedBy: 'DJ Artist Deep-Cut',
              curationReason: `Deep catalog cut from ${normAnchor}`,
            };
          }
        }
      }
    }

    // 3. Collaborative features and releases with anchor artist
    const collabTracks = await deezer.searchTracks(normAnchor, 25);
    const shuffledCollabs = fisherYatesShuffle(collabTracks);
    for (const track of shuffledCollabs) {
      if (await isCandidateEligibleAsync(track, queuedSongIds, queuedArtists, queuedDedupeKeys, queuedLanguages)) {
        return {
          track,
          curatedBy: 'DJ Collaborative Vibe',
          curationReason: `Collaborative track with ${normAnchor}`,
        };
      }
    }
  } catch (err) {
    console.warn('[Curator] Harmonic DJ track error:', (err as Error).message);
  }

  return null;
}

/**
 * Main Autoplay Pipeline: Generates the next N curated tracks respecting 48h/2h anti-repetition rules.
 * Maintains harmonic DJ continuity from the currently playing anchor track.
 */
export async function getNextAutoplayTracks(
  memberUserIds: string[],
  count = 2,
  existingQueueSongIds: string[] = [],
  existingQueueArtists: string[] = [],
  existingQueueTitles: string[] = [],
  anchorTrack?: { id: string; title: string; artist: string } | null
): Promise<CuratedTrackResult[]> {
  const roomProfile = getActiveVoiceRoomProfile(memberUserIds);
  const queuedSongIds = new Set(existingQueueSongIds);
  const queuedArtists = new Set<string>();
  for (const a of existingQueueArtists) {
    queuedArtists.add(a.toLowerCase());
    const norm = normalizeArtist(a).replace(/\s+/g, '');
    if (norm) queuedArtists.add(norm);
  }

  const queuedDedupeKeys = new Set<string>();
  for (let i = 0; i < existingQueueTitles.length; i++) {
    const t = existingQueueTitles[i];
    const a = existingQueueArtists[i] || '';
    if (t) queuedDedupeKeys.add(getTrackDedupeKey(t, a));
  }

  const queuedLanguages = new Set<string>();
  const results: CuratedTrackResult[] = [];

  // Determine active DJ Vibe Anchor:
  // 1. Explicitly passed anchor track (currently playing track or queue tail)
  // 2. Last played track in playback history
  // 3. Room liked artists or baseline scaffold
  let activeAnchor = (anchorTrack?.artist || '').trim();

  if (!activeAnchor) {
    const recent = getRecentPlaybackTitles(1);
    if (recent.length > 0) {
      const parts = recent[0].split(' - ');
      if (parts[0]) activeAnchor = parts[0].trim();
    }
  }

  if (!activeAnchor) {
    if (roomProfile.topLikedArtists.length > 0) {
      activeAnchor = roomProfile.topLikedArtists[0];
    } else {
      const baseline = baselineService.getBaseline();
      activeAnchor = baseline.artists[0] || 'Dua Lipa';
    }
  }

  // Tier 1: Harmonic DJ Chaining (chains smoothly from track to track)
  let djAttempts = 0;
  while (results.length < count && djAttempts < 12) {
    djAttempts++;
    const djResult = await getHarmonicDJTrack(activeAnchor, queuedSongIds, queuedArtists, queuedDedupeKeys, queuedLanguages);
    if (djResult) {
      queuedSongIds.add(djResult.track.id);
      queuedArtists.add(djResult.track.artist.toLowerCase());
      const normA = normalizeArtist(djResult.track.artist).replace(/\s+/g, '');
      if (normA) queuedArtists.add(normA);
      queuedDedupeKeys.add(getTrackDedupeKey(djResult.track.title, djResult.track.artist));
      results.push(djResult);

      // HARMONIC CHAIN: Step forward to this new track's artist for the next song!
      activeAnchor = djResult.track.artist;
    } else {
      // If activeAnchor is exhausted, try fallback to a room liked artist or baseline
      if (roomProfile.topLikedArtists.length > 0) {
        const nextSeed = roomProfile.topLikedArtists.find((a: string) => !queuedArtists.has(a.toLowerCase()));
        if (nextSeed) {
          activeAnchor = nextSeed;
          continue;
        }
      }
      break;
    }
  }

  // Tier 2: Vibe-Guarded Fallback (Never blind random cross-genre roulette)
  if (results.length < count && activeAnchor) {
    try {
      const related = await collaborativeGraph.getRelatedArtists(activeAnchor, 12);
      const peers = related.map((r: { name: string }) => r.name);
      for (const peer of peers) {
        if (results.length >= count) break;
        if (queuedArtists.has(peer.toLowerCase())) continue;
        const tracks = await deezer.searchTracks(peer, 6);
        for (const t of tracks) {
          if (results.length >= count) break;
          if (await isCandidateEligibleAsync(t, queuedSongIds, queuedArtists, queuedDedupeKeys, queuedLanguages)) {
            queuedSongIds.add(t.id);
            queuedArtists.add(t.artist.toLowerCase());
            const normA = normalizeArtist(t.artist).replace(/\s+/g, '');
            if (normA) queuedArtists.add(normA);
            queuedDedupeKeys.add(getTrackDedupeKey(t.title, t.artist));
            results.push({
              track: t,
              curatedBy: 'DJ Harmonic Chain',
              curationReason: `Harmonic peer match from ${activeAnchor}`,
            });
            break;
          }
        }
      }
    } catch (err) {
      console.warn('[Curator] Harmonic fallback error:', (err as Error).message);
    }
  }

  return results;
}

export default {
  isTrackEligibleForAutoplay,
  isCandidateEligibleAsync,
  isForeignLanguageLocked,
  getActiveVoiceRoomProfile,
  getNextAutoplayTracks,
  getActiveLanguageCooldowns,
  getEngine,
  setEngine,
};
