/**
 * @file services/streamFilters.ts
 * @description Port of Album Discovery Bot's stream_filters.py.
 * Filters out 99% of YouTube junk (karaoke, tributes, 8-bit, nightcore, slowed+reverb,
 * amateur covers, type beats, skits < 65s) while protecting legitimate song titles
 * (e.g. "Cover Me" by Bruce Springsteen or "Tribute" by Tenacious D), and enforces
 * the strict +/-5s studio duration tolerance guardrail.
 */

import { splitCollabArtists, normalizeNameForMatch } from '../utils/artistNormalizer.js';

const VARIANT_KEYWORDS = [
  'live',
  'concert',
  'karaoke',
  'instrumental',
  'tribute',
  'cover',
  '8-bit',
  '8 bit',
  'lullaby',
  'music box',
  'nightcore',
  'slowed',
  'reverb',
  'sped up',
  'chopped',
  'screwed',
  'acoustic',
  'demo',
  'rehearsal',
  'commentary',
  'track by track',
  'interview',
  'reaction',
  'review',
  'tutorial',
  'lesson',
  'how to play',
  'backing track',
  'drumless',
  'bass boosted',
  'earrape',
  'type beat',
  'parody',
  'ai cover',
  'ringtone',
  'medley',
  'teaser',
  'snippet',
  'preview',
];

const CHANNEL_JUNK_PATTERNS =
  /\b(karaoke|tribute|8-bit|lullaby|vitamin string quartet|piano guys|rockabye baby|twinkle twinkle little rock star|midnite string quartet|pickin' on|kids bop|kidz bop|ministry of sound|backing track|guitar lesson)\b/i;

/**
 * Strips feat./remastered/edition clutter to reveal the core song title.
 */
export function cleanTargetTitle(title: string): string {
  if (!title) return '';
  let t = title.replace(
    /\s*[\(\[](?:feat\.?|ft\.?|with|remaster(?:ed)?|deluxe|bonus|explicit|clean|album version|single version|radio edit|original mix|official[^\)\]]*)[^\)\]]*[\)\]]/gi,
    ''
  );
  t = t.replace(/\s+-\s+(?:remaster(?:ed)?.*|single version|album version|radio edit|explicit)$/i, '');
  return t.trim() || title.trim();
}

/**
 * Rejects live versions, karaoke, covers, tributes, slowed+reverb, and fan edits,
 * UNLESS the target studio song title legitimately contains that keyword!
 */
export function isUnwantedVariant(
  candidateTitle: string,
  targetTitle: string,
  channelName = ''
): boolean {
  const cLow = (candidateTitle || '').toLowerCase();
  const tLow = (targetTitle || '').toLowerCase();
  const chLow = (channelName || '').toLowerCase();

  if (CHANNEL_JUNK_PATTERNS.test(chLow) && !CHANNEL_JUNK_PATTERNS.test(tLow)) {
    return true;
  }

  for (const kw of VARIANT_KEYWORDS) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`\\b${escaped}\\b`, 'i');
    if (rx.test(cLow) && !rx.test(tLow)) {
      return true;
    }
  }

  if (/\b(?:remix|rmx|vip mix|bootleg|mashup)\b/i.test(cLow) && !/\b(?:remix|rmx|vip mix|bootleg|mashup)\b/i.test(tLow)) {
    return true;
  }

  return false;
}

/**
 * Strict +/-5s Duration Tolerance Guardrail against canonical Deezer/iTunes track duration.
 */
export function isDurationValid(
  candidateSecs: number,
  targetSecs: number,
  toleranceSecs = 5,
  allowZero = false
): boolean {
  if (!targetSecs || targetSecs <= 0) {
    return candidateSecs === 0 ? allowZero : candidateSecs >= 45 && candidateSecs <= 900;
  }
  if (!candidateSecs || candidateSecs <= 0) {
    return allowZero;
  }
  return Math.abs(candidateSecs - targetSecs) <= toleranceSecs;
}

/**
 * Verifies that the candidate title matches the target song title's core words.
 */
export function isTitleMatch(candidateTitle: string, targetTitle: string): boolean {
  const coreTarget = cleanTargetTitle(targetTitle).toLowerCase();
  const coreCand = cleanTargetTitle(candidateTitle).toLowerCase();
  if (!coreTarget || !coreCand) return false;

  const normT = coreTarget.replace(/[^a-z0-9\s]/g, ' ').trim();
  const normC = coreCand.replace(/[^a-z0-9\s]/g, ' ').trim();
  if (!normT || !normC) return coreCand.includes(coreTarget) || coreTarget.includes(coreCand);
  if (normC.includes(normT) || normT.includes(normC)) return true;

  const wordsT = normT.split(/\s+/).filter((w) => w.length > 1);
  if (wordsT.length === 0) return true;
  const wordsC = new Set(normC.split(/\s+/));
  const matched = wordsT.filter((w) => wordsC.has(w)).length;
  return matched / wordsT.length >= 0.75;
}

/**
 * Verifies that the candidate video belongs to the target artist (or featured artist).
 */
export function isArtistMatch(
  item: { title?: string; channel?: string; artists?: string[] },
  targetArtist: string
): boolean {
  if (!targetArtist) return true;
  const targetLow = targetArtist.toLowerCase().trim();
  if (['various artists', 'various', 'unknown', 'unknown artist', 'youtube', 'youtube search'].includes(targetLow)) {
    return true;
  }

  const targetParts = splitCollabArtists(targetArtist).map(normalizeNameForMatch).filter(Boolean);
  if (targetParts.length === 0) return true;

  const candidatePool = [
    item.channel || '',
    item.title || '',
    ...(item.artists || []),
  ]
    .map(normalizeNameForMatch)
    .filter(Boolean)
    .join(' ');

  return targetParts.some((tp) => candidatePool.includes(tp));
}

export function isSkitOrIntro(title: string, durationSecs = 0): boolean {
  const tLow = (title || '').toLowerCase();
  if (/\b(skit|interlude|intro|outro|commentary|voice memo|dialogue|spoken word)\b/i.test(tLow)) {
    return true;
  }
  if (durationSecs > 0 && durationSecs < 65) {
    return true;
  }
  return false;
}

export function isJunkAlbumTitle(title: string, artist = ''): boolean {
  const combined = `${title} ${artist}`.toLowerCase();
  return /\b(karaoke|tribute to|originally performed by|made famous by|in the style of|8-bit|lullaby renditions|backing tracks|ringtones)\b/i.test(
    combined
  );
}
