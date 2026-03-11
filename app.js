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
}


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


/* ── 6. MEDIA STREAM ──────────────────────────────── */

/**
 * HOST: Build stream and call guest.
 *
 * HOW HOST AUDIO WORKS:
 *   - vid (the <video> element) is MUTED so captureStream() can
 *     capture clean audio tracks without Chrome stealing them
 *     from the speakers.
 *   - hostAud (a hidden <audio> element) plays the SAME file
 *     so the host can hear everything normally.
 *   - The guest receives vid's captureStream() which has both
 *     video and audio tracks intact.
 */
function buildHostStream() {
  try {
    hostStream = vid.captureStream
      ? vid.captureStream()
      : vid.mozCaptureStream
      ? vid.mozCaptureStream()
      : null;
  } catch(e) { hostStream = null; }

  if (!hostStream) {
    toast('captureStream not supported — use Chrome or Edge'); return false;
  }

  // Mute the video element — audio will come from hostAud instead
  vid.muted = true;

  // Play the same file in the hidden audio element so host hears it
  if (hostObjURL) {
    hostAud.src = hostObjURL;
    hostAud.currentTime = vid.currentTime;
    if (!vid.paused) hostAud.play().catch(() => {});
  }

  return true;
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
  // Detach old stream cleanly
  vid.srcObject = null;
  vid.load();

  setTimeout(() => {
    vid.srcObject = stream;
    vid.muted     = true;  // MUST start muted — browser blocks autoplay with audio
    vid.playsInline = true;

    // Show video element immediately so it can render frames
    vid.style.display = 'block';

    let started = false;
    const startVideo = () => {
      if (started) return;
      vid.play().then(() => {
        started = true;
        mediaLoaded = true;
        document.getElementById('guest-wait').style.display = 'none';
        document.getElementById('change-banner').classList.remove('show');
        setPlayUI(true);
        showCtrl();
        sysMsg('✅ Stream connected!');
        showUnmuteBanner();
      }).catch(() => {
        // Autoplay blocked — show tap-to-watch overlay
        vid.style.display = 'none';
        showGuestWaiting('Tap to watch 👇', 'Click anywhere to start the stream.');
        document.getElementById('guest-wait').addEventListener('click', () => {
          vid.style.display = 'block';
          startVideo();
        }, { once: true });
      });
    };

    // Use addEventListener (not onloadedmetadata assignment) so we don't overwrite handlers
    vid.addEventListener('loadedmetadata', startVideo, { once: true });
    // Fallback: some browsers fire canplay before loadedmetadata on MediaStream
    vid.addEventListener('canplay', startVideo, { once: true });

    vid.onerror = () => toast('Stream error — try rejoining');
  }, 80);
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
    showGuestWaiting('Host changed media 🔄', 'New stream incoming…');
    sysMsg('🔄 Host changed media — new stream incoming…'); return;
  }
}


/* ── 8. FILE LOADING — HOST ONLY ──────────────────── */
function loadFile(file, isChange) {
  if (!file || role !== 'host') return;
  currentFilename = file.name;

  // Stop old streams
  vid.pause();
  if (hostAud) { hostAud.pause(); hostAud.src = ''; }
  if (hostStream) { hostStream.getTracks().forEach(t => t.stop()); hostStream = null; }
  if (hostObjURL) { URL.revokeObjectURL(hostObjURL); hostObjURL = null; }

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

    // Build stream (this mutes vid and starts hostAud)
    const ok = buildHostStream();
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
  };

  vid.addEventListener('canplay', onCanPlay);
  vid.onerror = () => toast('Could not load this file — try a different format');
}

function requestChangeMedia() { if (role === 'host') openM('mChange'); }
function doChangeMedia()      { closeM('mChange'); document.getElementById('fileChg').click(); }
function hideBanner()         { document.getElementById('change-banner').classList.remove('show'); }


/* ── 9. PLAYER CONTROLS ───────────────────────────── */
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
  if (hostAud) hostAud.currentTime = t; // keep audio in sync
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
  // Host: only toggle hostAud (local speaker) — vid stays muted permanently for captureStream
  // This NEVER touches the stream sent to guest
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
    hostAud.volume = val;           // host: controls local audio element only
    if (val === 0) updateMuteUI(true);
    else if (hostAud.muted) { hostAud.muted = false; updateMuteUI(false); }
  } else {
    vid.volume = val;               // guest: controls their own stream playback only
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