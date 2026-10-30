// Agent jobs. Each job is idempotent-ish and writes its trace so the dashboard can show
// exactly which models and tools the agent used.
//
// product_card -> radar -> plan -> (creative)        "full_run" chain
// measure: verdicts for running experiments + traction bank update

import { db, id, now } from "../lib/db.mjs";
import { settings } from "../lib/config.mjs";
import { respond, agent, image, openWeights, Trace } from "../lib/meta.mjs";
import { searchThreads, threadsAvailable } from "../lib/threads.mjs";
import { fetchPageText, isPublicHttpUrl } from "../lib/web.mjs";
import { checkAdPolicy } from "../lib/adpolicy.mjs";
import { priors, recordOutcome } from "../lib/bank.mjs";
import { putAsset } from "../lib/assets.mjs";
import { enqueue } from "../lib/queue.mjs";
import {
  productCardSchema,
  signalScoreSchema,
  clustersSchema,
  experimentsSchema,
  verdictSchema,
} from "../lib/schemas.mjs";

const P = (pid) => `PRODUCT#${pid}`;

// A signal must point at the actual post/page, never at a search-results page the model made up.
const SEARCH_PAGE = /(youtube\.com\/results|google\.[a-z.]+\/search|bing\.com\/search|duckduckgo\.com\/|search\.yahoo\.|[?&](q|query|search_query|keyword)=)/i;
// A draft can only be a reply where a public reply is possible; otherwise it becomes a new post.
const NOT_REPLYABLE = /(play\.google\.com|apps\.apple\.com|justuseapp|appbrain|apkpure|apkcombo|similarweb|trustpilot|g2\.com|capterra)/i;
export function draftTarget(channel, url) {
  const u = String(url ?? "").trim();
  if (!u || channel === "threads_post" || channel === "ad_test") return "";
  if (!isPublicHttpUrl(u) || NOT_REPLYABLE.test(u)) return "";
  if (channel === "threads_reply" && sourceOf(u) !== "threads") return "";
  return u;
}

// Threads posts found through web search still count as Threads demand.
export function sourceOf(url, fallback = "web") {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    if (h === "threads.com" || h === "threads.net") return "threads";
    if (h.endsWith("reddit.com")) return "reddit";
  } catch {}
  return fallback;
}

export function isPostUrl(url) {
  if (!url || !isPublicHttpUrl(url)) return false;
  return !SEARCH_PAGE.test(url);
}

// Lambda allows 900 s; leave room for scoring, clustering and writes after the agent loop.
const RADAR_AGENT_BUDGET_MS = 6 * 60 * 1000;

async function loadProduct(pid) {
  const p = await db.get(P(pid), "META");
  if (!p) throw new Error(`product ${pid} not found`);
  return p;
}

async function setJob(job, fields) {
  if (!job.productId) return;
  await db.update(P(job.productId), `JOB#${job.enqueuedAt}#${job.jobId}`, { ...fields, updatedAt: now() });
}

export async function runJob(job) {
  const handler = JOBS[job.type];
  if (!handler) throw new Error(`unknown job type ${job.type}`);
  const trace = new Trace();
  await setJob(job, { status: "running", startedAt: now() });
  try {
    const result = await handler(job, trace);
    await setJob(job, { status: "done", finishedAt: now(), trace: trace.steps, summary: result?.summary ?? "" });
    if (job.chain?.length) {
      const [next, ...rest] = job.chain;
      await enqueue({ type: next, productId: job.productId, chain: rest, apiBase: job.apiBase });
    }
    return result;
  } catch (err) {
    console.error(job.type, err);
    await setJob(job, { status: "error", finishedAt: now(), error: String(err.message || err).slice(0, 1000), trace: trace.steps });
    if (job.productId) await db.update(P(job.productId), "META", { stage: "error", stageError: String(err.message || err).slice(0, 500) });
    throw err;
  }
}

