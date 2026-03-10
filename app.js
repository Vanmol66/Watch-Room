/* ═══════════════════════════════════════════════════════
   watchroom — app.js  (v3 — fixed MediaStream)

   KEY FIXES vs v2:
   • captureStream() called AFTER first canplay, not loadedmetadata
   • Host audio: Web Audio API routes sound to speakers independently
     of the captured stream (so host hears their own video)
   • Guest stream: srcObject set + autoplay triggered correctly
   • Audio tracks guaranteed present before calling guest

   Sections:
     1.  Theme switcher
     2.  App state
     3.  Refresh / navigation guard
     4.  PeerJS loader & room creation / joining
     5.  WebRTC — data channel setup
     6.  WebRTC — media stream (callGuest / receiveStream)
     7.  Sync protocol (onData)
     8.  File loading — host only
     9.  Player controls — host only
    10.  Progress bar scrubbing — host only
    11.  Video element event listeners
    12.  Drag-and-drop — host only
    13.  Keyboard shortcuts
    14.  Controls overlay
    15.  Fullscreen
    16.  Floating chat
    17.  Chat
    18.  UI helpers
═══════════════════════════════════════════════════════ */

/* ───────────────────────────────────────────────────────
   1. APP INITIALIZATION
─────────────────────────────────────────────────────── */
// Redesign simplifies themes to a single premium dark mode.

/* ───────────────────────────────────────────────────────
   2. APP STATE
─────────────────────────────────────────────────────── */
let role = null; // 'host' | 'guest'
let roomCode = "";
let peer = null; // PeerJS Peer
let conn = null; // PeerJS DataConnection (chat + signals)
let mediaCall = null; // PeerJS MediaConnection (video stream)
let peerConn = false;
let mediaLoaded = false;
let isSyncing = false;
let ctrlTimer = null;
let fcMin = false;
let currentFilename = "";

// HOST-ONLY state
let hostStream = null; // MediaStream from captureStream()
let audioCtx = null; // AudioContext for routing host's local audio
let audioSrc = null; // MediaElementAudioSourceNode
let audioDest = null; // MediaStreamAudioDestinationNode (merges audio into hostStream)

const vid = document.getElementById("vid");

/* ───────────────────────────────────────────────────────
   3. REFRESH / NAVIGATION GUARD
─────────────────────────────────────────────────────── */
window.addEventListener("beforeunload", (e) => {
  if (mediaLoaded || peerConn) {
    e.preventDefault();
    e.returnValue = "";
  }
});

document.addEventListener("keydown", (e) => {
  const isRefresh =
    e.key === "F5" ||
    (e.ctrlKey && e.key === "r") ||
    (e.metaKey && e.key === "r");
  if (isRefresh && (mediaLoaded || peerConn)) {
    e.preventDefault();
    openM("mRefresh");
  }
});

/* ───────────────────────────────────────────────────────
   4. PEERJS LOADER & ROOM CREATION / JOINING
─────────────────────────────────────────────────────── */
function loadPeerJS(cb) {
  if (window.Peer) {
    cb();
    return;
  }
  const s = document.createElement("script");
  s.src = "https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js";
  s.onload = cb;
  s.onerror = () => toast("Could not load PeerJS — check connection");
  document.head.appendChild(s);
}

function rndCode() {
  const C = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(
    { length: 6 },
    () => C[(Math.random() * C.length) | 0],
  ).join("");
}

function createRoom() {
  roomCode = rndCode();
  role = "host";
  loadPeerJS(() => {
    peer = new Peer("wr-" + roomCode, { debug: 0 });
    peer.on("open", () => {
      enterRoom();
      document.getElementById("bigCode").textContent = roomCode;
      openM("mRoom");
      peer.on("connection", (c) => {
        conn = c;
        wireConn();
      });
    });
    peer.on("error", (e) => {
      if (e.type === "unavailable-id") toast("Code conflict — try again");
      else toast("Peer error: " + e.type);
    });
  });
}

