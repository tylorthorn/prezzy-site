/* Prezzy Studio — frontend
 * Credentials (API key / admin token) live in browser localStorage only.
 * build: 2026-08-06-v1
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const LS_KEY = "prezzy_studio_key";
  const LS_ADMIN = "prezzy_studio_admin";
  const LS_GALLERY = "prezzy_studio_gallery";
  const BASE = location.origin;

  const state = {
    models: [],
    apiKey: localStorage.getItem(LS_KEY) || "",
    adminToken: localStorage.getItem(LS_ADMIN) || "",
    ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2"],
    currentModel: "flux-klein",
    ratio: "1:1",
    engine: "wan2_2",
    gallery: JSON.parse(localStorage.getItem(LS_GALLERY) || "[]"),
    jobTimer: null,
    polling: false,
  };

  const MODEL_GROUPS = [
    { label: "Flux 系列", ids: ["flux-klein", "flux-klein-fast", "zimage"] },
    { label: "寫實", ids: ["realistic", "realistic-6", "general", "samaritan"] },
    { label: "動漫", ids: ["anime", "anime-2", "anime-25d", "anime-4"] },
    { label: "風格", ids: ["guofeng", "disney-cartoon"] },
    { label: "OpenAI 相容", ids: ["dall-e-3", "gpt-image-1", "dall-e-2", "nano-banana"] },
  ];

  /* ---------- utils ---------- */
  function toast(msg, kind = "") {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast show " + kind;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 3200);
  }

  function setStatus(el, text, kind = "") {
    el.textContent = text || "";
    el.className = "status" + (kind ? " " + kind : "");
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** 顯示用 URL：跨域一律走同源 /v1/media 代理（避免 CDN 無 CORS/ORB 擋圖）。 */
  function displayUrl(url) {
    const s = String(url || "");
    if (/^(blob:|data:|javascript:)/i.test(s)) return s;
    if (s.startsWith("/") || s.startsWith(location.origin)) return s;
    return `/v1/media?url=${encodeURIComponent(s)}`;
  }

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (state.apiKey) headers["Authorization"] = `Bearer ${state.apiKey}`;
    if (state.adminToken && path.startsWith("/api/")) headers["X-Admin-Key"] = state.adminToken;
    const res = await fetch(path, { ...options, headers });
    let data = null;
    try { data = await res.json(); } catch { data = { error: `非 JSON 回應 (${res.status})` }; }
    if (!res.ok && data && !data.error) data.error = `HTTP ${res.status}`;
    return data;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  /* ---------- tabs ---------- */
  function bindTabs() {
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        $("panel-" + btn.dataset.tab).classList.add("active");
      });
    });
  }

  /* ---------- models ---------- */
  async function loadModels() {
    const data = await api("/v1/models");
    if (data && Array.isArray(data.data)) {
      state.models = data.data;
      renderModels();
      $("model-count").textContent = `${state.models.length} 個模型`;
      $("build-badge").textContent = data.faa?.auth || "v0.1";
    } else {
      setStatus($("gen-status"), (data && data.error?.message) || "無法載入模型", "err");
    }
  }

  function renderModels() {
    const wrap = $("model-groups");
    wrap.innerHTML = "";
    for (const g of MODEL_GROUPS) {
      const items = state.models.filter((m) => g.ids.includes(m.id));
      if (!items.length) continue;
      const div = document.createElement("div");
      div.innerHTML = `<div class="model-group-label">${g.label}</div><div class="model-chips"></div>`;
      const chips = div.querySelector(".model-chips");
      for (const m of items) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "model-chip" + (m.id === state.currentModel ? " active" : "");
        b.textContent = m.id;
        b.onclick = () => {
          state.currentModel = m.id;
          document.querySelectorAll(".model-chip").forEach((c) => c.classList.remove("active"));
          b.classList.add("active");
        };
        chips.appendChild(b);
      }
      wrap.appendChild(div);
    }
  }

  function renderRatios() {
    const row = $("ratios");
    row.innerHTML = "";
    state.ratios.forEach((r) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ratio-btn" + (r === state.ratio ? " active" : "");
      b.textContent = r;
      b.onclick = () => {
        state.ratio = r;
        document.querySelectorAll(".ratio-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        const size = { "1:1": "1024x1024", "16:9": "1792x1024", "9:16": "1024x1792", "4:3": "1536x1024", "3:4": "1024x1536" }[r];
        if (size) $("size").value = size;
      };
      row.appendChild(b);
    });
  }

  /* ---------- engines ---------- */
  function bindEngines() {
    document.querySelectorAll(".engine-card").forEach((card) => {
      card.addEventListener("click", () => {
        document.querySelectorAll(".engine-card").forEach((c) => c.classList.remove("active"));
        card.classList.add("active");
        state.engine = card.dataset.engine;
      });
    });
  }

  /* ---------- image generation ---------- */
  function showLoading() {
    const p = $("preview");
    p.classList.add("loading");
    p.innerHTML = '<div class="preview-placeholder"><div class="ph-icon">🖼️</div><p>正在生成…<br/><span style="font-size:12px">AI Art 服務高峰期需等待數秒</span></p></div>';
    $("result-actions").classList.add("hidden");
  }

  function showResult(url, meta) {
    const p = $("preview");
    p.classList.remove("loading", "empty");
    p.innerHTML = `<img src="${escapeHtml(displayUrl(url))}" alt="result" />`;
    $("result-meta").textContent = meta || "";
    const open = $("btn-open");
    const dl = $("btn-download");
    open.href = url;
    open.target = "_blank";
    dl.href = `/v1/media?url=${encodeURIComponent(url)}&download=1`;
    $("result-actions").classList.remove("hidden");
  }

  function pushGallery({ url, type, model, meta }) {
    state.gallery.unshift({ url, type, model, meta, ts: Date.now() });
    state.gallery = state.gallery.slice(0, 60);
    localStorage.setItem(LS_GALLERY, JSON.stringify(state.gallery));
    renderGallery();
  }

  async function generateImage() {
    const prompt = $("prompt").value.trim();
    if (!prompt) return setStatus($("gen-status"), "請輸入提示詞", "err");
    const btn = $("btn-generate");
    btn.disabled = true;
    $("gen-label").textContent = "生成中…";
    $("gen-spinner").classList.remove("hidden");
    setStatus($("gen-status"), "提交中…", "warn");
    showLoading();

    const body = {
      model: state.currentModel,
      prompt,
      size: $("size").value,
      aspect: state.ratio, // 後端優先使用 aspect，7 種比例都生效
      response_format: $("response-format").value,
      negative_prompt: $("negative-prompt").value.trim() || undefined,
    };

    const t0 = Date.now();
    const data = await api("/v1/images/generations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    if (data.error) {
      const msg = typeof data.error === "object" ? data.error.message : data.error;
      setStatus($("gen-status"), msg || "生成失敗", "err");
      $("preview").classList.remove("loading");
      $("preview").classList.add("empty");
      toast(msg || "生成失敗", "err");
      btn.disabled = false;
      $("gen-label").textContent = "✨ 開始生成";
      $("gen-spinner").classList.add("hidden");
      return;
    }

    const url = data.data?.[0]?.url;
    if (!url) {
      setStatus($("gen-status"), "回應中沒有圖片 URL", "err");
      toast("回應中沒有圖片 URL", "err");
      btn.disabled = false;
      $("gen-label").textContent = "✨ 開始生成";
      $("gen-spinner").classList.add("hidden");
      return;
    }

    const faa = data.faa || {};
    const meta = `${faa.upstream || "prezzy"} · ${faa.upstreamModel || data.model || state.currentModel} · ${faa.ratio || state.ratio} · ${secs}s`;
    showResult(url, meta);
    setStatus($("gen-status"), `完成（${secs}s）`, "ok");
    toast("生成完成", "ok");
    pushGallery({ url, type: "image", model: data.model || state.currentModel, meta });

    btn.disabled = false;
    $("gen-label").textContent = "✨ 開始生成";
    $("gen-spinner").classList.add("hidden");
  }

  /* ---------- video generation ---------- */
  async function submitVideo() {
    const prompt = $("video-prompt").value.trim();
    if (!prompt) return setStatus($("video-status"), "請輸入影片提示詞", "err");
    const btn = $("btn-video");
    btn.disabled = true;
    $("video-label").textContent = "提交中…";
    $("video-spinner").classList.remove("hidden");
    setStatus($("video-status"), "提交中…", "warn");

    const data = await api("/v1/videos/generations", {
      method: "POST",
      body: JSON.stringify({ model: state.engine, prompt }),
    });

    if (data.error) {
      const msg = typeof data.error === "object" ? data.error.message : data.error;
      setStatus($("video-status"), msg || "提交失敗", "err");
      toast(msg || "提交失敗", "err");
      btn.disabled = false;
      $("video-label").textContent = "🎬 提交生成";
      $("video-spinner").classList.add("hidden");
      return;
    }

    setStatus($("video-status"), `已提交 job=${data.id}，開始輪詢…`, "warn");
    $("job-panel").classList.remove("hidden");
    const faa = data.faa || {};
    $("job-queue").textContent = faa.queue_position ?? "—";
    $("job-eta").textContent = faa.estimated_time_seconds ? `~${Math.ceil(faa.estimated_time_seconds / 60)} 分` : "—";
    $("job-state").textContent = "submitted";
    pollVideoJob(data.id);

    btn.disabled = false;
    $("video-label").textContent = "🎬 提交生成";
    $("video-spinner").classList.add("hidden");
  }

  async function pollVideoJob(jobId) {
    if (state.polling) return;
    state.polling = true;
    const started = Date.now();
    const timeoutMs = 12 * 60 * 1000;
    let poll = 0;

    while (Date.now() - started < timeoutMs) {
      poll += 1;
      const job = await api(`/v1/jobs/${encodeURIComponent(jobId)}`);
      if (job.error) {
        setStatus($("video-status"), typeof job.error === "object" ? job.error.message : job.error, "err");
        break;
      }
      $("job-state").textContent = job.status || "in_progress";
      if (job.state) $("job-message").textContent = `${job.state}${job.message ? " · " + job.message : ""}`;
      if (typeof job.progress === "number") {
        $("job-progress").style.width = `${Math.max(4, Math.min(100, job.progress))}%`;
      } else if (job.status === "completed") {
        $("job-progress").style.width = "100%";
      }

      if (job.status === "completed" && job.data?.[0]?.url) {
        const url = job.data[0].url;
        const p = $("video-preview");
        p.classList.remove("empty");
        p.innerHTML = `<video src="${escapeHtml(displayUrl(url))}" controls autoplay playsinline></video>`;
        $("job-progress").style.width = "100%";
        $("video-meta").textContent = `video-${job.faa?.engine || ""} · ${((Date.now() - started) / 1000).toFixed(0)}s`;
        setStatus($("video-status"), `影片生成完成（${((Date.now() - started) / 1000).toFixed(0)}s）`, "ok");
        toast("影片生成完成", "ok");
        pushGallery({ url, type: "video", model: `video-${job.faa?.engine || ""}`, meta: "video" });
        break;
      }
      await sleep(5000);
    }
    if (Date.now() - started >= timeoutMs) {
      setStatus($("video-status"), "輪詢逾時（12 分鐘）— 可稍後用 /v1/jobs 查詢", "err");
    }
    state.polling = false;
  }

  /* ---------- API console ---------- */
  function updateCodeSample(key) {
    const k = key || state.apiKey || "sk_pz_...";
    const lines = `# 1) 列出模型
curl -s -H "Authorization: Bearer ${k}" "${BASE}/v1/models"

# 2) 生成圖片（OpenAI Images API 相容）
curl -s -X POST "${BASE}/v1/images/generations" \\
  -H "Authorization: Bearer ${k}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"flux-klein","prompt":"a cute orange cat","size":"1024x1024"}'

# 3) 生成影片（非同步，回傳 job id）
curl -s -X POST "${BASE}/v1/videos/generations" \\
  -H "Authorization: Bearer ${k}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"wan-2-2","prompt":"a cat walking"}'`;

    $("code-sample").textContent = lines;
  }

  async function loadKeys() {
    if (!state.adminToken) {
      setStatus($("key-status"), "請先輸入 Admin Token 並儲存", "warn");
      $("key-list").innerHTML = "";
      return;
    }
    setStatus($("key-status"), "載入中…");
    const data = await api("/api/keys");
    if (!data.ok) {
      setStatus($("key-status"), data.error || "載入失敗", "err");
      return;
    }
    const list = $("key-list");
    list.innerHTML = "";
    (data.keys || []).forEach((k) => {
      const row = document.createElement("div");
      row.className = "key-item";
      row.innerHTML = `
        <div class="key-meta">
          <div class="t">${escapeHtml(k.name || "—")} · <code>${escapeHtml(k.prefix || "")}…</code></div>
          <div class="p">${escapeHtml(k.id)} · scopes=${escapeHtml((k.scopes || []).join(","))} · 用量=${k.usage?.total ?? 0} · ${new Date(k.createdAt).toLocaleString()}</div>
        </div>
        <button class="btn btn-danger btn-sm" data-id="${escapeHtml(k.id)}">撤銷</button>
      `;
      row.querySelector("button").onclick = async () => {
        if (!confirm(`確定撤銷 ${k.name || k.id}？`)) return;
        const res = await api(`/api/keys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
        setStatus($("key-status"), res.ok ? `已撤銷 ${k.id}` : res.error || "撤銷失敗", res.ok ? "ok" : "err");
        loadKeys();
      };
      list.appendChild(row);
    });
    if (!(data.keys || []).length) {
      list.innerHTML = '<p class="muted">尚無 API Key</p>';
    }
    setStatus($("key-status"), `共 ${(data.keys || []).length} 組 Key`, "ok");
  }

  function bindApi() {
    $("admin-token").value = state.adminToken;
    $("base-url").value = BASE;
    $("key-name").value = localStorage.getItem("prezzy_key_name") || "default";

    $("btn-admin-save").onclick = () => {
      state.adminToken = $("admin-token").value.trim();
      localStorage.setItem(LS_ADMIN, state.adminToken);
      toast("Admin Token 已儲存（僅本機）", "ok");
      loadKeys();
    };
    $("btn-key-create").onclick = async () => {
      if (!state.adminToken) return setStatus($("key-status"), "請先設定 Admin Token", "err");
      const name = $("key-name").value.trim() || "default";
      localStorage.setItem("prezzy_key_name", name);
      setStatus($("key-status"), "建立中…", "warn");
      const data = await api("/api/keys", { method: "POST", body: JSON.stringify({ name }) });
      if (!data.ok) return setStatus($("key-status"), data.error || "建立失敗", "err");
      const plain = data.key?.apiKey || "";
      state.apiKey = plain;
      localStorage.setItem(LS_KEY, plain);
      $("once-key").value = plain;
      $("once-wrap").classList.remove("hidden");
      updateCodeSample(plain);
      setStatus($("key-status"), "已建立（請立即複製）", "ok");
      toast("API Key 已建立", "ok");
      loadKeys();
    };
    $("btn-copy-key").onclick = async () => {
      try {
        await navigator.clipboard.writeText($("once-key").value);
        toast("已複製到剪貼簿", "ok");
      } catch {
        $("once-key").select();
      }
    };
    $("btn-copy-base").onclick = async () => {
      try {
        await navigator.clipboard.writeText(BASE);
        toast("Base URL 已複製", "ok");
      } catch { /* noop */ }
    };
    updateCodeSample();
  }

  /* ---------- gallery ---------- */
  function renderGallery() {
    const grid = $("gallery-grid");
    $("gallery-count").textContent = `${state.gallery.length} 件`;
    if (!state.gallery.length) {
      grid.innerHTML = '<p class="muted">尚無作品，先去生成一張吧！</p>';
      return;
    }
    grid.innerHTML = "";
    state.gallery.forEach((item) => {
      const a = document.createElement("a");
      a.href = item.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.title = `${item.model || ""} · ${item.meta || ""}`;
      if (item.type === "video") {
        const v = document.createElement("video");
        v.src = item.url;
        v.muted = true;
        a.appendChild(v);
      } else {
        const img = document.createElement("img");
        img.src = item.url;
        img.loading = "lazy";
        a.appendChild(img);
      }
      grid.appendChild(a);
    });
  }

  /* ---------- init ---------- */
  function init() {
    bindTabs();
    renderRatios();
    bindEngines();
    bindApi();
    renderGallery();
    $("btn-generate").onclick = generateImage;
    $("btn-video").onclick = submitVideo;
    $("btn-gallery-clear").onclick = () => {
      if (!confirm("清空全部作品紀錄？")) return;
      state.gallery = [];
      localStorage.setItem(LS_GALLERY, "[]");
      renderGallery();
    };
    $("prompt").addEventListener("input", () => {
      $("prompt-count").textContent = `${$("prompt").value.length} 字`;
    });
    // 直接選 size 下拉時同步比例按鈕
    $("size").addEventListener("change", () => {
      const m = { "1024x1024": "1:1", "1792x1024": "16:9", "1024x1792": "9:16", "1536x1024": "4:3", "1024x1536": "3:4", "768x1344": "9:16" };
      const r = m[$("size").value];
      if (r) {
        state.ratio = r;
        document.querySelectorAll(".ratio-btn").forEach((x) => x.classList.toggle("active", x.textContent === r));
      }
    });
    loadModels();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
