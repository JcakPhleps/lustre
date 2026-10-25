/* =========================================================================
   store.js — the data layer
   -------------------------------------------------------------------------
   One interface, two backends:
     • MockStore     — offline, in-memory demo (default until Firebase is set)
     • FirebaseStore — real Auth + Firestore + Storage (switches on when config
                       is filled in; lazy-loads the Firebase SDK from the CDN)

   The rest of the app only ever talks to the interface below, so swapping
   backends never touches the UI.
   ========================================================================= */

import { firebaseConfig, isConfigured } from "./firebase-config.js";

const now = () => Date.now();
const uid = () => Math.random().toString(36).slice(2, 10);
const initials = (name = "?") =>
  name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase() || "?";

/* ---- free-tier media: encode to data URLs stored in Firestore (no Storage) ---- */
function resizeToDataURL(file, maxDim = 1000, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const s = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * s); height = Math.round(height * s);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/* ===================================================================== */
/*  MOCK STORE — interactive offline preview                              */
/* ===================================================================== */
class MockStore {
  constructor() {
    this.mode = "demo";
    this._user = null;
    this._authCbs = [];
    this._convCbs = [];
    this._msgCbs = {};        // convId -> [cb]
    this._presCbs = {};       // convId -> [cb]
    this._convs = [];
    this._msgs = {};          // convId -> [msg]
    this._pres = {};          // convId -> {viewing:Set, typing:Set}
  }

  async init() {}

  onAuth(cb) { this._authCbs.push(cb); cb(this._user); }
  me() { return this._user; }

  async signIn(username) {
    const u = (username || "you").replace(/^@/, "");
    this._login({ uid: "me", username: u.toLowerCase(), email: null, name: u });
  }
  async signUp(username, _pass, email) {
    const u = (username || "you").replace(/^@/, "");
    this._login({ uid: "me", username: u.toLowerCase(), email: email || null, name: u });
  }
  async signOut() { this._user = null; this._authCbs.forEach(cb => cb(null)); }
  async updateProfile({ name }) { if (this._user) { this._user.name = name; this._authCbs.forEach(cb => cb(this._user)); } }

  /* friends (demo: adding a friend just adds them instantly) */
  onFriendRequests(cb) { cb([]); return () => {}; }
  onFriends(cb) { this._friendsCb = cb; cb(this._friends || []); return () => { this._friendsCb = null; }; }
  async sendFriendRequest(username) {
    const u = username.trim().replace(/^@/, ""); if (!u) throw new Error("Enter a username.");
    (this._friends ||= []).push({ uid: uid(), username: u.toLowerCase(), name: u });
    this._friendsCb?.(this._friends);
  }
  async acceptFriend() {}
  async declineFriend() {}
  async removeFriend(id) { this._friends = (this._friends || []).filter(f => f.uid !== id); this._friendsCb?.(this._friends || []); }
  async suggestFriends() { return []; }

  _login(user) {
    this._user = user;
    this._seed();
    this._authCbs.forEach(cb => cb(user));
    this._emitConvs();
  }

  /* ---- seed sample conversations ---- */
  _seed() {
    const mk = (name) => ({ uid: uid(), name });
    const alex = mk("Alex Rivera"), sam = mk("Sam Chen"), jordan = mk("Jordan Lee"), mom = mk("Mom");
    const C = [
      { id: "c1", type: "dm", name: "Alex Rivera", members: [alex], online: true,
        seed: [["them","Yo are we still on for tonight?",-9],["me","for sure, 8pm?",-8],["them","perfect 🤙",-7]] },
      { id: "c2", type: "group", name: "Weekend Crew", members: [alex, sam, jordan], online: false,
        seed: [["sam","who's driving?",-40,sam],["them","i can grab everyone",-39,jordan],["me","legend",-38]] },
      { id: "c3", type: "dm", name: "Mom", members: [mom], online: false,
        seed: [["them","Did you eat? 🍲",-180],["me","yes mom lol",-179]] },
      { id: "c4", type: "dm", name: "Sam Chen", members: [sam], online: true,
        seed: [["them","sent you the files",-1440]] },
    ];
    this._convs = []; this._msgs = {}; this._pres = {};
    for (const c of C) {
      this._pres[c.id] = { viewing: new Set(), typing: new Set() };
      this._msgs[c.id] = c.seed.map(([who, text, minsAgo, sender]) => ({
        id: uid(),
        from: who === "me" ? { uid: "me", name: this._user.name }
             : sender ? { uid: sender.uid, name: sender.name }
             : { uid: c.members[0].uid, name: c.members[0].name },
        text, image: null, audio: null,
        ts: now() + minsAgo * 60000,
        mine: who === "me",
        readBy: who === "me" ? [c.members[0].uid] : ["me"],
      }));
      const last = this._msgs[c.id][this._msgs[c.id].length - 1];
      this._convs.push({
        id: c.id, type: c.type, name: c.name, members: c.members,
        avatarText: initials(c.name), online: c.online,
        lastText: last ? (last.text || "📎 Attachment") : "", lastTs: last ? last.ts : now(),
        unread: 0,
      });
    }
    this._convs.sort((a, b) => b.lastTs - a.lastTs);
  }

