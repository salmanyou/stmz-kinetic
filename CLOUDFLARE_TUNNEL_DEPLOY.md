# Free Deployment via Cloudflare Tunnel

**For STMZ Kinetic — Windows · zero cost · zero card.**

This guide turns your Windows laptop into the production server for
stmzkinetic.com. Cloudflare gives you a free public URL with auto SSL and
ties it to your domain. Your code runs unchanged.

**Time:** ~40 minutes start to finish.

---

## What this is and isn't — read first

### What it IS
- A genuinely free, indefinite hosting solution
- Production-grade SSL/HTTPS automatic
- Custom domain (stmzkinetic.com) supported
- Cloudflare's global edge in front (fast worldwide)
- Survives reboots (runs as a Windows Service)

### What it ISN'T
- A laptop replacement — if your laptop is off, the site is off
- Suitable for high traffic — fine for ~100 visits/day, struggles at 10K+
- Maintenance-free forever — you'll want to migrate to real hosting once you have revenue

### The realistic outcome for your launch
- **Week 1–4:** This setup is more than enough. You'll have ~10–50 visitors/day. Your laptop being on while you work is exactly when traffic comes anyway.
- **Once you have 1+ paying customer ($9/mo):** Use that money to fund a Wise virtual card → migrate to Render free tier (truly free forever, no laptop dependency).

This is a launch bridge, not a forever home. And it's the only free bridge that exists in 2026.

---

## Prerequisites (already done)

