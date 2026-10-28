/* =========================================================================
   changelog.js — the single source of truth for the version + history.
   Add a new entry at the TOP; VERSION (shown everywhere) updates itself.
   Run `node scripts/gen-changelog.mjs` to refresh the repo's CHANGELOG.md.
   ========================================================================= */

export const CHANGELOG = [
  { version: "Beta 2.2", date: "2026-10-28", changes: [
    "Send GIFs — tap GIF next to Photo (powered by GIPHY)",
    "Much lighter on the server — typing, read receipts, and online status check in far less often",
    "Removed the “x active” counter",
    "Chats open with your latest 50 messages",
  ]},
  { version: "Beta 2.1", date: "2026-10-28", changes: [
    "Profile cards — tap someone’s picture or name to see their bio, @username, and whether they’re online",
    "Settings → Profile: write a bio, change your username (once a week) and display name (3 times a week)",
    "Edit and unsend now work for 5 minutes after sending",
    "Unsending a message pops it with a little burst ✨",
  ]},
  { version: "Beta 2", date: "2026-10-28", changes: [
    "Aero mode — a Windows 7 Aero look with frosted glass over a glowing blue light-streak background (Settings → Appearance → Style)",
    "Aero sound pack — water-drop bloops and glassy chimes",
  ]},
  { version: "v1.3", date: "2026-10-28", changes: [
    "Name suggestions pop up as you type in New Message and Add Friend",
  ]},
  { version: "v1.2", date: "2026-10-27", changes: [
    "Edit and unsend your messages — right-click, long-press, or the ⋯ button",
    "Tap a photo to view it full-size (and save it)",
    "Blue new-message dot now shows up reliably",
    "Message box fits on small phone screens",
  ]},
  { version: "v1.1", date: "2026-10-26", changes: [
    "End-to-end encryption for all messages, media, and previews",
    "Profile pictures — built-in presets and custom uploads",
    "Friend suggestions (people you may know, by mutual friends)",
    "Bigger Settings: accent colors, chat wallpapers, text size, sound packs",
    "Call ringtone, no-answer timeout, and hang-up that ends for both sides",
    "Desktop notifications for messages and calls",
    "Live “x active” counter and a blue new-message indicator",
    "Birthday + Terms/Privacy agreement at signup",
    "This changelog",
  ]},
  { version: "v1.0", date: "2026-10-24", changes: [
    "First release of Lustre",
    "Direct messages, group chats, image and voice messages",
    "Username / password accounts and a friends system",
    "Read receipts, typing, and “here” presence",
    "WebRTC voice and video calls",
    "2012 skeuomorphic design (iMessage / Mountain Lion era)",
  ]},
];

export const VERSION = CHANGELOG[0].version;   // auto-derived current version
// what the version badge says: "beta 2" (or "beta v1.3" for the older v-style names)
export const VERSION_LABEL = /^beta/i.test(VERSION) ? VERSION.toLowerCase() : "beta " + VERSION;
