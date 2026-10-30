// HTTP API behind a Lambda Function URL (payload format 2.0). Also mounted by scripts/dev-server.mjs.
import { createHash, timingSafeEqual } from "node:crypto";
import { db, id, now } from "../lib/db.mjs";
import { secrets, settings } from "../lib/config.mjs";
import { enqueue } from "../lib/queue.mjs";
import { bankOverview } from "../lib/bank.mjs";
import { getAsset } from "../lib/assets.mjs";
import { publishThreads, threadsIntentUrl } from "../lib/threads.mjs";
import { isPublicHttpUrl } from "../lib/web.mjs";
import { SNIPPET } from "../lib/snippet.mjs";

const P = (pid) => `PRODUCT#${pid}`;

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

function apiBaseFrom(event) {
  const host = event.headers?.host || event.requestContext?.domainName;
  if (!host) return process.env.API_BASE_URL || "";
  const proto = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  return `${proto}://${host}`;
}

async function authorised(event) {
  const { ADMIN_TOKEN } = await secrets();
  if (!ADMIN_TOKEN) return settings.mock || (process.env.DB === "memory" && process.env.NODE_ENV !== "production"); // open only in local dev
  const given = event.headers?.["x-tr-token"] ?? "";
  const a = Buffer.from(createHash("sha256").update(given).digest("hex"));
  const b = Buffer.from(createHash("sha256").update(ADMIN_TOKEN).digest("hex"));
  return timingSafeEqual(a, b);
}

function body(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

const strip = (row) => {
  if (!row) return row;
  const { pk, sk, gsi1pk, gsi1sk, ...rest } = row;
  return rest;
};

// ---------------------------------------------------------------- public routes
async function redirect(slug, event) {
  const link = await db.get(`LINK#${slug}`, "META");
  if (!link) return { statusCode: 404, headers: { "content-type": "text/plain" }, body: "Link not found" };
  const exp = await db.get(P(link.productId), `EXP#${link.experimentId}`);
  const ua = event.headers?.["user-agent"] ?? "";
  const bot = /bot|crawler|spider|preview|facebookexternalhit|slackbot|whatsapp|telegram/i.test(ua);
  if (!bot) {
    await db.update(P(link.productId), `EXP#${link.experimentId}`, {}, { clicks: 1 });
    await db.put({
      pk: P(link.productId),
      sk: `EVENT#${now()}#${id(6)}`,
      type: "event",
      event: "click",
      experimentId: link.experimentId,
      ttl: Math.floor(Date.now() / 1000) + 180 * 86400,
    });
  }
  const target = new URL(link.target || settings.publicSiteUrl);
  target.searchParams.set("utm_source", "traction-radar");
  target.searchParams.set("utm_medium", exp?.channel ?? "experiment");
  target.searchParams.set("utm_campaign", link.experimentId);
  target.searchParams.set("utm_content", slug);
  target.searchParams.set("tr", slug);
  return { statusCode: 302, headers: { location: target.toString(), "cache-control": "no-store" }, body: "" };
}

async function conversion(event) {
  const b = body(event);
  const slug = String(b.slug ?? b.tr ?? "").slice(0, 20);
  const kind = b.event === "payment" ? "payment" : b.event === "signup" ? "signup" : null;
  if (!slug || !kind) return json(400, { error: "slug and event (signup|payment) are required" });
  const link = await db.get(`LINK#${slug}`, "META");
  if (!link) return json(404, { error: "unknown slug" });
  if (b.eventId) {
    const dedupeKey = `EVENTID#${String(b.eventId).slice(0, 80)}`;
    if (await db.get(P(link.productId), dedupeKey)) return json(200, { ok: true, duplicate: true });
    await db.put({ pk: P(link.productId), sk: dedupeKey, type: "dedupe", ttl: Math.floor(Date.now() / 1000) + 90 * 86400 });
  }
  const value = Math.max(0, Number(b.value) || 0);
  const add = kind === "payment" ? { payments: 1, revenue: value } : { signups: 1 };
  await db.update(P(link.productId), `EXP#${link.experimentId}`, {}, add);
  await db.put({
    pk: P(link.productId),
    sk: `EVENT#${now()}#${id(6)}`,
    type: "event",
    event: kind,
    value,
    experimentId: link.experimentId,
    ttl: Math.floor(Date.now() / 1000) + 180 * 86400,
  });
  return json(200, { ok: true });
}

// ---------------------------------------------------------------- public try-it scans
// Anyone can scan one product URL. Capped per day (cost) and per IP (abuse); results are read-only.
const today = () => new Date().toISOString().slice(0, 10);
function clientIp(event) {
  return event.requestContext?.http?.sourceIp || event.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
}

async function publicScan(event) {
  const b = body(event);
  const url = String(b.url ?? "").trim();
  if (!url || !isPublicHttpUrl(url)) return json(400, { error: "Enter a public product URL, like https://yourapp.com" });
  const ipKey = createHash("sha256").update(clientIp(event)).digest("hex").slice(0, 16);
  const day = today();
  const ip = await db.update(`RATE#ip#${ipKey}`, day, { ttl: Math.floor(Date.now() / 1000) + 3 * 86400 }, { n: 1 });
  if (ip.n > settings.publicScansPerIp) return json(429, { error: `You've used today's ${settings.publicScansPerIp} free scans. Try again tomorrow.` });
  const all = await db.update("RATE#public", day, { ttl: Math.floor(Date.now() / 1000) + 3 * 86400 }, { n: 1 });
  if (all.n > settings.publicScansPerDay) return json(429, { error: "Today's free scans are used up. Watch the live demo, or try again tomorrow." });

  const pid = id(10);
  const createdAt = now();
  const product = {
    pk: P(pid),
    sk: "META",
    gsi1pk: "PUBLIC",
    gsi1sk: createdAt,
    type: "product",
    id: pid,
    public: true,
    name: new URL(url).hostname,
    url,
    notes: String(b.notes ?? "").slice(0, 600),
    apiBase: apiBaseFrom(event),
    stage: "queued",
    createdAt,
  };
  await db.put(product);
  await enqueue({ type: "product_card", productId: pid, chain: ["radar", "plan"], apiBase: product.apiBase });
  return json(202, { id: pid });
}

async function publicView(pid) {
  const res = await getProduct(pid);
  if (res.statusCode !== 200) return res;
  const data = JSON.parse(res.body);
  if (pid !== settings.demoProductId && !data.product.public) return json(404, { error: "not found" });
  delete data.events;
  data.jobs = data.jobs.filter((j) => j.status !== "error");
  return json(200, { ...data, demo: true });
}

// ---------------------------------------------------------------- owner routes
async function listProducts() {
  const rows = await db.queryGsi("PRODUCTS", "", { reverse: true });
  return json(200, { products: rows.map(strip) });
}

async function createProduct(event) {
  const b = body(event);
  const url = String(b.url ?? "").trim();
  if (url && !isPublicHttpUrl(url)) return json(400, { error: "url must be a public http(s) URL" });
  if (!url && !b.notes) return json(400, { error: "give a product URL or a description" });
  const pid = id(10);
  const createdAt = now();
  const product = {
    pk: P(pid),
    sk: "META",
    gsi1pk: "PRODUCTS",
    gsi1sk: createdAt,
    type: "product",
    id: pid,
    name: String(b.name ?? "").slice(0, 80) || (url ? new URL(url).hostname : "New product"),
    url,
    notes: String(b.notes ?? "").slice(0, 4000),
    apiBase: apiBaseFrom(event),
    stage: "queued",
    createdAt,
  };
  await db.put(product);
  await enqueue({ type: "product_card", productId: pid, chain: ["radar", "plan"], apiBase: product.apiBase });
  return json(201, { product: strip(product) });
}

async function getProduct(pid) {
  const rows = await db.query(P(pid));
  const meta = rows.find((r) => r.sk === "META");
  if (!meta) return json(404, { error: "not found" });
  const pick = (prefix) => rows.filter((r) => r.sk.startsWith(prefix)).map(strip);
  return json(200, {
    product: strip(meta),
    signals: pick("SIGNAL#").sort((a, b) => b.intent - a.intent),
    clusters: pick("CLUSTER#").sort((a, b) => b.intensity - a.intensity),
    intermediaries: pick("INTERMEDIARY#"),
    experiments: pick("EXP#").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    jobs: pick("JOB#").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 30),
    events: pick("EVENT#").slice(-200),
  });
}

