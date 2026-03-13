/* ═══════════════════════════════════════════════════════
   watchroom — app.js  (v4 — audio fixed)

   AUDIO STRATEGY:
   ┌──────────────────────────────────────────────────┐
   │  HOST                                            │
   │  <video id="vid"> — muted, feeds captureStream  │
   │  <audio id="hostAud"> — same ObjectURL, audible │
   │  → host sees video + hears audio normally        │
   │  → captureStream() captures video+audio tracks   │
   │    and sends them to guest via WebRTC            │
   │                                                  │
   │  GUEST                                           │
   │  <video id="vid"> srcObject = remoteStream       │
   │  Starts muted (browser autoplay policy)          │
   │  "Click for audio" banner → unmutes on click     │
   │  Mute button works independently                 │
   └──────────────────────────────────────────────────┘

   Sections:
     1.  Theme
     2.  State
     3.  Refresh guard
     4.  PeerJS / room creation / joining
     5.  Data channel (wireConn)
     6.  Media stream (host → guest)
     7.  Sync protocol (onData)
     8.  File loading (host only)
     9.  Player controls
    10.  Scrubbing
    11.  Video event listeners
    12.  Drag-and-drop
    13.  Keyboard shortcuts
    14.  Controls overlay
    15.  Fullscreen
    16.  Floating chat
    17.  Chat messages
    18.  UI helpers
═══════════════════════════════════════════════════════ */


/* ── 1. THEME ─────────────────────────────────────── */
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.querySelectorAll('.td,.ts').forEach(b => b.classList.remove('on'));
  document.querySelectorAll(`[data-t="${t}"]`).forEach(b => b.classList.add('on'));
  
  // Update toggle icons
  const isLight = t === 'light';
  const icSun = document.getElementById('icSun');
  const icMoon = document.getElementById('icMoon');
  if (icSun && icMoon) {
    icSun.style.display = isLight ? 'block' : 'none';
    icMoon.style.display = isLight ? 'none' : 'block';
  }
  
  localStorage.setItem('wr-theme', t);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'midnight';
  setTheme(current === 'light' ? 'midnight' : 'light');
}

// Initial theme load
(function initTheme() {
  const saved = localStorage.getItem('wr-theme') || 'midnight';
  setTheme(saved);
})();


/* ── 2. STATE ─────────────────────────────────────── */
let role            = null;
let roomCode        = '';
let peer            = null;
let conn            = null;
let mediaCall       = null;
let peerConn        = false;
let mediaLoaded     = false;
let isSyncing       = false;
let ctrlTimer       = null;
let fcMin           = false;
let currentFilename = '';
let hostStream      = null;
let hostObjURL      = null;   // ObjectURL kept for hostAud element
let subObjectURLs   = [];     // ObjectURLs for loaded subtitle blobs
let currentSubIdx   = -1;     // active subtitle track index (-1 = off)
let subCues         = [];     // parsed cue array [{start,end,text}]
let subRafId        = null;   // requestAnimationFrame handle
let subLastText     = null;   // last emitted cue text (avoid duplicate emits)

const vid     = document.getElementById('vid');
const hostAud = document.getElementById('hostAud'); // hidden <audio> for host's local audio


/* ── 3. REFRESH GUARD ─────────────────────────────── */
window.addEventListener('beforeunload', e => {
  if (mediaLoaded || peerConn) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('keydown', e => {
  const ref = e.key==='F5' || (e.ctrlKey&&e.key==='r') || (e.metaKey&&e.key==='r');
  if (ref && (mediaLoaded || peerConn)) { e.preventDefault(); openM('mRefresh'); }
});


/* ── 4. PEERJS / ROOM ─────────────────────────────── */
function loadPeerJS(cb) {
  if (window.Peer) { cb(); return; }
  const s = document.createElement('script');
  s.src = 'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js';
  s.onload = cb;
  s.onerror = () => toast('Could not load PeerJS — check connection');
  document.head.appendChild(s);
}

function rndCode() {
  const C = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6}, () => C[Math.random()*C.length|0]).join('');
}

function createRoom() {
  roomCode = rndCode(); role = 'host';
  loadPeerJS(() => {
    peer = new Peer('wr-' + roomCode, {debug:0});
    peer.on('open', () => {
      enterRoom();
      document.getElementById('bigCode').textContent = roomCode;
      openM('mRoom');
      peer.on('connection', c => { conn = c; wireConn(); });
    });
    peer.on('error', e => toast(e.type === 'unavailable-id' ? 'Code conflict — try again' : 'Peer error: ' + e.type));
  });
}

