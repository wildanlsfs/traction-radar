// JSON schemas for structured output. All follow the strict subset:
// root object, additionalProperties:false everywhere, every property required.

const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const int = (description) => ({ type: "integer", description });
const arr = (items, description) => ({ type: "array", items, description });
const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const enm = (values, description) => ({ type: "string", enum: values, description });

export const CATEGORIES = [
  "b2b_saas",
  "b2c_app",
  "marketplace",
  "community",
  "education",
  "dating",
  "health",
  "finance",
  "productivity",
  "developer_tool",
  "ecommerce",
  "content",
  "other",
];
export const CHANNELS = ["threads_post", "threads_reply", "community_post", "intermediary_outreach", "ad_test"];
export const ANGLES = ["save_time", "save_money", "avoid_risk", "trust_safety", "status", "convenience", "values_identity", "other"];
export const STAGES = ["seeking_solution", "complaining_about_problem", "complaining_about_competitor", "comparing_options", "aware_only", "irrelevant"];

export const productCardSchema = obj({
  name: str("Product name"),
  one_liner: str("What it does in one sentence, plain words"),
  problem: str("The painful problem it solves, from the user's point of view"),
  audience: arr(obj({ segment: str("Short label"), description: str("Who exactly, where they hang out") }), "2-4 audience segments"),
  pricing: str("Pricing as found, or 'unknown'"),
  price_band: enm(["free", "under_5_usd", "5_to_30_usd", "30_to_100_usd", "over_100_usd", "unknown"], "Monthly price band"),
  category: enm(CATEGORIES, "Primary category"),
  market_language: str("ISO 639-1 language most users speak, e.g. id, en, ms"),
  regions: arr(str("Country or region"), "Main markets"),
  search_phrases: arr(str("A phrase a frustrated user would literally write in a post"), "8-12 phrases in the market language"),
  jobs_to_be_done: arr(str("Job the user hires the product for"), "2-4 jobs"),
  restricted_ad_categories: arr(enm(["dating", "gambling", "crypto", "addiction", "financial", "employment", "housing", "health", "politics"], "Meta restricted category"), "Restricted ad categories that apply, empty if none"),
  risks: arr(str("Positioning or trust risk visible on the site"), "0-4 risks"),
});

export const signalScoreSchema = obj({
  scores: arr(
    obj({
      index: int("Index of the post in the input list"),
      intent: int("0-100: how likely this person would try a product that solves it this week"),
      stage: enm(STAGES, "Buying stage"),
      pain_point: str("The pain in <= 12 words, in the post's language"),
      phrases: arr(str("Exact short phrase copied from the post"), "1-3 exact phrases"),
    }),
    "One entry per input post",
  ),
});

export const clustersSchema = obj({
  clusters: arr(
    obj({
      label: str("Cluster name, <= 6 words"),
      summary: str("What these people are struggling with"),
      signal_indexes: arr(int("Index into the scored list"), "Members"),
      exact_phrases: arr(str("Verbatim phrase users wrote"), "3-6 phrases"),
      intensity: int("0-100 urgency of the pain"),
    }),
    "3-6 clusters",
  ),
  intermediaries: arr(
    obj({
      name: str("Community, account, agency, school, association, newsletter, group"),
      type: enm(["community", "account", "agency", "association", "school", "media", "marketplace", "other"], "Type"),
      url: str("Public URL or '' if unknown"),
      why: str("Why they already gather this audience"),
      offer: str("A concrete win-win offer to make them"),
    }),
    "0-8 intermediaries",
  ),
});

export const experimentsSchema = obj({
  experiments: arr(
    obj({
      title: str("Short imperative title"),
      channel: enm(CHANNELS, "Channel"),
      angle: str("The message angle in one sentence, using users' own words"),
      angle_type: enm(ANGLES, "Angle family, used to learn across products"),
      target_cluster: str("Cluster label this targets"),
      hypothesis: str("If we do X, then Y, because Z"),
      success_metric: enm(["signups", "payments", "clicks"], "Primary metric"),
      success_threshold: int("Minimum count within 7 days to call it a win"),
      drafts: arr(
        obj({
          target_url: str("URL of the post/community this is for, or '' for a new post"),
          text: str("Ready-to-send text. Put {link} where the tracking link goes. Helpful, honest, no spam, no fake claims."),
        }),
        "1-5 drafts",
      ),
      prior_evidence: str("What the traction bank or radar says about this choice"),
    }),
    "Exactly 3 experiments, different channels where possible",
  ),
});

export const verdictSchema = obj({
  verdict: enm(["keep", "kill", "ready_for_ads", "needs_more_data"], "Decision"),
  reasoning: str("Two sentences max, cite the numbers"),
  next_step: str("One concrete next action"),
  ad_brief: str("If ready_for_ads: a one-paragraph Meta ad brief using the winning angle, else ''"),
});
