/* =========================================================================
   app.js — UI controller
   ========================================================================= */
import { store, DEMO } from "./store.js";
import { recordVoice, renderWave, fmtDur } from "./audio.js";
import { CallManager } from "./calls.js";
import * as sfx from "./sfx.js";
import { CHANGELOG, VERSION } from "./changelog.js";

/* ---------- tiny DOM helper ---------- */
function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach(c => c != null && n.append(c));
  return n;
}
const $ = s => document.querySelector(s);
const screen = $("#screen");

/* ---------- time formatting ---------- */
const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDay = ts => {
  const d = new Date(ts), today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d).setHours(0, 0, 0, 0)) / 86400000;
  if (diff === 0) return "Today"; if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
};

function ageFrom(dobStr) {
  const d = new Date(dobStr), n = new Date();
  let a = n.getFullYear() - d.getFullYear();
  const m = n.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < d.getDate())) a--;
  return a;
}

/* ---------- avatars & profile pictures ---------- */
const initials = (n = "?") => n.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase() || "?";
const PFP_COLORS = {
  blue:   "linear-gradient(#5bb0ff,#0a6cff)",  green:  "linear-gradient(#8ee06a,#2f9c2f)",
  purple: "linear-gradient(#b98cff,#6c38c0)",  orange: "linear-gradient(#ffbf5c,#e0720a)",
  pink:   "linear-gradient(#ff93c4,#e03f85)",  teal:   "linear-gradient(#6ee0d0,#1aa697)",
  red:    "linear-gradient(#ff8a8a,#d62222)",  gray:   "linear-gradient(#b7c0cc,#8c97a6)",
};
const PRESETS = [
  "p:😎:blue", "p:🐱:orange", "p:🎮:purple", "p:🌮:red", "p:🚀:teal", "p:🎸:pink",
  "p:🌈:green", "p:👾:purple", "p:🍕:orange", "p:⚡:blue", "p:🦊:orange", "p:🐸:green",
];
// person: { uid?, name?, username?, photo? }; opts: { cls, online }
function avatarEl(person = {}, opts = {}) {
  const av = el("div", { class: "avatar" + (opts.cls ? " " + opts.cls : "") + (opts.online ? " online" : "") });
  const dot = el("span", { class: "dot" });
  applyAvatar(av, person, dot);
  if (!person.photo && person.uid && person.uid !== "me" && store.getProfile) {
    Promise.resolve(store.getProfile(person.uid)).then(p => { if (p && p.photo) applyAvatar(av, { ...person, photo: p.photo }, dot); });
  }
  return av;
}
function applyAvatar(av, person, dot) {
  const photo = person.photo;
  av.style.background = ""; av.style.backgroundImage = ""; av.textContent = "";
  av.classList.remove("has-img", "emoji");
  if (photo && photo.startsWith("data:")) {
    av.classList.add("has-img");
    av.style.backgroundImage = `url("${photo}")`;
  } else if (photo && photo.startsWith("p:")) {
    const [, emoji, color] = photo.split(":");
    av.classList.add("emoji");
    av.style.background = PFP_COLORS[color] || PFP_COLORS.gray;
    av.textContent = emoji || "";
  } else {
    av.textContent = initials(person.name || person.username || "?");
  }
  if (dot) av.append(dot);
}

/* =====================================================================
   APP STATE
   ===================================================================== */
let convs = [];
let activeId = null;
let msgUnsub = null, presUnsub = null;
let callWatchers = new Map();   // conv id -> unsub (incoming-call listeners)
let convSeen = null;   // conv id -> last seen lastTs (for background receive sounds)
let friendRequests = [], friends = [], friendsOpen = false, friendsBadgeEl = null, friendSubs = [];
let settingsPhoto;   // pending pfp in Settings; undefined = unchanged
function drawPfpPreview() {
  const u = store.me(); if (!u) return;
  applyAvatar($("#setPfpPreview"), { name: u.name, username: u.username, photo: settingsPhoto === undefined ? u.photo : settingsPhoto });
}
function clearPfpSel() { $("#setPfpPresets").querySelectorAll(".pfp-choice").forEach(x => x.classList.remove("sel")); }
const calls = new CallManager(store);

/* =====================================================================
   PREFERENCES (per-device, localStorage)
   ===================================================================== */
const ACCENTS = {
  Blue:     ["#45a5ff", "#1e8bff", "#0a6cff"],
  Green:    ["#8ee06a", "#49b839", "#2f9c2f"],
  Purple:   ["#b98cff", "#8a56e0", "#6c38c0"],
  Orange:   ["#ffbf5c", "#ff8c1a", "#e0720a"],
  Pink:     ["#ff93c4", "#ff5fa0", "#e03f85"],
  Graphite: ["#9aa0aa", "#636a74", "#454b54"],
};
const WALLS = {
  Linen: "#c9c5bd", Slate: "#aeb6c2", Sage: "#bcc5b4",
  Sand: "#d6c9ab", Rose: "#ccb9bd", Graphite: "#a6a6ab",
};
const SIZES = { Small: "13px", Medium: "14.5px", Large: "16.5px" };

function prefGet(k, d) { try { const v = localStorage.getItem("lustre." + k); return v === null ? d : v; } catch { return d; } }
function prefSet(k, v) { try { localStorage.setItem("lustre." + k, v); } catch {} }
const prefs = {
  accent: prefGet("accent", "Blue"),
  wall: prefGet("wall", "Linen"),
  size: prefGet("size", "Medium"),
  enter: prefGet("enter", "1") === "1",
  receipts: prefGet("receipts", "1") === "1",
  notify: prefGet("notify", "0") === "1",
  theme: prefGet("theme", document.documentElement.dataset.defaultTheme || "skeuo"),   // "skeuo" | "aero"
};
function notify(title, body, tag) {
  if (!prefs.notify || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, tag, renotify: true });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), 8000);
  } catch {}
}
function applyPrefs() {
  const r = document.documentElement.style;
  const a = ACCENTS[prefs.accent] || ACCENTS.Blue;
  r.setProperty("--blue-top", a[0]); r.setProperty("--blue-mid", a[1]); r.setProperty("--blue-bot-ok", a[2]);
  r.setProperty("--linen", WALLS[prefs.wall] || WALLS.Linen);
  r.setProperty("--bubble-size", SIZES[prefs.size] || SIZES.Medium);
  document.documentElement.dataset.theme = prefs.theme === "aero" ? "aero" : "skeuo";
}
applyPrefs();

/* =====================================================================
   BOOT
   ===================================================================== */
await store.init();
store.onAuth(user => {
  if (!user) return renderAuth();
  if (store.locked) return renderUnlock(user);
  renderApp(user);
});

// quick preview: open with #demo to jump straight into the sample chats
if (DEMO && location.hash === "#demo" && !store.me()) store.signIn("you@lustre.app");

