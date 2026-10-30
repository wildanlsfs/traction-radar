# Hackathon submission — draft answers

Form: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit

- **Team name:** Traction Radar
- **Track:** Indie Developer Track
- **Problem statement:** Build for Your World
- **Most Viral (X post link):** _optional, add if posted_
- **Public GitHub repository:** https://github.com/wildanlsfs/traction-radar
- **3-minute demo video:** _YouTube link, still to record_

## Project description

Traction Radar is an AI agent that finds where an app's first users will come from. Give it a product URL and it reads the landing page, searches public Threads posts and the web for people already describing the problem, scores every post for buying intent, and clusters them into pain points in the users' own words. It then plans three 7-day experiments on different channels (Threads posts, helpful replies, intermediary outreach or a small ad test), each with ready drafts and its own tracking link. Nothing is posted without the founder's approval. Clicks, signups and payments are measured with a one-line snippet, and every day the agent decides: keep, stop, needs more data, or ready for ads. Every outcome is stored anonymously in a "traction bank" that the planner reads first, so each experiment makes the next recommendation better. I built it because I'm an indie developer: building my apps took days, but finding the first users took months.

## Describe your use of Meta products to build the submitted project

- **Muse Wonder** (Meta Model API, Responses API): the radar agent loop with function tools (`record_signals`, `record_intermediaries`) and built-in `web_search`; experiment planning with strict JSON-schema output.
- **Muse Spark 1.3**: product card with search grounding, pain-point clustering, and daily verdicts.
- **Muse Spark Open** (open weights via partner inference, OpenAI-compatible Chat Completions): high-volume intent scoring of each collected post, with automatic fallback to Muse Spark.
- **Muse Image**: ad visual generated from an angle that already won organically.
- **Threads API**: keyword search of public posts and publishing approved posts.
Every model and tool call is recorded and shown in the dashboard's Agent trace.

## Why are Meta's models important to your solution?

The job needs three things at once: an agent that can search and decide what is worth keeping (Muse Wonder with tools and web search), cheap high-volume judgment on hundreds of short posts (Muse Spark and the open-weights Muse Spark Open), and image generation once a message is proven (Muse Image), all from one API with structured output. Meta also owns the channels where this demand lives (Threads, Instagram, Facebook) and the ad platform founders graduate to. Traction Radar sends founders to Meta Ads with an angle that has already converted, so it grows Meta's ad business instead of competing with it.

## Feedback on partner technologies (optional)

_Fill in only if Baseten/Modal/Fireworks were actually used._

## Survey questions

These two are your own opinion; answer them yourself:
- How likely are you to build with Meta Model API?
- Overall opinion of Meta Model API?