function joinRoom() {
  const code = document.getElementById("joinCode").value.trim().toUpperCase();
  if (code.length < 4) {
    toast("Enter a valid room code");
    return;
  }
  roomCode = code;
  role = "guest";
  loadPeerJS(() => {
    peer = new Peer({ debug: 0 });
    peer.on("open", () => {
      enterRoom();
      setDot("wait");
      setPeerLbl("Connecting…");

      conn = peer.connect("wr-" + roomCode, { reliable: true });
      conn.on("open", () => wireConn());
      conn.on("error", () => toast("Room not found — check the code"));

      // Listen for the host's video+audio call
      peer.on("call", (incoming) => {
        mediaCall = incoming;
        incoming.answer(); // no outgoing stream from guest
        incoming.on("stream", (remoteStream) => receiveStream(remoteStream));
        incoming.on("error", () => toast("Stream error — try rejoining"));
        incoming.on("close", () => {
          // Stream ended (host changed file or disconnected)
          if (role === "guest") {
            mediaLoaded = false;
            vid.srcObject = null;
            vid.style.display = "none";
          }
        });
      });
    });
    peer.on("error", () => toast("Connection error"));
  });
}

/* ───────────────────────────────────────────────────────
   5. DATA CHANNEL SETUP
─────────────────────────────────────────────────────── */
function wireConn() {
  peerConn = true;
  setDot("on");
  setPeerLbl("Connected");
  setRpPeer("Connected", "ok");
  document.getElementById("chatOnline").textContent = "2 online";
  sysMsg(
    role === "host"
      ? "🎉 Guest joined! Sending stream…"
      : "🎬 Connected! Waiting for host stream…",
  );

  conn.on("data", onData);
  conn.on("close", () => {
    peerConn = false;
    setDot("off");
    setPeerLbl("Peer left");
    setRpPeer("Disconnected", "wn");
    document.getElementById("chatOnline").textContent = "1 online";
    sysMsg("😢 Peer disconnected");
    if (role === "guest") {
      mediaLoaded = false;
      vid.srcObject = null;
      vid.style.display = "none";
      showGuestWaiting("Host disconnected", "Re-join the room to reconnect.");
    }
  });
  conn.on("error", () => {
    peerConn = false;
    setDot("off");
  });

  // If host already has stream ready, call guest immediately
  if (role === "host" && mediaLoaded && hostStream) {
    callGuest();
  }
}

/* ───────────────────────────────────────────────────────
   6. WEBRTC MEDIA STREAM
─────────────────────────────────────────────────────── */

/**
 * HOST: Build a clean MediaStream from the video element.
 *
 * IMPORTANT — why we use Web Audio API:
 *   captureStream() on a <video> element "takes" the audio tracks.
 *   Once captured, the browser may silence the local speaker output,
 *   meaning the host can no longer hear their own video.
 *
 *   Fix: we route audio through an AudioContext:
 *     MediaElementSource → local speaker (so host hears it)
 *     MediaElementSource → MediaStreamDestination (so stream has audio)
 *   Then we combine the video tracks from captureStream() with the
 *   audio tracks from the AudioContext destination into one stream
 *   that we send to the guest.
 */
function buildHostStream() {
  // --- Video track: use captureStream() for the raw video frames ---
  let rawStream;
  try {
    rawStream = vid.captureStream
      ? vid.captureStream()
      : vid.mozCaptureStream
        ? vid.mozCaptureStream()
        : null;
  } catch (e) {
    rawStream = null;
  }

  if (!rawStream) {
    toast("captureStream not supported — please use Chrome or Edge");
    return false;
  }

  // --- Audio: Web Audio API so host hears their own video ---
  try {
    // Reuse AudioContext if already created (avoid re-creating every time)
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();

    // Disconnect old nodes if re-loading
    if (audioSrc) {
      try {
        audioSrc.disconnect();
      } catch (e) {}
    }

    // MediaElementSource reads audio from the <video> element
    audioSrc = audioCtx.createMediaElementSource(vid);
    // Destination 1: the actual speakers (host hears the video)
    audioSrc.connect(audioCtx.destination);
    // Destination 2: a MediaStream we can send to the guest
    audioDest = audioCtx.createMediaStreamDestination();
    audioSrc.connect(audioDest);
  } catch (e) {
    // If Web Audio fails, fall back to direct capture (host may not hear audio)
    console.warn("AudioContext failed, falling back:", e);
    audioDest = null;
  }

  // --- Combine video from captureStream + audio from AudioContext ---
  const combined = new MediaStream();

  // Add video tracks
  rawStream.getVideoTracks().forEach((t) => combined.addTrack(t));

  // Prefer AudioContext audio tracks; fall back to captureStream audio
  const audioTracks = audioDest
    ? audioDest.stream.getAudioTracks()
    : rawStream.getAudioTracks();
  audioTracks.forEach((t) => combined.addTrack(t));

  hostStream = combined;
  return true;
}

