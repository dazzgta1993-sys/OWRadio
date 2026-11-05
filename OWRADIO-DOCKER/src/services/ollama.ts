/**
 * @file ollama.ts
 * @description Local LLM interface for qwen2.5:1.5b running on Ollama (http://127.0.0.1:11434).
 * Enforces CPU thread clamping (max 2 threads) to protect PCM audio playback and logs all interactions.
 */

import config from '../config.js';
import brainLogger from './brainLogger.js';
import musicIntel from './musicIntel.js';
import { normalizeArtist, normalizeTrackTitle } from '../utils/trackDedupe.js';

export interface CurationRecommendation {
  artist: string;
  title: string;
  type: 'preference_match' | 'wildcard';
  reason: string;
}

export interface CurationContext {
  activeMembersCount: number;
  likedArtists: string[];
  likedSongs: string[];
  dislikedArtists: string[];
  recentTracks: string[];
  randomSeedEra: string;
}

export interface VibeItem {
  artist: string;
  title: string;
  reason: string;
}

export interface EnrichedMetadata {
  mood: string;
  energyLevel: number;
  tags: string[];
}

let _ollamaCircuitBreakerUntil = 0;
let _ollamaConsecutiveErrors = 0;

/**
 * Execute a structured JSON request against Ollama with strict timeout, thread clamping, circuit breaker, and observability logging.
 */
async function callOllama<T>(
  prompt: string,
  timeoutMs = 5000,
  options: Record<string, any> = { num_thread: 2, num_predict: 200, temperature: 0.7 },
  action: 'curation' | 'vibe' | 'enrichment' | 'custom' = 'curation',
  metadata?: Record<string, any>
): Promise<T | null> {
  // Fast fail if circuit breaker is open (Ollama offline/unreachable)
  if (Date.now() < _ollamaCircuitBreakerUntil) {
    return null;
  }

  // Hard clamp on timeout to prevent freezing event loop or queue delays
  const effectiveTimeout = Math.min(timeoutMs, 5000);
  const url = `${config.OLLAMA_URL}/api/generate`;
  const t0 = performance.now();
  const timestamp = Math.floor(Date.now() / 1000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.OLLAMA_MODEL,
        prompt,
        stream: false,
        format: 'json',
        options,
      }),
      signal: AbortSignal.timeout(effectiveTimeout),
    });

    const durationMs = Math.round(performance.now() - t0);

    if (!response.ok) {
      console.warn(`[Ollama] HTTP error ${response.status} from ${url}`);
      _ollamaConsecutiveErrors++;
      if (_ollamaConsecutiveErrors >= 2) {
        _ollamaCircuitBreakerUntil = Date.now() + 180000;
        console.warn(`[Ollama] Circuit breaker active. Ollama returned HTTP errors; pausing queries for 3m.`);
      }
      brainLogger.logInteraction({
        timestamp,
        model: config.OLLAMA_MODEL,
        action,
        prompt,
        response: null,
        durationMs,
        status: 'error',
        metadata: { ...metadata, httpStatus: response.status, options },
      });
      return null;
    }

    const data = (await response.json()) as any;
    if (!data.response) {
      brainLogger.logInteraction({
        timestamp,
        model: config.OLLAMA_MODEL,
        action,
        prompt,
        response: null,
        durationMs,
        status: 'error',
        metadata: { ...metadata, error: 'Empty response body', options },
      });
      return null;
    }

    // Success - reset breaker
    _ollamaConsecutiveErrors = 0;
    _ollamaCircuitBreakerUntil = 0;

    const rawResponse = data.response;

    let parsedResult: T | null = null;
    try {
      parsedResult = JSON.parse(rawResponse) as T;
    } catch {
      // In case the model wrapped JSON in markdown code blocks or truncated mid-string
      try {
        const clean = rawResponse.replace(/```json\n?|\n?```/g, '').trim();
        parsedResult = JSON.parse(clean) as T;
      } catch {
        // Regex extract all completed track recommendation objects
        const recRegex = /\{\s*"artist":\s*"([^"]+)",\s*"title":\s*"([^"]+)",\s*"type":\s*"([^"]+)",\s*"reason":\s*"([^"]+)"\s*\}/g;
        const items: any[] = [];
        let match;
        while ((match = recRegex.exec(rawResponse)) !== null) {
          items.push({
            artist: match[1],
            title: match[2],
            type: match[3],
            reason: match[4],
          });
        }
        if (items.length > 0) {
          parsedResult = { recommendations: items } as unknown as T;
        } else {
          // Attempt closing brackets
          try {
            const repaired = rawResponse.trim().replace(/,\s*$/, '') + '\n  ]\n}';
            parsedResult = JSON.parse(repaired) as T;
          } catch {}
        }
      }
    }

    if (parsedResult) {
      brainLogger.logInteraction({
        timestamp,
        model: config.OLLAMA_MODEL,
        action,
        prompt,
        response: rawResponse,
        durationMs,
        status: 'success',
        metadata: { ...metadata, options },
      });
      return parsedResult;
    } else {
      brainLogger.logInteraction({
        timestamp,
        model: config.OLLAMA_MODEL,
        action,
        prompt,
        response: rawResponse,
        durationMs,
        status: 'error',
        metadata: { ...metadata, error: 'JSON Parse Failure', options },
      });
      return null;
    }
  } catch (err) {
    const durationMs = Math.round(performance.now() - t0);
    const isTimeout =
      (err as Error).name === 'TimeoutError' ||
      (err as Error).message.toLowerCase().includes('timeout') ||
      (err as Error).message.toLowerCase().includes('aborted');

    _ollamaConsecutiveErrors++;
    if (_ollamaConsecutiveErrors >= 2) {
      _ollamaCircuitBreakerUntil = Date.now() + 180000;
      console.warn(`[Ollama] Circuit breaker active (2 consecutive errors/timeouts). Ollama appears offline; pausing LLM queries for 3m.`);
    }

    console.warn(`[Ollama] Model query failed or timed out (${effectiveTimeout}ms):`, (err as Error).message);

    brainLogger.logInteraction({
      timestamp,
      model: config.OLLAMA_MODEL,
      action,
      prompt,
      response: null,
      durationMs,
      status: isTimeout ? 'timeout' : 'error',
      metadata: { ...metadata, error: (err as Error).message, timeoutMs: effectiveTimeout, options },
    });
    return null;
  }
}

