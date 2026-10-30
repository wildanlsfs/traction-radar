// Meta Model API client (Responses API, OpenAI-compatible surface).
//  - respond():      one call, optional web_search, optional structured output (text.format json_schema)
//  - agent():        tool-calling loop with developer function tools (+ optional web_search)
//  - image():        Muse Image generation
//  - openWeights():  Muse Spark Open via an OpenAI-compatible partner endpoint (Baseten/Modal/Fireworks)
// Every call is recorded in a per-run trace so the dashboard can show what the agent actually did.

import { secrets, settings } from "./config.mjs";
import { mockRespond, mockImage, mockOpenWeights } from "./mock.mjs";

export class Trace {
  constructor() {
    this.steps = [];
  }
  add(step) {
    this.steps.push({ at: new Date().toISOString(), ...step });
  }
}

async function post(url, body, apiKey, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      const err = new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 500)}`);
      err.status = res.status;
      throw err;
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
}

export function outputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  const parts = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) if (c.type === "output_text") parts.push(c.text);
  }
  return parts.join("\n");
}

export function citations(response) {
  const out = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? [])
      for (const a of c.annotations ?? []) if (a.type === "url_citation") out.push({ url: a.url, title: a.title });
  }
  return out;
}

export function searchResults(response) {
  const out = [];
  for (const item of response.output ?? [])
    if (item.type === "web_search_call") for (const r of item.results ?? []) out.push(r);
  return out;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Model did not return JSON");
  }
}

/**
 * One Responses API call.
 * @param {object} o
 * @param {string} o.name        label used in the trace + mock dispatch
 * @param {string|Array} o.input
 * @param {string} [o.instructions]
 * @param {object} [o.schema]    JSON schema -> structured output
 * @param {boolean} [o.webSearch]
 * @param {"low"|"medium"|"high"} [o.effort]
 * @param {string} [o.model]
 */
export async function respond({ name, input, instructions, schema, webSearch, effort = "medium", model, trace }) {
  model ??= settings.metaModel;
  if (settings.mock) {
    const r = mockRespond(name, { input, schema });
    trace?.add({ kind: "model", name, model: `${model} (mock)`, webSearch: !!webSearch });
    return r;
  }
  const { META_API_KEY } = await secrets();
  if (!META_API_KEY) throw new Error("META_API_KEY is not configured");
  const body = { model, input, reasoning: { effort } };
  if (instructions) body.instructions = instructions;
  if (webSearch) {
    body.tools = [{ type: "web_search", search_context_size: "high" }];
    body.include = ["web_search_call.results"];
  }
  if (schema) body.text = { format: { type: "json_schema", name, schema, strict: true } };
  const t0 = Date.now();
  const response = await post(`${settings.metaBaseUrl}/responses`, body, META_API_KEY);
  const text = outputText(response);
  const result = {
    id: response.id,
    text,
    json: schema ? parseJson(text) : undefined,
    citations: citations(response),
    searchResults: searchResults(response),
    usage: response.usage,
  };
  trace?.add({
    kind: "model",
    name,
    model,
    ms: Date.now() - t0,
    webSearch: !!webSearch,
    searches: (response.output ?? []).filter((i) => i.type === "web_search_call").length,
    usage: response.usage,
  });
  return result;
}

/**
 * Tool-calling agent loop on the Responses API.
 * tools: [{ name, description, parameters, run: async (args) => any }]
 */
export async function agent({ name, input, instructions, tools, webSearch, maxTurns = 8, effort = "high", model, trace, budgetMs }) {
  const started = Date.now();
  model ??= settings.metaModel;
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const apiTools = tools.map(({ name, description, parameters }) => ({
    type: "function",
    name,
    description,
    parameters,
  }));
  if (webSearch) apiTools.push({ type: "web_search", search_context_size: "high" });

  if (settings.mock) {
    // Mock: drive every tool once with plausible arguments so the whole pipeline is exercised.
    const { mockToolCalls } = await import("./mock.mjs");
    for (const call of mockToolCalls(name, input)) {
      const tool = byName[call.name];
      if (!tool) continue;
      const out = await tool.run(call.arguments);
      trace?.add({ kind: "tool", name: call.name, args: call.arguments, resultSize: JSON.stringify(out ?? null).length });
    }
    const r = mockRespond(name, { input });
    trace?.add({ kind: "model", name, model: `${model} (mock)`, turns: 1 });
    return r;
  }

  const { META_API_KEY } = await secrets();
  if (!META_API_KEY) throw new Error("META_API_KEY is not configured");

  let previous_response_id;
  let nextInput = input;
  const seenResults = [];
  for (let turn = 0; turn < maxTurns; turn++) {
    if (budgetMs && Date.now() - started > budgetMs) {
      trace?.add({ kind: "note", name: `${name}: time budget reached after ${turn} turns, keeping recorded results` });
      return { id: previous_response_id, text: "", citations: [], searchResults: seenResults, stoppedEarly: true };
    }
    const body = { model, input: nextInput, tools: apiTools, reasoning: { effort }, parallel_tool_calls: true };
    if (instructions) body.instructions = instructions;
    if (previous_response_id) body.previous_response_id = previous_response_id;
    if (webSearch) body.include = ["web_search_call.results"];
    const t0 = Date.now();
    const response = await post(`${settings.metaBaseUrl}/responses`, body, META_API_KEY);
    previous_response_id = response.id;
    seenResults.push(...searchResults(response));
    const calls = (response.output ?? []).filter((i) => i.type === "function_call");
    trace?.add({
      kind: "model",
      name: `${name}#${turn + 1}`,
      model,
      ms: Date.now() - t0,
      toolCalls: calls.map((c) => c.name),
      searches: (response.output ?? []).filter((i) => i.type === "web_search_call").length,
      usage: response.usage,
    });
    if (!calls.length) {
      return { id: response.id, text: outputText(response), citations: citations(response), searchResults: seenResults };
    }
    const outputs = await Promise.all(
      calls.map(async (c) => {
        let args = {};
        try {
          args = JSON.parse(c.arguments || "{}");
        } catch {
          /* leave empty */
        }
        let result;
        try {
          const tool = byName[c.name];
          if (!tool) throw new Error(`unknown tool ${c.name}`);
          result = await tool.run(args);
        } catch (err) {
          result = { error: String(err.message || err) };
        }
        trace?.add({ kind: "tool", name: c.name, args, resultSize: JSON.stringify(result ?? null).length });
        return { type: "function_call_output", call_id: c.call_id, output: JSON.stringify(result ?? null).slice(0, 60000) };
      }),
    );
    nextInput = outputs;
  }
  trace?.add({ kind: "note", name: `${name}: reached ${maxTurns} turns, keeping recorded results` });
  return { id: previous_response_id, text: "", citations: [], searchResults: seenResults, stoppedEarly: true };
}

