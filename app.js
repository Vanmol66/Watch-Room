/* ═══════════════════════════════════════════════════════
   watchroom — app.js
   Sections:
     1.  Theme switcher
     2.  App state
     3.  Refresh / navigation guard
     4.  PeerJS loader & room creation / joining
     5.  WebRTC connection setup
     6.  Sync protocol (onData handler)
     7.  File loading & media-change flow
     8.  Player controls (play, pause, seek, mute, volume)
     9.  Progress bar scrubbing
    10.  Video element event listeners
    11.  Drag-and-drop onto player
    12.  Keyboard shortcuts
    13.  Controls overlay visibility
    14.  Fullscreen
    15.  Floating chat (open, minimise, drag)
    16.  Chat — send & render messages
    17.  UI helpers (enterRoom, modals, toast, etc.)
═══════════════════════════════════════════════════════ */


/* ───────────────────────────────────────────────────────
   1. THEME SWITCHER
   Called from onclick on every theme dot button.
─────────────────────────────────────────────────────── */
let curTheme = 'midnight';

function setTheme(t, btn) {
  curTheme = t;
  document.documentElement.setAttribute('data-theme', t);
  // Update all theme dots on both landing and room topbar
  document.querySelectorAll('.td, .ts').forEach(b => b.classList.remove('on'));
  document.querySelectorAll(`[data-t="${t}"]`).forEach(b => b.classList.add('on'));
}


/* ───────────────────────────────────────────────────────
   2. APP STATE
─────────────────────────────────────────────────────── */
let role      = null;   // 'host' | 'guest'
let roomCode  = '';
let peer      = null;   // PeerJS Peer instance
let conn      = null;   // PeerJS DataConnection

let peerConn   = false; // true once data channel is open
let mediaLoaded = false; // true once a video file is loaded
let isSyncing  = false; // prevents feedback loops on remote sync events
let ctrlTimer  = null;  // timer for auto-hiding player controls
let fcMin      = false; // floating chat minimised state

const vid = document.getElementById('vid');


/* ───────────────────────────────────────────────────────
   3. REFRESH / NAVIGATION GUARD
   Shows a warning modal instead of the browser's default
   "leave page?" dialog when a room or file is active.
─────────────────────────────────────────────────────── */
window.addEventListener('beforeunload', e => {
  if (mediaLoaded || peerConn) {
    e.preventDefault();
    e.returnValue = '';
  }
});

document.addEventListener('keydown', e => {
  const isRefresh = e.key === 'F5'
    || (e.ctrlKey  && e.key === 'r')
    || (e.metaKey  && e.key === 'r');

  if (isRefresh && (mediaLoaded || peerConn)) {
    e.preventDefault();
    openM('mRefresh');
  }
});


/* ───────────────────────────────────────────────────────
   4. PEERJS LOADER & ROOM CREATION / JOINING
─────────────────────────────────────────────────────── */

/** Lazily loads the PeerJS library then calls cb(). */
function loadPeerJS(cb) {
  if (window.Peer) { cb(); return; }
  const s = document.createElement('script');
  s.src    = 'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js';
  s.onload = cb;
  s.onerror = () => toast('❌ Could not load PeerJS — check internet connection');
  document.head.appendChild(s);
}

/** Returns a random 6-character room code (no ambiguous chars). */
function rndCode() {
  const C = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => C[Math.random() * C.length | 0]).join('');
}

function createRoom() {
  roomCode = rndCode();
  role     = 'host';

  loadPeerJS(() => {
    peer = new Peer('wr-' + roomCode, { debug: 0 });

    peer.on('open', () => {
      enterRoom();
      document.getElementById('bigCode').textContent = roomCode;
      openM('mRoom');
      // Wait for a guest to connect
      peer.on('connection', c => { conn = c; wireConn(); });
    });

    peer.on('error', e => {
      if (e.type === 'unavailable-id') toast('⚠️ Code conflict — please try again');
      else toast('❌ Peer error: ' + e.type);
    });
  });
}

