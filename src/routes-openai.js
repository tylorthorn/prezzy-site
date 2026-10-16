/**
 * OpenAI-compatible surface.
 *
 *   GET  /v1/models
 *   POST /v1/images/generations      (sync: submit + retry until URL is ready)
 *   POST /v1/videos/generations      (async: returns { id, status:"submitted" })
 *   GET  /v1/jobs/:id                (poll video / image job)
 *   GET  /v1/videos/:id              (alias of /v1/jobs/:id)
 *
 * Auth: Authorization: Bearer sk_pz_...  (or anonymous if ANON_ALLOWED=true)
 * Output shape matches OpenAI SDK expectations; extra `faa` field is additive.
 */

import { json, openaiError, readJson, extractBearer, uuid, checkRateLimit } from "./shared.js";
import { resolveApiKey, trackUsage } from "./routes-keys.js";
import {
  aiart,
  dalle,
  txt2img,
  videoSubmit,
  videoStatus,
  VIDEO_ENGINES,
} from "./upstream/prezzy.js";

/** OpenAI /v1/images/generations size → ratio + dimensions */
const SIZE_MAP = {
  "256x256": { aspect: "1:1", w: 256, h: 256 },
  "512x512": { aspect: "1:1", w: 512, h: 512 },
  "1024x1024": { aspect: "1:1", w: 1024, h: 1024 },
  "1792x1024": { aspect: "16:9", w: 1792, h: 1024 },
  "1024x1792": { aspect: "9:16", w: 1024, h: 1792 },
  "1536x1024": { aspect: "4:3", w: 1536, h: 1024 },
  "1024x1536": { aspect: "3:4", w: 1024, h: 1536 },
  "1344x768": { aspect: "16:9", w: 1344, h: 768 },
  "768x1344": { aspect: "9:16", w: 768, h: 1344 },
};

/** exposed catalog: id → upstream mapping */
export const MODEL_CATALOG = [
  { id: "flux-klein", name: "Flux 2 Klein", backend: "aiart", model: "Flux 2 Klein", type: "image", company: "Black Forest Labs" },
  { id: "flux-klein-fast", name: "Flux 2 Klein Fast", backend: "aiart", model: "Flux 2 Klein Fast", type: "image", company: "Black Forest Labs" },
  { id: "zimage", name: "ZImage", backend: "aiart", model: "ZImage", type: "image", company: "Alibaba" },
  { id: "general", name: "General", backend: "aiart", model: "General", type: "image", company: "Prezzy" },
  { id: "realistic", name: "Realistic", backend: "aiart", model: "Realistic", type: "image", company: "Prezzy" },
  { id: "realistic-6", name: "Realistic 6", backend: "aiart", model: "Realistic 6", type: "image", company: "Prezzy" },
  { id: "anime", name: "Anime", backend: "aiart", model: "Anime", type: "image", company: "Prezzy" },
  { id: "anime-2", name: "Anime 2", backend: "aiart", model: "Anime 2", type: "image", company: "Prezzy" },
  { id: "anime-25d", name: "Anime 2.5D", backend: "aiart", model: "Anime 2.5D", type: "image", company: "Prezzy" },
  { id: "anime-4", name: "Anime 4", backend: "aiart", model: "Anime 4", type: "image", company: "Prezzy" },
  { id: "guofeng", name: "GuoFeng", backend: "aiart", model: "GuoFeng", type: "image", company: "Prezzy" },
  { id: "disney-cartoon", name: "Disney Cartoon", backend: "aiart", model: "Disney Cartoon", type: "image", company: "Prezzy" },
  { id: "samaritan", name: "Samaritan", backend: "aiart", model: "Samaritan", type: "image", company: "Prezzy" },
  { id: "dall-e-3", name: "DALL-E 3 XL", backend: "dalle", model: null, type: "image", company: "OpenAI (LoRA)" },
  { id: "gpt-image-1", name: "GPT Image 1", backend: "aiart", model: "Flux 2 Klein", type: "image", company: "OpenAI-compatible" },
  { id: "dall-e-2", name: "DALL-E 2", backend: "txt2img", model: "flux", type: "image", company: "OpenAI-compatible" },
  { id: "nano-banana", name: "Nano Banana", backend: "txt2img", model: "nano-banana", type: "image", company: "Google-compatible" },
];

