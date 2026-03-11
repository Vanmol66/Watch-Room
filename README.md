# 🎬 Watch Room

> **Sync local video files with anyone — zero uploads, zero storage, zero accounts.**
> Just pure peer-to-peer streaming, direct from your browser.

[![GitHub Pages](https://img.shields.io/badge/Hosted%20on-GitHub%20Pages-blue?logo=github)](https://pages.github.com/)
[![Zero Storage](https://img.shields.io/badge/Storage%20Used-0%20bytes-brightgreen)](#)
[![No Backend](https://img.shields.io/badge/Backend-None-orange)](#)
[![WebRTC](https://img.shields.io/badge/Powered%20by-WebRTC-blueviolet)](#)

---

## What is Watch Room?

Watch Room is a **disposable, ephemeral watch party app** that lets two people watch the same local video file in perfect sync — without uploading it anywhere. The host picks a file from their device, and it streams directly to the guest's browser over a peer-to-peer WebRTC connection.

When everyone leaves, the room vanishes. No data is ever stored. Not on GitHub Pages, not on any server, not anywhere.

---

## ✨ Features

- **Zero uploads** — your video file never leaves your device
- **Zero storage** — 0 bytes used on GitHub Pages or any server
- **Zero accounts** — no sign-up, no login, nothing
- **Live P2P streaming** — host streams video + audio directly to the guest via WebRTC
- **Perfectly synced playback** — play, pause, seek all sync in real time
- **Independent volume control** — guest can mute/adjust volume without affecting the host
- **Live chat** — built-in text chat sidebar and floating chat for fullscreen mode
- **Drag & drop** — drop a video file directly onto the player
- **Change media on the fly** — swap the video without disconnecting
- **5 themes** — Midnight, Sunset, Forest, Golden, Ice
- **Keyboard shortcuts** — Space, ← →, M, F, C
- **Fullscreen support** — with floating draggable chat overlay
- **Ephemeral rooms** — room code expires the moment everyone leaves

---

## 🚀 How to Use

### Host (you have the video file)

1. Open the app and click **Open Room**
2. A 6-character room code is generated (e.g. `YAHDA4`)
3. Share the code with your friend
4. Drop your video file onto the player or click **Choose File**
5. The stream starts automatically when your guest joins
6. Use the player controls to play, pause, and seek — your guest stays in sync

### Guest (you're watching)

1. Open the app and enter the room code
2. Click **Enter Room**
3. The host's video streams directly to you — no file needed on your end
4. Click **Enable Audio 🔊** on the banner that appears (browser requires one tap before audio plays)
5. Use the mute button and volume slider to control your own audio independently

---

## 🏗️ How It Works

```
HOST BROWSER                          GUEST BROWSER
─────────────────                     ─────────────────
Local video file                      No file needed
      │
      ▼
<video> element  ──captureStream()──► MediaStream
      │                                    │
      ▼                                    │ WebRTC (PeerJS)
<audio> element  ◄── host hears ──┐        │
  (hostAud)                       │        ▼
                                  │   <video> srcObject
                              muted      (guest sees
                              video      & hears stream)

Data Channel (PeerJS):
  play / pause / seek / timeupdate / chat  →→→  guest syncs UI
```

**Audio architecture** — The `<video>` element on the host side stays permanently muted so `captureStream()` can capture clean audio tracks (Chrome requires the element to be unmuted at the moment of capture). A hidden `<audio>` element plays the same file so the host hears their own video. The guest receives the full video + audio stream and controls their own volume independently.

**No relay servers** — PeerJS connects peers directly via WebRTC. The free PeerJS cloud is used only for the initial signalling handshake (exchanging connection info). All actual video/audio data flows directly between browsers.

---

## 📁 File Structure

```
watchroom/
├── index.html       # App shell — all HTML structure and layout
├── style.css        # All styles — themes, player, chat, modals
├── app.js           # All JavaScript logic — WebRTC, sync, controls
└── README.md        # This file
```

No build step. No npm install. No framework. Open `index.html` and it works.

> A single-file version (`watchroom.html`) with everything inlined is also available as an alternative for direct sharing.

---

## 🌐 Deployment (GitHub Pages)

1. Fork or clone this repo
2. Go to **Settings → Pages**
3. Set source to **main branch / root**
4. Your app is live at `https://YOUR-USERNAME.github.io/REPO-NAME/`

That's it. GitHub Pages serves static files for free, and since Watch Room has no backend and stores nothing, it fits perfectly within the free tier.

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `←` | Skip back 10s |
| `→` | Skip forward 10s |
| `M` | Mute / Unmute |
| `F` | Toggle Fullscreen |
| `C` | Toggle floating chat |

---

## 🔧 Browser Compatibility

| Browser | Host | Guest |
|---------|------|-------|
| Chrome | ✅ Full support | ✅ Full support |
| Edge | ✅ Full support | ✅ Full support |
| Firefox | ⚠️ Partial (`mozCaptureStream`) | ✅ Full support |
| Safari | ❌ No `captureStream()` | ✅ Full support |

> **The host must use Chrome or Edge.** The guest can use any modern browser including Safari and Firefox.
> Safari does not support `captureStream()` on `<video>` elements, which is required for the host to stream.

---

## 🔒 Privacy

- Your video file is **never uploaded** to any server
- No analytics, no tracking, no cookies
- Chat messages exist only in memory and disappear when the tab closes
- Room codes are randomly generated and not logged anywhere
- The only external service used is the free PeerJS signalling server, which sees your IP and room code for the duration of the connection handshake — nothing else

---

## ⚙️ Tech Stack

| Technology | Purpose |
|-----------|---------|
| [PeerJS](https://peerjs.com/) v1.5.2 | WebRTC abstraction — peer connections & data channel |
| `captureStream()` API | Capture live video + audio from `<video>` element |
| Web Audio API | Route host audio to speakers while keeping `<video>` muted for clean stream capture |
| `MediaStream` / WebRTC | Peer-to-peer video + audio delivery to guest |
| Vanilla JS + HTML + CSS | Everything else — zero frameworks, zero build tools |
| GitHub Pages | Free static hosting |

---

## 🐛 Known Limitations

- **One guest per room** — the current architecture supports exactly one host and one guest (1-to-1 only)
- **Host must stay connected** — if the host closes the tab, the guest's stream ends
- **No reconnection** — if the connection drops, the guest needs to re-enter the room code
- **Large files on slow connections** — WebRTC bitrate adapts automatically, but very high bitrate source files may stutter on slow networks
- **Host must use Chrome or Edge** — Safari doesn't support `captureStream()`

---

## 💡 Inspiration & Design Philosophy

Most watch party tools require you to upload your file, create an account, or install an extension. Watch Room does none of that. The idea was to build the simplest possible thing that actually works — a shareable room code, a file picker, and a stream. When you're done, there's nothing left behind.

The entire app is three files and loads in under 100KB.

---

## 📄 License

MIT — do whatever you want with it.