function joinRoom() {
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  if (code.length < 4) { toast('⚠️ Enter a valid room code'); return; }

  roomCode = code;
  role     = 'guest';

  loadPeerJS(() => {
    peer = new Peer({ debug: 0 });

    peer.on('open', () => {
      enterRoom();
      conn = peer.connect('wr-' + roomCode, { reliable: true });
      setDot('wait');
      setPeerLbl('Connecting…');
      conn.on('open',  () => wireConn());
      conn.on('error', () => toast('❌ Room not found — check the code'));
    });

    peer.on('error', () => toast('❌ Connection error'));
  });
}


/* ───────────────────────────────────────────────────────
   5. CONNECTION SETUP
   Called once the data channel opens (both sides).
─────────────────────────────────────────────────────── */
function wireConn() {
  peerConn = true;
  setDot('on');
  setPeerLbl('Connected 🟢');
  setRpPeer('Connected ✓', 'ok');
  document.getElementById('chatOnline').textContent = '2 online';
  sysMsg(role === 'host' ? '🎉 Guest joined the room!' : '🎬 Connected to host!');

  conn.on('data',  onData);
  conn.on('close', () => {
    peerConn = false;
    setDot('off');
    setPeerLbl('Peer left');
    setRpPeer('Disconnected', 'wn');
    document.getElementById('chatOnline').textContent = '1 online';
    sysMsg('😢 Peer left the room');
  });
  conn.on('error', () => { peerConn = false; setDot('off'); });

  // If host already has a file, tell the guest
  if (role === 'host' && mediaLoaded) emit({ type: 'meta', dur: vid.duration });
}


/* ───────────────────────────────────────────────────────
   6. SYNC PROTOCOL  (messages received from peer)
   Message types:
     chat          — chat text
     play          — host pressed play
     pause         — host pressed pause
     seek          — host scrubbed / skipped
     meta          — host file loaded (sent to guest)
     ready         — guest file loaded (sent to host)
     media-changed — host swapped media file (sent to guest)
─────────────────────────────────────────────────────── */
function onData(d) {

  if (d.type === 'chat') {
    addMsg(d.text, false);
    return;
  }

  if (d.type === 'play') {
    if (!mediaLoaded) return;
    isSyncing = true;
    vid.currentTime = d.time;
    vid.play().catch(() => {});
    setPlayUI(true);
    flash('▶ play');
    isSyncing = false;
    return;
  }

  if (d.type === 'pause') {
    if (!mediaLoaded) return;
    isSyncing = true;
    vid.currentTime = d.time;
    vid.pause();
    setPlayUI(false);
    flash('⏸ pause');
    isSyncing = false;
    return;
  }

  if (d.type === 'seek') {
    if (!mediaLoaded) return;
    isSyncing = true;
    vid.currentTime = d.time;
    flash('⏩ seek');
    isSyncing = false;
    return;
  }

  if (d.type === 'meta') {
    // Host has a file — update the guest-wait screen text
    document.getElementById('gwTitle').textContent = 'Host is ready!';
    document.getElementById('gwSub').innerHTML = 'Load <em>the same video</em> as your host.';
    return;
  }

  if (d.type === 'ready') {
    // Guest loaded their file — sync current playback state
    sysMsg('✅ Guest loaded their file — in sync!');
    if (role === 'host' && mediaLoaded) {
      emit({ type: vid.paused ? 'pause' : 'play', time: vid.currentTime });
    }
    return;
  }

  if (d.type === 'media-changed') {
    // Host swapped the file — reset guest player and show banner
    mediaLoaded = false;
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
    vid.style.display = 'none';
    setPlayUI(false);

    // Reset progress bar
    document.getElementById('progFill').style.width = '0%';
    document.getElementById('progKnob').style.left  = '0%';
    document.getElementById('tCur').textContent = '0:00';
    document.getElementById('tDur').textContent = '0:00';

    // Show top banner and guest-wait overlay
    document.getElementById('change-banner').classList.add('show');
    document.getElementById('guest-wait').style.display = 'flex';
    document.getElementById('gwTitle').textContent = '🔄 Host changed the media';
    document.getElementById('gwSub').innerHTML = 'Load <em>the new file</em> to stay in sync.';
    sysMsg('🔄 Host changed media — load your copy to continue.');
    return;
  }
}


