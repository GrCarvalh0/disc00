(function () {
  var myPeer = null;
  var myId = null;
  var myName = '';
  var roomCode = '';
  var hostId = '';
  var role = null; // 'host' | 'member'

  var localStream = null;
  var screenStream = null;
  var muted = false;
  var sharing = false;

  var roster = {}; // id -> name (everyone in the room, including me)
  var dataConns = {}; // host: id -> DataConnection to each member | member: {host: conn}
  var audioCalls = {}; // id -> MediaConnection (voice)
  var screenCallsOut = {}; // id -> MediaConnection (my screen -> them)
  var remoteScreens = {}; // id -> MediaStream
  var remoteAudioEls = {}; // id -> <audio>
  var speaking = {}; // id -> bool

  var view = 'lobby';
  var joinError = '';
  var joinStatus = '';

  var audioCtx = null;
  var analysers = {}; // id -> {analyser, data, raf}

  // ---------- dom helpers ----------
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

  function initials(name) {
    return (name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  function randRoomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var s = '';
    for (var i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function sanitizeRoomCode(code) {
    return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  }

  // ---------- speaking detection ----------
  function attachSpeakingDetector(id, stream) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var source = audioCtx.createMediaStreamSource(stream);
      var analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      var data = new Uint8Array(analyser.frequencyBinCount);
      var state = { analyser: analyser, data: data, stop: false };
      analysers[id] = state;

      function loop() {
        if (state.stop) return;
        analyser.getByteFrequencyData(data);
        var sum = 0;
        for (var i = 0; i < data.length; i++) sum += data[i];
        var avg = sum / data.length;
        var isSpeaking = avg > 14;
        if (speaking[id] !== isSpeaking) {
          speaking[id] = isSpeaking;
          var tileEl = document.getElementById('tile-' + id);
          if (tileEl) tileEl.classList.toggle('speaking', isSpeaking);
        }
        requestAnimationFrame(loop);
      }
      loop();
    } catch (e) {}
  }

  function detachSpeakingDetector(id) {
    if (analysers[id]) { analysers[id].stop = true; delete analysers[id]; }
    delete speaking[id];
  }

  // ---------- roster sync ----------
  function broadcastRoster() {
    Object.keys(dataConns).forEach(function (id) {
      try { dataConns[id].send({ type: 'roster', roster: roster }); } catch (e) {}
    });
  }

  function applyRoster(newRoster) {
    var oldIds = Object.keys(roster);
    var newIds = Object.keys(newRoster);
    roster = newRoster;

    newIds.forEach(function (id) {
      if (id === myId) return;
      if (oldIds.indexOf(id) === -1) {
        ensureMediaConnection(id);
      }
    });
    oldIds.forEach(function (id) {
      if (id === myId) return;
      if (newIds.indexOf(id) === -1) {
        cleanupPeer(id);
      }
    });
    renderRoomView();
  }

  function ensureMediaConnection(id) {
    if (id === myId || audioCalls[id]) return;
    if (myId < id) {
      var call = myPeer.call(id, localStream, { metadata: { kind: 'audio', name: myName } });
      if (call) registerAudioCall(id, call);
    }
    // if myId > id, we wait for them to call us (they run the same check)
  }

  function registerAudioCall(id, call) {
    audioCalls[id] = call;
    call.on('stream', function (remoteStream) {
      var audioEl = remoteAudioEls[id] || document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.srcObject = remoteStream;
      if (!remoteAudioEls[id]) {
        document.getElementById('audio-sink').appendChild(audioEl);
        remoteAudioEls[id] = audioEl;
      }
      attachSpeakingDetector(id, remoteStream);
      renderRoomView();
    });
    call.on('close', function () { cleanupPeer(id); });
    call.on('error', function () { cleanupPeer(id); });
  }

  function cleanupPeer(id) {
    if (audioCalls[id]) { try { audioCalls[id].close(); } catch (e) {} delete audioCalls[id]; }
    if (screenCallsOut[id]) { try { screenCallsOut[id].close(); } catch (e) {} delete screenCallsOut[id]; }
    if (remoteAudioEls[id]) { remoteAudioEls[id].remove(); delete remoteAudioEls[id]; }
    delete remoteScreens[id];
    delete dataConns[id];
    detachSpeakingDetector(id);
    delete roster[id];
    renderRoomView();
  }

  // ---------- join / host flow ----------
  function setupPeerCommonHandlers() {
    myPeer.on('call', function (call) {
      var kind = call.metadata && call.metadata.kind;
      if (kind === 'screen') {
        call.answer();
        call.on('stream', function (remoteStream) {
          remoteScreens[call.peer] = remoteStream;
          renderRoomView();
        });
        call.on('close', function () { delete remoteScreens[call.peer]; renderRoomView(); });
      } else {
        call.answer(localStream);
        registerAudioCall(call.peer, call);
        if (call.metadata && call.metadata.name) roster[call.peer] = call.metadata.name;
        renderRoomView();
      }
    });

    myPeer.on('error', function (err) {
      if (String(err.type) === 'peer-unavailable') return; // benign, target left
      console.error('PeerJS error', err);
    });

    myPeer.on('disconnected', function () {
      joinStatus = 'Conexão perdida, tentando reconectar...';
      renderRoomView();
      try { myPeer.reconnect(); } catch (e) {}
    });
  }

  function becomeHost() {
    role = 'host';
    roster = {};
    roster[myId] = myName;

    myPeer.on('connection', function (conn) {
      conn.on('open', function () {
        dataConns[conn.peer] = conn;
      });
      conn.on('data', function (msg) {
        if (msg.type === 'hello') {
          roster[conn.peer] = msg.name;
          dataConns[conn.peer] = conn;
          conn.send({ type: 'roster', roster: roster });
          broadcastRoster();
          applyRoster(roster);
        }
      });
      conn.on('close', function () {
        delete roster[conn.peer];
        delete dataConns[conn.peer];
        cleanupPeer(conn.peer);
        broadcastRoster();
      });
    });

    view = 'room';
    renderRoomView();
  }

  function becomeMember() {
    role = 'member';
    var conn = myPeer.connect(hostId, { reliable: true });
    dataConns[hostId] = conn;

    conn.on('open', function () {
      conn.send({ type: 'hello', name: myName });
      view = 'room';
      joinStatus = '';
      renderRoomView();
    });

    conn.on('data', function (msg) {
      if (msg.type === 'roster') applyRoster(msg.roster);
    });

    conn.on('close', function () {
      joinStatus = 'Perdemos a conexão com a sala. Tentando reabrir...';
      renderRoomView();
      Object.keys(roster).forEach(function (id) { if (id !== myId) cleanupPeer(id); });
      setTimeout(attemptTakeoverOrRejoin, 800);
    });

    conn.on('error', function () {
      setTimeout(attemptTakeoverOrRejoin, 800);
    });
  }

  function attemptTakeoverOrRejoin() {
    if (view !== 'room') return;
    try { myPeer.destroy(); } catch (e) {}
    myPeer = new Peer(hostId);
    myPeer.on('open', function (id) {
      myId = id;
      setupPeerCommonHandlers();
      becomeHost();
    });
    myPeer.on('error', function () {
      myPeer = new Peer();
      myPeer.on('open', function (id) {
        myId = id;
        setupPeerCommonHandlers();
        becomeMember();
      });
    });
  }

  function loadPeerJS() {
    return new Promise(function (resolve) {
      if (window.Peer) return resolve();
      var script = document.createElement('script');
      script.src = 'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js';
      script.onload = resolve;
      document.head.appendChild(script);
    });
  }

  async function joinRoom(name, code) {
    joinError = '';
    if (!name.trim()) { joinError = 'Digite seu nome.'; renderLobby(); return; }
    var cleanCode = sanitizeRoomCode(code);
    if (!cleanCode) { joinError = 'Digite ou gere um código de sala.'; renderLobby(); return; }

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      joinError = 'Não foi possível acessar o microfone. Verifique as permissões do navegador.';
      renderLobby();
      return;
    }

    await loadPeerJS();

    myName = name.trim();
    roomCode = cleanCode;
    hostId = 'sala-' + roomCode;
    joinStatus = 'Conectando...';
    view = 'connecting';
    render();

    myPeer = new Peer(hostId);

    myPeer.on('open', function (id) {
      myId = id;
      setupPeerCommonHandlers();
      becomeHost();
    });

    myPeer.on('error', function (err) {
      if (String(err.type) !== 'unavailable-id') return;
      myPeer = new Peer();
      myPeer.on('open', function (id) {
        myId = id;
        setupPeerCommonHandlers();
        becomeMember();
      });
    });
  }

  // ---------- media controls ----------
  function toggleMute() {
    if (!localStream) return;
    muted = !muted;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !muted; });
    renderRoomView();
  }

  async function startShare() {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (e) { return; }
    sharing = true;
    Object.keys(roster).forEach(function (id) {
      if (id === myId) return;
      var call = myPeer.call(id, screenStream, { metadata: { kind: 'screen', name: myName } });
      if (call) screenCallsOut[id] = call;
    });
    var vtrack = screenStream.getVideoTracks()[0];
    if (vtrack) vtrack.onended = stopShare;
    renderRoomView();
  }

  function stopShare() {
    if (screenStream) { screenStream.getTracks().forEach(function (t) { t.stop(); }); }
    screenStream = null;
    Object.keys(screenCallsOut).forEach(function (id) {
      try { screenCallsOut[id].close(); } catch (e) {}
      delete screenCallsOut[id];
    });
    sharing = false;
    renderRoomView();
  }

  function leaveRoom() {
    if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
    if (screenStream) screenStream.getTracks().forEach(function (t) { t.stop(); });
    Object.keys(audioCalls).forEach(function (id) { try { audioCalls[id].close(); } catch (e) {} });
    Object.keys(screenCallsOut).forEach(function (id) { try { screenCallsOut[id].close(); } catch (e) {} });
    Object.keys(dataConns).forEach(function (id) { try { dataConns[id].close(); } catch (e) {} });
    if (myPeer) { try { myPeer.destroy(); } catch (e) {} }

    Object.keys(remoteAudioEls).forEach(function (id) { remoteAudioEls[id].remove(); });
    Object.keys(analysers).forEach(function (id) { analysers[id].stop = true; });

    myPeer = null; myId = null; role = null; roster = {}; dataConns = {};
    audioCalls = {}; screenCallsOut = {}; remoteScreens = {}; remoteAudioEls = {}; analysers = {}; speaking = {};
    localStream = null; screenStream = null; sharing = false; muted = false;
    view = 'lobby';
    render();
  }

  // ---------- render: lobby ----------
  function renderLobby() {
    var app = document.getElementById('app');
    if (!document.getElementById('root-wrap')) app.appendChild(el('div', { id: 'root-wrap' }));
    var root = document.getElementById('root-wrap');
    root.innerHTML = '';

    var nameInput = el('input', { type: 'text', id: 'name-input', placeholder: 'Seu nome' });
    var codeInput = el('input', { type: 'text', id: 'code-input', placeholder: 'Código da sala' });
    var genBtn = el('button', { class: 'btn btn-ghost', text: 'Gerar', onclick: function () { codeInput.value = randRoomCode(); } });
    var errEl = joinError ? el('p', { class: 'error-text', text: joinError }) : null;
    var joinBtn = el('button', { class: 'btn btn-block', text: 'Entrar na chamada', onclick: function () { joinRoom(nameInput.value, codeInput.value); } });

    var card = el('div', { class: 'lobby-card' }, [
      el('h2', { text: 'Sala de voz' }),
      el('p', { class: 'lobby-sub', text: 'Combine um código com a galera e entrem na mesma sala para conversar e compartilhar tela.' }),
      el('label', { text: 'Nome' }), nameInput,
      el('label', { text: 'Código da sala' }),
      el('div', { class: 'room-row' }, [codeInput, genBtn]),
      errEl,
      joinBtn
    ]);

    var main = el('div', { class: 'main lobby-wrap' }, [card]);
    root.appendChild(buildRail(false));
    root.appendChild(main);
  }

  function renderConnecting() {
    var app = document.getElementById('app');
    if (!document.getElementById('root-wrap')) app.appendChild(el('div', { id: 'root-wrap' }));
    var root = document.getElementById('root-wrap');
    root.innerHTML = '';
    var card = el('div', { class: 'lobby-card' }, [
      el('h2', { text: 'Entrando na sala...' }),
      el('p', { class: 'status-text', text: joinStatus || 'Conectando...' })
    ]);
    var main = el('div', { class: 'main lobby-wrap' }, [card]);
    root.appendChild(buildRail(false));
    root.appendChild(main);
  }

  function buildRail(connected) {
    var children = [el('div', { class: 'rail-icon', text: 'GC' })];
    if (connected) {
      children.push(el('div', { class: 'rail-sep' }));
      children.push(el('div', { class: 'rail-pulse' }));
    }
    return el('div', { class: 'rail' }, children);
  }

  // ---------- render: room ----------
  function renderRoomView() {
    if (view !== 'room') return;
    var app = document.getElementById('app');
    if (!document.getElementById('root-wrap')) app.appendChild(el('div', { id: 'root-wrap' }));
    var root = document.getElementById('root-wrap');
    root.innerHTML = '';

    var header = el('div', { class: 'room-header' }, [
      el('h1', { class: 'brand-title', text: 'Sala de voz' }),
      el('div', { class: 'room-code-pill' }, [
        el('span', { text: roomCode }),
        el('button', { text: 'copiar', onclick: function () { navigator.clipboard && navigator.clipboard.writeText(roomCode); } })
      ])
    ]);

    var stage = el('div', { class: 'stage' });
    var memberIds = Object.keys(roster);

    if (memberIds.length === 0) memberIds = [myId];

    memberIds.forEach(function (id) {
      var isMe = id === myId;
      var name = isMe ? myName : (roster[id] || 'amigo');
      var isSharingScreen = isMe ? sharing : !!remoteScreens[id];

      if (isSharingScreen) {
        var v = el('video', { autoplay: 'true', playsinline: 'true' });
        if (isMe) { v.muted = true; v.srcObject = screenStream; }
        else v.srcObject = remoteScreens[id];
        stage.appendChild(el('div', { class: 'tile screen-tile', id: 'tile-' + id }, [
          v, el('span', { class: 'screen-tile-label', text: (isMe ? 'Você' : name) + ' • compartilhando' })
        ]));
      } else {
        var isMuted = isMe ? muted : false;
        var cls = 'tile' + (isMe ? ' you' : '') + (isMuted ? ' muted-tile' : '');
        stage.appendChild(el('div', { class: cls, id: 'tile-' + id }, [
          el('div', { class: 'tile-avatar', text: initials(name) }),
          el('p', { class: 'tile-name', text: isMe ? name + ' (você)' : name }),
          el('p', { class: 'tile-badge' + (isMuted ? ' mic-off' : ''), text: isMuted ? 'mudo' : 'no ar' })
        ]));
      }
    });

    if (memberIds.length <= 1) {
      stage.appendChild(el('div', { class: 'stage-empty', text: 'Esperando a galera entrar... compartilhe o código ' + roomCode + ' com seus amigos.' }));
    }

    var controls = el('div', { class: 'controls' }, [
      el('button', { class: 'ctrl-btn' + (muted ? '' : ' on'), text: muted ? '🔇 Mic' : '🎙️ Mic', onclick: toggleMute }),
      el('button', {
        class: 'ctrl-btn' + (sharing ? ' share-active' : ''), text: sharing ? '🛑 Parar' : '🖥️ Compartilhar',
        onclick: function () { sharing ? stopShare() : startShare(); }
      }),
      el('button', { class: 'ctrl-btn leave', text: '📞 Sair', onclick: leaveRoom })
    ]);

    var count = Math.max(memberIds.length, 1);
    var statusLine = el('p', { class: 'status-line', text: count + (count === 1 ? ' pessoa' : ' pessoas') + ' na sala' + (joinStatus ? ' · ' + joinStatus : '') });

    var main = el('div', { class: 'main' }, [header, stage, controls, statusLine]);
    root.appendChild(buildRail(true));
    root.appendChild(main);
  }

  function render() {
    if (view === 'lobby') renderLobby();
    else if (view === 'connecting') renderConnecting();
    else renderRoomView();
  }

  render();
})();
