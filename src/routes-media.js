/**
 * GET /v1/media?url=<encoded> — media proxy.
 * Fetches remote image/video bytes and returns them with permissive CORS +
 * correct Content-Type, so the studio UI (and OpenAI clients fetching urls)
 * always render upstream media regardless of the upstream CDN headers.
 */

function bad(msg, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}

export async function proxyMedia(context) {
  const { env, request } = context;
  const urlObj = new URL(request.url);
  const q = urlObj.searchParams.get("url") || "";
  const asDownload = urlObj.searchParams.get("download") === "1";
  if (!q) return bad("url query param required");

  let u;
  try {
    u = new URL(q);
  } catch {
    return bad("invalid url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return bad("only http(s) allowed");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let res;
  try {
    res = await fetch(u.toString(), {
      signal: ctrl.signal,
      headers: { Accept: "*/*", "User-Agent": "prezzy-studio/1.0" },
      redirect: "follow",
    });
  } catch (e) {
    clearTimeout(timer);
    return bad(`upstream fetch failed: ${e.message || e}`, 502);
  }
  clearTimeout(timer);

  if (!res.ok) return bad(`upstream HTTP ${res.status}`, 502);

  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set(
    "Content-Type",
    res.headers.get("Content-Type") || "application/octet-stream"
  );
  headers.set("Cache-Control", "public, max-age=3600");
  if (res.headers.get("Content-Length")) {
    headers.set("Content-Length", res.headers.get("Content-Length"));
  }
  if (asDownload) {
    const ct = (res.headers.get("Content-Type") || "").split(";")[0].trim();
    const ext = ct.includes("video") ? "mp4" : ct.includes("gif") ? "gif" : "png";
    headers.set("Content-Disposition", `attachment; filename="prezzy-${Date.now()}.${ext}"`);
  }
  return new Response(res.body, { status: 200, headers });
}