function joinRoom() {
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  if (code.length < 4) { toast('Enter a valid room code'); return; }
  roomCode = code; role = 'guest';
  loadPeerJS(() => {
    peer = new Peer({debug:0});
    peer.on('open', () => {
      enterRoom(); setDot('wait'); setPeerLbl('Connecting…');
      conn = peer.connect('wr-' + roomCode, {reliable:true});
      conn.on('open',  () => wireConn());
      conn.on('error', () => toast('Room not found — check the code'));

      // Receive the host's video+audio stream
      peer.on('call', incoming => {
        mediaCall = incoming;
        incoming.answer(); // no outgoing stream from guest
        incoming.on('stream', s => receiveStream(s));
        incoming.on('error',  () => toast('Stream error — try rejoining'));
        incoming.on('close',  () => {
          if (role !== 'guest') return;
          mediaLoaded = false; vid.srcObject = null; vid.style.display = 'none';
        });
      });
    });
    peer.on('error', () => toast('Connection error'));
  });
}


/* ── 5. DATA CHANNEL ──────────────────────────────── */
function wireConn() {
  peerConn = true;
  setDot('on'); setPeerLbl('Connected'); setRpPeer('Connected', 'ok');
  document.getElementById('chatOnline').textContent = '2 online';
  sysMsg(role === 'host' ? '🎉 Guest joined! Sending stream…' : '🎬 Connected! Waiting for stream…');

  conn.on('data', onData);
  conn.on('close', () => {
    peerConn = false; setDot('off'); setPeerLbl('Peer left'); setRpPeer('Disconnected','wn');
    document.getElementById('chatOnline').textContent = '1 online';
    sysMsg('😢 Peer disconnected');
    if (role === 'guest') {
      mediaLoaded = false; vid.srcObject = null; vid.style.display = 'none';
      showGuestWaiting('Host disconnected', 'Re-join to reconnect.');
    }
  });
  conn.on('error', () => { peerConn = false; setDot('off'); });

  if (role === 'host' && mediaLoaded && hostStream) callGuest();
}


/* ── 6. MEDIA STREAM ────────────────────────────────── */

/**
 * buildHostStream() — async, returns Promise<bool>.
 *
 * BLACK SCREEN ROOT CAUSE:
 *   captureStream() on a <video> sends only a black/frozen frame when:
 *     (a) the element is MUTED at call-time, OR
 *     (b) the element is PAUSED (no frames flowing through the encoder).
 *   Chrome requires the element to be UN-MUTED and ACTIVELY PLAYING when
 *   captureStream() is called.
 *
 * FIX — exact sequence:
 *   1. vid.muted = false            unmute before capture
 *   2. vid.play() + 1 rAF tick      ensure frames are flowing
 *   3. captureStream()              capture live video+audio
 *   4. vid.pause()                  pause back (host controls playback)
 *   5. vid.muted = true             mute vid; host hears via hostAud
 *   6. hostAud mirrors same src     host hears their own video
 *
 * NEVER use AudioContext/createMediaElementSource — it hijacks the element
 * pipeline and causes a permanent black screen.
 */
function buildHostStream() {
  return new Promise(resolve => {
    try {
      vid.muted = false; // must be unmuted at capture time

      const doCapture = () => {
        let stream = null;
        try {
          stream = vid.captureStream
            ? vid.captureStream()
            : vid.mozCaptureStream
            ? vid.mozCaptureStream()
            : null;
        } catch(e) {}

        if (!stream) {
          toast('captureStream not supported — use Chrome or Edge');
          resolve(false); return;
        }

        hostStream = stream;

        // Mute vid — host hears through hostAud, guest hears through stream.
        vid.muted = true;
        vid.pause();
        if (hostObjURL) {
          hostAud.src         = hostObjURL;
          hostAud.currentTime = vid.currentTime;
          hostAud.volume      = 1;
          hostAud.muted       = false;
        }
        resolve(true);
      };

      // Video must be playing so the encoder has live frames to send.
      vid.play().then(() => requestAnimationFrame(doCapture))
                .catch(() => doCapture()); // fallback if play() fails

    } catch(e) {
      console.error('buildHostStream error:', e);
      toast('Stream build error — try reloading');
      resolve(false);
    }
  });
}

function callGuest() {
  if (!peerConn || !hostStream) return;
  if (mediaCall) { try { mediaCall.close(); } catch(e) {} }
  mediaCall = peer.call(conn.peer, hostStream);
  mediaCall.on('error', () => toast('Stream call error'));
  emit({type:'meta', dur:vid.duration, filename:currentFilename});
  sysMsg('📡 Streaming to guest…');
  toast('📡 Streaming video + audio to guest!');
}