  onConversations(cb) { this._convCbs.push(cb); if (this._user) cb(this._convs); }
  _emitConvs() { this._convs.sort((a, b) => b.lastTs - a.lastTs); this._convCbs.forEach(cb => cb(this._convs)); }

  async createConversation({ type, name, handles }) {
    const members = (handles || []).map(h => ({ uid: uid(), name: h.replace(/^@/, "") }));
    const id = uid();
    const title = name || members.map(m => m.name).join(", ") || "New chat";
    this._pres[id] = { viewing: new Set(), typing: new Set() };
    this._msgs[id] = [];
    this._convs.push({ id, type: type || (members.length > 1 ? "group" : "dm"), name: title, members,
      avatarText: initials(title), online: false, lastText: "", lastTs: now(), unread: 0 });
    this._emitConvs();
    return id;
  }

  onMessages(convId, cb) {
    (this._msgCbs[convId] ||= []).push(cb);
    cb(this._msgs[convId] || []);
    return () => { this._msgCbs[convId] = (this._msgCbs[convId] || []).filter(f => f !== cb); };
  }
  _emitMsgs(convId) { (this._msgCbs[convId] || []).forEach(cb => cb(this._msgs[convId] || [])); }

  async sendMessage(convId, { text, image, audio }) {
    const conv = this._convs.find(c => c.id === convId);
    const msg = { id: uid(), from: { uid: "me", name: this._user.name },
      text: text || "", image: image || null, audio: audio || null, ts: now(), mine: true, readBy: [] };
    (this._msgs[convId] ||= []).push(msg);
    conv.lastText = text || (image ? "Photo" : audio ? "Voice message" : "");
    conv.lastTs = msg.ts; conv.lastFrom = "me";
    this._emitMsgs(convId); this._emitConvs();
    this._simulateReply(conv, msg);
  }

  /* make the demo feel alive: they view → read → type → reply */
  _simulateReply(conv, myMsg) {
    const partner = conv.members[0];
    const pres = this._pres[conv.id];
    setTimeout(() => { pres.viewing.add(partner.name); this._emitPres(conv.id); }, 500);
    setTimeout(() => { myMsg.readBy = [partner.uid]; this._emitMsgs(conv.id); }, 1000);
    setTimeout(() => { pres.typing.add(partner.name); this._emitPres(conv.id); }, 1200);
    const replies = ["haha yeah","for sure","omg","wait really?","on my way 🚗","sounds good 👍",
      "lmaooo","one sec","💯","nice","k","let me check","that's wild","😂😂"];
    setTimeout(() => {
      pres.typing.delete(partner.name); this._emitPres(conv.id);
      const text = replies[Math.floor(Math.random() * replies.length)];
      const reply = { id: uid(), from: { uid: partner.uid, name: partner.name },
        text, image: null, audio: null, ts: now(), mine: false, readBy: ["me"] };
      this._msgs[conv.id].push(reply);
      conv.lastText = text; conv.lastTs = reply.ts; conv.lastFrom = partner.uid;
      this._emitMsgs(conv.id); this._emitConvs();
      setTimeout(() => { pres.viewing.delete(partner.name); this._emitPres(conv.id); }, 4000);
    }, 2400);
  }

