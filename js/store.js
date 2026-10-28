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
import * as E2E from "./crypto.js";

const now = () => Date.now();
const uid = () => Math.random().toString(36).slice(2, 10);
const initials = (name = "?") =>
  name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase() || "?";

/* ---- Firestore usage (free tier: 50k reads / 20k writes a day) ---- */
const PRESENCE_EVERY = 2 * 60 * 1000;    // "x active" heartbeat + count refresh
const ONLINE_WINDOW = 5 * 60 * 1000;     // seen within this long → counts as online
const MESSAGES_SHOWN = 50;               // messages loaded when a chat opens

/* ---- profile change limits (firestore.rules enforces the same) ---- */
const WEEK = 7 * 24 * 60 * 60 * 1000;
export const NAME_CHANGES_PER_WEEK = 3;
export const BIO_MAX = 160;
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
// display name: 3 changes in a 7-day window that starts with the first change
export function nameLimit(u, t = now()) {
  const fresh = !u.nameWindowStart || t > u.nameWindowStart + WEEK;
  return { fresh, left: fresh ? NAME_CHANGES_PER_WEEK : Math.max(0, NAME_CHANGES_PER_WEEK - (u.nameChanges || 0)),
    resetAt: fresh ? null : u.nameWindowStart + WEEK };
}
// username: once every 7 days
export function usernameLimit(u, t = now()) {
  const nextAt = u.usernameChangedAt ? u.usernameChangedAt + WEEK : 0;
  return { ok: t > nextAt, nextAt };
}
function checkName(u, name) {
  if (!name) throw new Error("Display name can’t be empty.");
  if (name.length > 32) throw new Error("Display name can be at most 32 characters.");
  const lim = nameLimit(u);
  if (!lim.left) throw new Error(`You’ve changed your display name ${NAME_CHANGES_PER_WEEK} times this week — you can change it again on ${fmtDate(lim.resetAt)}.`);
  return lim;
}
function checkUsername(u, uname) {
  if (!/^[a-z0-9_.]{3,20}$/.test(uname)) throw new Error("Usernames are 3–20 characters: letters, numbers, _ or .");
  const lim = usernameLimit(u);
  if (!lim.ok) throw new Error(`You can change your username again on ${fmtDate(lim.nextAt)}.`);
}
const cleanBio = bio => {
  const b = (bio || "").trim();
  if (b.length > BIO_MAX) throw new Error(`Bio can be at most ${BIO_MAX} characters.`);
  return b;
};

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
    this._login({ uid: "me", username: u.toLowerCase(), email: null, name: u, bio: "", createdAt: now() });
  }
  async signUp(username, _pass, email, _dob) {
    const u = (username || "you").replace(/^@/, "");
    this._login({ uid: "me", username: u.toLowerCase(), email: email || null, name: u, bio: "", createdAt: now() });
  }
  async signOut() { this._user = null; this._authCbs.forEach(cb => cb(null)); }
  async updateProfile({ name, email, photo, bio }) {
    if (!this._user) return;
    const u = this._user;
    if (bio !== undefined) bio = cleanBio(bio);
    if (name !== undefined && name !== u.name) {
      const lim = checkName(u, name);
      if (lim.fresh) { u.nameWindowStart = now(); u.nameChanges = 1; } else u.nameChanges++;
      u.name = name;
    }
    if (bio !== undefined) u.bio = bio;
    if (email !== undefined) u.email = email || null;
    if (photo !== undefined) u.photo = photo || null;
    this._authCbs.forEach(cb => cb(u));
  }
  async changeUsername(newName) {
    const uname = newName.trim().toLowerCase().replace(/^@/, "");
    if (uname === this._user.username) return;
    checkUsername(this._user, uname);
    this._user.username = uname; this._user.usernameChangedAt = now();
    this._authCbs.forEach(cb => cb(this._user));
  }
  // demo people: look them up from the sample chats
  async fetchProfile(id) {
    if (id === "me" || id === this._user?.uid) return { ...this._user, createdAt: this._user.createdAt };
    const m = this._convs.flatMap(c => c.members).find(m => m.uid === id)
      || (this._friends || []).find(f => f.uid === id) || { name: id.replace(/^demo-/, "") };
    const name = m.name || m.username;
    return { uid: id, name, username: m.username || name.split(" ")[0].toLowerCase(),
      bio: "just here for the group chats ✌️", createdAt: now() - 40 * 86400000 };
  }
  async isOnline(id) { return this._convs.some(c => c.online && c.type === "dm" && c.members[0]?.uid === id); }
  async changePassword() { /* demo: no-op */ }
  async processAvatar(file) { return await resizeToDataURL(file, 160, 0.82); }
  async getProfile() { return {}; }
  startGlobalPresence() {}
  onActiveCount(cb) { cb(1); return () => {}; }

  /* friends (demo: adding a friend just adds them instantly) */
  onFriendRequests(cb) { cb([]); return () => {}; }
  onFriends(cb) { this._friendsCb = cb; cb(this._friends || []); return () => { this._friendsCb = null; }; }
  async sendFriendRequest(username) {
    const u = username.trim().replace(/^@/, ""); if (!u) throw new Error("Enter a username.");
    (this._friends ||= []).push({ uid: "demo-" + u.toLowerCase(), username: u.toLowerCase(), name: u });
    this._friendsCb?.(this._friends);
  }
  async acceptFriend() {}
  async declineFriend() {}
  async removeFriend(id) { this._friends = (this._friends || []).filter(f => f.uid !== id); this._friendsCb?.(this._friends || []); }
  async suggestFriends() { return []; }
  async searchUsers(prefix, limit = 6) {
    const p = prefix.trim().toLowerCase().replace(/^@/, ""); if (!p) return [];
    const people = ["alex", "alexis", "sam", "samantha", "jordan", "jordyn", "taylor", "morgan", "casey", "riley", "mom"]
      .map(u => ({ uid: "demo-" + u, username: u, name: u[0].toUpperCase() + u.slice(1) }));
    return people.filter(u => u.username.startsWith(p)).slice(0, limit);
  }

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

  async sendMessage(convId, { text, image, audio, gif }) {
    const conv = this._convs.find(c => c.id === convId);
    const msg = { id: uid(), from: { uid: "me", name: this._user.name },
      text: text || "", image: image || null, audio: audio || null, gif: gif || null, ts: now(), mine: true, readBy: [] };
    (this._msgs[convId] ||= []).push(msg);
    conv.lastText = text || (image ? "Photo" : audio ? "Voice message" : gif ? "GIF" : "");
    conv.lastTs = msg.ts; conv.lastFrom = "me";
    this._emitMsgs(convId); this._emitConvs();
    this._simulateReply(conv, msg);
  }
  async editMessage(convId, msgId, text) {
    const list = this._msgs[convId] || [], m = list.find(m => m.id === msgId); if (!m) return;
    m.text = text; m.edited = true;
    if (list[list.length - 1] === m) this._convs.find(c => c.id === convId).lastText = text;
    this._emitMsgs(convId); this._emitConvs();
  }
  async unsendMessage(convId, msgId) {
    const list = this._msgs[convId] || [], m = list.find(m => m.id === msgId); if (!m) return;
    Object.assign(m, { unsent: true, text: "", image: null, audio: null, gif: null });
    if (list[list.length - 1] === m) this._convs.find(c => c.id === convId).lastText = "Message unsent";
    this._emitMsgs(convId); this._emitConvs();
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
      conv.unread = (conv.unread || 0) + 1;   // like Firebase; the open chat clears it
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
  constructor() {
    this.mode = "firebase"; this._authCbs = []; this._user = null;
    this._profileCache = new Map(); this._memberIds = {};
    this._privKey = null; this._locked = false; this._authBusy = false;
  }
  get locked() { return this._locked; }

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
      if (this._authBusy) return;              // signIn/signUp drives the flow explicitly
      if (u) await this._handleAuth(u, null);  // page reload: unlock from device cache
      else { this._user = null; this._privKey = null; this._authCbs.forEach(cb => cb(null)); }
    });
  }

  async _handleAuth(u, password) {
    const prof = await this._loadProfile(u);
    const ms = ts => ts?.toMillis?.() || null;
    this._user = { uid: u.uid, username: prof.username, name: prof.name || prof.username,
      email: prof.email || null, photo: prof.photo || null, pubKey: prof.pubKey || null,
      bio: prof.bio || "", createdAt: ms(prof.createdAt),
      usernameChangedAt: ms(prof.usernameChangedAt), nameWindowStart: ms(prof.nameWindowStart), nameChanges: prof.nameChanges || 0 };
    this._claimUsername().catch(() => {});     // older accounts: add the username → login lookup
    await this._setupKeys(password);
    this._authCbs.forEach(cb => cb(this._user));
    if (this._user) this._presenceHeartbeat();
  }

  // Establish the E2EE private key: with a password we unwrap (or create) it;
  // without one (reload) we load the decrypted copy cached for this device.
  async _setupKeys(password) {
    const uid = this._user.uid, ref = this._fs.doc(this.db, "users", uid);
    if (password) {
      const snap = await this._fs.getDoc(ref); const d = snap.exists() ? snap.data() : {};
      if (d.pubKey && d.encPriv) {
        try { this._privKey = await E2E.unwrapPrivateKey(d.encPriv, d.salt, d.iv, password); this._locked = false; }
        catch { this._locked = true; return; }
      } else {
        const idk = await E2E.generateIdentity();
        const w = await E2E.wrapPrivateKey(idk.privateKey, password);
        await this._fs.updateDoc(ref, { pubKey: idk.publicKeyB64, encPriv: w.encPrivB64, salt: w.saltB64, iv: w.ivB64 });
        this._privKey = idk.privateKey; this._user.pubKey = idk.publicKeyB64;
        this._profileCache.delete(uid); this._locked = false;
      }
      try { await E2E.saveDeviceKey(uid, this._privKey); } catch {}
    } else {
      try { const dk = await E2E.loadDeviceKey(uid); if (dk) { this._privKey = dk; this._locked = false; return; } } catch {}
      this._locked = true;   // no cached key on this device → need password to unlock
    }
  }
  async unlock(password) {   // re-enter password to restore keys on a fresh device
    if (!this._user) return false;
    await this._setupKeys(password);
    if (!this._locked) this._authCbs.forEach(cb => cb(this._user));
    return !this._locked;
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

  // After a username change the login email stays the same, so look up which
  // login the username belongs to (usernames/{name}); fall back to the derived one.
  async _loginEmailFor(username) {
    const uname = username.trim().toLowerCase().replace(/^@/, "");
    try {
      const s = await this._fs.getDoc(this._fs.doc(this.db, "usernames", uname));
      if (s.exists() && s.data().authEmail) return s.data().authEmail;
    } catch {}
    return this._emailFor(uname);
  }
  async signIn(username, pass) {
    this._authBusy = true;
    try {
      const email = await this._loginEmailFor(username);
      let cred;
      try { cred = await this._auth.signInWithEmailAndPassword(this.auth, email, pass); }
      catch (e) {
        if (email === this._emailFor(username)) throw e;
        cred = await this._auth.signInWithEmailAndPassword(this.auth, this._emailFor(username), pass);
      }
      await this._handleAuth(cred.user, pass);
    } finally { this._authBusy = false; }
  }
  async signUp(username, pass, realEmail, dob) {
    this._authBusy = true;
    try {
      const uname = username.trim().toLowerCase();
      let claim = null;
      try { claim = await this._fs.getDoc(this._fs.doc(this.db, "usernames", uname)); } catch {}
      if (claim?.exists()) throw new Error("That username is already taken.");
      let cred;
      try { cred = await this._auth.createUserWithEmailAndPassword(this.auth, this._emailFor(uname), pass); }
      catch (e) {
        if (!String(e.code).includes("email-already-in-use")) throw e;
        // that login belongs to someone who has since renamed (or an older account):
        // make a fresh login id, then make sure nobody actually has the name
        cred = await this._auth.createUserWithEmailAndPassword(this.auth, `${uname}+${Date.now().toString(36)}@lustre.app`, pass);
        const held = await this._fs.getDocs(this._fs.query(this._fs.collection(this.db, "users"), this._fs.where("username", "==", uname)));
        if (!held.empty) { await cred.user.delete(); throw e; }
      }
      await this._auth.updateProfile(cred.user, { displayName: uname });
      await this._fs.setDoc(this._fs.doc(this.db, "users", cred.user.uid),
        { username: uname, name: uname, email: realEmail || null, dob: dob || null, createdAt: this._fs.serverTimestamp() });
      await this._handleAuth(cred.user, pass);   // generates + stores E2EE keys
    } finally { this._authBusy = false; }
  }
  async signOut() {
    const uid = this._user?.uid;
    this._privKey = null; this._locked = false;
    if (uid) try { await E2E.clearDeviceKey(uid); } catch {}   // wipe device key (shared computers)
    await this._auth.signOut(this.auth);
  }
  async updateProfile({ name, email, photo, bio }) {
    const u = this._user, patch = {};
    let nameLim = null;
    if (name !== undefined && name !== u.name) {
      nameLim = checkName(u, name);
      patch.name = name;
      if (nameLim.fresh) { patch.nameWindowStart = this._fs.serverTimestamp(); patch.nameChanges = 1; }
      else patch.nameChanges = this._fs.increment(1);
    }
    if (bio !== undefined) patch.bio = cleanBio(bio);
    if (email !== undefined) patch.email = email || null;
    if (photo !== undefined) patch.photo = photo || null;
    if (Object.keys(patch).length) await this._fs.updateDoc(this._fs.doc(this.db, "users", u.uid), patch);
    if (nameLim) {
      u.name = name;
      if (nameLim.fresh) { u.nameWindowStart = now(); u.nameChanges = 1; } else u.nameChanges++;
    }
    if (bio !== undefined) u.bio = patch.bio;
    if (email !== undefined) u.email = email || null;
    if (photo !== undefined) u.photo = photo || null;
    this._profileCache.delete(u.uid);
    this._authCbs.forEach(cb => cb(u));
  }

  // claim a username in the login lookup (signup, older accounts, renames)
  async _claimUsername() {
    const ref = this._fs.doc(this.db, "usernames", this._user.username);
    const s = await this._fs.getDoc(ref);
    if (!s.exists()) await this._fs.setDoc(ref, { uid: this._user.uid, authEmail: this.auth.currentUser.email });
  }
  async _usernameTaken(uname) {
    try {
      const claim = await this._fs.getDoc(this._fs.doc(this.db, "usernames", uname));
      if (claim.exists() && claim.data().uid !== this._user.uid) return true;
    } catch {}
    const held = await this._fs.getDocs(this._fs.query(this._fs.collection(this.db, "users"), this._fs.where("username", "==", uname)));
    return held.docs.some(d => d.id !== this._user.uid);
  }
  // rename: claim the new name, free the old one, and stamp the change — all at once
  async changeUsername(newName) {
    const u = this._user, uname = newName.trim().toLowerCase().replace(/^@/, "");
    if (uname === u.username) return;
    checkUsername(u, uname);
    if (await this._usernameTaken(uname)) throw new Error(`@${uname} is already taken.`);
    const batch = this._fs.writeBatch(this.db);
    batch.set(this._fs.doc(this.db, "usernames", uname), { uid: u.uid, authEmail: this.auth.currentUser.email });
    try {
      const oldRef = this._fs.doc(this.db, "usernames", u.username), old = await this._fs.getDoc(oldRef);
      if (old.exists() && old.data().uid === u.uid) batch.delete(oldRef);
    } catch {}
    batch.update(this._fs.doc(this.db, "users", u.uid), { username: uname, usernameChangedAt: this._fs.serverTimestamp() });
    try { await batch.commit(); }
    catch (e) {
      if (String(e.code).includes("permission-denied"))
        throw new Error("Username changes need the latest Firebase rules — publish firestore.rules, then try again.");
      throw e;
    }
    try { await this._auth.updateProfile(this.auth.currentUser, { displayName: uname }); } catch {}
    u.username = uname; u.usernameChangedAt = now();
    this._profileCache.delete(u.uid);
    this._authCbs.forEach(cb => cb(u));
  }

  // fresh copy of someone's profile (for the profile card); refreshes the cache too
  async fetchProfile(id) {
    const s = await this._fs.getDoc(this._fs.doc(this.db, "users", id));
    const d = s.exists() ? s.data() : {};
    this._profileCache.set(id, Promise.resolve(d));
    return { uid: id, name: d.name || d.username, username: d.username, photo: d.photo || null,
      bio: d.bio || "", createdAt: d.createdAt?.toMillis?.() || null };
  }
  // online = their "x active" heartbeat is recent
  async isOnline(id) {
    try {
      const s = await this._fs.getDoc(this._fs.doc(this.db, "presence_global", id));
      return s.exists() && (s.data().at?.toMillis?.() || 0) >= Date.now() - ONLINE_WINDOW;
    } catch { return false; }
  }
  async changePassword(newPass) {
    await this._auth.updatePassword(this.auth.currentUser, newPass);
    if (this._privKey) {   // re-wrap the E2EE key with the new password
      const w = await E2E.wrapPrivateKey(this._privKey, newPass);
      await this._fs.updateDoc(this._fs.doc(this.db, "users", this._user.uid),
        { encPriv: w.encPrivB64, salt: w.saltB64, iv: w.ivB64 });
      this._profileCache.delete(this._user.uid);
    }
  }
  async _membersFor(convId) {
    let ids = this._memberIds[convId];
    if (!ids) {
      const s = await this._fs.getDoc(this._fs.doc(this.db, "conversations", convId));
      ids = s.exists() ? (s.data().memberIds || []) : [];
      this._memberIds[convId] = ids;
    }
    const members = [];
    for (const u of ids) {
      let p = await this.getProfile(u);
      if (!p?.pubKey) { this._profileCache.delete(u); p = await this.getProfile(u); }  // avoid stale pre-keygen cache
      members.push({ uid: u, pubKey: p?.pubKey || (u === this._user.uid ? this._user.pubKey : null) });
    }
    return members;
  }
  async _decrypt(enc, senderUid) {
    if (!this._privKey || !senderUid) return null;
    try {
      let sp = await this.getProfile(senderUid);
      if (!sp?.pubKey) { this._profileCache.delete(senderUid); sp = await this.getProfile(senderUid); }
      const pub = sp?.pubKey || (senderUid === this._user.uid ? this._user.pubKey : null);
      if (!pub) return null;
      return await E2E.decryptMessage(enc, pub, this._user.uid, this._privKey);
    } catch { return null; }
  }
  // compress an uploaded image to a small avatar data URL (free tier, no Storage)
  async processAvatar(file) { return await resizeToDataURL(file, 160, 0.82); }
  // cached read of any user's public profile (for showing their pfp/name)
  getProfile(uid) {
    if (!this._profileCache.has(uid)) {
      this._profileCache.set(uid, (async () => {
        try { const s = await this._fs.getDoc(this._fs.doc(this.db, "users", uid)); return s.exists() ? s.data() : {}; }
        catch { return {}; }
      })());
    }
    return this._profileCache.get(uid);
  }

  /* ---------------- global presence ("x active") ----------------
     Kept cheap on purpose (free-tier quota): one heartbeat write every 2 min
     while the tab is visible, and the count is a single aggregate read every
     2 min — NOT a live listener on the whole collection, which re-read every
     doc for every viewer on every heartbeat. */
  startGlobalPresence() {
    if (this._gpStarted) return; this._gpStarted = true;
    const beat = () => {
      if (!this._user || document.hidden) return;
      this._fs.setDoc(this._fs.doc(this.db, "presence_global", this._user.uid),
        { at: this._fs.serverTimestamp(), name: this._user.name }, { merge: true }).catch(() => {});
    };
    beat();
    this._gpTimer = setInterval(beat, PRESENCE_EVERY);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) beat(); });
    window.addEventListener("beforeunload", () => {
      try { this._fs.deleteDoc(this._fs.doc(this.db, "presence_global", this._user.uid)); } catch {}
    });
  }
  onActiveCount(cb) {
    let stopped = false;
    const count = async () => {
      if (stopped || document.hidden) return;
      try {
        const since = this._fs.Timestamp.fromMillis(Date.now() - ONLINE_WINDOW);
        const q = this._fs.query(this._fs.collection(this.db, "presence_global"), this._fs.where("at", ">=", since));
        const snap = await this._fs.getCountFromServer(q);
        cb(Math.max(snap.data().count, 1));
      } catch {}
    };
    count();
    const t = setInterval(count, PRESENCE_EVERY);
    const onVis = () => { if (!document.hidden) count(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { stopped = true; clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
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

  // username autocomplete: everyone whose username starts with `prefix`
  async searchUsers(prefix, limit = 6) {
    const p = prefix.trim().toLowerCase().replace(/^@/, ""); if (!p) return [];
    const q = this._fs.query(this._fs.collection(this.db, "users"),
      this._fs.where("username", ">=", p), this._fs.where("username", "<", p + "\uf8ff"),
      this._fs.orderBy("username"), this._fs.limit(limit + 1));
    const snap = await this._fs.getDocs(q);
    return snap.docs.filter(d => d.id !== this._user.uid).slice(0, limit)
      .map(d => ({ uid: d.id, username: d.data().username, name: d.data().name, photo: d.data().photo || null }));
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
    return this._fs.onSnapshot(q, async snap => {
      const list = [];
      for (const d of snap.docs) {
        const v = d.data();
        this._memberIds[d.id] = v.memberIds || [];     // cache for encryption
        const others = (v.members || []).filter(m => m.uid !== this._user.uid);
        const title = v.type === "group" ? (v.name || others.map(m => m.name).join(", "))
                                          : (others[0]?.name || "Chat");
        let preview = v.lastText || "";                // legacy plaintext
        if (v.lastEnc) { const dec = await this._decrypt(v.lastEnc, v.lastFrom); preview = dec === null ? "🔒 Encrypted" : dec; }
        list.push({
          id: d.id, type: v.type, name: title, members: others,
          avatarText: initials(title), online: false,
          lastText: preview, lastTs: v.lastTs?.toMillis?.() || Date.now(),
          lastFrom: v.lastFrom || null,
          unread: (v.unread || {})[this._user.uid] || 0,
        });
        (this._myUnread ||= {})[d.id] = (v.unread || {})[this._user.uid] || 0;
      }
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
    this._memberIds[ref.id] = members.map(m => m.uid);
    return ref.id;
  }

  onMessages(convId, cb) {
    const q = this._fs.query(
      this._fs.collection(this.db, "conversations", convId, "messages"),
      this._fs.orderBy("ts", "asc"), this._fs.limitToLast(MESSAGES_SHOWN));
    return this._fs.onSnapshot(q, async snap => {
      const out = [];
      for (const d of snap.docs) {
        const v = d.data();
        const base = { id: d.id, from: v.from, ts: v.ts?.toMillis?.() || Date.now(),
          mine: v.from?.uid === this._user.uid, readBy: v.readBy || [], edited: !!v.editedAt };
        if (v.unsent) {
          out.push({ ...base, unsent: true, text: "", image: null, audio: null });
        } else if (v.enc) {
          const dec = await this._decrypt(v.enc, v.from?.uid);
          if (dec === null) out.push({ ...base, text: "🔒 Can’t decrypt this message", image: null, audio: null });
          else { let c = {}; try { c = JSON.parse(dec); } catch {}
            out.push({ ...base, text: c.text || "", image: c.image || null, audio: c.audio || null, gif: c.gif || null }); }
        } else {
          out.push({ ...base, text: v.text || "", image: v.image || null, audio: v.audio || null }); // legacy
        }
      }
      cb(out);
    });
  }

  async sendMessage(convId, { text, image, audio, gif }) {
    if (!this._privKey) throw new Error("Your messages are locked — sign in again to unlock encryption.");
    const from = { uid: this._user.uid, name: this._user.name };
    const members = await this._membersFor(convId);
    const content = JSON.stringify({ text: text || "", image: image || null, audio: audio || null, gif: gif || null });
    const enc = await E2E.encryptMessage(content, members, this._privKey);
    const kind = image ? "image" : audio ? "audio" : gif ? "gif" : "text";
    await this._fs.addDoc(this._fs.collection(this.db, "conversations", convId, "messages"),
      { from, enc, kind, ts: this._fs.serverTimestamp(), readBy: [this._user.uid] });
    const lastEnc = await E2E.encryptMessage(text || (image ? "Photo" : gif ? "GIF" : "Voice message"), members, this._privKey);
    // bump everyone else's unread counter (drives the blue new-message dot)
    const bumps = {};
    for (const m of members) if (m.uid !== this._user.uid) bumps[`unread.${m.uid}`] = this._fs.increment(1);
    await this._fs.updateDoc(this._fs.doc(this.db, "conversations", convId),
      { lastEnc, lastKind: kind, lastTs: this._fs.serverTimestamp(), lastFrom: this._user.uid, ...bumps });
  }

  // edit / unsend your own messages. The doc stays put (keeps its place in the
  // chat): an edit re-encrypts the new text, an unsend wipes the content.
  async editMessage(convId, msgId, text) {
    if (!this._privKey) throw new Error("Your messages are locked — sign in again to unlock encryption.");
    const members = await this._membersFor(convId);
    const enc = await E2E.encryptMessage(JSON.stringify({ text, image: null, audio: null }), members, this._privKey);
    await this._fs.updateDoc(this._fs.doc(this.db, "conversations", convId, "messages", msgId),
      { enc, editedAt: this._fs.serverTimestamp() });
    if (await this._isLastMessage(convId, msgId)) {
      const lastEnc = await E2E.encryptMessage(text, members, this._privKey);
      await this._fs.updateDoc(this._fs.doc(this.db, "conversations", convId), { lastEnc, lastKind: "text" });
    }
  }
  async unsendMessage(convId, msgId) {
    const gone = this._fs.deleteField();
    await this._fs.updateDoc(this._fs.doc(this.db, "conversations", convId, "messages", msgId),
      { unsent: true, kind: "unsent", enc: gone, text: gone, image: gone, audio: gone });
    if (await this._isLastMessage(convId, msgId))
      await this._fs.updateDoc(this._fs.doc(this.db, "conversations", convId),
        { lastEnc: gone, lastText: "Message unsent", lastKind: "unsent" });
  }
  async _isLastMessage(convId, msgId) {
    const snap = await this._fs.getDocs(this._fs.query(
      this._fs.collection(this.db, "conversations", convId, "messages"),
      this._fs.orderBy("ts", "desc"), this._fs.limit(1)));
    return snap.docs[0]?.id === msgId;
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
  // Presence writes are throttled: a change (start/stop typing, open/leave a chat)
  // writes right away; the same state again only refreshes "at" every 10s, with
  // one trailing write so a read receipt still lands. (It used to write on every
  // keystroke and every incoming message.)
  async _pres(convId, patch) {
    const st = (this._presState ||= {})[convId] ||= { state: {}, at: 0, timer: null };
    const next = { ...st.state, ...patch };
    const changed = Object.keys(patch).some(k => st.state[k] !== patch[k]);
    st.state = next;
    if (!changed && Date.now() - st.at < 10000) {
      if (!st.timer) st.timer = setTimeout(() => { st.timer = null; this._presWrite(convId, st); }, 10000 - (Date.now() - st.at));
      return;
    }
    await this._presWrite(convId, st);
  }
  async _presWrite(convId, st) {
    clearTimeout(st.timer); st.timer = null; st.at = Date.now();
    try {
      await this._fs.setDoc(this._fs.doc(this.db, "conversations", convId, "presence", this._user.uid),
        { name: this._user.name, at: this._fs.serverTimestamp(), ...st.state }, { merge: true });
    } catch (_) {}
  }
  _presenceHeartbeat() {/* refreshed on view/type; kept simple for indev 1 */}

  async openConversation(convId) { await this.markRead(convId); }
  async markRead(convId) {
    // clear my unread counter (skip the write when it's already 0)
    if ((this._myUnread || {})[convId] === 0) return;
    try {
      await this._fs.updateDoc(this._fs.doc(this.db, "conversations", convId),
        { [`unread.${this._user.uid}`]: 0 });
    } catch (_) {}
  }

  // Free tier: no Cloud Storage — compress and store media as data URLs in the
  // message doc. Firestore caps docs at ~1 MB, so we guard the size.
  // caps account for encryption (~1.4x) so the encrypted doc stays under 1 MB
  async uploadImage(file) {
    let url = await resizeToDataURL(file, 900, 0.7);
    if (url.length > 560000) url = await resizeToDataURL(file, 640, 0.58);
    if (url.length > 680000) throw new Error("That image is too large — try a smaller one.");
    return url;
  }
  async uploadAudio(blob, dur) {
    if (blob.size > 440000) throw new Error("Voice message is too long — keep it under ~30 seconds.");
    return { url: await blobToDataURL(blob), dur };
  }

  get rtcReady() { return true; }
}

/* ===================================================================== */
export const store = isConfigured() ? new FirebaseStore() : new MockStore();
export const DEMO = store.mode === "demo";
