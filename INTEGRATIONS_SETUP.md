# Integrations setup — Phase 2

Three things to wire up so your users can actually auto-post:

1. **LinkedIn** — direct posting to a user's feed (real OAuth).
2. **Universal webhook** — covers every other platform via Make.com / Zapier / n8n.
3. **External cron** — keeps the scheduler ticking on free-tier hosting.

You only need to do Part 1 and Part 3 once (you, the app owner). Part 2 is what
each of your **customers** does inside their own STMZ Kinetic workspace.

---

## Part 1 — LinkedIn (you set this up once)

1. Go to **https://www.linkedin.com/developers/apps** and click **Create app**.
   - App name: STMZ Kinetic
   - LinkedIn Page: any page you control (your business page works)
   - Logo: upload one
   - Legal agreement: accept

2. In the new app's **Products** tab, add (request) these two products:
   - **Sign In with LinkedIn using OpenID Connect** — usually instant approval
   - **Share on LinkedIn** — usually instant approval

3. In the **Auth** tab:
   - Add this exact URL to **Authorized redirect URLs**:
     ```
     https://YOUR-DOMAIN/api/linkedin/callback
     ```
     For local dev also add:
     ```
     http://localhost:3000/api/linkedin/callback
     ```
   - Note the **Client ID** and **Client Secret** at the top of the page.

4. Paste them into your server `.env`:
   ```
   LINKEDIN_CLIENT_ID=<the client id>
   LINKEDIN_CLIENT_SECRET=<the client secret>
   LINKEDIN_STATE_SECRET=<any long random string you make up>
   APP_URL=https://YOUR-DOMAIN     ← important; the redirect uses this
   ```

5. Restart the server. In the app, sign in, go to **Connect**, click
   **Connect LinkedIn**. You'll go through LinkedIn's OAuth screen and bounce
   back with a green "connected" badge.

> **Production scale note:** while your app is in **Development mode**, only
> people you explicitly add as App Members on LinkedIn can use the OAuth flow.
> Once you have real users, request **Marketing Developer Platform** access
> for full public availability. The webhook integration (Part 2) doesn't have
> this limit and covers every user immediately.

---

## Part 2 — Universal webhook (each user wires this themselves)

This is what your users do inside their workspace. It's the same flow you'd
document on a "How to connect Instagram" help page. The good news: one setup
covers Instagram, TikTok, X, Facebook, WhatsApp Business, Telegram, anything.

### What they do (copy this into your help docs)

**Step 1 — Make a Make.com account (free, 1000 ops/month)**
- Go to https://www.make.com and sign up.

**Step 2 — Create a Scenario**
- Click **Create a new scenario**.
- First module: search for **Webhooks** → choose **Custom webhook**.
- Click **Add** → name it "STMZ Kinetic" → **Save** → copy the webhook URL.

**Step 3 — Paste the URL into STMZ Kinetic**
- In their STMZ Kinetic workspace → **Connect** → paste the URL into
  "Universal webhook" → **Save webhook**.
- Hit **Test fire** to send a sample event. Make.com will show "Successfully
  determined" in the webhook module.

**Step 4 — Add the destination module(s)**
- Right-click the webhook module → **Run this module only** → trigger another
  test from STMZ.
- Now add a second module after the webhook. Examples:
  - **Instagram for Business** → "Create a Photo Post" — connect their IG
    Business account (must be Business/Creator type and linked to a Facebook
    Page) and map fields: `caption = caption + ' ' + hashtags`, image URL = `imageUrl`.
  - **Facebook Pages** → "Create a Post" — map `caption + hashtags` to Message,
    `imageUrl` to Photo URL.
  - **X (Twitter)** → "Create a Tweet" — map `hook + caption + hashtags` to Text.
  - **WhatsApp Business** (via Cloud API or third-party module).
  - **Telegram Bot** → "Send a Message" — works great for personal channels.

- Add a **Router** if they want one webhook to fan out to multiple platforms
  based on the `platform` field in the payload.

**Step 5 — Turn the scenario on**
- Top of Make screen → toggle the scenario **ON**.