  onConvPresence(convId, cb) {
    (this._presCbs[convId] ||= []).push(cb);
    this._emitPres(convId);
    return () => { this._presCbs[convId] = (this._presCbs[convId] || []).filter(f => f !== cb); };
  }
  _emitPres(convId) {
    const p = this._pres[convId] || { viewing: new Set(), typing: new Set() };
    (this._presCbs[convId] || []).forEach(cb => cb({ viewing: [...p.viewing], typing: [...p.typing], reads: {} }));
  }

  setViewing() {}      // (my own presence; no-op in demo)
  setTyping() {}
  openConversation(convId) { const c = this._convs.find(c => c.id === convId); if (c) { c.unread = 0; this._emitConvs(); } }
  markRead() {}

  async uploadImage(file) { return URL.createObjectURL(file); }
  async uploadAudio(blob, dur) { return { url: URL.createObjectURL(blob), dur }; }

  // calls use this to know we're offline
  get rtcReady() { return false; }
}

/* ===================================================================== */
/*  FIREBASE STORE — real backend (lazy-loaded)                           */
/* ===================================================================== */
class FirebaseStore {
  constructor() { this.mode = "firebase"; this._authCbs = []; this._user = null; }

  async init() {
    const V = "10.12.0", base = `https://www.gstatic.com/firebasejs/${V}`;
    const app = await import(`${base}/firebase-app.js`);
    this._auth = await import(`${base}/firebase-auth.js`);
    this._fs = await import(`${base}/firebase-firestore.js`);
    this._st = await import(`${base}/firebase-storage.js`);
    this.app = app.initializeApp(firebaseConfig);
    this.auth = this._auth.getAuth(this.app);
    this.db = this._fs.getFirestore(this.app);
    this.storage = this._st.getStorage(this.app);

    this._auth.onAuthStateChanged(this.auth, async (u) => {
      if (u) {
        const prof = await this._loadProfile(u);
        this._user = { uid: u.uid, username: prof.username, name: prof.name || prof.username, email: prof.email || null };
      } else { this._user = null; }
      this._authCbs.forEach(cb => cb(this._user));
      if (this._user) this._presenceHeartbeat();
    });
  }

  onAuth(cb) { this._authCbs.push(cb); if (this._user !== undefined) cb(this._user); }
  me() { return this._user; }

  // Firebase Auth is email/password under the hood; we derive a stable internal
  // email from the username so people sign in with just a username + password.
  _emailFor(username) { return `${username.trim().toLowerCase()}@lustre.app`; }

  async _loadProfile(u) {
    const ref = this._fs.doc(this.db, "users", u.uid);
    const snap = await this._fs.getDoc(ref);
    if (!snap.exists()) {
      const uname = (u.displayName || u.email.split("@")[0]).toLowerCase();
      const data = { username: uname, name: uname, email: null, createdAt: this._fs.serverTimestamp() };
      await this._fs.setDoc(ref, data); return data;
    }
    return snap.data();
  }

  async signIn(username, pass) {
    await this._auth.signInWithEmailAndPassword(this.auth, this._emailFor(username), pass);
  }
  async signUp(username, pass, realEmail) {
    const uname = username.trim().toLowerCase();
    const cred = await this._auth.createUserWithEmailAndPassword(this.auth, this._emailFor(uname), pass);
    await this._auth.updateProfile(cred.user, { displayName: uname });
    await this._fs.setDoc(this._fs.doc(this.db, "users", cred.user.uid),
      { username: uname, name: uname, email: realEmail || null, createdAt: this._fs.serverTimestamp() });
  }
  async signOut() { await this._auth.signOut(this.auth); }
  async updateProfile({ name }) {
    await this._fs.updateDoc(this._fs.doc(this.db, "users", this._user.uid), { name });
    this._user.name = name; this._authCbs.forEach(cb => cb(this._user));
  }

