// The traction bank: anonymised outcomes of real experiments across all products.
// No product names, URLs, drafts or user handles are stored here - only the shape of what was tried
// (category, channel, angle family, price band, language) and what happened.

import { createHash } from "node:crypto";
import { db, now } from "./db.mjs";

const anon = (s) => createHash("sha256").update(`tr-bank:${s}`).digest("hex").slice(0, 16);

export async function recordOutcome({ product, experiment }) {
  const card = product.card ?? {};
  const outcomeId = anon(experiment.id);
  const item = {
    pk: `BANK#${card.category ?? "other"}`,
    sk: `OUTCOME#${outcomeId}`,
    gsi1pk: "BANK",
    gsi1sk: now(),
    type: "outcome",
    category: card.category ?? "other",
    price_band: card.price_band ?? "unknown",
    language: card.market_language ?? "",
    channel: experiment.channel,
    angle_type: experiment.angle_type,
    clicks: experiment.clicks ?? 0,
    signups: experiment.signups ?? 0,
    payments: experiment.payments ?? 0,
    revenue: experiment.revenue ?? 0,
    spend: experiment.spend ?? 0,
    days: experiment.days ?? 0,
    verdict: experiment.verdict?.verdict ?? "needs_more_data",
    updatedAt: now(),
  };
  await db.put(item);
  return item;
}

function summarise(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    const g = groups.get(key) ?? { key, n: 0, clicks: 0, signups: 0, payments: 0, wins: 0 };
    g.n++;
    g.clicks += r.clicks;
    g.signups += r.signups;
    g.payments += r.payments;
    if (r.verdict === "keep" || r.verdict === "ready_for_ads") g.wins++;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      signupRate: g.clicks ? +(g.signups / g.clicks).toFixed(3) : 0,
      winRate: g.n ? +(g.wins / g.n).toFixed(2) : 0,
    }))
    .sort((a, b) => b.winRate - a.winRate || b.signupRate - a.signupRate);
}

/** Priors the planner receives: what worked for similar products, and overall. */
export async function priors(category) {
  const same = await db.query(`BANK#${category}`, "OUTCOME#");
  const all = await db.queryGsi("BANK", "", { limit: 2000 });
  return {
    sameCategory: {
      outcomes: same.length,
      byChannel: summarise(same, (r) => r.channel),
      byAngle: summarise(same, (r) => r.angle_type),
    },
    allProducts: {
      outcomes: all.length,
      byChannel: summarise(all, (r) => r.channel),
      byAngle: summarise(all, (r) => r.angle_type),
      byChannelAndLanguage: summarise(all, (r) => `${r.channel}|${r.language}`).slice(0, 12),
    },
  };
}

export async function bankOverview() {
  const all = await db.queryGsi("BANK", "", { limit: 5000 });
  return {
    outcomes: all.length,
    categories: [...new Set(all.map((r) => r.category))].length,
    byChannel: summarise(all, (r) => r.channel),
    byAngle: summarise(all, (r) => r.angle_type),
    byCategory: summarise(all, (r) => r.category),
  };
}
