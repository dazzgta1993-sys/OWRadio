import fs from 'node:fs';

function fixFinalErrors() {
  // 1. Fix src/bot/playerUi.ts
  for (const p of ['src/bot/playerUi.ts', 'OWRADIO-DOCKER/src/bot/playerUi.ts']) {
    if (fs.existsSync(p)) {
      let c = fs.readFileSync(p, 'utf8');
      const oldTheme = `    let themeColor = 0x6366f1; // Indigo / Studio Violet
    if (state.radioStation) {
      themeColor = 0x38bdf8; // Sky Blue
    } else if (state.timeCapsuleYear) {
      themeColor = 0xf59e0b; // Gold
    } else if (state.morph?.active) {
      themeColor = 0xec4899; // Magenta
    } else if (track.curatedBy === 'AI Vibe Mix') {
      themeColor = 0xa855f7; // Purple
    } else if (track.curatedBy === 'User Request' || track.isManualRequest) {
      themeColor = track.requestType === 'playlist' ? 0x3b82f6 : 0x10b981;
    }`;

      const newTheme = `    let themeColor = 0x6366f1; // Indigo / Studio Violet
    if (track.curatedBy === 'DJ Harmonic Chain') {
      themeColor = 0xa855f7; // Purple
    } else if (track.curatedBy === 'User Request' || track.isManualRequest) {
      themeColor = track.requestType === 'playlist' ? 0x3b82f6 : 0x10b981;
    }`;

      c = c.replace(oldTheme, newTheme);
      c = c.replace(oldTheme.replace(/\n/g, '\r\n'), newTheme.replace(/\n/g, '\r\n'));
      fs.writeFileSync(p, c, 'utf8');
      console.log('Fixed theme in', p);
    }
  }

  // 2. Fix src/bot/commands/play.ts
  for (const p of ['src/bot/commands/play.ts', 'OWRADIO-DOCKER/src/bot/commands/play.ts']) {
    if (fs.existsSync(p)) {
      let c = fs.readFileSync(p, 'utf8');
      c = c.replace(/item\.reason/g, "(item as any).reason || 'Vibe match'");
      fs.writeFileSync(p, c, 'utf8');
      console.log('Fixed item.reason in', p);
    }
  }

  // 3. Fix src/web/server.ts
  for (const p of ['src/web/server.ts', 'OWRADIO-DOCKER/src/web/server.ts']) {
    if (fs.existsSync(p)) {
      let c = fs.readFileSync(p, 'utf8');
      c = c.replace(/item\.reason/g, "(item as any).reason || 'Vibe match'");
      fs.writeFileSync(p, c, 'utf8');
      console.log('Fixed item.reason in', p);
    }
  }
}

fixFinalErrors();