/** HOST: Call the guest peer with our combined stream. */
function callGuest() {
  if (!peerConn || !hostStream) return;
  if (mediaCall) {
    try {
      mediaCall.close();
    } catch (e) {}
  }

  const guestId = conn.peer;
  mediaCall = peer.call(guestId, hostStream);
  mediaCall.on("error", (e) => {
    console.error("call error", e);
    toast("Stream call error");
  });

  emit({ type: "meta", dur: vid.duration, filename: currentFilename });
  sysMsg("📡 Streaming to guest…");
  toast("📡 Streaming video + audio to guest!");
}

/** GUEST: Receive and play the incoming stream. */
function receiveStream(stream) {
  console.log(
    "receiveStream tracks:",
    stream.getTracks().map((t) => t.kind + ":" + t.readyState),
  );

  // Detach any previous stream
  vid.srcObject = null;

  // Small delay to let the browser settle before attaching new srcObject
  setTimeout(() => {
    vid.srcObject = stream;
    vid.muted = false; // Guest must hear audio

    // Autoplay: browsers require a user gesture or muted to autoplay.
    // We attempt play; if blocked, show a "click to watch" prompt.
    const tryPlay = () => {
      vid
        .play()
        .then(() => {
          mediaLoaded = true;
          vid.style.display = "block";
          document.getElementById("guest-wait").style.display = "none";
          document.getElementById("change-banner").classList.remove("show");
          setPlayUI(true);
          showCtrl();
          sysMsg("✅ Stream connected — host controls playback");
          toast("🍿 Watching with host!");
        })
        .catch((err) => {
          console.warn("autoplay blocked:", err);
          // Show a tap-to-watch overlay
          showGuestWaiting(
            "Tap to watch 👇",
            "Autoplay blocked — tap anywhere to start the stream.",
          );
          document.getElementById("guest-wait").addEventListener(
            "click",
            () => {
              tryPlay();
            },
            { once: true },
          );
        });
    };

    vid.onloadedmetadata = () => tryPlay();
    vid.onerror = (e) => {
      console.error("vid error", e);
      toast("Stream error — try rejoining");
    };
  }, 100);
}

/** HOST: Re-stream after changing media. */
function recallGuest() {
  if (peerConn) {
    emit({ type: "media-changed", filename: currentFilename });
    if (hostStream) {
      // Give the new stream a moment before calling
      setTimeout(() => callGuest(), 500);
    }
  }
}

/* ───────────────────────────────────────────────────────
   7. SYNC PROTOCOL
─────────────────────────────────────────────────────── */
function onData(d) {
  if (d.type === "chat") {
    addMsg(d.text, false);
    return;
  }

  if (d.type === "play") {
    isSyncing = true;
    if (vid.srcObject) vid.play().catch(() => {});
    setPlayUI(true);
    flash("▶ play");
    isSyncing = false;
    return;
  }

  if (d.type === "pause") {
    isSyncing = true;
    if (vid.srcObject) vid.pause();
    setPlayUI(false);
    flash("⏸ pause");
    isSyncing = false;
    return;
  }

  if (d.type === "seek") {
    flash("⏩ " + fmt(d.time));
    document.getElementById("tCur").textContent = fmt(d.time);
    return;
  }

  if (d.type === "timeupdate") {
    const p = d.dur > 0 ? (d.time / d.dur) * 100 : 0;
    document.getElementById("progFill").style.width = p + "%";
    document.getElementById("progKnob").style.left = p + "%";
    document.getElementById("tCur").textContent = fmt(d.time);
    document.getElementById("tDur").textContent = fmt(d.dur);
    return;
  }

  if (d.type === "meta") {
    document.getElementById("tDur").textContent = fmt(d.dur);
    currentFilename = d.filename || "";
    return;
  }

  if (d.type === "media-changed") {
    mediaLoaded = false;
    if (vid.srcObject) {
      vid.pause();
      vid.srcObject = null;
    }
    vid.style.display = "none";
    setPlayUI(false);
    document.getElementById("progFill").style.width = "0%";
    document.getElementById("progKnob").style.left = "0%";
    document.getElementById("tCur").textContent = "0:00";
    document.getElementById("tDur").textContent = "0:00";
    showGuestWaiting("Host changed media 🔄", "New stream incoming…");
    sysMsg("🔄 Host changed media — new stream incoming…");
    return;
  }
}