/**
 * Curate upcoming tracks blending room tastes with wildcards, live web search, and DB dossiers.
 */
export async function curateNextTracks(
  context: CurationContext,
  activeUserIds: string[] = []
): Promise<CurationRecommendation[]> {
  // 1. Gather rich database dossiers for active listeners
  const dossiers = musicIntel.getActiveListenersDossier(activeUserIds);

  // 2. Gather session trajectory
  const trajectory = musicIntel.getRecentSessionTrajectory(4);

  // 3. Gather live web & music scene intel
  const liveIntel = await musicIntel.gatherLiveMusicIntel(context.randomSeedEra, context.likedArtists);

  let listenerSections = '';
  if (dossiers.length > 0) {
    listenerSections = dossiers
      .map((d) => {
        const top = d.topArtists
          .map((a) => {
            const sampleStr = a.sampleTracks && a.sampleTracks.length > 0 ? ` (e.g. "${a.sampleTracks.join('", "')}")` : '';
            return `${a.name} (+${a.score.toFixed(1)})${sampleStr}`;
          })
          .join(', ') || 'Eclectic';
        const dormant = d.dormantFavorites.length > 0 ? ` (Dormant Gems: ${d.dormantFavorites.join(', ')})` : '';
        return `• Listener ${d.displayName}: Favors [${top}]${dormant}`;
      })
      .join('\n');
  } else {
    listenerSections = `• Room consensus favors: ${context.likedArtists.slice(0, 6).join(', ') || 'Eclectic'}`;
  }

  const recentTrackList = trajectory.recentTracks
    .map((t) => `${t.artist} - ${t.title}${t.releaseYear ? ` (${t.releaseYear})` : ''}`)
    .join(' -> ') || 'Session Start';

  const adjacentStr = liveIntel.adjacentArtists.length > 0 ? liveIntel.adjacentArtists.slice(0, 6).join(', ') : 'Contemporary Scene';
  const staplesStr = liveIntel.eraStaples.length > 0 ? liveIntel.eraStaples.join(', ') : '';
  const webTrendStr = liveIntel.liveTrends.length > 0
    ? liveIntel.liveTrends.slice(0, 2).map((s) => `• "${s}"`).join('\n')
    : '';

  const wikiContextStr = liveIntel.artistContexts.length > 0
    ? liveIntel.artistContexts.slice(0, 2).map((c) => `• ${c}`).join('\n')
    : '';

  const vetoedStr = context.dislikedArtists.slice(0, 8).join(', ') || 'None';

  const prompt = `You are OWRadio, an elite autonomous radio DJ & music director.
Curate the next 4 tracks with deep music intelligence, harmonic progression, and anti-cliché taste.

=== ACTIVE LISTENERS (FROM DATABASE) ===
${listenerSections}
• Hard Vetoed/Disliked: ${vetoedStr}

=== RECENT SESSION FLOW ===
Recent flow: ${recentTrackList}

=== LIVE SCENE & ERA INTEL ===
• Seed Era: "${context.randomSeedEra}"
${staplesStr ? `• Era Real Staples: ${staplesStr}\n` : ''}• Related/Adjacent Artists: ${adjacentStr}
${wikiContextStr ? `• Artist Context: ${wikiContextStr}\n` : ''}${webTrendStr ? `• Scene Trend: ${webTrendStr}\n` : ''}
DIRECTIVES:
1. Real Track Mandate: Recommend 4 REAL existing tracks from the artist discographies or real scene staples above. Strictly DO NOT fabricate or invent fake song titles.
2. Veto Enforcement: Strictly NEVER recommend any artist listed in Hard Vetoed/Disliked or recent flow.
3. Balance: 3 "preference_match" (matching listener taste) + 1 "wildcard" (fitting "${context.randomSeedEra}").
4. Ultra-Concise Rationale: Exactly 3-5 words in the reason field (e.g. "Bridges synth into melodic house"). Do NOT write long sentences.

Return ONLY JSON:
{
  "recommendations": [
    {
      "artist": "Artist",
      "title": "Title",
      "type": "preference_match",
      "reason": "Bridges dark synth into post-punk"
    }
  ]
}`;

  const result = await callOllama<{ recommendations?: CurationRecommendation[] }>(
    prompt,
    3500,
    { num_thread: 2, num_predict: 250, temperature: 0.7 },
    'curation',
    {
      activeListeners: context.activeMembersCount,
      seedEra: context.randomSeedEra,
      topArtistsCount: context.likedArtists.length,
      liveAdjacentCount: liveIntel.adjacentArtists.length,
    }
  );

  if (!result?.recommendations || !Array.isArray(result.recommendations)) {
    return [];
  }

  const vetoedLower = new Set(context.dislikedArtists.map((a) => a.toLowerCase().trim()));
  return result.recommendations.filter(
    (r) => r.artist && r.title && (r.type === 'preference_match' || r.type === 'wildcard') && !vetoedLower.has(r.artist.toLowerCase().trim())
  );
}

