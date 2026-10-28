/* =========================================================================
   crypto.js — end-to-end encryption primitives (WebCrypto only)
   -------------------------------------------------------------------------
   Scheme:
     • Identity: ECDH P-256 keypair per user. Public key is published;
       private key never leaves the device unencrypted.
     • Private key is wrapped with a key derived from the user's password
       (PBKDF2-SHA256, 250k iters → AES-256-GCM) so any device they log into
       can recover it. A decrypted copy is cached per-device in IndexedDB so
       a page reload doesn't need the password again.
     • Each message gets a random AES-256-GCM message key (MK); the body is
       encrypted with MK. MK is then wrapped to every member via an ECDH
       shared secret (sender↔member), so every member (incl. the sender's
       other devices) can unwrap it. Server/operator can never read content.

   We never invent crypto — this is all audited browser primitives.
   ========================================================================= */

const te = new TextEncoder(), td = new TextDecoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const subtle = () => crypto.subtle;

/* ---------------- identity keypair ---------------- */
export async function generateIdentity() {
  const kp = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const spki = await subtle().exportKey("spki", kp.publicKey);
  return { publicKeyB64: b64(spki), privateKey: kp.privateKey };
}
export async function importPublicKey(pubB64) {
  return subtle().importKey("spki", unb64(pubB64), { name: "ECDH", namedCurve: "P-256" }, true, []);
}

/* ---------------- password-wrapping of the private key ---------------- */
async function pwKey(password, salt) {
  const base = await subtle().importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function wrapPrivateKey(privateKey, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await pwKey(password, salt);
  const pk = await subtle().exportKey("pkcs8", privateKey);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv }, k, pk);
  return { encPrivB64: b64(ct), saltB64: b64(salt), ivB64: b64(iv) };
}
export async function unwrapPrivateKey(encPrivB64, saltB64, ivB64, password) {
  const k = await pwKey(password, unb64(saltB64));
  const pk = await subtle().decrypt({ name: "AES-GCM", iv: unb64(ivB64) }, k, unb64(encPrivB64));
  return subtle().importKey("pkcs8", pk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
}

/* ---------------- per-message encryption ---------------- */
async function sharedKey(myPrivateKey, peerPublicKey) {
  return subtle().deriveKey(
    { name: "ECDH", public: peerPublicKey }, myPrivateKey,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
// members: [{ uid, pubKey(b64) }] — MUST include the sender (for their other devices)
export async function encryptMessage(plaintext, members, myPrivateKey) {
  const mk = await subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: "AES-GCM", iv }, mk, te.encode(plaintext));
  const mkRaw = await subtle().exportKey("raw", mk);
  const keys = {};
  for (const m of members) {
    if (!m.pubKey) continue;
    const sk = await sharedKey(myPrivateKey, await importPublicKey(m.pubKey));
    const wkIv = crypto.getRandomValues(new Uint8Array(12));
    const wk = await subtle().encrypt({ name: "AES-GCM", iv: wkIv }, sk, mkRaw);
    keys[m.uid] = { wk: b64(wk), wkIv: b64(wkIv) };
  }
  return { ct: b64(ct), iv: b64(iv), keys };
}
export async function decryptMessage(payload, senderPubB64, myUid, myPrivateKey) {
  const mine = payload && payload.keys && payload.keys[myUid];
  if (!mine) throw new Error("no-key");
  const sk = await sharedKey(myPrivateKey, await importPublicKey(senderPubB64));
  const mkRaw = await subtle().decrypt({ name: "AES-GCM", iv: unb64(mine.wkIv) }, sk, unb64(mine.wk));
  const mk = await subtle().importKey("raw", mkRaw, { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: unb64(payload.iv) }, mk, unb64(payload.ct));
  return td.decode(pt);
}

/* ---------------- per-device key cache (IndexedDB) ---------------- */
const DB_NAME = "lustre-keys";
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("keys");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function saveDeviceKey(uid, privateKey) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("keys", "readwrite");
    tx.objectStore("keys").put(privateKey, uid);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
export async function loadDeviceKey(uid) {
  const db = await idb();
  return new Promise(res => {
    const tx = db.transaction("keys", "readonly");
    const g = tx.objectStore("keys").get(uid);
    g.onsuccess = () => res(g.result || null); g.onerror = () => res(null);
  });
}
export async function clearDeviceKey(uid) {
  const db = await idb();
  return new Promise(res => {
    const tx = db.transaction("keys", "readwrite");
    tx.objectStore("keys").delete(uid);
    tx.oncomplete = () => res();
  });
}
