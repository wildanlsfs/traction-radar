// Traction Radar dashboard. Plain ES modules, no build step.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Escape, then highlight any exact phrase the clustering step pulled out of this text.
const hl = (text, phrases) => {
  let out = esc(text);
  for (const ph of [...new Set(phrases)].filter((x) => x && x.length > 3).sort((a, b) => b.length - a.length)) {
    const e = esc(ph).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?![^<]*>)${e}`, "i"), (m) => `<mark>${m}</mark>`);
  }
  return out;
};

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const cfg = () => ({ api: store.get("tr_api", ""), token: store.get("tr_token", "") });
// Demo mode: read-only view of one showcase product, no token needed.
const isDemo = () => document.body.classList.contains("demo");
const setDemo = (on) => { document.body.classList.toggle("demo", on); store.set("tr_demo", on); };
let demoSrc = "/demo"; // what a read-only view loads: the showcase product or a visitor's free scan
let demoBase = "#/demo";
const isTry = () => demoBase.startsWith("#/try/");

async function api(path, { method = "GET", body } = {}) {
  const { api: base, token } = cfg();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-tr-token": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401)
    throw Object.assign(new Error(token ? "The access token was rejected. Check it in Settings." : "Add your access token in Settings first."), { status: 401 });
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}

const STEPS = [
  { key: "card", label: "Read the product", stages: ["queued", "reading_product"] },
  { key: "radar", label: "Scan public demand", stages: ["card_ready", "scanning_demand"] },
  { key: "score", label: "Score intent", stages: ["scoring_intent"] },
  { key: "plan", label: "Plan experiments", stages: ["radar_ready", "planning"] },
  { key: "measure", label: "Run and measure", stages: ["experiments_ready"] },
];
const ORDER = ["queued", "reading_product", "card_ready", "scanning_demand", "scoring_intent", "radar_ready", "planning", "experiments_ready"];
const BUSY = new Set(["queued", "reading_product", "scanning_demand", "scoring_intent", "planning"]);
const CHANNEL = {
  threads_post: "Threads post",
  threads_reply: "Replies on Threads",
  community_post: "Community post",
  intermediary_outreach: "Partner with an intermediary",
  ad_test: "Small Meta ad test",
};
const STATUS = { draft: "Awaiting approval", running: "Running", decided: "Decided", blocked_policy: "Needs ad permission" };
const VERDICT = { keep: "Keep going", kill: "Stop this one", ready_for_ads: "Ready for ads", needs_more_data: "Needs more data" };

// ---------------------------------------------------------------- rail
async function renderRail(activeId) {
  const nav = $("#productList");
  $("#railAuth").textContent = isDemo() ? "Sign in" : "Settings";
  $("#railAuth").href = isDemo() ? "#/signin" : "#/settings";
  if (isDemo()) {
    const mine = store.get("tr_try", "");
    nav.innerHTML = `<a href="#/demo" ${activeId === "demo" ? 'aria-current="page"' : ""}>${esc(railDemoName)}<small>Live demo · read-only</small></a>`
      + (mine ? `<a href="#/try/${esc(mine)}" ${activeId === mine ? 'aria-current="page"' : ""}>${esc(store.get("tr_try_name", "Your scan"))}<small>Your free scan</small></a>` : "")
      + `<a href="#/try" ${activeId === "try" ? 'aria-current="page"' : ""}>Try it on your product<small>Free scan, no account</small></a>`;
    return;
  }
  try {
    const { products } = await api("/api/products");
    nav.innerHTML = products.length
      ? products
          .map((p) => `<a href="#/p/${p.id}" ${p.id === activeId ? 'aria-current="page"' : ""}>${esc(p.name)}<small>${esc(stageText(p.stage))}</small></a>`)
          .join("")
      : "";
  } catch (e) {
    nav.innerHTML = e.status === 401 ? `<p class="hint">Add your access token in <a href="#/settings">Settings</a>.</p>` : "";
  }
}
function stageText(stage) {
  return (
    {
      queued: "Queued",
      reading_product: "Reading the product…",
      card_ready: "Product understood",
      scanning_demand: "Scanning conversations…",
      scoring_intent: "Scoring intent…",
      radar_ready: "Demand mapped",
      planning: "Planning experiments…",
      experiments_ready: "Experiments ready",
      error: "Needs attention",
    }[stage] ?? stage
  );
}

let railDemoName = store.get("tr_demo_name", "Live demo");

// ---------------------------------------------------------------- views
const view = () => $("#view");

function emptyView() {
  view().innerHTML = `
    <section class="empty">
      <h1>Your app is live. Where are its first users?</h1>
      <p>Give Traction Radar a product URL. It finds real people describing the problem you solve, maps where they gather, and plans three small experiments you can measure this week.</p>
      <button class="btn primary" id="emptyAdd">Add a product</button>
    </section>`;
  $("#emptyAdd").onclick = openNewProduct;
}

let pollTimer;
let renderGen = 0; // newest render wins: a slow background refresh must not overwrite a tab the user just opened
async function productView(pid, tab = "overview") {
  clearTimeout(pollTimer);
  const gen = ++renderGen;
  let data;
  try {
    data = await api(isDemo() ? demoSrc : `/api/products/${pid}`);
  } catch (e) {
    if (gen !== renderGen) return;
    view().innerHTML = `<section class="empty"><h1>Couldn't load this product</h1><p>${esc(e.message)}</p></section>`;
    return;
  }
  if (gen !== renderGen) return;
  const { product: p, signals, clusters, jobs, intermediaries } = data;
  const experiments = data.experiments.filter((e) => e.status !== "superseded");
  const base = isDemo() ? demoBase : `#/p/${pid}`;
  if (isDemo() && !isTry() && railDemoName !== (p.card?.name || p.name)) { railDemoName = p.card?.name || p.name; store.set("tr_demo_name", railDemoName); renderRail("demo"); }
  if (isTry() && store.get("tr_try", "") === pid && store.get("tr_try_name", "") !== (p.card?.name || p.name)) { store.set("tr_try_name", p.card?.name || p.name); renderRail(pid); }
  const card = p.card;
  const idx = ORDER.indexOf(p.stage);
  const stepState = (s) => {
    const first = ORDER.indexOf(s.stages[0]);
    const last = ORDER.indexOf(s.stages[s.stages.length - 1]);
    if (p.stage === "experiments_ready") return s.key === "measure" ? (experiments.some((e) => e.status === "running" || e.status === "decided") ? "active" : "") : "done";
    if (idx > last) return "done";
    if (idx >= first && idx <= last) return BUSY.has(p.stage) ? "active" : "done";
    return "";
  };
  const tabs = [
    ["overview", "Product"],
    ["demand", "Demand", signals.length],
    ["experiments", "Experiments", experiments.length],
    ["trace", "Agent trace", jobs.length],
  ];

  view().innerHTML = `
    ${isDemo() && !isTry() ? `<div class="demo-bar"><p><b>Live demo, read-only.</b> A real Traction Radar run on ${esc(p.card?.name || p.name)}, a live product. Posting, rescans and edits are switched off.</p><a class="btn" href="#/try">Try it on your product</a></div>` : ""}
    ${isTry() ? `<div class="demo-bar"><p><b>Your free scan, read-only.</b> ${BUSY.has(p.stage) ? "The agent is working. This page updates by itself; a full scan takes about 5–8 minutes." : p.stage === "error" ? "The scan stopped early. Try again with a short description of what the product does." : "Done. Bookmark this page to come back to it."}</p><a class="btn" href="#/demo">See the live demo</a></div>` : ""}
    <header class="head">
      <div>
        <h1>${esc(card?.name || p.name)}</h1>
        <p class="lede">${esc(card?.one_liner || p.notes || "Reading the product…")}</p>
        ${p.url ? `<a class="url" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a>` : ""}
      </div>
      ${card ? `<dl class="cartouche">
        <div><dt>Category</dt><dd>${esc(card.category.replaceAll("_", " "))}</dd></div>
        <div><dt>Market</dt><dd>${esc(card.regions.join(", "))} · ${esc(card.market_language)}</dd></div>
        <div><dt>Price</dt><dd>${esc(card.pricing)}</dd></div>
        <div><dt>Ad policy</dt><dd class="${(p.adPolicy ?? []).length ? "flag" : ""}">${(p.adPolicy ?? []).length ? esc(p.adPolicy.map((f) => f.label).join(", ")) : "No restriction found"}</dd></div>
      </dl>` : ""}
    </header>
    <div class="row actions">
        <button class="btn" data-run="radar" ${BUSY.has(p.stage) ? "disabled" : ""}>Rescan demand</button>
        <button class="btn" data-run="plan" ${BUSY.has(p.stage) || !clusters.length ? "disabled" : ""}>Plan new experiments</button>
        <button class="btn primary" data-run="measure" ${!experiments.some((e) => e.status === "running") ? "disabled" : ""}>Judge results now</button>
    </div>
    <ol class="course" aria-label="Progress">${STEPS.map((s) => `<li class="${stepState(s)}">${s.label}</li>`).join("")}</ol>
    ${p.stage === "error" ? `<div class="policy"><h3>The last step failed</h3><p>${esc(p.stageError)}</p><div class="row" style="margin-top:10px"><button class="btn" data-run="all">Run everything again</button></div></div>` : ""}
    <nav class="tabs">${tabs
      .map(([k, label, n]) => `<a href="${base}/${k}" ${k === tab ? 'aria-current="page"' : ""}>${label}${n !== undefined ? `<span class="count">${n}</span>` : ""}</a>`)
      .join("")}</nav>
    <div id="tab"></div>`;

  view().querySelectorAll("[data-run]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api(`/api/products/${pid}/run`, { method: "POST", body: { step: b.dataset.run } });
        toast(b.dataset.run === "measure" ? "Judging results…" : "Started");
        setTimeout(() => productView(pid, tab), 600);
      } catch (e) {
        toast(e.message);
        b.disabled = false;
      }
    }),
  );

  const el = $("#tab");
  if (tab === "overview") renderOverview(el, p, card, intermediaries);
  if (tab === "demand") renderDemand(el, signals, clusters, intermediaries, p);
  if (tab === "experiments") renderExperiments(el, pid, experiments, p);
  if (tab === "trace") renderTrace(el, jobs);

  if ((!isDemo() || isTry()) && (BUSY.has(p.stage) || jobs.some((j) => j.status === "queued" || j.status === "running"))) {
    pollTimer = setTimeout(async () => {
      if (location.hash.startsWith(base)) {
        const keepScroll = scrollY;
        await productView(pid, tab);
        scrollTo(0, keepScroll);
        renderRail(pid);
      }
    }, 2500);
  }
}