/* ───────────────────────────────────────────────────────
   7. FILE LOADING & MEDIA-CHANGE FLOW
─────────────────────────────────────────────────────── */

/**
 * loadFile(file, isChange)
 *   file     — File object from <input> or drag-drop
 *   isChange — true when swapping an already-loaded file
 */
function loadFile(file, isChange) {
  if (!file) return;

  // Stop and clean up previous video
  vid.pause();
  vid.removeAttribute('src');
  vid.load();

  vid.src = URL.createObjectURL(file);
  vid.load();

  vid.onloadedmetadata = () => {
    mediaLoaded = true;

    // Hide loading screens
    document.getElementById('drop-zone').classList.add('hidden');
    document.getElementById('guest-wait').style.display = 'none';
    document.getElementById('change-banner').classList.remove('show');

    // Show video
    vid.style.display = 'block';
    setPlayUI(false);
    showCtrl();

    // Reveal "Change Media" controls now a file is loaded
    document.getElementById('btnChgCtrl').style.display = 'flex';
    document.getElementById('rpChgBtn').style.display   = 'flex';

    if (role === 'host') {
      if (isChange) {
        emit({ type: 'media-changed', filename: file.name });
        sysMsg('🔄 You changed the media — peer notified.');
        toast('🎬 New file loaded! Ready to play.');
      } else {
        if (peerConn) emit({ type: 'meta', dur: vid.duration });
        toast('🎬 Video loaded! You control playback.');
      }
    } else {
      hideBanner();
      if (peerConn) emit({ type: 'ready' });
      toast(isChange ? '🍿 New file ready! Waiting for host…' : '🍿 Loaded! Waiting for host to play…');
    }
  };

  vid.onerror = () => toast('❌ Could not load this file — try a different format');
}

/** Host clicks the "Change Media" button — show confirm modal or pick directly. */
function requestChangeMedia() {
  if (role === 'host') {
    openM('mChange'); // confirm dialog first
  } else {
    // Guest swaps silently
    document.getElementById('fileChg').click();
  }
}

/** Called from "Choose New File" button inside the confirm modal. */
function doChangeMedia() {
  closeM('mChange');
  document.getElementById('fileChg').click();
}

/** Called from "Load file" button on the change-media banner (guest). */
function triggerChangeFile() {
  hideBanner();
  document.getElementById('fileChg').click();
}

function hideBanner() {
  document.getElementById('change-banner').classList.remove('show');
}


/* ───────────────────────────────────────────────────────
   8. PLAYER CONTROLS
─────────────────────────────────────────────────────── */
function togglePlay() {
  if (!mediaLoaded) { toast('Load a video file first 👆'); return; }

  if (vid.paused) {
    vid.play().then(() => {
      setPlayUI(true);
      if (!isSyncing) emit({ type: 'play', time: vid.currentTime });
    }).catch(() => {});
  } else {
    vid.pause();
    setPlayUI(false);
    if (!isSyncing) emit({ type: 'pause', time: vid.currentTime });
  }
}

/** Skip forward or backward by `s` seconds. */
function skip(s) {
  if (!mediaLoaded) return;
  const t = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + s));
  vid.currentTime = t;
  emit({ type: 'seek', time: t });
}