/* =====================================================================
   AUTH SCREEN
   ===================================================================== */
function renderAuth() {
  let mode = "in"; // 'in' | 'up'
  const err = el("div", { class: "err" });

  const username = el("input", { class: "input", placeholder: "username", autocomplete: "username",
    autocapitalize: "none", spellcheck: "false" });
  const pass = el("input", { class: "input", type: "password", placeholder: "Password", autocomplete: "current-password" });
  const email = el("input", { class: "input", type: "email", placeholder: "you@email.com",
    autocomplete: "email", autocapitalize: "none" });
  const emailWrap = el("div", { class: "hidden" }, [
    el("label", { html: "Email <span style='font-weight:400;color:#9aa0a8'>(optional — for recovery)</span>" }),
    email,
  ]);
  const dob = el("input", { class: "input", type: "date" });
  const dobWrap = el("div", { class: "hidden" }, [el("label", { text: "Date of birth" }), dob]);
  const agree = el("input", { type: "checkbox" });
  const agreeWrap = el("div", { class: "hidden" }, [
    el("label", { class: "toggle", style: "font-size:12px;align-items:flex-start" }, [agree,
      el("span", { html: "I'm 13 or older and agree to the <a href='terms.html' target='_blank' class='link'>Terms</a> &amp; <a href='privacy.html' target='_blank' class='link'>Privacy Policy</a>." })]),
  ]);

  const submit = el("button", { class: "btn blue", text: "Sign In" });
  const toggle = el("span", { class: "link", text: "Create one" });

  const card = el("div", { class: "card" }, [
    el("h1", {}, ["Lustre", el("span", { class: "indev", text: "beta " + VERSION, title: "What's new", onclick: openChangelog })]),
    el("div", { class: "tag", text: "stay in touch — with a little shine" }),
    el("label", { text: "Username" }), username,
    el("label", { text: "Password" }), pass,
    emailWrap,
    dobWrap,
    agreeWrap,
    err,
    el("div", { class: "row" }, [submit]),
    el("div", { class: "muted", html: "" }),
  ]);
  const muted = card.querySelector(".muted");
  const refreshMuted = () => {
    muted.textContent = mode === "in" ? "New here? " : "Already have an account? ";
    toggle.textContent = mode === "in" ? "Create one" : "Sign in";
    muted.append(toggle);
  };
  refreshMuted();

  toggle.addEventListener("click", () => {
    mode = mode === "in" ? "up" : "in";
    submit.textContent = mode === "in" ? "Sign In" : "Create Account";
    emailWrap.classList.toggle("hidden", mode === "in");
    dobWrap.classList.toggle("hidden", mode === "in");
    agreeWrap.classList.toggle("hidden", mode === "in");
    pass.setAttribute("autocomplete", mode === "in" ? "current-password" : "new-password");
    err.textContent = ""; refreshMuted();
  });

  async function go() {
    err.textContent = "";
    const uname = username.value.trim().toLowerCase();
    if (!/^[a-z0-9_.]{3,20}$/.test(uname)) {
      err.textContent = "Username: 3–20 chars — letters, numbers, . or _ only."; return;
    }
    if (pass.value.length < 6) { err.textContent = "Password must be at least 6 characters."; return; }
    if (mode === "up") {
      if (!dob.value) { err.textContent = "Please enter your date of birth."; return; }
      if (ageFrom(dob.value) < 13) { err.textContent = "You must be at least 13 years old to use Lustre."; return; }
      if (!agree.checked) { err.textContent = "Please agree to the Terms & Privacy Policy."; return; }
    }
    submit.disabled = true;
    try {
      if (mode === "in") await store.signIn(uname, pass.value);
      else await store.signUp(uname, pass.value, email.value.trim(), dob.value);
    } catch (e) { err.textContent = friendlyAuthError(e); submit.disabled = false; }
  }
  submit.addEventListener("click", go);
  [username, pass, email].forEach(i => i.addEventListener("keydown", e => e.key === "Enter" && go()));

  const extras = [];
  if (DEMO) {
    const demoBtn = el("button", { class: "btn", style: "margin-top:12px;width:100%",
      text: "Skip — preview the look →", onclick: () => store.signIn("you@lustre.app") });
    extras.push(el("div", { style: "width:340px;max-width:100%;margin:14px auto 0;text-align:center" }, [
      el("div", { style: "font-size:12px;line-height:1.5;color:#8a6d1e;text-shadow:0 1px 0 rgba(255,255,255,.6)",
        text: "Demo mode — Firebase isn’t configured yet. Explore freely; nothing is saved." }),
      demoBtn,
    ]));
  }

  const footer = el("div", { class: "muted", style: "margin-top:12px",
    html: "<a href='privacy.html' target='_blank' class='link'>Privacy</a> &nbsp;·&nbsp; <a href='terms.html' target='_blank' class='link'>Terms</a>" });

  screen.innerHTML = "";
  screen.append(el("div", { class: "center" }, [el("div", {}, [card, ...extras, footer])]));
}

/* unlock screen — fresh device with no cached key needs the password */
function renderUnlock(user) {
  const err = el("div", { class: "err" });
  const pass = el("input", { class: "input", type: "password", placeholder: "Your password", autocomplete: "current-password" });
  const btn = el("button", { class: "btn blue", text: "Unlock" });
  const go = async () => {
    err.textContent = ""; btn.disabled = true;
    const ok = await store.unlock(pass.value);
    if (!ok) { err.textContent = "Wrong password — couldn’t unlock your messages."; btn.disabled = false; }
  };
  btn.onclick = go;
  pass.addEventListener("keydown", e => e.key === "Enter" && go());
  const card = el("div", { class: "card" }, [
    el("h1", {}, ["Lustre", el("span", { class: "indev", text: "beta " + VERSION, title: "What's new", onclick: openChangelog })]),
    el("div", { class: "tag", text: "Enter your password to unlock your encrypted messages on this device" }),
    el("label", { text: "Password" }), pass,
    err,
    el("div", { class: "row" }, [btn]),
    el("div", { class: "muted" }, [el("span", { class: "link", text: "Sign out", onclick: () => store.signOut() })]),
  ]);
  screen.innerHTML = "";
  screen.append(el("div", { class: "center" }, [card]));
}

/* "What's new" changelog (version pill opens this) */
function openChangelog() {
  const body = $("#changelogBody"); body.innerHTML = "";
  for (const e of CHANGELOG) {
    body.append(el("div", { class: "sectionhead", text: e.version + "  —  " + e.date }));
    const ul = el("ul", { class: "changelog-list" });
    for (const c of e.changes) ul.append(el("li", { text: c }));
    body.append(ul);
  }
  $("#changelogOverlay").classList.add("show");
}

/* =====================================================================
   MAIN APP
   ===================================================================== */