function renderOverview(el, p, card, intermediaries) {
  if (!card) {
    el.innerHTML = `<p class="hint">The agent is reading the landing page. This takes under a minute.</p>`;
    return;
  }
  const policy = p.adPolicy ?? [];
  el.innerHTML = `
    ${policy.length ? `<div class="policy">
        <h3>Check before you run ads</h3>
        ${policy.map((f) => `<p><strong>${esc(f.label)}.</strong> ${esc(f.requirement)} <a href="${esc(f.url)}" target="_blank" rel="noopener">Meta policy</a></p>`).join("")}
        <label class="row" style="flex-direction:row;font-weight:400;margin-top:10px"><input type="checkbox" id="permOk" ${p.adPermissionConfirmed ? "checked" : ""}/> I already have Meta's permission for this category</label>
      </div>` : ""}
    <section class="section">
      <h2>What the agent understood</h2>
      <p class="hint">Correct anything wrong in your notes and rescan; every later step builds on this.</p>
      <dl class="facts">
        <div><dt>Problem it solves</dt><dd>${esc(card.problem)}</dd></div>
        <div><dt>Category and price</dt><dd>${esc(card.category.replaceAll("_", " "))} · ${esc(card.pricing)}</dd></div>
        <div><dt>Markets</dt><dd>${esc(card.regions.join(", "))} (language: ${esc(card.market_language)})</dd></div>
        <div><dt>Jobs users hire it for</dt><dd>${card.jobs_to_be_done.map(esc).join("; ")}</dd></div>
      </dl>
    </section>
    <section class="section">
      <h2>Who it's for</h2>
      <ul class="list-plain">${card.audience.map((a) => `<li><h3>${esc(a.segment)}</h3><p class="hint">${esc(a.description)}</p></li>`).join("")}</ul>
    </section>
    <section class="section">
      <h2>Phrases people use before they know you exist</h2>
      <div class="phrases">${card.search_phrases.map((s) => `<span class="phrase">${esc(s)}</span>`).join("")}</div>
    </section>
    ${card.risks?.length ? `<section class="section"><h2>Trust risks on the landing page</h2><ul>${card.risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></section>` : ""}
    <section class="section">
      <h2>Measure signups and payments</h2>
      <p class="hint">Add this to your app once. Visitors from experiment links are attributed without cookies or personal data.</p>
      <div class="code">&lt;script src="${esc(cfg().api || location.origin)}/t.js" defer&gt;&lt;/script&gt;
// after a signup:   TractionRadar.signup()
// after a payment:  TractionRadar.payment(29000, "order-id")</div>
    </section>`;
  const perm = $("#permOk", el);
  if (perm)
    perm.onchange = async () => {
      await api(`/api/products/${p.id}`, { method: "PATCH", body: { adPermissionConfirmed: perm.checked } });
      toast(perm.checked ? "Ad tests unlocked for the next plan" : "Ad tests stay off");
    };
}

function renderDemand(el, signals, clusters, intermediaries, p) {
  if (!signals.length) {
    el.innerHTML = `<p class="hint">${BUSY.has(p.stage) ? "Scanning public conversations on Threads and the web…" : "No public posts with real intent were found yet. Add more detail to your notes and rescan."}</p>`;
    return;
  }
  const byId = Object.fromEntries(signals.map((s) => [s.id, s]));
  const phrases = clusters.flatMap((c) => c.exactPhrases ?? []);
  const clustered = new Set(clusters.flatMap((c) => c.signalIds));
  const rest = signals.filter((s) => !clustered.has(s.id));
  const sectors = clusters.map((c) => ({ label: c.label, items: c.signalIds.map((i) => byId[i]).filter(Boolean) }));
  if (rest.length) sectors.push({ label: "Unclustered", items: rest });
  const LET = "ABCDEFGH";
  const st = p.radarStats ?? {};
  const n = sectors.length || 1;
  const span = (2 * Math.PI) / n;
  const top = -Math.PI / 2;
  const pt = (r, a) => [50 + r * 100 * Math.cos(a), 50 + r * 100 * Math.sin(a)];
  const rOf = (v) => 0.07 + ((100 - Math.max(0, Math.min(100, v))) / 100) * 0.39;
  const rings = [rOf(0), rOf(20), rOf(50), rOf(80)];
  const spokes = sectors.map((_, i) => pt(0.48, top + i * span));
  const labels = sectors.map((_, i) => pt(0.5, top + (i + 0.5) * span));
  const rose = `<svg class="rose" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="48" fill="none" stroke="currentColor" stroke-width=".35"/>
      ${Array.from({ length: 72 }, (_, k) => { const a = (k * Math.PI) / 36; const o = k % 6 ? 47 : 45.6; const [x1, y1] = [50 + 48 * Math.cos(a), 50 + 48 * Math.sin(a)]; const [x2, y2] = [50 + o * Math.cos(a), 50 + o * Math.sin(a)]; return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="currentColor" stroke-width=".25"/>`; }).join("")}
      ${rings.map((r, i) => `<circle cx="50" cy="50" r="${r * 100}" fill="none" stroke="var(--rule)" stroke-width="${i === 3 ? ".45" : ".3"}" ${i === 0 ? "" : 'stroke-dasharray="1 1.2"'}/>`).join("")}
      <circle cx="50" cy="50" r="${(rOf(75) * 100).toFixed(2)}" fill="color-mix(in srgb, var(--hot) 6%, transparent)"/>
      ${spokes.map(([x, y]) => `<line x1="50" y1="50" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" stroke="var(--rule)" stroke-width=".3"/>`).join("")}
      ${labels.map(([x, y], i) => `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" dominant-baseline="middle" font-family="Archivo" font-weight="800" font-size="3.4" fill="var(--cobalt)" style="font-variation-settings:'wdth' 125">${LET[i]}</text>`).join("")}
      ${[80, 50, 20].map((v) => [v, rOf(v)]).map(([v, r]) => `<text x="${50 + 0.6}" y="${50 - r * 100 - 0.8}" font-family="Archivo" font-size="2.1" fill="var(--muted)">${v}</text>`).join("")}
    </svg>`;
  let k = 0;
  const soundings = sectors
    .map((sec, si) =>
      sec.items
        .map((s, i) => {
          const r = rOf(s.intent);
          const a = top + si * span + ((i + 1) / (sec.items.length + 1)) * span;
          const [x, y] = pt(r, a);
          return `<button class="sounding ${s.intent >= 75 ? "hot" : ""}" style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;animation-delay:${k++ * 50}ms" data-sig="${s.id}" aria-label="Intent ${s.intent}: ${esc(s.text.slice(0, 80))}">${s.intent}</button>`;
        })
        .join(""),
    )
    .join("");

  el.innerHTML = `
    <section class="section">
      <h2>Demand chart</h2>
      <p class="hint">Every number is a real public post and its intent score. The closer to the centre, the closer that person is to trying a solution this week. ${st.candidates ? `${st.relevant} of ${st.candidates} posts showed real intent.` : ""} ${st.threadsConnected === false ? (signals.some((x) => x.source === "threads") ? `${signals.filter((x) => x.source === "threads").length} of these are Threads posts found through web search; direct Threads keyword search is waiting for Meta’s app review.` : "This scan used web search; direct Threads keyword search is waiting for Meta’s app review.") : ""}</p>
      <div class="radar-wrap">
        <div class="radar reveal">${rose}${soundings}</div>
        <div>
          <div class="key"><span><b>◯ 75+</b> looking for a solution now</span><span>Sectors are pain points</span></div>
          <ol class="legend">${sectors.map((sec, i) => `<li><span class="sector">${LET[i]}</span><span>${esc(sec.label)}</span><span class="n">${sec.items.length} ${sec.items.length === 1 ? "post" : "posts"}</span></li>`).join("")}</ol>
          <div id="quote"></div>
        </div>
      </div>
    </section>
    <section class="section">
      <h2>Pain points, in their words</h2>
      <div class="clusters">${clusters
        .map((c, i) => `<div class="cluster"><h3><span>${LET[i]} · ${esc(c.label)}</span><span class="intent ${c.intensity >= 75 ? "hot" : ""}">${c.intensity}</span></h3><p>${esc(c.summary)}</p><ul>${c.exactPhrases.map((x) => `<li>“<mark>${esc(x)}</mark>”</li>`).join("")}</ul></div>`)
        .join("")}</div>
    </section>
    ${intermediaries.length ? `<section class="section">
      <h2>Who already gathers these people</h2>
      <p class="hint">One yes from an intermediary can bring more users than a hundred replies.</p>
      <ul class="list-plain">${intermediaries
        .map((m) => `<li><h3>${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.name)}</a>` : esc(m.name)} <small class="hint">${esc(m.type)}</small></h3><p class="hint">${esc(m.why)}</p><p style="margin-top:6px"><strong>Offer:</strong> ${esc(m.offer)}</p></li>`)
        .join("")}</ul></section>` : ""}
    <section class="section">
      <h2>All posts</h2>
      <ul class="list-plain">${signals
        .map((s) => `<li class="signal-row"><span class="intent ${s.intent >= 75 ? "hot" : ""}">${s.intent}</span><div><p class="q">${hl(s.text, phrases)}</p><p class="meta">${esc(s.author)} · ${esc(s.source)} · ${esc((s.stage || "").replaceAll("_", " "))} ${s.url ? `· <a href="${esc(s.url)}" target="_blank" rel="noopener">Open post</a>` : ""}</p></div></li>`)
        .join("")}</ul>
    </section>`;

  const showQuote = (sid) => {
    const s = byId[sid] ?? rest.find((x) => x.id === sid);
    el.querySelectorAll(".sounding").forEach((d) => d.setAttribute("aria-pressed", d.dataset.sig === sid ? "true" : "false"));
    $("#quote", el).innerHTML = `<div class="quote"><blockquote>${hl(s.text, phrases)}</blockquote><footer><span class="intent ${s.intent >= 75 ? "hot" : ""}">Intent ${s.intent}</span><span>${esc(s.author)}</span><span>${esc(s.painPoint)}</span>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">Open post</a>` : ""}</footer></div>`;
  };
  el.querySelectorAll(".sounding").forEach((d) => d.addEventListener("click", () => showQuote(d.dataset.sig)));
  if (signals[0]) showQuote(signals[0].id);
}

