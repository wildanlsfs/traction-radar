// Threads API: public keyword search (signals) and publishing approved posts.
// Without the threads_keyword_search approval, search only covers the token owner's own posts,
// so the radar treats Threads as one source among others and degrades gracefully.

import { secrets, settings } from "./config.mjs";
import { mockThreadsSearch } from "./mock.mjs";

const FIELDS = "id,text,media_type,permalink,timestamp,username,has_replies,is_quote_post,is_reply";

export async function threadsAvailable() {
  if (settings.mock) return true;
  const { THREADS_TOKEN } = await secrets();
  return !!THREADS_TOKEN;
}

export async function searchThreads(q, { searchType = "RECENT", limit = 50, sinceDays = 90 } = {}) {
  if (settings.mock) return mockThreadsSearch(q);
  const { THREADS_TOKEN } = await secrets();
  if (!THREADS_TOKEN) return { posts: [], note: "THREADS_TOKEN not configured" };
  const params = new URLSearchParams({
    q,
    search_type: searchType,
    limit: String(Math.min(limit, 100)),
    fields: FIELDS,
    since: String(Math.floor(Date.now() / 1000) - sinceDays * 86400),
    access_token: THREADS_TOKEN,
  });
  const res = await fetch(`${settings.threadsBaseUrl}/keyword_search?${params}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { posts: [], note: `threads error ${res.status}: ${body?.error?.message ?? ""}`.trim() };
  return {
    posts: (body.data ?? [])
      .filter((p) => p.text)
      .map((p) => ({
        source: "threads",
        externalId: p.id,
        url: p.permalink,
        author: p.username,
        text: p.text,
        postedAt: p.timestamp,
        isReply: !!p.is_reply,
      })),
  };
}

/** Publish a text post to the token owner's Threads account. Only called after a human approves it. */
export async function publishThreads(text) {
  if (settings.mock) return { id: `mock_${Date.now()}`, permalink: "https://www.threads.com/" };
  const { THREADS_TOKEN } = await secrets();
  if (!THREADS_TOKEN) throw new Error("THREADS_TOKEN not configured");
  const base = settings.threadsBaseUrl;
  const create = await fetch(`${base}/me/threads`, {
    method: "POST",
    body: new URLSearchParams({ media_type: "TEXT", text, access_token: THREADS_TOKEN }),
  }).then((r) => r.json());
  if (!create.id) throw new Error(`Threads container failed: ${JSON.stringify(create).slice(0, 300)}`);
  const pub = await fetch(`${base}/me/threads_publish`, {
    method: "POST",
    body: new URLSearchParams({ creation_id: create.id, access_token: THREADS_TOKEN }),
  }).then((r) => r.json());
  if (!pub.id) throw new Error(`Threads publish failed: ${JSON.stringify(pub).slice(0, 300)}`);
  const info = await fetch(`${base}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(THREADS_TOKEN)}`)
    .then((r) => r.json())
    .catch(() => ({}));
  return { id: pub.id, permalink: info.permalink };
}

/** Web intent so a human can post / reply from their own account without any API permission. */
export function threadsIntentUrl(text) {
  return `https://www.threads.com/intent/post?text=${encodeURIComponent(text)}`;
}