function renderApp(user) {
  const convList = el("div", { class: "conv-list" });
  const search = el("input", { class: "input", placeholder: "Search", oninput: e => filterConvs(e.target.value) });
  const newChatBtn = el("button", { class: "btn blue", text: "New Chat",
    onclick: () => $("#newChatOverlay").classList.add("show") });
  friendsBadgeEl = el("span", { class: "reqbadge hidden" });
  const friendsBtn = el("button", { class: "btn", onclick: openFriends }, ["Friends", friendsBadgeEl]);
  const settingsBtn = el("button", { class: "btn", text: "Settings", onclick: openSettings });
  const activeCountEl = el("span", { class: "active-count", text: "…" });
  const sidebar = el("div", { class: "sidebar pinstripe" }, [
    el("div", { class: "brand" }, [
      el("span", { class: "spark" }),
      el("span", { class: "wordmark" }, ["Lustre", el("span", { class: "indev", text: "beta " + VERSION, title: "What's new", onclick: openChangelog })]),
    ]),
    el("div", { class: "active-line" }, [el("span", { class: "active-dot" }), activeCountEl]),
    el("div", { class: "sidebar-actions" }, [newChatBtn, friendsBtn, settingsBtn]),
    el("div", { class: "search" }, [search]),
    convList,
  ]);
  store.startGlobalPresence();
  store.onActiveCount(n => { activeCountEl.textContent = n + " active"; });

  const chat = el("div", { class: "chat" }, [
    el("div", { class: "center", html: "<div style='color:#6c6660;text-shadow:0 1px 0 rgba(255,255,255,.5)'>Pick a conversation, or start a new one.</div>" }),
  ]);

  const body = el("div", { class: "body" }, [sidebar, chat]);
  screen.innerHTML = ""; screen.append(body);

  // keep references
  renderApp._els = { convList, chat, body, search };

  let demoOpened = false;
  store.onConversations(list => {
    // play "receive" when a non-active chat gets a new incoming message
    if (convSeen) {
      for (const c of list) {
        const prev = convSeen.get(c.id);
        if (prev !== undefined && c.lastTs > prev && c.id !== activeId
            && c.lastFrom && c.lastFrom !== store.me().uid) {
          sfx.playReceive();
          notify(c.name, c.lastText || "New message", "msg-" + c.id);   // another chat → always notify
        }
      }
    } else convSeen = new Map();
    for (const c of list) convSeen.set(c.id, c.lastTs);
    convs = list; paintConvList();
    // watch every conversation for incoming calls
    const ids = new Set(list.map(c => c.id));
    for (const [cid, un] of callWatchers) if (!ids.has(cid)) { try { un(); } catch {} callWatchers.delete(cid); }
    for (const c of list) if (!callWatchers.has(c.id)) callWatchers.set(c.id, calls.listenIncoming(c, onIncomingCall, onCallCancel));
    if (location.hash === "#demo" && !demoOpened && !activeId && convs.length) { demoOpened = true; openConv(convs[0].id); }
  });

  // friends + requests (live; drives the Friends badge even when the dialog is closed)
  friendSubs.forEach(u => { try { u(); } catch {} }); friendSubs = [];
  friendSubs.push(store.onFriendRequests(reqs => { friendRequests = reqs; updateFriendsBadge(); if (friendsOpen) renderFriendLists(); }));
  friendSubs.push(store.onFriends(list => { friends = list; if (friendsOpen) renderFriendLists(); }));

  wireChrome();
}

function filterConvs(q) { paintConvList(q.toLowerCase()); }

function paintConvList(filter = "") {
  const { convList } = renderApp._els;
  convList.innerHTML = "";
  for (const c of convs) {
    if (filter && !c.name.toLowerCase().includes(filter)) continue;
    const av = avatarEl({ uid: c.type === "dm" ? c.members[0]?.uid : null, name: c.name }, { online: c.online });
    const row = el("div", { class: "conv" + (c.id === activeId ? " active" : ""), onclick: () => openConv(c.id) }, [
      av,
      el("div", { class: "conv-body" }, [
        el("div", { class: "conv-top" }, [
          el("div", { class: "conv-name", text: c.name }),
          el("div", { class: "conv-time", text: c.lastTs ? fmtTime(c.lastTs) : "" }),
        ]),
        el("div", { class: "conv-last", text: c.lastText || "No messages yet" }),
      ]),
    ]);
    if (c.unread > 0) row.append(el("div", { class: "newdot", title: "New message" }));
    convList.append(row);
  }
}

// back to the chat list (narrow screens): stop treating the chat as open,
// so new messages in it light up the blue dot again
function leaveConv() {
  if (!activeId) return;
  store.setViewing(activeId, false);
  if (msgUnsub) { msgUnsub(); msgUnsub = null; }
  if (presUnsub) { presUnsub(); presUnsub = null; }
  activeId = null;
  paintConvList(renderApp._els.search.value.toLowerCase());
}

/* =====================================================================
   OPEN A CONVERSATION
   ===================================================================== */
