/**
 * Prezzy upstream adapter.
 *
 * Reverse-engineered surface (2026-08-06):
 *   GET/POST https://prexzyapis.com
 *     /ai/aiart?prompt=&model?=&ratio?=           → image_url (may 500 "Image still processing")
 *     /ai/dalle?prompt=&negativePrompt?=&width?=&height?=&seed?=&guidanceScale?=
 *                                                → image_url[] (temporary, download promptly)
 *     /ai/txt2img?prompt=&model?=&style?=&aspect_ratio?=
 *                                                → image_url + job_id (rockhr CDN)
 *     /ai/aiart-video?prompt=&engine?=           → task_id + device_id (async)
 *     /ai/aiart-video-status?task_id=&device_id= → { ready, state, progress } (+ video URL when ready)
 */

import { enc, sleep } from "../shared.js";

export const PREZZY_MODEL_LIST = [
  "General",
  "Realistic",
  "Realistic 2",
  "Realistic 3",
  "Realistic 4",
  "Realistic 5",
  "Realistic 6",
  "Anime",
  "Anime 2",
  "Anime 2.5D",
  "Anime 2.5D 2",
  "Anime 3",
  "Anime 4",
  "GuoFeng",
  "Disney Cartoon",
  "Samaritan",
  "Flux 2 Klein",
  "Flux 2 Klein Fast",
  "ZImage",
];

export const PREZZY_RATIOS = ["1:1", "9:16", "16:9", "3:4", "4:3", "2:3", "3:2"];

export const VIDEO_ENGINES = [
  { id: "wan2_2", name: "Wan 2.2", desc: "Alibaba · balanced quality/speed" },
  { id: "hunyuan1_5", name: "Hunyuan 1.5", desc: "Tencent · cinematic" },
  { id: "ltx2", name: "LTX 2", desc: "Lightricks · fast, lightweight" },
];

function baseUrl(env) {
  return String(env?.PREZZY_BASE_URL || "https://prexzyapis.com").replace(/\/+$/, "");
}

