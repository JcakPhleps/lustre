# Lustre

A chat-first social app wearing a **2012 skeuomorphic skin** — iOS 6 / OS X
Mountain Lion *Messages* with a splash of early-Facebook: linen, brushed metal,
glossy gradient bubbles with tails, letterpressed labels, aqua buttons.

> Restarted from the old *Fig Messenger* prototype. Same era, fresh build.

## Run it (demo mode)

No backend needed to see the look — it ships with an interactive offline demo
(sample conversations, simulated replies, live typing / read-receipts / "here").

```bash
cd ~/lustre
python3 -m http.server 8777
# then open http://localhost:8777
#   • http://localhost:8777/#demo  → jump straight into the sample chats
```

(It must be served over HTTP, not opened as a `file://` — ES modules need it.)

## What's in indev 1

| Feature | Status |
|---|---|
| 2012 skeuomorphic UI (linen, metal, glossy bubbles) | ✅ |
| Direct messages | ✅ |
| Group chats (sender names + avatars) | ✅ |
| Image attachments | ✅ |
| Voice messages (record + waveform + playback) | ✅ |
| Read receipts (Delivered / Read) | ✅ |
| **"I'm here"** indicator (other person viewing the chat) | ✅ |
| Typing indicator | ✅ |
| Video / voice calls (1:1) | ✅ WebRTC, needs Firebase |
| Group video calls | ◧ mesh wired, needs real testing |

Demo mode simulates presence/replies locally. The call stage opens with your own
camera in demo mode so you can see the UI; real peer connections need Firebase.

## Wiring Firebase (later)

1. Create a Firebase project → add a **Web app** → copy the config.
2. Paste it into `js/firebase-config.js`. The app flips from demo to live
   automatically (real Auth + Firestore + Storage).
3. Enable **Email/Password** auth, **Firestore**, and **Storage** in the console.
4. Deploy rules + indexes:
   ```bash
   firebase deploy --only firestore:rules,firestore:indexes,storage
   ```
5. (Optional) Host it: `firebase deploy --only hosting`.

## Architecture

```
index.html          shell: title bar, modals, call stage
css/style.css       the entire 2012 design system (pure CSS textures, no assets)
js/firebase-config  paste config here; empty = demo mode
js/store.js         data layer — MockStore (demo) | FirebaseStore (live), one interface
js/app.js           UI controller: screens, rendering, presence, receipts
js/audio.js         voice message record / waveform / playback
js/calls.js         WebRTC calls + Firestore signalling
```

The UI only ever talks to `store`, so swapping demo ↔ Firebase never touches the UI.
