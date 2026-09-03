// ===== WebRTC Multi-Peer Mesh Module =====

const CHUNK_SIZE = 64 * 1024;
// ICE servers are fetched from our own server (/api/turn-credentials), which
// injects TURN credentials using a metered.ca API key kept SERVER-SIDE only.
// No long-lived TURN credentials live in this client bundle. Falls back to STUN.
const STUN_ONLY = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
let _iceCache = null, _iceCacheAt = 0;
// Whether a working TURN relay is available (the server probes it). Devices on
// different networks (4G vs Wi-Fi, CGNAT…) can only connect through TURN, so
// the UI uses this to explain failures instead of spinning forever.
const turnStatus = { checked: false, available: null, provider: null };
function getTurnStatus() { return turnStatus; }
function _hasTurnUrl(s) {
  const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
  return urls.some(u => /^turns?:/i.test(String(u)));
}
function _setTurnStatus(available, provider) {
  turnStatus.checked = true;
  turnStatus.available = available;
  turnStatus.provider = provider || null;
  try { document.dispatchEvent(new CustomEvent('turn-status', { detail: { ...turnStatus } })); } catch (e) { /* ignore */ }
}
async function getIceServers() {
  const now = Date.now();
  if (_iceCache && (now - _iceCacheAt) < 9 * 60 * 1000) return _iceCache;
  try {
    const r = await fetch('/api/turn-credentials', { cache: 'no-store' });
    if (r.ok) {
      const data = await r.json();
      if (data && Array.isArray(data.iceServers) && data.iceServers.length) {
        _iceCache = data.iceServers;
        _iceCacheAt = now;
        // `turn` is set by the server after a real allocate probe; older servers
        // omit it, so fall back to "does the list contain a turn: url".
        _setTurnStatus(data.turn !== false && data.iceServers.some(_hasTurnUrl), data.provider);
        return _iceCache;
      }
    }
  } catch (e) { /* network/credential error → STUN fallback */ }
  _setTurnStatus(false, null);
  return STUN_ONLY;
}

// Manages a single P2P connection to one remote peer
class SinglePeer {
  constructor(remotePeerId, ws, localPeerId, isInitiator, onConnected, onDisconnected, onData) {
    this.remotePeerId = remotePeerId;
    this.ws = ws;
    this.localPeerId = localPeerId;
    this.onConnected = onConnected;
    this.onDisconnected = onDisconnected;
    this.onData = onData;
    this.isInitiator = isInitiator;
    this.pc = null;
    this.dataChannel = null;
    this.connected = false;
    this.failed = false;       // ICE gave up (after one restart attempt)
    this._iceFailures = 0;
    this._recvMeta = null;
    this._recvChunks = [];
    this._recvSize = 0;

    this._ready = this._init(isInitiator);
  }

  async _init(isInitiator) {
    this.pc = new RTCPeerConnection({ iceServers: await getIceServers() });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.ws.send(JSON.stringify({
          type: 'signal',
          to: this.remotePeerId,
          data: { type: 'ice-candidate', candidate: event.candidate },
        }));
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'connected') {
        this.connected = true;
        this.failed = false;
        this.onConnected(this.remotePeerId);
      } else if (['disconnected', 'failed', 'closed'].includes(state)) {
        this.connected = false;
        this.onDisconnected(this.remotePeerId);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') this._onIceFailed();
    };