function openConv(id) {
  // leave previous
  if (activeId && activeId !== id) store.setViewing(activeId, false);
  if (msgUnsub) { msgUnsub(); msgUnsub = null; }
  if (presUnsub) { presUnsub(); presUnsub = null; }

  activeId = id;
  const conv = convs.find(c => c.id === id);
  store.openConversation(id);
  store.setViewing(id, true);
  paintConvList(renderApp._els.search.value.toLowerCase());
  renderApp._els.body.classList.add("show-chat");

  const { chat } = renderApp._els;
  chat.innerHTML = "";

  /* ---- header ---- */
  const status = el("div", { class: "status", text: conv.online ? "Online" : "" });
  const head = el("div", { class: "chat-head metal" }, [
    el("button", { class: "btn backbtn", text: "‹ Chats",
      onclick: () => { renderApp._els.body.classList.remove("show-chat"); leaveConv(); } }),
    avatarEl({ uid: conv.type === "dm" ? conv.members[0]?.uid : null, name: conv.name }, { cls: "sm", online: conv.online }),
    el("div", { class: "who" }, [el("div", { class: "name", text: conv.name }), status]),
    el("button", { class: "btn", text: "Call", onclick: () => startCall(conv, false) }),
    el("button", { class: "btn", text: "Video", onclick: () => startCall(conv, true) }),
  ]);

  /* ---- messages ---- */
  const messages = el("div", { class: "messages linen" });
  const receiptEl = el("div", { class: "receipt hidden" });   // persistent; not rebuilt with bubbles

  /* ---- composer ---- */
  const ta = el("textarea", { rows: 1, placeholder: "Message", oninput: onType });
  const photoBtn = el("button", { class: "btn", text: "Photo", onclick: () => $("#imgInput").click() });
  const voiceBtn = el("button", { class: "btn", text: "Voice", onclick: toggleVoice });
  const sendBtn = el("button", { class: "btn blue", text: "Send", onclick: sendText });
  const composer = el("div", { class: "composer metal" }, [
    photoBtn,
    el("div", { class: "field" }, [ta]),
    voiceBtn,
    sendBtn,
  ]);

  const editBar = el("div", { class: "editbar hidden" }, [
    el("span", { text: "Editing message" }),
    el("button", { class: "btn", text: "Cancel", onclick: cancelEdit }),
  ]);

  chat.append(head, messages, editBar, composer);
  autoGrow(ta);

  /* ---- live state + render pipeline ---- */
  let lastMsgs = [];
  let lastPres = { viewing: [], typing: [], reads: {} };
  let seenIds = null;
  let prevRead = false, prevViewing = false, prevTyping = false, presInit = false;

  const readTs = () => conv.members.reduce((mx, m) => Math.max(mx, lastPres.reads?.[m.uid] || 0), 0);
  const otherViewing = () => (lastPres.viewing || []).length > 0;

  // rebuild the message bubbles (only when the message list actually changes)
  function renderMessages() {
    paintMessages(messages, lastMsgs, conv, onMsgMenu);
    messages.append(receiptEl);                // keep receipt below the bubbles
    paintTyping(messages, conv, lastPres);     // typing bubble stays last
    updateReceipt();
  }
  // presence changed (typing / here / read) — update WITHOUT touching the bubbles
  function renderPresence() {
    paintTyping(messages, conv, lastPres);
    updateStatus(status, conv, lastPres);
    updateReceipt();
  }
  function updateReceipt() {
    const lastMine = [...lastMsgs].reverse().find(m => m.mine);
    if (conv.type !== "dm" || !prefs.receipts || !lastMine) { receiptEl.classList.add("hidden"); return; }
    const read = otherViewing() || readTs() >= lastMine.ts;
    receiptEl.textContent = read ? "Read " + fmtTime(lastMine.ts) : "Delivered";
    receiptEl.classList.remove("hidden");
  }
  function checkReadSound() {
    const lastMine = [...lastMsgs].reverse().find(m => m.mine);
    const read = conv.type === "dm" && !!lastMine && (otherViewing() || readTs() >= lastMine.ts);
    if (read && !prevRead) sfx.playRead();
    prevRead = read;
  }

  msgUnsub = store.onMessages(id, list => {
    const added = !seenIds ? [] : list.filter(m => !seenIds.has(m.id));
    lastMsgs = list;
    renderMessages();
    store.setViewing(id, true);   // refresh our "seen" time so the sender gets a Read
    if (seenIds === null) seenIds = new Set(list.map(m => m.id));
    else {
      for (const m of added) seenIds.add(m.id);
      const incoming = added.filter(m => !m.mine);
      if (incoming.length) {
        if (!document.hidden) store.openConversation(id);   // looking at it — keep the new-message dot off
        sfx.playReceive();
        if (document.hidden) {
          const m = incoming[incoming.length - 1];
          notify(conv.name, m.text || (m.image ? "Photo" : m.audio ? "Voice message" : "New message"), "msg-" + id);
        }
      }
    }
    checkReadSound();
  });

  presUnsub = store.onConvPresence(id, pres => {
    lastPres = pres;
    renderPresence();
    const viewing = otherViewing(), typing = (pres.typing || []).length > 0;
    if (presInit) {
      if (viewing && !prevViewing) sfx.playHere();
      else if (!viewing && prevViewing) sfx.playLeft();
      if (typing && !prevTyping) sfx.playTyping();
    }
    prevViewing = viewing; prevTyping = typing; presInit = true;
    checkReadSound();
  });

  /* ---- actions ---- */
  function sendText() {
    const text = ta.value.trim(); if (!text) return;
    if (editing) {
      if (text !== editing.text)
        store.editMessage(id, editing.id, text).catch(e => alert(e.message || "Couldn’t edit that message."));
      cancelEdit(); store.setTyping(id, false);
      return;
    }
    store.sendMessage(id, { text }); sfx.playSend();
    ta.value = ""; autoGrow(ta); store.setTyping(id, false);
  }

  // edit / unsend (your own messages): right-click, long-press, or the ⋯ button
  let editing = null;
  function onMsgMenu(m, x, y) {
    const isText = !m.image && !m.audio;
    showMsgMenu(x, y, [
      isText && { label: "Copy", fn: () => navigator.clipboard?.writeText(m.text) },
      isText && { label: "Edit", fn: () => startEdit(m) },
      { label: "Unsend", danger: true, fn: () => unsend(m) },
    ]);
  }
  function startEdit(m) {
    editing = m;
    ta.value = m.text; autoGrow(ta); ta.focus();
    sendBtn.textContent = "Save";
    editBar.classList.remove("hidden");
  }
  function cancelEdit() {
    editing = null;
    ta.value = ""; autoGrow(ta);
    sendBtn.textContent = "Send";
    editBar.classList.add("hidden");
  }
  function unsend(m) {
    if (!confirm("Unsend this message? It’ll be removed for everyone in the chat.")) return;
    if (editing?.id === m.id) cancelEdit();
    store.unsendMessage(id, m.id).catch(e => alert(e.message || "Couldn’t unsend that message."));
  }

  ta.addEventListener("keydown", e => {
    if (e.key === "Escape" && editing) { e.preventDefault(); cancelEdit(); return; }
    if (e.key !== "Enter") return;
    const send = prefs.enter ? !e.shiftKey : (e.metaKey || e.ctrlKey);
    if (send) { e.preventDefault(); sendText(); }
  });
  let typingTimer;
  function onType() {
    autoGrow(ta);
    store.setTyping(id, true);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => store.setTyping(id, false), 2500);
  }

  // image attachment
  $("#imgInput").onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    e.target.value = "";
    try {
      const url = await store.uploadImage(file);
      store.sendMessage(id, { image: url }); sfx.playSend();
    } catch (e) { alert(e.message || "Couldn’t send that image."); }
  };

  // voice
  let recorder = null;
  async function toggleVoice() {
    if (!recorder) {
      try {
        recorder = await recordVoice();
        voiceBtn.classList.add("red"); voiceBtn.textContent = "Stop";
      } catch { alert("Microphone permission needed for voice messages."); }
    } else {
      const { blob, dur, peaks } = await recorder.stop();
      recorder = null; voiceBtn.classList.remove("red"); voiceBtn.textContent = "Voice";
      try {
        const uploaded = await store.uploadAudio(blob, dur);
        store.sendMessage(id, { audio: { ...uploaded, peaks } }); sfx.playSend();
      } catch (e) { alert(e.message || "Couldn’t send that voice message."); }
    }
  }

  scrollBottom(messages);
}

