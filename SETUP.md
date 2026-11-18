# StreamChat setup guide

StreamChat puts your Twitch, Kick and TikTok chat in one window and on your stream as an OBS overlay.
It can run **on your Windows PC** (the desktop app) or **on your Hetzner server** (Docker), reached privately over Tailscale.

Platform websites change their menus often, so a button might have a slightly different name than written here.

---

## 1. Install the desktop app (Windows)

Run `StreamChat-x.y.z-setup.exe`. On first start, pick **On this PC** (or **On my server** once you've done section 6).

Closing the window keeps StreamChat running in the tray, so your overlay keeps working. Quit it from the tray icon.

## 2. Twitch (2 minutes)

Reading chat works right away: type your channel name in **Settings → Accounts → Twitch**.
To send messages, moderate, and get follow alerts, sign in:

1. Go to <https://dev.twitch.tv/console/apps> and click **Register Your Application**.
2. Name: anything (e.g. `StreamChat-yourname`). OAuth Redirect URL: `http://localhost`. Category: **Chat Bot**. Client Type: **Public**.
3. Click **Manage**, copy the **Client ID**, and paste it into StreamChat → Settings → Twitch.
4. Click **Sign in with Twitch**, then enter the code shown at twitch.tv/activate.

## 3. TikTok (1 minute)

Type your TikTok username in **Settings → Accounts → TikTok**. Chat connects by itself when you go LIVE.

- TikTok has no official chat API. StreamChat uses the same unofficial method as TikFinity and similar tools, which
  can break for a while when TikTok changes things.
- A free API key from <https://www.eulerstream.com> raises the connection limits. Paste it into the TikTok card.
- TikTok is read-only: other apps can't send messages or moderate there.

## 4. Kick (5–10 minutes)

Kick sends chat to StreamChat as **webhooks**: Kick's servers call a public HTTPS address. Tailscale Funnel gives you
one for just the webhook port, while the app and overlay stay private.

### 4a. Make the webhook address

On the machine that runs StreamChat (your PC, or the server):

1. Install Tailscale (<https://tailscale.com/download>) and sign in.
2. Run:

   ```bash
   tailscale funnel --bg --https=8443 http://127.0.0.1:8788
   ```

   If Tailscale says Funnel isn't enabled, open the link it prints and allow it.
3. Your webhook URL is `https://<machine-name>.<your-tailnet>.ts.net:8443/webhooks/kick`.
   Run `tailscale funnel status` to see the exact address.

Port 8788 only answers Kick webhooks, and StreamChat checks Kick's signature on every one.

### 4b. Create the Kick app

1. On kick.com go to **Settings → Developer** and create an app.
2. **Redirect URL**: copy it from StreamChat → Settings → Kick (it ends in `/auth/kick/callback`).
3. Turn on **Webhooks** and paste your webhook URL from 4a.
4. Scopes: read user, read channel, write chat, subscribe to events, moderation (ban and chat messages).
5. Copy the **Client ID** and **Client Secret** into StreamChat, then click **Sign in with Kick**.
6. Send a message in your Kick chat. It should show up in StreamChat within a second.

Kick only sends events to one webhook URL. If you move StreamChat between your PC and the server, update the URL in
the Kick app.

## 5. Add the overlay to OBS

1. In StreamChat open **Overlay** (the layers icon) and copy the **Chat overlay URL**.
2. In OBS: **Sources → + → Browser**, paste the URL, size **450 × 800** (or whatever fits your layout).
3. For alerts, add a second Browser source with the **Alerts overlay URL**, size **1920 × 1080**.
4. Style it in the Overlay studio. Changes show up live in OBS.

Use **Make new overlay link** (Settings → Server) if an overlay URL ever leaks.

---

## 6. Run it on your Hetzner server instead (optional)

Then chat, the overlay and saved chat keep running when your PC is off, and OBS loads the overlay from the server
over Tailscale.

1. Log in to the server over SSH (a fresh Ubuntu or Debian server is fine) and run:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/JustSad42/streamchat/main/install.sh | sudo bash
   ```

   It installs Docker and Tailscale if they're missing, starts StreamChat, makes it reachable on your tailnet (private),
   makes only the Kick webhook port public with Tailscale Funnel, and turns on nightly updates. If Tailscale prints a
   link, open it to sign the server in, or to allow Funnel once.
2. At the end it prints three things: the app address, your access key, and your Kick webhook URL.
3. In the desktop app: tray icon → **Change connection… → On my server**, then paste the address and access key.
   (Or open the printed `…/app?key=…` link in any browser on your tailnet.)
4. Set up the platforms as in sections 2–4. Put the printed Kick webhook URL in your Kick app (Kick only sends to one
   URL, so this replaces your PC's).
5. Copy the overlay URLs from the app again. They now point at the server. Your PC needs Tailscale running for OBS to
   load them.

Handy commands on the server:

```bash
sudo streamchat status     # addresses, access key, Kick webhook URL
sudo streamchat update     # update now (it also updates itself every night)
sudo streamchat logs       # follow the log
sudo streamchat restart
```

Your settings and saved chat live in `/opt/streamchat/data`. Nothing is reachable from the internet except the Kick
webhook port.

---

## Troubleshooting

- **Kick connected but no messages:** check the webhook URL in your Kick app, and that `tailscale funnel status` shows
  port 8443. Settings → Server → Log shows each event as it arrives.
- **TikTok says rate limit:** add a free Euler Stream API key.
- **Overlay shows "link is out of date":** you made a new overlay link; copy the new URL into OBS.
- **Kick checklist says "Webhooks turned on" failed:** in your Kick app (kick.com → Settings → Developer) turn on
  Webhooks, paste the Webhook URL from StreamChat, and save. StreamChat retries every 20 seconds.
- **TikTok says "Waiting for your stream":** that's normal while you're not live. It connects by itself within about
  20 seconds of you going LIVE.
- **Port 8787 is in use:** another StreamChat (or something else) is running. Quit it from the tray, or change `port`
  in `%APPDATA%\com.streamchat.app\desktop.json`.