function renderExperiments(el, pid, experiments, p) {
  if (!experiments.length) {
    el.innerHTML = `<p class="hint">${BUSY.has(p.stage) ? "Planning three experiments from the demand map and the traction bank…" : "No experiments yet."}</p>`;
    return;
  }
  el.style.paddingTop = "18px";
  el.innerHTML = experiments
    .map((e, ei) => {
      const rate = e.clicks ? Math.round((e.signups / e.clicks) * 100) : 0;
      return `<article class="exp" data-exp="${e.id}">
        <span class="exp-tab">Experiment ${"ABC"[ei] ?? ei + 1}</span>
        <div class="exp-head">
          <div><p class="channel">${esc(CHANNEL[e.channel] ?? e.channel)} · targets “${esc(e.targetCluster)}”</p><h2>${esc(e.title)}</h2></div>
          <span class="stamp ${esc(e.status)}">${esc(STATUS[e.status] ?? e.status)}</span>
        </div>
        <p class="angle">${esc(e.angle)}</p>
        <p class="why">${esc(e.hypothesis)}</p>
        ${e.priorEvidence ? `<p class="why" style="margin-top:6px"><strong>Evidence:</strong> ${esc(e.priorEvidence)}</p>` : ""}
        <div class="log">
          <div><b>${e.clicks ?? 0}</b><span>clicks</span></div>
          <div><b>${e.signups ?? 0}</b><span>signups (${rate}%)</span></div>
          <div><b>${e.payments ?? 0}</b><span>payments</span></div>
          <div><b>${e.successThreshold}</b><span>${esc(e.successMetric)} needed to win</span></div>
        </div>
        ${e.verdict ? `<div class="verdict ${esc(e.verdict.verdict)}"><strong>${esc(VERDICT[e.verdict.verdict])}.</strong> ${esc(e.verdict.reasoning)} <br/><em>Next:</em> ${esc(e.verdict.next_step)}${e.verdict.ad_brief ? `<p style="margin-top:8px"><strong>Ad brief:</strong> ${esc(e.verdict.ad_brief)}</p>` : ""}</div>` : ""}
        ${e.creative?.key ? `<div class="creative"><img src="${esc(cfg().api)}/assets/${esc(e.creative.key)}" alt="Ad visual generated by Muse Image for this angle"/><p class="hint">Generated with Muse Image from the winning angle. Use it for a small ad test once the angle has proven itself organically.</p></div>` : ""}
        <h3 style="margin-top:18px">Drafts (${e.drafts.filter((d) => d.status === "posted").length}/${e.drafts.length} posted)</h3>
        ${e.drafts
          .map(
            (d) => `<div class="draft" data-draft="${d.id}" data-status="${esc(d.status)}">
            <p class="target">${d.targetUrl ? `Reply to <a href="${esc(d.targetUrl)}" target="_blank" rel="noopener">${esc(d.targetUrl)}</a>` : "New post"} · ${esc(d.status.replaceAll("_", " "))}</p>
            <textarea aria-label="Draft text" rows="${Math.min(14, Math.max(3, d.text.split("\n").length + Math.ceil(d.text.length / 110)))}" ${d.status === "posted" ? "readonly" : ""}>${esc(d.text)}</textarea>
            <div class="row">
              ${d.status === "pending_approval" ? `<button class="btn primary" data-act="approved">Approve</button><button class="btn quiet" data-act="skipped">Skip</button>` : ""}
              ${d.status === "approved" && !d.targetUrl && (e.channel === "threads_post") ? `<button class="btn primary" data-act="publish">Publish to my Threads</button>` : ""}
              ${d.status === "approved" ? `<button class="btn" data-act="copy">Copy and open</button><button class="btn" data-act="posted">I posted it</button>` : ""}
              ${d.status === "posted" && d.postedUrl ? `<a href="${esc(d.postedUrl)}" target="_blank" rel="noopener">View post</a>` : ""}
            </div></div>`,
          )
          .join("")}
        <details class="more"><summary>Tracking link and manual numbers</summary>
          <p class="hint" style="margin:8px 0">Every draft already contains this link: <a href="${esc(e.link)}" target="_blank" rel="noopener">${esc(e.link)}</a></p>
          <form class="row metrics"><label>Ad spend <input name="spend" type="number" min="0" step="any" style="width:120px"/></label><label>Extra signups <input name="signups" type="number" step="1" style="width:110px"/></label><label>Extra payments <input name="payments" type="number" step="1" style="width:110px"/></label><button class="btn">Add numbers</button></form>
        </details>
        ${e.status === "draft" ? `<div class="row" style="margin-top:14px"><button class="btn" data-start>Start without posting yet</button></div>` : ""}
      </article>`;
    })
    .join("");

  el.querySelectorAll(".exp").forEach((art) => {
    const eid = art.dataset.exp;
    const exp = experiments.find((x) => x.id === eid);
    art.querySelectorAll(".draft").forEach((box) => {
      const did = box.dataset.draft;
      box.querySelectorAll("[data-act]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const act = btn.dataset.act;
          const text = $("textarea", box).value;
          try {
            if (act === "copy") {
              await navigator.clipboard?.writeText(text).catch(() => {});
              const d = exp.drafts.find((x) => x.id === did);
              window.open(d.targetUrl || `https://www.threads.com/intent/post?text=${encodeURIComponent(text)}`, "_blank", "noopener");
              toast("Copied. Paste it, post it, then tap “I posted it”.");
              return;
            }
            if (act === "publish") {
              await api(`/api/experiments/${pid}/${eid}/drafts/${did}`, { method: "POST", body: { text } });
              await api(`/api/experiments/${pid}/${eid}/drafts/${did}/publish`, { method: "POST" });
              toast("Published to Threads");
            } else {
              await api(`/api/experiments/${pid}/${eid}/drafts/${did}`, { method: "POST", body: { status: act, text } });
              toast({ approved: "Approved", skipped: "Skipped", posted: "Marked as posted. The experiment is running." }[act]);
            }
            productView(pid, "experiments");
          } catch (e) {
            toast(e.message);
          }
        }),
      );
    });
    $("[data-start]", art)?.addEventListener("click", async () => {
      try {
        await api(`/api/experiments/${pid}/${eid}/start`, { method: "POST" });
        productView(pid, "experiments");
      } catch (e) {
        toast(e.message);
      }
    });
    $("form.metrics", art).addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target));
      await api(`/api/experiments/${pid}/${eid}/metrics`, { method: "POST", body: f });
      toast("Numbers added");
      productView(pid, "experiments");
    });
  });
}

