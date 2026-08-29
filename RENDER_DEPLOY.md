# Render — One-Click Deploy

**For when you have a working international card** (Wise, Payoneer, or any Visa/MC that Stripe accepts).
Until then, follow `CLOUDFLARE_TUNNEL_DEPLOY.md` instead.

This repo includes a `render.yaml` Blueprint, so deployment is mostly clicking
"Deploy" and pasting secrets when prompted.

---

## Prerequisites
- ✅ Code pushed to GitHub (already done — repo at `github.com/salmanyou/stmz-kinetic`)
- ✅ Working international card on file with Render
- ✅ Firebase project set up (auth + Firestore + service account JSON)
- ✅ API keys ready: Groq, Pexels (+ optionally ElevenLabs, Gemini, Cerebras, OpenRouter)

---

## Deploy in 3 steps

### Step 1 — Connect repo as a Blueprint

1. Dashboard → **New + → Blueprint**
2. Connect your GitHub repo `salmanyou/stmz-kinetic`
3. Render reads `render.yaml`, shows you the service it'll create:
   `stmz-kinetic` (web service, Node, Singapore, free plan)

### Step 2 — Fill in secrets

Render prompts you for every `sync: false` variable. Paste:

| Variable | Value |
|---|---|
| `GROQ_API_KEY` | your Groq key (`gsk_...`) |
| `PEXELS_API_KEY` | your Pexels key |
| `ELEVENLABS_API_KEY` | (optional) your ElevenLabs key |
| `GEMINI_API_KEY` | (optional) Gemini key for AI failover |
| `CEREBRAS_API_KEY` | (optional) Cerebras key for AI failover |
| `OPENROUTER_API_KEY` | (optional) OpenRouter for more failover |
| `FIREBASE_SERVICE_ACCOUNT` | the **minified one-line JSON** from Firebase service account |
| `ADMIN_EMAILS` | your Gmail (Founder mode — unlimited free access) |
| `LINKEDIN_CLIENT_ID` | (optional) for LinkedIn direct posting |
| `LINKEDIN_CLIENT_SECRET` | (optional) |
| `PADDLE_*` | leave blank pre-launch; fill in after Paddle approval |

`SCHEDULER_SECRET` and `LINKEDIN_STATE_SECRET` are auto-generated — Render
fills them with strong random values.

Click **Apply**.

### Step 3 — Watch it build

Render starts the first build automatically — takes 3–5 minutes. When you see
"Your service is live 🎉", click the temporary URL Render assigns (looks like
`stmz-kinetic-xxxx.onrender.com`) → your app loads.

---

## After it's live

### Add your Render URL to Firebase
1. https://console.firebase.google.com → your project → Authentication → Settings → Authorized domains
2. Add `stmz-kinetic-xxxx.onrender.com`
3. Test Google sign-in

### Point your domain
1. Render → your service → Settings → Custom Domains → add `stmzkinetic.com` AND `www.stmzkinetic.com`
2. Render shows DNS records — add them at your DNS host (Cloudflare or GoDaddy)
3. Wait 5–30 min, Render auto-issues free SSL
4. Add `stmzkinetic.com` to Firebase Authorized domains too

### Keep scheduler alive (free tier sleeps after 15 min)
- Sign up at cron-job.org
- Create job: `https://stmzkinetic.com/api/scheduler/tick?secret={your SCHEDULER_SECRET from Render env}`
- Schedule: every 5 minutes
- Create a second job: `https://stmzkinetic.com/api/autopilot/tick?secret={same secret}` every hour

---

## Founder mode reminder

Make sure `ADMIN_EMAILS` includes your Gmail address. Then **also** edit
`public/js/app.js` near the top of the file:

```js
const ADMIN_EMAILS = [
  'your-email@gmail.com',  // ← uncomment + paste your address
];
```

Commit + push to GitHub → Render auto-redeploys → sign in → you'll see
**⭐ Founder · Unlimited** in the sidebar. Every limit bypassed.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Build fails with "MODULE_NOT_FOUND" | Re-check `package.json` is committed; redeploy |
| "FIREBASE_SERVICE_ACCOUNT is not JSON" | The JSON must be on ONE LINE. Re-minify and paste again |
| Sign-in error "unauthorized domain" | Add the Render URL to Firebase Authorized domains |
| 502 / health check failures | Open Render logs — almost always a missing required env var |
| Free tier slow first load | Expected — Render sleeps after 15 min idle. The cron-job pings keep it warm |
