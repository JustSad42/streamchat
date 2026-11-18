# StreamChat

Twitch, Kick and TikTok chat in one window, plus a styled OBS chat overlay and alerts.
Runs on your Windows PC (desktop app) or on a Linux server (Docker) reached over Tailscale.

- **Merged chat** with per-platform tabs, Mentions and Events tabs, and an events side panel
- **Emotes:** Twitch, Kick, TikTok sub emotes, plus **7TV** (Twitch + Kick, including animated and zero-width), **FrankerFaceZ** and **BetterTTV**. 7TV changes show up live.
- **Send** to Twitch, Kick or both at once, with replies, emote/user Tab-completion and an emote picker
- **Moderate:** delete, timeout and ban from hover buttons, right-click or the user card (Twitch, Kick)
- **Highlights:** mentions of your name, plus your own words or regexes in any color
- **Events:** follows, subs, gifted subs, raids, bits, channel points, Kicks, TikTok gifts/likes/shares
- **OBS overlay** with a live-preview style editor (bubble, no background or one panel), and an **alerts overlay**
- **Saved chat + search** (Ctrl+F), **first-time chatters**, **nicknames, notes and linked accounts** per viewer
- **Slash commands** (/ban, /timeout, /slow, /shoutout, /raid…), **ban everywhere**, **blocked words**
- **Stats bar** (viewers, uptime, messages per minute), **columns** and **pop-out windows**, keyboard shortcuts,
  text size from tiny to huge
- **Auto-updates** for the desktop app; servers update themselves nightly

Download the installer from [Releases](https://github.com/JustSad42/streamchat/releases/latest), then see
[SETUP.md](SETUP.md). On a server:

```bash
curl -fsSL https://raw.githubusercontent.com/JustSad42/streamchat/main/install.sh | sudo bash
```

## Layout

| Folder | What |
| --- | --- |
| `server/` | Node/TypeScript server: platform connectors, emotes, API, WebSocket, Kick webhooks |
| `web/` | The chat app (`app/`), OBS overlays (`overlay/`) and shared rendering (`shared/`) |
| `desktop/` | Tauri app for Windows: runs the server in the background or connects to a remote one |
| `installer/`, `release.ps1` | Windows installer (Inno Setup) |
| `Dockerfile`, `docker-compose.yml` | Server deployment |

## Develop

```bash
cd server && npm install && npm start      # http://127.0.0.1:8787/app?key=... (key is printed)
npm test                                   # offline tests
```

`.\release.ps1 0.3.0 -Publish -Notes "..."` sets the version, builds the installer and the server bundle, and publishes
a GitHub release (installed apps and servers update from it). `install.sh` and `deploy/streamchat` are the server
installer and helper command.

## How each platform connects

- **Twitch:** IRC over WebSocket for chat (works signed out), Helix for moderation/badges/user cards, EventSub WebSocket for follows and redemptions. Sign-in uses the device-code flow, so only a public Client ID is needed.
- **Kick:** the official public API. Chat and events arrive as signed webhooks; sending and moderation use the REST API with your sign-in (OAuth + PKCE).
- **TikTok:** [tiktok-live-connector](https://github.com/zerodytrash/TikTok-Live-Connector) (unofficial, signing via Euler Stream). Read-only.
