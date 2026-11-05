import fs from 'node:fs';

function applyCleanups() {
  const targets = [
    {
      files: ['src/player/GuildPlayer.ts', 'OWRADIO-DOCKER/src/player/GuildPlayer.ts'],
      fn: (content) => {
        // Fix PlayerStatePayload interface
        content = content.replace(/  storyArc\?:\s*ReturnType<typeof stationCurator\[[^\]]+\]>;\r?\n/g, '');
        content = content.replace(/  radioStation\?:\s*ReturnType<typeof stationCurator\[[^\]]+\]>;\r?\n/g, '');
        content = content.replace(/  timeCapsuleYear\?:\s*number\s*\|\s*null;\r?\n/g, '');
        content = content.replace(/  morph\?:\s*ReturnType<typeof stationCurator\[[^\]]+\]>;\r?\n/g, '');
        content = content.replace(/  brainPills\?:\s*any\[\];\r?\n/g, '');
        content = content.replace(/  activeBrainCount\?:\s*number;\r?\n/g, '');
        content = content.replace(/  totalBrainCount\?:\s*number;\r?\n/g, '');

        // Fix line 956 featureFlags check
        content = content.replace(
          /else if \(this\.currentTrack && featureFlags\.isEnabled\('feature_harmonic_crossfade'\)\)/g,
          'else if (this.currentTrack)'
        );

        // Fix getStatePayload return object
        content = content.replace(/      storyArc:\s*stationCurator\.getStoryArcState\(\),\r?\n/g, '');
        content = content.replace(/      radioStation:\s*stationCurator\.getActiveStation\(\),\r?\n/g, '');
        content = content.replace(/      timeCapsuleYear:\s*stationCurator\.getTimeCapsuleYear\(\),\r?\n/g, '');
        content = content.replace(/      morph:\s*stationCurator\.getMorphState\(\),\r?\n/g, '');
        content = content.replace(/      brainPills,\r?\n/g, '');
        content = content.replace(/      activeBrainCount,\r?\n/g, '');
        content = content.replace(/      totalBrainCount:\s*brainPills\.length,\r?\n/g, '');

        return content;
      }
    },
    {
      files: ['src/services/harmonicMixing.ts', 'OWRADIO-DOCKER/src/services/harmonicMixing.ts'],
      fn: (content) => {
        content = content.replace(/if \(!featureFlags\.isEnabled\('feature_harmonic_crossfade'\)\) \{[\s\S]*?\}\r?\n\r?\n/g, '');
        return content;
      }
    },
    {
      files: ['src/services/streamResolver.ts', 'OWRADIO-DOCKER/src/services/streamResolver.ts'],
      fn: (content) => {
        content = content.replace(/import featureFlags from '\.\/featureFlags\.js';\r?\n/g, '');
        return content;
      }
    },
    {
      files: ['src/bot/playerUi.ts', 'OWRADIO-DOCKER/src/bot/playerUi.ts'],
      fn: (content) => {
        content = content.replace(/import featureFlags from '\.\.\/services\/featureFlags\.js';\r?\n/g, '');
        content = content.replace(/import stationCurator from '\.\.\/services\/stationCurator\.js';\r?\n/g, '');
        return content;
      }
    },
    {
      files: ['src/bot/client.ts', 'OWRADIO-DOCKER/src/bot/client.ts'],
      fn: (content) => {
        content = content.replace(/import featureFlags from '\.\.\/services\/featureFlags\.js';\r?\n/g, '');
        return content;
      }
    },
    {
      files: ['src/bot/commands/play.ts', 'OWRADIO-DOCKER/src/bot/commands/play.ts'],
      fn: (content) => {
        content = content.replace(/import vibeService from '\.\.\/\.\.\/services\/vibeService\.js';\r?\n/g, '');
        content = content.replace(/import featureFlags from '\.\.\/\.\.\/services\/featureFlags\.js';\r?\n/g, '');
        content = content.replace(/if \(featureFlags\.isEnabled\('feature_vibe_latent'\)\) \{[\s\S]*?\}\r?\n/g, '');
        // Replace vibeService in handleVibe with collaborativeGraph + Deezer
        const oldHandleVibe = `  const vibeItems = await vibeService.generateVibePlaylist(prompt, 6);`;
        const newHandleVibe = `  const related = await collaborativeGraph.getRelatedArtists(prompt, 6);
  const candidateArtists = related.length > 0 ? related.map((r: any) => r.name) : [prompt];
  const vibeItems = await collaborativeGraph.getDeepCutsForArtists(candidateArtists, 6, 2);`;
        content = content.replace(oldHandleVibe, newHandleVibe);
        if (!content.includes('import collaborativeGraph')) {
          content = "import collaborativeGraph from '../../services/collaborativeGraph.js';\n" + content;
        }
        return content;
      }
    },
    {
      files: ['src/web/server.ts', 'OWRADIO-DOCKER/src/web/server.ts'],
      fn: (content) => {
        if (!content.includes('import collaborativeGraph')) {
          content = "import collaborativeGraph from '../services/collaborativeGraph.js';\n" + content;
        }
        return content;
      }
    }
  ];

  for (const t of targets) {
    for (const f of t.files) {
      if (fs.existsSync(f)) {
        let text = fs.readFileSync(f, 'utf8');
        text = t.fn(text);
        fs.writeFileSync(f, text, 'utf8');
        console.log('Cleaned and patched', f);
      }
    }
  }
}

applyCleanups();