function toggleMute() {
  vid.muted = !vid.muted;
  document.getElementById('icVol').style.display  = vid.muted ? 'none' : '';
  document.getElementById('icMute').style.display = vid.muted ? '' : 'none';
  document.getElementById('btnMute').classList.toggle('lit', vid.muted);
}

function setVol(v) { vid.volume = parseFloat(v); }


/* ───────────────────────────────────────────────────────
   9. PROGRESS BAR SCRUBBING
─────────────────────────────────────────────────────── */
function startScrub(e) {
  if (!mediaLoaded) return;
  e.preventDefault();
  doScrub(e);

  const mm  = e.type === 'mousedown' ? 'mousemove' : 'touchmove';
  const mu  = e.type === 'mousedown' ? 'mouseup'   : 'touchend';
  const mv  = ev => doScrub(ev);
  const end = () => {
    document.removeEventListener(mm, mv);
    document.removeEventListener(mu, end);
    emit({ type: 'seek', time: vid.currentTime });
  };

  document.addEventListener(mm, mv);
  document.addEventListener(mu, end);
}

function doScrub(e) {
  const r = document.getElementById('progArea').getBoundingClientRect();
  const x = e.touches ? e.touches[0].clientX : e.clientX;
  vid.currentTime = Math.max(0, Math.min(1, (x - r.left) / r.width)) * (vid.duration || 0);
}


/* ───────────────────────────────────────────────────────
   10. VIDEO ELEMENT EVENT LISTENERS
─────────────────────────────────────────────────────── */
vid.addEventListener('timeupdate', () => {
  if (!vid.duration) return;
  const p = (vid.currentTime / vid.duration) * 100;
  document.getElementById('progFill').style.width = p + '%';
  document.getElementById('progKnob').style.left  = p + '%';
  document.getElementById('tCur').textContent = fmt(vid.currentTime);
  document.getElementById('tDur').textContent = fmt(vid.duration);
});

vid.addEventListener('play',  () => { if (!isSyncing) emit({ type: 'play',  time: vid.currentTime }); setPlayUI(true); });
vid.addEventListener('pause', () => { if (!isSyncing) emit({ type: 'pause', time: vid.currentTime }); setPlayUI(false); });
vid.addEventListener('ended', () => setPlayUI(false));
vid.addEventListener('click', togglePlay);

// Double-click on the video element → toggle fullscreen
document.getElementById('playerWrap').addEventListener('dblclick', e => {
  if (e.target === vid) toggleFS();
});


/* ───────────────────────────────────────────────────────
   11. DRAG-AND-DROP ONTO PLAYER
─────────────────────────────────────────────────────── */
const dzEl = document.getElementById('drop-zone');
const pw   = document.getElementById('playerWrap');

pw.addEventListener('dragover', e => {
  e.preventDefault();
  dzEl.classList.add('drag-over');
});
pw.addEventListener('dragleave', () => dzEl.classList.remove('drag-over'));
pw.addEventListener('drop', e => {
  e.preventDefault();
  dzEl.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  // If a file is already loaded, treat it as a media change
  loadFile(f, mediaLoaded);
});