/**
 * GUEST: Receive stream.
 *
 * HOW GUEST AUDIO WORKS:
 *   - Stream starts MUTED so browser autoplay policy allows it.
 *   - An "🔊 Click for audio" banner appears.
 *   - On any click/tap → unmute. From then on the mute button
 *     works normally as an independent volume control.
 */
function receiveStream(stream) {
  // DON'T call vid.load() — resets decoder and drops quality to lowest bitrate
  vid.srcObject   = stream;
  vid.muted       = true;    // must start muted — browser blocks autoplay with audio
  vid.playsInline = true;
  vid.style.display = 'block';

  let started = false;

  const startVideo = () => {
    // Set started SYNCHRONOUSLY before play() — both loadedmetadata and canplay
    // can fire almost simultaneously, and play() is async, so checking started
    // inside .then() is too late — causes multiple play() calls and black screen.
    if (started) return;
    started = true;

    // Remove the other listener immediately so it never fires again
    vid.removeEventListener('loadedmetadata', startVideo);
    vid.removeEventListener('canplay',        startVideo);

    vid.play().then(() => {
      mediaLoaded = true;
      document.getElementById('guest-wait').style.display = 'none';
      document.getElementById('change-banner').classList.remove('show');
      setPlayUI(true);
      showCtrl();
      sysMsg('✅ Stream connected!');
      showUnmuteBanner();
    }).catch(() => {
      // Autoplay blocked — let user tap to start
      started = false;
      vid.style.display = 'none';
      showGuestWaiting('Tap to watch 👇', 'Click to start the stream.');
      document.getElementById('guest-wait').addEventListener('click', () => {
        vid.style.display = 'block';
        startVideo();
      }, { once: true });
    });
  };

  vid.addEventListener('loadedmetadata', startVideo);
  vid.addEventListener('canplay',        startVideo);
  vid.onerror = () => toast('Stream error — try rejoining');
}

/* Unmute banner — shown to guest after stream starts */
function showUnmuteBanner() {
  const b = document.getElementById('unmute-banner');
  if (b) b.style.display = 'flex';
}
function hideUnmuteBanner() {
  const b = document.getElementById('unmute-banner');
  if (b) b.style.display = 'none';
}

/* Guest explicitly enables audio from the unmute banner */
function guestEnableAudio() {
  vid.muted = false;
  vid._audioEnabled = true;
  hideUnmuteBanner();
  updateMuteUI(false);
  toast('🔊 Audio on!');
}

function recallGuest() {
  if (!peerConn) return;
  emit({type:'media-changed', filename:currentFilename});
  if (hostStream) setTimeout(() => callGuest(), 400);
}


/* ── 7. SYNC PROTOCOL ─────────────────────────────── */
function onData(d) {
  if (d.type === 'chat') { addMsg(d.text, false); return; }

  if (d.type === 'play') {
    isSyncing = true;
    if (vid.srcObject) vid.play().catch(() => {});
    setPlayUI(true); flash('▶ play'); isSyncing = false; return;
  }
  if (d.type === 'pause') {
    isSyncing = true;
    if (vid.srcObject) vid.pause();
    setPlayUI(false); flash('⏸ pause'); isSyncing = false; return;
  }
  if (d.type === 'seek') {
    flash('⏩ ' + fmt(d.time));
    document.getElementById('tCur').textContent = fmt(d.time); return;
  }
  if (d.type === 'timeupdate') {
    const p = d.dur > 0 ? (d.time / d.dur) * 100 : 0;
    document.getElementById('progFill').style.width = p + '%';
    document.getElementById('progKnob').style.left  = p + '%';
    document.getElementById('tCur').textContent = fmt(d.time);
    document.getElementById('tDur').textContent = fmt(d.dur); return;
  }
  if (d.type === 'meta') {
    document.getElementById('tDur').textContent = fmt(d.dur);
    currentFilename = d.filename || ''; return;
  }
  if (d.type === 'media-changed') {
    mediaLoaded = false;
    if (vid.srcObject) { vid.pause(); vid.srcObject = null; }
    vid.style.display = 'none'; setPlayUI(false);
    document.getElementById('progFill').style.width = '0%';
    document.getElementById('progKnob').style.left  = '0%';
    document.getElementById('tCur').textContent = '0:00';
    document.getElementById('tDur').textContent = '0:00';
    clearSubOverlay();
    showGuestWaiting('Host changed media 🔄', 'New stream incoming…');
    sysMsg('🔄 Host changed media — new stream incoming…'); return;
  }
  if (d.type === 'sub-cue') { if (role === 'guest') showSubOverlay(d.text); return; }
  if (d.type === 'sub-off') { if (role === 'guest') clearSubOverlay(); return; }
}


