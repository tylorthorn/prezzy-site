# Prezzy Studio — AI 生成工作台（Cloudflare Workers）

免費 AI 圖片 / 影片生成站，上游為 [prexzyapis.com](https://prexzyapis.com)（免註冊、免 Key、無限）。
對外提供 **OpenAI 相容 API**，並內建 **API Key 管理** 與速率限制。純 Cloudflare Workers 免費方案即可運作。

## 功能

| 層面 | 內容 |
|---|---|
| 🎨 生成工作台 | 16+ 圖片模型（Flux 2 Klein / ZImage / 寫實 / 動漫 / DALL-E 3 XL…）、7 種比例、負面提示詞、尺寸、b64_json |
| 🎬 影片生成 | Wan 2.2 / Hunyuan 1.5 / LTX 2，非同步提交 + 自動輪詢（隊列位置 / 預估時間 / 進度條） |
| 🔑 API Key | 管理員建立 / 撤銷 Key（`sk_pz_...`）、每 Key 限流、用量統計、匿名模式 |
| 🤖 OpenAI 相容 | `GET /v1/models`、`POST /v1/images/generations`（同步）、`POST /v1/videos/generations` + `GET /v1/jobs/:id`（非同步） |
| 🖼️ 媒體代理 | `GET /v1/media?url=&download=1` — 同源代理上游媒體，保證 UI 渲染與下載 |
| ⚡ 自動降級 | AI Art 上游忙碌（"Image still processing"）時自動改用 txt2img 重試 |

## 目錄

```
prezzy-site/
├── wrangler.toml           # Worker + assets + KV（KEYS）
├── src/
│   ├── index.js            # 路由入口
│   ├── routes-openai.js    # OpenAI 相容端點 + 模型目錄
│   ├── routes-keys.js      # API Key 管理（KV 存 hash）
│   ├── routes-media.js     # 媒體代理（/v1/media）
│   ├── shared.js           # JSON/限流/CORS 工具
│   └── upstream/prezzy.js  # Prezzy 上游 adapter（逆向結果實作）
├── public/                 # 專業生成站 UI（index / docs / css / js）
├── scripts/make-preview.mjs # 產生自包含功能預覽 .preview.html
└── test/adapter.test.mjs   # 端到端測試（直連真實 API）
```

## 本地開發

```bash
cd prezzy-site
npm install
npm run dev        # http://127.0.0.1:8787
```

## 部署

```bash
cd prezzy-site
npx wrangler login
npx wrangler kv namespace create KEYS        # 把傳回的 id / preview_id 填入 wrangler.toml
npx wrangler secret put ADMIN_TOKEN           # 管理 API Key 用的密鑰
npm run deploy                                 # → https://prezzy-site.<子域>.workers.dev
```

綁定自訂網域：Worker → Settings → Domains & Routes。

## 測試

```bash
npm run check          # 語法檢查（全部 src + 前端）
npm run test:adapter   # 端到端（直連真實 Prezzy API，含實際生成）
```

## API 快速參考

```bash
# 生成圖片（OpenAI Images API 相容，匿名可用）
curl -s -X POST "https://<你的網域>/v1/images/generations" \
  -H "Content-Type: application/json" \
  -d '{"model":"flux-klein","prompt":"a cute cat","size":"1024x1024"}'

# 生成影片（非同步）→ 用回傳的 id 輪詢 /v1/jobs/:id
curl -s -X POST "https://<你的網域>/v1/videos/generations" \
  -H "Content-Type: application/json" \
  -d '{"model":"wan-2-2","prompt":"a cat walking"}'

# 管理 Key（需 ADMIN_TOKEN）
curl -s -H "X-Admin-Key: <ADMIN_TOKEN>" -X POST "https://<你的網域>/api/keys" \
  -H "Content-Type: application/json" -d '{"name":"my-app"}'

# 媒體代理（UI 顯示 / 下載用）
curl -s -o out.png "https://<你的網域>/v1/media?url=<image-url>"
```

## 預覽 UI（不需部署）

```bash
node scripts/make-preview.mjs   # 產生 .preview.html（內嵌 CSS/JS + shim，直連真實 Prezzy）
# 直接用瀏覽器開啟 .preview.html 即可試用完整流程
```

### OpenAI SDK

```js
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "https://<你的網域>/v1",
  apiKey: "sk_pz_...",            // 匿名模式可省略
});
const img = await client.images.generate({
  model: "flux-klein", prompt: "a cute cat", size: "1024x1024",
});
```

## 模型清單

圖片：`flux-klein` `flux-klein-fast` `zimage` `realistic` `realistic-6` `general` `samaritan` `anime` `anime-2` `anime-25d` `anime-4` `guofeng` `disney-cartoon` `dall-e-3` `gpt-image-1` `dall-e-2` `nano-banana`
影片：`wan-2-2` `hunyuan-1-5` `ltx-2`

## 安全注意

- API Key 只存 SHA-256 hash；管理端點需 `ADMIN_TOKEN` secret
- 匿名模式（`ANON_ALLOWED=true`）預設開啟且限流較嚴，適合個人自用
- 圖片 URL（尤其 DALL-E）可能為臨時位址，請盡快下載
- 上游為第三方免費服務，高峰期可能回「Image still processing」— 已自動降級處理