function renderTrace(el, jobs) {
  const NAMES = { product_card: "Read the product", radar: "Scan public demand", plan: "Plan experiments", creative: "Generate ad visual", measure: "Judge results" };
  el.innerHTML = `<p class="hint" style="margin-bottom:18px">Every model call and tool call the agent made, newest first. Open-weights calls ran on Muse Spark Open.</p>` +
    jobs
      .map((j) => `<section class="job"><h3>${esc(NAMES[j.jobType] ?? j.jobType)} <small>${esc(j.status)}${j.summary ? ` · ${esc(j.summary)}` : ""}${j.error ? ` · ${esc(j.error)}` : ""}</small></h3>
        <ul class="list-plain trace">${(j.trace ?? [])
          .map((s) => `<li><span class="kind ${esc(s.kind)}">${esc(s.kind)}</span><span>${esc(s.name ?? "")} <span class="hint">${esc(s.model ?? "")}${s.openWeights ? " (open weights)" : ""}${s.webSearch ? " + web search" : ""}${s.toolCalls?.length ? ` → ${esc(s.toolCalls.join(", "))}` : ""}${s.args ? ` ${esc(JSON.stringify(s.args).slice(0, 90))}` : ""}</span></span><span class="hint">${s.ms ? `${(s.ms / 1000).toFixed(1)}s` : ""}</span></li>`)
          .join("")}</ul></section>`)
      .join("");
}