/* ── 8. FILE LOADING — HOST ONLY ──────────────────── */
function loadFile(file, isChange) {
  if (!file || role !== 'host') return;
  currentFilename = file.name;

  // Reset state. Never .stop() captureStream tracks — they are live refs.
  vid.pause();
  if (hostAud) { hostAud.pause(); hostAud.src = ''; }
  hostStream = null;
  if (hostObjURL) { URL.revokeObjectURL(hostObjURL); hostObjURL = null; }

  // Clear subtitle state from previous file
  vid.querySelectorAll('track').forEach(t => t.remove());
  subObjectURLs.forEach(u => URL.revokeObjectURL(u));
  subObjectURLs = []; subCues = []; currentSubIdx = -1; subLastText = null;
  cancelAnimationFrame(subRafId);
  clearSubOverlay();
  const btnCC = document.getElementById('btnCC');
  if (btnCC) btnCC.classList.remove('lit');

  vid.removeAttribute('src'); vid.srcObject = null; vid.load();

  hostObjURL = URL.createObjectURL(file);
  vid.src = hostObjURL;
  vid.load();

  const onCanPlay = () => {
    vid.removeEventListener('canplay', onCanPlay);
    mediaLoaded = true;

    document.getElementById('drop-zone').classList.add('hidden');
    vid.style.display = 'block';
    setPlayUI(false); showCtrl();
    document.getElementById('btnChgCtrl').style.display = 'flex';
    document.getElementById('rpChgBtn').style.display   = 'flex';

    // buildHostStream is async: plays 1 frame, captures, then resolves.
    buildHostStream().then(ok => {
      if (!ok) return;
      if (isChange) {
        recallGuest();
        toast('🎬 New file loaded! Re-streaming…');
      } else {
        if (peerConn) callGuest();
        else sysMsg('📂 File ready — waiting for guest to join…');
        toast('🎬 Video ready! Share the code with your guest.');
      }
      if (peerConn) emit({type:'meta', dur:vid.duration, filename:file.name});
    });
  };

  vid.addEventListener('canplay', onCanPlay);
  vid.onerror = () => toast('Could not load this file — try a different format');
}

function requestChangeMedia() { if (role === 'host') openM('mChange'); }
function doChangeMedia()      { closeM('mChange'); document.getElementById('fileChg').click(); }
function hideBanner()         { document.getElementById('change-banner').classList.remove('show'); }


/* ── 9. SUBTITLES & AUDIO TRACKS ─────────────────── */

/* Convert SRT text to WebVTT */
function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/(\d+)\n(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1\n$2.$3')
    .replace(/ --> (\d{2}:\d{2}:\d{2}),(\d{3})/g, ' --> $1.$2');
}

/* Parse VTT text into [{start, end, text}] */
function parseVttCues(vttText) {
  const cues = [];
  const blocks = vttText.replace(/\r\n/g, '\n').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex(l => l.includes(' --> '));
    if (ti < 0) continue;
    const toSec = s => {
      const p = s.trim().split(':');
      return +p[0] * 3600 + +p[1] * 60 + parseFloat(p[2].replace(',', '.'));
    };
    const [rawS, rawE] = lines[ti].split(' --> ');
    const text = lines.slice(ti + 1).join('\n').trim();
    if (text) cues.push({ start: toSec(rawS), end: toSec(rawE), text });
  }
  return cues;
}

/* Load subtitle file — HOST only */
function loadSubtitle(file) {
  if (!file || role !== 'host') return;
  const reader = new FileReader();
  reader.onload = e => {
    let text = e.target.result;
    if (file.name.toLowerCase().endsWith('.srt')) text = srtToVtt(text);
    const cues = parseVttCues(text);
    const blob = new Blob([text], { type: 'text/vtt' });
    const url  = URL.createObjectURL(blob);
    subObjectURLs.push(url);
    const track = document.createElement('track');
    track.kind  = 'subtitles';
    track.label = file.name.replace(/\.(vtt|srt)$/i, '');
    track.src   = url;
    track._cues = cues;
    vid.appendChild(track);
    buildSubList();
    activateSub(vid.textTracks.length - 1);
    toast('📄 Subtitles: ' + track.label);
  };
  reader.readAsText(file);
  document.getElementById('fileSubtitle').value = '';
}