// ------------------------------------------------------------------ product card
async function productCard(job, trace) {
  const product = await loadProduct(job.productId);
  await db.update(P(product.id), "META", { stage: "reading_product" });
  let page = { title: "", description: "", text: "" };
  if (product.url && isPublicHttpUrl(product.url)) {
    try {
      page = await fetchPageText(product.url);
      trace.add({ kind: "tool", name: "fetch_page", args: { url: product.url }, resultSize: page.text.length });
    } catch (e) {
      trace.add({ kind: "tool", name: "fetch_page", args: { url: product.url }, error: e.message });
    }
  }
  const r = await respond({
    name: "product_card",
    model: settings.metaFastModel,
    webSearch: true,
    effort: "medium",
    trace,
    instructions:
      "You are a growth analyst. Build an honest product card for a founder who has users = 0. " +
      "Use the landing page text first; use web search only to fill gaps such as pricing or what the product is. " +
      "search_phrases must be phrases real frustrated people would type in a social post BEFORE knowing this product exists " +
      "(describe the pain, not the product), in the market language. Never invent traction or features.",
    input:
      `Product URL: ${product.url || "(none)"}\n` +
      `Founder notes: ${product.notes || "(none)"}\n\n` +
      `Landing page title: ${page.title}\nMeta description: ${page.description}\n\nLanding page text:\n${page.text}`,
    schema: productCardSchema,
  });
  const card = r.json;
  const adPolicy = checkAdPolicy(
    [card.one_liner, card.problem, card.category, page.text.slice(0, 4000), product.notes ?? ""].join(" "),
    card.restricted_ad_categories,
  );
  await db.update(P(product.id), "META", {
    card,
    adPolicy,
    name: card.name || product.name,
    stage: "card_ready",
    cardSources: r.citations.slice(0, 10),
  });
  return { summary: `${card.name}: ${card.category}, ${adPolicy.length} ad-policy flags` };
}