Now every scheduled post in STMZ Kinetic that fires will POST to the webhook
and Make.com will route it to whichever account they set up.

### The webhook payload shape

```json
{
  "type": "stmz_post",
  "platform": "Instagram",
  "hook": "First-line hook of the post",
  "caption": "Full caption with newlines as \\n",
  "hashtags": ["#tag1", "#tag2"],
  "cta": "Call to action text",
  "imageUrl": "https://image.pollinations.ai/prompt/...",
  "scheduledAt": 1717000000000,
  "firedAt": "2026-06-04T10:00:00.000Z",
  "brand": { "id": "..." }
}
```

The "Test fire" button sends a simpler `type: "stmz_test"` event so users can
verify the connection without a real post.

---

## Part 2b — Telegram direct posting (each user, 1 minute)

Telegram is the only major platform besides LinkedIn that allows direct
posting with zero approval process. Each user connects their own bot:

1. In Telegram, open **@BotFather** (official, verified).
2. Send `/newbot`, pick a display name, then a username ending in `bot`.
   BotFather replies with a **bot token** like `123456789:ABCdefGHI…` — copy it.
3. Add the bot to the channel/group where posts should appear and make it
   an **admin** with "Post messages" permission.
4. **Chat ID**: for a public channel use `@channelusername`. For a private
   group, send any message in the group, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy the
   numeric `chat.id` (often negative for groups).
5. In STMZ Kinetic → **Connect → Telegram**, paste both values and click
   **Save & connect**, then **Send test message**.

From then on, any post whose platform is **Telegram** publishes through the
bot at its scheduled time (scheduler or AutoPilot).

## Part 2c — Voice narration providers (server-side, optional)

The Video Studio voice tries three providers in order:

| Order | Provider        | Key needed | Notes                                  |
|-------|-----------------|-----------|----------------------------------------|
| 1     | StreamElements  | No        | 6 voices; free but occasionally down (502) |
| 2     | Google TTS      | No        | 1 voice; automatic fallback            |
| 3     | ElevenLabs      | Yes       | 6 premium voices; free 10k chars/month |

For reliable, premium-quality narration, create a free key at
https://elevenlabs.io and set `ELEVENLABS_API_KEY=` in your `.env`.
No code changes needed — the provider chain picks it up automatically.

## Part 3 — External cron (keeps the scheduler alive on free hosting)

The server runs an internal scheduler every 60 seconds. **But Render's free tier
sleeps after 15 minutes of no traffic**, which means scheduled posts won't fire
if no one's visiting your site at 9 AM. The fix is free and takes two minutes.

1. Go to **https://cron-job.org** and sign up (free).
2. Click **Create cronjob**.
3. URL:
   ```
   https://YOUR-DOMAIN/api/scheduler/tick?secret=<the SCHEDULER_SECRET from your .env>
   ```
4. Schedule: **every 1 minute** (or every 5 if you want to save free-tier ops).
5. Save and enable.

Every minute cron-job.org pings your tick endpoint. The server wakes up, checks
for due posts, and fires them through LinkedIn and the webhook. Free hosting,
real scheduler, works 24/7.

Alternative free crons: **UptimeRobot**, **EasyCron**, **Render's own paid Cron Job
service** ($1/mo if you want fewer moving parts).

---

## Quick troubleshooting

- **"LinkedIn connection failed"** — almost always means the redirect URL in
  the LinkedIn app doesn't match `APP_URL + /api/linkedin/callback` exactly.
  Check trailing slashes, http vs https, and that `APP_URL` is set in `.env`.

- **Webhook test works but real posts don't fire** — check that
  `FIREBASE_SERVICE_ACCOUNT` is set in `.env`. The scheduler needs Admin access
  to read posts.

- **First scheduler tick query fails with a Firestore index error** — Firestore
  prints a one-click "create index" link in your server logs. Click it once and
  the scheduler runs from then on.

- **LinkedIn post fails with 401** — the access token expired (LinkedIn tokens
  are typically 60 days). User just clicks **Connect LinkedIn** again.