/* ───────────────────────────────────────────────────────
   12. KEYBOARD SHORTCUTS
─────────────────────────────────────────────────────── */
document.addEventListener('keydown', e => {
  // Don't fire shortcuts while typing in an input
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

  if      (e.code === 'Space')       { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowLeft')   skip(-10);
  else if (e.code === 'ArrowRight')  skip(10);
  else if (e.code === 'KeyM')        toggleMute();
  else if (e.code === 'KeyF')        toggleFS();
  else if (e.code === 'KeyC')        toggleFChat();
});


/* ───────────────────────────────────────────────────────
   13. CONTROLS OVERLAY VISIBILITY
─────────────────────────────────────────────────────── */
function showCtrl() {
  if (!mediaLoaded) return;
  document.getElementById('ctrl').classList.add('show');
}

function schedHide() {
  clearTimeout(ctrlTimer);
  ctrlTimer = setTimeout(() => {
    if (!vid.paused) document.getElementById('ctrl').classList.remove('show');
  }, 2600);
}

function onMove() { showCtrl(); schedHide(); }


/* ───────────────────────────────────────────────────────
   14. FULLSCREEN
─────────────────────────────────────────────────────── */
function toggleFS() {
  if (!document.fullscreenElement)
    document.getElementById('playerWrap').requestFullscreen().catch(() => {});
  else
    document.exitFullscreen();
}

document.addEventListener('fullscreenchange', () => {
  const fs = !!document.fullscreenElement;

  document.getElementById('icFS').style.display = fs ? 'none' : '';
  document.getElementById('icEX').style.display = fs ? '' : 'none';

  // Hide side panels in fullscreen; show floating chat instead
  document.getElementById('chatSide').style.display   = fs ? 'none' : 'flex';
  document.getElementById('rightPanel').style.display = fs ? 'none' : 'flex';

  if (fs) {
    document.getElementById('fchat').classList.add('open');
    document.getElementById('btnFChat').classList.add('lit');
  } else {
    document.getElementById('fchat').classList.remove('open');
    document.getElementById('btnFChat').classList.remove('lit');
  }
});


/* ───────────────────────────────────────────────────────
   15. FLOATING CHAT
─────────────────────────────────────────────────────── */
function toggleFChat() {
  const fc = document.getElementById('fchat');
  fc.classList.toggle('open');
  document.getElementById('btnFChat').classList.toggle('lit', fc.classList.contains('open'));
}

function minFChat() {
  fcMin = !fcMin;
  document.getElementById('fchat').classList.toggle('minimized', fcMin);
}

function closeFChat() {
  document.getElementById('fchat').classList.remove('open');
  document.getElementById('btnFChat').classList.remove('lit');
}

// Drag the floating chat window around
(() => {
  const h = document.getElementById('fcHead');
  const b = document.getElementById('fchat');
  let ox, oy, bx, by, drag = false;

  h.addEventListener('mousedown', e => {
    drag = true;
    ox = e.clientX; oy = e.clientY;
    const r = b.getBoundingClientRect();
    bx = r.left; by = r.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!drag) return;
    b.style.right  = 'auto';
    b.style.bottom = 'auto';
    b.style.left   = Math.max(0, bx + (e.clientX - ox)) + 'px';
    b.style.top    = Math.max(0, by + (e.clientY - oy)) + 'px';
  });

  document.addEventListener('mouseup', () => drag = false);
})();


/* ───────────────────────────────────────────────────────
   16. CHAT — SEND & RENDER
─────────────────────────────────────────────────────── */

/** Send a chat message from either the sidebar or the floating input. */
function sendChat(fromFloat) {
  const inp = document.getElementById(fromFloat ? 'fcIn' : 'chatInp');
  const t = inp.value.trim();
  if (!t) return;
  inp.value = '';
  addMsg(t, true);
  emit({ type: 'chat', text: t });
}

/** Render a chat message bubble in both the sidebar and floating chat. */
function addMsg(text, mine) {
  // ── Sidebar ──
  const box  = document.getElementById('msgs');
  const wrap = document.createElement('div'); wrap.className = 'mb ' + (mine ? 'me' : 'them');
  const who  = document.createElement('div'); who.className = 'mb-who'; who.textContent = mine ? 'you' : 'them';
  const txt  = document.createElement('div'); txt.className = 'mb-txt'; txt.textContent = text;
  wrap.append(who, txt);
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;

  // ── Floating chat ──
  const fb = document.getElementById('fmsgs');
  const fd = document.createElement('div'); fd.className = 'fm ' + (mine ? 'fme' : 'fpe'); fd.textContent = text;
  fb.appendChild(fd);
  fb.scrollTop = fb.scrollHeight;
}

