import fs from 'node:fs';

function fixTier2(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  const startMarker = '  // Tier 2: Emergency Dead-Air Prevention (Local Catalog Safety Net)';
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) {
    console.error('startMarker not found in', filePath);
    return;
  }

  const endMarker = '  return results;\n}';
  const endMarkerCRLF = '  return results;\r\n}';
  let endIdx = content.indexOf(endMarker, startIdx);
  if (endIdx === -1) {
    endIdx = content.indexOf(endMarkerCRLF, startIdx);
  }
  if (endIdx === -1) {
    console.error('endMarker not found in', filePath);
    return;
  }

  const newTier2 = `  // Tier 2: Vibe-Guarded Fallback (Never blind random cross-genre roulette)
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
            const normA = normalizeArtist(t.artist).replace(/\\s+/g, '');
            if (normA) queuedArtists.add(normA);
            queuedDedupeKeys.add(getTrackDedupeKey(t.title, t.artist));
            results.push({
              track: t,
              curatedBy: 'DJ Harmonic Chain',
              curationReason: \`Harmonic peer match from \${activeAnchor}\`,
            });
            break;
          }
        }
      }
    } catch (err) {
      console.warn('[Curator] Harmonic fallback error:', (err as Error).message);
    }
  }

`;

  const updated = content.slice(0, startIdx) + newTier2 + content.slice(endIdx);
  fs.writeFileSync(filePath, updated, 'utf8');
  console.log('Successfully updated Tier 2 in', filePath);
}

fixTier2('src/services/curator.ts');
fixTier2('OWRADIO-DOCKER/src/services/curator.ts');