async function runStep(pid, event) {
  const { step } = body(event);
  const map = { card: "product_card", radar: "radar", plan: "plan", measure: "measure", all: "product_card" };
  const type = map[step];
  if (!type) return json(400, { error: "step must be card|radar|plan|measure|all" });
  const product = await db.get(P(pid), "META");
  if (!product) return json(404, { error: "not found" });
  const job = await enqueue({ type, productId: pid, chain: step === "all" ? ["radar", "plan"] : [], apiBase: apiBaseFrom(event) });
  return json(202, { jobId: job.jobId });
}

async function patchProduct(pid, event) {
  const b = body(event);
  const set = {};
  if (typeof b.adPermissionConfirmed === "boolean") set.adPermissionConfirmed = b.adPermissionConfirmed;
  if (typeof b.notes === "string") set.notes = b.notes.slice(0, 4000);
  if (typeof b.name === "string") set.name = b.name.slice(0, 80);
  const p = await db.update(P(pid), "META", set);
  return json(200, { product: strip(p) });
}

async function startExperiment(pid, eid) {
  const e = await db.get(P(pid), `EXP#${eid}`);
  if (!e) return json(404, { error: "not found" });
  if (e.status === "blocked_policy") return json(409, { error: "Ad-policy permission required before this experiment can start" });
  const updated = await db.update(P(pid), `EXP#${eid}`, { status: "running", startedAt: e.startedAt ?? now() });
  return json(200, { experiment: strip(updated) });
}