class UpstreamError extends Error {
  constructor(message, { status = 502, code = "UPSTREAM_ERROR", payload = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

async function upstreamJson(url, { timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
  } catch (e) {
    throw new UpstreamError(`Upstream unreachable: ${e.message || e}`, { status: 502, code: "UPSTREAM_UNREACHABLE" });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    throw new UpstreamError(data?.error || `Upstream HTTP ${res.status}`, {
      status: res.status >= 500 ? 502 : res.status,
      code: "UPSTREAM_ERROR",
      payload: data,
    });
  }
  return data;
}

/** Does Prezzy say the image is still processing (retryable)? */
export function isProcessingError(data) {
  const s = String(data?.error || data?.message || "");
  return /still processing|please try again|processing/i.test(s) && (data?.status === false || !data?.status);
}

/**
 * /ai/aiart — main image generator (18 models × 7 ratios).
 * Retries on the known "Image still processing" error.
 */
export async function aiart(env, { prompt, model, ratio, negativePrompt, maxTries = 4, retryDelayMs = 4000 } = {}) {
  const q = new URLSearchParams({ prompt: String(prompt || "").trim() });
  if (model) q.set("model", String(model));
  if (ratio) q.set("ratio", String(ratio));
  if (negativePrompt) q.set("negative_prompt", String(negativePrompt));
  const url = `${baseUrl(env)}/ai/aiart?${q.toString()}`;

  let last = null;
  for (let i = 0; i < maxTries; i++) {
    const data = await upstreamJson(url, { timeoutMs: 40000 });
    if (data?.image_url) {
      return {
        image_url: data.image_url,
        model: data.model || model || "General",
        ratio: data.ratio || ratio || "1:1",
        upstream: "aiart",
        tries: i + 1,
      };
    }
    last = data;
    if (isProcessingError(data) && i < maxTries - 1) await sleep(retryDelayMs);
  }
  throw new UpstreamError(last?.error || "AI Art generation failed", {
    status: 502,
    code: "UPSTREAM_ERROR",
    payload: last,
  });
}

/**
 * /ai/dalle — DALL-E 3 XL LoRA (HuggingFace Space, temp URLs).
 */
export async function dalle(env, { prompt, negativePrompt, width = 1024, height = 1024, seed, guidanceScale } = {}) {
  const q = new URLSearchParams({ prompt: String(prompt || "").trim() });
  if (negativePrompt) q.set("negativePrompt", String(negativePrompt));
  q.set("width", String(width));
  q.set("height", String(height));
  if (seed != null) q.set("seed", String(seed));
  if (guidanceScale != null) q.set("guidanceScale", String(guidanceScale));
  const url = `${baseUrl(env)}/ai/dalle?${q.toString()}`;

  const data = await upstreamJson(url, { timeoutMs: 60000 });
  const urls = Array.isArray(data?.image_url)
    ? data.image_url
        .map((it) => it?.image?.url || it?.url || null)
        .filter(Boolean)
    : data?.image_url
      ? [data.image_url]
      : [];
  if (!urls.length) {
    throw new UpstreamError(data?.error || "DALL-E generation failed", {
      status: 502,
      code: "UPSTREAM_ERROR",
      payload: data,
    });
  }
  return {
    image_url: urls[0],
    all_urls: urls,
    model: "DALL-E 3 XL",
    params: data?.parameters || null,
    note: data?.note || null,
    upstream: "dalle",
  };
}

/**
 * /ai/txt2img — NanoBanana / Flux (rockhr CDN, most reliable — returns immediately).
 */
export async function txt2img(env, { prompt, model, style, aspectRatio } = {}) {
  const q = new URLSearchParams({ prompt: String(prompt || "").trim() });
  if (model) q.set("model", String(model));
  if (style) q.set("style", String(style));
  if (aspectRatio) q.set("aspect_ratio", String(aspectRatio));
  const url = `${baseUrl(env)}/ai/txt2img?${q.toString()}`;

  const data = await upstreamJson(url, { timeoutMs: 60000 });
  if (!data?.image_url) {
    throw new UpstreamError(data?.error || "txt2img generation failed", {
      status: 502,
      code: "UPSTREAM_ERROR",
      payload: data,
    });
  }
  return {
    image_url: data.image_url,
    job_id: data.job_id || null,
    model: model || "nano-banana",
    upstream: "txt2img",
  };
}

/**
 * /ai/aiart-video — text-to-video, async. Returns task/device ids for polling.
 */
export async function videoSubmit(env, { prompt, engine = "wan2_2" } = {}) {
  const q = new URLSearchParams({ prompt: String(prompt || "").trim() });
  q.set("engine", String(engine));
  const url = `${baseUrl(env)}/ai/aiart-video?${q.toString()}`;

  const data = await upstreamJson(url, { timeoutMs: 40000 });
  if (!data?.task_id || !data?.device_id) {
    throw new UpstreamError(data?.error || "Video submission failed", {
      status: 502,
      code: "UPSTREAM_ERROR",
      payload: data,
    });
  }
  return {
    task_id: data.task_id,
    device_id: data.device_id,
    engine: data.engine || engine,
    duration: data.duration ?? 5,
    estimated_time_seconds: data.estimated_time_seconds ?? null,
    queue_position: data.queue_position ?? null,
    message: data.message || "",
    status_url: data.status_url || `/ai/aiart-video-status?task_id=${data.task_id}&device_id=${data.device_id}`,
    upstream: "aiart-video",
  };
}

/**
 * /ai/aiart-video-status — poll a video job.
 * Returns { ready, state, progress, video_url?, message? }.
 */
export async function videoStatus(env, { taskId, deviceId } = {}) {
  if (!taskId || !deviceId) {
    throw new UpstreamError("task_id and device_id are required", { status: 400, code: "VALIDATION_ERROR" });
  }
  const q = new URLSearchParams({ task_id: String(taskId), device_id: String(deviceId) });
  const url = `${baseUrl(env)}/ai/aiart-video-status?${q.toString()}`;

  const data = await upstreamJson(url, { timeoutMs: 30000 });
  return {
    ready: !!data?.ready,
    state: data?.state || "unknown",
    progress: data?.progress ?? null,
    message: data?.message || "",
    video_url: data?.video_url || data?.url || null,
    upstream: "aiart-video-status",
  };
}
