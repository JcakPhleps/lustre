/* =========================================================================
   calls.js — video / voice calls (WebRTC)
   -------------------------------------------------------------------------
   • Demo mode: opens the call stage with your own camera so you can see the UI.
   • Firebase mode: 1:1 call over a Firestore-signalled RTCPeerConnection.
     Signalling docs live under conversations/{id}/signals, and a single
     conversations/{id}/calls/live doc announces/ends the call.
   ========================================================================= */

// STUN finds your public address; TURN relays media when a direct path is
// blocked (common across different home networks). OpenRelay is a free,
// no-signup public TURN service so calls connect without any setup.
const ICE = { iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
]};

function mediaErr(e, video) {
  switch (e && e.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Lustre needs camera & microphone access to call. Please allow it when your browser asks, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return video ? "No camera found — try a voice call instead." : "No microphone found.";
    case "NotReadableError":
      return "Your camera or mic is being used by another app. Close it and try again.";
    default:
      return e?.message || "Couldn’t access your camera/microphone.";
  }
}

export class CallManager {
  constructor(store) {
    this.store = store;
    this.local = null;           // local MediaStream
    this.peers = new Map();      // uid -> { pc }
    this.active = null;          // { convId, video, members }
    this._unsub = [];
    this._onTile = () => {};
    this._onEnd = () => {};
  }

  // read these lazily — the Firebase SDK isn't loaded when the manager is built
  get fs() { return this.store._fs; }
  get db() { return this.store.db; }

  onTile(fn) { this._onTile = fn; }
  onEnd(fn) { this._onEnd = fn; }

  async _getMedia(video) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Calls need a secure page — use the https site or http://localhost (not an http:// IP address).");
    }
    try {
      this.local = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    } catch (e) {
      throw new Error(mediaErr(e, video));
    }
    this._onTile("me", this.local, "You");
    return this.local;
  }

  async _clearSignals(callId) {
    try {
      const snap = await this.fs.getDocs(this.fs.collection(this.db, "conversations", callId, "signals"));
      await Promise.all(snap.docs.map(d => this.fs.deleteDoc(d.ref)));
    } catch {}
  }

  /* ---------------- outgoing ---------------- */
  async start(conv, { video = true } = {}) {
    this.active = { convId: conv.id, video, members: conv.members };
    await this._getMedia(video);

    if (this.store.mode === "demo") {
      setTimeout(() => this._onTile(conv.members[0]?.uid || "peer", this.local, conv.name + " (demo)"), 700);
      return;
    }
    const peer = conv.members[0];
    await this._clearSignals(conv.id);              // caller clears stale signals
    await this._connectTo(peer.uid, conv.id, true);
    await this.fs.setDoc(this.fs.doc(this.db, "conversations", conv.id, "calls", "live"),
      { from: this.store.me().uid, fromName: this.store.me().name, video, at: this.fs.serverTimestamp() });
    this._watchLive(conv.id);
  }

  // when the shared call doc disappears, the other side ended it → hang up too
  _watchLive(convId) {
    let saw = false;
    this._unsub.push(this.fs.onSnapshot(this.fs.doc(this.db, "conversations", convId, "calls", "live"), snap => {
      if (snap.exists()) saw = true;
      else if (saw) this.hangup();
    }));
  }

  /* ---------------- incoming ---------------- */
  listenIncoming(conv, onIncoming, onCancel) {
    if (this.store.mode === "demo") return () => {};
    const ref = this.fs.doc(this.db, "conversations", conv.id, "calls", "live");
    return this.fs.onSnapshot(ref, snap => {
      const v = snap.data();
      if (v && v.from !== this.store.me().uid && !this.active) onIncoming(conv, v);
      else if (!v && onCancel) onCancel(conv);        // caller hung up / call ended
    });
  }

  async accept(conv, info) {
    this.active = { convId: conv.id, video: info.video, members: conv.members };
    await this._getMedia(info.video);
    await this._connectTo(info.from, conv.id, false); // answerer must NOT clear signals
    this._watchLive(conv.id);
  }

  async decline(conv) {
    if (this.store.mode === "demo") return this.hangup();
    try { await this.fs.deleteDoc(this.fs.doc(this.db, "conversations", conv.id, "calls", "live")); } catch {}
  }

  /* ---------------- peer connection + signalling ---------------- */
  async _connectTo(peerUid, callId, isCaller) {
    const pc = new RTCPeerConnection(ICE);
    this.peers.set(peerUid, { pc });
    this.local.getTracks().forEach(t => pc.addTrack(t, this.local));

    const remote = new MediaStream();
    pc.ontrack = e => {
      (e.streams[0] ? e.streams[0].getTracks() : [e.track]).forEach(t => remote.addTrack(t));
      this._onTile(peerUid, remote, "Them");
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.hangup();   // dead connection → end
    };

    const me = this.store.me().uid;
    const sigCol = this.fs.collection(this.db, "conversations", callId, "signals");
    pc.onicecandidate = e => {
      if (e.candidate) this.fs.addDoc(sigCol, { to: peerUid, from: me, cand: e.candidate.toJSON(), at: this.fs.serverTimestamp() });
    };

    // buffer remote ICE candidates until the remote description is set
    const pending = [];
    let remoteSet = false;

    const q = this.fs.query(sigCol, this.fs.where("to", "==", me));
    this._unsub.push(this.fs.onSnapshot(q, snap => {
      snap.docChanges().forEach(async ch => {
        if (ch.type !== "added") return;
        const d = ch.doc.data();
        if (d.from !== peerUid) return;
        if (d.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
          remoteSet = true;
          while (pending.length) { try { await pc.addIceCandidate(new RTCIceCandidate(pending.shift())); } catch {} }
          if (d.sdp.type === "offer") {
            const ans = await pc.createAnswer();
            await pc.setLocalDescription(ans);
            await this.fs.addDoc(sigCol, { to: peerUid, from: me, sdp: { type: ans.type, sdp: ans.sdp }, at: this.fs.serverTimestamp() });
          }
        } else if (d.cand) {
          if (remoteSet) { try { await pc.addIceCandidate(new RTCIceCandidate(d.cand)); } catch {} }
          else pending.push(d.cand);
        }
      });
    }));

    if (isCaller) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.fs.addDoc(sigCol, { to: peerUid, from: me, sdp: { type: offer.type, sdp: offer.sdp }, at: this.fs.serverTimestamp() });
    }
  }

  /* ---------------- controls ---------------- */
  toggleMute() { const t = this.local?.getAudioTracks()[0]; if (t) t.enabled = !t.enabled; return t ? !t.enabled : false; }
  toggleCam()  { const t = this.local?.getVideoTracks()[0]; if (t) t.enabled = !t.enabled; return t ? !t.enabled : false; }

  async hangup() {
    const convId = this.active?.convId;
    this.peers.forEach(p => { try { p.pc.close(); } catch {} });
    this.peers.clear();
    this.local?.getTracks().forEach(t => t.stop());
    this.local = null;
    this._unsub.forEach(u => { try { u(); } catch {} }); this._unsub = [];
    if (convId && this.store.mode === "firebase") {
      try { await this.fs.deleteDoc(this.fs.doc(this.db, "conversations", convId, "calls", "live")); } catch {}
      this._clearSignals(convId);
    }
    this.active = null;
    this._onEnd();
  }
}