const MODEL_ALIASES = {
  "dall-e": "dall-e-2",
  "gpt-image": "gpt-image-1",
  "flux": "flux-klein",
  "flux-klein-fast": "flux-klein-fast",
  "wan": "wan-2-2",
  "hunyuan": "hunyuan-1-5",
  "ltx": "ltx-2",
  "ltx2": "ltx-2",
};

export function normalizeModelId(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "flux-klein";
  if (MODEL_ALIASES[s]) return MODEL_ALIASES[s];
  return s;
}

function findCatalog(id) {
  const norm = normalizeModelId(id);
  return MODEL_CATALOG.find((m) => m.id === norm);
}

function mapSize(size) {
  const key = String(size || "1024x1024").trim().toLowerCase();
  if (SIZE_MAP[key]) return { ...SIZE_MAP[key], size: key };
  const m = key.match(/^(\d+)\s*x\s*(\d+)$/i);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w > 0 && h > 0) {
      const r = w / h;
      let aspect = "1:1";
      if (r > 1.4) aspect = "16:9";
      else if (r < 1 / 1.4) aspect = "9:16";
      return { aspect, w, h, size: key };
    }
  }
  if (/^\d+:\d+$/.test(key)) return { aspect: key, w: 0, h: 0, size: key };
  return { aspect: "1:1", w: 1024, h: 1024, size: "1024x1024" };
}

async function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchMediaAsBase64(url) {
  const res = await fetch(url, { headers: { Accept: "image/*,*/*" } });
  if (!res.ok) throw new Error(`Failed to download media: HTTP ${res.status}`);
  return arrayBufferToBase64(await res.arrayBuffer());
}

/**
 * Resolve auth: API key → { scope bucket, label }; or anonymous.
 * @param {{ jobPoll?: boolean }} opts jobPoll uses a separate (higher) limit bucket so video polling isn't blocked by the general limit.
 */
export async function authOpenAI(env, request, { jobPoll = false } = {}) {
  const raw = extractBearer(request);
  const anonAllowed = String(env?.ANON_ALLOWED ?? "true") !== "false";

  let auth;
  if (!raw) {
    if (!anonAllowed) {
      return { error: openaiError("Missing API Key. Use Authorization: Bearer sk_pz_...", { status: 401, type: "invalid_request_error", code: "UNAUTHORIZED" }) };
    }
    auth = { subject: "anon", label: "anonymous", scopes: ["generate", "models"] };
  } else {
    let resolved;
    try {
      resolved = await resolveApiKey(env, raw);
    } catch (e) {
      return { error: openaiError(e.message || "Invalid API Key", { status: e.status || 401, type: "invalid_request_error", code: e.code || "UNAUTHORIZED" }) };
    }
    auth = {
      subject: `key:${resolved.keyId}`,
      label: `key:${resolved.name || resolved.keyId}`,
      scopes: resolved.scopes || ["*"],
      keyMeta: resolved,
      keyHash: resolved.keyHash, // sha256 hash — never the raw key
    };
  }

  // Rate limit per subject (key id or anonymous). Fail-open on storage errors.
  const keyedLimit = jobPoll
    ? Number(env?.RATE_LIMIT_JOBS_KEYED || 120)
    : Number(env?.RATE_LIMIT_KEYED || 60);
  const anonLimit = jobPoll
    ? Number(env?.RATE_LIMIT_JOBS_ANON || 60)
    : Number(env?.RATE_LIMIT_ANON || 10);
  const limit = auth.subject === "anon" ? anonLimit : keyedLimit;
  const bucket = jobPoll ? "jobs" : "all";
  const allowed = await checkRateLimit(env, auth.subject, { bucket, limit, windowSec: 60 });
  if (!allowed) {
    return { error: openaiError(`Rate limit exceeded (${limit}/min for ${auth.label})`, { status: 429, type: "rate_limit_error" }) };
  }
  return auth;
}

/** Track a successful generation against the key (throttled KV write). */
export async function trackGen(env, auth, bucket) {
  if (auth?.keyHash) await trackUsage(env, auth.keyHash, { bucket });
}

export function hasScope(scopes, needed) {
  const list = Array.isArray(scopes) ? scopes : ["*"];
  return list.includes("*") || list.includes(needed);
}