/* paint message bubbles with day-stamps, grouping, avatars (receipt is separate) */
function paintMessages(container, list, conv, onMenu) {
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  container.querySelectorAll(".msg,.daystamp,.typingrow").forEach(n => n.remove());
  let lastDay = null;
  const sorted = [...list].sort((a, b) => a.ts - b.ts);
  sorted.forEach((m, i) => {
    const day = fmtDay(m.ts);
    if (day !== lastDay) { container.append(el("div", { class: "daystamp", text: day })); lastDay = day; }
    container.append(msgNode(m, conv, sorted[i - 1], onMenu));
  });
  if (atBottom) scrollBottom(container);
}

function msgNode(m, conv, prev, onMenu) {
  const sameSender = prev && prev.from.uid === m.from.uid && (m.ts - prev.ts < 120000);
  const stack = el("div", { class: "stack" });

  if (conv.type === "group" && !m.mine && !sameSender)
    stack.append(el("div", { class: "sender", text: m.from.name }));

  let bubble;
  if (m.unsent) {
    bubble = el("div", { class: "unsent", text: m.mine ? "You unsent a message" : `${m.from.name} unsent a message` });
  } else if (m.image) {
    bubble = el("div", { class: "bubble media " + (m.mine ? "me" : "them") },
      [el("img", { src: m.image, onclick: () => openLightbox(m.image) })]);
  } else if (m.audio) {
    bubble = el("div", { class: "bubble " + (m.mine ? "me" : "them") }, [voiceNode(m.audio)]);
  } else {
    bubble = el("div", { class: "bubble " + (m.mine ? "me" : "them"), text: m.text });
  }
  stack.append(bubble);
  if (m.edited && !m.unsent) stack.append(el("div", { class: "edited", text: "Edited" }));

  const row = el("div", { class: "msg" + (m.mine ? " mine" : "") });
  if (conv.type === "group" && !m.mine)
    row.append(avatarEl({ uid: m.from.uid, name: m.from.name }, { cls: "sm" }));
  row.append(stack);
  if (m.mine && !m.unsent && onMenu) {
    const open = (x, y) => onMenu(m, x, y);
    attachLongPress(bubble, open);
    row.append(el("button", { class: "msgmore", text: "⋯", title: "Edit or unsend",
      onclick: e => { const r = e.currentTarget.getBoundingClientRect(); open(r.left, r.bottom + 4); } }));
  }
  return row;
}

/* right-click or long-press (touch) on a bubble → open its menu */
function attachLongPress(node, open) {
  node.addEventListener("contextmenu", e => { e.preventDefault(); open(e.clientX, e.clientY); });
  let timer = null, fired = false;
  node.addEventListener("touchstart", e => {
    const t = e.touches[0]; fired = false;
    timer = setTimeout(() => { fired = true; open(t.clientX, t.clientY); }, 500);
  }, { passive: true });
  const cancel = () => { clearTimeout(timer); timer = null; };
  node.addEventListener("touchmove", cancel, { passive: true });
  node.addEventListener("touchcancel", cancel);
  node.addEventListener("touchend", e => { cancel(); if (fired) e.preventDefault(); });   // no click after a long-press
}

/* username autocomplete under an input. `find(query, alreadyTyped)` returns
   people; `multi` = comma-separated list (completes the name being typed). */
function attachSuggest(input, { find, multi = false, showOnEmpty = false }) {
  input.setAttribute("autocomplete", "off");
  const wrap = el("div", { class: "suggest-wrap" });
  input.replaceWith(wrap); wrap.append(input);
  const list = el("div", { class: "suggest hidden" });
  wrap.append(list);
  let items = [], sel = -1, timer = null, reqNo = 0;

  const parts = () => input.value.split(",");
  const current = () => (multi ? parts().pop() : input.value).trim();
  const taken = () => multi ? parts().slice(0, -1).map(s => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean) : [];
  const close = () => { list.classList.add("hidden"); items = []; sel = -1; };

  function paint() {
    list.innerHTML = "";
    if (!items.length) { close(); return; }
    items.forEach((u, i) => list.append(el("div", {
      class: "suggest-item" + (i === sel ? " sel" : ""),
      onpointerdown: e => { e.preventDefault(); pick(u); },   // before the input blurs
    }, [
      avatarEl({ uid: u.uid, name: u.name || u.username, photo: u.photo }, { cls: "sm" }),
      el("div", { class: "friend-name" }, [
        el("div", { text: u.name || u.username }),
        el("div", { class: "friend-sub", text: "@" + u.username }),
      ]),
      u.tag ? el("span", { class: "suggest-tag", text: u.tag }) : null,
    ])));
    list.classList.remove("hidden");
  }
  function pick(u) {
    if (multi) { const p = parts(); p[p.length - 1] = " " + u.username; input.value = p.join(",").replace(/^ /, "") + ", "; }
    else input.value = u.username;
    close(); input.focus();
  }
  function update() {
    const q = current();
    if (!q && !showOnEmpty) { close(); return; }
    const my = ++reqNo;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      let res = [];
      try { res = await find(q, taken()); } catch {}
      if (my !== reqNo) return;          // a newer keystroke already asked
      items = res; sel = -1; paint();
    }, q ? 150 : 0);
  }

  input.addEventListener("input", update);
  input.addEventListener("focus", update);
  input.addEventListener("blur", () => setTimeout(close, 100));
  input.addEventListener("keydown", e => {
    if (list.classList.contains("hidden") || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % items.length; paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; paint(); }
    else if (e.key === "Enter" && sel >= 0) { e.preventDefault(); e.stopImmediatePropagation(); pick(items[sel]); }
    else if (e.key === "Escape") { e.stopPropagation(); close(); }
  });
}

/* full-screen image viewer (click a photo in the chat) */
function openLightbox(src) {
  const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") close(); };
  const box = el("div", { class: "lightbox", onclick: e => { if (e.target === box) close(); } }, [
    el("img", { src, alt: "Photo" }),
    el("div", { class: "lightbox-bar" }, [
      el("a", { class: "btn", text: "Save", href: src, download: "lustre-photo.jpg" }),
      el("button", { class: "btn", text: "✕", title: "Close", onclick: close }),
    ]),
  ]);
  document.addEventListener("keydown", onKey);
  document.body.append(box);
}

/* small popup menu (Copy / Edit / Unsend) */
let msgMenu = null;
function showMsgMenu(x, y, items) {
  closeMsgMenu();
  msgMenu = el("div", { class: "msgmenu" }, items.filter(Boolean).map(it =>
    el("button", { class: it.danger ? "danger" : "", text: it.label,
      onclick: () => { closeMsgMenu(); it.fn(); } })));
  document.body.append(msgMenu);
  const r = msgMenu.getBoundingClientRect();
  msgMenu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px";
  msgMenu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px";
}
function closeMsgMenu() { msgMenu?.remove(); msgMenu = null; }
document.addEventListener("pointerdown", e => { if (msgMenu && !msgMenu.contains(e.target)) closeMsgMenu(); }, true);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeMsgMenu(); });
window.addEventListener("resize", closeMsgMenu);

