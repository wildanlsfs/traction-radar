// Deterministic Meta ads policy pre-check. Runs before the agent suggests any ad test, so a founder
// does not burn days on ads that will be auto-rejected. The model also flags categories, and we merge both.

export const RESTRICTED = {
  dating: {
    label: "Dating & matchmaking",
    requirement: "Prior written permission from Meta before running ads; target 18+ only.",
    url: "https://transparency.meta.com/policies/ad-standards/restricted-goods-services/dating-ads/",
  },
  gambling: {
    label: "Online gambling & gaming",
    requirement: "Prior written permission from Meta; licensed operators only.",
    url: "https://transparency.meta.com/policies/ad-standards/",
  },
  crypto: {
    label: "Cryptocurrency products",
    requirement: "Prior written permission or regulatory certification.",
    url: "https://transparency.meta.com/policies/ad-standards/",
  },
  addiction: {
    label: "Addiction treatment",
    requirement: "Third-party certification (e.g. LegitScript) required.",
    url: "https://transparency.meta.com/policies/ad-standards/",
  },
  financial: {
    label: "Credit, loans & financial products",
    requirement: "Special Ad Category (limited targeting); some countries require verification.",
    url: "https://transparency.meta.com/policies/ad-standards/",
  },
  employment: {
    label: "Employment / job offers",
    requirement: "Special Ad Category: limited age, gender and location targeting.",
    url: "https://transparency.meta.com/policies/ad-standards/",
  },
  housing: {
    label: "Housing",
    requirement: "Special Ad Category: limited targeting.",
    url: "https://transparency.meta.com/policies/ad-standards/",
  },
  health: {
    label: "Health, weight loss & wellness",
    requirement: "No before/after or negative self-perception claims; sensitive targeting limits.",
    url: "https://transparency.meta.com/policies/ad-standards/",
  },
  politics: {
    label: "Social issues, elections or politics",
    requirement: "Authorisation + 'Paid for by' disclaimer required.",
    url: "https://transparency.meta.com/policies/ad-standards/",
  },
};

const KEYWORDS = {
  dating: /\b(dating|match ?making|matchmaker|jodoh|ta'?aruf|taaruf|biro jodoh|soulmate|marriage platform)\b/i,
  gambling: /\b(gambl|casino|betting|slot ?online|judi|togel|sportsbook)\b/i,
  crypto: /\b(crypto|bitcoin|token sale|defi|nft|web3 wallet)\b/i,
  addiction: /\b(rehab|addiction treatment|detox|sobriety)\b/i,
  financial: /\b(loan|lending|pinjaman|credit card|kredit|paylater|pinjol)\b/i,
  employment: /\b(job board|lowongan|recruit|hiring platform|job offer|manning agency)\b/i,
  housing: /\b(rent(al)? listing|real estate|properti|apartment listing|kos-?kosan)\b/i,
  health: /\b(weight loss|diet|diet pill|slimming|mental health|therapy|kesehatan)\b/i,
  politics: /\b(election|pemilu|campaign donation|political)\b/i,
};

export function checkAdPolicy(text, modelCategories = []) {
  const hits = new Set(modelCategories.filter((c) => RESTRICTED[c]));
  for (const [cat, re] of Object.entries(KEYWORDS)) if (re.test(text)) hits.add(cat);
  return [...hits].map((cat) => ({ category: cat, ...RESTRICTED[cat] }));
}
