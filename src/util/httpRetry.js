import fetch from "node-fetch";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

// Thin wrapper around node-fetch: retries only on HTTP 429, honoring
// Retry-After when present, otherwise exponential backoff from 1s.
// Non-429 responses (including other error statuses) are returned as-is —
// callers keep their existing res.ok / res.json() handling unchanged.
export async function fetchWithRetry(url, opts = {}, { retries = MAX_RETRIES, label = url } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, opts);
    if (res.status !== 429 || attempt >= retries) return res;

    const delay = parseRetryAfter(res.headers.get("retry-after")) ?? BASE_DELAY_MS * 2 ** attempt;
    console.warn(`429 from ${label}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${retries})`);
    await sleep(delay);
  }
}