/** Muse Image: returns { b64, url } */
export async function image({ prompt, size = "1024x1024", trace }) {
  if (settings.mock) {
    trace?.add({ kind: "image", model: `${settings.imageModel} (mock)` });
    return mockImage(prompt);
  }
  const { META_API_KEY } = await secrets();
  const t0 = Date.now();
  const res = await post(`${settings.metaBaseUrl}/images/generations`, { model: settings.imageModel, prompt, size, n: 1 }, META_API_KEY);
  trace?.add({ kind: "image", model: settings.imageModel, ms: Date.now() - t0 });
  const d = res.data?.[0] ?? {};
  return { b64: d.b64_json, url: d.url };
}

/**
 * Muse Spark Open (open weights) through an OpenAI-compatible Chat Completions endpoint.
 * Falls back to the Meta Model API fast model when no partner endpoint is configured.
 */
export async function openWeights({ name, system, user, schema, trace }) {
  if (settings.mock) {
    trace?.add({ kind: "model", name, model: `${settings.openWeightsModel} (mock)` });
    return mockOpenWeights(name, user);
  }
  const s = await secrets();
  const usePartner = settings.openWeightsBaseUrl && s.OPEN_WEIGHTS_API_KEY;
  const base = usePartner ? settings.openWeightsBaseUrl.replace(/\/$/, "") : settings.metaBaseUrl;
  const key = usePartner ? s.OPEN_WEIGHTS_API_KEY : s.META_API_KEY;
  const model = usePartner ? settings.openWeightsModel : settings.metaFastModel;
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.1,
  };
  if (schema) body.response_format = { type: "json_schema", json_schema: { name, schema, strict: true } };
  const t0 = Date.now();
  const res = await post(`${base}/chat/completions`, body, key);
  const text = res.choices?.[0]?.message?.content ?? "";
  trace?.add({ kind: "model", name, model, openWeights: !!usePartner, ms: Date.now() - t0, usage: res.usage });
  return { text, json: schema ? parseJson(text) : undefined };
}
