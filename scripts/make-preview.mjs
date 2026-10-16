/**
 * Dev tool: generate a self-contained, fully-functional preview of the studio.
 * Inlines style.css + app.js and adds a fetch shim that proxies /v1/* to the
 * REAL Prezzy API (which supports browser CORS), so the preview actually works
 * without deploying the Worker.
 *
 * Output: .preview.html  (gitignored) — open it anywhere or use the Preview tab.
 *
 * Run: node scripts/make-preview.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public/index.html"), "utf8");
const css = readFileSync(join(root, "public/css/style.css"), "utf8");
const js = readFileSync(join(root, "public/js/app.js"), "utf8");

const MODEL_CATALOG = [
  { id: "flux-klein", name: "Flux 2 Klein", company: "Black Forest Labs" },
  { id: "flux-klein-fast", name: "Flux 2 Klein Fast", company: "Black Forest Labs" },
  { id: "zimage", name: "ZImage", company: "Alibaba" },
  { id: "general", name: "General", company: "Prezzy" },
  { id: "realistic", name: "Realistic", company: "Prezzy" },
  { id: "realistic-6", name: "Realistic 6", company: "Prezzy" },
  { id: "anime", name: "Anime", company: "Prezzy" },
  { id: "anime-2", name: "Anime 2", company: "Prezzy" },
  { id: "anime-25d", name: "Anime 2.5D", company: "Prezzy" },
  { id: "anime-4", name: "Anime 4", company: "Prezzy" },
  { id: "guofeng", name: "GuoFeng", company: "Prezzy" },
  { id: "disney-cartoon", name: "Disney Cartoon", company: "Prezzy" },
  { id: "samaritan", name: "Samaritan", company: "Prezzy" },
  { id: "dall-e-3", name: "DALL-E 3 XL", company: "OpenAI (LoRA)" },
  { id: "gpt-image-1", name: "GPT Image 1", company: "OpenAI-compatible" },
  { id: "dall-e-2", name: "DALL-E 2", company: "OpenAI-compatible" },
  { id: "nano-banana", name: "Nano Banana", company: "Google-compatible" },
  { id: "wan-2-2", name: "Wan 2.2", company: "alibaba", type: "video" },
  { id: "hunyuan-1-5", name: "Hunyuan 1.5", company: "tencent", type: "video" },
  { id: "ltx-2", name: "LTX 2", company: "lightricks", type: "video" },
];

const SHIM = `
<script>
/* ====== Preview shim: /v1/* → real Prezzy API (CORS allowed) ====== */
(function () {
  const REAL = "https://prexzyapis.com";
  const realFetch = window.fetch.bind(window);
  const jobs = {}; // id → {task_id, device_id, engine}

  const CATALOG = ${JSON.stringify(MODEL_CATALOG)};
  const MODEL_ALIAS = {
    "flux-klein": "Flux 2 Klein", "flux-klein-fast": "Flux 2 Klein Fast",
    "zimage": "ZImage", "general": "General", "realistic": "Realistic",
    "realistic-6": "Realistic 6", "anime": "Anime", "anime-2": "Anime 2",
    "anime-25d": "Anime 2.5D", "anime-4": "Anime 4", "guofeng": "GuoFeng",
    "disney-cartoon": "Disney Cartoon", "samaritan": "Samaritan",
    "gpt-image-1": "Flux 2 Klein",
  };
  const SIZE_ASPECT = {
    "256x256": "1:1", "512x512": "1:1", "1024x1024": "1:1",
    "1792x1024": "16:9", "1024x1792": "9:16", "1536x1024": "4:3",
    "1024x1536": "3:4", "768x1344": "9:16",
  };

  function jr(data, status) {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }

  // Preview runs in a strict webview: cross-origin images may be ORB-blocked.
  // Convert upstream media to a same-origin blob URL so it always renders.
  async function toBlobUrl(url) {
    try {
      const r = await realFetch(url);
      if (!r.ok) return url;
      return URL.createObjectURL(await r.blob());
    } catch {
      return url;
    }
  }

  window.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("/v1/")) {
      const path = url.replace(/\\?.*$/, "");
      const method = (init.method || "GET").toUpperCase();

      if (method === "GET" && path === "/v1/models") {
        const created = Math.floor(Date.now() / 1000);
        return jr({ object: "list", data: CATALOG.map((m) => ({ id: m.id, object: "model", created, owned_by: m.company || "prezzy", type: m.type || "image" })), faa: { auth: "preview-shim" } });
      }

      if (method === "POST" && path === "/v1/images/generations") {
        const body = JSON.parse(init.body || "{}");
        const prompt = encodeURIComponent(body.prompt || "");
        const sizeKey = String(body.size || "1024x1024").toLowerCase();
        const aspect = body.aspect || SIZE_ASPECT[sizeKey] || "1:1";
        const modelId = String(body.model || "flux-klein");
        let upstream = "aiart";
        let u = "";
        if (modelId === "dall-e-3") {
          const [w, h] = sizeKey.split("x").map(Number);
          u = REAL + "/ai/dalle?prompt=" + prompt + "&width=" + (w || 1024) + "&height=" + (h || 1024);
          upstream = "dalle";
        } else if (modelId === "nano-banana" || modelId === "dall-e-2") {
          u = REAL + "/ai/txt2img?prompt=" + prompt + "&model=flux&aspect_ratio=" + encodeURIComponent(aspect);
          upstream = "txt2img";
        } else {
          u = REAL + "/ai/aiart?prompt=" + prompt + "&model=" + encodeURIComponent(MODEL_ALIAS[modelId] || "Flux 2 Klein") + "&ratio=" + encodeURIComponent(aspect);
        }
        try {
          const r = await realFetch(u, { headers: { Accept: "application/json" } });
          const d = await r.json();
          let imageUrl = Array.isArray(d.image_url)
            ? (d.image_url[0]?.image?.url || d.image_url[0]?.url || null)
            : (d.image_url || null);
          if (!imageUrl && d.status === false && /processing/i.test(String(d.error || ""))) {
            // 降級：AI Art 忙碌 → txt2img
            upstream = "txt2img";
            const r2 = await realFetch(REAL + "/ai/txt2img?prompt=" + prompt + "&model=flux&aspect_ratio=" + encodeURIComponent(aspect));
            const d2 = await r2.json();
            imageUrl = d2.image_url || null;
          }
          if (!imageUrl) return jr({ error: { message: d.error || "upstream error", type: "api_error" } }, 502);
          const finalUrl = await toBlobUrl(imageUrl);
          return jr({ created: Math.floor(Date.now() / 1000), data: [{ url: finalUrl, revised_prompt: null }], model: modelId, faa: { upstream, upstreamModel: MODEL_ALIAS[modelId] || null, ratio: aspect, size: sizeKey, auth: "preview-shim" } });
        } catch (e) {
          return jr({ error: { message: String(e.message || e), type: "api_error" } }, 502);
        }
      }

      if (method === "POST" && path === "/v1/videos/generations") {
        const body = JSON.parse(init.body || "{}");
        const engine = String(body.model || "wan-2-2").includes("hunyuan") ? "hunyuan1_5" : String(body.model || "wan-2-2").includes("ltx") ? "ltx2" : "wan2_2";
        const prompt = encodeURIComponent(body.prompt || "");
        const r = await realFetch(REAL + "/ai/aiart-video?prompt=" + prompt + "&engine=" + engine);
        const d = await r.json();
        if (!d.task_id) return jr({ error: { message: d.error || "submit failed", type: "api_error" } }, 502);
        const id = "pv_" + Math.random().toString(36).slice(2, 10);
        jobs[id] = { task_id: d.task_id, device_id: d.device_id, engine: d.engine, queue: d.queue_position, eta: d.estimated_time_seconds };
        return jr({ id, object: "video", status: "submitted", created: Math.floor(Date.now() / 1000), model: "video-" + engine, faa: { engine: d.engine, queue_position: d.queue_position, estimated_time_seconds: d.estimated_time_seconds, auth: "preview-shim", poll: { url: "/v1/jobs/" + id, intervalSec: 5 } } }, 202);
      }

      if (method === "GET" && path.startsWith("/v1/jobs/")) {
        const id = decodeURIComponent(path.split("/")[3]);
        const job = jobs[id];
        if (!job) return jr({ error: { message: "Job not found", type: "invalid_request_error" } }, 404);
        const r = await realFetch(REAL + "/ai/aiart-video-status?task_id=" + job.task_id + "&device_id=" + job.device_id);
        const d = await r.json();
        const out = { id, object: "video", model: "video-" + job.engine, status: d.ready ? "completed" : "in_progress", state: d.state, progress: d.progress, message: d.message, created: Math.floor(Date.now() / 1000), faa: { engine: job.engine } };
        if (d.ready && d.video_url) out.data = [{ url: await toBlobUrl(d.video_url) }];
        return jr(out);
      }

      return jr({ error: { message: "preview shim: unsupported " + method + " " + path, type: "invalid_request_error" } }, 404);
    }
    return realFetch(input, init);
  };
})();
</script>
`;

const out = html
  .replace('<link rel="stylesheet" href="/css/style.css" />', `<style>\n${css}\n</style>`)
  .replace('<script src="/js/app.js"></script>', `${SHIM}\n<script>\n${js}\n</script>`);

writeFileSync(join(root, ".preview.html"), out);
console.log("OK → .preview.html (" + out.length + " bytes)");
