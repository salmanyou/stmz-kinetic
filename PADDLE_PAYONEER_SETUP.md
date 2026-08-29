# Paddle + Payoneer — full setup for Pakistan (and anywhere)

This walks you from zero to **money landing in your Payoneer account when someone subscribes to STMZ Kinetic**. Everything here is free.

> **Why Paddle?** It's a Merchant of Record — they handle global VAT/sales tax, fraud, chargebacks, and they're one of the only major processors that pays out to Payoneer (which works in Pakistan). You don't need a registered business or a US bank.

The whole setup takes **about 60–90 minutes**, plus 2–5 working days for Paddle's identity verification.

---

## Part 0 — Things to have ready before you start

Paddle's verification team will ask for these. Have them ready as JPGs/PDFs in a folder on your computer:

1. **Photo of your CNIC** (both sides) or passport.
2. **A proof of address** dated within the last 90 days — utility bill (K-Electric/SSGC), bank statement, or government letter. Your name and address must be visible.
3. **A Payoneer account.** If you don't have one, do Part 1 first.
4. **Your live URL** (the Render URL from your deploy, e.g. `https://stmz-kinetic.onrender.com`). Paddle needs a live site to review.
5. **Privacy Policy + Terms of Service** pages on your live site. Yours already exist at `/privacy` and `/terms` — Paddle WILL check these. Add your contact email to them before applying.

---

## Part 1 — Create your Payoneer account (skip if you have one)

1. Go to **https://www.payoneer.com** → **Register**.
2. Choose **"Individual"** (or "Company" if you have a registered business; Individual is fine for starting out).
3. Fill in:
   - Email + password
   - Name **exactly** as on your CNIC (this must match Paddle later)
   - Date of birth
   - Mobile number (Pakistan +92)
4. Address — your real address from your CNIC.
5. Security questions.
6. Identity verification — upload your CNIC photo. Payoneer will review within 1–3 working days.
7. **Link a bank account for withdrawal:** in Payoneer dashboard → **Activity → Withdraw → Bank Account → Add new account**. Add your Pakistani bank account. Withdrawals to PK banks usually take 2–3 days and have a small fee (~$1.50 per withdrawal).

While you wait for Payoneer to verify (1–3 days), go set up Paddle (Part 2).

---

## Part 2 — Create your Paddle seller account

1. Go to **https://www.paddle.com** → click **Get started / Sign up**.
2. Use a **professional email address** (not Gmail throwaway; ideally one with your domain or a serious-looking address).
3. On the next screen choose: **Sell digital products / SaaS**.
4. Company information:
   - **Business name** — your name or business name. If you don't have a registered business, use your full legal name and select "Sole proprietor / Individual."
   - **Country** — Pakistan.
   - **Business address** — your real address.
5. **Website URL** — your live deployed STMZ Kinetic URL. Paddle WILL visit and check it. Make sure:
   - The site actually loads.
   - The `/privacy` and `/terms` pages load.
   - There's at least one product/pricing visible (your three tiers).
6. **What you sell** — write a clear paragraph. Example:
   > "STMZ Kinetic is a social media content workspace. Users generate AI-powered social posts, schedule them to a calendar, and auto-post to LinkedIn directly or to other platforms via their connected Make.com/Zapier automation. Sold as a monthly SaaS subscription at three tiers: Starter $9, Pro $19, Agency $49."

7. Submit. You're now in Paddle's **sandbox** (test mode) until you're verified.

---

## Part 3 — While waiting for verification, set up your products

You can do everything below in Paddle's sandbox and it will carry over once verified.

### 3a. Create the three products

In Paddle dashboard:

1. **Catalog → Products → New product.**
2. **Starter** product:
   - Name: `STMZ Kinetic — Starter`
   - Tax category: **SaaS — Standard**
   - Description: "1 brand, 50 AI-generated posts per month, LinkedIn direct posting."
   - Save.
   - Inside the product → **Prices → New price**:
     - Type: **Recurring**
     - Billing cycle: **Monthly**
     - Amount: **9.00 USD**
     - Trial: optional (e.g. 7 days)
     - Save.
   - Copy the **Price ID** (looks like `pri_01abc...`). This is your `PADDLE_PRICE_STARTER`.

3. Repeat for **Pro** ($19) → save the Price ID as `PADDLE_PRICE_PRO`.
4. Repeat for **Agency** ($49) → save as `PADDLE_PRICE_AGENCY`.

### 3b. Get your Client Token (for the frontend checkout button)

1. **Developer Tools → Authentication → Client-side tokens → New token.**
2. Name: `STMZ frontend`. Save.
3. Copy the token. This is your `clientToken` in `public/js/firebase-config.js`.

### 3c. Get your Webhook Secret (so the server can verify Paddle events)

1. **Developer Tools → Notifications → New notification.**
2. **Destination URL:** `https://YOUR-DOMAIN/api/paddle/webhook`
3. **Events to subscribe to:** tick all of these
   - `transaction.completed`
   - `subscription.created`
   - `subscription.activated`
   - `subscription.updated`
   - `subscription.canceled`
   - `subscription.paused`
4. Save.
5. After saving, click the notification → reveal the **secret key** (`pdl_ntfset_...`). This is your `PADDLE_WEBHOOK_SECRET` in `.env`.

### 3d. Paste everything into your code

In `public/js/firebase-config.js`:
```js
export const paddleConfig = {
  environment: "sandbox",                          // change to "production" after verification
  clientToken: "pdl_live_apikey_OR_pdl_sdbx_...",   // from 3b
  priceStarter: "pri_01abc...starter",              // from 3a
  pricePro:     "pri_01abc...pro",                  // from 3a
  priceAgency:  "pri_01abc...agency",               // from 3a
};
```