/* ───────────────────────────────────────────────────────
   8. FILE LOADING — HOST ONLY
─────────────────────────────────────────────────────── */
function loadFile(file, isChange) {
  if (!file || role !== "host") return;
  currentFilename = file.name;

  // Stop old stream + video
  vid.pause();
  if (hostStream) {
    hostStream.getTracks().forEach((t) => t.stop());
    hostStream = null;
  }

  // Clean up previous audio routing
  if (audioSrc) {
    try {
      audioSrc.disconnect();
    } catch (e) {}
    audioSrc = null;
  }

  vid.removeAttribute("src");
  vid.srcObject = null;
  vid.load();

  vid.src = URL.createObjectURL(file);
  vid.load();

  // We wait for 'canplay' (not just loadedmetadata) to ensure
  // audio tracks are actually available in the stream
  const onCanPlay = () => {
    vid.removeEventListener("canplay", onCanPlay);

    mediaLoaded = true;
    document.getElementById("drop-zone").classList.add("hidden");
    vid.style.display = "block";
    setPlayUI(false);
    showCtrl();
    document.getElementById("btnChgCtrl").style.display = "flex";
    document.getElementById("rpChgBtn").style.display = "flex";

    // Build the combined stream (video from captureStream + audio via AudioContext)
    const ok = buildHostStream();
    if (!ok) return;

    if (isChange) {
      recallGuest();
      sysMsg("🔄 Media changed — re-streaming to guest.");
      toast("🎬 New file loaded! Re-streaming…");
    } else {
      if (peerConn) callGuest();
      else sysMsg("📂 File loaded — waiting for guest to join…");
      toast("🎬 Video ready! Share the code with your guest.");
    }

    if (peerConn)
      emit({ type: "meta", dur: vid.duration, filename: file.name });
  };

  vid.addEventListener("canplay", onCanPlay);
  vid.onerror = () =>
    toast("Could not load this file — try a different format");
}

function requestChangeMedia() {
  if (role === "host") openM("mChange");
}
function doChangeMedia() {
  closeM("mChange");
  document.getElementById("fileChg").click();
}
function hideBanner() {
  document.getElementById("change-banner").classList.remove("show");
}

/* ───────────────────────────────────────────────────────
   9. PLAYER CONTROLS — HOST ONLY
─────────────────────────────────────────────────────── */
function togglePlay() {
  if (role !== "host") {
    toast("Only the host controls playback 🎬");
    return;
  }
  if (!mediaLoaded) {
    toast("Load a video file first 👆");
    return;
  }

  // Resume AudioContext on first user gesture (browser policy)
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();

  if (vid.paused) {
    vid
      .play()
      .then(() => {
        setPlayUI(true);
        emit({ type: "play", time: vid.currentTime });
      })
      .catch(() => {});
  } else {
    vid.pause();
    setPlayUI(false);
    emit({ type: "pause", time: vid.currentTime });
  }
}

function skip(s) {
  if (role !== "host" || !mediaLoaded) return;
  const t = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + s));
  vid.currentTime = t;
  emit({ type: "seek", time: t });
}

function toggleMute() {
  // For host: muting adjusts the AudioContext gain, not vid.muted
  // (vid.muted would break the audio routing)
  if (audioCtx && audioSrc) {
    if (!toggleMute._gainNode) {
      toggleMute._gainNode = audioCtx.createGain();
      // Re-route: audioSrc → gainNode → destination + audioDest
      audioSrc.disconnect();
      audioSrc.connect(toggleMute._gainNode);
      toggleMute._gainNode.connect(audioCtx.destination);
      if (audioDest) toggleMute._gainNode.connect(audioDest);
    }
    const muted = toggleMute._gainNode.gain.value === 0;
    toggleMute._gainNode.gain.value = muted ? 1 : 0;
    document.getElementById("icVol").style.display = muted ? "" : "none";
    document.getElementById("icMute").style.display = muted ? "none" : "";
    document.getElementById("btnMute").classList.toggle("lit", !muted);
  } else {
    // Fallback if no AudioContext
    vid.muted = !vid.muted;
    document.getElementById("icVol").style.display = vid.muted ? "none" : "";
    document.getElementById("icMute").style.display = vid.muted ? "" : "none";
    document.getElementById("btnMute").classList.toggle("lit", vid.muted);
  }
}

