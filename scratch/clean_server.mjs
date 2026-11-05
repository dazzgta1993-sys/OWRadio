import fs from 'node:fs';

function cleanServer(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // 1. Remove dead imports
  content = content.replace(/import vibeService[^\n]+\n/g, '');
  content = content.replace(/import tasteRadar[^\n]+\n/g, '');
  content = content.replace(/import featureFlags[^\n]+\n/g, '');
  content = content.replace(/import stationCurator[^\n]+\n/g, '');

  // 2. Clean mode === 'vibe' to use collaborativeGraph & deezer
  const oldVibeCode = `    if (mode === 'vibe') {
      const vibeItems = await vibeService.generateVibePlaylist(query, 5);`;

  const newVibeCode = `    if (mode === 'vibe') {
      const related = await collaborativeGraph.getRelatedArtists(query, 5);
      const artistsToQuery = related.length > 0 ? related.map((r: any) => r.name) : [query];
      const vibeItems = await collaborativeGraph.getDeepCutsForArtists(artistsToQuery, 5, 2);`;

  if (content.includes(oldVibeCode)) {
    content = content.replace(oldVibeCode, newVibeCode);
  } else {
    const oldVibeCRLF = oldVibeCode.replace(/\n/g, '\r\n');
    const newVibeCRLF = newVibeCode.replace(/\n/g, '\r\n');
    if (content.includes(oldVibeCRLF)) {
      content = content.replace(oldVibeCRLF, newVibeCRLF);
    }
  }

  // 3. Remove tasteRadar from GET /api/brain
  const oldBrainRadar = `      tasteRadar: {
        target: 50_000,
        totalSongs: tasteRadar.getCatalogStats().totalSongs,
        totalEmbeddings: tasteRadar.getCatalogStats().totalEmbeddings,
        progressPct: ((tasteRadar.getCatalogStats().totalSongs / 50_000) * 100).toFixed(1),
      },`;
  content = content.replace(oldBrainRadar, '');
  content = content.replace(oldBrainRadar.replace(/\n/g, '\r\n'), '');

  // 4. Remove fake endpoints from POST /api/brain/radar/scan down to before GET /api/events
  const startDeadRoute = "  // --- 5f. POST /api/brain/radar/scan";
  const startDeadIdx = content.indexOf(startDeadRoute);
  const endDeadRoute = "  // --- 6. GET /api/events (Server-Sent Events) ---";
  const endDeadIdx = content.indexOf(endDeadRoute);

  if (startDeadIdx !== -1 && endDeadIdx !== -1) {
    content = content.slice(0, startDeadIdx) + content.slice(endDeadIdx);
    console.log('Removed dead endpoints from', filePath);
  } else {
    console.error('Could not find endpoint boundaries in', filePath);
  }

  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Successfully updated', filePath);
}

cleanServer('src/web/server.ts');
cleanServer('OWRADIO-DOCKER/src/web/server.ts');
