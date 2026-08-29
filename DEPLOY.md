# Deploy — free, professional, ~30 minutes

The recommended path: **Render + a free or cheap domain + cron-job.org**. Everything below is free except optional domain registration (~$1–10/year).

---

## Why Render (and not Vercel/Netlify/Fly)

STMZ Kinetic needs a **persistent Node.js process** because:
- The post scheduler runs `setInterval` every 60 seconds
- The AutoPilot scheduler runs hourly
- The LinkedIn OAuth callback needs a stable server route

This rules out **Vercel** and **Netlify** (their serverless functions can't run `setInterval` between requests). **Fly.io** works but has more setup. **Railway** works great but only gives $5/month free.

**Render's free Web Service** gives you 750 hours/month (essentially always-on), a free `*.onrender.com` subdomain with HTTPS, automatic deploys from GitHub, and a real Node.js runtime. It sleeps after 15 min of no traffic, but cron-job.org pinging the scheduler endpoint keeps it warm — so you get a persistent server for $0.

---

## Step-by-step (first deploy)

### 1. Push your code to GitHub (5 min)

```bash
cd path/to/stmz-kinetic
git init
git add .
git commit -m "Initial commit"
```

Then create a new repo on GitHub (private is fine). Follow the on-screen "push an existing repository" instructions GitHub shows you.

### 2. Pick your domain (5 min — optional but recommended)

**Three honest options, in order of professionalism:**

| Option | Cost | URL looks like | Best for |
|---|---|---|---|
| **Render free subdomain** | $0 | `stmz-kinetic.onrender.com` | Testing, MVP, first 10 customers |
| **Free real subdomain** | $0 | `stmz.is-a.dev` or `stmz.js.org` or `stmz.eu.org` | Looks legit, free forever |
| **Real `.com`** | ~$1–10/year | `stmzkinetic.com` | Professional, best for paying customers |

For the free subdomain route: open https://github.com/is-a-dev/register and follow the README — it's a GitHub pull request, takes ~24h to be approved.

For a real `.com`: **Porkbun.com** has `.com` domains for ~$10/year, no upsells. **Namecheap** has occasional $1 first-year deals. Avoid GoDaddy.

You can launch on the Render subdomain and switch to a real domain later — set the placeholder swap (next step) to whatever you have now.

### 3. Set the domain in your code (30 seconds)

```bash
chmod +x set-domain.sh
./set-domain.sh your-actual-domain.com
```

This swaps every `REPLACE-WITH-YOUR-DOMAIN.com` in `index.html`, `sitemap.xml`, `robots.txt`, and the footer email. Commit and push:

```bash
git add -A && git commit -m "Set domain" && git push
```

### 4. Deploy to Render (5 min)

1. Sign up at **https://render.com** (use your GitHub account — one click).
2. Dashboard → **New** → **Web Service**.
3. Click **Connect a repository** → pick your stmz-kinetic repo.
4. Fill in:
   - **Name:** `stmz-kinetic` (will give you `https://stmz-kinetic.onrender.com`)
   - **Region:** pick closest to your customers (Frankfurt for EU + Asia)
   - **Branch:** `main`
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** **Free**
5. Scroll to **Environment Variables** and add the keys from your `.env`:
   - `GROQ_API_KEY` (and optionally `OPENROUTER_API_KEY`, `GEMINI_API_KEY`)
   - `FIREBASE_SERVICE_ACCOUNT` (the whole JSON — Render handles long values fine)
   - `PADDLE_WEBHOOK_SECRET` + `PADDLE_PRICE_STARTER` + `PADDLE_PRICE_PRO` + `PADDLE_PRICE_AGENCY`
   - `LINKEDIN_CLIENT_ID` + `LINKEDIN_CLIENT_SECRET` + `LINKEDIN_STATE_SECRET`
   - `SCHEDULER_SECRET` (any long random string)
   - `APP_URL` = `https://stmz-kinetic.onrender.com` (or your custom domain)
6. Click **Create Web Service**. Render builds and deploys. About 2–5 minutes.

When the log shows `STMZ Kinetic running on …`, open the URL — your site is live.

### 5. Connect your custom domain (optional, 5 min)

If you have a custom domain:

1. Render dashboard → your service → **Settings** → **Custom Domains** → **Add custom domain** → type your domain.
2. Render gives you DNS records to add. Go to your domain registrar (Porkbun / Namecheap / wherever) → DNS settings → add the records exactly as Render shows.
3. Wait 5 minutes to 24 hours for DNS to propagate. Render auto-issues HTTPS once propagation completes.
4. Once live, update `APP_URL` in Render's environment variables to your custom domain, click **Manual deploy** → **Clear build cache & deploy**.

### 6. Set up the scheduler cron (3 min)

The free tier sleeps after 15 minutes of no traffic. To keep the scheduler firing posts on time:

1. Sign up at **https://cron-job.org** (free).
2. **Create cronjob.**
3. URL: `https://YOUR-DOMAIN/api/scheduler/tick?secret=<your SCHEDULER_SECRET>`
4. Schedule: **every 1 minute**.
5. Save and enable.

Also add a second cronjob for AutoPilot (hourly):

- URL: `https://YOUR-DOMAIN/api/autopilot/tick?secret=<your SCHEDULER_SECRET>`
- Schedule: every **15 minutes** (it internally rate-limits to once per user per cadence window)

### 7. Paste Firestore rules (1 min)

Firebase Console → your project → **Firestore Database** → **Rules** tab → delete everything → paste the contents of `firestore.rules` → **Publish**.

### 8. Enable Google sign-in (1 min)

Firebase Console → **Authentication** → **Sign-in method** → **Google** → toggle Enable → Save.

### 9. Test it end-to-end (10 min)

1. Open your live URL.
2. Click **Start free** → workspace opens.
3. Click **Sign in** (top right) → Google popup → sign in.
4. Onboarding wizard appears → set up a test brand.
5. Click **Generate** → should produce 3 posts with images.
6. Open one post → click **🎬 Make video** → WebM downloads.
7. **Connect** tab → LinkedIn → connect (will only work if your LinkedIn dev app is set up per `INTEGRATIONS_SETUP.md`).
8. **AutoPilot** tab → configure → save → **Generate this week now** (requires Pro subscription; use Paddle sandbox test card `4242 4242 4242 4242` to test).

If anything fails, check Render logs (Dashboard → your service → **Logs**) — Node will print the exact error.

---

## After launch — distribution checklist

The code is done. Real income depends on these next steps, in order:

1. **Record one 60-second screen video** of you using AutoPilot to generate a week of content for a fictional brand in your niche. Upload to YouTube + LinkedIn.
2. **Post that video in three places**:
   - One local Facebook group for small businesses (e.g. "Pakistan E-commerce Owners", "Karachi Entrepreneurs")
   - LinkedIn (organic, no boost — just post it from your profile)
   - One Reddit community (r/smallbusiness, r/Entrepreneur, or a niche-specific one)
3. **DM five small business owners you know personally** with a link to your demo video. Not strangers — people who know you. Ask if they'd try it.
4. **Track conversion**: of 100 visitors, how many click Start Free → how many sign in → how many subscribe? If <2% sign in from visitors, your landing page needs work. If sign-in is fine but no subscriptions, your pricing/onboarding needs work. If subscriptions happen, double down on the channel that brought them.

That's the playbook every founder uses. No bots, no spam — just one good demo seen by real people.