function setVol(v) {
  if (toggleMute._gainNode) {
    toggleMute._gainNode.gain.value = parseFloat(v);
  } else {
    vid.volume = parseFloat(v);
  }
}

/* ───────────────────────────────────────────────────────
   10. PROGRESS BAR SCRUBBING — HOST ONLY
─────────────────────────────────────────────────────── */
function startScrub(e) {
  if (role !== "host" || !mediaLoaded) return;
  e.preventDefault();
  doScrub(e);
  const mm = e.type === "mousedown" ? "mousemove" : "touchmove";
  const mu = e.type === "mousedown" ? "mouseup" : "touchend";
  const mv = (ev) => doScrub(ev);
  const end = () => {
    document.removeEventListener(mm, mv);
    document.removeEventListener(mu, end);
    emit({ type: "seek", time: vid.currentTime });
  };
  document.addEventListener(mm, mv);
  document.addEventListener(mu, end);
}

function doScrub(e) {
  const r = document.getElementById("progArea").getBoundingClientRect();
  const x = e.touches ? e.touches[0].clientX : e.clientX;
  vid.currentTime =
    Math.max(0, Math.min(1, (x - r.left) / r.width)) * (vid.duration || 0);
}

/* ───────────────────────────────────────────────────────
   11. VIDEO EVENT LISTENERS
─────────────────────────────────────────────────────── */
vid.addEventListener("timeupdate", () => {
  if (!vid.duration || role !== "host") return;
  const p = (vid.currentTime / vid.duration) * 100;
  document.getElementById("progFill").style.width = p + "%";
  document.getElementById("progKnob").style.left = p + "%";
  document.getElementById("tCur").textContent = fmt(vid.currentTime);
  document.getElementById("tDur").textContent = fmt(vid.duration);
  // Throttled sync to guest
  if (!vid._lastSync || vid.currentTime - vid._lastSync > 1) {
    vid._lastSync = vid.currentTime;
    emit({ type: "timeupdate", time: vid.currentTime, dur: vid.duration });
  }
});

vid.addEventListener("play", () => {
  if (!isSyncing && role === "host")
    emit({ type: "play", time: vid.currentTime });
  setPlayUI(true);
});
vid.addEventListener("pause", () => {
  if (!isSyncing && role === "host")
    emit({ type: "pause", time: vid.currentTime });
  setPlayUI(false);
});
vid.addEventListener("ended", () => setPlayUI(false));

vid.addEventListener("click", () => {
  if (role === "host") togglePlay();
  else toast("Only the host controls playback 🎬");
});

document.getElementById("playerWrap").addEventListener("dblclick", (e) => {
  if (e.target === vid) toggleFS();
});

/* ───────────────────────────────────────────────────────
   12. DRAG-AND-DROP — HOST ONLY
─────────────────────────────────────────────────────── */
const dzEl = document.getElementById("drop-zone");
const pw = document.getElementById("playerWrap");

pw.addEventListener("dragover", (e) => {
  if (role !== "host") return;
  e.preventDefault();
  dzEl.classList.add("drag-over");
});
pw.addEventListener("dragleave", () => dzEl.classList.remove("drag-over"));
pw.addEventListener("drop", (e) => {
  if (role !== "host") return;
  e.preventDefault();
  dzEl.classList.remove("drag-over");
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f, mediaLoaded);
});

/* ───────────────────────────────────────────────────────
   13. KEYBOARD SHORTCUTS
─────────────────────────────────────────────────────── */
document.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
  if (e.code === "Space") {
    e.preventDefault();
    togglePlay();
  } else if (e.code === "ArrowLeft") skip(-10);
  else if (e.code === "ArrowRight") skip(10);
  else if (e.code === "KeyM") toggleMute();
  else if (e.code === "KeyF") toggleFS();
  else if (e.code === "KeyC") toggleFChat();
});

