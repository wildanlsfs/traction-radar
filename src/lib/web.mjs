// Fetch a public web page and reduce it to readable text for the model.
import { settings } from "./config.mjs";

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?|metadata)/i;

export function isPublicHttpUrl(raw) {
  try {
    const u = new URL(raw);
    return (u.protocol === "https:" || u.protocol === "http:") && !PRIVATE_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

export function htmlToText(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] ?? "";
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/section)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return { title, description: desc, text: body };
}

export async function fetchPageText(url, { maxChars = 20000 } = {}) {
  if (settings.mock) {
    return { url, title: "Mock product", description: "", text: "Mock landing page text." };
  }
  if (!isPublicHttpUrl(url)) throw new Error("Only public http(s) URLs can be fetched");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": "TractionRadarBot/0.1 (+https://github.com/wildanlsfs/traction-radar)" },
    });
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html") && !type.includes("text")) return { url, title: "", description: "", text: "" };
    const html = (await res.text()).slice(0, 600000);
    const page = htmlToText(html);
    return { url: res.url, ...page, text: page.text.slice(0, maxChars) };
  } finally {
    clearTimeout(timer);
  }
}
