// Local dev server: serves the dashboard from web/ and the API on the same origin.
//   npm run dev:mock          # no API keys needed, fake model responses, in-memory DB
//   META_API_KEY=... DB=memory LOCAL_DB_FILE=data/local-db.json npm run dev   # real models, local storage
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT || 8787);
const WEB = new URL("../web/", import.meta.url).pathname;
const { route } = await import("../src/handlers/api.mjs");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const API_PREFIXES = ["/api", "/demo", "/r/", "/e", "/t.js", "/assets/", "/health"];

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const isApi = API_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p.endsWith("/") ? p : `${p}/`) || url.pathname === p.replace(/\/$/, ""));
  if (isApi) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const event = {
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
      requestContext: { http: { method: req.method } },
      body: Buffer.concat(chunks).toString("utf8"),
    };
    const out = await route(event);
    res.writeHead(out.statusCode, out.headers);
    res.end(out.isBase64Encoded ? Buffer.from(out.body, "base64") : out.body);
    return;
  }
  let file = normalize(join(WEB, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(WEB)) file = join(WEB, "index.html");
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    const data = await readFile(join(WEB, "index.html"));
    res.writeHead(200, { "content-type": TYPES[".html"] });
    res.end(data);
  }
}).listen(PORT, () => console.log(`Traction Radar dev server on http://localhost:${PORT}  (mock=${process.env.MOCK_LLM === "1"})`));