- ✅ Code working locally (you've already tested `npm start`)
- ✅ stmzkinetic.com purchased at GoDaddy
- ✅ Firebase set up, env vars in a `.env` file
- ⏳ Cloudflare account (free)

---

## Phase A — Set up your `.env` file locally (5 min)

The Render deploy never finished, so your environment variables only exist in Render's UI. Now they need to exist on your laptop.

1. In your project folder (`C:\Users\Elite\Downloads\stmz-kinetic-FINAL (3)\stmz-kinetic\`), create a file named exactly `.env` (with the dot, no extension)

   Tip: in PowerShell, run:
   ```powershell
   New-Item -Path .env -ItemType File
   ```

2. Open `.env` in Notepad. Paste this template and fill in your real values:

   ```
   GROQ_API_KEY=your_new_groq_key
   PEXELS_API_KEY=your_pexels_key
   ELEVENLABS_API_KEY=your_elevenlabs_key
   GEMINI_API_KEY=your_new_gemini_key
   CEREBRAS_API_KEY=your_new_cerebras_key
   OPENROUTER_API_KEY=your_openrouter_if_any
   FIREBASE_SERVICE_ACCOUNT=PASTE_ONE_LINE_MINIFIED_JSON_HERE
   APP_URL=https://stmzkinetic.com
   SCHEDULER_SECRET=mash_keyboard_random_30_chars
   LINKEDIN_STATE_SECRET=different_random_30_chars
   PORT=3000
   ```

3. Save the file. Your `.gitignore` already excludes `.env` so it won't go to GitHub.

4. Test it runs:
   ```powershell
   npm install
   npm start
   ```
   You should see something like `STMZ Kinetic v… listening on :3000`.
   Open http://localhost:3000 in your browser — landing page should load.

5. Stop the server: `Ctrl + C` in the terminal.

If anything fails here, fix it before moving on. The tunnel only forwards traffic — your app needs to run locally first.

---

## Phase B — Move your domain DNS to Cloudflare (15 min, mostly waiting)

GoDaddy holds your domain, but Cloudflare needs to manage its DNS so the tunnel works. **You keep the domain at GoDaddy** — only DNS moves.

### B.1 — Create free Cloudflare account
1. Go to https://dash.cloudflare.com/sign-up
2. Sign up with email (no card required)
3. Verify email

### B.2 — Add your domain
1. Dashboard → **Add a site** → enter `stmzkinetic.com` → Continue
2. Pick the **Free plan** ($0/month) → Continue
3. Cloudflare scans your existing DNS at GoDaddy and shows existing records — usually keep them as-is unless you know they're old GoDaddy parking records
4. Click **Continue**

### B.3 — Cloudflare gives you 2 nameservers
You'll see something like:
```
sage.ns.cloudflare.com
walt.ns.cloudflare.com
```
(your exact ones may differ — use what Cloudflare actually shows you)

**Keep this Cloudflare tab open.**

### B.4 — Update nameservers at GoDaddy
1. Open https://godaddy.com in another tab → Sign in
2. **My Products** → find stmzkinetic.com → click **DNS** (or "Manage DNS")
3. Scroll down to **Nameservers** section → click **Change**
4. Select **Enter my own nameservers (advanced)** or **Custom**
5. Delete the existing GoDaddy nameservers
6. Add both Cloudflare nameservers exactly as shown
7. Save

### B.5 — Wait for propagation
- Back in Cloudflare → click **Done, check nameservers**
- Cloudflare needs to detect the change. Takes 5 min – 2 hours.
- You'll get an email when ready ("Your site is now active on Cloudflare")
- While waiting, continue with Phase C below — it doesn't depend on this.

---

## Phase C — Install Cloudflare Tunnel CLI (10 min)

### C.1 — Download cloudflared for Windows
1. Open https://github.com/cloudflare/cloudflared/releases/latest
2. Scroll to "Assets" → download `cloudflared-windows-amd64.exe`
3. Rename to `cloudflared.exe`
4. Move it to a permanent folder, e.g. `C:\cloudflared\cloudflared.exe`

### C.2 — Add to PATH (so you can run it from anywhere)
1. Press `Win` → type "environment variables" → open "Edit the system environment variables"
2. Click **Environment Variables...** button
3. Under "User variables", click **Path** → **Edit** → **New** → add `C:\cloudflared`
4. Click OK on all dialogs
5. **Close and re-open PowerShell** for PATH to refresh
6. Test: in PowerShell run `cloudflared --version` → should print a version number

### C.3 — Login to Cloudflare from CLI
1. In PowerShell, run:
   ```powershell
   cloudflared tunnel login
   ```
2. Your browser opens → log in → select **stmzkinetic.com** → Authorize
3. You'll see "You have successfully logged in" — close the browser tab
4. PowerShell will say a cert was saved

### C.4 — Create the tunnel
1. In PowerShell:
   ```powershell
   cloudflared tunnel create stmz-kinetic
   ```
2. Output will include a tunnel ID like `abc12345-6789-...` and a credentials file path. **Copy both** — you'll need them.

### C.5 — Create the tunnel config file
1. Open Notepad → paste this (replace `YOUR-TUNNEL-ID` with the ID from C.4):
   ```yaml
   tunnel: YOUR-TUNNEL-ID
   credentials-file: C:\Users\Elite\.cloudflared\YOUR-TUNNEL-ID.json
   ingress:
     - hostname: stmzkinetic.com
       service: http://localhost:3000
     - hostname: www.stmzkinetic.com
       service: http://localhost:3000
     - service: http_status:404
   ```
2. Save As → `C:\Users\Elite\.cloudflared\config.yml` → Set "Save as type" to **All Files** so it doesn't add `.txt`
3. Double-check the file is named exactly `config.yml` (not `config.yml.txt`)

### C.6 — Route DNS through the tunnel
This tells Cloudflare DNS to send stmzkinetic.com to your tunnel:
```powershell
cloudflared tunnel route dns stmz-kinetic stmzkinetic.com
cloudflared tunnel route dns stmz-kinetic www.stmzkinetic.com
```

---

## Phase D — Test it works (5 min)

### D.1 — Start your app
In PowerShell tab 1:
```powershell
cd "C:\Users\Elite\Downloads\stmz-kinetic-FINAL (3)\stmz-kinetic"
npm start
```
Leave this running.

### D.2 — Start the tunnel
Open a SECOND PowerShell window. Run:
```powershell
cloudflared tunnel run stmz-kinetic
```
You'll see logs about routes registering.

### D.3 — Test in browser
- Wait 1 minute for routes to settle
- Open https://stmzkinetic.com in an **incognito window**
- You should see your STMZ Kinetic landing page on your real domain 🎉

### D.4 — Add Cloudflare URL to Firebase authorized domains
- Open https://console.firebase.google.com → your project → Authentication → Settings → **Authorized domains**
- Add `stmzkinetic.com` AND `www.stmzkinetic.com`
- Test Google sign-in on the live site

If sign-in works, you're live. Move on.

---

## Phase E — Make it survive reboots (5 min)

Right now your two PowerShell windows must stay open. That's not sustainable. Let's install the tunnel as a Windows Service so it auto-starts on boot.

### E.1 — Install as service
In an **Administrator** PowerShell (right-click PowerShell → Run as administrator):
```powershell
cloudflared service install
```

This registers cloudflared as a Windows Service. It now starts automatically with Windows.

### E.2 — For the Node app — use PM2 (process manager)
The Node app also needs to survive reboots. Install PM2:
```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install
```

Then start your app under PM2:
```powershell
cd "C:\Users\Elite\Downloads\stmz-kinetic-FINAL (3)\stmz-kinetic"
pm2 start npm --name stmz -- start
pm2 save
```

PM2 will now auto-restart your app on reboot.

### E.3 — Verify
1. Reboot your laptop
2. After login, wait 1 minute
3. Open https://stmzkinetic.com — site should load with no manual steps

---

## Day-to-day operation

### Site is up — what's running
- **Node app:** under PM2, auto-restarts on crash, survives reboot
- **Cloudflare Tunnel:** Windows Service, runs on every boot

### To deploy a code update
1. Edit code locally
2. `pm2 restart stmz` (no need to push to GitHub; this is local code)
3. Done — change is live in ~3 seconds

### To check if something's broken
```powershell
pm2 logs stmz       # see app logs
pm2 status          # see if app is running
```

For tunnel:
```powershell
cloudflared tunnel info stmz-kinetic
```

### Common situations
- **"My internet went down at home"** → site goes down. Comes back when you're online.
- **"I'm traveling"** → if you closed your laptop lid, site is down. Either leave laptop on at home, or accept downtime during travel.
- **"My PC restarted from Windows Update"** → fine. PM2 + service auto-recover within 2 minutes.

---

## When (and how) to migrate off this setup

You should migrate the day you have 1 paying customer. Here's why:
- Your laptop dying or internet going out = lost revenue, bad customer experience
- Real hosting starts at $5/month — covered by one Pro subscription
- The credit card barrier is the only hurdle, and a paid customer = enough cash for a Wise card

**Migration path:**
1. First $9 customer pays
2. Use that money to fund a Wise virtual card (or buy a Payoneer card)
3. Sign up for Render with the working card → deploy the same GitHub repo (no code changes needed)
4. Add Render's IP to Cloudflare DNS → tunnel becomes optional
5. Eventually shut down tunnel — Render hosts directly

I'll write you that migration guide when you reach that point. For now, focus on launch.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `npm start` fails locally | Check `.env` syntax — usually missing quote or line-break in `FIREBASE_SERVICE_ACCOUNT` |
| `cloudflared tunnel run` errors "no such tunnel" | You're in the wrong PowerShell or didn't run `login` first |
| stmzkinetic.com still shows GoDaddy page | Nameservers haven't propagated yet — wait, check dnschecker.org |
| Google sign-in says "unauthorized domain" | Phase D.4 — add stmzkinetic.com to Firebase Authorized domains |
| Cloudflare says "Error 1033 / origin not reachable" | Your Node app crashed — `pm2 logs stmz` to see why |
| Tunnel works briefly then disconnects | Your PC went to sleep — Settings → Power → Never sleep when plugged in |

If you hit something not on this list, send me the exact error message you see — I'll diagnose.
