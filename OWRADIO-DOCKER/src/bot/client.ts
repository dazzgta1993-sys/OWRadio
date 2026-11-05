/**
 * @file bot/client.ts
 * @description Clean Discord Bot Client & Slash Command Handler for OWRadio.
 * Supports /play, /skip, /pause, /resume, /stop, /vibe, /volume, and interactive Player Buttons.
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  GuildMember,
  Routes as DiscordRoutes,
} from 'discord.js';
import { joinVoiceChannel, DiscordGatewayAdapterCreator } from '@discordjs/voice';
import config from '../config.js';
import globalPlayer from '../player/GuildPlayer.js';
import { resolveQueryToTracks } from '../services/searchService.js';
import { buildNowPlayingPayload } from './playerUi.js';
import { runAutoResume } from './autoResume.js';
import { VibeMode, VibeEngineSource } from '../services/vibeEngine.js';

export const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

let activeVoiceChannelId: string | null = null;

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a studio song, album, Spotify link, or YouTube URL')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('Song title, artist, Spotify or YouTube URL').setRequired(true)
    ),
  new SlashCommandBuilder().setName('skip').setDescription('Skip to the next track in Deck 2'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set broadcast & voice volume (0-200%)')
    .addIntegerOption((opt) =>
      opt.setName('level').setDescription('Volume percentage (0-200)').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('vibe')
    .setDescription('Configure the real Multi-Platform Vibe Engine')
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('Vibe progression mode')
        .addChoices(
          { name: 'Balanced (Anchor + Similar)', value: 'balanced' },
          { name: 'Deep Dive (Same Artist Catalog)', value: 'deep_dive' },
          { name: 'Collabs & Circle', value: 'collabs' },
          { name: 'Wild Discovery', value: 'discovery' }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName('engine')
        .setDescription('Metadata & radio source')
        .addChoices(
          { name: 'Auto Multi-Cloud (Deezer + YTMusic + Apple)', value: 'auto' },
          { name: 'Deezer Artist Radio', value: 'deezer' },
          { name: 'YouTube Music Radio', value: 'ytmusic' },
          { name: 'MusicBrainz Studio Discography', value: 'musicbrainz' },
          { name: 'Official UK/US Top 40 Charts', value: 'charts' }
        )
    ),
].map((c) => c.toJSON());

async function updateDiscordVoiceStatus(statusText: string): Promise<void> {
  if (!activeVoiceChannelId || !discordClient.isReady()) return;
  try {
    await discordClient.rest.put(`/channels/${activeVoiceChannelId}/voice-status` as any, {
      body: { status: statusText.slice(0, 480) },
    });
  } catch {}
}

globalPlayer.on('trackStart', (track) => {
  void updateDiscordVoiceStatus(`🎶 ${track.artist} - ${track.title}`);
});

discordClient.once('ready', async () => {
  console.log(`🤖 [Discord] Logged in as ${discordClient.user?.tag}`);
  if (config.DISCORD_TOKEN && discordClient.user) {
    const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
    try {
      if (config.GUILD_ID) {
        await rest.put(Routes.applicationGuildCommands(discordClient.user.id, config.GUILD_ID), {
          body: commands,
        });
      } else {
        await rest.put(DiscordRoutes.applicationCommands(discordClient.user.id), {
          body: commands,
        });
      }
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
          if (globalPlayer.isPaused) globalPlayer.resume();
          else globalPlayer.pause();
          break;
        case 'owr_skip':
          globalPlayer.skip();
          break;
        case 'owr_stop':
          globalPlayer.stop();
          void updateDiscordVoiceStatus('');
          break;
        case 'owr_like':
          globalPlayer.voteCurrentTrack('up');
          break;
        case 'owr_dislike':
          globalPlayer.voteCurrentTrack('down');
          break;
      }
      await interaction.update(buildNowPlayingPayload(globalPlayer));
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'play') {
      await interaction.deferReply();
      const query = interaction.options.getString('query', true);
      const member = interaction.member as GuildMember | null;
      const voiceChannel = member?.voice?.channel;

      if (voiceChannel && interaction.guild) {
        activeVoiceChannelId = voiceChannel.id;
        const conn = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: interaction.guild.id,
          adapterCreator: interaction.guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
          selfDeaf: true,
        });
        globalPlayer.attachVoiceConnection(conn);
      }

      const { tracks, collectionName } = await resolveQueryToTracks(query, interaction.user.username);
      if (tracks.length === 0) {
        await interaction.editReply(`⚠️ No studio tracks found for **${query}**.`);
        return;
      }

      if (tracks.length === 1) {
        await globalPlayer.playNow(tracks[0]);
      } else {
        const [first, ...rest] = tracks;
        await globalPlayer.playNow(first);
        globalPlayer.enqueueMany(rest);
      }

      await interaction.editReply({
        content: collectionName ? `📀 Loaded **${collectionName}**` : undefined,
        ...buildNowPlayingPayload(globalPlayer),
      });
    } else if (interaction.commandName === 'skip') {
      globalPlayer.skip();
      await interaction.reply({ content: '⏭️ Skipped to next track.', ephemeral: true });
    } else if (interaction.commandName === 'pause') {
      globalPlayer.pause();
      await interaction.reply({ content: '⏸️ Paused playback.', ephemeral: true });
    } else if (interaction.commandName === 'resume') {
      globalPlayer.resume();
      await interaction.reply({ content: '▶️ Resumed playback.', ephemeral: true });
    } else if (interaction.commandName === 'stop') {
      globalPlayer.stop();
      void updateDiscordVoiceStatus('');
      await interaction.reply({ content: '⏹️ Stopped playback and cleared queue.', ephemeral: true });
    } else if (interaction.commandName === 'volume') {
      const lvl = interaction.options.getInteger('level', true);
      const updated = globalPlayer.setVolume(lvl);
      await interaction.reply({ content: `🔊 Volume set to **${updated}%**.`, ephemeral: true });
    } else if (interaction.commandName === 'vibe') {
      const mode = interaction.options.getString('mode') as VibeMode | null;
      const engine = interaction.options.getString('engine') as VibeEngineSource | null;
      globalPlayer.setVibeConfig(mode || undefined, engine || undefined);
      await interaction.reply({
        content: `🎛️ Vibe updated — Mode: **${globalPlayer.vibeMode.toUpperCase()}** | Engine: **${globalPlayer.vibeEngineSource.toUpperCase()}**`,
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error('❌ [Discord] Interaction error:', err);
  }
});

export async function startDiscordBot(): Promise<void> {
  if (!config.isDiscordEnabled) {
    console.log('ℹ️ [Discord] No DISCORD_TOKEN set — running in Standalone Web Radio Mode.');
    return;
  }
  await discordClient.login(config.DISCORD_TOKEN);
}