/** Render a system/status message (centred, muted) in both panels. */
function sysMsg(text) {
  // Sidebar
  const box  = document.getElementById('msgs');
  const wrap = document.createElement('div'); wrap.className = 'mb sys';
  const txt  = document.createElement('div'); txt.className = 'mb-txt'; txt.textContent = text;
  wrap.appendChild(txt);
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;

  // Floating
  const fb = document.getElementById('fmsgs');
  const fd = document.createElement('div'); fd.className = 'fm fsy'; fd.textContent = text;
  fb.appendChild(fd);
  fb.scrollTop = fb.scrollHeight;
}


/* ───────────────────────────────────────────────────────
   17. UI HELPERS
─────────────────────────────────────────────────────── */

/** Switch from landing page to room view. */
function enterRoom() {
  document.getElementById('page-land').style.display = 'none';
  document.getElementById('page-room').style.display = 'flex';

  document.getElementById('codeDisp').textContent = roomCode;
  document.getElementById('rpCode').textContent   = roomCode;
  document.getElementById('roleChip').textContent = role === 'host' ? '🎬 Host' : '👀 Guest';
  document.getElementById('rpRole').textContent   = role === 'host'
    ? 'Host — controls playback' : 'Guest — synced viewer';

  if (role === 'guest') {
    document.getElementById('drop-zone').classList.add('hidden');
    document.getElementById('guest-wait').style.display = 'flex';
  }
}

/** Update play/pause button icons. */
function setPlayUI(playing) {
  document.getElementById('icPlay').style.display  = playing ? 'none' : '';
  document.getElementById('icPause').style.display = playing ? '' : 'none';
  if (playing) schedHide(); else showCtrl();
}

/** Flash the "⚡ synced" badge for 2 seconds. */
function flash(msg) {
  const el = document.getElementById('syncBadge');
  el.textContent = '⚡ ' + msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2000);
}

/** Set the peer connection status dot (off / wait / on). */
function setDot(s) {
  const d = document.getElementById('peerDot');
  d.className = 'pdot';
  if (s === 'on')   d.classList.add('on');
  if (s === 'wait') d.classList.add('wait');
}

function setPeerLbl(t)    { document.getElementById('peerLbl').textContent = t; }

function setRpPeer(t, cls) {
  const el = document.getElementById('rpPeer');
  el.textContent = t;
  el.className   = 'rp-val ' + cls;
}

/** Open / close a modal by its HTML id. */
function openM(id)  { document.getElementById(id).classList.add('open'); }
function closeM(id) { document.getElementById(id).classList.remove('open'); }

/** Leave room: notify peer, close connections, reload page. */
function doLeave() {
  emit({ type: 'chat', text: '— ' + role + ' left the room' });
  setTimeout(() => {
    try { conn && conn.close(); }  catch(e) {}
    try { peer && peer.destroy(); } catch(e) {}
    location.reload();
  }, 180);
}

function copyCode() {
  navigator.clipboard.writeText(roomCode).catch(() => {});
  toast('📋 Copied: ' + roomCode);
}

/** Send a message over the PeerJS data channel (silently fails if not connected). */
function emit(d) {
  if (conn && conn.open) {
    try { conn.send(d); } catch(e) {}
  }
}

/** Format seconds as M:SS */
function fmt(s) {
  if (isNaN(s)) return '0:00';
  return Math.floor(s / 60) + ':' + Math.floor(s % 60).toString().padStart(2, '0');
}

/** Show a brief toast notification at the bottom of the screen. */
let _tt;
function toast(msg) {
  document.getElementById('toastTxt').textContent = msg;
  const el = document.getElementById('toast');
  el.classList.add('show');
  clearTimeout(_tt);
  _tt = setTimeout(() => el.classList.remove('show'), 3400);
}

/** Clean up connections before the page unloads normally. */
window.addEventListener('beforeunload', () => {
  try { conn && conn.close(); }  catch(e) {}
  try { peer && peer.destroy(); } catch(e) {}
});