/* ───────────────────────────────────────────────────────
   14. CONTROLS OVERLAY
─────────────────────────────────────────────────────── */
function showCtrl() {
  if (!mediaLoaded) return;
  document.getElementById("ctrl").classList.add("show");
}
function schedHide() {
  clearTimeout(ctrlTimer);
  ctrlTimer = setTimeout(() => {
    if (!vid.paused) document.getElementById("ctrl").classList.remove("show");
  }, 2600);
}
function onMove() {
  showCtrl();
  schedHide();
}

/* ───────────────────────────────────────────────────────
   15. FULLSCREEN
─────────────────────────────────────────────────────── */
function toggleFS() {
  if (!document.fullscreenElement)
    document
      .getElementById("playerWrap")
      .requestFullscreen()
      .catch(() => {});
  else document.exitFullscreen();
}
document.addEventListener("fullscreenchange", () => {
  const fs = !!document.fullscreenElement;
  document.getElementById("icFS").style.display = fs ? "none" : "";
  document.getElementById("icEX").style.display = fs ? "" : "none";
  document.getElementById("chatSide").style.display = fs ? "none" : "flex";
  document.getElementById("rightPanel").style.display = fs ? "none" : "flex";
  if (fs) {
    document.getElementById("fchat").classList.add("open");
    document.getElementById("btnFChat").classList.add("lit");
  } else {
    document.getElementById("fchat").classList.remove("open");
    document.getElementById("btnFChat").classList.remove("lit");
  }
});

/* ───────────────────────────────────────────────────────
   16. FLOATING CHAT
─────────────────────────────────────────────────────── */
function toggleFChat() {
  const fc = document.getElementById("fchat");
  fc.classList.toggle("open");
  document
    .getElementById("btnFChat")
    .classList.toggle("lit", fc.classList.contains("open"));
}
function minFChat() {
  fcMin = !fcMin;
  document.getElementById("fchat").classList.toggle("minimized", fcMin);
}
function closeFChat() {
  document.getElementById("fchat").classList.remove("open");
  document.getElementById("btnFChat").classList.remove("lit");
}
(() => {
  const h = document.getElementById("fcHead");
  const b = document.getElementById("fchat");
  let ox,
    oy,
    bx,
    by,
    drag = false;
  h.addEventListener("mousedown", (e) => {
    drag = true;
    ox = e.clientX;
    oy = e.clientY;
    const r = b.getBoundingClientRect();
    bx = r.left;
    by = r.top;
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!drag) return;
    b.style.right = "auto";
    b.style.bottom = "auto";
    b.style.left = Math.max(0, bx + (e.clientX - ox)) + "px";
    b.style.top = Math.max(0, by + (e.clientY - oy)) + "px";
  });
  document.addEventListener("mouseup", () => (drag = false));
})();

/* ───────────────────────────────────────────────────────
   17. CHAT
─────────────────────────────────────────────────────── */
function sendChat(fromFloat) {
  const inp = document.getElementById(fromFloat ? "fcIn" : "chatInp");
  const t = inp.value.trim();
  if (!t) return;
  inp.value = "";
  addMsg(t, true);
  emit({ type: "chat", text: t });
}

function addMsg(text, mine) {
  const box = document.getElementById("msgs");
  const wrap = document.createElement("div");
  wrap.className = "mb " + (mine ? "me" : "them");
  const who = document.createElement("div");
  who.className = "mb-who";
  who.textContent = mine ? "you" : "them";
  const txt = document.createElement("div");
  txt.className = "mb-txt";
  txt.textContent = text;
  wrap.append(who, txt);
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
  const fb = document.getElementById("fmsgs");
  const fd = document.createElement("div");
  fd.className = "fm " + (mine ? "fme" : "fpe");
  fd.textContent = text;
  fb.appendChild(fd);
  fb.scrollTop = fb.scrollHeight;
}

function sysMsg(text) {
  const box = document.getElementById("msgs");
  const wrap = document.createElement("div");
  wrap.className = "mb sys";
  const txt = document.createElement("div");
  txt.className = "mb-txt";
  txt.textContent = text;
  wrap.appendChild(txt);
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
  const fb = document.getElementById("fmsgs");
  const fd = document.createElement("div");
  fd.className = "fm fsy";
  fd.textContent = text;
  fb.appendChild(fd);
  fb.scrollTop = fb.scrollHeight;
}

