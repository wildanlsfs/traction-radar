// End-to-end test of the API + agent pipeline in mock mode (MOCK_LLM=1 DB=memory).
import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/handlers/api.mjs";

const call = async (method, path, body, headers = {}) => {
  const res = await route({
    rawPath: path,
    headers: { host: "localhost:8787", ...headers },
    requestContext: { http: { method } },
    body: body ? JSON.stringify(body) : "",
  });
  return { ...res, json: res.headers?.["content-type"]?.includes("json") ? JSON.parse(res.body) : null };
};
const waitFor = async (fn, ms = 5000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("full run: product -> card -> radar -> plan -> tracking -> verdict -> bank", async () => {
  const created = await call("POST", "/api/products", { url: "https://example.com", notes: "pengingat tagihan WA" });
  assert.equal(created.statusCode, 201);
  const pid = created.json.product.id;

  const detail = await waitFor(async () => {
    const r = await call("GET", `/api/products/${pid}`);
    return r.json.product.stage === "experiments_ready" ? r.json : null;
  });
  assert.equal(detail.product.card.name, "TagihIn");
  assert.ok(detail.signals.length >= 5, "signals scored");
  assert.ok(detail.signals.every((s) => s.stage !== "irrelevant"), "ads filtered out");
  assert.equal(detail.clusters.length, 2);
  assert.equal(detail.experiments.length, 3);
  assert.ok(detail.jobs.every((j) => j.status === "done"), "all jobs done");
  assert.ok(detail.jobs.some((j) => j.trace?.some((s) => s.kind === "tool" && s.name === "search_threads")), "agent used threads tool");

  const exp = detail.experiments.find((e) => e.channel === "threads_post");
  assert.ok(exp.drafts[0].text.includes(`/r/${exp.slug}`), "tracking link injected");

  // approve + mark posted -> experiment starts
  const d = exp.drafts[0];
  let r = await call("POST", `/api/experiments/${pid}/${exp.id}/drafts/${d.id}`, { status: "approved" });
  assert.equal(r.json.experiment.drafts[0].status, "approved");
  r = await call("POST", `/api/experiments/${pid}/${exp.id}/drafts/${d.id}/publish`);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.experiment.status, "running");

  // clicks + conversions
  for (let i = 0; i < 30; i++) {
    const c = await call("GET", `/r/${exp.slug}`, null, { "user-agent": "Mozilla/5.0" });
    assert.equal(c.statusCode, 302);
    assert.match(c.headers.location, /tr=/);
  }
  const bot = await call("GET", `/r/${exp.slug}`, null, { "user-agent": "facebookexternalhit/1.1" });
  assert.equal(bot.statusCode, 302);
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/e", { slug: exp.slug, event: "signup" })).statusCode, 200);
  await call("POST", "/e", { slug: exp.slug, event: "payment", value: 29000, eventId: "ord-1" });
  const dup = await call("POST", "/e", { slug: exp.slug, event: "payment", value: 29000, eventId: "ord-1" });
  assert.equal(dup.json.duplicate, true);

  await call("POST", `/api/products/${pid}/run`, { step: "measure" });
  const judged = await waitFor(async () => {
    const x = (await call("GET", `/api/products/${pid}`)).json.experiments.find((e) => e.id === exp.id);
    return x.verdict ? x : null;
  });
  assert.equal(judged.clicks, 30, "bot click ignored");
  assert.equal(judged.signups, 5);
  assert.equal(judged.payments, 1);
  assert.equal(judged.revenue, 29000);
  assert.equal(judged.verdict.verdict, "ready_for_ads");

  const creativeDone = await waitFor(async () => {
    const x = (await call("GET", `/api/products/${pid}`)).json.experiments.find((e) => e.id === exp.id);
    return x.creative?.key ? x : null;
  });
  const img = await call("GET", `/assets/${creativeDone.creative.key}`);
  assert.equal(img.statusCode, 200);

  const bank = await call("GET", "/api/bank");
  assert.ok(bank.json.outcomes >= 1);
  assert.ok(!JSON.stringify(bank.json).includes("example.com"), "bank is anonymised");

  const js = await call("GET", "/t.js");
  assert.match(js.body, /TractionRadar/);
});

test("rejects private URLs and unknown slugs", async () => {
  assert.equal((await call("POST", "/api/products", { url: "http://169.254.169.254/latest" })).statusCode, 400);
  assert.equal((await call("GET", "/r/nope")).statusCode, 404);
  assert.equal((await call("POST", "/e", { slug: "nope", event: "signup" })).statusCode, 404);
});

test("signal URLs must be real posts, not search pages", async () => {
  const { isPostUrl } = await import("../src/jobs/index.mjs");
  assert.equal(isPostUrl("https://www.youtube.com/results?search_query=gagal+taaruf"), false);
  assert.equal(isPostUrl("https://www.google.com/search?q=x"), false);
  assert.equal(isPostUrl("http://127.0.0.1/x"), false);
  assert.equal(isPostUrl("https://www.threads.com/@a/post/abc"), true);
  assert.equal(isPostUrl("https://play.google.com/store/apps/details?id=taarufapp.id"), true);
  const { sourceOf } = await import("../src/jobs/index.mjs");
  assert.equal(sourceOf("https://www.threads.com/@a/post/abc"), "threads");
  assert.equal(sourceOf("https://threads.net/@a/post/abc", "forum"), "threads");
  assert.equal(sourceOf("https://kaskus.co.id/thread/x", "forum"), "forum");
  const { draftTarget } = await import("../src/jobs/index.mjs");
  assert.equal(draftTarget("threads_post", "https://aboutislam.net/x"), "");
  assert.equal(draftTarget("community_post", "https://www.justuseapp.com/en/app/x/reviews"), "");
  assert.equal(draftTarget("threads_reply", "https://www.reddit.com/r/x/comments/1"), "");
  assert.equal(draftTarget("threads_reply", "https://www.threads.com/@a/post/1"), "https://www.threads.com/@a/post/1");
  assert.equal(draftTarget("community_post", "https://www.lemon8-app.com/u/1"), "https://www.lemon8-app.com/u/1");
  assert.equal(draftTarget("community_post", "https://researchhub.id/index.php/jimek/article/download/5894/3346"), "");
  assert.equal(draftTarget("community_post", "https://www.karyapelaut.com/2021/02/pertanyaan-interview-pelaut.html"), "");
  assert.equal(draftTarget("community_post", "https://forum.example.org/t/pelaut-interview/12"), "https://forum.example.org/t/pelaut-interview/12");
  assert.equal(draftTarget("intermediary_outreach", "https://www.karyapelaut.com/"), "https://www.karyapelaut.com/");
});

test("public scans are capped, read-only, and never expose owner products", async () => {
  const owner = (await call("POST", "/api/products", { url: "https://owner.example.com" })).json.product.id;
  assert.equal((await call("GET", `/demo/p/${owner}`)).statusCode, 404);
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const r = await call("POST", "/demo/scan", { url: `https://try${i}.example.com` });
    assert.equal(r.statusCode, 202);
    ids.push(r.json.id);
  }
  assert.equal((await call("POST", "/demo/scan", { url: "https://try3.example.com" })).statusCode, 429);
  assert.equal((await call("POST", "/demo/scan", { url: "http://10.0.0.1" })).statusCode, 400);
  const view = await call("GET", `/demo/p/${ids[0]}`);
  assert.equal(view.statusCode, 200);
  assert.equal(view.json.demo, true);
  const listed = (await call("GET", "/api/products")).json.products.map((p) => p.id);
  assert.ok(!listed.includes(ids[0]), "public scans stay out of the owner's list");
});