In `.env` (on Render → Environment, or locally in `.env`):
```
PADDLE_WEBHOOK_SECRET=pdl_ntfset_...   (from 3c)
PADDLE_PRICE_STARTER=pri_01abc...starter
PADDLE_PRICE_PRO=pri_01abc...pro
PADDLE_PRICE_AGENCY=pri_01abc...agency
```

Redeploy. Test a subscription using Paddle's sandbox test card `4242 4242 4242 4242` (any future expiry, any CVC). You should see a Pro/Starter/Agency badge appear in the workspace.

---

## Part 4 — Verification (the bit that takes a few days)

1. In Paddle dashboard, look for **"Verify your account"** or **"Go live"** prompts.
2. Submit:
   - **Identity:** photo of your CNIC (front & back) or passport.
   - **Proof of address:** utility bill / bank statement (≤ 90 days old).
   - **Sometimes:** a short video selfie holding the CNIC. (Their system asks if needed.)
   - **A short description** of who buys your product and how.
3. Submit.
4. Wait. Paddle's review is usually **2–5 working days**. They might come back with questions — answer fast and politely; this speeds things up massively.

While you wait you can still take test payments using sandbox cards. Real cards won't work until verified.

---

## Part 5 — Connect Payoneer for payouts

After Paddle verifies your account:

1. **Paddle dashboard → Account settings → Payouts.**
2. **Add payout method → Payoneer.**
3. Paddle redirects you to Payoneer. **Sign in.**
4. Authorize Paddle as a payment source.
5. Back in Paddle, the Payoneer account is now linked.
6. Set your **payout schedule** (Paddle offers monthly or biweekly).
7. Set your **minimum payout threshold** ($100 is standard).

When subscribers pay, Paddle holds the money (less their fees ~5% + 50¢) and sends it to Payoneer on the schedule. You then withdraw from Payoneer to your Pakistani bank account.

---

## Part 6 — Going live

1. In Paddle, switch your environment from **sandbox** to **live** (also called "production").
2. In `public/js/firebase-config.js` change `environment: "sandbox"` → `environment: "production"`.
3. Regenerate the **live** client token and price IDs (they're different from sandbox). Update both your `firebase-config.js` (live client token + live price IDs) and `.env` (live webhook secret + live price IDs).
4. Update your webhook destination URL in Paddle to point at your live server (it should already, but double-check).
5. Redeploy. Take a real test payment with your own card. You should see money appear in your Paddle balance within a minute.
6. Cancel the test subscription from Paddle (no fee for refunding within 24 hours).

You're now collecting real payments.

---

## Part 7 — What to do when something breaks

**Customers say checkout doesn't open**
- Open browser console. If you see `Paddle is not defined`, the Paddle script didn't load. Check that `<script src="https://cdn.paddle.com/paddle/v2/paddle.js" defer></script>` is in your `index.html`.
- If you see `Invalid client token`, your `clientToken` in `firebase-config.js` is wrong or is sandbox in production.

**Customer paid but doesn't get Pro**
- Open Paddle dashboard → **Developer Tools → Notifications → Logs**. Find the event for that customer.
- If you see **"Failed"** or **"Pending"** — your server's webhook endpoint isn't reachable, or the signature secret is wrong.
- If "Delivered" — the signature is OK; the issue is in your code. Check your server logs around the timestamp.

**Webhook says "invalid signature"**
- The `PADDLE_WEBHOOK_SECRET` in your `.env` doesn't match the one in Paddle. Regenerate in Paddle → copy → redeploy.

**Verification rejected**
- 95% of the time it's because the website isn't clear about what's sold, or the privacy/terms pages are missing or generic. Tighten the pricing copy on your landing page, make sure both legal pages are accessible, and re-submit. Always respond to their email within a day.

---

## Part 8 — Tax stuff (don't skip this part, it bites)

- **Paddle handles VAT/sales tax for the customer** — they collect it, you don't.
- **Your tax obligation in Pakistan:** the money you receive from Paddle is income from export of services. Pakistan's FBR rules favour this — currently a reduced/zero rate for IT export services if you register with the **PSEB** (Pakistan Software Export Board, free) and file annually. Talk to an accountant or check the FBR's IT export schedule before your first big payout. You don't need to do this on day 1, but do it once you cross ~$500/month consistently.
- **Payoneer issues a Form 1099-K to the IRS** for US-source income only. As a Pakistani receiving Payoneer payouts, this typically does not affect you, but keep records.

---

## Quick cheat sheet of every key & where it lives

| Key | Where to get it | Where to paste it |
|---|---|---|
| Paddle client token | Paddle → Developer Tools → Authentication | `public/js/firebase-config.js` → `paddleConfig.clientToken` |
| Paddle Starter price ID | Paddle → Catalog → Starter → Prices | `firebase-config.js` `priceStarter` + `.env` `PADDLE_PRICE_STARTER` |
| Paddle Pro price ID | Paddle → Catalog → Pro → Prices | `firebase-config.js` `pricePro` + `.env` `PADDLE_PRICE_PRO` |
| Paddle Agency price ID | Paddle → Catalog → Agency → Prices | `firebase-config.js` `priceAgency` + `.env` `PADDLE_PRICE_AGENCY` |
| Paddle webhook secret | Paddle → Developer Tools → Notifications → secret | `.env` `PADDLE_WEBHOOK_SECRET` |

That's everything. Total real cost: $0. Setup time: 60–90 minutes of clicking + a few days for verification.
