import collaborativeGraph from '../../services/collaborativeGraph.js';
/**
 * @file play.ts
 * @description Streamlined Slash command handlers for /play and /vibe.
 * Unifies single track search and playlists under one clean /play command with autocomplete.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type GuildMember,
} from 'discord.js';
import type { GuildPlayer } from '../../player/GuildPlayer.js';
import { AudioTrack } from '../../player/AudioTrack.js';
import youtube from '../../services/youtube.js';
import deezer from '../../services/deezer.js';
import linkParser from '../../services/linkParser.js';
import curator from '../../services/curator.js';
import dynamicSettings from '../../services/dynamicSettings.js';
import { normalizeArtist, getTrackDedupeKey } from '../../utils/trackDedupe.js';

export const playCommand = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a song, artist, album, or playlist in voice')
  .addStringOption((opt) =>
    opt
      .setName('query')
      .setDescription('Song title, artist, YouTube URL, Spotify link, or playlist')
      .setRequired(true)
      .setAutocomplete(true)
  );

export const vibeCommand = new SlashCommandBuilder()
  .setName('vibe')
  .setDescription('Generate an instant playlist curated by vibe & genre')
  .addStringOption((opt) =>
    opt
      .setName('prompt')
      .setDescription('Describe the vibe (e.g. "rainy night cyber drive", "90s funk barbecue") or "off" to reset')
      .setRequired(true)
  );

/**
 * Ensures the bot is connected to the user's voice channel while enforcing anti-steal rules.
 */
async function ensureVoiceConnection(
  interaction: ChatInputCommandInteraction,
  player: GuildPlayer
): Promise<boolean> {
  const member = interaction.member as GuildMember;
  const targetChannel = member?.voice?.channel;

  if (!targetChannel) {
    await interaction.editReply('❌ You must be inside a voice channel to use this command!');
    return false;
  }

  const currentChannel = player.getActiveVoiceChannel();
  if (currentChannel && currentChannel.id !== targetChannel.id) {
    // If the bot is actively playing for human listeners in another channel, block non-admins
    const activeListeners = player.getActiveListenerUserIds();
    const isBotAlone = activeListeners.length === 0;

    const hasAdminPerm =
      member.permissions.has(PermissionFlagsBits.ManageChannels) ||
      member.permissions.has(PermissionFlagsBits.Administrator);

    if (!isBotAlone && !hasAdminPerm) {
      await interaction.editReply(
        `❌ The bot is currently playing for listeners in **${currentChannel.name}**. Only server Mods/Admins can move the bot to another channel.`
      );
      return false;
    }
  }

  await player.connectToVoice(targetChannel);
  return true;
}

/**
 * Handle unified /play <query>
 */
