/**
 * API Key management.
 *
 * Keys look like `sk_pz_<random>`; only the SHA-256 hash is stored in KV.
 * Management endpoints require the ADMIN_TOKEN secret (Bearer / X-Admin-Key).
 * Usage counters persist at most once per 60s per key to preserve KV write quota.
 */

import { json, err, readJson, extractBearer, randomToken, sha256Hex, requireKv } from "./shared.js";

const KEY_PREFIX = "sk_pz_";
const MAX_KEYS = 50;
const USAGE_WRITE_MIN_MS = 60 * 1000;

function adminToken(env) {
  return String(env?.ADMIN_TOKEN || "").trim();
}

async function adminOk(env, request) {
  const t = adminToken(env);
  if (!t) return false;
  const h = request.headers.get("Authorization") || request.headers.get("X-Admin-Key") || "";
  const provided = h.replace(/^Bearer\s+/i, "").trim();
  if (!provided) return false;
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(t);
  if (a.length !== b.length) return false;
  try {
    return crypto.subtle.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function adminGate(env, request) {
  if (await adminOk(env, request)) return null;
  if (!adminToken(env)) {
    return err("Admin not configured — set the ADMIN_TOKEN secret via `wrangler secret put ADMIN_TOKEN`", 503);
  }
  return err("Admin required — send `Authorization: Bearer <ADMIN_TOKEN>` or `X-Admin-Key: <ADMIN_TOKEN>`", 401);
}

async function indexKeys(kv) {
  try {
    const raw = await kv.get("keys:all");
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function readKey(kv, hash) {
  const raw = await kv.get(`key:${hash}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function publicView(rec) {
  return {
    id: rec.id,
    name: rec.name,
    prefix: rec.prefix,
    scopes: rec.scopes || ["*"],
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt || null,
    revokedAt: rec.revokedAt || null,
    usage: rec.usage || { total: 0, images: 0, videos: 0 },
  };
}

export async function apiKeysList(context) {
  const gate = await adminGate(context.env, context.request);
  if (gate) return gate;
  const kv = requireKv(context.env);
  const hashes = await indexKeys(kv);
  const keys = [];
  for (const h of hashes) {
    const rec = await readKey(kv, h);
    if (rec && !rec.revokedAt) keys.push(publicView(rec));
  }
  keys.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json({ ok: true, count: keys.length, keys });
}

export async function apiKeysCreate(context) {
  const gate = await adminGate(context.env, context.request);
  if (gate) return gate;
  const body = await readJson(context.request);
  const kv = requireKv(context.env);

  const hashes = await indexKeys(kv);
  const active = [];
  for (const h of hashes) {
    const rec = await readKey(kv, h);
    if (rec && !rec.revokedAt) active.push(rec);
  }
  if (active.length >= MAX_KEYS) {
    return err(`最多 ${MAX_KEYS} 組 API Key，請先撤銷舊的`, 400);
  }

  const name = String(body.name || body.label || "default").trim().slice(0, 64) || "default";
  let scopes = body.scopes;
  if (typeof scopes === "string") {
    scopes = scopes.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(scopes) || !scopes.length) scopes = ["generate", "models"];

  const apiKey = KEY_PREFIX + randomToken(22);
  const keyHash = await sha256Hex(apiKey);
  const id = `key_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const rec = {
    id,
    name,
    scopes,
    prefix: apiKey.slice(0, 12),
    createdAt: Date.now(),
    lastUsedAt: null,
    revokedAt: null,
    usage: { total: 0, images: 0, videos: 0 },
  };
  await kv.put(`key:${keyHash}`, JSON.stringify(rec));
  hashes.push(keyHash);
  await kv.put("keys:all", JSON.stringify(hashes));

  return json(
    {
      ok: true,
      key: { ...publicView(rec), apiKey, warning: "請立即複製保存，之後無法再查看完整 key" },
    },
    201
  );
}

export async function apiKeysRevoke(context) {
  const gate = await adminGate(context.env, context.request);
  if (gate) return gate;
  const id = String(context.params?.id || "").trim();
  if (!id) return err("缺少 key id", 400);
  const kv = requireKv(context.env);

  const hashes = await indexKeys(kv);
  let found = null;
  let foundHash = null;
  for (const h of hashes) {
    const rec = await readKey(kv, h);
    if (rec?.id === id && !rec.revokedAt) {
      found = rec;
      foundHash = h;
      break;
    }
  }
  if (!found) return err("API Key 不存在或已撤銷", 404);

  found.revokedAt = Date.now();
  await kv.put(`key:${foundHash}`, JSON.stringify(found));
  return json({ ok: true, key: publicView(found) });
}

/**
 * Resolve a raw API key → { keyId, name, scopes, usage } or throw.
 */
export async function resolveApiKey(env, rawKey) {
  const kv = requireKv(env);
  const key = String(rawKey || "").trim();
  if (!key.startsWith(KEY_PREFIX)) {
    const e = new Error("Invalid API Key");
    e.status = 401;
    e.code = "UNAUTHORIZED";
    throw e;
  }
  const keyHash = await sha256Hex(key);
  const rec = await readKey(kv, keyHash);
  if (!rec) {
    const e = new Error("Invalid API Key");
    e.status = 401;
    e.code = "UNAUTHORIZED";
    throw e;
  }
  if (rec.revokedAt) {
    const e = new Error("API Key has been revoked");
    e.status = 403;
    e.code = "FORBIDDEN";
    throw e;
  }

  // touch lastUsedAt + usage at most once per minute (KV write quota)
  const now = Date.now();
  const prev = Number(rec.lastUsedAt) || 0;
  if (!prev || now - prev >= USAGE_WRITE_MIN_MS) {
    rec.lastUsedAt = now;
    try {
      await kv.put(`key:${keyHash}`, JSON.stringify(rec));
    } catch {
      /* ignore */
    }
  }
  return {
    keyId: rec.id,
    name: rec.name,
    scopes: rec.scopes || ["*"],
    usage: rec.usage || { total: 0, images: 0, videos: 0 },
    keyHash,
    raw: rec,
  };
}

/** Increment usage counters (throttled KV write; fail-open). */
export async function trackUsage(env, subject, { bucket = "images" } = {}) {
  try {
    const kv = requireKv(env);
    if (subject === "anon") return;
    const keyHash = subject; // subject is key hash when keyed
    const rec = await readKey(kv, keyHash);
    if (!rec) return;
    const now = Date.now();
    if (now - (Number(rec.lastUsageWrite) || 0) < USAGE_WRITE_MIN_MS) return;
    rec.lastUsageWrite = now;
    rec.usage = rec.usage || { total: 0, images: 0, videos: 0 };
    rec.usage.total += 1;
    rec.usage[bucket] = (rec.usage[bucket] || 0) + 1;
    await kv.put(`key:${keyHash}`, JSON.stringify(rec));
  } catch {
    /* fail open */
  }
}
