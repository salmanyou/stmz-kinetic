# STMZ Kinetic — Social Media Workspace

The workspace small businesses, e-commerce sellers, agencies and creators open
every Monday morning. Plan, generate, schedule, **auto-post** and track every
social media post in one place.

## What's inside

- **Dashboard** — one-glance view of drafts, scheduled, and posted content.
- **Generate** — AI campaign builder. Pick platforms + goal + count → hooks,
  captions, hashtags, CTAs and a matching image per post.
- **Ideas** — 10 AI-generated content ideas tailored to your brand, one click
  to turn any of them into a draft post.
- **Library** — every post you've ever made, with search/filter by brand,
  platform and status.
- **Calendar** — month view of every scheduled post. Click to edit/reschedule.
- **Templates** — six pre-built campaign starters.
- **Assistant** — AI chat with your brand loaded in context.
- **Connect** — LinkedIn OAuth (direct posting) + universal webhook for every
  other platform (Make.com / Zapier / n8n / your own).
- **Brand kit** — unlimited brand profiles (agencies switch in the sidebar).
- **Settings** — account, subscription, data export, sign in/out.

Powered by:
- Real multi-provider AI relay (Groq → OpenRouter → Gemini) with auto-failover
- Google sign-in + Firestore sync across devices
- Real Paddle subscriptions
- **Real server-side scheduler** that fires posts at their scheduled time

---

## What you fill in (only this)

| Where | What |
|------|------|
| `.env` | At least one AI key — **Groq is free & easiest** ([console.groq.com/keys](https://console.groq.com/keys)) |
| `.env` | `FIREBASE_SERVICE_ACCOUNT` (full JSON or base64 — required for sync, subscription and scheduler) |
| `.env` | `PADDLE_WEBHOOK_SECRET` (when you wire payments) |
| `.env` | `LINKEDIN_CLIENT_ID` + `LINKEDIN_CLIENT_SECRET` (for direct LinkedIn posting) |
| `.env` | `SCHEDULER_SECRET` (any long random string — protects the cron tick endpoint) |
| `.env` | `APP_URL` (your public URL once deployed — used by OAuth redirects) |
| `public/js/firebase-config.js` | Firebase web config + Paddle client token + price ID |
| Firebase console → Firestore → Rules | Paste the contents of `firestore.rules` |
| Firebase console → Authentication → Sign-in method | Enable **Google** |
| cron-job.org | Hit `/api/scheduler/tick?secret=...` every minute (see INTEGRATIONS_SETUP.md) |

The app **boots even with nothing set** — features turn on as you add keys.
Images are free, keyless (Pollinations).

---

## Three docs to read

1. **`README.md`** — this file (overview, deploy).
2. **`PADDLE_PAYONEER_SETUP.md`** — full Paddle + Payoneer payout setup.
3. **`INTEGRATIONS_SETUP.md`** — LinkedIn OAuth, Make.com webhook walkthrough,
   and the cron scheduler setup.

---

## Run locally

```bash
npm install
cp .env.example .env       # add GROQ_API_KEY at minimum
npm start                  # → http://localhost:3000
```

The Generate / Ideas / Assistant views work as soon as Groq is set. The Library
and Calendar work locally without sign-in (data stays in your browser).

---

## Deploy free

Push to GitHub → [render.com](https://render.com) → **New → Web Service** →
connect the repo → Build: `npm install`, Start: `npm start` → add your `.env`
values under **Environment** → Deploy. You get `https://your-app.onrender.com`.

> **Important:** set `APP_URL` in Render's environment to your final URL — the
> LinkedIn OAuth redirect uses it.

Replace `stmz-kinetic.example.com` in `public/index.html`, `public/sitemap.xml`
and `public/robots.txt` with your real domain.

---

## What's new in Phase 2 (the automation layer)

- **Real server-side scheduler.** Runs every 60 seconds AND is exposed at
  `/api/scheduler/tick` so a free external cron (cron-job.org) keeps it alive
  on free-tier hosting. Finds posts whose `scheduledAt <= now` and `status ===
  'scheduled'` and fires them.
- **LinkedIn OAuth + direct posting.** Users click "Connect LinkedIn" once,
  approve on LinkedIn's screen, and from then on their scheduled LinkedIn posts
  publish to their feed automatically.
- **Universal webhook.** A single URL per user. We POST every fired post to it.
  They route to Instagram / TikTok / X / Facebook / WhatsApp / Telegram via
  Make.com (free tier, 1000 ops/month), Zapier, n8n, or their own server.
- **Share buttons in every post.** Web Share API on mobile (works with Instagram,
  TikTok, anything installed) and deep links on desktop (Twitter/X, LinkedIn,
  Facebook, WhatsApp, Telegram).
- **Ideas view** — AI generates 10 brand-specific ideas, one click to draft.
- **Assistant view** — real chat with brand context loaded automatically.
- **Connect view** — one place to manage LinkedIn + webhook.

---

## How the AI relay works

`server.js` defines a `PROVIDERS` list. It tries them in order — Groq first
(fast, free), then OpenRouter, then Gemini — and **automatically switches to
the next** if one errors or is rate-limited.

```
Groq  →  OpenRouter  →  Gemini
```

Add a key for any of them and it joins the relay. Models are configurable at
the top of `server.js`.

---

## Honest scope

- **LinkedIn auto-posting works on day one.** While your LinkedIn dev app is in
  Development mode, only people you list as App Members can use OAuth. Request
  Marketing Developer Platform access when you need public scale.
- **Instagram / TikTok / X / Facebook / WhatsApp** auto-post through the
  webhook + Make.com / Zapier — no app-review wait, works for every user
  immediately. This is exactly how thousands of SaaS products handle it.
- Nothing in here fakes metrics, inflates engagement, or violates platform
  rules. What it claims to do, it does.

---

## File map

```
stmz-kinetic/
├── server.js                       # Express: AI relay + auth + Paddle webhook + scheduler + LinkedIn OAuth
├── package.json
├── .env.example
├── firestore.rules                 # paste into Firebase console
├── README.md                       # this file
├── PADDLE_PAYONEER_SETUP.md        # payment setup
├── INTEGRATIONS_SETUP.md           # LinkedIn / Make.com / cron setup
└── public/
    ├── index.html                  # landing + workspace shell
    ├── privacy.html · terms.html
    ├── manifest.json · sw.js · robots.txt · sitemap.xml
    ├── og.svg · icon.svg
    ├── css/style.css
    └── js/
        ├── firebase-config.js      # YOU FILL THIS IN
        ├── storage.js              # Firestore + localStorage abstraction
        └── app.js                  # 10 views + post editor + auth + paddle + share
```
