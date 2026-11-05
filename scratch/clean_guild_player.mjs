import fs from 'node:fs';

function cleanGuildPlayer(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Remove stationCurator and featureFlags imports
  content = content.replace(/import stationCurator[^\n]+\n/g, '');
  content = content.replace(/import featureFlags[^\n]+\n/g, '');

  // Clean PlayerStatePayload interface
  const ifaceOld = `  storyArc?: ReturnType<typeof stationCurator['getStoryArcState']>;
  radioStation?: ReturnType<typeof stationCurator['getActiveStation']>;
  timeCapsuleYear?: number | null;
  morph?: ReturnType<typeof stationCurator['getMorphState']>;
  audioMeter?: { rms: number; peak: number; bands: number[] };
  brainPills?: any[];
  activeBrainCount?: number;
  totalBrainCount?: number;`;

  const ifaceNew = `  audioMeter?: { rms: number; peak: number; bands: number[] };`;
  content = content.replace(ifaceOld, ifaceNew);

  // Clean getStatePayload return object
  const retOld = `      storyArc: stationCurator.getStoryArcState(),
      radioStation: stationCurator.getActiveStation(),
      timeCapsuleYear: stationCurator.getTimeCapsuleYear(),
      morph: stationCurator.getMorphState(),
      audioMeter: this.broadcastTee.getLiveAudioMeter(),
      brainPills,
      activeBrainCount,
      totalBrainCount: brainPills.length,`;

  const retNew = `      audioMeter: this.broadcastTee.getLiveAudioMeter(),`;
  content = content.replace(retOld, retNew);

  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Cleaned', filePath);
}

cleanGuildPlayer('src/player/GuildPlayer.ts');
cleanGuildPlayer('OWRADIO-DOCKER/src/player/GuildPlayer.ts');