  /* ---------------- friends ---------------- */
  async _findUserByName(uname) {
    const q = this._fs.query(this._fs.collection(this.db, "users"), this._fs.where("username", "==", uname));
    const snap = await this._fs.getDocs(q);
    return snap.empty ? null : { uid: snap.docs[0].id, ...snap.docs[0].data() };
  }
  async sendFriendRequest(username) {
    const uname = username.trim().toLowerCase().replace(/^@/, "");
    if (!uname) throw new Error("Enter a username.");
    if (uname === this._user.username) throw new Error("That's you!");
    const target = await this._findUserByName(uname);
    if (!target) throw new Error(`No user named “${uname}”.`);
    const already = await this._fs.getDoc(this._fs.doc(this.db, "users", this._user.uid, "friends", target.uid));
    if (already.exists()) throw new Error(`You're already friends with ${uname}.`);
    // drop a request into their inbox
    await this._fs.setDoc(this._fs.doc(this.db, "users", target.uid, "requests", this._user.uid),
      { username: this._user.username, name: this._user.name, at: this._fs.serverTimestamp() });
  }
  onFriendRequests(cb) {
    return this._fs.onSnapshot(this._fs.collection(this.db, "users", this._user.uid, "requests"), snap => {
      cb(snap.docs.map(d => ({ uid: d.id, username: d.data().username, name: d.data().name })));
    });
  }
  async acceptFriend(req) {
    const me = this._user;
    await this._fs.setDoc(this._fs.doc(this.db, "users", me.uid, "friends", req.uid),
      { username: req.username, name: req.name, since: this._fs.serverTimestamp() });
    await this._fs.setDoc(this._fs.doc(this.db, "users", req.uid, "friends", me.uid),
      { username: me.username, name: me.name, since: this._fs.serverTimestamp() });
    await this._fs.deleteDoc(this._fs.doc(this.db, "users", me.uid, "requests", req.uid));
  }
  async declineFriend(req) {
    await this._fs.deleteDoc(this._fs.doc(this.db, "users", this._user.uid, "requests", req.uid));
  }
  onFriends(cb) {
    return this._fs.onSnapshot(this._fs.collection(this.db, "users", this._user.uid, "friends"), snap => {
      cb(snap.docs.map(d => ({ uid: d.id, username: d.data().username, name: d.data().name })));
    });
  }
  async removeFriend(uid) {
    await this._fs.deleteDoc(this._fs.doc(this.db, "users", this._user.uid, "friends", uid));
    try { await this._fs.deleteDoc(this._fs.doc(this.db, "users", uid, "friends", this._user.uid)); } catch {}
  }

  // friends-of-friends, ranked by how many friends you share
  async suggestFriends(limit = 8) {
    const myUid = this._user.uid;
    const mine = await this._fs.getDocs(this._fs.collection(this.db, "users", myUid, "friends"));
    const myFriendIds = mine.docs.map(d => d.id);
    const exclude = new Set([myUid, ...myFriendIds]);
    const counts = new Map();
    for (const fid of myFriendIds) {
      try {
        const fof = await this._fs.getDocs(this._fs.collection(this.db, "users", fid, "friends"));
        fof.forEach(d => {
          if (exclude.has(d.id)) return;
          const v = d.data();
          const cur = counts.get(d.id) || { uid: d.id, username: v.username, name: v.name, mutuals: 0 };
          cur.mutuals++;
          counts.set(d.id, cur);
        });
      } catch {}
    }
    return [...counts.values()].sort((a, b) => b.mutuals - a.mutuals).slice(0, limit);
  }

  onConversations(cb) {
    // array-contains alone needs no composite index; we sort client-side.
    const q = this._fs.query(
      this._fs.collection(this.db, "conversations"),
      this._fs.where("memberIds", "array-contains", this._user.uid));
    return this._fs.onSnapshot(q, snap => {
      const list = snap.docs.map(d => {
        const v = d.data();
        const others = (v.members || []).filter(m => m.uid !== this._user.uid);
        const title = v.type === "group" ? (v.name || others.map(m => m.name).join(", "))
                                          : (others[0]?.name || "Chat");
        return {
          id: d.id, type: v.type, name: title, members: others,
          avatarText: initials(title), online: false,
          lastText: v.lastText || "", lastTs: v.lastTs?.toMillis?.() || Date.now(),
          lastFrom: v.lastFrom || null,
          unread: (v.unread || {})[this._user.uid] || 0,
        };
      });
      list.sort((a, b) => b.lastTs - a.lastTs);
      cb(list);
    });
  }