/* Activate subtitle track index (-1 = off) */
function activateSub(idx) {
  currentSubIdx = idx;
  // Set all tracks to hidden (we render manually via overlay)
  for (let i = 0; i < vid.textTracks.length; i++) vid.textTracks[i].mode = 'hidden';
  cancelAnimationFrame(subRafId);
  if (idx >= 0 && vid.querySelectorAll('track')[idx]) {
    subCues = vid.querySelectorAll('track')[idx]._cues || [];
    document.getElementById('btnCC').classList.add('lit');
    startSubRaf();
  } else {
    subCues = []; subLastText = null;
    clearSubOverlay();
    emit({ type: 'sub-off' });
    document.getElementById('btnCC').classList.remove('lit');
  }
  buildSubList();
  closeSubMenu();
}

/* RAF loop — find current cue and push to overlay + guest */
function startSubRaf() {
  cancelAnimationFrame(subRafId);
  const tick = () => {
    subRafId = requestAnimationFrame(tick);
    const t    = vid.currentTime;
    const cue  = subCues.find(c => t >= c.start && t < c.end) || null;
    const text = cue ? cue.text : '';
    if (text === subLastText) return;
    subLastText = text;
    showSubOverlay(text);
    if (peerConn) emit(text ? { type: 'sub-cue', text } : { type: 'sub-off' });
  };
  subRafId = requestAnimationFrame(tick);
}

/* Show / clear the overlay div */
function showSubOverlay(text) {
  const el = document.getElementById('sub-overlay');
  if (!text) { clearSubOverlay(); return; }
  el.innerHTML = text.replace(/\n/g, '<br>');
  el.classList.add('has-text');
}
function clearSubOverlay() {
  subLastText = null;
  const el = document.getElementById('sub-overlay');
  if (el) { el.classList.remove('has-text'); el.innerHTML = ''; }
}

/* Build the subtitle track list inside the dropdown */
function buildSubList() {
  const list = document.getElementById('subTrackList');
  list.innerHTML = '';
  const offBtn = document.createElement('button');
  offBtn.className = 'sub-item' + (currentSubIdx === -1 ? ' active' : '');
  offBtn.textContent = 'Off';
  offBtn.onclick = () => activateSub(-1);
  list.appendChild(offBtn);
  vid.querySelectorAll('track').forEach((t, i) => {
    const btn = document.createElement('button');
    btn.className = 'sub-item' + (i === currentSubIdx ? ' active' : '');
    btn.textContent = t.label || ('Track ' + (i + 1));
    btn.onclick = () => activateSub(i);
    list.appendChild(btn);
  });
  // Load button only visible to host
  const lb = document.getElementById('subLoadBtn');
  if (lb) lb.style.display = role === 'host' ? '' : 'none';
}

/* Toggle subtitle dropdown */
function toggleSubMenu() {
  closeAudMenu();
  buildSubList();
  document.getElementById('subMenu').classList.toggle('open');
}
function closeSubMenu() { document.getElementById('subMenu').classList.remove('open'); }

/* Build and toggle audio track dropdown */
function buildAudList() {
  const tracks = vid.audioTracks;
  const wrap   = document.getElementById('audWrap');
  if (!tracks || tracks.length <= 1) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const list = document.getElementById('audTrackList');
  list.innerHTML = '';
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const btn = document.createElement('button');
    btn.className = 'sub-item' + (t.enabled ? ' active' : '');
    btn.textContent = t.label || t.language || ('Track ' + (i + 1));
    btn.onclick = () => {
      for (let j = 0; j < tracks.length; j++) tracks[j].enabled = (j === i);
      buildAudList();
      closeAudMenu();
      toast('🎵 Audio: ' + (t.label || t.language || 'Track ' + (i + 1)));
    };
    list.appendChild(btn);
  }
}
function toggleAudMenu() {
  closeSubMenu();
  buildAudList();
  document.getElementById('audMenu').classList.toggle('open');
}
function closeAudMenu() { document.getElementById('audMenu').classList.remove('open'); }

// Refresh audio track list when a new file is ready (host only)
vid.addEventListener('loadedmetadata', () => { if (role === 'host') buildAudList(); });

// Close both dropdowns on any outside click
document.addEventListener('click', e => {
  if (!e.target.closest('#subWrap')) closeSubMenu();
  if (!e.target.closest('#audWrap')) closeAudMenu();
});


