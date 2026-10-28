/* =========================================================================
   giphy.js — GIF search, powered by GIPHY
   -------------------------------------------------------------------------
   Paste your GIPHY API key below to turn on the GIF button.
   Get one free: developers.giphy.com → Create an App → API → copy the key.
   (Like the Firebase config, this key is meant to live in the web page.)
   Until it's filled in, the GIF button stays hidden.
   ========================================================================= */

export const GIPHY_API_KEY = "";

export const giphyReady = () => !!GIPHY_API_KEY;

const BASE = "https://api.giphy.com/v1/gifs";

async function call(path, params) {
  const qs = new URLSearchParams({ api_key: GIPHY_API_KEY, rating: "pg-13", limit: "24", bundle: "messaging_non_clips", ...params });
  const res = await fetch(`${BASE}/${path}?${qs}`);
  if (!res.ok) throw new Error(res.status === 429 ? "GIPHY is busy — try again in a bit." : "Couldn’t load GIFs.");
  const { data } = await res.json();
  return data.map(g => {
    const img = g.images.fixed_height, small = g.images.fixed_width_small || g.images.fixed_width || img;
    return { id: g.id, title: g.title || "GIF", preview: small.url, url: img.url, w: +img.width || 200, h: +img.height || 200 };
  });
}
export const trendingGifs = (offset = 0) => call("trending", { offset: String(offset) });
export const searchGifs = (q, offset = 0) => call("search", { q, offset: String(offset), lang: "en" });

// only ever show GIFs from GIPHY's own CDN (a message's GIF link comes from another user)
export function isGiphyUrl(url) {
  try { const u = new URL(url); return u.protocol === "https:" && /(^|\.)giphy\.com$/.test(u.hostname); }
  catch { return false; }
}