function voiceNode(audio) {
  const a = new Audio(audio.url);
  const play = el("button", { class: "play", text: "▶" });
  const wave = renderWave(audio.peaks || [0.3, 0.6, 0.4, 0.8, 0.5]);
  const dur = el("span", { class: "dur", text: fmtDur(audio.dur || 1) });
  play.addEventListener("click", () => {
    if (a.paused) { a.play(); play.textContent = "⏸"; } else { a.pause(); play.textContent = "▶"; }
  });
  a.addEventListener("ended", () => { play.textContent = "▶"; });
  return el("div", { class: "voice" }, [play, wave, dur]);
}

/* the "typing…" bubble at the bottom of the transcript */
function paintTyping(messages, conv, pres) {
  messages.querySelectorAll(".typingrow").forEach(n => n.remove());
  if (!(pres.typing || []).length) return;
  const who = conv.type === "group" ? pres.typing.join(", ") + " typing…" : "";
  const bubble = el("div", { class: "bubble them typing" }, [el("i"), el("i"), el("i")]);
  const row = el("div", { class: "msg typingrow" }, [
    ...(conv.type === "group" ? [el("div", { class: "avatar sm", text: "…" })] : []),
    el("div", { class: "stack" }, [...(who ? [el("div", { class: "sender", text: who })] : []), bubble]),
  ]);
  messages.append(row);
  scrollBottom(messages);
}

/* header subtitle: typing… / x is here / online */
function updateStatus(statusEl, conv, pres) {
  const viewing = (pres.viewing || []).length > 0;
  const typing = (pres.typing || []).length > 0;
  if (typing) { statusEl.textContent = "typing…"; statusEl.className = "status here"; }
  else if (viewing) { statusEl.textContent = conv.type === "group" ? pres.viewing.join(", ") + " here" : conv.name.split(" ")[0] + " is here"; statusEl.className = "status here"; }
  else { statusEl.textContent = conv.online ? "Online" : ""; statusEl.className = "status"; }
}

/* =====================================================================
   CALLS
   ===================================================================== */
const callStage = $("#callStage"), callGrid = $("#callGrid");
let outgoingTimer = null, callConnected = false;
const RING_MS = 1700, MAX_RINGS = 20;   // give up after ~20 rings
calls.onTile((peerId, stream, label) => {
  let tile = callGrid.querySelector(`[data-peer="${peerId}"]`);
  if (!tile) {
    const video = el("video", { autoplay: "", playsinline: "", muted: peerId === "me" ? "" : null });
    video.muted = peerId === "me";
    tile = el("div", { class: "calltile", "data-peer": peerId }, [video, el("div", { class: "label", text: label })]);
    callGrid.append(tile);
  }
  tile.querySelector("video").srcObject = stream;
  tile.querySelector(".label").textContent = label;
  if (peerId !== "me") { callConnected = true; clearTimeout(outgoingTimer); sfx.stopRing(); }  // connected
});
calls.onEnd(() => { clearTimeout(outgoingTimer); sfx.stopRing(); callStage.classList.remove("show"); callGrid.innerHTML = ""; });

async function startCall(conv, video) {
  callGrid.innerHTML = "";
  callConnected = false; clearTimeout(outgoingTimer);
  callStage.classList.add("show");
  sfx.startRing();                        // ringback while waiting for an answer
  try {
    await calls.start(conv, { video });
    outgoingTimer = setTimeout(() => {     // no answer after ~20 rings → end it
      if (!callConnected) { calls.hangup(); alert("No answer."); }
    }, RING_MS * MAX_RINGS);
  } catch (e) {
    sfx.stopRing(); callStage.classList.remove("show"); alert(e.message || "Couldn’t start the call."); calls.hangup();
  }
}
$("#callHang").onclick = () => calls.hangup();
$("#callMute").onclick = e => { const muted = calls.toggleMute(); e.currentTarget.classList.toggle("active", muted); e.currentTarget.textContent = muted ? "Unmute" : "Mute"; };
$("#callVideo").onclick = e => { const off = calls.toggleCam(); e.currentTarget.classList.toggle("active", off); e.currentTarget.textContent = off ? "Start Camera" : "Camera"; };

// incoming call — any conversation can ring (listeners set up in onConversations)
let incomingInfo = null;
function onIncomingCall(conv, info) {
  if (calls.active) return;
  incomingInfo = { conv, info };
  $("#incomingName").textContent = info.fromName || conv.name;
  $("#incomingKind").textContent = info.video ? "Video call" : "Voice call";
  $("#incomingOverlay").classList.add("show");
  sfx.startRing();
  notify(info.fromName || conv.name, (info.video ? "Video" : "Voice") + " call…", "call-" + conv.id);
}
function onCallCancel(conv) {
  if (incomingInfo && incomingInfo.conv.id === conv.id) {
    incomingInfo = null;
    sfx.stopRing();
    $("#incomingOverlay").classList.remove("show");
  }
}
$("#incomingAccept").onclick = async () => {
  sfx.stopRing();
  $("#incomingOverlay").classList.remove("show");
  if (!incomingInfo) return;
  const { conv, info } = incomingInfo; incomingInfo = null;
  callStage.classList.add("show"); callGrid.innerHTML = "";
  try { await calls.accept(conv, info); }
  catch (e) { callStage.classList.remove("show"); alert(e.message || "Couldn’t join the call."); calls.hangup(); }
};
$("#incomingDecline").onclick = () => {
  sfx.stopRing();
  $("#incomingOverlay").classList.remove("show");
  if (incomingInfo) calls.decline(incomingInfo.conv);
  incomingInfo = null;
};

// changelog overlay (wired at top level so it works on auth/unlock screens too)
$("#changelogClose").onclick = () => $("#changelogOverlay").classList.remove("show");
$("#changelogOverlay").addEventListener("click", e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove("show"); });

/* =====================================================================
   CHROME (title-bar buttons + modals)
   ===================================================================== */
