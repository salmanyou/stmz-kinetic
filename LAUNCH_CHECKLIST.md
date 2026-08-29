# STMZ Kinetic — Launch Checklist

Work top to bottom. Each step says where the details live.
Estimated total time: ~2 hours of focused work.

---

## Phase 1 — Accounts & keys (~30 min, all free)

- [ ] **Groq** — https://console.groq.com → API Keys → create key
      → paste into `.env` as `GROQ_API_KEY=`
- [ ] **Pexels** — https://www.pexels.com/api/new/ → get key
      → `PEXELS_API_KEY=` (powers stock photos AND video clips)
- [ ] **ElevenLabs** (recommended) — https://elevenlabs.io → free account → API key
      → `ELEVENLABS_API_KEY=` (premium voice fallback, 10k chars/month free)
- [ ] Optional extra AI failover: Gemini, OpenRouter, Cerebras keys
      → see comments in `.env.example`

## Phase 2 — Firebase (~20 min)

- [ ] Create project at https://console.firebase.google.com
- [ ] **Authentication** → Sign-in method → enable **Google**
- [ ] **Firestore Database** → Create database (production mode)
- [ ] Firestore → **Rules** tab → paste contents of `firestore.rules` → Publish
- [ ] Project settings → General → Your apps → Web app → copy config
      → paste values into `public/js/firebase-config.js`
- [ ] Project settings → Service accounts → **Generate new private key**
      → minify the JSON to one line → `.env` as `FIREBASE_SERVICE_ACCOUNT=`
      ⚠ NEVER commit this file or paste the key anywhere public.

## Phase 3 — Domain & deploy (~30 min)

⚠ **Important — your domain currently shows GoDaddy's "Coming Soon" page.**
The GoDaddy site builder page is NOT your app. After deploying the app
(below), you must point the domain at it and remove the GoDaddy placeholder:

- [ ] Deploy the app first → follow **DEPLOY.md** (Render free tier walkthrough)
- [ ] In Render → your service → **Settings → Custom Domains** → add
      `stmzkinetic.com` AND `www.stmzkinetic.com` — Render shows you the
      DNS records it needs
- [ ] In GoDaddy → **My Products → stmzkinetic.com → DNS**:
      - Delete/disable GoDaddy "Website Builder" forwarding if present
      - Add **A record**: name `@` → value shown by Render (e.g. `216.24.57.1`)
      - Add **CNAME**: name `www` → value `<your-app>.onrender.com`
- [ ] Wait 10–30 min for DNS, then https://stmzkinetic.com shows YOUR app
      (Render auto-issues the free SSL certificate)
- [ ] `set-domain.sh` already ran for stmzkinetic.com (canonical, og, sitemap,
      robots all branded) — nothing more to do there
- [ ] Set `APP_URL=https://stmzkinetic.com` in Render → Environment
- [ ] Add an external cron to keep the scheduler alive on free hosting
      → **INTEGRATIONS_SETUP.md → Part 3** (cron-job.org, 2 minutes)
- [ ] After the site is live: submit `https://stmzkinetic.com/sitemap.xml`
      in Google Search Console (free) so Google indexes you fast

## Phase 4 — Payments (~20 min)

- [ ] Paddle account + 3 products ($9 / $19 / $49 monthly)
      → **PADDLE_PAYONEER_SETUP.md** (includes Payoneer payout for Pakistan)
- [ ] `.env`: `PADDLE_PRICE_STARTER=`, `PADDLE_PRICE_PRO=`, `PADDLE_PRICE_AGENCY=`,
      `PADDLE_WEBHOOK_SECRET=`
- [ ] Point the Paddle webhook at `https://yourdomain.com/api/paddle/webhook`

## Phase 5 — Live smoke test (~15 min)

Run through this on the LIVE site (not localhost) in Chrome:

- [ ] Sign in with Google → workspace opens
- [ ] Create a brand profile → saves
- [ ] Generate → create a campaign → posts appear with images
- [ ] Video Studio → 30s video with voice → preview plays WITH sound
- [ ] Connect → Telegram → connect your own test bot → **Send test message** arrives
- [ ] Schedule a post with platform = Telegram → fires at scheduled minute
- [ ] Subscribe with Paddle **test card** → tier updates in Settings
- [ ] As Pro (test): 90s video option unlocks; AutoPilot toggle works
- [ ] Sign out → sign in on phone → everything responsive

## Phase 6 — Launch (the part only you can do)

- [ ] Record the 60-second demo → **DEMO_VIDEO_SCRIPT.md** (script written for you)
- [ ] Post it in the six places listed at the bottom of that file
- [ ] Reply to every single comment and DM within the first 48 hours
- [ ] Support inbox: stmzkinetic@gmail.com — answer within 24h like the site promises

---

## When something breaks in week 1 (it will — that's normal)

1. Check the server logs on your host (Render → Logs tab)
2. Check browser DevTools console — all video/audio steps log as `[stmz/…]`
3. AI errors usually mean a key is missing/exhausted → `/healthz` shows which
   providers are configured
4. Voice silent → `X-TTS-Provider` response header shows which provider served;
   all three down is near-impossible

Ship it. Real users teach you more in a week than another month of polish.
