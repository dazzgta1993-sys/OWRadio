/**
 * @file utils/artistNormalizer.ts
 * @description Multi-artist collaboration splitter, canonical title/artist normalizer,
 * and 4-track artist separation scheduler.
 */

const PRESERVED_DUO_BANDS = new Set([
  'ac/dc',
  'hall & oates',
  'daryl hall & john oates',
  'simon & garfunkel',
  'earth, wind & fire',
  'florence + the machine',
  'florence and the machine',
  'mumford & sons',
  "guns n' roses",
  'brooks & dunn',
  'tegan and sara',
  'coheed and cambria',
  'crosby, stills, nash & young',
  'crosby, stills & nash',
  'emerson, lake & palmer',
  'peter, paul and mary',
  'kool & the gang',
  'kc and the sunshine band',
  'sly and the family stone',
  'echo & the bunnymen',
  'belle and sebastian',
  'angus & julia stone',
  'above & beyond',
  'chase & status',
]);

/**
 * Splits composite collaboration strings ("Calvin Harris, Ellie Goulding",
 * "Daft Punk feat. Pharrell Williams") into individual artist names while
 * preserving band names that contain punctuation.
 */
export function splitCollabArtists(artistStr: string): string[] {
  const raw = (artistStr || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\bVEVO$/i, '')
    .trim();
  if (!raw) return [];
  if (PRESERVED_DUO_BANDS.has(raw.toLowerCase())) {
    return [raw];
  }
  const parts = raw
    .split(/\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x)\s+|\s*,\s*|\s*&\s*|\s*;\s*|\s*\/\s*/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 1);
  return parts.length > 0 ? parts : [raw];
}

/**
 * Extracts the primary lead artist from a potentially composite artist string.
 */
export function extractPrimaryArtist(artistStr: string): string {
  const parts = splitCollabArtists(artistStr);
  return parts[0] || (artistStr || '').trim();
}

export function normalizeNameForMatch(s: string): string {
  let clean = (s || '')
    .toLowerCase()
    .replace(/\s*-\s*topic$/i, '')
    .trim()
    .replace(/^['"`\u2018\u2019\u201c\u201d]+|['"`\u2018\u2019\u201c\u201d]+$/g, '');
  if (clean.startsWith('the ')) {
    clean = clean.slice(4).trim();
  }
  clean = clean
    .replace(/!/g, 'i')
    .replace(/\$/g, 's')
    .replace(/@/g, 'a')
    .replace(/&/g, 'and')
    .replace(/\+/g, 'and');
  return clean.replace(/[^a-z0-9]/g, '');
}

export function normalizeTrackKey(artist: string, title: string): string {
  const pArt = normalizeNameForMatch(extractPrimaryArtist(artist));
  const cleanTitle = (title || '')
    .toLowerCase()
    .replace(/\s*[\(\[][^\)\]]*(?:official|video|audio|lyrics|visualizer|remaster|hd|4k|feat|ft)[^\)\]]*[\)\]]/gi, '')
    .replace(/[^a-z0-9]/g, '');
  return `${pArt}:::${cleanTitle}`;
}

/**
 * Ensures no two songs by the same primary or featured artist appear consecutively
 * or within `minDistance` tracks of each other, and penalizes recently played artists.
 */
export function applyArtistSeparation<T extends { artist: string; title: string }>(
  tracks: T[],
  minDistance = 4,
  excludeArtists: string[] = [],
  maxPerArtist = 2
): T[] {
  if (!tracks || tracks.length === 0) return [];

  const recentSet = new Set<string>();
  for (const a of excludeArtists) {
    for (const sub of splitCollabArtists(a)) {
      recentSet.add(sub.toLowerCase());
    }
  }

  const byArtist = new Map<string, T[]>();
  for (const t of tracks) {
    const credits = splitCollabArtists(t.artist).map((c) => c.toLowerCase());
    const key = credits[0] || t.artist.toLowerCase().trim();
    const bucket = byArtist.get(key) || [];
    if (bucket.length < maxPerArtist) {
      bucket.push(t);
      byArtist.set(key, bucket);
    }
  }

  const ordered: T[] = [];
  const lastArtistPos = new Map<string, number>();
  let remaining = Array.from(byArtist.values()).reduce((acc, list) => acc + list.length, 0);
  const maxLoops = remaining * 8;
  let loop = 0;

  while (remaining > 0 && loop < maxLoops) {
    loop++;
    let bestArt: string | null = null;
    let bestScore = -999999;
    const currentIdx = ordered.length;

    for (const [art, trks] of byArtist.entries()) {
      if (trks.length === 0) continue;
      const candCredits = splitCollabArtists(trks[0].artist || art).map((c) => c.toLowerCase());
      const minDistSeen = Math.min(
        ...candCredits.map((c) => currentIdx - (lastArtistPos.get(c) ?? -999))
      );

      // Never pick the same primary or featured artist consecutively
      if (minDistSeen <= 1 && currentIdx > 0) continue;

      let score = 0;
      if (minDistSeen < minDistance) {
        score -= (minDistance - minDistSeen) * 100;
      } else {
        score += minDistSeen * 10;
      }
      if (candCredits.some((c) => recentSet.has(c))) {
        score -= 600;
      }
      score += Math.random() * 15;

      if (score > bestScore) {
        bestScore = score;
        bestArt = art;
      }
    }

    if (bestArt && (byArtist.get(bestArt)?.length ?? 0) > 0) {
      const chosen = byArtist.get(bestArt)!.shift()!;
      ordered.push(chosen);
      for (const c of splitCollabArtists(chosen.artist || bestArt)) {
        lastArtistPos.set(c.toLowerCase(), currentIdx);
      }
      remaining--;
    } else {
      break;
    }
  }

  return ordered;
}