/**
 * Converts a natural language vibe prompt into a themed playlist.
 */
export async function generateVibePlaylist(userPrompt: string, count = 8): Promise<VibeItem[]> {
  const prompt = `You are OWRadio, an expert DJ.
The user wants a playlist with this specific mood/vibe: "${userPrompt}"

Output exactly ${count} real, iconic or deep-cut songs that fit this vibe perfectly.
Output ONLY JSON in this schema:
{
  "playlist": [
    {
      "artist": "Artist Name",
      "title": "Track Title",
      "reason": "Short 5-word description"
    }
  ]
}

CRITICAL DIVERSITY & DEDUPLICATION RULES:
- Every single song in the playlist MUST be by a DIFFERENT artist. NEVER include the same artist twice!
- NEVER output remixes, alternate edits, or multiple versions of the same song.
- Curate a varied, diverse playlist across distinct legendary or underground artists matching this aesthetic.`;

  const result = await callOllama<{ playlist?: VibeItem[] }>(
    prompt,
    4000,
    { num_thread: 2, num_predict: 260, temperature: 0.7 },
    'vibe',
    { vibePrompt: userPrompt, targetCount: count }
  );

  if (!result?.playlist || !Array.isArray(result.playlist)) {
    return [];
  }

  // Strictly filter out duplicates or repeated artists
  const seenArtists = new Set<string>();
  const seenTitles = new Set<string>();
  const diverseList: VibeItem[] = [];

  for (const p of result.playlist) {
    if (!p.artist || !p.title) continue;
    const normA = normalizeArtist(p.artist).replace(/\s+/g, '');
    const normT = normalizeTrackTitle(p.title, p.artist);
    if (!normA || seenArtists.has(normA) || seenTitles.has(normT)) {
      continue;
    }
    seenArtists.add(normA);
    seenTitles.add(normT);
    diverseList.push(p);
  }

  return diverseList;
}

/**
 * Enriches song metadata in the background (mood, energy level, AI tags).
 */
export async function enrichSongMetadata(
  title: string,
  artist: string,
  album?: string
): Promise<EnrichedMetadata | null> {
  const prompt = `Analyze this track: "${title}" by "${artist}"${album ? ` (Album: "${album}")` : ''}.
Return mood, energyLevel (1-10), and 3-5 style tags.
Output ONLY JSON:
{
  "mood": "Euphoric / Melancholic / Energetic",
  "energyLevel": 7,
  "tags": ["synthwave", "retrofuturistic", "night-drive"]
}`;

  return callOllama<EnrichedMetadata>(
    prompt,
    3000,
    { num_thread: 2, num_predict: 80, temperature: 0.4 },
    'enrichment',
    { title, artist, album }
  );
}

export default {
  curateNextTracks,
  generateVibePlaylist,
  enrichSongMetadata,
};
