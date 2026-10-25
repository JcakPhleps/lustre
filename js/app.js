/* =========================================================================
   app.js — UI controller
   ========================================================================= */
import { store, DEMO } from "./store.js";
import { recordVoice, renderWave, fmtDur } from "./audio.js";
import { CallManager } from "./calls.js";
import * as sfx from "./sfx.js";

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

/* =====================================================================
   APP STATE
   ===================================================================== */
let convs = [];
let activeId = null;
let msgUnsub = null, presUnsub = null;
let callWatchers = new Map();   // conv id -> unsub (incoming-call listeners)
let convSeen = null;   // conv id -> last seen lastTs (for background receive sounds)
let friendRequests = [], friends = [], friendsOpen = false, friendsBadgeEl = null, friendSubs = [];
const calls = new CallManager(store);

/* =====================================================================
   BOOT
   ===================================================================== */
await store.init();
store.onAuth(user => { user ? renderApp(user) : renderAuth(); });

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

  const submit = el("button", { class: "btn blue", text: "Sign In" });
  const toggle = el("span", { class: "link", text: "Create one" });

  const card = el("div", { class: "card" }, [
    el("h1", {}, ["Lustre", el("span", { class: "indev", text: "indev" })]),
    el("div", { class: "tag", text: "stay in touch — with a little shine" }),
    el("label", { text: "Username" }), username,
    el("label", { text: "Password" }), pass,
    emailWrap,
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
    submit.disabled = true;
    try {
      if (mode === "in") await store.signIn(uname, pass.value);
      else await store.signUp(uname, pass.value, email.value.trim());
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

  screen.innerHTML = "";
  screen.append(el("div", { class: "center" }, [el("div", {}, [card, ...extras])]));
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
  const settingsBtn = el("button", { class: "btn", text: "Settings", onclick: openAccount });
  const sidebar = el("div", { class: "sidebar pinstripe" }, [
    el("div", { class: "brand" }, [
      el("span", { class: "spark" }),
      el("span", { class: "wordmark" }, ["Lustre", el("span", { class: "indev", text: "indev" })]),
    ]),
    el("div", { class: "sidebar-actions" }, [newChatBtn, friendsBtn, settingsBtn]),
    el("div", { class: "search" }, [search]),
    convList,
  ]);

  const chat = el("div", { class: "chat" }, [
    el("div", { class: "center", html: "<div style='color:#6c6660;text-shadow:0 1px 0 rgba(255,255,255,.5)'>Pick a conversation, or start a new one.</div>" }),
  ]);

  const body = el("div", { class: "body" }, [sidebar, chat]);
  screen.innerHTML = ""; screen.append(body);

  // keep references
  renderApp._els = { convList, chat, body, search };

  store.onConversations(list => {
    // play "receive" when a non-active chat gets a new incoming message
    if (convSeen) {
      for (const c of list) {
        const prev = convSeen.get(c.id);
        if (prev !== undefined && c.lastTs > prev && c.id !== activeId
            && c.lastFrom && c.lastFrom !== store.me().uid) sfx.playReceive();
      }
    } else convSeen = new Map();
    for (const c of list) convSeen.set(c.id, c.lastTs);
    convs = list; paintConvList();
    // watch every conversation for incoming calls
    const ids = new Set(list.map(c => c.id));
    for (const [cid, un] of callWatchers) if (!ids.has(cid)) { try { un(); } catch {} callWatchers.delete(cid); }
    for (const c of list) if (!callWatchers.has(c.id)) callWatchers.set(c.id, calls.listenIncoming(c, onIncomingCall, onCallCancel));
    if (location.hash === "#demo" && !activeId && convs.length) openConv(convs[0].id);
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
    const av = el("div", { class: "avatar" + (c.online ? " online" : ""), text: c.avatarText },
      [el("span", { class: "dot" })]);
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
    if (c.unread > 0) row.append(el("div", { class: "badge", text: String(c.unread) }));
    convList.append(row);
  }
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
      onclick: () => { renderApp._els.body.classList.remove("show-chat"); store.setViewing(id, false); } }),
    el("div", { class: "avatar sm" + (conv.online ? " online" : ""), text: conv.avatarText }, [el("span", { class: "dot" })]),
    el("div", { class: "who" }, [el("div", { class: "name", text: conv.name }), status]),
    el("button", { class: "btn", text: "Call", onclick: () => startCall(conv, false) }),
    el("button", { class: "btn", text: "Video", onclick: () => startCall(conv, true) }),
  ]);

  /* ---- messages ---- */
  const messages = el("div", { class: "messages linen" });

  /* ---- composer ---- */
  const ta = el("textarea", { rows: 1, placeholder: "Message", oninput: onType });
  const photoBtn = el("button", { class: "btn", text: "Photo", onclick: () => $("#imgInput").click() });
  const voiceBtn = el("button", { class: "btn", text: "Voice", onclick: toggleVoice });
  const sendBtn = el("button", { class: "btn green", text: "Send", onclick: sendText });
  const composer = el("div", { class: "composer metal" }, [
    photoBtn,
    el("div", { class: "field" }, [ta]),
    voiceBtn,
    sendBtn,
  ]);

  chat.append(head, messages, composer);
  autoGrow(ta);

  /* ---- live state + render pipeline ---- */
  let lastMsgs = [];
  let lastPres = { viewing: [], typing: [], reads: {} };
  let seenIds = null;
  let prevRead = false, prevViewing = false, prevTyping = false, presInit = false;

  const readTs = () => conv.members.reduce((mx, m) => Math.max(mx, lastPres.reads?.[m.uid] || 0), 0);
  const otherViewing = () => (lastPres.viewing || []).length > 0;

  function render() {
    paintMessages(messages, lastMsgs, conv, { readTs: readTs(), otherViewing: otherViewing() });
    paintTyping(messages, conv, lastPres);
    updateStatus(status, conv, lastPres);
  }
  function checkReadSound() {
    const lastMine = [...lastMsgs].reverse().find(m => m.mine);
    const read = conv.type === "dm" && !!lastMine && (otherViewing() || readTs() >= lastMine.ts);
    if (read && !prevRead) sfx.playRead();
    prevRead = read;
  }

  msgUnsub = store.onMessages(id, list => {
    lastMsgs = list;
    render();
    store.setViewing(id, true);   // refresh our "seen" time so the sender gets a Read
    if (seenIds === null) { seenIds = new Set(list.map(m => m.id)); }
    else {
      let gotIncoming = false;
      for (const m of list) if (!seenIds.has(m.id)) { seenIds.add(m.id); if (!m.mine) gotIncoming = true; }
      if (gotIncoming) sfx.playReceive();
    }
    checkReadSound();
  });

  presUnsub = store.onConvPresence(id, pres => {
    lastPres = pres;
    render();
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
    store.sendMessage(id, { text }); sfx.playSend();
    ta.value = ""; autoGrow(ta); store.setTyping(id, false);
  }
  ta.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
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

/* paint all messages with day-stamps, grouping, avatars, receipts */
function paintMessages(container, list, conv, readInfo = {}) {
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  container.querySelectorAll(".msg,.daystamp,.typingrow,.receipt").forEach(n => n.remove());
  let lastDay = null;
  const sorted = [...list].sort((a, b) => a.ts - b.ts);
  sorted.forEach((m, i) => {
    const day = fmtDay(m.ts);
    if (day !== lastDay) { container.append(el("div", { class: "daystamp", text: day })); lastDay = day; }
    container.append(msgNode(m, conv, sorted[i - 1]));
  });
  // read receipt (DMs only) — read if they're here now or last saw us after this message
  if (conv.type === "dm") {
    const lastMine = [...sorted].reverse().find(m => m.mine);
    if (lastMine) {
      const read = !!readInfo.otherViewing || (readInfo.readTs || 0) >= lastMine.ts;
      container.append(el("div", { class: "receipt", text: read ? "Read " + fmtTime(lastMine.ts) : "Delivered" }));
    }
  }
  if (atBottom) scrollBottom(container);
}

function msgNode(m, conv, prev) {
  const sameSender = prev && prev.from.uid === m.from.uid && (m.ts - prev.ts < 120000);
  const stack = el("div", { class: "stack" });

  if (conv.type === "group" && !m.mine && !sameSender)
    stack.append(el("div", { class: "sender", text: m.from.name }));

  let bubble;
  if (m.image) {
    bubble = el("div", { class: "bubble media " + (m.mine ? "me" : "them") },
      [el("img", { src: m.image, onclick: () => window.open(m.image) })]);
  } else if (m.audio) {
    bubble = el("div", { class: "bubble " + (m.mine ? "me" : "them") }, [voiceNode(m.audio)]);
  } else {
    bubble = el("div", { class: "bubble " + (m.mine ? "me" : "them"), text: m.text });
  }
  stack.append(bubble);

  const row = el("div", { class: "msg" + (m.mine ? " mine" : "") });
  if (conv.type === "group" && !m.mine)
    row.append(el("div", { class: "avatar sm", text: (m.from.name || "?").slice(0, 2).toUpperCase() }));
  row.append(stack);
  return row;
}

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
});
calls.onEnd(() => { callStage.classList.remove("show"); callGrid.innerHTML = ""; });

