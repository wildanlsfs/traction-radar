// Runtime configuration. Secrets come from env (local dev) or SSM Parameter Store (Lambda).
// Secrets are never logged and never returned by the API.

const SECRET_NAMES = [
  "META_API_KEY", // Meta Model API key (Bearer)
  "THREADS_TOKEN", // Threads user access token (threads_basic [+ threads_keyword_search, threads_content_publish])
  "OPEN_WEIGHTS_API_KEY", // API key for the Muse Spark Open endpoint (Baseten / Modal / Fireworks)
  "ADMIN_TOKEN", // shared secret the dashboard sends as x-tr-token
];

let cache = null;

async function loadFromSsm(names) {
  const prefix = process.env.SSM_PREFIX;
  if (!prefix) return {};
  const { SSMClient, GetParametersCommand } = await import("@aws-sdk/client-ssm");
  const ssm = new SSMClient({});
  const res = await ssm.send(
    new GetParametersCommand({ Names: names.map((n) => `${prefix}/${n}`), WithDecryption: true }),
  );
  const out = {};
  for (const p of res.Parameters ?? []) out[p.Name.split("/").pop()] = p.Value;
  return out;
}

export async function secrets() {
  if (cache) return cache;
  const fromEnv = Object.fromEntries(SECRET_NAMES.map((n) => [n, process.env[n]]).filter(([, v]) => v));
  const missing = SECRET_NAMES.filter((n) => !fromEnv[n]);
  let fromSsm = {};
  if (missing.length) {
    try {
      fromSsm = await loadFromSsm(missing);
    } catch (err) {
      console.warn("SSM load failed:", err.name);
    }
  }
  const merged = { ...fromSsm, ...fromEnv };
  // Only cache once the required secrets exist, so a key added later is picked up without a redeploy.
  if (merged.META_API_KEY && merged.ADMIN_TOKEN) cache = merged;
  return merged;
}

export const settings = {
  metaBaseUrl: process.env.META_BASE_URL || "https://api.meta.ai/v1",
  metaModel: process.env.META_MODEL || "muse-wonder-1.0",
  metaFastModel: process.env.META_FAST_MODEL || "muse-spark-1.3",
  imageModel: process.env.META_IMAGE_MODEL || "muse-image-1.0",
  openWeightsBaseUrl: process.env.OPEN_WEIGHTS_BASE_URL || "",
  openWeightsModel: process.env.OPEN_WEIGHTS_MODEL || "meta-models/muse-spark-open-1026",
  threadsBaseUrl: "https://graph.threads.com/v1.0",
  publicSiteUrl: process.env.PUBLIC_SITE_URL || "http://localhost:8787",
  mock: process.env.MOCK_LLM === "1",
};