/* ───────────────────────────────────────────────────────
   18. UI HELPERS
─────────────────────────────────────────────────────── */
function enterRoom() {
  document.getElementById("page-land").style.display = "none";
  document.getElementById("page-room").style.display = "flex";
  document.getElementById("codeDisp").textContent = roomCode;
  document.getElementById("rpCode").textContent = roomCode;
  document.getElementById("roleChip").textContent =
    role === "host" ? "🎬 Host" : "👀 Guest";
  document.getElementById("rpRole").textContent =
    role === "host" ? "Host — picks file & controls" : "Guest — stream viewer";

  if (role === "guest") {
    document.getElementById("drop-zone").classList.add("hidden");
    showGuestWaiting(
      "Waiting for host…",
      "The host will stream the video — no file needed on your end.",
    );
    document.getElementById("btnChgCtrl").style.display = "none";
    document.getElementById("rpChgBtn").style.display = "none";
    document.getElementById("progArea").style.pointerEvents = "none";
    document.getElementById("progArea").style.cursor = "default";
  }
}

function showGuestWaiting(title, sub) {
  document.getElementById("gwTitle").textContent = title;
  document.getElementById("gwSub").innerHTML = sub;
  document.getElementById("guest-wait").style.display = "flex";
}

function setPlayUI(playing) {
  document.getElementById("icPlay").style.display = playing ? "none" : "";
  document.getElementById("icPause").style.display = playing ? "" : "none";
  if (playing) schedHide();
  else showCtrl();
}

function flash(msg) {
  const el = document.getElementById("syncBadge");
  el.textContent = "⚡ " + msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2000);
}

function setDot(s) {
  const d = document.getElementById("peerDot");
  d.className = "pdot";
  if (s === "on") d.classList.add("on");
  if (s === "wait") d.classList.add("wait");
}
function setPeerLbl(t) {
  document.getElementById("peerLbl").textContent = t;
}
function setRpPeer(t, cls) {
  const el = document.getElementById("rpPeer");
  el.textContent = t;
  el.className = "rp-val " + cls;
}

function openM(id) {
  document.getElementById(id).classList.add("open");
}
function closeM(id) {
  document.getElementById(id).classList.remove("open");
}

function doLeave() {
  emit({ type: "chat", text: "— " + role + " left the room" });
  setTimeout(() => {
    try {
      if (hostStream) hostStream.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    try {
      if (audioSrc) audioSrc.disconnect();
    } catch (e) {}
    try {
      if (audioCtx) audioCtx.close();
    } catch (e) {}
    try {
      mediaCall && mediaCall.close();
    } catch (e) {}
    try {
      conn && conn.close();
    } catch (e) {}
    try {
      peer && peer.destroy();
    } catch (e) {}
    location.reload();
  }, 180);
}

function copyCode() {
  navigator.clipboard.writeText(roomCode).catch(() => {});
  toast("📋 Copied: " + roomCode);
}

function emit(d) {
  if (conn && conn.open)
    try {
      conn.send(d);
    } catch (e) {}
}

function fmt(s) {
  if (isNaN(s) || s == null) return "0:00";
  return (
    Math.floor(s / 60) +
    ":" +
    Math.floor(s % 60)
      .toString()
      .padStart(2, "0")
  );
}

let _tt;
function toast(msg) {
  document.getElementById("toastTxt").textContent = msg;
  const el = document.getElementById("toast");
  el.classList.add("show");
  clearTimeout(_tt);
  _tt = setTimeout(() => el.classList.remove("show"), 3400);
}

window.addEventListener("beforeunload", () => {
  try {
    if (hostStream) hostStream.getTracks().forEach((t) => t.stop());
  } catch (e) {}
  try {
    if (audioSrc) audioSrc.disconnect();
  } catch (e) {}
  try {
    if (audioCtx) audioCtx.close();
  } catch (e) {}
  try {
    mediaCall && mediaCall.close();
  } catch (e) {}
  try {
    conn && conn.close();
  } catch (e) {}
  try {
    peer && peer.destroy();
  } catch (e) {}
});