function wireChrome() {
  // new chat modal
  $("#newChatCancel").onclick = () => $("#newChatOverlay").classList.remove("show");
  attachSuggest($("#newChatPeople"), {
    multi: true,
    showOnEmpty: true,
    // friends first (by username or name), then everyone else by username
    find: async (q, taken) => {
      const ql = q.toLowerCase().replace(/^@/, "");
      const mine = friends.filter(f => !ql || f.username.startsWith(ql) || (f.name || "").toLowerCase().includes(ql))
        .map(f => ({ ...f, tag: "Friend" }));
      const others = ql ? await store.searchUsers(ql) : [];
      const seen = new Set(taken), out = [];
      for (const u of [...mine, ...others]) if (!seen.has(u.username)) { seen.add(u.username); out.push(u); }
      return out.slice(0, 6);
    },
  });
  $("#newChatCreate").onclick = async () => {
    const people = $("#newChatPeople").value.split(",").map(s => s.trim()).filter(Boolean);
    if (!people.length) { $("#newChatErr").textContent = "Add at least one username."; return; }
    const name = $("#newChatName").value.trim();
    const type = people.length > 1 || name ? "group" : "dm";
    try {
      $("#newChatErr").textContent = "";
      const id = await store.createConversation({ type, name, handles: people });
      $("#newChatOverlay").classList.remove("show");
      $("#newChatPeople").value = ""; $("#newChatName").value = ""; $("#newChatErr").textContent = "";
      setTimeout(() => openConv(id), 120);
    } catch (e) { $("#newChatErr").textContent = e.message || String(e); }
  };

  // settings modal
  $("#setSignout").onclick = () => { $("#settingsOverlay").classList.remove("show"); store.signOut(); };
  $("#setSave").onclick = async () => {
    const errEl = $("#setErr");
    try {
      await store.updateProfile({
        name: $("#setName").value.trim(), email: $("#setEmail").value.trim(),
        ...(settingsPhoto !== undefined ? { photo: settingsPhoto } : {}),
      });
      errEl.textContent = "Saved."; errEl.style.color = "#2f9c16";
      setTimeout(() => $("#settingsOverlay").classList.remove("show"), 450);
    } catch (e) { errEl.textContent = e.message || String(e); errEl.style.color = ""; }
  };
  $("#setPfpUpload").onclick = () => $("#pfpInput").click();
  $("#pfpInput").onchange = async e => {
    const f = e.target.files[0]; if (!f) return; e.target.value = "";
    try { settingsPhoto = await store.processAvatar(f); drawPfpPreview(); clearPfpSel(); }
    catch { $("#setErr").textContent = "Couldn’t load that image."; $("#setErr").style.color = ""; }
  };
  $("#setPfpRemove").onclick = () => { settingsPhoto = null; drawPfpPreview(); clearPfpSel(); };
  $("#setChangePw").onclick = () => $("#pwArea").classList.toggle("hidden");
  $("#setWhatsNew").onclick = () => { $("#settingsOverlay").classList.remove("show"); openChangelog(); };
  $("#pwSave").onclick = async () => {
    const pw = $("#pwNew").value, errEl = $("#setErr");
    if (pw.length < 6) { errEl.textContent = "Password must be at least 6 characters."; errEl.style.color = ""; return; }
    try {
      await store.changePassword(pw);
      errEl.textContent = "Password updated."; errEl.style.color = "#2f9c16";
      $("#pwNew").value = ""; $("#pwArea").classList.add("hidden");
    } catch (e) {
      errEl.textContent = (e.code || "").includes("recent-login")
        ? "Please sign out and back in, then change your password."
        : friendlyAuthError(e);
      errEl.style.color = "";
    }
  };
  // friends modal
  const addFriend = async () => {
    const v = $("#friendAdd").value.trim(); if (!v) return;
    const errEl = $("#friendErr");
    try {
      await store.sendFriendRequest(v);
      $("#friendAdd").value = "";
      errEl.textContent = "Request sent!"; errEl.style.color = "#2f9c16";
    } catch (e) { errEl.textContent = e.message || String(e); errEl.style.color = ""; }
  };
  $("#friendAddBtn").onclick = addFriend;
  attachSuggest($("#friendAdd"), {
    find: async q => {
      const isFriend = new Set(friends.map(f => f.uid));
      return (await store.searchUsers(q)).map(u => ({ ...u, tag: isFriend.has(u.uid) ? "Friend" : "" }));
    },
  });
  $("#friendAdd").addEventListener("keydown", e => e.key === "Enter" && addFriend());
  $("#friendsClose").onclick = () => { $("#friendsOverlay").classList.remove("show"); friendsOpen = false; };

  [$("#newChatOverlay"), $("#settingsOverlay"), $("#friendsOverlay")].forEach(o =>
    o.addEventListener("click", e => { if (e.target === o) { o.classList.remove("show"); friendsOpen = false; } }));
}

