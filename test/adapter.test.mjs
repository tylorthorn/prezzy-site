/**
 * End-to-end test: adapter + OpenAI-compatible routes against the real Prezzy API.
 * Run: npm run test:adapter   (or: node test/adapter.test.mjs)
 */
import {
  aiart,
  dalle,
  txt2img,
  videoSubmit,
  videoStatus,
} from "../src/upstream/prezzy.js";
import {
  openaiImagesGenerations,
  openaiModels,
  openaiVideosGenerations,
  openaiJob,
} from "../src/routes-openai.js";

// In-memory KV stub so /v1/jobs/:id can find jobs the route just stored.
const kvStore = new Map();
const ENV = {
  PREZZY_BASE_URL: "https://prexzyapis.com",
  ANON_ALLOWED: "true",
  KEYS: {
    async get(k) { return kvStore.get(k) ?? null; },
    async put(k, v) { kvStore.set(k, v); },
  },
};

let passed = 0;
let failed = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}${extra ? " — " + extra : ""}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`);
  }
}

async function safe(name, fn) {
  try {
    await fn();
  } catch (e) {
    ok(name, false, e.message.slice(0, 90));
  }
}

async function testAdapter() {
  console.log("\n== 1. Adapter（直連 Prezzy 真實 API）==\n");

  await safe("txt2img 回傳 image_url", async () => {
    const t = await txt2img(ENV, { prompt: "a test blue dog", model: "flux" });
    ok("txt2img 回傳 image_url", /^https?:\/\//.test(t.image_url), t.image_url.slice(0, 70));
    console.log(`      upstream=${t.upstream} job_id=${t.job_id || "—"}`);
  });

  await safe("aiart（上游忙碌時可降級）", async () => {
    try {
      const a = await aiart(ENV, { prompt: "a test red cat", model: "Flux 2 Klein", ratio: "1:1", maxTries: 2 });
      ok("aiart 回傳 image_url", /^https?:\/\//.test(a.image_url), a.image_url.slice(0, 70));
      console.log(`      upstream=${a.upstream} model=${a.model} tries=${a.tries}`);
    } catch (e) {
      ok("aiart（忙碌時拋出可降級錯誤）", /processing|failed/i.test(e.message), e.message.slice(0, 80));
    }
  });

  await safe("dalle 回傳 image_url", async () => {
    const d = await dalle(ENV, { prompt: "a test cat", width: 1024, height: 1024 });
    ok("dalle 回傳 image_url", /^https?:\/\//.test(d.image_url), d.image_url.slice(0, 70));
    console.log(`      upstream=${d.upstream} urls=${(d.all_urls || []).length}`);
  });

  await safe("videoSubmit 回傳 task_id/device_id", async () => {
    const v = await videoSubmit(ENV, { prompt: "a test cat walking", engine: "wan2_2" });
    ok("videoSubmit 回傳 task_id/device_id", !!(v.task_id && v.device_id), `queue=${v.queue_position} eta=${v.estimated_time_seconds}s`);
    console.log(`      engine=${v.engine} task_id=${String(v.task_id).slice(0, 12)}…`);

    if (v.task_id && v.device_id) {
      const st = await videoStatus(ENV, { taskId: v.task_id, deviceId: v.device_id });
      ok("videoStatus 回傳結構", st.state !== undefined, `state=${st.state} ready=${st.ready}`);
    }
  });
}

function fakeCtx(path, body) {
  const req = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { request: req, env: ENV };
}

async function testOpenAIRoutes() {
  console.log("\n== 2. OpenAI 相容路由（匿名模式）==\n");

  const mres = await openaiModels({ request: new Request("http://localhost/v1/models"), env: ENV });
  const mdata = await mres.json();
  const ids = (mdata.data || []).map((m) => m.id);
  ok("GET /v1/models 回傳 list", mdata.object === "list" && ids.length > 10, `${ids.length} 個模型`);
  ok("包含 flux-klein 與 wan-2-2", ids.includes("flux-klein") && ids.includes("wan-2-2"));

  const ires = await openaiImagesGenerations(fakeCtx("/v1/images/generations", { model: "flux-klein", prompt: "e2e test cat", size: "1024x1024" }));
  const idata = await ires.json();
  const url = idata.data?.[0]?.url;
  ok("POST /v1/images/generations 回傳 url", ires.status === 200 && /^https?:\/\//.test(url || ""), (idata.faa?.upstream || "") + " · " + (url || "").slice(0, 60));
  if (idata.error) console.log("      error:", JSON.stringify(idata.error));

  await safe("POST /v1/videos/generations + GET /v1/jobs/:id", async () => {
    const vres = await openaiVideosGenerations(fakeCtx("/v1/videos/generations", { model: "wan-2-2", prompt: "e2e video test" }));
    const vdata = await vres.json();
    ok("video 提交回傳 id/status", vres.status === 202 && vdata.id && vdata.status === "submitted", `job=${String(vdata.id).slice(0, 8)}…`);

    const jres = await openaiJob({
      request: new Request(`http://localhost/v1/jobs/${vdata.id}`),
      env: ENV,
      params: { id: vdata.id },
    });
    const jdata = await jres.json();
    ok("job 輪詢回傳 status", jdata.status === "in_progress" || jdata.status === "completed", `status=${jdata.status} state=${jdata.state}`);
  });
}

console.log("Prezzy Studio — e2e test（真實網路，單圖生成約需 5–60 秒）");
try {
  await testAdapter();
  await testOpenAIRoutes();
} catch (e) {
  failed++;
  console.log("  ❌ 測試執行失敗：", e.message);
}

console.log(`\n結果：${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