async function bankView() {
  let b;
  try {
    b = await api(isDemo() ? "/demo/bank" : "/api/bank");
  } catch (e) {
    view().innerHTML = `<section class="empty"><h1>Traction bank</h1><p>${esc(e.message)}</p></section>`;
    return;
  }
  const bars = (rows, label) => {
    const max = Math.max(1, ...rows.map((r) => r.signupRate));
    return rows.length
      ? `<div class="bars">${rows.map((r) => `<div class="bar"><span>${esc(label(r.key))}</span><div class="track"><div class="fill" style="width:${(r.signupRate / max) * 100}%"></div></div><span class="num">${Math.round(r.signupRate * 100)}% · n=${r.n}</span></div>`).join("")}</div>`
      : `<p class="hint">No outcomes yet.</p>`;
  };
  view().innerHTML = `
    <header class="head"><div><h1>Traction bank</h1><p class="lede">What actually worked across ${b.outcomes} experiments in ${b.categories} product categories. Stored anonymously: no product names, links or handles. The planner reads this before proposing anything.</p></div></header>
    <section class="section" style="margin-top:28px"><h2>Signup rate by channel</h2><p class="hint">Signups per click.</p>${bars(b.byChannel, (k) => CHANNEL[k] ?? k)}</section>
    <section class="section"><h2>Signup rate by message angle</h2>${bars(b.byAngle, (k) => k.replaceAll("_", " "))}</section>
    <section class="section"><h2>By product category</h2>${bars(b.byCategory, (k) => k.replaceAll("_", " "))}</section>`;
}