/* ── 10. PLAYER CONTROLS ───────────────────────────── */
function togglePlay() {
  if (role !== 'host') { toast('Only the host controls playback 🎬'); return; }
  if (!mediaLoaded)    { toast('Load a video file first 👆'); return; }
  if (vid.paused) {
    vid.play().then(() => {
      if (hostAud) hostAud.play().catch(() => {});
      setPlayUI(true);
      emit({type:'play', time:vid.currentTime});
    }).catch(() => {});
  } else {
    vid.pause();
    if (hostAud) hostAud.pause();
    setPlayUI(false);
    emit({type:'pause', time:vid.currentTime});
  }
}

function skip(s) {
  if (role !== 'host' || !mediaLoaded) return;
  const t = Math.max(0, Math.min(vid.duration||0, vid.currentTime + s));
  vid.currentTime = t;
  if (hostAud) hostAud.currentTime = t;
  emit({type:'seek', time:t});
}

function toggleMute() {
  if (role === 'guest') {
    // Guest: toggle their own local video volume only — completely independent of host
    vid.muted = !vid.muted;
    updateMuteUI(vid.muted);
    // If they were on the unmute banner and press M, hide it
    if (!vid.muted) hideUnmuteBanner();
    return;
  }
  // Host: toggle local speaker only — vid stays muted, stream to guest unaffected.
  if (hostAud) {
    hostAud.muted = !hostAud.muted;
    updateMuteUI(hostAud.muted);
  }
}

function updateMuteUI(muted) {
  document.getElementById('icVol').style.display  = muted ? 'none' : '';
  document.getElementById('icMute').style.display = muted ? '' : 'none';
  document.getElementById('btnMute').classList.toggle('lit', muted);
}

function setVol(v) {
  const val = parseFloat(v);
  if (role === 'host' && hostAud) {
    hostAud.volume = val;
    if (val === 0) updateMuteUI(true);
    else if (hostAud.muted) { hostAud.muted = false; updateMuteUI(false); }
  } else {
    vid.volume = val;
    if (val === 0) updateMuteUI(true);
    else if (vid.muted) { vid.muted = false; updateMuteUI(false); }
  }
}


/* ── 10. SCRUBBING — HOST ONLY ────────────────────── */
function startScrub(e) {
  if (role !== 'host' || !mediaLoaded) return;
  e.preventDefault(); doScrub(e);
  const mm = e.type==='mousedown' ? 'mousemove' : 'touchmove';
  const mu = e.type==='mousedown' ? 'mouseup'   : 'touchend';
  const mv = ev => doScrub(ev);
  const end = () => {
    document.removeEventListener(mm, mv);
    document.removeEventListener(mu, end);
    if (hostAud) hostAud.currentTime = vid.currentTime;
    emit({type:'seek', time:vid.currentTime});
  };
  document.addEventListener(mm, mv);
  document.addEventListener(mu, end);
}
function doScrub(e) {
  const r = document.getElementById('progArea').getBoundingClientRect();
  const x = e.touches ? e.touches[0].clientX : e.clientX;
  vid.currentTime = Math.max(0, Math.min(1, (x-r.left)/r.width)) * (vid.duration||0);
}


/* ── 11. VIDEO EVENT LISTENERS ────────────────────── */
vid.addEventListener('timeupdate', () => {
  if (!vid.duration || role !== 'host') return;
  const p = (vid.currentTime / vid.duration) * 100;
  document.getElementById('progFill').style.width = p + '%';
  document.getElementById('progKnob').style.left  = p + '%';
  document.getElementById('tCur').textContent = fmt(vid.currentTime);
  document.getElementById('tDur').textContent = fmt(vid.duration);
  if (!vid._lastSync || vid.currentTime - vid._lastSync > 1) {
    vid._lastSync = vid.currentTime;
    emit({type:'timeupdate', time:vid.currentTime, dur:vid.duration});
  }
});

vid.addEventListener('play',  () => { if (!isSyncing && role==='host') emit({type:'play',  time:vid.currentTime}); setPlayUI(true);  });
vid.addEventListener('pause', () => { if (!isSyncing && role==='host') emit({type:'pause', time:vid.currentTime}); setPlayUI(false); });
vid.addEventListener('ended', () => { if (hostAud) hostAud.pause(); setPlayUI(false); });
vid.addEventListener('click', () => { if (role==='host') togglePlay(); else toast('Only the host controls playback 🎬'); });
document.getElementById('playerWrap').addEventListener('dblclick', e => { if (e.target===vid) toggleFS(); });