// ------------------------------------------------------------------ radar
async function radar(job, trace) {
  const product = await loadProduct(job.productId);
  const card = product.card;
  if (!card) throw new Error("run product_card first");
  await db.update(P(product.id), "META", { stage: "scanning_demand" });

  const found = new Map(); // url|text -> signal
  const intermediaries = [];
  const threadsOn = await threadsAvailable();
  const threadsNotes = [];

  const tools = [
    {
      name: "search_threads",
      description:
        "Search public Threads posts by keyword (official Threads API). Use short phrases in the market language, 1-4 words work best. Returns up to 50 posts.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          search_type: { type: "string", enum: ["RECENT", "TOP"] },
        },
        required: ["query", "search_type"],
        additionalProperties: false,
      },
      run: async ({ query, search_type }) => {
        if (!threadsOn) return { posts: [], note: "Threads not connected; rely on web search." };
        const r = await searchThreads(query, { searchType: search_type || "RECENT" });
        if (r.note) threadsNotes.push(r.note);
        return { posts: r.posts.map((p) => ({ url: p.url, author: p.author, text: p.text.slice(0, 500), postedAt: p.postedAt })), note: r.note };
      },
    },
    {
      name: "record_signals",
      description:
        "Save public posts/pages where a real person describes the pain, asks for a solution, or complains about an alternative. Only public content. Quote their text exactly.",
      parameters: {
        type: "object",
        properties: {
          signals: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source: { type: "string", enum: ["threads", "web", "forum", "reddit", "other"] },
                url: { type: "string" },
                author: { type: "string" },
                text: { type: "string" },
              },
              required: ["source", "url", "author", "text"],
              additionalProperties: false,
            },
          },
        },
        required: ["signals"],
        additionalProperties: false,
      },
      run: async ({ signals }) => {
        let added = 0;
        let rejected = 0;
        for (const s of signals ?? []) {
          if (!s.text || s.text.length < 15) continue;
          if (!isPostUrl(s.url)) {
            rejected++;
            continue;
          }
          const key = s.url || s.text.slice(0, 80);
          if (found.has(key)) continue;
          found.set(key, { ...s, source: sourceOf(s.url, s.source), text: s.text.slice(0, 1500) });
          added++;
        }
        return {
          saved: added,
          total: found.size,
          ...(rejected ? { rejected, note: "Rejected entries whose url is a search-results page or not a public post/page. Only record URLs of the actual post." } : {}),
        };
      },
    },
    {
      name: "record_intermediaries",
      description: "Save communities, accounts, agencies, schools, associations or media that already gather the target audience.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string" },
                url: { type: "string" },
                why: { type: "string" },
              },
              required: ["name", "type", "url", "why"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
      run: async ({ items }) => {
        intermediaries.push(...(items ?? []));
        return { saved: items?.length ?? 0 };
      },
    },
  ];

  const result = await agent({
    name: "radar",
    trace,
    tools,
    webSearch: true,
    maxTurns: 8,
    effort: "medium",
    budgetMs: RADAR_AGENT_BUDGET_MS,
    instructions:
      "You are a demand scout for an app that has zero users. Find REAL people in public who have the problem it solves, " +
      "and the intermediaries who already gather them. Process: (1) run search_threads with 4-8 of the provided phrases and variations, " +
      "(2) use web search for public Threads posts first (queries like `site:threads.com <phrase>` for 2-4 phrases), then forums, Q&A sites, Reddit, Kaskus, Quora, Lemon8, Facebook pages and articles' comment threads, " +
      "(3) call record_signals after EVERY search round (not only at the end) with each relevant post you saw: exact text, the URL of that specific post or page (never a search-results URL), public handle, " +
      "(4) call record_intermediaries. Aim for 25-60 signals. Skip ads, brand posts and the product's own posts. " +
      "Do not collect private data beyond the public handle. When done, reply with one short paragraph of what you found.",
    input: JSON.stringify({
      product: { name: card.name, one_liner: card.one_liner, problem: card.problem, audience: card.audience, regions: card.regions, language: card.market_language },
      search_phrases: card.search_phrases,
    }),
  });

  // Also harvest raw web results the model saw but did not record, as low-confidence candidates.
  for (const r of result.searchResults ?? []) {
    const key = r.url;
    if (key && isPostUrl(key) && !found.has(key) && r.snippet && r.snippet.length > 40)
      found.set(key, { source: sourceOf(r.url, "web"), url: r.url, author: r.title ?? "", text: r.snippet.slice(0, 800), harvested: true });
  }

  const raw = [...found.values()].slice(0, 120);
  await db.update(P(product.id), "META", { stage: "scoring_intent" });

  // Bulk intent scoring on open weights (Muse Spark Open), in batches.
  const scored = [];
  for (let i = 0; i < raw.length; i += 15) {
    const batch = raw.slice(i, i + 15);
    const r = await openWeights({
      name: "score_signals",
      trace,
      schema: signalScoreSchema,
      system:
        "You score social posts for purchase intent toward a product category. Be strict: brand posts, ads, news and jokes are 'irrelevant' with intent < 10. " +
        "Copy phrases exactly from the post.",
      user: JSON.stringify({
        product_problem: card.problem,
        audience: card.audience.map((a) => a.segment),
        posts: batch.map((p, idx) => ({ index: idx, text: p.text })),
      }),
    });
    for (const s of r.json?.scores ?? []) {
      const post = batch[s.index];
      if (!post) continue;
      scored.push({ ...post, intent: s.intent, stage: s.stage, painPoint: s.pain_point, phrases: s.phrases });
    }
  }
  const relevant = scored.filter((s) => s.stage !== "irrelevant" && s.intent >= 20).sort((a, b) => b.intent - a.intent);

  // Cluster + intermediary offers.
  let clusters = { clusters: [], intermediaries: [] };
  if (relevant.length) {
    const r = await respond({
      name: "cluster_signals",
      model: settings.metaFastModel,
      effort: "medium",
      trace,
      schema: clustersSchema,
      instructions:
        "Group the scored posts into pain-point clusters a founder can act on. exact_phrases must be verbatim from posts. " +
        "For intermediaries, merge the candidates given and propose a concrete, honest win-win offer for each.",
      input: JSON.stringify({
        product: { name: card.name, one_liner: card.one_liner },
        posts: relevant.map((s, i) => ({ index: i, intent: s.intent, stage: s.stage, text: s.text.slice(0, 400) })),
        intermediary_candidates: intermediaries,
      }),
    });
    clusters = r.json;
  }

  // Persist (replace previous radar results).
  for (const prefix of ["SIGNAL#", "CLUSTER#", "INTERMEDIARY#"])
    for (const old of await db.query(P(product.id), prefix)) await db.del(old.pk, old.sk);

  const signalIds = [];
  for (const s of relevant) {
    const sid = id(8);
    signalIds.push(sid);
    await db.put({ pk: P(product.id), sk: `SIGNAL#${sid}`, type: "signal", id: sid, ...s, createdAt: now() });
  }
  for (const c of clusters.clusters) {
    const cid = id(8);
    await db.put({
      pk: P(product.id),
      sk: `CLUSTER#${cid}`,
      type: "cluster",
      id: cid,
      label: c.label,
      summary: c.summary,
      intensity: c.intensity,
      exactPhrases: c.exact_phrases,
      signalIds: c.signal_indexes.map((i) => signalIds[i]).filter(Boolean),
    });
  }
  for (const m of clusters.intermediaries) {
    const mid = id(8);
    await db.put({ pk: P(product.id), sk: `INTERMEDIARY#${mid}`, type: "intermediary", id: mid, ...m });
  }
  await db.update(P(product.id), "META", {
    stage: "radar_ready",
    radarStats: {
      candidates: raw.length,
      relevant: relevant.length,
      clusters: clusters.clusters.length,
      intermediaries: clusters.intermediaries.length,
      threadsConnected: threadsOn,
      threadsNotes: [...new Set(threadsNotes)].slice(0, 3),
      agentSummary: result.text?.slice(0, 1200) ?? "",
      at: now(),
    },
  });
  return { summary: `${relevant.length}/${raw.length} relevant signals, ${clusters.clusters.length} clusters` };
}

