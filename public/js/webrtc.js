// ===== WebRTC P2P Transfer Module =====

const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

class PeerConnection {
  constructor(ws, onConnected, onDisconnected, onData) {
    this.ws = ws;
    this.onConnected = onConnected;
    this.onDisconnected = onDisconnected;
    this.onData = onData;
    this.pc = null;
    this.dataChannel = null;
    this.isInitiator = false;
    this.connected = false;

    // Receiving state
    this._recvMeta = null;
    this._recvChunks = [];
    this._recvSize = 0;
  }

  init(isInitiator) {
    this.isInitiator = isInitiator;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.ws.send(JSON.stringify({
          type: 'signal',
          data: { type: 'ice-candidate', candidate: event.candidate }
        }));
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'connected') {
        this.connected = true;
        this.onConnected();
      } else if (['disconnected', 'failed', 'closed'].includes(this.pc.connectionState)) {
        this.connected = false;
        this.onDisconnected();
      }
    };

    if (isInitiator) {
      this.dataChannel = this.pc.createDataChannel('transfer', {
        ordered: true,
      });
      this._setupDataChannel(this.dataChannel);
      this._createOffer();
    } else {
      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this._setupDataChannel(this.dataChannel);
      };
    }
  }

  _setupDataChannel(channel) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      this.connected = true;
      this.onConnected();
    };

    channel.onclose = () => {
      this.connected = false;
      this.onDisconnected();
    };

    channel.onmessage = (event) => {
      this._handleMessage(event.data);
    };
  }

  _handleMessage(data) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'text':
          this.onData({ type: 'text', data: msg.data });
          break;

        case 'file-meta':
          // Start receiving a file
          this._recvMeta = {
            name: msg.name,
            size: msg.size,
            mimeType: msg.mimeType,
          };
          this._recvChunks = [];
          this._recvSize = 0;
          this.onData({
            type: 'file-start',
            name: msg.name,
            size: msg.size,
            mimeType: msg.mimeType,
          });
          break;

        case 'file-end':
          // Assemble the file
          const blob = new Blob(this._recvChunks, { type: this._recvMeta.mimeType });
          this.onData({
            type: 'file-complete',
            name: this._recvMeta.name,
            size: this._recvMeta.size,
            mimeType: this._recvMeta.mimeType,
            blob,
          });
          this._recvMeta = null;
          this._recvChunks = [];
          this._recvSize = 0;
          break;
      }
    } else {
      // Binary chunk
      this._recvChunks.push(data);
      this._recvSize += data.byteLength;
      if (this._recvMeta) {
        this.onData({
          type: 'file-progress',
          name: this._recvMeta.name,
          loaded: this._recvSize,
          total: this._recvMeta.size,
        });
      }
    }
  }

  async _createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.ws.send(JSON.stringify({
      type: 'signal',
      data: { type: 'offer', sdp: offer }
    }));
  }

  async handleSignal(signal) {
    switch (signal.type) {
      case 'offer':
        await this.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.ws.send(JSON.stringify({
          type: 'signal',
          data: { type: 'answer', sdp: answer }
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

  // ===== Send Methods =====

  sendText(text) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') return false;
    this.dataChannel.send(JSON.stringify({ type: 'text', data: text }));
    return true;
  }

  async sendFile(file, onProgress) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') return false;

    // Send metadata first
    this.dataChannel.send(JSON.stringify({
      type: 'file-meta',
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
    }));

    // Send file in chunks
    let offset = 0;
    const reader = new FileReader();

    const readSlice = () => {
      return new Promise((resolve, reject) => {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(slice);
      });
    };

    while (offset < file.size) {
      const chunk = await readSlice();

      // Wait for buffer to drain if needed
      while (this.dataChannel.bufferedAmount > 4 * CHUNK_SIZE) {
        await new Promise(r => setTimeout(r, 20));
      }

      this.dataChannel.send(chunk);
      offset += chunk.byteLength;

      if (onProgress) {
        onProgress(offset, file.size);
      }
    }

    // Send end marker
    this.dataChannel.send(JSON.stringify({ type: 'file-end' }));
    return true;
  }

  close() {
    if (this.dataChannel) this.dataChannel.close();
    if (this.pc) this.pc.close();
  }
}