  async createConversation({ type, name, handles }) {
    // resolve usernames → users
    const members = [{ uid: this._user.uid, name: this._user.name, username: this._user.username }];
    for (const h of (handles || [])) {
      const uname = h.trim().toLowerCase().replace(/^@/, "");
      if (!uname || uname === this._user.username || members.some(m => m.username === uname)) continue;
      const q = this._fs.query(this._fs.collection(this.db, "users"), this._fs.where("username", "==", uname));
      const snap = await this._fs.getDocs(q);
      if (snap.empty) throw new Error(`No user named “${uname}”.`);
      const d = snap.docs[0];
      members.push({ uid: d.id, name: d.data().name, username: uname });
    }
    if (members.length < 2) throw new Error("Add at least one other person by username.");
    const ref = await this._fs.addDoc(this._fs.collection(this.db, "conversations"), {
      type: type || (members.length > 2 ? "group" : "dm"),
      name: name || null, members,
      memberIds: members.map(m => m.uid),
      lastText: "", lastTs: this._fs.serverTimestamp(), unread: {},
      createdAt: this._fs.serverTimestamp(),
    });
    return ref.id;
  }

  onMessages(convId, cb) {
    const q = this._fs.query(
      this._fs.collection(this.db, "conversations", convId, "messages"),
      this._fs.orderBy("ts", "asc"), this._fs.limitToLast(200));
    return this._fs.onSnapshot(q, snap => {
      cb(snap.docs.map(d => {
        const v = d.data();
        return {
          id: d.id, from: v.from, text: v.text || "", image: v.image || null, audio: v.audio || null,
          ts: v.ts?.toMillis?.() || Date.now(), mine: v.from?.uid === this._user.uid,
          readBy: v.readBy || [],
        };
      }));
    });
  }

  async sendMessage(convId, { text, image, audio }) {
    const from = { uid: this._user.uid, name: this._user.name };
    await this._fs.addDoc(this._fs.collection(this.db, "conversations", convId, "messages"),
      { from, text: text || "", image: image || null, audio: audio || null,
        ts: this._fs.serverTimestamp(), readBy: [this._user.uid] });
    await this._fs.updateDoc(this._fs.doc(this.db, "conversations", convId),
      { lastText: text || (image ? "Photo" : "Voice message"),
        lastTs: this._fs.serverTimestamp(), lastFrom: this._user.uid });
  }

  /* presence: a lightweight doc per conversation keyed by uid */
  onConvPresence(convId, cb) {
    const q = this._fs.collection(this.db, "conversations", convId, "presence");
    return this._fs.onSnapshot(q, snap => {
      const viewing = [], typing = [], reads = {}, cutoff = Date.now() - 15000;
      snap.forEach(d => {
        if (d.id === this._user.uid) return;
        const v = d.data();
        const t = v.at?.toMillis?.() || 0;
        reads[d.id] = t;                       // last-seen time (for read receipts)
        if (t >= cutoff && v.viewing) viewing.push(v.name);
        if (t >= cutoff && v.typing) typing.push(v.name);
      });
      cb({ viewing, typing, reads });
    });
  }
  async setViewing(convId, on) { await this._pres(convId, { viewing: on }); }
  async setTyping(convId, on) { await this._pres(convId, { typing: on }); }
  async _pres(convId, patch) {
    try {
      await this._fs.setDoc(this._fs.doc(this.db, "conversations", convId, "presence", this._user.uid),
        { name: this._user.name, at: this._fs.serverTimestamp(), ...patch }, { merge: true });
    } catch (_) {}
  }
  _presenceHeartbeat() {/* refreshed on view/type; kept simple for indev 1 */}

  async openConversation(convId) { await this.markRead(convId); }
  async markRead(convId) {
    // clear my unread counter and stamp recent messages as read
    try {
      await this._fs.updateDoc(this._fs.doc(this.db, "conversations", convId),
        { [`unread.${this._user.uid}`]: 0 });
    } catch (_) {}
  }

  // Free tier: no Cloud Storage — compress and store media as data URLs in the
  // message doc. Firestore caps docs at ~1 MB, so we guard the size.
  async uploadImage(file) {
    let url = await resizeToDataURL(file, 1000, 0.7);
    if (url.length > 900000) url = await resizeToDataURL(file, 720, 0.6);
    if (url.length > 1000000) throw new Error("That image is too large for the free tier.");
    return url;
  }
  async uploadAudio(blob, dur) {
    if (blob.size > 720000) throw new Error("Voice message is too long for the free tier (~45s max).");
    return { url: await blobToDataURL(blob), dur };
  }

  get rtcReady() { return true; }
}

/* ===================================================================== */
export const store = isConfigured() ? new FirebaseStore() : new MockStore();
export const DEMO = store.mode === "demo";
