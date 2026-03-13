# 🎬 Watch Room

> **Sync local video files with anyone — zero uploads, zero storage, zero accounts.**
> Just pure peer-to-peer streaming, direct from your browser.

![WatchRoom Preview](public/Watchroom.webp)

[![GitHub Pages](https://img.shields.io/badge/Hosted%20on-GitHub%20Pages-blue?logo=github)](https://pages.github.com/)
[![Zero Storage](https://img.shields.io/badge/Storage%20Used-0%20bytes-brightgreen)](#)

---

## ✨ Key Features

- **P2P Streaming**: Files are streamed directly between peers using WebRTC. No servers, no uploads, and zero storage used.
- **Synced Playback**: Play, pause, and seek are synchronized across all participants.
- **Independent Audio**: Guest controls their own volume and mute state independently of the host.
- **Live Chat**: Built-in ephemeral chat for real-time interaction (no history saved).
- **Privacy First**: No accounts required. Your files never leave your device.
- **Theming**: 5 carefully crafted themes (Midnight, Sunset, Forest, Golden, Ice).

---

## 🚀 How to Use

### Host (You have the video file)
1. Open the app and click **Open Room**.
2. Share the generated 6-character room code with your friend.
3. Drop your video file onto the player (or click **Choose File**).

### Guest (You are watching)
1. Open the app and enter the room code.
2. Click **Enter Room**.
3. Once the host selects a file, you completely receive the stream automatically (no file needed on your end).
4. *Note: You must click **Enable Audio 🔊** to hear sound (browser autoplay policy).*

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `← / →` | Skip backward / forward 10s |
| `M` | Mute / Unmute |
| `F` | Toggle Fullscreen |
| `C` | Toggle floating chat |

---

## ⚙️ Tech Stack & Compatibility

- **Tech**: HTML5, Vanilla CSS, Pure JavaScript, WebRTC (PeerJS).
- **Hosting**: GitHub Pages (Free static hosting).
- **Host Browser**: Chrome or Edge (Requires `captureStream()` API).
- **Guest Browser**: Any modern browser (Chrome, Edge, Firefox, Safari).

---

## 📄 License

MIT — do whatever you want with it.