function settingsView() {
  const c = cfg();
  view().innerHTML = `
    <header class="head"><div><h1>Settings</h1><p class="lede">Stored only in this browser.</p></div></header>
    <form id="settings" class="section" style="margin-top:24px;max-width:560px;display:flex;flex-direction:column;gap:14px">
      <label>API address <input name="api" value="${esc(c.api)}" placeholder="Leave empty when the API runs on this site"/></label>
      <label>Access token <input name="token" type="password" value="${esc(c.token)}" autocomplete="off"/></label>
      <div class="row"><button class="btn primary">Save settings</button><button class="btn quiet" type="button" id="signOut">Sign out</button></div>
    </form>`;
  $("#signOut").onclick = () => { store.set("tr_token", ""); location.hash = "#/signin"; };
  $("#settings").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    store.set("tr_api", f.api.trim().replace(/\/$/, ""));
    store.set("tr_token", f.token.trim());
    try {
      await api("/api/products");
      toast("Connected. Settings saved.");
      renderRail();
      location.hash = "#/";
    } catch (err) {
      toast(err.status === 401 ? "Saved, but the API rejected this access token. Paste it again without spaces." : `Saved, but the API couldn't be reached: ${err.message}`);
    }
  };
}

function signInView() {
  document.body.classList.add("signin");
  view().innerHTML = `
    <section class="signin-page">
      <div class="signin-copy">
        <a class="brand big" href="#/signin" aria-label="Traction Radar">
          <svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="16" cy="16" r="8" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2"/><path d="M16 1v30M1 16h30" stroke="currentColor" stroke-width=".75"/><path d="M16 4l2 12-2 2-2-2z" fill="currentColor"/><circle cx="23" cy="10" r="2.6" fill="var(--hot)"/></svg>
          <span>Traction Radar</span>
        </a>
        <h1>Find your app’s first users from the people already asking for it.</h1>
        <p class="lede">An agent reads your product, finds real public posts describing the problem you solve, and plans three small experiments you can measure this week.</p>
        <div class="row"><a class="btn primary" href="#/demo">View the live demo</a><a class="btn" href="#/try">Try it on your product</a></div>
        <p class="hint">The demo is a real run on a live product. Trying it on yours is free and needs no account.</p>
      </div>
      <form id="signinForm" class="signin-card">
        <h2>Sign in</h2>
        <label>Access token <input name="token" type="password" autocomplete="current-password" required /></label>
        <details class="more"><summary>API address</summary><label style="margin-top:10px">API address <input name="api" value="${esc(cfg().api)}" placeholder="Leave empty when the API runs on this site" /></label></details>
        <button class="btn primary wide">Sign in</button>
        <p class="hint">This instance has one owner. Founder accounts are on the roadmap.</p>
      </form>
    </section>`;
  $("#signinForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const prev = cfg();
    store.set("tr_token", f.token.trim());
    if (f.api !== undefined) store.set("tr_api", f.api.trim().replace(/\/$/, ""));
    try {
      await api("/api/products");
      setDemo(false);
      document.body.classList.remove("signin");
      toast("Signed in");
      location.hash = "#/";
    } catch (err) {
      store.set("tr_token", prev.token);
      toast(err.status === 401 ? "That access token was rejected." : `Couldn't reach the API: ${err.message}`);
    }
  };
}