/* ── 12. DRAG AND DROP — HOST ONLY ───────────────── */
const dzEl = document.getElementById('drop-zone');
const pw   = document.getElementById('playerWrap');
pw.addEventListener('dragover',  e => { if (role!=='host') return; e.preventDefault(); dzEl.classList.add('drag-over'); });
pw.addEventListener('dragleave', () => dzEl.classList.remove('drag-over'));
pw.addEventListener('drop', e => {
  if (role !== 'host') return;
  e.preventDefault(); dzEl.classList.remove('drag-over');
  const f = e.dataTransfer.files[0]; if (f) loadFile(f, mediaLoaded);
});


/* ── 13. KEYBOARD SHORTCUTS ───────────────────────── */
document.addEventListener('keydown', e => {
  if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
  if      (e.code==='Space')      { e.preventDefault(); togglePlay(); }
  else if (e.code==='ArrowLeft')  skip(-10);
  else if (e.code==='ArrowRight') skip(10);
  else if (e.code==='KeyM')       toggleMute();
  else if (e.code==='KeyF')       toggleFS();
  else if (e.code==='KeyC')       toggleFChat();
});


/* ── 14. CONTROLS OVERLAY ─────────────────────────── */
function showCtrl() { if (!mediaLoaded) return; document.getElementById('ctrl').classList.add('show'); }
function schedHide() {
  clearTimeout(ctrlTimer);
  ctrlTimer = setTimeout(() => { if (!vid.paused) document.getElementById('ctrl').classList.remove('show'); }, 2600);
}
function onMove() { showCtrl(); schedHide(); }


/* ── 15. FULLSCREEN ───────────────────────────────── */
function toggleFS() {
  if (!document.fullscreenElement) document.getElementById('playerWrap').requestFullscreen().catch(()=>{});
  else document.exitFullscreen();
}
document.addEventListener('fullscreenchange', () => {
  const fs = !!document.fullscreenElement;
  document.getElementById('icFS').style.display = fs ? 'none' : '';
  document.getElementById('icEX').style.display = fs ? '' : 'none';
  document.getElementById('chatSide').style.display   = fs ? 'none' : 'flex';
  document.getElementById('rightPanel').style.display = fs ? 'none' : 'flex';
  if (fs) { document.getElementById('fchat').classList.add('open');    document.getElementById('btnFChat').classList.add('lit'); }
  else    { document.getElementById('fchat').classList.remove('open'); document.getElementById('btnFChat').classList.remove('lit'); }
});


/* ── 16. FLOATING CHAT ────────────────────────────── */
function toggleFChat() {
  const fc = document.getElementById('fchat');
  fc.classList.toggle('open');
  document.getElementById('btnFChat').classList.toggle('lit', fc.classList.contains('open'));
}
function minFChat()  { fcMin=!fcMin; document.getElementById('fchat').classList.toggle('minimized',fcMin); }
function closeFChat(){ document.getElementById('fchat').classList.remove('open'); document.getElementById('btnFChat').classList.remove('lit'); }
(() => {
  const h=document.getElementById('fcHead'), b=document.getElementById('fchat');
  let ox,oy,bx,by,drag=false;
  h.addEventListener('mousedown', e => { drag=true; ox=e.clientX; oy=e.clientY; const r=b.getBoundingClientRect(); bx=r.left; by=r.top; e.preventDefault(); });
  document.addEventListener('mousemove', e => { if(!drag) return; b.style.right='auto'; b.style.bottom='auto'; b.style.left=Math.max(0,bx+(e.clientX-ox))+'px'; b.style.top=Math.max(0,by+(e.clientY-oy))+'px'; });
  document.addEventListener('mouseup', () => drag=false);
})();


/* ── 17. CHAT ─────────────────────────────────────── */
function sendChat(ff) {
  const inp=document.getElementById(ff?'fcIn':'chatInp');
  const t=inp.value.trim(); if(!t) return;
  inp.value=''; addMsg(t,true); emit({type:'chat',text:t});
}
function addMsg(text, mine) {
  const box=document.getElementById('msgs');
  const w=document.createElement('div'); w.className='mb '+(mine?'me':'them');
  const wh=document.createElement('div'); wh.className='mb-who'; wh.textContent=mine?'you':'them';
  const tx=document.createElement('div'); tx.className='mb-txt'; tx.textContent=text;
  w.append(wh,tx); box.appendChild(w); box.scrollTop=box.scrollHeight;
  const fb=document.getElementById('fmsgs');
  const fd=document.createElement('div'); fd.className='fm '+(mine?'fme':'fpe'); fd.textContent=text;
  fb.appendChild(fd); fb.scrollTop=fb.scrollHeight;
}
function sysMsg(text) {
  const box=document.getElementById('msgs');
  const w=document.createElement('div'); w.className='mb sys';
  const t=document.createElement('div'); t.className='mb-txt'; t.textContent=text;
  w.appendChild(t); box.appendChild(w); box.scrollTop=box.scrollHeight;
  const fb=document.getElementById('fmsgs');
  const fd=document.createElement('div'); fd.className='fm fsy'; fd.textContent=text;
  fb.appendChild(fd); fb.scrollTop=fb.scrollHeight;
}