/** GET /v1/models — OpenAI list shape */
export async function openaiModels(context) {
  const a = await authOpenAI(context.env, context.request);
  if (a.error) return a.error;
  if (!hasScope(a.scopes, "models")) {
    return openaiError("Missing scope: models", { status: 403, code: "FORBIDDEN" });
  }
  const created = Math.floor(Date.now() / 1000);
  const data = MODEL_CATALOG.map((m) => ({
    id: m.id,
    object: "model",
    created,
    owned_by: m.company || "prezzy",
    type: m.type,
    permission: [],
    root: m.id,
    parent: null,
  }));
  // video engines
  for (const v of VIDEO_ENGINES) {
    data.push({
      id: `video-${v.id}`,
      object: "model",
      created,
      owned_by: "prezzy",
      type: "video",
      permission: [],
      root: `video-${v.id}`,
      parent: null,
    });
  }
  data.push({ id: "wan-2-2", object: "model", created, owned_by: "alibaba", type: "video" });
  data.push({ id: "hunyuan-1-5", object: "model", created, owned_by: "tencent", type: "video" });
  data.push({ id: "ltx-2", object: "model", created, owned_by: "lightricks", type: "video" });
  return json({ object: "list", data, faa: { auth: a.label } });
}

/** POST /v1/images/generations — sync */
export async function openaiImagesGenerations(context) {
  const a = await authOpenAI(context.env, context.request);
  if (a.error) return a.error;
  if (!hasScope(a.scopes, "generate")) {
    return openaiError("Missing scope: generate", { status: 403, code: "FORBIDDEN" });
  }

  const body = await readJson(context.request);
  const prompt = String(body.prompt || body.input || "").trim();
  if (!prompt) return openaiError("prompt is required", { status: 400, param: "prompt" });

  const n = Number(body.n ?? 1);
  if (Number.isFinite(n) && n > 1) {
    return openaiError("Only n=1 is supported", { status: 400, param: "n" });
  }

  const modelRaw = String(body.model || "flux-klein").trim();
  const cat = findCatalog(modelRaw);
  const backend = cat?.backend || "aiart";
  const modelId = cat?.id || normalizeModelId(modelRaw);

  const size = mapSize(body.size);
  // FAA 擴充：body.aspect 優先於 size 推導的比例（讓 UI 的比例按鈕完整可用）
  const aspectOverride = body.aspect || body.aspect_ratio || body.ratio || null;
  if (aspectOverride && size) size.aspect = String(aspectOverride);
  const negativePrompt = body.negative_prompt || body.negativePrompt || null;
  const responseFormat = String(body.response_format || body.responseFormat || "url").toLowerCase();
  if (responseFormat !== "url" && responseFormat !== "b64_json") {
    return openaiError("response_format must be 'url' or 'b64_json'", { status: 400, param: "response_format" });
  }

  // quality/seed/guidance passthrough
  const seed = body.seed != null ? Number(body.seed) : null;
  const guidanceScale = body.guidance_scale ?? body.guidanceScale ?? null;
  const quality = body.quality || "standard";

  let result;
  let fallbackUsed = false;
  try {
    if (backend === "dalle") {
      result = await dalle(context.env, {
        prompt,
        negativePrompt,
        width: size.w || 1024,
        height: size.h || 1024,
        seed,
        guidanceScale,
      });
    } else if (backend === "txt2img") {
      result = await txt2img(context.env, {
        prompt,
        model: cat?.model || "flux",
        aspectRatio: size.aspect,
      });
    } else {
      try {
        result = await aiart(context.env, {
          prompt,
          model: cat?.model || "Flux 2 Klein",
          ratio: size.aspect,
          negativePrompt,
        });
      } catch (e) {
        // AI Art 上游忙碌（Image still processing）→ 自動降級到可靠的 txt2img
        fallbackUsed = true;
        result = await txt2img(context.env, {
          prompt,
          model: "flux",
          aspectRatio: size.aspect,
        });
      }
    }
  } catch (e) {
    return openaiError(e.message || "generation failed", {
      status: e.status || 502,
      type: "api_error",
      code: e.code || "UPSTREAM_ERROR",
    });
  }

  await trackGen(context.env, a, "images");

  const created = Math.floor(Date.now() / 1000);
  const item = { revised_prompt: null };
  if (responseFormat === "b64_json") {
    try {
      item.b64_json = await fetchMediaAsBase64(result.image_url);
    } catch (e) {
      return openaiError(e.message || "failed to encode image", { status: 502, type: "api_error" });
    }
  } else {
    item.url = result.image_url;
  }

  return json({
    created,
    data: [item],
    model: modelId,
    faa: {
      upstream: result.upstream,
      upstreamModel: result.model || null,
      ratio: result.ratio || size.aspect,
      size: size.size,
      quality,
      tries: result.tries || null,
      note: result.note || null,
      fallback: fallbackUsed || null,
      auth: a.label,
    },
  });
}