function tryView() {
  view().innerHTML = `
    <header class="head"><div><h1>Try it on your product</h1><p class="lede">Paste your app’s URL. The agent reads the page, looks for real public posts from people describing the problem you solve, and plans three experiments. Free, no account; results are read-only and nothing is posted.</p></div></header>
    <form id="tryForm" class="section signin-card" style="margin-top:28px;max-width:620px">
      <label>Product URL <input name="url" type="url" required placeholder="https://yourapp.com" /></label>
      <label>What it does, in one line (optional) <input name="notes" maxlength="300" placeholder="Who it's for and what problem it solves" /></label>
      <button class="btn primary">Start the free scan</button>
      <p class="hint">A few free scans per day are shared by everyone. A full scan takes about 5–8 minutes.</p>
    </form>`;
  $("#tryForm").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("button", e.target);
    btn.disabled = true;
    try {
      const f = Object.fromEntries(new FormData(e.target));
      const { id } = await api("/demo/scan", { method: "POST", body: f });
      store.set("tr_try", id);
      store.set("tr_try_name", new URL(f.url).hostname);
      location.hash = `#/try/${id}`;
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  };
}

// ---------------------------------------------------------------- new product
function openNewProduct() {
  const dlg = $("#newProduct");
  $("#newProductForm").reset();
  dlg.showModal();
}
$("#newProductBtn").onclick = openNewProduct;
$("#newProductForm").addEventListener("submit", async (ev) => {
  if (ev.submitter?.value !== "ok") return;
  ev.preventDefault();
  const f = Object.fromEntries(new FormData(ev.target));
  try {
    const { product } = await api("/api/products", { method: "POST", body: f });
    $("#newProduct").close();
    location.hash = `#/p/${product.id}`;
    toast("Radar started");
  } catch (e) {
    toast(e.message);
    if (e.status === 401) {
      $("#newProduct").close();
      location.hash = "#/settings";
    }
  }
});

