# Traction Radar

**An AI agent that finds where an app's first users will come from, runs small measurable experiments, and learns from real outcomes.**

Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Oct 26 – Nov 4, 2026). Indie track, theme *Build for Your World*. All code in this repository was written during the hackathon.

## The problem

AI made building an app fast. Getting its first users is still slow and expensive. Content takes months to show results; ads burn budget before you know which message works. Most indie products die with zero users, not because nobody needs them, but because the founder never found the people who already describe the problem in public.

## What it does

1. **Reads your product.** Give it a URL. Muse Spark reads the landing page (plus web search to fill gaps) and builds a product card: problem, audience, price band, market language, and the phrases a frustrated person would write *before* knowing you exist. A deterministic check flags Meta ad categories that need prior permission (dating, crypto, finance, …) so you don't waste days on ads that will be rejected.
2. **Scans public demand.** A Muse Wonder agent searches public Threads posts (Threads Keyword Search API) and the open web (built-in `web_search`), recording real posts where people describe the pain, plus the communities, accounts and agencies that already gather them.
3. **Scores intent on open weights.** Every post is scored 0–100 for buying intent and stage by **Muse Spark Open** on partner inference (Baseten/Modal), then clustered into pain points in the users' own words. The dashboard plots each post on a demand map.
4. **Plans three experiments.** Muse Wonder designs three 7-day experiments (Threads posts, helpful replies, intermediary outreach, or a small ad test) with ready-to-send drafts. Each experiment gets its own tracking link. **Nothing is posted without human approval.**
5. **Measures and decides.** Clicks come from the tracking links; signups and payments from a 1-line snippet. Daily, the agent judges each experiment: keep, kill, needs more data, or **ready for ads**, in which case Muse Image generates the ad visual from the winning angle.
6. **Learns across products.** Every outcome is stored anonymously in the **traction bank** (category, channel, angle family, language, numbers; no names, links or handles). The planner reads these priors before proposing anything, so every product that runs an experiment makes the next recommendation better. This data only exists because experiments were actually run; no model can search for it.

## Meta AI tooling used

| Model / API | Used for |
|---|---|
| Muse Wonder (Meta Model API, Responses API) | Radar agent loop with function tools + web search; experiment planning with structured output |
| Muse Spark 1.3 | Product card (with search grounding), pain-point clustering, verdicts |
| Muse Spark Open (open weights, via Baseten/Modal) | High-volume intent scoring of every collected post |
| Muse Image | Ad visuals for angles that proved themselves organically |
| Threads API | Public keyword search; publishing approved posts |

Every model and tool call is recorded and shown in the dashboard's **Agent trace** tab.

## Architecture

All serverless, sized to stay within the AWS always-free tier at hackathon scale. No API Gateway.

```
Dashboard (S3 + CloudFront)
        │
        ▼
Lambda Function URL ── api.mjs ──► DynamoDB (single table)
   │  /r/:slug  tracking redirect          ▲
   │  /e        conversion events          │
   │  /t.js     1-line snippet             │
   ▼                                       │
SQS ──► worker.mjs (agent jobs) ───────────┘
          product_card → radar → plan → creative
EventBridge (daily) ──► scheduler.mjs ──► measure (verdicts + traction bank)
Secrets: SSM Parameter Store (SecureString)
```

Code map: `src/jobs/index.mjs` (agent pipeline), `src/lib/meta.mjs` (Meta Model API + open-weights client), `src/lib/threads.mjs`, `src/lib/bank.mjs`, `src/lib/adpolicy.mjs`, `src/handlers/*`, `web/` (dashboard, no build step).

## Run locally

```bash
npm install            # AWS SDK for local DynamoDB access (Lambda has it built in)
npm run dev:mock       # no keys needed: fake model responses, in-memory DB → http://localhost:8787
npm test               # end-to-end test of the whole pipeline in mock mode
```

With real models and local storage:

```bash
META_API_KEY=... THREADS_TOKEN=... DB=memory LOCAL_DB_FILE=data/local-db.json npm run dev
```

Optional open-weights endpoint: `OPEN_WEIGHTS_BASE_URL=<OpenAI-compatible base URL> OPEN_WEIGHTS_API_KEY=...` (model `meta-models/muse-spark-open-1026`). Without it, intent scoring falls back to Muse Spark on the Meta Model API.

## Deploy to AWS

Requires the AWS CLI and SAM CLI.

```bash
scripts/set-secrets.sh prod      # META_API_KEY, ADMIN_TOKEN, THREADS_TOKEN, OPEN_WEIGHTS_API_KEY
sam build && sam deploy --guided --stack-name traction-radar \
  --parameter-overrides OpenWeightsBaseUrl=<partner base url>
scripts/deploy-site.sh traction-radar
```

Open the printed dashboard URL, go to **Settings**, and paste your `ADMIN_TOKEN`.

## Measuring conversions in your app

```html
<script src="https://<your-api>/t.js" defer></script>
<script>
  // after a signup
  TractionRadar.signup();
  // after a payment (amount, unique order id for de-duplication)
  TractionRadar.payment(29000, "order-123");
</script>
```

The snippet remembers the `?tr=` code from the tracking link in first-party storage for 30 days and sends only that code and the event type. No cookies, no personal data.

## Responsible by design

- Only public content is collected; we keep the public handle and post URL, never private profiles.
- Replies are drafted, never auto-sent; a human approves and posts each one. Drafts disclose that the author built the product.
- The traction bank stores no product names, URLs, drafts or user handles.
- Ad tests are blocked for restricted categories until the founder confirms Meta's permission.

## License

MIT