/* ---- friends ---- */
function openFriends() {
  friendsOpen = true;
  $("#friendErr").textContent = "";
  renderFriendLists();
  loadSuggestions();
  $("#friendsOverlay").classList.add("show");
}
async function loadSuggestions() {
  const box = $("#friendSuggest");
  box.innerHTML = ""; box.append(el("div", { class: "muted", text: "Looking…" }));
  let list = [];
  try { list = await store.suggestFriends(); } catch { list = []; }
  const friendIds = new Set(friends.map(f => f.uid));
  list = list.filter(s => !friendIds.has(s.uid));
  box.innerHTML = "";
  if (!list.length) { box.append(el("div", { class: "muted", text: "No suggestions yet — add a few friends first." })); return; }
  for (const s of list) {
    const addBtn = el("button", { class: "btn blue", text: "Add" });
    addBtn.onclick = async () => {
      addBtn.disabled = true; addBtn.textContent = "Sent";
      try { await store.sendFriendRequest(s.username); }
      catch (e) { addBtn.disabled = false; addBtn.textContent = "Add"; $("#friendErr").textContent = e.message; $("#friendErr").style.color = ""; }
    };
    box.append(friendRow(s, [
      el("span", { class: "friend-mutual", text: s.mutuals + " mutual" + (s.mutuals === 1 ? "" : "s") }),
      addBtn,
    ]));
  }
}
function updateFriendsBadge() {
  if (!friendsBadgeEl) return;
  const n = friendRequests.length;
  friendsBadgeEl.textContent = n ? String(n) : "";
  friendsBadgeEl.classList.toggle("hidden", !n);
}
function friendRow(p, actions) {
  return el("div", { class: "friend-row" }, [
    avatarEl({ uid: p.uid, name: p.name || p.username, photo: p.photo }, { cls: "sm" }),
    el("div", { class: "friend-name" }, [
      el("div", { text: p.name || p.username }),
      el("div", { class: "friend-sub", text: "@" + p.username }),
    ]),
    ...actions,
  ]);
}
function renderFriendLists() {
  $("#friendReqSection").classList.toggle("hidden", friendRequests.length === 0);
  const reqList = $("#friendReqList"); reqList.innerHTML = "";
  for (const r of friendRequests) {
    reqList.append(friendRow(r, [
      el("button", { class: "btn green", text: "Accept",
        onclick: async () => { try { await store.acceptFriend(r); } catch (e) { $("#friendErr").textContent = e.message; $("#friendErr").style.color = ""; } } }),
      el("button", { class: "btn", text: "Decline", onclick: () => store.declineFriend(r) }),
    ]));
  }
  const frList = $("#friendList"); frList.innerHTML = "";
  if (!friends.length) frList.append(el("div", { class: "muted", text: "No friends yet." }));
  else for (const f of friends) {
    frList.append(friendRow(f, [
      el("button", { class: "btn blue", text: "Message", onclick: () => messageFriend(f) }),
      el("button", { class: "btn", text: "Remove", onclick: () => store.removeFriend(f.uid) }),
    ]));
  }
}
async function messageFriend(f) {
  $("#friendsOverlay").classList.remove("show"); friendsOpen = false;
  const existing = convs.find(c => c.type === "dm" && c.members.some(m => m.uid === f.uid));
  if (existing) return openConv(existing.id);
  try { const id = await store.createConversation({ type: "dm", handles: [f.username] }); setTimeout(() => openConv(id), 150); }
  catch (e) { alert(e.message || "Couldn’t start that chat."); }
}
function buildSwatches(container, map, current, kind) {
  container.innerHTML = "";
  for (const [name, val] of Object.entries(map)) {
    const bg = kind === "accent" ? `linear-gradient(${val[0]}, ${val[2]})` : val;
    const sw = el("div", { class: "swatch" + (name === current ? " sel" : ""), title: name, style: `background:${bg}` });
    sw.onclick = () => {
      if (kind === "accent") { prefs.accent = name; prefSet("accent", name); }
      else { prefs.wall = name; prefSet("wall", name); }
      applyPrefs();
      container.querySelectorAll(".swatch").forEach(s => s.classList.remove("sel"));
      sw.classList.add("sel");
    };
    container.append(sw);
  }
}
function buildSegmented(container, options, current, onPick) {
  container.innerHTML = "";
  for (const opt of options) {
    const b = el("button", { text: opt, class: opt === current ? "sel" : "" });
    b.onclick = () => { container.querySelectorAll("button").forEach(x => x.classList.remove("sel")); b.classList.add("sel"); onPick(opt); };
    container.append(b);
  }
}
function openSettings() {
  const u = store.me();
  $("#settingsWho").textContent = u.username ? "@" + u.username : "Demo user";
  settingsPhoto = undefined;
  drawPfpPreview();
  const presets = $("#setPfpPresets"); presets.innerHTML = "";
  for (const p of PRESETS) {
    const [, emoji, color] = p.split(":");
    const choice = el("div", { class: "avatar sm emoji pfp-choice" });
    choice.style.background = PFP_COLORS[color]; choice.textContent = emoji;
    choice.onclick = () => { settingsPhoto = p; drawPfpPreview(); clearPfpSel(); choice.classList.add("sel"); };
    presets.append(choice);
  }
  $("#setName").value = u.name || "";
  $("#setEmail").value = u.email || "";
  buildSwatches($("#setAccent"), ACCENTS, prefs.accent, "accent");
  buildSwatches($("#setWall"), WALLS, prefs.wall, "wall");
  buildSegmented($("#setSize"), ["Small", "Medium", "Large"], prefs.size, v => { prefs.size = v; prefSet("size", v); applyPrefs(); });
  const PACKS = { MSN: "msn", Classic: "classic", Aero: "aero" };
  const buildPacks = () => buildSegmented($("#setPack"), Object.keys(PACKS),
    Object.keys(PACKS).find(k => PACKS[k] === sfx.getPack()) || "MSN", v => sfx.setPack(PACKS[v]));
  buildPacks();
  // switching style also switches to its matching sound pack (can be changed after)
  buildSegmented($("#setTheme"), ["Skeuomorphic", "Aero"], prefs.theme === "aero" ? "Aero" : "Skeuomorphic", v => {
    prefs.theme = v === "Aero" ? "aero" : "skeuo"; prefSet("theme", prefs.theme); applyPrefs();
    if (prefs.theme === "aero" && sfx.getPack() !== "aero") sfx.setPack("aero");
    if (prefs.theme === "skeuo" && sfx.getPack() === "aero") sfx.setPack("msn");
    buildPacks();
  });
  const enter = $("#setEnter"); enter.checked = prefs.enter;
  enter.onchange = () => { prefs.enter = enter.checked; prefSet("enter", enter.checked ? "1" : "0"); };
  const rec = $("#setReceipts"); rec.checked = prefs.receipts;
  rec.onchange = () => { prefs.receipts = rec.checked; prefSet("receipts", rec.checked ? "1" : "0"); if (activeId) openConv(activeId); };
  const snd = $("#setSound"); snd.checked = sfx.soundEnabled();
  snd.onchange = () => sfx.setSoundEnabled(snd.checked);
  const ntf = $("#setNotify");
  ntf.checked = prefs.notify && typeof Notification !== "undefined" && Notification.permission === "granted";
  ntf.onchange = async () => {
    if (ntf.checked) {
      if (typeof Notification === "undefined") { $("#setErr").textContent = "This browser doesn’t support notifications."; $("#setErr").style.color = ""; ntf.checked = false; return; }
      let perm = Notification.permission;
      if (perm === "default") perm = await Notification.requestPermission();
      if (perm !== "granted") { ntf.checked = false; prefs.notify = false; prefSet("notify", "0"); $("#setErr").textContent = "Notifications are blocked in your browser settings."; $("#setErr").style.color = ""; return; }
    }
    prefs.notify = ntf.checked; prefSet("notify", ntf.checked ? "1" : "0");
    if (ntf.checked) { try { const n = new Notification("Lustre", { body: "Notifications are on." }); setTimeout(() => n.close(), 4000); } catch {} }
  };
  $("#pwArea").classList.add("hidden"); $("#pwNew").value = "";
  $("#setErr").textContent = ""; $("#setErr").style.color = "";
  $("#setMode").textContent = DEMO ? "Demo mode — profile changes are local only." : "Signed in with Firebase.";
  $("#settingsOverlay").classList.add("show");
}

/* =====================================================================
   UTIL
   ===================================================================== */
function friendlyAuthError(e) {
  const code = e?.code || "";
  if (code.includes("email-already-in-use")) return "That username is already taken.";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found"))
    return "Wrong username or password.";
  if (code.includes("too-many-requests")) return "Too many attempts — please wait a moment.";
  if (code.includes("weak-password")) return "Password must be at least 6 characters.";
  if (code.includes("network")) return "Network error — check your connection.";
  return (e?.message || String(e)).replace("Firebase:", "").replace(/\s*\(auth[^)]*\)/, "").trim();
}

function autoGrow(ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 96) + "px"; }
function scrollBottom(c) { requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; }); }

// leaving a chat / tab should clear "I'm here"
window.addEventListener("beforeunload", () => { if (activeId) store.setViewing(activeId, false); });
document.addEventListener("visibilitychange", () => {
  if (activeId) store.setViewing(activeId, !document.hidden);
  if (activeId && !document.hidden) store.openConversation(activeId);   // back on the tab → clear its dot
});
