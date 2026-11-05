/**
 * @file curator.ts
 * @description 48-Hour Anti-Repeat, Active Voice Room Taste Blending, and Dynamic Deezer Deep-Cut Fallback Engine.
 * Guarantees zero static fallback song lists and zero repetitive loops.
 */

import { sqlite } from '../db/index.js';
import config from '../config.js';
import deezer, { type DeezerTrackMetadata } from './deezer.js';
import musicbrainz from './musicbrainz.js';
import vectorCurator from './vectorCurator.js';
import brainLogger from './brainLogger.js';
import stationCurator from './stationCurator.js';
import vetoService from './vetoService.js';
import featureFlags from './featureFlags.js';
import dynamicSettings from './dynamicSettings.js';
import collaborativeGraph from './collaborativeGraph.js';
import { normalizeArtist, normalizeTrackTitle, getTrackDedupeKey } from '../utils/trackDedupe.js';
import { detectTrackLanguage, detectTrackLanguageAsync, LANGUAGE_METADATA, type TrackLanguage } from './languageDetector.js';
import baselineService from './baselineService.js';

export type CurationEngineType = 'embedding' | 'hybrid' | 'graph' | 'deezer';

let currentEngine: CurationEngineType = (config.CURATION_ENGINE as CurationEngineType) || 'hybrid';

export function getEngine(): CurationEngineType {
  return currentEngine;
}

export function setEngine(engine: CurationEngineType): void {
  const previous = currentEngine;
  currentEngine = engine;
  brainLogger.logInteraction({
    timestamp: Math.floor(Date.now() / 1000),
    model: 'engine_switchboard',
    action: 'custom',
    prompt: `Operator switch curation engine: [${previous}] -> [${engine}]`,
    response: JSON.stringify({ previous, activeEngine: engine, timestamp: new Date().toISOString() }, null, 2),
    durationMs: 1,
    status: 'success',
    metadata: { previous, current: engine },
  });
  console.log(`[Curator] Curation Engine dynamically switched: ${previous.toUpperCase()} -> ${engine.toUpperCase()}`);
}