async function startCall(conv, video) {
  callGrid.innerHTML = "";
  callStage.classList.add("show");
  try { await calls.start(conv, { video }); }
  catch (e) { alert("Couldn’t start call: " + (e.message || e)); calls.hangup(); }
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
}
function onCallCancel(conv) {
  if (incomingInfo && incomingInfo.conv.id === conv.id) {
    incomingInfo = null;
    $("#incomingOverlay").classList.remove("show");
  }
}
$("#incomingAccept").onclick = async () => {
  $("#incomingOverlay").classList.remove("show");
  if (!incomingInfo) return;
  const { conv, info } = incomingInfo; incomingInfo = null;
  callStage.classList.add("show"); callGrid.innerHTML = "";
  try { await calls.accept(conv, info); }
  catch (e) { alert("Couldn’t join call: " + (e.message || e)); calls.hangup(); }
};
$("#incomingDecline").onclick = () => {
  $("#incomingOverlay").classList.remove("show");
  if (incomingInfo) calls.decline(incomingInfo.conv);
  incomingInfo = null;
};

/* =====================================================================
   CHROME (title-bar buttons + modals)
   ===================================================================== */
function wireChrome() {
  // new chat modal
  $("#newChatCancel").onclick = () => $("#newChatOverlay").classList.remove("show");
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

  // account modal
  $("#accountSignout").onclick = () => { $("#accountOverlay").classList.remove("show"); store.signOut(); };
  $("#accountSave").onclick = async () => {
    try { await store.updateProfile({ name: $("#accountName").value.trim() }); $("#accountOverlay").classList.remove("show"); }
    catch (e) { $("#accountErr").textContent = e.message || String(e); }
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
  $("#friendAdd").addEventListener("keydown", e => e.key === "Enter" && addFriend());
  $("#friendsClose").onclick = () => { $("#friendsOverlay").classList.remove("show"); friendsOpen = false; };

  [$("#newChatOverlay"), $("#accountOverlay"), $("#friendsOverlay")].forEach(o =>
    o.addEventListener("click", e => { if (e.target === o) { o.classList.remove("show"); friendsOpen = false; } }));
}

/* ---- friends ---- */
function openFriends() {
  friendsOpen = true;
  $("#friendErr").textContent = "";
  renderFriendLists();
  $("#friendsOverlay").classList.add("show");
}
function updateFriendsBadge() {
  if (!friendsBadgeEl) return;
  const n = friendRequests.length;
  friendsBadgeEl.textContent = n ? String(n) : "";
  friendsBadgeEl.classList.toggle("hidden", !n);
}
function friendRow(p, actions) {
  return el("div", { class: "friend-row" }, [
    el("div", { class: "avatar sm", text: (p.name || p.username || "?").slice(0, 2).toUpperCase() }),
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
function openAccount() {
  const u = store.me();
  $("#accountWho").textContent = (u.username ? "@" + u.username : "Demo user") + (u.email ? "  ·  " + u.email : "");
  $("#accountName").value = u.name || "";
  const snd = $("#accountSound");
  snd.checked = sfx.soundEnabled();
  snd.onchange = () => sfx.setSoundEnabled(snd.checked);
  $("#accountErr").textContent = "";
  $("#accountMode").textContent = DEMO ? "Demo mode — changes are local only." : "Signed in with Firebase.";
  $("#accountOverlay").classList.add("show");
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
});