/* ── 18. UI HELPERS ───────────────────────────────── */
function enterRoom() {
  document.getElementById('page-land').style.display = 'none';
  document.getElementById('page-room').style.display = 'flex';
  document.getElementById('codeDisp').textContent = roomCode;
  document.getElementById('rpCode').textContent   = roomCode;
  document.getElementById('roleChip').textContent = role==='host' ? '🎬 Host' : '👀 Guest';
  document.getElementById('rpRole').textContent   = role==='host' ? 'Host — picks file & controls' : 'Guest — stream viewer';

  if (role === 'guest') {
    document.getElementById('drop-zone').classList.add('hidden');
    showGuestWaiting('Waiting for host…', 'The host will stream the video — no file needed on your end.');
    document.getElementById('btnChgCtrl').style.display = 'none';
    document.getElementById('rpChgBtn').style.display   = 'none';
    document.getElementById('progArea').style.pointerEvents = 'none';
    document.getElementById('progArea').style.cursor = 'default';
  }
}

function showGuestWaiting(title, sub) {
  document.getElementById('gwTitle').textContent = title;
  document.getElementById('gwSub').innerHTML     = sub;
  document.getElementById('guest-wait').style.display = 'flex';
}

function setPlayUI(playing) {
  document.getElementById('icPlay').style.display  = playing ? 'none' : '';
  document.getElementById('icPause').style.display = playing ? '' : 'none';
  if (playing) schedHide(); else showCtrl();
}

function flash(msg) {
  const el=document.getElementById('syncBadge');
  el.textContent='⚡ '+msg; el.classList.add('show');
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove('show'),2000);
}

function setDot(s) {
  const d=document.getElementById('peerDot'); d.className='pdot';
  if(s==='on') d.classList.add('on'); if(s==='wait') d.classList.add('wait');
}
function setPeerLbl(t)     { document.getElementById('peerLbl').textContent=t; }
function setRpPeer(t, cls) { const el=document.getElementById('rpPeer'); el.textContent=t; el.className='rp-val '+cls; }
function openM(id)  { document.getElementById(id).classList.add('open'); }
function closeM(id) { document.getElementById(id).classList.remove('open'); }

function doLeave() {
  emit({type:'chat', text:'— '+role+' left the room'});
  setTimeout(() => {
    try { if(hostAud){hostAud.pause();hostAud.src='';} }         catch(e){}
    try { if(hostStream) hostStream.getTracks().forEach(t=>t.stop()); } catch(e){}
    try { if(hostObjURL) URL.revokeObjectURL(hostObjURL); }       catch(e){}
    try { mediaCall&&mediaCall.close(); }                          catch(e){}
    try { conn&&conn.close(); }                                    catch(e){}
    try { peer&&peer.destroy(); }                                  catch(e){}
    location.reload();
  }, 180);
}

function copyCode() { navigator.clipboard.writeText(roomCode).catch(()=>{}); toast('📋 Copied: '+roomCode); }
function emit(d)    { if(conn&&conn.open) try{conn.send(d);}catch(e){} }
function fmt(s)     { if(isNaN(s)||s==null) return '0:00'; return Math.floor(s/60)+':'+Math.floor(s%60).toString().padStart(2,'0'); }

let _tt;
function toast(msg) {
  document.getElementById('toastTxt').textContent=msg;
  const el=document.getElementById('toast'); el.classList.add('show');
  clearTimeout(_tt); _tt=setTimeout(()=>el.classList.remove('show'),3400);
}

window.addEventListener('beforeunload', () => {
  try { if(hostAud){hostAud.pause();hostAud.src='';} }         catch(e){}
  try { if(hostStream) hostStream.getTracks().forEach(t=>t.stop()); } catch(e){}
  try { mediaCall&&mediaCall.close(); } catch(e){}
  try { conn&&conn.close(); }           catch(e){}
  try { peer&&peer.destroy(); }         catch(e){}
});