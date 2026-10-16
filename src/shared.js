/**
 * Shared helpers for Prezzy Studio Worker.
 * - JSON response helpers
 * - API key generation / hashing
 * - Rate limiting via Cache API (no KV write quota)
 * - CORS preflight
 */

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
  "Access-Control-Max-Age": "86400",
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

export function err(message, status = 400, extra = {}) {
  return json({ ok: false, error: String(message || "error"), ...extra }, status);
}

/** OpenAI-shaped error body (what OpenAI SDKs expect). */
export function openaiError(message, { status = 400, type = "invalid_request_error", code = null, param = null, extra = {} } = {}) {
  return json(
    {
      error: {
        message: String(message || "error"),
        type,
        param,
        code,
      },
      ...extra,
    },
    status
  );
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function uuid() {
  return crypto.randomUUID();
}

const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export function randomToken(len = 22) {
  let out = "";
  const arr = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) out += CHARS[arr[i] % CHARS.length];
  return out;
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function requireKv(env) {
  if (!env?.KEYS) {
    const e = new Error("KEYS KV binding is not configured");
    e.status = 500;
    throw e;
  }
  return env.KEYS;
}

/** Extract Bearer token from Authorization header. */
export function extractBearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Rate limit via Cache API — does NOT consume KV write quota.
 * Fail-open when cache is unavailable. Returns true if allowed.
 */
export async function checkRateLimit(env, subject, { bucket = "all", limit = 60, windowSec = 60 } = {}) {
  try {
    const slot = Math.floor(Date.now() / (windowSec * 1000));
    const cacheKey = new Request(
      `https://pz-rl.internal/rl/${encodeURIComponent(String(subject))}/${encodeURIComponent(String(bucket))}/${slot}`
    );
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    let cur = 0;
    if (hit) cur = Number(await hit.text()) || 0;
    if (cur >= limit) return false;
    const res = new Response(String(cur + 1), {
      headers: {
        "Cache-Control": `max-age=${Math.max(60, windowSec * 2)}`,
        "Content-Type": "text/plain",
      },
    });
    await cache.put(cacheKey, res);
    return true;
  } catch {
    return true; // fail open
  }
}

export function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** URL-encode a prompt for Prezzy query strings. */
export function enc(value) {
  return encodeURIComponent(String(value ?? ""));
}

export function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString() : "—";
}
