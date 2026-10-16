/**
 * Prezzy Studio — Cloudflare Worker entry.
 * Routes: static assets (public/) + OpenAI-compatible API + admin key management.
 * build: 2026-08-06-v1
 */

import { json, err, corsPreflight } from "./shared.js";
import {
  openaiModels,
  openaiImagesGenerations,
  openaiVideosGenerations,
  openaiJob,
} from "./routes-openai.js";
import { apiKeysList, apiKeysCreate, apiKeysRevoke } from "./routes-keys.js";
import { proxyMedia } from "./routes-media.js";

const BUILD = "2026-08-06-v1";

function ctx(request, env, executionCtx, params = {}) {
  return { request, env, waitUntil: executionCtx?.waitUntil?.bind(executionCtx), params };
}

function match(path, pattern) {
  const pp = pattern.split("/").filter(Boolean);
  const sp = path.split("/").filter(Boolean);
  if (pp.length !== sp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(sp[i]);
    else if (pp[i] !== sp[i]) return null;
  }
  return params;
}

async function handleApi(request, env, executionCtx) {
  const url = new URL(request.url);
  let path = url.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const method = request.method.toUpperCase();
  const base = ctx(request, env, executionCtx);

  if (method === "OPTIONS" && (path.startsWith("/v1") || path.startsWith("/api"))) {
    return corsPreflight();
  }

  // --- Media proxy ---
  if (method === "GET" && path === "/v1/media") return proxyMedia(base);

  // --- OpenAI-compatible public API ---
  if (method === "GET" && path === "/v1/models") return openaiModels(base);
  if (method === "POST" && path === "/v1/images/generations") return openaiImagesGenerations(base);
  if (method === "POST" && path === "/v1/videos/generations") return openaiVideosGenerations(base);

  let params = match(path, "/v1/jobs/:id");
  if (params && method === "GET") return openaiJob({ ...base, params });
  params = match(path, "/v1/videos/:id");
  if (params && method === "GET") return openaiJob({ ...base, params });

  // --- Admin: API key management ---
  if (method === "GET" && path === "/api/keys") return apiKeysList(base);
  if (method === "POST" && path === "/api/keys") return apiKeysCreate(base);
  params = match(path, "/api/keys/:id");
  if (params && method === "DELETE") return apiKeysRevoke({ ...base, params });

  return err(`API not found: ${method} ${path}`, 404);
}

export default {
  async fetch(request, env, executionCtx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/__version") {
      return json({
        ok: true,
        build: BUILD,
        runtime: "cloudflare-worker",
        name: "prezzy-studio",
        features: ["openai-images", "openai-videos", "api-keys", "anon-mode"],
        anon_allowed: String(env?.ANON_ALLOWED ?? "true") !== "false",
        admin_configured: !!String(env?.ADMIN_TOKEN || "").trim(),
      });
    }

    if (path === "/api" || path.startsWith("/api/") || path === "/v1" || path.startsWith("/v1/")) {
      try {
        return await handleApi(request, env, executionCtx);
      } catch (e) {
        return json({ ok: false, error: e.message || String(e) }, 500);
      }
    }

    // Static assets (public/)
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