// ------------------------------------------------------------------ plan experiments
export function trackingUrl(apiBase, slug) {
  return `${(apiBase || process.env.API_BASE_URL || settings.publicSiteUrl).replace(/\/$/, "")}/r/${slug}`;
}

async function plan(job, trace) {
  const product = await loadProduct(job.productId);
  const card = product.card;
  await db.update(P(product.id), "META", { stage: "planning" });
  const clusters = await db.query(P(product.id), "CLUSTER#");
  const intermediaries = await db.query(P(product.id), "INTERMEDIARY#");
  const signals = (await db.query(P(product.id), "SIGNAL#")).sort((a, b) => b.intent - a.intent).slice(0, 25);
  const past = await db.query(P(product.id), "EXP#");
  const bank = await priors(card.category);

  const r = await respond({
    name: "plan_experiments",
    effort: "high",
    trace,
    schema: experimentsSchema,
    instructions:
      "You are a growth lead for a founder with no users and little budget. Design exactly 3 small experiments for the next 7 days. " +
      "Rules: use the users' own words (exact phrases) in angles; drafts must be genuinely helpful, disclose that the author built the product, " +
      "never fake testimonials, never spam the same text to many people, at most 5 drafts per experiment; reply drafts must answer the person's actual post. " +
      "Use the traction bank priors: prefer channels/angles that won for similar products, but keep one exploratory bet. " +
      "Do not repeat experiments that were killed before. If the product is in a restricted ad category, do not plan ad_test unless approval is confirmed. " +
      "The 3 experiments MUST use 3 different channels and at least 2 different angle_type values, so the week tests distinct hypotheses. " +
      "Write drafts ready to send as-is: no placeholders like [nama] or [name]; refer to the author as 'the founder of <product name>' in the market language. " +
      "Draft targets must be postable: threads_post and ad_test drafts are NEW posts (target_url ''); threads_reply drafts target a Threads post URL; " +
      "community_post replies may only target a discussion URL from top_signals where anyone can reply (Threads, Reddit, Lemon8, Quora, Kaskus, a forum thread) — " +
      "never app-store pages, review aggregators or news articles; when no such URL exists, write a new post for that community and leave target_url ''.",
    input: JSON.stringify({
      product: card,
      ad_policy_flags: product.adPolicy,
      ad_permission_confirmed: !!product.adPermissionConfirmed,
      clusters: clusters.map((c) => ({ label: c.label, summary: c.summary, intensity: c.intensity, exact_phrases: c.exactPhrases })),
      top_signals: signals.map((s) => ({ url: s.url, author: s.author, text: s.text.slice(0, 300), intent: s.intent })),
      intermediaries: intermediaries.map((m) => ({ name: m.name, type: m.type, url: m.url, offer: m.offer })),
      past_experiments: past.filter((e) => e.status !== "superseded").map((e) => ({ title: e.title, channel: e.channel, angle_type: e.angle_type, verdict: e.verdict?.verdict, clicks: e.clicks ?? 0, signups: e.signups ?? 0 })),
      traction_bank_priors: bank,
    }),
  });

  // Experiments that never started are replaced by the new plan instead of piling up.
  for (const e of past)
    if (e.status === "draft" && !(e.drafts ?? []).some((d) => d.status === "posted"))
      await db.update(P(product.id), e.sk, { status: "superseded" });

  // Guard against the model ignoring the diversity rule: keep the first experiment per channel.
  const seenChannels = new Set();
  const picked = r.json.experiments.filter((e) => !seenChannels.has(e.channel) && seenChannels.add(e.channel));
  for (const e of r.json.experiments) if (picked.length < 3 && !picked.includes(e)) picked.push(e);
  const created = [];
  for (const e of picked.slice(0, 3)) {
    const eid = id(8);
    const slug = id(7);
    const link = trackingUrl(job.apiBase || product.apiBase, slug);
    await db.put({ pk: `LINK#${slug}`, sk: "META", type: "link", slug, productId: product.id, experimentId: eid, target: product.url });
    const blocked = e.channel === "ad_test" && product.adPolicy?.length && !product.adPermissionConfirmed;
    const exp = {
      pk: P(product.id),
      sk: `EXP#${eid}`,
      type: "experiment",
      id: eid,
      slug,
      link,
      title: e.title,
      channel: e.channel,
      angle: e.angle,
      angle_type: e.angle_type,
      targetCluster: e.target_cluster,
      hypothesis: e.hypothesis,
      successMetric: e.success_metric,
      successThreshold: e.success_threshold,
      priorEvidence: e.prior_evidence,
      drafts: e.drafts.map((d) => ({
        id: id(6),
        targetUrl: draftTarget(e.channel, d.target_url),
        text: d.text.replaceAll("{link}", link).replace(/\[(nama|name|nama anda|your name)\]/gi, card.name ? `founder ${card.name}` : "founder"),
        status: "pending_approval",
      })),
      status: blocked ? "blocked_policy" : "draft",
      clicks: 0,
      signups: 0,
      payments: 0,
      revenue: 0,
      spend: 0,
      createdAt: now(),
    };
    await db.put(exp);
    created.push(exp);
    if (e.channel === "ad_test" && !blocked) await enqueue({ type: "creative", productId: product.id, experimentId: eid });
  }
  await db.update(P(product.id), "META", { stage: "experiments_ready" });
  return { summary: created.map((e) => `${e.channel}: ${e.title}`).join(" | ") };
}