async function updateDraft(pid, eid, did, event) {
  const b = body(event);
  const e = await db.get(P(pid), `EXP#${eid}`);
  if (!e) return json(404, { error: "not found" });
  const drafts = e.drafts.map((d) => {
    if (d.id !== did) return d;
    const next = { ...d };
    if (["approved", "posted", "skipped", "pending_approval"].includes(b.status)) next.status = b.status;
    if (typeof b.text === "string") next.text = b.text.slice(0, 3000);
    if (typeof b.postedUrl === "string") next.postedUrl = b.postedUrl.slice(0, 500);
    if (next.status === "posted") next.postedAt = d.postedAt ?? now();
    return next;
  });
  const set = { drafts };
  if (drafts.some((d) => d.status === "posted") && e.status === "draft") {
    set.status = "running";
    set.startedAt = now();
  }
  const updated = await db.update(P(pid), `EXP#${eid}`, set);
  return json(200, { experiment: strip(updated), intentUrl: threadsIntentUrl(drafts.find((d) => d.id === did)?.text ?? "") });
}

async function publishDraft(pid, eid, did) {
  const e = await db.get(P(pid), `EXP#${eid}`);
  const d = e?.drafts?.find((x) => x.id === did);
  if (!d) return json(404, { error: "not found" });
  if (d.status !== "approved") return json(409, { error: "Approve the draft before publishing" });
  if (d.targetUrl) return json(409, { error: "Replies are posted by you from the Threads app; open the target post and paste the text." });
  const pub = await publishThreads(d.text);
  return updateDraft(pid, eid, did, { body: JSON.stringify({ status: "posted", postedUrl: pub.permalink ?? "" }) });
}

async function addMetrics(pid, eid, event) {
  const b = body(event);
  const add = {};
  for (const f of ["spend", "signups", "payments", "revenue", "clicks"]) {
    const n = Number(b[f]);
    if (Number.isFinite(n) && n !== 0) add[f] = n;
  }
  const e = await db.update(P(pid), `EXP#${eid}`, {}, add);
  return json(200, { experiment: strip(e) });
}

// ---------------------------------------------------------------- router
export async function route(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  const path = (event.rawPath ?? event.path ?? "/").replace(/\/+$/, "") || "/";
  const parts = path.split("/").filter(Boolean);

  if (method === "OPTIONS") return { statusCode: 204, headers: {}, body: "" };
  if (path === "/health") return json(200, { ok: true, mock: settings.mock });
  if (parts[0] === "r" && parts[1] && method === "GET") return redirect(parts[1], event);
  if (path === "/e" && method === "POST") return conversion(event);
  if (path === "/t.js") return { statusCode: 200, headers: { "content-type": "application/javascript", "cache-control": "public, max-age=3600" }, body: SNIPPET(apiBaseFrom(event)) };
  if (parts[0] === "assets" && method === "GET") {
    const asset = await getAsset(parts.slice(1).join("/"));
    if (!asset) return json(404, { error: "not found" });
    return { statusCode: 200, headers: { "content-type": asset.contentType, "cache-control": "public, max-age=86400" }, body: asset.body.toString("base64"), isBase64Encoded: true };
  }

  // Read-only public demo: one showcase product chosen by the owner, plus the anonymous bank.
  if (parts[0] === "demo") {
    if (parts[1] === "scan" && method === "POST") return publicScan(event);
    if (method !== "GET") return json(404, { error: "not found" });
    if (parts[1] === "bank") return json(200, await bankOverview());
    if (parts[1] === "p" && parts[2]) return publicView(parts[2]);
    if (!settings.demoProductId) return json(404, { error: "no demo configured" });
    return publicView(settings.demoProductId);
  }

  if (parts[0] !== "api") return json(404, { error: "not found" });
  if (!(await authorised(event))) return json(401, { error: "unauthorised" });

  const [, a, b, c, d, e2, f] = parts;
  if (a === "products" && !b && method === "GET") return listProducts();
  if (a === "products" && !b && method === "POST") return createProduct(event);
  if (a === "products" && b && !c && method === "GET") return getProduct(b);
  if (a === "products" && b && !c && method === "PATCH") return patchProduct(b, event);
  if (a === "products" && b && c === "run" && method === "POST") return runStep(b, event);
  if (a === "experiments" && b && c && d === "start" && method === "POST") return startExperiment(b, c);
  if (a === "experiments" && b && c && d === "metrics" && method === "POST") return addMetrics(b, c, event);
  if (a === "experiments" && b && c && d === "drafts" && e2 && !f && method === "POST") return updateDraft(b, c, e2, event);
  if (a === "experiments" && b && c && d === "drafts" && e2 && f === "publish" && method === "POST") return publishDraft(b, c, e2);
  if (a === "bank" && method === "GET") return json(200, await bankOverview());
  return json(404, { error: "not found" });
}

export async function handler(event) {
  try {
    return await route(event);
  } catch (err) {
    console.error(err);
    return json(500, { error: "internal error" });
  }
}