function videoIdFromModel(modelRaw) {
  const s = String(modelRaw || "").trim().toLowerCase();
  if (/wan/.test(s)) return "wan2_2";
  if (/hunyuan/.test(s)) return "hunyuan1_5";
  if (/ltx/.test(s)) return "ltx2";
  return "wan2_2";
}

/** POST /v1/videos/generations — async job */
export async function openaiVideosGenerations(context) {
  const a = await authOpenAI(context.env, context.request);
  if (a.error) return a.error;
  if (!hasScope(a.scopes, "generate")) {
    return openaiError("Missing scope: generate", { status: 403, code: "FORBIDDEN" });
  }
  const body = await readJson(context.request);
  const prompt = String(body.prompt || body.input || "").trim();
  if (!prompt) return openaiError("prompt is required", { status: 400, param: "prompt" });
  const engine = videoIdFromModel(body.model);

  let sub;
  try {
    sub = await videoSubmit(context.env, { prompt, engine });
  } catch (e) {
    return openaiError(e.message || "video submission failed", {
      status: e.status || 502,
      type: "api_error",
      code: e.code || "UPSTREAM_ERROR",
    });
  }

  await trackGen(context.env, a, "videos");

  const jobId = uuid();
  const job = {
    id: jobId,
    type: "video",
    engine: sub.engine,
    prompt,
    task_id: sub.task_id,
    device_id: sub.device_id,
    status: "submitted",
    queue_position: sub.queue_position,
    estimated_time_seconds: sub.estimated_time_seconds,
    created_at: Date.now(),
  };
  let jobTracked = true;
  try {
    await context.env.KEYS.put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 86400 });
  } catch {
    jobTracked = false;
  }

  return json(
    {
      id: jobId,
      object: "video",
      status: "submitted",
      created: Math.floor(Date.now() / 1000),
      model: `video-${engine}`,
      faa: {
        engine: sub.engine,
        queue_position: sub.queue_position,
        estimated_time_seconds: sub.estimated_time_seconds,
        auth: a.label,
        job_tracked: jobTracked,
        poll: { url: `/v1/jobs/${jobId}`, intervalSec: 5 },
        upstream: { task_id: sub.task_id, device_id: sub.device_id },
      },
    },
    202
  );
}

/** GET /v1/jobs/:id — poll video job */
export async function openaiJob(context) {
  const a = await authOpenAI(context.env, context.request, { jobPoll: true });
  if (a.error) return a.error;
  if (!hasScope(a.scopes, "generate") && !hasScope(a.scopes, "jobs")) {
    return openaiError("Missing scope", { status: 403, code: "FORBIDDEN" });
  }
  const jobId = String(context.params?.id || "").trim();
  if (!jobId) return openaiError("job id required", { status: 400, param: "id" });

  let job = null;
  try {
    const raw = await context.env.KEYS.get(`job:${jobId}`);
    if (raw) job = JSON.parse(raw);
  } catch {
    job = null;
  }
  if (!job) {
    return openaiError("Job not found", { status: 404, code: "NOT_FOUND" });
  }
  if (job.type !== "video") {
    return json({ id: job.id, object: "job", status: job.status || "completed" });
  }

  let st;
  try {
    st = await videoStatus(context.env, { taskId: job.task_id, deviceId: job.device_id });
  } catch (e) {
    return openaiError(e.message || "status check failed", { status: e.status || 502, type: "api_error" });
  }

  const out = {
    id: job.id,
    object: "video",
    model: `video-${job.engine}`,
    status: st.ready ? "completed" : "in_progress",
    state: st.state,
    progress: st.progress,
    message: st.message,
    created: Math.floor(job.created_at / 1000),
    faa: { engine: job.engine, queue_position: job.queue_position, auth: a.label },
  };
  if (st.ready && st.video_url) {
    out.data = [{ url: st.video_url }];
  }
  return json(out);
}