export interface CuratedTrackResult {
  track: DeezerTrackMetadata;
  curatedBy: 'AI Room Mix' | 'AI Wildcard' | 'JEPA Vector Latent' | 'Jev Decision Engine' | 'Dynamic Taste Deep-Cut' | 'Dynamic Era Roulette' | 'Dynamic Genre Explorer' | 'User Request';
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
export function getActiveLanguageCooldowns(cooldownMinutes?: number): ActiveLanguageCooldown[] {
  const mins = cooldownMinutes ?? dynamicSettings.getNumber('curation_language_cooldown_minutes', 1440);
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - mins * 60;

  const recent = stmtRecentPlaysLanguage.all(cutoff) as Array<{
    title: string;
    artist_name: string;
    played_at: number;
  }>;

  const result: ActiveLanguageCooldown[] = [];
  const seenLangs = new Set<TrackLanguage>();

  for (const row of recent) {
    const lang = detectTrackLanguage(row.title, row.artist_name);
    if (lang !== 'en' && !seenLangs.has(lang)) {
      seenLangs.add(lang);
      const meta = LANGUAGE_METADATA[lang] || { name: lang.toUpperCase(), flag: '🌍' };
      const remainingSec = Math.max(0, (row.played_at + mins * 60) - now);
      result.push({
        language: lang,
        languageName: meta.name,
        flag: meta.flag,
        lastTitle: row.title,
        lastArtist: row.artist_name,
        lastPlayedAt: row.played_at,
        remainingSec,
      });
    }
  }

  return result;
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

  // 4. Global Foreign Language Cooldown (Dynamic setting, default: 1440m / 24 hours)
  // Enforces max 1 foreign track per day across the entire station
  const langCooldownMinutes = dynamicSettings.getNumber('curation_language_cooldown_minutes', 1440);
  if (langCooldownMinutes > 0) {
    const trackLang = detectTrackLanguage(title || '', artistName, undefined, isrc, songId);
    if (trackLang !== 'en') {
      // 4A. In-memory queue check: no foreign song can enter if any foreign track is already queued
      if (queuedLanguages && queuedLanguages.size > 0) {
        return false;
      }

      // 4B. Playback history cooldown check: enforce maximum 1 foreign track per cooldown window across ALL languages
      const cutoffLang = now - langCooldownMinutes * 60;
      if (!cachedLanguageCooldownMap || now > cachedLanguageExpiry) {
        const recentPlays = stmtRecentPlaysLanguage.all(cutoffLang) as Array<{ title: string; artist_name: string; played_at: number }>;
        const freshMap = new Map<TrackLanguage, { title: string; artist: string; playedAt: number }>();
        for (const row of recentPlays) {
          const l = detectTrackLanguage(row.title, row.artist_name);
          if (l !== 'en' && !freshMap.has(l)) {
            freshMap.set(l, { title: row.title, artist: row.artist_name, playedAt: row.played_at });
          }
        }
        cachedLanguageCooldownMap = freshMap;
        cachedLanguageExpiry = now + 5; // Cache for 5s to eliminate SQL loop thrashing
      }

      // If ANY foreign language track has played within the cooldown window, block this candidate!
      if (cachedLanguageCooldownMap.size > 0) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Checks whether foreign language playback is locked across the station under the 99.9% English purity guardrail.
 */
export function isForeignLanguageLocked(lang: TrackLanguage, queuedLanguages?: Set<string>): boolean {
  if (lang === 'en') return false;
  if (queuedLanguages && queuedLanguages.size > 0) return true;

  const langCooldownMinutes = dynamicSettings.getNumber('curation_language_cooldown_minutes', 1440);
  if (langCooldownMinutes <= 0) return false;

  const now = Math.floor(Date.now() / 1000);
  const cutoffLang = now - langCooldownMinutes * 60;
  if (!cachedLanguageCooldownMap || now > cachedLanguageExpiry) {
    const recentPlays = stmtRecentPlaysLanguage.all(cutoffLang) as Array<{ title: string; artist_name: string; played_at: number }>;
    const freshMap = new Map<TrackLanguage, { title: string; artist: string; playedAt: number }>();
    for (const row of recentPlays) {
      const l = detectTrackLanguage(row.title, row.artist_name);
      if (l !== 'en' && !freshMap.has(l)) {
        freshMap.set(l, { title: row.title, artist: row.artist_name, playedAt: row.played_at });
      }
    }
    cachedLanguageCooldownMap = freshMap;
    cachedLanguageExpiry = now + 5;
  }
  return cachedLanguageCooldownMap.size > 0;
}

/**
 * Fully asynchronous candidate validator: runs 48h/2h filters + deep NLP lyrics/tag language screening.
 */
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

  // 2. High-Purity English verification via Last.fm tags + lyrics NLP
  const lang = await detectTrackLanguageAsync(track.title, track.artist, track.album, track.isrc, track.id);
  if (lang !== 'en') {
    if (isForeignLanguageLocked(lang, queuedLanguages)) {
      console.log(`[Curator] 🛑 Foreign track "${track.artist} - ${track.title}" (${lang}) blocked by 24h English purity guardrail.`);
      return false;
    }
  }
  return true;
}

/**
 * Aggregates preferences of active non-bot members currently present in the voice room.
 */
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
 * Dynamic Anti-Bubble Fallback Walk (used when LLM is offline or returns fewer than required tracks).
 * NEVER returns a static hardcoded track list.
 */
async function getDynamicFallbackTrack(
  roomProfile: RoomTasteProfile,
  queuedSongIds: Set<string>,
  queuedArtists: Set<string>,
  queuedDedupeKeys: Set<string> = new Set(),
  queuedLanguages: Set<string> = new Set()
): Promise<CuratedTrackResult | null> {
  const hasSeeds = roomProfile.topLikedArtists.length > 0;
  const rand = Math.random();

  // --- Bucket 1: Core Taste Anchor (20%) ---
  if (hasSeeds && rand < 0.20) {
    const seedArtist = roomProfile.topLikedArtists[Math.floor(Math.random() * roomProfile.topLikedArtists.length)];
    try {
      const artist = await deezer.searchArtist(seedArtist);
      const artistId = artist?.id;
      if (artistId) {
        const topTracks = await deezer.getArtistTopTracks(artistId, 15);
        for (const track of topTracks) {
          if (await isCandidateEligibleAsync(track, queuedSongIds, queuedArtists, queuedDedupeKeys, queuedLanguages)) {
            return {
              track,
              curatedBy: 'Dynamic Taste Deep-Cut',
              curationReason: `Core taste anchor: ${seedArtist}`,
            };
          }
        }
      }
    } catch (err) {
      console.warn('[Curator] Core anchor selection error:', (err as Error).message);
    }
  }

  // --- Bucket 2: 1st-Degree Collaborative Deep-Cuts (50%) ---
  if (hasSeeds && rand < 0.70) {
    const seedArtist = roomProfile.topLikedArtists[Math.floor(Math.random() * roomProfile.topLikedArtists.length)];
    try {
      const related = await collaborativeGraph.getRelatedArtists(seedArtist, 8);
      const relatedNames = related.map((r) => r.name);
      if (relatedNames.length > 0) {
        const deepCuts = await collaborativeGraph.getDeepCutsForArtists(relatedNames, 5, 3);
        const shuffled = fisherYatesShuffle(deepCuts);
        for (const track of shuffled) {
          if (await isCandidateEligibleAsync(track, queuedSongIds, queuedArtists, queuedDedupeKeys, queuedLanguages)) {
            return {
              track,
              curatedBy: 'Dynamic Taste Deep-Cut',
              curationReason: `Collaborative b-side branched from ${seedArtist}`,
            };
          }
        }
      }
    } catch (err) {
      console.warn('[Curator] Collaborative deep-cut error:', (err as Error).message);
    }
  }

  // --- Bucket 3: Preferred Genre Discovery or Vintage Circadian Vault (30%) ---
  try {
    const hasGenres = roomProfile.topLikedGenres && roomProfile.topLikedGenres.length > 0;
    // When listeners have active genre preferences, prioritize them with 70% probability
    const pickPreferredGenre = hasGenres && (Math.random() < 0.70 || !hasSeeds);

    let candidates: DeezerTrackMetadata[] = [];
    let reason = '';
    let curatedBy: CuratedTrackResult['curatedBy'] = 'Dynamic Era Roulette';

    if (pickPreferredGenre && roomProfile.topLikedGenres.length > 0) {
      const rawGenre = roomProfile.topLikedGenres[Math.floor(Math.random() * roomProfile.topLikedGenres.length)];
      const normGenre = rawGenre.toLowerCase().trim();
      const chartId = GENRE_CHART_MAP[normGenre];
      if (chartId) {
        candidates = await deezer.getRandomChartTracks(chartId, 40);
      } else {
        candidates = await deezer.searchTracks(`${rawGenre} hits classics`, 35);
      }
      reason = `Room genre preference: ${rawGenre.toUpperCase()}`;
      curatedBy = 'Dynamic Genre Explorer';
    } else {
      const rollType = Math.random() < 0.5 ? 'genre' : 'year';
      if (rollType === 'genre') {
        const genreId = FALLBACK_GENRE_IDS[Math.floor(Math.random() * FALLBACK_GENRE_IDS.length)];
        candidates = await deezer.getRandomChartTracks(genreId, 40);
        reason = 'Dynamic genre roulette exploration';
      } else {
        // Curate authentic vintage era without querying literal keyword "years"
        const vintageThemes = [
          { query: '70s classic rock hits', name: '70s Classic Rock' },
          { query: '70s soul funk classics', name: '70s Soul & Funk' },
          { query: '80s new wave synthpop', name: '80s Synthpop & New Wave' },
          { query: '80s classic pop anthems', name: '80s Pop Vault' },
          { query: '90s alternative rock', name: '90s Alternative' },
          { query: '90s grunge classics', name: '90s Grunge' },
          { query: '90s trip hop chill', name: '90s Trip Hop' },
          { query: '2000s indie rock', name: '2000s Indie' },
          { query: '2000s electronic classic', name: '2000s Electronic' },
          { query: '2010s indie pop hits', name: '2010s Indie Pop' },
        ];
        const theme = vintageThemes[Math.floor(Math.random() * vintageThemes.length)];
        candidates = await deezer.searchTracksRandomized(theme.query, 40, 200);
        reason = `Dynamic vintage vault (${theme.name})`;
      }
    }

    const shuffled = fisherYatesShuffle(candidates);
    for (const track of shuffled) {
      if (await isCandidateEligibleAsync(track, queuedSongIds, queuedArtists, queuedDedupeKeys, queuedLanguages)) {
        return {
          track,
          curatedBy,
          curationReason: reason,
        };
      }
    }
  } catch (err) {
    console.warn('[Curator] Dynamic roulette fallback error:', (err as Error).message);
  }

  // Last resort Deezer charts
  const englishGenreChartIds = [132, 152, 116, 165, 85]; // Pop, Rock, Rap, R&B, Alternative
  const selectedGenre = englishGenreChartIds[Math.floor(Math.random() * englishGenreChartIds.length)];
  const charts = await deezer.getRandomChartTracks(selectedGenre, 50);
  const shuffledCharts = fisherYatesShuffle(charts);
  for (const track of shuffledCharts) {
    if (await isCandidateEligibleAsync(track, queuedSongIds, queuedArtists, queuedDedupeKeys, queuedLanguages)) {
      return {
        track,
        curatedBy: 'Dynamic Era Roulette',
        curationReason: 'General eclectic discovery',
      };
    }
  }

  // --- Tier 4: Local SQLite Catalog Safety Net (Anti-Fatigue Bucket) ---
  try {
    const localCandidates = sqlite.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM playback_history h WHERE h.song_id = s.id) as play_count,
        (SELECT MAX(played_at) FROM playback_history h WHERE h.song_id = s.id) as last_played
      FROM songs s
      ORDER BY play_count ASC, last_played ASC, RANDOM()
      LIMIT 50
    `).all() as any[];

    for (const row of localCandidates) {
      if (await isCandidateEligibleAsync({ id: row.id, artist: row.artist, title: row.title, album: row.album, durationSec: row.duration_sec }, queuedSongIds, queuedArtists, queuedDedupeKeys, queuedLanguages)) {
        const metadata: DeezerTrackMetadata = {
          id: row.id,
          deezerId: row.deezer_id || row.id.replace(/^dz_/, ''),
          title: row.title,
          artist: row.artist,
          album: row.album || undefined,
          durationSec: row.duration_sec || 180,
          artworkUrl: row.artwork_url || '',
          artworkThumbUrl: row.artwork_thumb_url || '',
          genre: row.genre || undefined,
          releaseYear: row.release_year || undefined,
        };
        return {
          track: metadata,
          curatedBy: 'Dynamic Taste Deep-Cut',
          curationReason: row.play_count === 0 ? 'Local Catalog: Unplayed Deep Discovery' : 'Local Catalog: Anti-Fatigue Vault Selection',
        };
      }
    }
  } catch (err) {
    console.warn('[Curator] Local catalog fallback error:', (err as Error).message);
  }

  return null;
}

/**
 * Main Autoplay Pipeline: Generates the next N curated tracks respecting 48h/2h anti-repetition rules.
 */
export async function getNextAutoplayTracks(
  memberUserIds: string[],
  count = 2,
  existingQueueSongIds: string[] = [],
  existingQueueArtists: string[] = [],
  existingQueueTitles: string[] = []
): Promise<CuratedTrackResult[]> {
  const roomProfile = getActiveVoiceRoomProfile(memberUserIds);
  const recentTracks = getRecentPlaybackTitles(8);
  const randomSeedEra = SEED_ERAS[Math.floor(Math.random() * SEED_ERAS.length)];

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
  for (let i = 0; i < existingQueueTitles.length; i++) {
    const t = existingQueueTitles[i];
    const a = existingQueueArtists[i] || '';
    if (t && a) {
      const l = await detectTrackLanguageAsync(t, a);
      if (l !== 'en') queuedLanguages.add(l);
    }
  }

  const results: CuratedTrackResult[] = [];

  // --- Tier 0: Grounded Time Capsule (Strict Record Release Dates, Zero LLM Hallucination) ---
  const timeCapsuleYear = featureFlags.isEnabled('feature_time_capsule')
    ? stationCurator.getTimeCapsuleYear()
    : null;

  if (timeCapsuleYear) {
    try {
      const tcTracks = await stationCurator.getNextTimeCapsuleTracks(
        count,
        queuedSongIds,
        queuedArtists
      );
      for (const track of tcTracks) {
        if (isTrackEligibleForAutoplay(track.id, track.artist, queuedSongIds, queuedArtists, track.title, queuedDedupeKeys, track.durationSec, queuedLanguages, (track as any).isrc)) {
          queuedSongIds.add(track.id);
          queuedArtists.add(track.artist.toLowerCase());
          const normA = normalizeArtist(track.artist).replace(/\s+/g, '');
          if (normA) queuedArtists.add(normA);
          queuedDedupeKeys.add(getTrackDedupeKey(track.title, track.artist));
          const lang = detectTrackLanguage(track.title, track.artist, undefined, (track as any).isrc, track.id);
          if (lang !== 'en') queuedLanguages.add(lang);
          results.push({
            track,
            curatedBy: 'Dynamic Era Roulette',
            curationReason: `Grounded verified record release from ${timeCapsuleYear}`,
          });
        }
      }

      if (results.length >= count) {
        return results;
      }
    } catch (err) {
      console.warn('[Curator] Grounded time capsule tier error:', (err as Error).message);
    }
  }  // --- Tier 1: Curation Pipeline based on active Engine (hybrid / embedding / jev / llm) ---
  if (currentEngine === 'hybrid') {
    // Primary Hybrid Mode: 20/50/30 Degrees of Separation Collaborative Graph (Last.fm + Deezer)
    let hybridAttempts = 0;
    while (results.length < count && hybridAttempts < 8) {
      hybridAttempts++;
      const collTrack = await getDynamicFallbackTrack(roomProfile, queuedSongIds, queuedArtists, queuedDedupeKeys, queuedLanguages);
      if (collTrack) {
        queuedSongIds.add(collTrack.track.id);
        queuedArtists.add(collTrack.track.artist.toLowerCase());
        const normA = normalizeArtist(collTrack.track.artist).replace(/\s+/g, '');
        if (normA) queuedArtists.add(normA);
        queuedDedupeKeys.add(getTrackDedupeKey(collTrack.track.title, collTrack.track.artist));
        const lang = await detectTrackLanguageAsync(collTrack.track.title, collTrack.track.artist, undefined, collTrack.track.isrc, collTrack.track.id);
        if (lang !== 'en') queuedLanguages.add(lang);
        results.push(collTrack);
      }
    }
  } else if (currentEngine === 'embedding') {
    if (vectorCurator.getIndexedCount() >= 500) {
      try {
        const vectorTracks = await vectorCurator.curateNextTracks(
          roomProfile,
          memberUserIds,
          count,
          queuedSongIds,
          queuedArtists,
          queuedLanguages
        );
        for (const vt of vectorTracks) {
          results.push(vt);
          const lang = await detectTrackLanguageAsync(vt.track.title, vt.track.artist);
          if (lang !== 'en') queuedLanguages.add(lang);
        }
      } catch (err) {
        console.warn('[Curator] Latent vector curation tier error:', (err as Error).message);
      }
    }
    }

  // --- MusicBrainz & Deezer Discography Discovery (if slots remain) ---
  if (results.length < count && roomProfile.topLikedArtists.length > 0) {
    try {
      const seedArtist = roomProfile.topLikedArtists[Math.floor(Math.random() * roomProfile.topLikedArtists.length)];
      const mbRecordings = await musicbrainz.getArtistTopRecordings(seedArtist, 5);
      for (const rec of mbRecordings) {
        if (results.length >= count) break;
        const candidates = await deezer.searchTracks(`${rec.artist} ${rec.title}`, 2);
        for (const candidate of candidates) {
          if (await isCandidateEligibleAsync(candidate, queuedSongIds, queuedArtists, queuedDedupeKeys, queuedLanguages)) {
            queuedSongIds.add(candidate.id);
            queuedArtists.add(candidate.artist.toLowerCase());
            const normA = normalizeArtist(candidate.artist).replace(/\s+/g, '');
            if (normA) queuedArtists.add(normA);
            queuedDedupeKeys.add(getTrackDedupeKey(candidate.title, candidate.artist));
            results.push({
              track: candidate,
              curatedBy: 'MusicBrainz & Deezer Discovery',
              curationReason: `Official discography recommendation for ${seedArtist}`,
            });
            break;
          }
        }
      }
    } catch {}
  }

  // --- Tier 2: Dynamic Anti-Bubble Fallback ---
    let tier2Attempts = 0;
  while (results.length < count && tier2Attempts < 8) {
    tier2Attempts++;
    const fallbackResult = await getDynamicFallbackTrack(roomProfile, queuedSongIds, queuedArtists, queuedDedupeKeys, queuedLanguages);
    if (!fallbackResult) {
      continue;
    }
    queuedSongIds.add(fallbackResult.track.id);
    queuedArtists.add(fallbackResult.track.artist.toLowerCase());
    const normA = normalizeArtist(fallbackResult.track.artist).replace(/\s+/g, '');
    if (normA) queuedArtists.add(normA);
    queuedDedupeKeys.add(getTrackDedupeKey(fallbackResult.track.title, fallbackResult.track.artist));
    const lang = await detectTrackLanguageAsync(fallbackResult.track.title, fallbackResult.track.artist, undefined, fallbackResult.track.isrc, fallbackResult.track.id);
    if (lang !== 'en') queuedLanguages.add(lang);
    results.push(fallbackResult);

    brainLogger.logInteraction({
      timestamp: Math.floor(Date.now() / 1000),
      model: 'deezer-graph-engine',
      action: 'tier2_fallback',
      prompt: `Dynamic Fallback (Room listeners: ${roomProfile.memberCount}, Liked: ${roomProfile.topLikedArtists.join(', ') || 'Eclectic'})`,
      response: JSON.stringify({
        track: `${fallbackResult.track.artist} - ${fallbackResult.track.title}`,
        curatedBy: fallbackResult.curatedBy,
        reason: fallbackResult.curationReason,
      }, null, 2),
      durationMs: 180,
      status: 'fallback',
      metadata: { curatedBy: fallbackResult.curatedBy, trackId: fallbackResult.track.id },
    });
  }

  // --- Tier 5: Emergency Dead-Air Prevention (Progressive Softening) ---
  if (results.length < count) {
    console.warn('[Curator] ⚠️ Tight cooldowns detected. Activating Emergency Anti-Fatigue Vault to guarantee zero dead air.');
    try {
      const emergencyTracks = sqlite.prepare(`
        SELECT s.*,
          (SELECT COUNT(*) FROM playback_history h WHERE h.song_id = s.id) as play_count,
          (SELECT MAX(played_at) FROM playback_history h WHERE h.song_id = s.id) as last_played
        FROM songs s
        ORDER BY play_count ASC, last_played ASC
        LIMIT 10
      `).all() as any[];

      for (const row of emergencyTracks) {
        if (results.length >= count) break;
        if (queuedSongIds.has(row.id)) continue;
        const normA = normalizeArtist(row.artist).replace(/\s+/g, '');
        if (queuedArtists.has(row.artist.toLowerCase()) || (normA && queuedArtists.has(normA))) continue;

        queuedSongIds.add(row.id);
        queuedArtists.add(row.artist.toLowerCase());
        results.push({
          track: {
            id: row.id,
            deezerId: row.deezer_id || row.id.replace(/^dz_/, ''),
            title: row.title,
            artist: row.artist,
            album: row.album || undefined,
            durationSec: row.duration_sec || 180,
            artworkUrl: row.artwork_url || '',
            artworkThumbUrl: row.artwork_thumb_url || '',
            releaseYear: row.release_year || undefined,
          },
          curatedBy: 'Dynamic Taste Deep-Cut',
          curationReason: 'Emergency Vault: Longest-rested library track',
        });
      }
    } catch (err) {
      console.warn('[Curator] Emergency fallback error:', (err as Error).message);
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