    if (isInitiator) {
      this.dataChannel = this.pc.createDataChannel('transfer', { ordered: true });
      this._setupDataChannel(this.dataChannel);
      this._createOffer();
    } else {
      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this._setupDataChannel(this.dataChannel);
      };
    }
  }

  _setupDataChannel(ch) {
    ch.binaryType = 'arraybuffer';
    ch.onopen = () => { this.connected = true; this.onConnected(this.remotePeerId); };
    ch.onclose = () => { this.connected = false; this.onDisconnected(this.remotePeerId); };
    ch.onmessage = (e) => this._handleMessage(e.data);
  }

  _handleMessage(data) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case 'text':
          this.onData({ type: 'text', data: msg.data, from: this.remotePeerId });
          break;
        case 'file-meta':
          this._recvMeta = { name: msg.name, size: msg.size, mimeType: msg.mimeType };
          this._recvChunks = [];
          this._recvSize = 0;
          this.onData({ type: 'file-start', name: msg.name, size: msg.size, mimeType: msg.mimeType, from: this.remotePeerId });
          break;
        case 'file-end':
          const blob = new Blob(this._recvChunks, { type: this._recvMeta.mimeType });
          this.onData({ type: 'file-complete', name: this._recvMeta.name, size: this._recvMeta.size, mimeType: this._recvMeta.mimeType, blob, from: this.remotePeerId });
          this._recvMeta = null;
          this._recvChunks = [];
          this._recvSize = 0;
          break;
      }
    } else {
      this._recvChunks.push(data);
      this._recvSize += data.byteLength;
      if (this._recvMeta) {
        this.onData({ type: 'file-progress', name: this._recvMeta.name, loaded: this._recvSize, total: this._recvMeta.size, from: this.remotePeerId });
      }
    }
  }

  // ICE failed: no candidate pair works (typically: different networks and no
  // usable TURN relay). Try ONE ICE restart (the initiator re-offers with fresh
  // candidates; the responder just waits for that offer). If it fails again,
  // mark the peer as failed so the UI can explain instead of hanging.
  async _onIceFailed() {
    this._iceFailures++;
    if (this._iceFailures === 1) {
      if (this.isInitiator && this.pc.signalingState !== 'closed') {
        try { await this._createOffer({ iceRestart: true }); } catch (e) { /* next 'failed' event marks the peer failed */ }
      }
      return;
    }
    this.failed = true;
    this.connected = false;
    this.onDisconnected(this.remotePeerId, 'failed');
  }

  async _createOffer(options) {
    const offer = await this.pc.createOffer(options);
    await this.pc.setLocalDescription(offer);
    this.ws.send(JSON.stringify({
      type: 'signal',
      to: this.remotePeerId,
      data: { type: 'offer', sdp: offer },
    }));
  }

  async handleSignal(signal) {
    await this._ready; // ensure pc exists (ICE servers fetched) before signaling
    switch (signal.type) {
      case 'offer':
        await this.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.ws.send(JSON.stringify({
          type: 'signal',
          to: this.remotePeerId,
          data: { type: 'answer', sdp: answer },
        }));
        break;
      case 'answer':
        await this.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        break;
      case 'ice-candidate':
        if (signal.candidate) {
          await this.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
        break;
    }
  }

  sendText(text) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') return false;
    this.dataChannel.send(JSON.stringify({ type: 'text', data: text }));
    return true;
  }

  async sendFile(file, onProgress) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') return false;
    this.dataChannel.send(JSON.stringify({
      type: 'file-meta', name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream',
    }));
    let offset = 0;
    const reader = new FileReader();
    const readSlice = () => new Promise((resolve, reject) => {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(slice);
    });
    while (offset < file.size) {
      const chunk = await readSlice();
      while (this.dataChannel.bufferedAmount > 4 * CHUNK_SIZE) {
        await new Promise(r => setTimeout(r, 20));
      }
      this.dataChannel.send(chunk);
      offset += chunk.byteLength;
      if (onProgress) onProgress(offset, file.size);
    }
    this.dataChannel.send(JSON.stringify({ type: 'file-end' }));
    return true;
  }

  close() {
    if (this.dataChannel) this.dataChannel.close();
    if (this.pc) this.pc.close();
    this.connected = false;
  }
}

// Manages all peer connections in a room (mesh topology)
class PeerManager {
  constructor(ws, localPeerId, onStatusChange, onData) {
    this.ws = ws;
    this.localPeerId = localPeerId;
    this.onStatusChange = onStatusChange; // (connectedCount, totalPeers) => {}
    this.onData = onData;
    this.peers = new Map(); // remotePeerId -> SinglePeer
  }

  // Called when we join a room and there are existing peers (we are receiver)
  connectToExisting(peerIds) {
    for (const id of peerIds) {
      this._addPeer(id, false);
    }
  }

  // Called when a new peer joins (we are initiator)
  addNewPeer(peerId) {
    this._addPeer(peerId, true);
  }

  // Called when a peer leaves
  removePeer(peerId) {
    const p = this.peers.get(peerId);
    if (p) { p.close(); this.peers.delete(peerId); }
    this._notifyStatus();
  }

  // Handle incoming signal from a specific peer
  handleSignal(fromPeerId, signal) {
    let p = this.peers.get(fromPeerId);
    if (!p) {
      // Unknown peer sent us a signal (e.g. offer) — create as receiver
      p = this._addPeer(fromPeerId, false);
    }
    p.handleSignal(signal);
  }

  // Broadcast text to all connected peers
  sendTextToAll(text) {
    let sent = false;
    for (const p of this.peers.values()) {
      if (p.sendText(text)) sent = true;
    }
    return sent;
  }

  // Send file to all connected peers
  async sendFileToAll(file, onProgress) {
    const activePeers = Array.from(this.peers.values()).filter(p => p.connected);
    if (activePeers.length === 0) return false;

    // Send to each peer sequentially (to avoid memory overload)
    for (const p of activePeers) {
      await p.sendFile(file, onProgress);
    }
    return true;
  }

  get connectedCount() {
    let count = 0;
    for (const p of this.peers.values()) if (p.connected) count++;
    return count;
  }

  get totalPeers() {
    return this.peers.size;
  }

  // Peers whose ICE negotiation gave up (see SinglePeer._onIceFailed)
  get failedCount() {
    let count = 0;
    for (const p of this.peers.values()) if (p.failed) count++;
    return count;
  }

  closeAll() {
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
  }

  // Update WebSocket reference (for reconnection)
  updateWs(ws) {
    this.ws = ws;
  }

  _addPeer(peerId, isInitiator) {
    if (this.peers.has(peerId)) {
      this.peers.get(peerId).close();
    }
    const p = new SinglePeer(
      peerId, this.ws, this.localPeerId, isInitiator,
      () => this._notifyStatus(),
      () => this._notifyStatus(),
      (data) => this.onData(data),
    );
    this.peers.set(peerId, p);
    this._notifyStatus();
    return p;
  }

  _notifyStatus() {
    this.onStatusChange(this.connectedCount, this.peers.size, this.failedCount);
  }
}