// ------------------------------------------------------------------ creative (Muse Image)
async function creative(job, trace) {
  const product = await loadProduct(job.productId);
  const exp = await db.get(P(product.id), `EXP#${job.experimentId}`);
  if (!exp) throw new Error("experiment not found");
  const prompt =
    `Clean, modern social ad visual for "${product.card?.name}", ${product.card?.one_liner}. ` +
    `Message angle: ${exp.angle}. Show the situation of the audience (${product.card?.audience?.[0]?.segment ?? "users"}) ` +
    `in a realistic, warm, trustworthy style. No text in the image, no logos, no faces in close-up, square 1:1, high contrast focal point.`;
  const img = await image({ prompt, trace });
  let key = "";
  if (img.b64) key = await putAsset(`creatives/${product.id}/${exp.id}.png`, Buffer.from(img.b64, "base64"));
  await db.update(P(product.id), `EXP#${exp.id}`, { creative: { key, url: img.url ?? "", prompt, at: now() } });
  return { summary: "creative generated" };
}

// ------------------------------------------------------------------ measure + verdict + bank
async function measure(job, trace) {
  const product = await loadProduct(job.productId);
  const exps = (await db.query(P(product.id), "EXP#")).filter((e) => ["running", "decided"].includes(e.status));
  for (const e of exps) {
    const days = e.startedAt ? Math.max(0, (Date.now() - Date.parse(e.startedAt)) / 86400000) : 0;
    const r = await respond({
      name: "verdict",
      model: settings.metaFastModel,
      effort: "medium",
      trace,
      schema: verdictSchema,
      instructions:
        "Judge a 7-day growth experiment for an early product. Be numerate and conservative: fewer than ~30 clicks or 2 days is usually needs_more_data. " +
        "ready_for_ads only if the angle converts clicks to signups/payments clearly better than the others and the product has no unresolved ad-policy flag.",
      input: JSON.stringify({
        experiment: {
          title: e.title,
          channel: e.channel,
          angle: e.angle,
          hypothesis: e.hypothesis,
          successMetric: e.successMetric,
          successThreshold: e.successThreshold,
          postedDrafts: (e.drafts ?? []).filter((d) => d.status === "posted").length,
        },
        results: { days: +days.toFixed(1), clicks: e.clicks, signups: e.signups, payments: e.payments, revenue: e.revenue, spend: e.spend },
        siblings: exps.filter((x) => x.id !== e.id).map((x) => ({ channel: x.channel, angle_type: x.angle_type, clicks: x.clicks, signups: x.signups, payments: x.payments })),
        ad_policy_flags: product.adPolicy,
        ad_permission_confirmed: !!product.adPermissionConfirmed,
      }),
    });
    const verdict = { ...r.json, at: now() };
    const updated = await db.update(P(product.id), `EXP#${e.id}`, {
      verdict,
      days: +days.toFixed(1),
      status: verdict.verdict === "needs_more_data" || verdict.verdict === "keep" ? "running" : "decided",
    });
    await recordOutcome({ product, experiment: updated });
    if (verdict.verdict === "ready_for_ads" && !e.creative) await enqueue({ type: "creative", productId: product.id, experimentId: e.id });
  }
  return { summary: `${exps.length} experiments judged` };
}

const JOBS = {
  product_card: productCard,
  radar,
  plan,
  creative,
  measure,
};
