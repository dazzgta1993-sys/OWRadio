/**
 * @file trackDedupe.ts
 * @description Robust title, artist normalization and deduplication engine.
 * Prevents consecutive duplicates, variant editions (e.g. Extended vs Radio vs Album),
 * and same-artist clustering across player queues, vibe mixes, and autoplay.
 */

/**
 * Normalizes an artist name for strict and fuzzy equality comparisons.
 * Handles "The", "A", "An" prefixes, VEVO suffixes, Topic channels, and punctuation.
 */
/**
 * Splits composite or collaboration artist strings into individual artists.
 * Handles: "Calvin Harris, Ellie Goulding", "David Guetta and Bebe Rexha",
 * "Kygo feat. Conrad Sewell", "Swedish House Mafia ft. John Martin".
 */
export function extractArtists(artistStr: string): string[] {
  if (!artistStr) return [];
  const parts = artistStr.split(/(?:,|\s+&\s+|\s+and\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+with\s+|\s+vs\.?\s+|\s+x\s+)/i);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Extracts the single primary lead artist from a collaboration string.
 */
export function extractPrimaryArtist(artistStr: string): string {
  const list = extractArtists(artistStr);
  return list[0] || (artistStr || '').trim();
}

export function normalizeArtist(artist: string): string {
  if (!artist) return '';
  let clean = artist.toLowerCase().trim();
  clean = clean.replace(/\s*-\s*topic$/i, '');
  clean = clean.replace(/vevo$/i, '');
  clean = clean.replace(/^(the|a|an)\s+/i, '');
  clean = clean.replace(/^the(?=[a-z0-9])/i, '');
  clean = clean.replace(/[^\w\s]/g, '');
  clean = clean.replace(/\s+/g, ' ');
  return clean.trim();
}

/**
 * Normalizes a song title by stripping variant labels:
 * e.g. "(Extended Version)", "(Official Music Video)", "(Remastered 2021)", "(Radio Edit)",
 * "[HQ]", "[4K]", "feat. ...", trailing "- Remaster", etc.
 */
export function normalizeTrackTitle(title: string, artist?: string): string {
  if (!title) return '';
  let clean = title.toLowerCase();

  // If title is "Artist - Song", strip the artist part if it matches the artist or if parts look like Artist - Song
  if (clean.includes(' - ')) {
    const parts = clean.split(' - ');
    if (parts.length >= 2) {
      const p0 = normalizeArtist(parts[0]).replace(/\s+/g, '');
      const artNorm = artist ? normalizeArtist(artist).replace(/\s+/g, '') : '';
      if (!artNorm || p0 === artNorm || (p0.length > 3 && artNorm.includes(p0)) || (artNorm.length > 3 && p0.includes(artNorm))) {
        clean = parts.slice(1).join(' - ');
      }
    }
  }

  // If artist is known and title starts with "Artist - ...", strip the artist prefix
  if (artist) {
    const normArt = normalizeArtist(artist);
    if (normArt.length > 0) {
      const words = normArt.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const flexiblePattern = words.join('\\s*');
      clean = clean.replace(new RegExp(`^${flexiblePattern}\\s*[-:]\\s*`, 'i'), '');
    }
  }

  clean = clean
    // Remove content inside brackets / parens with edition keywords, year remasters, or video tags
    .replace(/\s*[\(\[](?:(?:\d{4}|[a-z]+)[\s\-_/;:,]+)?(?:official|music|video|audio|lyric(?:s)?|visualizer|extended|remaster(?:ed)?|radio|edit|club|album|original|mix|version|hd|hq|4k|feat\.?|ft\.?|featuring|live|deluxe|mono|stereo|bonus|acoustic|\d{4}).*?[\)\]]/gi, '')
    // Remove any remaining empty parens or brackets
    .replace(/\s*[\(\[]\s*[\)\]]/g, '')
    // Remove trailing dash or edition notes (e.g. "- 2011 Remaster", "- Radio Edit", "- 1998 Remaster")
    .replace(/\s*[-/|]\s*(?:remaster(?:ed)?|radio edit|extended(?: mix| version)?|club mix|original mix|single version|\d{4}\s+remaster|\d{4}\s+mix).*$/gi, '')
    // Strip non-alphanumeric characters
    .replace(/[^\w\s]/g, '')
    // Collapse multiple whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  return clean;
}

/**
 * Returns a canonical deduplication key for a track.
 * Two tracks with the same deduplication key represent the same underlying song.
 */
export function getTrackDedupeKey(title: string, artist: string): string {
  const normA = normalizeArtist(artist).replace(/\s+/g, '');
  const normT = normalizeTrackTitle(title, artist);
  return `${normA}:::${normT}`;
}

/**
 * Checks whether two tracks are duplicates based on ID or normalized title/artist.
 */
export function isDuplicateTrack(
  a: { title: string; artist: string; id?: string },
  b: { title: string; artist: string; id?: string }
): boolean {
  if (!a || !b) return false;

  // 1. Exact ID check (stripping yt_ prefix)
  if (a.id && b.id) {
    const cleanA = a.id.replace(/^yt_/, '');
    const cleanB = b.id.replace(/^yt_/, '');
    if (cleanA === cleanB) return true;
  }

  // 2. Canonical Dedupe Key check
  const keyA = getTrackDedupeKey(a.title, a.artist);
  const keyB = getTrackDedupeKey(b.title, b.artist);
  if (keyA === keyB) return true;

  // 3. Normalized artist equality with substring title match (e.g. "Song Name" vs "Song Name Extra")
  const normArtistA = normalizeArtist(a.artist).replace(/\s+/g, '');
  const normArtistB = normalizeArtist(b.artist).replace(/\s+/g, '');
  if (normArtistA.length > 2 && normArtistA === normArtistB) {
    const normTitleA = normalizeTrackTitle(a.title, a.artist);
    const normTitleB = normalizeTrackTitle(b.title, b.artist);
    if (normTitleA === normTitleB) return true;
    if (
      (normTitleA.length >= 6 && normTitleB.startsWith(normTitleA)) ||
      (normTitleB.length >= 6 && normTitleA.startsWith(normTitleB))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if two artists are identical or represent the same entity.
 */
export function isSameArtist(artistA: string, artistB: string): boolean {
  if (!artistA || !artistB) return false;
  const a = normalizeArtist(artistA).replace(/\s+/g, '');
  const b = normalizeArtist(artistB).replace(/\s+/g, '');
  return a === b;
}