// ---------------------------------------------------------------- router
async function router() {
  clearTimeout(pollTimer);
  renderGen++;
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const signedIn = Boolean(cfg().token);
  document.body.classList.remove("signin");
  if (parts[0] === "demo" || parts[0] === "try") setDemo(true);
  else if (signedIn) setDemo(false);
  else if (!(store.get("tr_demo", false) && parts[0] === "bank")) setDemo(false);

  if (parts[0] === "signin" || (!signedIn && !isDemo())) {
    signInView();
  } else if (parts[0] === "demo") {
    demoSrc = "/demo"; demoBase = "#/demo";
    renderRail("demo");
    await productView("demo", parts[1] || "demand");
  } else if (parts[0] === "try" && parts[1]) {
    demoSrc = `/demo/p/${encodeURIComponent(parts[1])}`; demoBase = `#/try/${parts[1]}`;
    renderRail(parts[1]);
    await productView(parts[1], parts[2] || "overview");
  } else if (parts[0] === "try") {
    demoBase = "#/demo";
    renderRail("try");
    tryView();
  } else if (parts[0] === "p" && parts[1]) {
    renderRail(parts[1]);
    await productView(parts[1], parts[2] || "overview");
  } else if (parts[0] === "bank") {
    renderRail();
    await bankView();
  } else if (parts[0] === "settings") {
    renderRail();
    settingsView();
  } else {
    await renderRail();
    const first = $("#productList a");
    if (first) location.hash = first.getAttribute("href");
    else emptyView();
  }
  view().focus({ preventScroll: true });
}
addEventListener("hashchange", router);
router();
