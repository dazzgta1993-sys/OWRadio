/**
 * @file bot/client.ts
 * @description Rebuilt Discord Bot Client & Studio Slash Command Suite for OWRadio v3.0.
 * Every single file strictly under 300 lines of code.
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  GuildMember,
  Events,
} from 'discord.js';
import { joinVoiceChannel, DiscordGatewayAdapterCreator } from '@discordjs/voice';
import config from '../config.js';
import globalPlayer from '../player/GuildPlayer.js';
import AudioTrack from '../player/AudioTrack.js';
import { resolveQueryToTracks, searchArtistDiscography } from '../services/searchService.js';
import { getOfficialCharts } from '../services/itunes.js';
import { getDeezerChartTracks } from '../services/deezer.js';
import { buildNowPlayingPayload } from './playerUi.js';
import { runAutoResume } from './autoResume.js';
import { VibeMode, VibeEngineSource } from '../services/vibeEngine.js';

export const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
});

let activeVoiceChannelId: string | null = null;

const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Play or queue a studio song, album, Spotify link, or YouTube URL')
    .addStringOption((opt) => opt.setName('query').setDescription('Song title, artist, or URL').setRequired(true))
    .addStringOption((opt) => opt.setName('source').setDescription('Catalog engine').addChoices(
      { name: '🌐 Multi-Engine Auto', value: 'auto' }, { name: '🔴 YouTube Music', value: 'ytmusic' },
      { name: '🟣 Deezer Studio', value: 'deezer' }, { name: '🍎 Apple Music', value: 'apple' }, { name: '▶️ YouTube Video', value: 'youtube' }
    ))
    .addStringOption((opt) => opt.setName('mode').setDescription('Play immediately or queue').addChoices(
      { name: '▶️ Play Now', value: 'now' }, { name: '➕ Add to Queue', value: 'queue' }
    )),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show live interactive Studio Player & Deck 2/3 status'),
  new SlashCommandBuilder().setName('queue').setDescription('View Now Playing, Deck 2, Deck 3, and Upcoming Queue'),
  new SlashCommandBuilder().setName('charts').setDescription('Load & play Official Top 40 Charts')
    .addStringOption((opt) => opt.setName('country').setDescription('Chart region').setRequired(true).addChoices(
      { name: '🇬🇧 UK Official Top 40', value: 'gb' }, { name: '🇺🇸 US Hot 100', value: 'us' }, { name: '🌍 Global Deezer Top', value: 'global' }
    )),
  new SlashCommandBuilder().setName('discography').setDescription('Explore canonical MusicBrainz Studio Albums')
    .addStringOption((opt) => opt.setName('artist').setDescription('Artist name').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip to the pre-warmed track in Deck 2'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause studio broadcast'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume studio broadcast'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder().setName('volume').setDescription('Set broadcast volume (0-200%)')
    .addIntegerOption((opt) => opt.setName('level').setDescription('Volume (0-200)').setRequired(true)),
  new SlashCommandBuilder().setName('vibe').setDescription('Configure Multi-Cloud Vibe Engine & Autoplay')
    .addStringOption((opt) => opt.setName('mode').setDescription('Vibe progression mode').addChoices(
      { name: '⚓ Smart Vibe (Lock Artist)', value: 'balanced' }, { name: '🎯 Artist Deep Dive', value: 'deep_dive' },
      { name: '🤝 Collabs Circle', value: 'collabs' }, { name: '🌌 Wild Discovery', value: 'discovery' }
    ))
    .addStringOption((opt) => opt.setName('engine').setDescription('Recommendation platform').addChoices(
      { name: '🌐 Auto Multi-Cloud', value: 'auto' }, { name: '🟣 Deezer Studio Radio', value: 'deezer' },
      { name: '🔴 YouTube Music', value: 'ytmusic' }, { name: '🏛️ MusicBrainz Canonical', value: 'musicbrainz' },
      { name: '🍎 Apple Music', value: 'apple' }, { name: '📊 Official Charts', value: 'charts' }
    ))
    .addBooleanOption((opt) => opt.setName('autoplay').setDescription('Turn 24/7 Autoplay ON or OFF')),
].map((c) => c.toJSON());

async function updateDiscordVoiceStatus(statusText: string): Promise<void> {
  if (!activeVoiceChannelId || !discordClient.isReady()) return;
  try {
    await discordClient.rest.put(`/channels/${activeVoiceChannelId}/voice-status` as any, { body: { status: statusText.slice(0, 480) } });
  } catch {}
}

globalPlayer.on('trackStart', (track) => void updateDiscordVoiceStatus(`🎶 ${track.artist} - ${track.title}`));

function connectMemberVoiceIfNeeded(member: GuildMember | null): void {
  const voiceChannel = member?.voice?.channel;
  if (voiceChannel && member?.guild) {
    activeVoiceChannelId = voiceChannel.id;
    const conn = joinVoiceChannel({
      channelId: voiceChannel.id, guildId: member.guild.id,
      adapterCreator: member.guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator, selfDeaf: true,
    });
    globalPlayer.attachVoiceConnection(conn);
  }
}

discordClient.once(Events.ClientReady, async () => {
  console.log(`🤖 [Discord] Logged in as ${discordClient.user?.tag}`);
  if (config.DISCORD_TOKEN && discordClient.user) {
    const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
    try {
      if (config.GUILD_ID) {
        await rest.put(Routes.applicationCommands(discordClient.user.id), { body: [] }).catch(() => {});
        await rest.put(Routes.applicationGuildCommands(discordClient.user.id, config.GUILD_ID), { body: commands });
      } else {
        await rest.put(Routes.applicationCommands(discordClient.user.id), { body: commands });
      }
      console.log(`✅ [Discord] Synced ${commands.length} studio slash commands.`);
    } catch (err) {
      console.warn('⚠️ [Discord] Command registration notice:', (err as Error).message);
    }
  }
  await runAutoResume(discordClient);
});

discordClient.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      switch (interaction.customId) {
        case 'owr_pause_resume':
          if (globalPlayer.isPaused) globalPlayer.resume(); else if (globalPlayer.isPlaying) globalPlayer.pause(); else void globalPlayer.playNext();
          break;
        case 'owr_skip': globalPlayer.skip(); break;
        case 'owr_stop': globalPlayer.stop(); void updateDiscordVoiceStatus(''); break;
        case 'owr_like': globalPlayer.voteCurrentTrack('up'); break;
        case 'owr_dislike': globalPlayer.voteCurrentTrack('down'); break;
        case 'owr_shuffle':
          if (globalPlayer.queue.length > 1) {
            for (let i = globalPlayer.queue.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [globalPlayer.queue[i], globalPlayer.queue[j]] = [globalPlayer.queue[j], globalPlayer.queue[i]];
            }
          } else {
            globalPlayer.deck2Track = null; globalPlayer.deck3Track = null;
            if (globalPlayer.isPlaying) void globalPlayer.prewarmDecks();
          }
          globalPlayer.emitStateUpdate(); break;
        case 'owr_loop':
          globalPlayer.loopMode = globalPlayer.loopMode === 'off' ? 'queue' : globalPlayer.loopMode === 'queue' ? 'track' : 'off';
          globalPlayer.emitStateUpdate(); break;
        case 'owr_autoplay':
          globalPlayer.autoplay = !globalPlayer.autoplay;
          if (globalPlayer.autoplay && !globalPlayer.isPlaying) void globalPlayer.playNext();
          globalPlayer.emitStateUpdate(); break;
      }
      await interaction.update(buildNowPlayingPayload(globalPlayer));
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;

    if (cmd === 'play') {
      await interaction.deferReply();
      connectMemberVoiceIfNeeded(interaction.member as GuildMember | null);
      const query = interaction.options.getString('query', true);
      const source = interaction.options.getString('source') || 'auto';
      const mode = interaction.options.getString('mode') || 'now';
      const { tracks, collectionName } = await resolveQueryToTracks(query, interaction.user.username, source);
      if (tracks.length === 0) { await interaction.editReply(`⚠️ No studio tracks found for **${query}**.`); return; }
      if (mode === 'queue') {
        globalPlayer.enqueueMany(tracks);
      } else {
        const [first, ...rest] = tracks;
        await globalPlayer.playNow(first);
        if (rest.length > 0) globalPlayer.enqueueMany(rest);
      }
      await interaction.editReply({ content: collectionName ? `📀 Loaded **${collectionName}**` : undefined, ...buildNowPlayingPayload(globalPlayer) });
    } else if (cmd === 'nowplaying') {
      await interaction.reply(buildNowPlayingPayload(globalPlayer));
    } else if (cmd === 'queue') {
      const snap = globalPlayer.getStateSnapshot();
      const lines: string[] = [];
      if (snap.nowPlaying) lines.push(`🔊 **Deck 1 (Now Playing):** ${snap.nowPlaying.artist} — **${snap.nowPlaying.title}** (\`${snap.nowPlaying.durationFormatted}\`)`);
      if (snap.deck2) lines.push(`⚡ **Deck 2 (Ready):** ${snap.deck2.artist} — *${snap.deck2.title}*`);
      if (snap.deck3) lines.push(`🎯 **Deck 3 (Cued):** ${snap.deck3.artist} — *${snap.deck3.title}*`);
      const extra = snap.queue.slice(0, 8).map((t, i) => `\`${i + 1}.\` ${t.artist} — ${t.title} (\`${t.durationFormatted}\`)`);
      if (extra.length > 0) lines.push('\n**Upcoming Queue:**', ...extra);
      await interaction.reply({ content: lines.join('\n') || 'Queue is currently empty.', ephemeral: true });
    } else if (cmd === 'charts') {
      await interaction.deferReply();
      connectMemberVoiceIfNeeded(interaction.member as GuildMember | null);
      const country = interaction.options.getString('country', true);
      const raw = country === 'global' ? await getDeezerChartTracks(15) : await getOfficialCharts(country as 'gb' | 'us', 15);
      const tracks = raw.map((t: any) => new AudioTrack({
        deezerId: t.deezerId || t.id, title: t.title, artist: t.artist, album: t.album,
        duration: t.duration || 0, artworkUrl: t.cover, source: country === 'global' ? 'deezer' : 'apple',
        requestedBy: interaction.user.username,
      }));
      if (tracks.length > 0) {
        const [first, ...rest] = tracks;
        await globalPlayer.playNow(first);
        if (rest.length > 0) globalPlayer.enqueueMany(rest);
      }
      await interaction.editReply({ content: `📊 Loaded **${country.toUpperCase()} Top Charts** (${tracks.length} hits)`, ...buildNowPlayingPayload(globalPlayer) });
    } else if (cmd === 'discography') {
      await interaction.deferReply();
      const artist = interaction.options.getString('artist', true);
      const data = await searchArtistDiscography(artist);
      const studios = data.albums.filter((a) => a.category === 'Studio Albums').slice(0, 12);
      const list = (studios.length ? studios : data.albums.slice(0, 12)).map((a) => `• **${a.title}** (${a.year || 'N/A'}) — *${a.category}*`).join('\n');
      await interaction.editReply(`💿 **${data.artist} — Canonical Studio Discography (MusicBrainz)**\n${list || 'No studio albums found.'}`);
    } else if (cmd === 'skip') {
      globalPlayer.skip(); await interaction.reply(buildNowPlayingPayload(globalPlayer));
    } else if (cmd === 'pause') {
      globalPlayer.pause(); await interaction.reply({ content: '⏸️ Paused playback.', ephemeral: true });
    } else if (cmd === 'resume') {
      globalPlayer.resume(); await interaction.reply({ content: '▶️ Resumed playback.', ephemeral: true });
    } else if (cmd === 'stop') {
      globalPlayer.stop(); void updateDiscordVoiceStatus(''); await interaction.reply({ content: '⏹️ Stopped playback and cleared queue.', ephemeral: true });
    } else if (cmd === 'volume') {
      const updated = globalPlayer.setVolume(interaction.options.getInteger('level', true));
      await interaction.reply({ content: `🔊 Volume set to **${updated}%**.`, ephemeral: true });
    } else if (cmd === 'vibe') {
      const mode = interaction.options.getString('mode') as VibeMode | null;
      const engine = interaction.options.getString('engine') as VibeEngineSource | null;
      const autoOpt = interaction.options.getBoolean('autoplay');
      if (typeof autoOpt === 'boolean') globalPlayer.autoplay = autoOpt;
      globalPlayer.setVibeConfig(mode || undefined, engine || undefined);
      await interaction.reply({
        content: `🎛️ **Vibe Updated** — Mode: **${globalPlayer.vibeMode.toUpperCase()}** • Source: **${globalPlayer.vibeEngineSource.toUpperCase()}** • Autoplay: **${globalPlayer.autoplay ? 'ON' : 'OFF'}**`,
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error('❌ [Discord] Interaction error:', err);
  }
});

export async function startDiscordBot(): Promise<void> {
  if (!config.isDiscordEnabled) return;
  await discordClient.login(config.DISCORD_TOKEN);
}
