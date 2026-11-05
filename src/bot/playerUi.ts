/**
 * @file bot/playerUi.ts
 * @description Clean Discord Now Playing Studio Embed & Interactive Control Buttons (2 Action Rows).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { GuildPlayer } from '../player/GuildPlayer.js';

export function buildNowPlayingPayload(player: GuildPlayer) {
  const track = player.currentTrack;
  if (!track) {
    const idleEmbed = new EmbedBuilder()
      .setColor(0x7c3aed)
      .setTitle('📻 OWRadio Studio — Ready')
      .setDescription('Use `/play`, `/charts`, or the Web Studio Dashboard (`http://localhost:8091`) to start streaming 100% real studio audio.');
    return { embeds: [idleEmbed], components: [] };
  }

  const elapsed = player.getElapsedSeconds();
  const dur = track.duration || 0;
  const pct = dur > 0 ? Math.min(1, Math.max(0, elapsed / dur)) : 0;
  const filled = Math.round(pct * 16);
  const bar = '▬'.repeat(filled) + '🔘' + '▬'.repeat(Math.max(0, 16 - filled));

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
  };

  const lines = [
    `**Artist:** ${track.artist}`,
    track.album ? `**Album:** ${track.album}${track.releaseYear ? ` (${track.releaseYear})` : ''}` : '',
    track.vibeReason ? `**Vibe:** ${track.vibeReason}` : `**Anchor:** ⚓ ${player.vibeAnchorArtist || track.artist}`,
    '',
    `\`${formatTime(elapsed)}\` ${bar} \`${track.formattedDuration}\``,
  ].filter(Boolean);

  if (player.deck2Track) {
    lines.push(`\n**⚡ Deck 2 (Ready):** ${player.deck2Track.artist} — *${player.deck2Track.title}*`);
  }
  if (player.deck3Track) {
    lines.push(`**🎯 Deck 3 (Cued):** ${player.deck3Track.artist} — *${player.deck3Track.title}*`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle(`🎶 ${track.title}`.slice(0, 250))
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({
      text: `Vibe: ${player.vibeMode.toUpperCase()} • Source: ${player.vibeEngineSource.toUpperCase()} • Autoplay: ${player.autoplay ? 'ON' : 'OFF'} • Loop: ${player.loopMode.toUpperCase()} • Vol: ${player.broadcastTee.getVolumePercent()}%`,
    });

  if (track.artworkUrl && track.artworkUrl.startsWith('http')) {
    embed.setThumbnail(track.artworkUrl);
  }

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('owr_pause_resume')
      .setLabel(player.isPaused ? 'Resume' : 'Pause')
      .setEmoji(player.isPaused ? '▶️' : '⏸️')
      .setStyle(player.isPaused ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('owr_skip')
      .setLabel('Skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('owr_stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('owr_like')
      .setLabel('Lock Vibe')
      .setEmoji('👍')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('owr_dislike')
      .setLabel('Skip & Cool')
      .setEmoji('👎')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('owr_shuffle')
      .setLabel('Shuffle Decks')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('owr_loop')
      .setLabel(`Loop: ${player.loopMode.toUpperCase()}`)
      .setEmoji('🔁')
      .setStyle(player.loopMode !== 'off' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('owr_autoplay')
      .setLabel(`Autoplay: ${player.autoplay ? 'ON' : 'OFF'}`)
      .setEmoji('🤖')
      .setStyle(player.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}