export async function handlePlay(
  interaction: ChatInputCommandInteraction,
  player: GuildPlayer
): Promise<void> {
  await interaction.deferReply();

  if (!(await ensureVoiceConnection(interaction, player))) {
    return;
  }

  const member = interaction.member as GuildMember;
  if (dynamicSettings.getBoolean('curation_dj_only_queue', false)) {
    const hasAdminPerm =
      member.permissions.has(PermissionFlagsBits.ManageChannels) ||
      member.permissions.has(PermissionFlagsBits.Administrator);
    if (!hasAdminPerm) {
      await interaction.editReply('🔒 **DJ-Only Queue is enabled.** Only server Mods/Admins can queue songs right now.');
      return;
    }
  }

  const query = interaction.options.getString('query', true).trim();
  const userId = interaction.user.id;
  const parsedLink = linkParser.parseMusicLink(query);

  // --- Case 1: YouTube Link (Video or Playlist) ---
  if (parsedLink?.provider === 'youtube') {
    if (parsedLink.type === 'playlist' || (!parsedLink.id && parsedLink.playlistId)) {
      const playlistId = parsedLink.playlistId || parsedLink.id;
      const ytTracks = await youtube.getPlaylistTracks(playlistId, 50);
      if (ytTracks.length === 0) {
        await interaction.editReply(`❌ Could not resolve YouTube playlist from: ${query}`);
        return;
      }

      const tracks = ytTracks.map((meta) =>
        AudioTrack.fromYouTube(
          meta,
          userId,
          true,
          'User Request',
          `YouTube Playlist by ${interaction.user.username}`,
          'playlist',
          `yt_pl_${playlistId}`,
          `YouTube Playlist (${interaction.user.username})`
        )
      );
      const enqueuedCount = await player.enqueueBatch(tracks);

      const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle('▶️ Enqueued YouTube Playlist')
        .setDescription(`Successfully blended **${enqueuedCount} tracks** from YouTube into the queue.`)
        .setThumbnail(ytTracks[0].artworkThumbUrl);

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // Single YouTube video
    const ytMeta = await youtube.getTrack(parsedLink.id);
    if (ytMeta) {
      const audioTrack = AudioTrack.fromYouTube(
        ytMeta,
        userId,
        true,
        'User Request',
        `Requested by ${interaction.user.username}`,
        'single'
      );
      await player.enqueue(audioTrack);

      const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle('▶️ Enqueued from YouTube')
        .setDescription(`**${audioTrack.title}**\nby **${audioTrack.artist}**`)
        .setThumbnail(audioTrack.artworkThumbUrl)
        .addFields(
          {
            name: 'Duration',
            value: `${Math.floor(audioTrack.durationSec / 60)}:${String(audioTrack.durationSec % 60).padStart(2, '0')}`,
            inline: true,
          },
          { name: 'Requested By', value: `<@${userId}>`, inline: true }
        );

      await interaction.editReply({ embeds: [embed] });
      return;
    }
  }

  // --- Case 2: Deezer Album or Playlist Link ---
  if (parsedLink?.provider === 'deezer' && (parsedLink.type === 'album' || parsedLink.type === 'playlist')) {
    let tracksMeta: any[] = [];
    let playlistTitle = 'Playlist';
    if (parsedLink.type === 'album') {
      tracksMeta = await deezer.getAlbumTracks(parsedLink.id);
      playlistTitle = 'Deezer Album';
    } else {
      tracksMeta = await deezer.getPlaylistTracks(parsedLink.id);
      playlistTitle = 'Deezer Playlist';
    }

    if (tracksMeta.length > 0) {
      const plTracks = tracksMeta.map((meta) =>
        AudioTrack.fromDeezer(
          meta,
          userId,
          true,
          'User Request',
          `Enqueued by ${interaction.user.username}`,
          'playlist',
          `dz_pl_${parsedLink.id}`,
          `${playlistTitle} (${interaction.user.username})`
        )
      );
      const enqueuedCount = await player.enqueueBatch(plTracks);

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`📑 Enqueued ${playlistTitle}`)
        .setDescription(`Successfully blended **${enqueuedCount} tracks** into the queue.`)
        .setThumbnail(tracksMeta[0].artworkThumbUrl);

      await interaction.editReply({ embeds: [embed] });
      return;
    }
  }

  // --- Case 3: Deezer Single Track Link ---
  if (parsedLink?.provider === 'deezer' && parsedLink.type === 'track') {
    const dzMeta = await deezer.getTrack(parsedLink.id);
    if (dzMeta) {
      const audioTrack = AudioTrack.fromDeezer(
        dzMeta,
        userId,
        true,
        'User Request',
        `Requested by ${interaction.user.username}`,
        'single'
      );
      await player.enqueue(audioTrack);

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🎵 Enqueued Track')
        .setDescription(`**${audioTrack.title}**\nby **${audioTrack.artist}**`)
        .setThumbnail(audioTrack.artworkThumbUrl);

      await interaction.editReply({ embeds: [embed] });
      return;
    }
  }

  // --- Case 4: Freeform Search Query (YouTube -> Deezer) ---
  let audioTrack: AudioTrack | null = null;
  const ytResults = await youtube.searchTracks(query, 1);
  if (ytResults.length > 0) {
    audioTrack = AudioTrack.fromYouTube(
      ytResults[0],
      userId,
      true,
      'YouTube Search',
      `Requested by ${interaction.user.username}`,
      'single'
    );
  } else {
    const dzResults = await deezer.searchTracks(query, 1);
    if (dzResults.length > 0) {
      audioTrack = AudioTrack.fromDeezer(
        dzResults[0],
        userId,
        true,
        'User Request',
        `Requested by ${interaction.user.username}`,
        'single'
      );
    }
  }

  if (!audioTrack) {
    await interaction.editReply(`❌ Could not find track matching: **${query}**`);
    return;
  }

  await player.enqueue(audioTrack);

  const isYt = audioTrack.id.startsWith('yt_');
  const embed = new EmbedBuilder()
    .setColor(isYt ? 0xff0000 : 0x5865f2)
    .setTitle(isYt ? '▶️ Enqueued Track' : '🎵 Enqueued Track')
    .setDescription(`**${audioTrack.title}**\nby **${audioTrack.artist}**`)
    .setThumbnail(audioTrack.artworkThumbUrl)
    .addFields(
      {
        name: 'Duration',
        value: `${Math.floor(audioTrack.durationSec / 60)}:${String(audioTrack.durationSec % 60).padStart(2, '0')}`,
        inline: true,
      },
      { name: 'Requested By', value: `<@${userId}>`, inline: true }
    );

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Handle /vibe <prompt>
 */
export async function handleVibe(
  interaction: ChatInputCommandInteraction,
  player: GuildPlayer
): Promise<void> {
  await interaction.deferReply();

  if (!(await ensureVoiceConnection(interaction, player))) {
    return;
  }

  const prompt = interaction.options.getString('prompt', true).trim();
  const userId = interaction.user.id;

  // 1. Check if user wants to turn off / disengage vibe steering
  const isOffCommand = ['off', 'clear', 'reset', 'none', 'stop', 'disable'].includes(prompt.toLowerCase());
  if (isOffCommand) {
        await player.recurateAutoplayBuffer();
    await interaction.editReply({
      content: '✨ **Latent Vibe Steering Disengaged.** Autoplay buffer restored to natural room consensus.',
      components: [],
    });
    return;
  }

  // 2. If 384-d Latent Steering is enabled, embed prompt and set real-time steering vector
  let isSteeringEngaged = false;

  // 3. Purge stale unplayed autoplay tracks so the new vibe takes effect IMMEDIATELY
  await player.recurateAutoplayBuffer();

  const related = await collaborativeGraph.getRelatedArtists(prompt, 6);
  const candidateArtists = related.length > 0 ? related.map((r: any) => r.name) : [prompt];
  const vibeItems = await collaborativeGraph.getDeepCutsForArtists(candidateArtists, 6, 2);

  if (vibeItems.length === 0) {
    if (isSteeringEngaged) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_vibe_steer_off')
          .setLabel('⏹️ Disengage Vibe Steering')
          .setStyle(ButtonStyle.Danger)
      );
      await interaction.editReply({
        content: `✨ Latent steering vector set for: **"${prompt}"**! Autoplay buffer recurated toward this aesthetic.`,
        components: [row],
      });
      return;
    }
    await interaction.editReply(`❌ Could not find tracks matching vibe: "${prompt}"`);
    return;
  }

  const queuedSongIds = new Set<string>();
  const queuedArtists = new Set<string>();
  const queuedDedupeKeys = new Set<string>();
  const queuedLanguages = new Set<string>();

  if (player.currentTrack) {
    queuedSongIds.add(player.currentTrack.id);
    queuedArtists.add(player.currentTrack.artist.toLowerCase());
    const normCurArt = normalizeArtist(player.currentTrack.artist).replace(/\s+/g, '');
    if (normCurArt) queuedArtists.add(normCurArt);
    queuedDedupeKeys.add(getTrackDedupeKey(player.currentTrack.title, player.currentTrack.artist));
    const lang = 'en';
    if (lang !== 'en') queuedLanguages.add(lang);
  }

  for (const q of player.getQueueList()) {
    queuedSongIds.add(q.id);
    queuedArtists.add(q.artist.toLowerCase());
    const normQArt = normalizeArtist(q.artist).replace(/\s+/g, '');
    if (normQArt) queuedArtists.add(normQArt);
    queuedDedupeKeys.add(getTrackDedupeKey(q.title, q.artist));
    const lang = 'en';
    if (lang !== 'en') queuedLanguages.add(lang);
  }

  let queuedCount = 0;
  for (const item of vibeItems) {
    const itemNormArtist = normalizeArtist(item.artist).replace(/\s+/g, '');
    if (itemNormArtist && queuedArtists.has(itemNormArtist)) continue;

    const ytResults = await youtube.searchTracks(`${item.artist} ${item.title}`, 1);
    const ytCandidate = ytResults[0];

    if (ytCandidate) {
      const candKey = getTrackDedupeKey(ytCandidate.title, ytCandidate.artist);
      const candNormArt = normalizeArtist(ytCandidate.artist).replace(/\s+/g, '');

      if (
        !queuedDedupeKeys.has(candKey) &&
        (!candNormArt || !queuedArtists.has(candNormArt)) &&
        curator.isTrackEligibleForAutoplay(
          ytCandidate.id,
          ytCandidate.artist,
          queuedSongIds,
          queuedArtists,
          ytCandidate.title,
          queuedDedupeKeys,
          undefined,
          queuedLanguages
        )
      ) {
        const track = AudioTrack.fromYouTube(
          ytCandidate,
          userId,
          true,
          'AI Vibe Mix',
          (item as any).reason || 'Vibe match',
          'playlist',
          `vibe_${prompt.toLowerCase().replace(/\s+/g, '_')}`,
          `Vibe: "${prompt}"`
        );
        await player.enqueue(track);
        queuedSongIds.add(ytCandidate.id);
        queuedArtists.add(ytCandidate.artist.toLowerCase());
        if (candNormArt) queuedArtists.add(candNormArt);
        if (itemNormArtist) queuedArtists.add(itemNormArtist);
        queuedDedupeKeys.add(candKey);
        const candLang = 'en';
        if (candLang !== 'en') queuedLanguages.add(candLang);
        queuedCount++;
        continue;
      }
    }

    const searchRes = await deezer.searchTracks(`${item.artist} ${item.title}`, 1);
    const meta = searchRes[0];
    if (meta) {
      const metaKey = getTrackDedupeKey(meta.title, meta.artist);
      const metaNormArt = normalizeArtist(meta.artist).replace(/\s+/g, '');

      if (
        !queuedDedupeKeys.has(metaKey) &&
        (!metaNormArt || !queuedArtists.has(metaNormArt)) &&
        curator.isTrackEligibleForAutoplay(
          meta.id,
          meta.artist,
          queuedSongIds,
          queuedArtists,
          meta.title,
          queuedDedupeKeys,
          meta.durationSec,
          queuedLanguages
        )
      ) {
        const track = AudioTrack.fromDeezer(
          meta,
          userId,
          true,
          'AI Vibe Mix',
          (item as any).reason || 'Vibe match',
          'playlist',
          `vibe_${prompt.toLowerCase().replace(/\s+/g, '_')}`,
          `Vibe: "${prompt}"`
        );
        await player.enqueue(track);
        queuedSongIds.add(meta.id);
        queuedArtists.add(meta.artist.toLowerCase());
        if (metaNormArt) queuedArtists.add(metaNormArt);
        if (itemNormArtist) queuedArtists.add(itemNormArtist);
        queuedDedupeKeys.add(metaKey);
        const metaLang = 'en';
        if (metaLang !== 'en') queuedLanguages.add(metaLang);
        queuedCount++;
      }
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('✨ AI Vibe Mix & Latent Steering')
    .setDescription(
      `Vibe prompt: **"${prompt}"**\n` +
      `Enqueued **${queuedCount} tracks** matching this aesthetic.\n\n` +
      (isSteeringEngaged
        ? '🛰️ **384-d Latent Steering:** `ACTIVE` (Autoplay queue recurated to this vector)'
        : '⚡ *Standard Playlist Mode (384-d steering toggle is OFF in settings)*')
    )
    .setFooter({ text: 'OWRadio Vibe Engine • Type /vibe off to disengage' });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (isSteeringEngaged) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_vibe_steer_off')
          .setLabel('⏹️ Disengage Vibe Steering')
          .setStyle(ButtonStyle.Danger)
      )
    );
  }

  await interaction.editReply({ embeds: [embed], components });
}

export default {
  playCommand,
  vibeCommand,
  handlePlay,
  handleVibe,
};
