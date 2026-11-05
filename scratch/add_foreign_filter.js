const fs = require('fs');

function updateCurator(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Replace isForeignLanguageLocked and isCandidateEligibleAsync
  const searchStr = 'export function isForeignLanguageLocked';
  const startIdx = content.indexOf(searchStr);
  if (startIdx === -1) {
    console.error('Could not find start in', filePath);
    return;
  }

  const endSearch = 'export function getActiveVoiceRoomProfile';
  const endIdx = content.indexOf(endSearch, startIdx);
  if (endIdx === -1) {
    console.error('Could not find end in', filePath);
    return;
  }

  const newBlock = `export function isLikelyForeignTitle(title: string): boolean {
  if (!title) return false;
  const lower = title.toLowerCase();
  // 1. Nordic / Germanic accented characters typical of domestic non-English releases
  if (/[åäöøæüëï]/.test(lower)) return true;
  // 2. Non-Latin scripts (Cyrillic, Greek, CJK, Arabic)
  if (/[\\u0400-\\u04FF\\u3040-\\u30FF\\u4E00-\\u9FFF\\u0600-\\u06FF]/.test(title)) return true;
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
    console.log(\`[Curator] 🛡️ Non-English title "\${track.artist} - \${track.title}" blocked by English purity guardrail.\`);
    return false;
  }

  return true;
}

`;

  const updated = content.slice(0, startIdx) + newBlock + content.slice(endIdx);
  fs.writeFileSync(filePath, updated, 'utf8');
  console.log('Successfully updated', filePath);
}

updateCurator('src/services/curator.ts');
updateCurator('OWRADIO-DOCKER/src/services/curator.ts');
