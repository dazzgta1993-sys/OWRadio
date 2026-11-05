# 📻 OWRadio — 24/7 Web Radio & Discord Audio Engine

> A lightweight, high-fidelity 24/7 internet radio station and Discord music bot powered by **YouTube Music**, **Deezer**, and **MusicBrainz**.
> Broadcast a continuous audio stream to web browsers and media players while streaming studio-quality music to Discord voice channels.

---

## 🌟 Features

- **🎵 Official Studio Audio:** Searches **YouTube Music** first for pristine, official album tracks with no music video sketches, dialogue, or applause.
- **📻 24/7 Live Web Stream:** Listen in your web browser, VLC, iPhone/Android, or media player via continuous MP3 broadcast (`/stream.mp3`).
- **🎧 Responsive Web Dashboard:** Search Deezer and YouTube, add songs to the queue, and see live album artwork from any device.
- **🤖 Sleek Discord Bot:** Plays directly in Discord voice channels with an auto-updating interactive player card in chat.
- **⚡ Pro DJ Dual-Deck Engine:** Pre-buffers upcoming songs in RAM across dual decks with 1.0-second equal-power crossfades so the music never stops.
- **🧠 Smart Autoplay:** When the user queue runs out, it automatically picks cohesive tracks matching your room's taste using Deezer and MusicBrainz discographies.
- **🚀 Ultra Lightweight:** Completely zero-AI overhead — runs in under 150 MB of RAM with instant startup.

---

## 🚀 Quick Start (3 Steps)

### 1. Clone & Install
```bash
git clone https://github.com/dazzgta1993-sys/OWRadio.git
cd OWRadio
npm install
```

### 2. Configure Credentials
Copy the sample environment file:
```bash
cp .env.example .env
```
Open `.env` in any text editor and add your **Discord Bot Token**:
```env
DISCORD_TOKEN=your_bot_token_here
```
*(Get your bot token in 1 minute from the [Discord Developer Portal](https://discord.com/developers/applications) under **Bot** ➔ **Reset Token**).*

### 3. Start the Station
```bash
npm start
```

- **Web Dashboard:** [http://localhost:8091](http://localhost:8091)
- **Live MP3 Stream:** [http://localhost:8091/stream.mp3](http://localhost:8091/stream.mp3)

---

## 💬 Discord Slash Commands

| Command | Description |
| :--- | :--- |
| **`/play <song or link>`** | Plays or queues any song, album, or playlist from YouTube Music, YouTube, or Deezer |
| **`/vibe <mood>`** | Automatically creates an instant themed playlist matching a vibe (e.g. `80s synthwave`, `lofi study`, `french electro`) |
| **`/control skip`** | Skips smoothly to the next song in the queue |
| **`/control pause`** / **`resume`** | Pauses or unpauses playback |
| **`/control queue`** | Displays the current playlist queue |
| **`/control stop`** | Stops playback and clears the current track |
| **`/join`** / **`/leave`** | Summons the bot to your current voice channel or disconnects it |

---

## ⚙️ Configuration (`.env`)

All settings are optional with smart defaults built-in:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `DISCORD_TOKEN` | *(None)* | Your Discord Bot Token. If omitted, runs in Standalone Web Radio mode. |
| `DISCORD_GUILD_ID` | *(None)* | Your Discord Server ID for instant slash command registration without caching delays. |
| `WEB_PORT` | `8091` | Port for the web dashboard and audio stream. |
| `ADMIN_PASSWORD` | *(None)* | Admin password to restrict skip/pause/volume on the web. Leave empty for open access. |
| `YOUTUBE_COOKIES_PATH`| `./cookies.txt` | Optional cookies file exported from YouTube to prevent bot verification on datacenter IPs. |

---

## 🐳 Docker Setup (Optional)

If you prefer to run inside Docker:
```bash
cd OWRADIO-DOCKER
cp .env.example .env
docker compose up -d --build
```

---

## 📄 License

Distributed under the [MIT License](./package.json).
