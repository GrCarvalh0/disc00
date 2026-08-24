(function () {
  var ROOM = null;
  var MY_ID = null;
  var MY_NAME = null;
  var localStream = null;
  var screenStream = null;
  var muted = false;
  var sharing = false;

  var peers = {}; // id -> {name, ts}
  var pcs = {}; // id -> RTCPeerConnection
  var negState = {}; // id -> {makingOffer, ignoreOffer, polite}
  var remoteAudioEls = {}; // id -> audio element
  var remoteVideoEls = {}; // id -> video element (screen)
  var sendChains = {}; // key -> promise chain for serialized sends

  var presenceTimer = null, pollTimer = null;
  var view = 'lobby';
  var joinError = '';

  var ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function randId() { return Math.random().toString(36).slice(2, 10); }
  function randRoomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var s = '';
    for (var i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  function initials(name) {
    return (name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  // ---------- signaling via shared storage ----------
  function sigKey(fromId, toId) { return 'sig:' + ROOM + ':' + fromId + ':' + toId; }
  function presenceKey(id) { return 'pres:' + ROOM + ':' + id; }
  function presencePrefix() { return 'pres:' + ROOM + ':'; }
  function sigPrefixToMe() { return 'sig:' + ROOM + ':'; }

  function sendSignal(toId, message) {
    var key = sigKey(MY_ID, toId);
    var chain = sendChains[key] || Promise.resolve();
    sendChains[key] = chain.then(async function () {
      var existing = [];
      try {
        var r = await window.storage.get(key, true);
        existing = r && r.value ? JSON.parse(r.value) : [];
      } catch (e) { existing = []; }
      existing.push(message);
      try { await window.storage.set(key, JSON.stringify(existing), true); } catch (e) {}
    }).catch(function () {});
    return sendChains[key];
  }

  async function pollSignals() {
    if (!ROOM) return;
    try {
      var listing = await window.storage.list(sigPrefixToMe(), true);
      var keys = (listing && listing.keys) || [];
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.indexOf(':' + MY_ID) !== k.length - (':' + MY_ID).length) continue; // must end with :MY_ID
        var fromId = k.slice(sigPrefixToMe().length, k.length - (':' + MY_ID).length);
        if (!fromId || fromId === MY_ID) continue;
        var res;
        try { res = await window.storage.get(k, true); } catch (e) { continue; }
        if (!res || !res.value) continue;
        var msgs = [];
        try { msgs = JSON.parse(res.value); } catch (e) { msgs = []; }
        if (!msgs.length) continue;
        try { await window.storage.set(k, '[]', true); } catch (e) {}
        for (var j = 0; j < msgs.length; j++) {
          await handleSignalMessage(fromId, msgs[j]);
        }
      }
    } catch (e) {}
  }

  // ---------- presence ----------
  async function announcePresence() {
    try {
      await window.storage.set(presenceKey(MY_ID), JSON.stringify({ name: MY_NAME, ts: Date.now() }), true);
    } catch (e) {}
  }

  async function pollPresence() {
    if (!ROOM) return;
    try {
      var listing = await window.storage.list(presencePrefix(), true);
      var keys = (listing && listing.keys) || [];
      var seen = {};
      var now = Date.now();
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var id = k.slice(presencePrefix().length);
        if (id === MY_ID) continue;
        var res;
        try { res = await window.storage.get(k, true); } catch (e) { continue; }
        if (!res || !res.value) continue;
        var data;
        try { data = JSON.parse(res.value); } catch (e) { continue; }
        if (now - data.ts > 9000) continue; // stale
        seen[id] = true;
        if (!peers[id]) {
          peers[id] = { name: data.name, ts: data.ts };
          onPeerJoined(id);
        } else {
          peers[id].ts = data.ts;
          peers[id].name = data.name;
        }
      }
      Object.keys(peers).forEach(function (id) {
        if (!seen[id]) { onPeerLeft(id); }
      });
      renderRoom();
    } catch (e) {}
  }

  function onPeerJoined(id) {
    getOrCreatePC(id);
    renderRoom();
  }

  function onPeerLeft(id) {
    delete peers[id];
    var pc = pcs[id];
    if (pc) { try { pc.close(); } catch (e) {} delete pcs[id]; }
    delete negState[id];
    var a = remoteAudioEls[id]; if (a) { a.remove(); delete remoteAudioEls[id]; }
    var v = remoteVideoEls[id]; if (v) { delete remoteVideoEls[id]; }
    renderRoom();
  }

  // ---------- WebRTC (perfect negotiation) ----------
  function getOrCreatePC(id) {
    if (pcs[id]) return pcs[id];
    var pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    negState[id] = { makingOffer: false, ignoreOffer: false, polite: MY_ID < id };
    pcs[id] = pc;

    if (localStream) {
      localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
    }
    if (screenStream) {
      screenStream.getTracks().forEach(function (t) { pc.addTrack(t, screenStream); });
    }

    pc.onnegotiationneeded = async function () {
      var st = negState[id];
      try {
        st.makingOffer = true;
        await pc.setLocalDescription();
        await sendSignal(id, { kind: 'description', description: pc.localDescription });
      } catch (e) {} finally { st.makingOffer = false; }
    };

    pc.onicecandidate = function (ev) {
      if (ev.candidate) sendSignal(id, { kind: 'candidate', candidate: ev.candidate });
    };

    pc.ontrack = function (ev) {
      var track = ev.track;
      if (track.kind === 'audio') {
        var stream = new MediaStream([track]);
        var audioEl = remoteAudioEls[id] || document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.srcObject = stream;
        if (!remoteAudioEls[id]) {
          document.getElementById('audio-sink').appendChild(audioEl);
          remoteAudioEls[id] = audioEl;
        }
      } else if (track.kind === 'video') {
        var vstream = new MediaStream([track]);
        remoteVideoEls[id] = { stream: vstream, track: track };
        track.onended = function () { delete remoteVideoEls[id]; renderRoom(); };
        renderRoom();
      }
    };

    pc.onconnectionstatechange = function () { renderRoom(); };

    return pc;
  }

  async function handleSignalMessage(fromId, msg) {
    if (!peers[fromId]) { peers[fromId] = { name: '...', ts: Date.now() }; }
    var pc = getOrCreatePC(fromId);
    var st = negState[fromId];
    if (msg.kind === 'description') {
      var desc = msg.description;
      var offerCollision = desc.type === 'offer' && (st.makingOffer || pc.signalingState !== 'stable');
      st.ignoreOffer = !st.polite && offerCollision;
      if (st.ignoreOffer) return;
      try {
        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          await sendSignal(fromId, { kind: 'description', description: pc.localDescription });
        }
      } catch (e) {}
    } else if (msg.kind === 'candidate') {
      try { await pc.addIceCandidate(msg.candidate); } catch (e) { if (!st.ignoreOffer) {} }
    }
  }

  // ---------- media controls ----------
  async function toggleMute() {
    if (!localStream) return;
    muted = !muted;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !muted; });
    renderRoom();
  }

  async function startShare() {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (e) {
      return;
    }
    sharing = true;
    Object.keys(pcs).forEach(function (id) {
      var pc = pcs[id];
      screenStream.getTracks().forEach(function (t) { pc.addTrack(t, screenStream); });
    });
    var vtrack = screenStream.getVideoTracks()[0];
    if (vtrack) vtrack.onended = function () { stopShare(); };
    renderRoom();
  }

  function stopShare() {
    if (screenStream) {
      screenStream.getTracks().forEach(function (t) {
        Object.keys(pcs).forEach(function (id) {
          var pc = pcs[id];
          var sender = pc.getSenders().find(function (s) { return s.track === t; });
          if (sender) { try { pc.removeTrack(sender); } catch (e) {} }
        });
        t.stop();
      });
    }
    screenStream = null;
    sharing = false;
    renderRoom();
  }

  async function leaveRoom() {
    try { await window.storage.delete(presenceKey(MY_ID), true); } catch (e) {}
    Object.keys(pcs).forEach(function (id) { try { pcs[id].close(); } catch (e) {} });
    pcs = {}; peers = {}; negState = {};
    if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
    if (screenStream) screenStream.getTracks().forEach(function (t) { t.stop(); });
    localStream = null; screenStream = null; sharing = false; muted = false;
    if (presenceTimer) clearInterval(presenceTimer);
    if (pollTimer) clearInterval(pollTimer);
    Object.keys(remoteAudioEls).forEach(function (id) { remoteAudioEls[id].remove(); });
    remoteAudioEls = {}; remoteVideoEls = {};
    ROOM = null; MY_ID = null;
    view = 'lobby';
    render();
  }

  // ---------- join flow ----------
  async function joinRoom(name, roomCode) {
    joinError = '';
    if (!name.trim()) { joinError = 'Digite seu nome.'; render(); return; }
    if (!roomCode.trim()) { joinError = 'Digite ou gere um código de sala.'; render(); return; }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      joinError = 'Não foi possível acessar o microfone. Verifique as permissões do navegador.';
      render();
      return;
    }
    MY_NAME = name.trim();
    ROOM = roomCode.trim().toUpperCase();
    MY_ID = randId();
    view = 'room';
    render();
    await announcePresence();
    presenceTimer = setInterval(announcePresence, 3000);
    pollTimer = setInterval(function () { pollPresence(); pollSignals(); }, 1000);
    pollPresence();
  }

  window.addEventListener('beforeunload', function () {
    if (ROOM && MY_ID) { try { navigator.sendBeacon && window.storage.delete(presenceKey(MY_ID), true); } catch (e) {} }
  });

  // ---------- render ----------
  function renderLobby(root) {
    var nameInput = el('input', { type: 'text', id: 'name-input', placeholder: 'Seu nome' });
    var codeInput = el('input', { type: 'text', id: 'code-input', placeholder: 'Código da sala' });
    var genBtn = el('button', { class: 'btn btn-ghost', text: 'Gerar', onclick: function () { codeInput.value = randRoomCode(); } });
    var errEl = joinError ? el('p', { class: 'error-text', text: joinError }) : null;

    var joinBtn = el('button', {
      class: 'btn btn-block', text: 'Entrar na chamada', onclick: function () {
        joinRoom(nameInput.value, codeInput.value);
      }
    });

    var card = el('div', { class: 'lobby-card' }, [
      el('h2', { text: 'Chamada com a galera' }),
      el('p', { class: 'lobby-sub', text: 'Combine um código com seus amigos e entrem na mesma sala para falar por voz e compartilhar a tela.' }),
      el('label', { text: 'Nome' }), nameInput,
      el('label', { text: 'Código da sala' }),
      el('div', { class: 'room-row' }, [codeInput, genBtn]),
      errEl,
      joinBtn
    ]);
    root.appendChild(card);
  }

  function renderRoomView(root) {
    var header = el('div', { class: 'room-header' }, [
      el('div', { class: 'room-code-pill' }, [
        el('span', { text: 'Sala ' + ROOM }),
        el('button', {
          text: 'copiar', onclick: function () {
            navigator.clipboard && navigator.clipboard.writeText(ROOM);
          }
        })
      ])
    ]);
    root.appendChild(header);

    var sharedVideos = Object.keys(remoteVideoEls);
    var stage = el('div', { class: 'stage' });
    if (sharing && screenStream) {
      var localVideo = el('video', { autoplay: 'true', muted: 'true', playsinline: 'true' });
      localVideo.srcObject = screenStream;
      stage.appendChild(el('div', { class: 'screen-tile' }, [localVideo, el('span', { class: 'screen-tile-label', text: 'Você (compartilhando)' })]));
    }
    sharedVideos.forEach(function (id) {
      var entry = remoteVideoEls[id];
      var v = el('video', { autoplay: 'true', playsinline: 'true' });
      v.srcObject = entry.stream;
      var peerName = peers[id] ? peers[id].name : 'amigo';
      stage.appendChild(el('div', { class: 'screen-tile' }, [v, el('span', { class: 'screen-tile-label', text: peerName })]));
    });
    if (!sharing && sharedVideos.length === 0) {
      stage.appendChild(el('div', { class: 'stage-empty', text: 'Ninguém está compartilhando a tela agora. Clique em "Compartilhar tela" quando quiser mostrar algo.' }));
    }
    root.appendChild(stage);

    var participants = el('div', { class: 'participants' });
    participants.appendChild(el('div', { class: 'chip you' + (muted ? ' muted' : '') }, [
      el('div', { class: 'avatar', text: initials(MY_NAME) }),
      el('div', {}, [
        el('p', { class: 'chip-name', text: MY_NAME + ' (você)' }),
        el('p', { class: 'chip-badge', text: muted ? 'mudo' : (sharing ? 'compartilhando tela' : 'no ar') })
      ])
    ]));
    Object.keys(peers).forEach(function (id) {
      var p = peers[id];
      var isSharing = !!remoteVideoEls[id];
      participants.appendChild(el('div', { class: 'chip' + (isSharing ? ' sharing' : '') }, [
        el('div', { class: 'avatar', text: initials(p.name) }),
        el('div', {}, [
          el('p', { class: 'chip-name', text: p.name }),
          el('p', { class: 'chip-badge', text: isSharing ? 'compartilhando tela' : 'conectado' })
        ])
      ]));
    });
    root.appendChild(participants);

    var controls = el('div', { class: 'controls' }, [
      el('button', { class: 'ctrl-btn' + (muted ? '' : ' on'), text: muted ? '🔇 Ativar mic' : '🎙️ Mic ligado', onclick: toggleMute }),
      el('button', {
        class: 'ctrl-btn' + (sharing ? ' on' : ''), text: sharing ? '🛑 Parar compartilhamento' : '🖥️ Compartilhar tela',
        onclick: function () { sharing ? stopShare() : startShare(); }
      }),
      el('button', { class: 'ctrl-btn leave', text: '📞 Sair', onclick: leaveRoom })
    ]);
    root.appendChild(controls);

    root.appendChild(el('p', { class: 'status-line', text: Object.keys(peers).length + ' amigo(s) na sala · sinalização por polling, pode levar alguns segundos para conectar.' }));
  }

  function render() {
    var app = document.getElementById('app');
    if (!document.getElementById('root-wrap')) {
      app.appendChild(el('div', { id: 'root-wrap' }));
    }
    var root = document.getElementById('root-wrap');
    root.innerHTML = '';
    var wrap = el('div', { class: 'wrap' });
    wrap.appendChild(el('div', { class: 'brand' }, [el('span', { class: 'brand-dot' }), el('h1', { text: 'Sala de chamada' })]));
    if (view === 'lobby') renderLobby(wrap);
    else renderRoomView(wrap);
    root.appendChild(wrap);
  }

  render();
})();