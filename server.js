/**
 * STMZ KINETIC — Server (Phase 2)
 * ---------------------------------------------------------------------------
 * Real backend: multi-provider AI relay with auto-failover, Firebase-verified
 * subscriptions, Paddle webhook, plus the Phase 2 automation layer:
 *   • Server-side scheduler that fires due posts every minute
 *   • LinkedIn OAuth + direct posting to user's feed
 *   • Universal webhook firing for Make.com / Zapier / n8n / etc.
 *   • AI endpoints for content ideas + general assistant
 */

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const app = express();
app.use(cors());

/* ============================================================
   Firebase Admin (optional but recommended)
   ============================================================ */
let adminAuth = null, adminDb = null;
(async () => {
  try {
    let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) { console.log('[firebase] FIREBASE_SERVICE_ACCOUNT not set — server-side checks/scheduler disabled.'); return; }
    if (!raw.trim().startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(raw);
    const admin = await import('firebase-admin');
    const a = admin.default || admin;
    if (!(a.apps && a.apps.length)) a.initializeApp({ credential: a.credential.cert(serviceAccount) });
    adminAuth = a.auth();
    adminDb = a.firestore();
    console.log('[firebase] Admin initialised.');
  } catch (err) {
    console.error('[firebase] Admin init failed:', err.message);
  }
})();

/* ============================================================
   AI RELAY — Groq → OpenRouter → Gemini, with multi-key per provider
   ------------------------------------------------------------
   You can paste multiple keys for the same provider in .env,
   separated by commas, e.g.:
     GROQ_API_KEY=gsk_aaa...,gsk_bbb...,gsk_ccc...
   The relay round-robins through them and automatically tries
   the next key on rate-limits/errors before falling through to
   the next provider.
   ============================================================ */
function parseKeys(envVar) {
  const v = process.env[envVar];
  if (!v) return [];
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

// Round-robin cursor per provider so load is spread across keys.
const keyCursor = { groq:0, openrouter:0, gemini:0, cerebras:0 };
function nextKey(provider, keys) {
  if (!keys.length) return null;
  const i = keyCursor[provider] % keys.length;
  keyCursor[provider] = (keyCursor[provider] + 1) % keys.length;
  return keys[i];
}

const PROVIDERS = [
  { name:'groq',
    keys() { return parseKeys('GROQ_API_KEY'); },
    enabled() { return this.keys().length > 0; },
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    async call(sys, usr) {
      const keys = this.keys();
      let lastErr;
      for (let i = 0; i < keys.length; i++) {
        const key = nextKey('groq', keys);
        try {
          const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method:'POST',
            headers:{ 'Authorization':`Bearer ${key}`, 'Content-Type':'application/json' },
            body: JSON.stringify({ model:this.model, messages:[{role:'system',content:sys},{role:'user',content:usr}], temperature:0.7, max_tokens:1600 })
          });
          if (r.status === 429 || r.status === 401) { lastErr = new Error(`groq ${r.status}`); continue; }
          if (!r.ok) throw new Error(`groq ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('groq: all keys exhausted');
    }
  },
  { name:'openrouter',
    keys() { return parseKeys('OPENROUTER_API_KEY'); },
    enabled() { return this.keys().length > 0; },
    model: process.env.OPENROUTER_MODEL || 'openrouter/free',
    async call(sys, usr) {
      const keys = this.keys(); let lastErr;
      for (let i = 0; i < keys.length; i++) {
        const key = nextKey('openrouter', keys);
        try {
          const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method:'POST',
            headers:{ 'Authorization':`Bearer ${key}`, 'Content-Type':'application/json', 'HTTP-Referer': APP_URL, 'X-Title':'STMZ Kinetic' },
            body: JSON.stringify({ model:this.model, messages:[{role:'system',content:sys},{role:'user',content:usr}], temperature:0.7, max_tokens:1600 })
          });
          if (r.status === 429 || r.status === 401) { lastErr = new Error(`openrouter ${r.status}`); continue; }
          if (!r.ok) throw new Error(`openrouter ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('openrouter: all keys exhausted');
    }
  },
  { name:'gemini',
    keys() { return parseKeys('GEMINI_API_KEY'); },
    enabled() { return this.keys().length > 0; },
    model: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    async call(sys, usr) {
      const keys = this.keys(); let lastErr;
      for (let i = 0; i < keys.length; i++) {
        const key = nextKey('gemini', keys);
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${key}`;
          const r = await fetch(url, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ systemInstruction:{parts:[{text:sys}]}, contents:[{role:'user',parts:[{text:usr}]}], generationConfig:{temperature:0.7,maxOutputTokens:1600} })
          });
          if (r.status === 429 || r.status === 401 || r.status === 403) { lastErr = new Error(`gemini ${r.status}`); continue; }
          if (!r.ok) throw new Error(`gemini ${r.status}`);
          return (await r.json()).candidates?.[0]?.content?.parts?.map(p=>p.text).join('').trim();
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('gemini: all keys exhausted');
    }
  },
  // Cerebras — fast inference, free tier 14,400 req/day per key, OpenAI-compatible
  { name:'cerebras',
    keys() { return parseKeys('CEREBRAS_API_KEY'); },
    enabled() { return this.keys().length > 0; },
    model: process.env.CEREBRAS_MODEL || 'gpt-oss-120b',
    async call(sys, usr) {
      const keys = this.keys(); let lastErr;
      for (let i = 0; i < keys.length; i++) {
        const key = nextKey('cerebras', keys);
        try {
          const r = await fetch('https://api.cerebras.ai/v1/chat/completions', {
            method:'POST',
            headers:{ 'Authorization':`Bearer ${key}`, 'Content-Type':'application/json' },
            body: JSON.stringify({ model:this.model, messages:[{role:'system',content:sys},{role:'user',content:usr}], temperature:0.7, max_tokens:1600 })
          });
          if (r.status === 429 || r.status === 401) { lastErr = new Error(`cerebras ${r.status}`); continue; }
          if (!r.ok) throw new Error(`cerebras ${r.status}`);
          return (await r.json()).choices?.[0]?.message?.content?.trim();
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('cerebras: all keys exhausted');
    }
  },
];

async function relay(system, user) {
  const active = PROVIDERS.filter(p=>p.enabled());
  if (!active.length) { const e = new Error('NO_PROVIDER'); e.code='NO_PROVIDER'; throw e; }
  let lastErr;
  for (const p of active) {
    try { const text = await p.call(system, user); if (text && text.length) return { text, provider:p.name, model:p.model }; throw new Error(`${p.name} empty`); }
    catch (err) { lastErr = err; console.warn(`[relay] ${p.name} failed (${err.message}) — failing over...`); }
  }
  const e = new Error('ALL_PROVIDERS_FAILED: ' + (lastErr?.message || '?')); e.code='ALL_FAILED'; throw e;
}

const SYSTEM_PROMPTS = {
  writer:
    'You are a senior marketing copywriter. Produce clear, persuasive, ready-to-publish copy. ' +
    'Match the requested format and platform. Output only the copy, no preamble.',
  assistant:
    'You are STMZ Kinetic, a sharp, practical marketing assistant. Give concise, accurate, actionable answers ' +
    'specific to the brand context you are given. If unsure, say so plainly — never invent facts.',
  campaign:
    'You are a senior social media strategist and copywriter. You generate complete, platform-native content calendars ' +
    'for a specific brand. You MUST reply with STRICT, valid JSON only — no markdown, no commentary, no code fences. ' +
    'The JSON shape is exactly: { "posts": [ { "day": <int>, "platform": "<string>", "time": "<HH:MM>", ' +
    '"theme": "<short angle>", "hook": "<scroll-stopping first line>", ' +
    '"caption": "<full ready-to-post caption with line breaks as \\n>", "hashtags": ["#tag", ...], ' +
    '"cta": "<call to action>", "stockQuery": "<2-3 word CONCRETE photo search keyword matching this post, e.g. \\"coffee shop owner\\", \\"leather sandals\\", \\"gym workout\\" — literal objects/people/places, never abstract>", "imagePrompt": "<concise vivid visual description for an image generator, no text in image>" } ] } ' +
    'Vary angles across posts (educational, social proof, offer, behind-the-scenes, story, tips). Use realistic posting times. ' +
    'If the brief includes PAST PERFORMANCE INSIGHTS, lean toward the patterns of top performers and away from the patterns of low performers.',
  variants:
    'You generate alternative versions of a social media caption. Output STRICT JSON only — no markdown, no commentary. ' +
    'Shape: { "variants": [ "<full alternative caption 1>", "<alternative 2>", ... ] }. ' +
    'Each variant should say the same thing but in a different voice / angle: one bolder, one more direct, one more conversational. Same length range as the original.',
  repurpose:
    'You adapt a social media post from one platform to another, matching the destination platform native style. ' +
    'Twitter/X = punchy short, hooky opener, dense; LinkedIn = thoughtful, paragraphs, professional; Instagram = visual+evocative caption; ' +
    'TikTok = casual hooky spoken script; Facebook = warm conversational. Reply with STRICT JSON only. ' +
    'Shape: { "hook": "<...>", "caption": "<...>", "hashtags": ["#tag"], "cta": "<...>", "stockQuery": "<2-3 word CONCRETE photo search keyword matching this post, e.g. \\"coffee shop owner\\", \\"leather sandals\\", \\"gym workout\\" — literal objects/people/places, never abstract>", "imagePrompt": "<visual idea>" }',
  videoScript:
    'You are a senior short-form video scriptwriter for social media (Reels, TikTok, Shorts). ' +
    'Given a brand and a prompt, produce a multi-scene script optimised for scroll-stopping vertical video. ' +
    'Reply with STRICT JSON only — no markdown, no commentary. ' +
    'Shape: { "title": "<short video title 2-6 words>", ' +
    '"scenes": [ { "caption": "<punchy on-screen text, max 8 words, ALL-CAPS allowed for emphasis>", ' +
    '"narration": "<one natural sentence the voiceover speaks for THIS scene — describes/explains what is happening, NOT just the caption text. Must FIT the scene duration: ~2 words per second (so a 3-second scene = ~6 words, 5-second scene = ~10 words). Speak in the brand voice. Sound like a human, not a label reader.>", ' +
    '"stockQuery": "<2-3 word stock photo search keyword for THIS scene, e.g. \\"summer beach\\", \\"leather workshop\\", \\"happy customer\\" — concrete, visual, photographable, NOT abstract>", ' +
    '"imagePrompt": "<vivid, detailed visual description for an AI image generator (used as fallback if stock photo unavailable) — describe a single static scene with lighting, mood, composition, no text in image, photo-realistic, cinematic, lifestyle photography style>", ' +
    '"duration": <2 to 5 second integer> } ], ' +
    '"endCaption": "<final scene CTA, e.g. \\"Link in bio\\">", "totalSeconds": <sum of all durations> } ' +
    'Rules: ' +
    'open with a hook caption that creates curiosity in 4 words or less; each scene caption pays off the previous; the last scene must be a clear CTA. ' +
    'CRITICAL — narration is what the voice ACTUALLY says: full natural sentence, conversational, describing/explaining the scene. ' +
    'Never make narration just repeat the caption. Example — if caption is "DISCOVER", narration could be "Meet the leather sandals everyone is talking about." ' +
    'stockQuery must be CONCRETE and VISUAL (objects, places, people doing things) — Pexels searches the literal words. ' +
    'Image prompts must be DIFFERENT visuals across scenes. Vary angle, subject, lighting, location.',
  contentLift:
    'You are a senior content strategist who turns long-form material into platform-native social campaigns. ' +
    'Given source content (an article, blog post, transcript, notes, or anything textual) and a brand profile, ' +
    'extract the 5–7 most valuable, distinct ideas in the source and produce one social media post per idea — each on the most suitable platform, ready to publish. ' +
    'Reply with STRICT JSON only — no markdown, no commentary, no preamble. ' +
    'Shape: { "summary": "<one-sentence summary of the source>", ' +
    '"posts": [ { "platform": "<Instagram | LinkedIn | TikTok | X / Twitter | Facebook | Telegram>", ' +
    '"hook": "<scroll-stopping first line>", ' +
    '"caption": "<full ready-to-post caption, with \\n line breaks>", ' +
    '"hashtags": ["#tag", "#tag"], ' +
    '"cta": "<call to action>", ' +
    '"stockQuery": "<2-3 word CONCRETE photo search keyword matching this post, e.g. \\"coffee shop owner\\", \\"leather sandals\\", \\"gym workout\\" — literal objects/people/places, never abstract>", ' +
    '"imagePrompt": "<vivid visual description for image generator, no text in image>" } ] } ' +
    'Each post should cover a DIFFERENT idea from the source. Mix platforms across the campaign. ' +
    'Match the brand voice exactly. Never copy sentences verbatim from the source — always rewrite in the brand voice.',
  replyAssistant:
    'You are an expert community manager. Given an incoming comment or DM (in any language) and a brand profile, ' +
    'generate 3 reply options that protect the brand voice, are appropriate for the relationship (customer / lead / hater / fan), ' +
    'and move the conversation forward without sounding robotic. ' +
    'Reply with STRICT JSON only. Shape: ' +
    '{ "intent": "<detected intent: question | praise | complaint | sales-lead | troll | other>", ' +
    '"replies": [ { "label": "<short label like \\"Friendly\\", \\"Direct\\", \\"Witty\\">", "text": "<full reply, max 280 chars unless context demands longer>" } ] } ' +
    'For complaints: lead with acknowledgement, never argue. ' +
    'For sales leads: end with a soft next step (e.g. DM link, calendar link, reply guide). ' +
    'For trolls: brief, polite, no engagement bait. ' +
    'For praise: warm and human, sometimes funny if brand voice allows.',
  insights:
    'You are a senior social media analyst. Given a brand and a list of the user\'s recent posts WITH manual engagement numbers ' +
    '(likes, comments, shares, reach), write a concise, ACTIONABLE insights brief. ' +
    'Reply with STRICT JSON only. Shape: ' +
    '{ "topThemes": ["<short pattern in top performers>", ...], ' +
    '"lowThemes": ["<short pattern in low performers>", ...], ' +
    '"bestPlatform": "<single platform name based on data>", ' +
    '"bestTimeOfDay": "<HH:MM or descriptive window>", ' +
    '"actionable": "<2-4 sentence specific recommendation the user can apply next week — name actual hook styles, topics, formats from THEIR data>" } ' +
    'Do not be generic. Cite specific patterns from their data. If data is thin (<5 posts with engagement), say so honestly in the actionable field.',
  bulkProduct:
    'You are a senior e-commerce social media copywriter. Given a list of products (with name, description, price, and optional category), ' +
    'generate a complete social media campaign — multiple platform-native posts per product covering different angles (feature, story, social proof, FOMO, lifestyle). ' +
    'Reply with STRICT JSON only — no markdown. Shape: ' +
    '{ "campaign": [ { "productName": "<exact name>", "posts": [ ' +
    '{ "platform": "<Instagram | LinkedIn | TikTok | X / Twitter | Facebook | Telegram>", ' +
    '"hook": "<...>", "caption": "<...>", "hashtags": ["#tag"], "cta": "<...>", ' +
    '"stockQuery": "<2-3 word CONCRETE photo search keyword matching this post, e.g. \\"coffee shop owner\\", \\"leather sandals\\", \\"gym workout\\" — literal objects/people/places, never abstract>", "imagePrompt": "<vivid visual description, no text in image, photo-realistic lifestyle photography>" } ] } ] } ' +
    'Default to 3 posts per product spread across 2-3 platforms. Vary angles within each product — never make all 3 posts the same idea. ' +
    'Match the brand voice exactly. Keep captions punchy and conversion-focused.',
  ideas:
    'You are a content strategist. Given a brand, generate 10 specific, creative content ideas tailored to it. ' +
    'Reply with STRICT, valid JSON only — no markdown, no code fences. Shape: ' +
    '{ "ideas": [ { "title": "<headline-style idea>", "angle": "<one sentence on the angle>", ' +
    '"platform_hint": "<best platform>", "format": "<carousel|reel|post|short|article>", ' +
    '"stockQuery": "<2-3 word CONCRETE photo search keyword for this idea, literal objects/people/places>" } ] } ' +
    'Make each idea distinct and immediately actionable. Avoid generic advice; tie ideas to the brand specifics.',
};

// Pull the first valid JSON object/array out of a model response (handles fences, prose preambles).
function extractJSON(text) {
  if (!text) return null;
  let t = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(t); } catch {}
  const start = t.search(/[\[{]/); if (start === -1) return null;
  const open = t[start]; const close = open === '{' ? '}' : ']';
  let depth = 0, end = -1;
  for (let i = start; i < t.length; i++) { if (t[i] === open) depth++; else if (t[i] === close) { depth--; if (depth === 0) { end = i; break; } } }
  if (end === -1) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

/* ============================================================
   Demo rate limit + subscription check
   ============================================================ */
const DEMO_LIMIT = parseInt(process.env.DEMO_LIMIT || '3', 10);
const demoBuckets = new Map();
function todayKey() { return new Date().toISOString().slice(0,10); }
function demoConsume(ip) {
  const day = todayKey();
  const b = demoBuckets.get(ip);
  if (!b || b.day !== day) { demoBuckets.set(ip,{count:1,day}); return {allowed:true, remaining: DEMO_LIMIT-1}; }
  if (b.count >= DEMO_LIMIT) return {allowed:false, remaining:0};
  b.count += 1; return {allowed:true, remaining: DEMO_LIMIT - b.count};
}

// Per-IP rolling rate limit for unauthenticated proxy endpoints.
// Prevents abuse of /api/tts, /api/img-proxy, /api/stock-video as free
// bandwidth or free TTS by other websites.
const proxyBuckets = new Map();
const PROXY_LIMIT_PER_MIN = parseInt(process.env.PROXY_LIMIT_PER_MIN || '60', 10);
function proxyAllow(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = proxyBuckets.get(ip) || [];
  const recent = arr.filter(t => t > windowStart);
  if (recent.length >= PROXY_LIMIT_PER_MIN) {
    proxyBuckets.set(ip, recent);
    return false;
  }
  recent.push(now);
  proxyBuckets.set(ip, recent);
  // Opportunistically clean up old buckets so the Map doesn't grow forever
  if (proxyBuckets.size > 5000) {
    for (const [k, v] of proxyBuckets) {
      if (v.length === 0 || v[v.length-1] < windowStart) proxyBuckets.delete(k);
    }
  }
  return true;
}
function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
}

// ─── Founder admin bypass ───
// Set ADMIN_EMAILS in .env as a comma-separated list of Gmail addresses
// that get unlimited free access regardless of subscription. Example:
//   ADMIN_EMAILS=you@gmail.com,cofounder@gmail.com
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .toLowerCase()
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

async function checkSubscription(req) {
  try {
    if (!adminAuth || !adminDb) return { active:false, expiresAt:null, tier:null, reason:'no-admin' };
    const authz = req.headers.authorization || '';
    const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!token) return { active:false, expiresAt:null, tier:null, reason:'no-token' };
    const decoded = await adminAuth.verifyIdToken(token);
    // ─── Founder bypass: full unlimited access ───
    if (decoded.email && ADMIN_EMAILS.includes(decoded.email.toLowerCase())) {
      return { active:true, founder:true, expiresAt:null, tier:'founder', uid:decoded.uid };
    }
    const snap = await adminDb.collection('users').doc(decoded.uid).get();
    if (!snap.exists) return { active:false, expiresAt:null, tier:null, uid:decoded.uid };
    const sub = snap.data()?.subscription;
    if (!sub || sub.status !== 'active') return { active:false, expiresAt:null, tier:null, uid:decoded.uid };
    if (sub.expiresAt && Date.now() > sub.expiresAt) return { active:false, expiresAt:sub.expiresAt, tier:null, uid:decoded.uid };
    return { active:true, expiresAt: sub.expiresAt || null, tier: sub.tier || sub.plan || 'pro', uid: decoded.uid };
  } catch (err) {
    return { active:false, expiresAt:null, tier:null, reason:err.message };
  }
}

/* ============================================================
   Public health + me endpoints
   ============================================================ */
app.get('/healthz', (req, res) => {
  res.json({
    ok:true,
    providers: PROVIDERS.filter(p=>p.enabled()).map(p=>p.name),
    firebaseAdmin: !!adminAuth,
    linkedin: !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET),
    pexels: !!process.env.PEXELS_API_KEY,
    cerebras: !!process.env.CEREBRAS_API_KEY,
    scheduler: !!adminDb,
    demoLimit: DEMO_LIMIT,
  });
});

app.get('/api/me', express.json(), async (req, res) => {
  const sub = await checkSubscription(req);
  res.json({ active: sub.active, expiresAt: sub.expiresAt, tier: sub.tier });
});

/* ============================================================
   AI: /api/generate (writer/assistant) + /api/campaign + /api/ideas
   ============================================================ */
async function gateAndRelay(req, res, { systemKey, user, parseJSON }) {
  const sub = await checkSubscription(req);
  let demoRemaining = null;
  if (!sub.active) {
    const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown').trim();
    const demo = demoConsume(ip);
    demoRemaining = demo.remaining;
    if (!demo.allowed) {
      return res.status(402).json({ error:'DEMO_LIMIT_REACHED', message:`You've used your ${DEMO_LIMIT} free runs for today. Subscribe to unlock unlimited.`, remaining:0 });
    }
  }
  try {
    const out = await relay(SYSTEM_PROMPTS[systemKey], user);
    if (parseJSON) {
      const parsed = extractJSON(out.text);
      if (!parsed) return res.status(502).json({ error:'PARSE_FAILED', message:'The AI returned an unexpected format. Please try again.' });
      return res.json({ ...parsed, provider: out.provider, model: out.model, subscribed: sub.active, demoRemaining });
    }
    res.json({ text: out.text, provider: out.provider, model: out.model, subscribed: sub.active, demoRemaining });
  } catch (err) {
    if (err.code === 'NO_PROVIDER') return res.status(503).json({ error:'NO_PROVIDER', message:'No AI provider configured. Add GROQ_API_KEY (free).' });
    console.error(`[${systemKey}] failed:`, err.message);
    res.status(502).json({ error:'RELAY_FAILED', message:'All AI providers are busy. Please try again.' });
  }
}

app.post('/api/generate', express.json({limit:'1mb'}), async (req, res) => {
  const { tool='assistant', prompt='', context='' } = req.body || {};
  if (!prompt) return res.status(400).json({ error:'Missing prompt.' });
  const user = context ? `${context}\n\n${prompt}` : prompt;
  await gateAndRelay(req, res, { systemKey: tool, user, parseJSON: false });
});

// Shared: map a language code → an instruction appended to AI prompts so the
// generated captions/hooks/hashtags come out in that language. English = no-op.
const LANG_NAMES_GEN = {
  en:'English', es:'Spanish', fr:'French', de:'German', it:'Italian', pt:'Portuguese',
  nl:'Dutch', ru:'Russian', ar:'Arabic', hi:'Hindi', ur:'Urdu', bn:'Bengali', tr:'Turkish',
  id:'Indonesian', ms:'Malay', th:'Thai', vi:'Vietnamese', ja:'Japanese', ko:'Korean',
  'zh-CN':'Chinese (Mandarin)', pl:'Polish', uk:'Ukrainian', ro:'Romanian', el:'Greek',
  sv:'Swedish', fa:'Persian', ta:'Tamil', te:'Telugu', fil:'Filipino', sw:'Swahili',
};
function langInstruction(lang) {
  const code = (lang || 'en').toString();
  if (code === 'en') return '';
  const name = LANG_NAMES_GEN[code] || 'English';
  return ` IMPORTANT: Write ALL hooks, captions, and CTAs in natural, fluent ${name} ` +
    `(not translated-sounding). Hashtags may stay in English or ${name}, whichever a native speaker would use. ` +
    `Any "stockQuery" or "imagePrompt" fields stay in ENGLISH (for image search). Everything the audience reads must be in ${name}.`;
}

app.post('/api/campaign', express.json({limit:'1mb'}), async (req, res) => {
  const body = req.body || {};
  const brand = body.brand || {};
  const platforms = body.platforms || ['Instagram'];
  const goal = body.goal || 'grow awareness';
  const count = body.count ?? 7;
  const days = body.days ?? 7;
  if (!brand.name) return res.status(400).json({ error:'Brand name is required.' });
  const sub = await checkSubscription(req);
  const n = sub.active ? Math.min(parseInt(count,10) || 7, 30) : Math.min(parseInt(count,10) || 3, 3);
  const user =
    `BRAND PROFILE\nName: ${brand.name}\nWhat they sell: ${brand.what || 'n/a'}\n` +
    `Target audience: ${brand.audience || 'general'}\nVoice / tone: ${brand.tone || 'friendly and professional'}\n` +
    `Key offer / link: ${brand.offer || 'n/a'}\n\nTASK: Create exactly ${n} social media posts spread across ${days} day(s) ` +
    `for these platform(s): ${platforms.join(', ')}. Campaign goal: ${goal}.` +
    langInstruction(body.lang) +
    ` Return STRICT JSON in the required shape.`;
  req.body._n = n;
  await gateAndRelay(req, res, { systemKey:'campaign', user, parseJSON:true });
});

app.post('/api/ideas', express.json({limit:'1mb'}), async (req, res) => {
  const body = req.body || {};
  const brand = body.brand || {};
  const theme = body.theme || '';
  if (!brand.name) return res.status(400).json({ error:'Brand name is required.' });
  const user =
    `BRAND\nName: ${brand.name}\nSells: ${brand.what || 'n/a'}\nAudience: ${brand.audience || 'n/a'}\nVoice: ${brand.tone || 'friendly'}\n` +
    (theme ? `Theme to focus on: ${theme}\n` : '') +
    `\nTASK: Generate 10 specific content ideas. Reply in the required STRICT JSON shape.`;
  await gateAndRelay(req, res, { systemKey:'ideas', user, parseJSON:true });
});

/* ----- A/B CAPTION VARIANTS: 3 alternatives for any caption ----- */
app.post('/api/variants', express.json({limit:'1mb'}), async (req, res) => {
  const body = req.body || {};
  const caption = body.caption || '';
  const brand = body.brand || {};
  const count = body.count ?? 3;
  if (!caption.trim()) return res.status(400).json({ error:'Caption is required.' });
  const user =
    `BRAND\nName: ${brand.name || 'n/a'}\nVoice: ${brand.tone || 'friendly'}\n\n` +
    `ORIGINAL CAPTION:\n${caption}\n\n` +
    `TASK: Produce ${Math.min(Math.max(count,2),5)} alternative versions in the required STRICT JSON shape.`;
  await gateAndRelay(req, res, { systemKey:'variants', user, parseJSON:true });
});

/* ----- CROSS-PLATFORM REPURPOSE: adapt a post to a different platform ----- */
app.post('/api/repurpose', express.json({limit:'1mb'}), async (req, res) => {
  const body = req.body || {};
  const hook = body.hook || '';
  const caption = body.caption || '';
  const hashtags = body.hashtags || [];
  const fromPlatform = body.fromPlatform || 'Instagram';
  const toPlatform = body.toPlatform || 'LinkedIn';
  const brand = body.brand || {};
  if (!caption.trim() && !hook.trim()) return res.status(400).json({ error:'Need at least a hook or caption.' });
  const user =
    `BRAND\nName: ${brand.name || 'n/a'}\nVoice: ${brand.tone || 'friendly'}\n\n` +
    `ORIGINAL (${fromPlatform})\nHook: ${hook}\nCaption: ${caption}\nHashtags: ${hashtags.join(' ')}\n\n` +
    `TASK: Adapt this for ${toPlatform}. Match the destination platform's native style. STRICT JSON.`;
  await gateAndRelay(req, res, { systemKey:'repurpose', user, parseJSON:true });
});

/* ----- AI VIDEO SCRIPT: prompt → multi-scene script with image prompts per scene ----- */
app.post('/api/video-script', express.json({limit:'1mb'}), async (req, res) => {
  const body = req.body || {};
  const prompt = body.prompt || '';
  const brand = body.brand || {};
  const scenes = body.scenes ?? 4;
  const targetSec = parseInt(body.targetSec, 10) || 0;
  const lang = (body.lang || 'en').toString();
  if (!prompt.trim()) return res.status(400).json({ error:'A prompt is required.' });
  // Allow up to 24 scenes (~2 minutes at 5s/scene)
  const nScenes = Math.min(Math.max(parseInt(scenes,10) || 4, 3), 24);
  const approxSec = targetSec || (nScenes * 4);
  const LANG_NAMES = {
    en:'English', es:'Spanish', fr:'French', de:'German', it:'Italian', pt:'Portuguese',
    nl:'Dutch', ru:'Russian', ar:'Arabic', hi:'Hindi', ur:'Urdu', bn:'Bengali', tr:'Turkish',
    id:'Indonesian', ms:'Malay', th:'Thai', vi:'Vietnamese', ja:'Japanese', ko:'Korean',
    'zh-CN':'Chinese (Mandarin)', pl:'Polish', uk:'Ukrainian', ro:'Romanian', el:'Greek',
    sv:'Swedish', fa:'Persian', ta:'Tamil', te:'Telugu', fil:'Filipino', sw:'Swahili',
  };
  const langName = LANG_NAMES[lang] || 'English';
  const langInstruction = lang === 'en' ? '' :
    `\n\nLANGUAGE: Write ALL "caption" and "narration" text in ${langName}. ` +
    `The on-screen captions and the spoken narration must both be natural, fluent ${langName} — ` +
    `not translated-sounding. Keep "stockQuery" and "imagePrompt" in ENGLISH (they are for image search). ` +
    `Everything the viewer reads or hears must be in ${langName}.`;
  const user =
    `BRAND\nName: ${brand.name || 'unknown'}\nSells: ${brand.what || 'n/a'}\nVoice: ${brand.tone || 'friendly'}\n\n` +
    `VIDEO PROMPT:\n${prompt}\n\n` +
    `TASK: Produce a ${nScenes}-scene video script for vertical social platforms (Reels / TikTok / Shorts / LinkedIn). ` +
    `Target total length: ~${approxSec} seconds. ` +
    `Each scene needs caption + stockQuery + imagePrompt + duration. ` +
    `For longer videos (>30s), include a clear narrative arc: hook → context → proof → CTA. ` +
    langInstruction +
    `\nSTRICT JSON.`;
  await gateAndRelay(req, res, { systemKey:'videoScript', user, parseJSON:true });
});

/* ----- CONTENT LIFT: turn a URL or pasted text into a 5-7 post social campaign ----- */
function extractMainTextFromHTML(html) {
  if (!html) return '';
  // Strip scripts, styles, and HTML tags. Cheap but works for ~80% of public pages.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

app.post('/api/content-lift', express.json({limit:'2mb'}), async (req, res) => {
  const body = req.body || {};
  let source = body.source || 'text';
  let content = body.content || '';
  const url = body.url || '';
  const brand = body.brand || {};

  // If a URL was provided, fetch it server-side and extract text.
  if (source === 'url' || (url && !content)) {
    if (!url || !/^https?:\/\//.test(url)) {
      return res.status(400).json({ error:'Please provide a valid http(s) URL.' });
    }
    try {
      const ctrl = new AbortController();
      const tmo = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; STMZ-Kinetic/1.0; +https://stmz.app)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      clearTimeout(tmo);
      if (!r.ok) return res.status(502).json({ error:'FETCH_FAILED', message:`Source returned ${r.status}. The page may be paywalled or block bots.` });
      const html = await r.text();
      content = extractMainTextFromHTML(html);
      if (content.length < 200) {
        return res.status(422).json({ error:'TOO_SHORT', message:'Could not extract meaningful text from that URL. Try pasting the content directly.' });
      }
    } catch (err) {
      return res.status(502).json({ error:'FETCH_FAILED', message: err.name === 'AbortError' ? 'The page took too long to load.' : err.message });
    }
  }

  if (!content || content.trim().length < 100) {
    return res.status(400).json({ error:'Source content is too short (need at least ~100 characters).' });
  }

  // Cap to keep prompt size sane (≈ 8000 chars ≈ 2k tokens)
  if (content.length > 8000) content = content.slice(0, 8000) + ' [content truncated]';

  const user =
    `BRAND PROFILE\nName: ${brand.name || 'unknown'}\nSells: ${brand.what || 'n/a'}\n` +
    `Audience: ${brand.audience || 'general'}\nVoice: ${brand.tone || 'friendly and professional'}\n\n` +
    `SOURCE CONTENT (extract the 5-7 best ideas, write one platform-native post per idea):\n${content}\n\n` +
    `TASK: Build a 5-7 post social campaign that turns this into native posts across multiple platforms. STRICT JSON.`;

  await gateAndRelay(req, res, { systemKey:'contentLift', user, parseJSON:true });
});

/* ----- V7: REPLY ASSISTANT — paste a comment/DM → 3 brand-voiced replies ----- */
app.post('/api/reply', express.json({limit:'200kb'}), async (req, res) => {
  const body = req.body || {};
  const message = body.message || '';
  const brand = body.brand || {};
  const tone = body.tone || 'warm';
  if (!message.trim()) return res.status(400).json({ error:'Please paste the message first.' });
  const user =
    `BRAND\nName: ${brand.name || 'n/a'}\nSells: ${brand.what || 'n/a'}\nVoice: ${brand.tone || 'friendly'}\n` +
    `Desired reply tone: ${tone}\n\n` +
    `INCOMING MESSAGE:\n${message.slice(0, 2000)}\n\n` +
    `TASK: Detect intent and generate 3 reply options. STRICT JSON.`;
  await gateAndRelay(req, res, { systemKey:'replyAssistant', user, parseJSON:true });
});

/* ----- V7: ANALYTICS INSIGHTS — brand + performance data → actionable insights ----- */
app.post('/api/insights', express.json({limit:'1mb'}), async (req, res) => {
  const body = req.body || {};
  const posts = body.posts || [];
  const brand = body.brand || {};
  const withPerf = posts.filter(p =>
    p.status === 'posted' && p.performance &&
    ((p.performance.likes || 0) + (p.performance.comments || 0) + (p.performance.shares || 0)) > 0
  );
  if (withPerf.length < 3) {
    return res.json({
      thin: true,
      message: 'Need at least 3 posted entries with engagement marked to generate insights. Open a posted post and add likes/comments numbers in the editor.',
    });
  }
  const score = p => (p.performance.likes||0) + (p.performance.comments||0)*2 + (p.performance.shares||0)*3;
  const sorted = [...withPerf].sort((a,b) => score(b) - score(a));
  const top = sorted.slice(0, 5);
  const bottom = sorted.slice(-3);
  const user =
    `BRAND\nName: ${brand.name || 'n/a'}\nVoice: ${brand.tone || 'friendly'}\n\n` +
    `TOP performers (score = likes + 2·comments + 3·shares):\n` +
    top.map((p,i)=>`${i+1}. [${p.platform}] "${(p.hook||'').slice(0,80)}" — ${p.performance.likes||0}L · ${p.performance.comments||0}C · ${p.performance.shares||0}S`).join('\n') +
    `\n\nLOW performers:\n` +
    bottom.map((p,i)=>`${i+1}. [${p.platform}] "${(p.hook||'').slice(0,80)}" — ${p.performance.likes||0}L · ${p.performance.comments||0}C`).join('\n') +
    `\n\nTASK: Specific, actionable insights for next week's content. STRICT JSON.`;
  await gateAndRelay(req, res, { systemKey:'insights', user, parseJSON:true });
});

/* ----- V7: BULK PRODUCT CAMPAIGN — CSV/text of products → multi-post campaign each ----- */
app.post('/api/bulk-products', express.json({limit:'2mb'}), async (req, res) => {
  const body = req.body || {};
  const products = body.products || [];
  const brand = body.brand || {};
  const postsPerProduct = body.postsPerProduct ?? 3;
  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error:'No products provided.' });
  }
  if (products.length > 20) {
    return res.status(400).json({ error:'Maximum 20 products per batch — split into smaller batches.' });
  }
  const n = Math.min(Math.max(parseInt(postsPerProduct,10) || 3, 1), 5);
  const productList = products.map((p, i) =>
    `${i+1}. ${p.name || 'Unnamed'} — ${p.description || ''}${p.price ? ` (${p.price})` : ''}${p.category ? ` [${p.category}]` : ''}`
  ).join('\n');
  const user =
    `BRAND PROFILE\nName: ${brand.name || 'unknown'}\nWhat: ${brand.what || 'n/a'}\nAudience: ${brand.audience || 'general'}\nVoice: ${brand.tone || 'friendly'}\n\n` +
    `PRODUCT LIST (${products.length} products):\n${productList}\n\n` +
    `TASK: Generate ${n} platform-native posts PER product, covering different angles (feature, story, social proof, FOMO, lifestyle). STRICT JSON.`;
  await gateAndRelay(req, res, { systemKey:'bulkProduct', user, parseJSON:true });
});

/* ============================================================
   AUTOPILOT — the headline V4 feature
   ------------------------------------------------------------
   Each user can enable autopilot. The server-side hourly tick
   checks for users due for generation, builds a brief using
   their brand + recent top-performing posts, calls the AI
   relay, and saves the week's posts either as pending_approval
   (default) or scheduled (if autoSchedule=true).
   Pro+ only — Starter tier is gated out.
   ============================================================ */
function nextWeekStart(hour = 9) {
  const d = new Date();
  const day = d.getDay();                  // 0 = Sunday
  const daysUntilMonday = ((1 - day + 7) % 7) || 7;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + daysUntilMonday, hour, 0, 0, 0);
  return monday.getTime();
}

function pollinationsUrl(prompt) {
  const seed = Math.floor(Math.random() * 9_000_000);
  return `https://image.pollinations.ai/prompt/${encodeURIComponent((prompt || 'brand content').slice(0,180))}?width=768&height=768&nologo=true&seed=${seed}`;
}

/* Pexels-first image resolution: real, relevant, instant stock photo for the
   post's stockQuery; AI-generated Pollinations image only as fallback.
   This is what makes post images MATCH the post content. */
async function resolvePostImage(stockQuery, imagePrompt) {
  const key = process.env.PEXELS_API_KEY;
  const q = (stockQuery || '').toString().trim().slice(0, 100);
  if (key && q) {
    try {
      const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&orientation=landscape&per_page=5`, {
        headers: { Authorization: key },
      });
      if (r.ok) {
        const data = await r.json();
        const pick = data?.photos?.[Math.floor(Math.random() * Math.min(data.photos?.length || 0, 5))];
        const url = pick?.src?.large2x || pick?.src?.large || pick?.src?.original;
        if (url) return url;
      }
    } catch { /* fall through to AI image */ }
  }
  return pollinationsUrl(imagePrompt || stockQuery);
}

async function generateAutopilotForUser(uid, userData) {
  const ap = userData.autopilot || {};
  const brands = userData.brands || [];
  if (!brands.length) return { skipped:'no-brands' };
  const brand = brands.find(b => b.id === ap.brandId) || brands[0];

  // Pull recent posted content with performance data
  let perfContext = '';
  try {
    const recentSnap = await adminDb.collection('users').doc(uid).collection('posts')
      .where('status', '==', 'posted').limit(30).get();
    const withPerf = recentSnap.docs.map(d => d.data()).filter(p => p.performance && (p.performance.likes || p.performance.comments));
    if (withPerf.length >= 2) {
      withPerf.sort((a,b) =>
        (b.performance.likes + b.performance.comments*2 + b.performance.shares*3) -
        (a.performance.likes + a.performance.comments*2 + a.performance.shares*3));
      const top = withPerf.slice(0, 3);
      const bottom = withPerf.slice(-2);
      perfContext = `\n\nPAST PERFORMANCE INSIGHTS (use these to bias generation):\n` +
        `TOP performers — lean into their angles & hook style:\n` +
        top.map((p,i)=>`  ${i+1}. "${(p.hook||'').slice(0,80)}" — ${p.performance.likes||0} likes, ${p.performance.comments||0} comments`).join('\n') +
        (bottom.length ? `\nLOW performers — avoid these patterns:\n` +
          bottom.map((p,i)=>`  ${i+1}. "${(p.hook||'').slice(0,80)}" — ${p.performance.likes||0} likes`).join('\n') : '');
    }
  } catch (e) { /* missing index or no posts is fine */ }

  const n = Math.min(Math.max(parseInt(ap.postsPerWeek,10) || 5, 1), 21);
  const platforms = (ap.platforms && ap.platforms.length) ? ap.platforms : ['Instagram','LinkedIn'];
  const mix = ap.contentMix || '30% educational, 25% engagement (questions), 20% behind-the-scenes, 15% social proof, 10% offer';

  const userPrompt =
    `BRAND PROFILE\nName: ${brand.name}\nWhat they sell: ${brand.what || 'n/a'}\n` +
    `Target audience: ${brand.audience || 'general'}\nVoice / tone: ${brand.tone || 'friendly'}\n` +
    `Key offer / link: ${brand.offer || 'n/a'}` + perfContext +
    `\n\nTASK: Create exactly ${n} social media posts for the upcoming week across these platforms: ${platforms.join(', ')}. ` +
    `Spread evenly across the 7 days (set the day field 1-7). Content mix target: ${mix}. ` +
    `Return STRICT JSON in the required shape.`;

  const out = await relay(SYSTEM_PROMPTS.campaign, userPrompt);
  const parsed = extractJSON(out.text);
  if (!parsed?.posts?.length) throw new Error('parse failed');

  const startMs = nextWeekStart(9);
  const dayMs = 24*60*60*1000;
  const batch = adminDb.batch();
  const userRef = adminDb.collection('users').doc(uid);
  // Resolve every post's image in parallel (Pexels-first → AI fallback)
  const imageUrls = await Promise.all(
    parsed.posts.map(p => resolvePostImage(p.stockQuery, p.imagePrompt || p.hook))
  );
  parsed.posts.forEach((p, i) => {
    const day = Math.max(1, Math.min(7, parseInt(p.day,10) || (i+1)));
    const [h='09', mm='00'] = (p.time || '09:00').split(':');
    const scheduledAt = startMs + (day-1)*dayMs + (parseInt(h,10)-9)*60*60*1000 + parseInt(mm,10)*60*1000;
    const ref = userRef.collection('posts').doc();
    batch.set(ref, {
      brandId: brand.id,
      platform: p.platform || platforms[0],
      hook: p.hook || '',
      caption: p.caption || '',
      hashtags: p.hashtags || [],
      cta: p.cta || '',
      imagePrompt: p.imagePrompt || '',
      stockQuery: p.stockQuery || '',
      imageUrl: imageUrls[i],
      status: ap.autoSchedule ? 'scheduled' : 'pending_approval',
      scheduledAt,
      source: 'autopilot',
      createdAt: Date.now(),
    });
  });
  batch.set(userRef, {
    autopilot: { ...ap, lastGeneratedAt: Date.now(), lastBatchSize: parsed.posts.length }
  }, { merge: true });
  await batch.commit();
  return { generated: parsed.posts.length, brand: brand.name };
}

async function autopilotTick() {
  if (!adminDb) return { skipped:true };
  try {
    const snap = await adminDb.collection('users').where('autopilot.enabled', '==', true).limit(30).get();
    let generated = 0, skipped = 0, failed = 0;
    for (const userDoc of snap.docs) {
      const u = userDoc.data();
      const ap = u.autopilot || {};
      const sub = u.subscription || {};
      // Gate: Pro+ only and only active subscriptions
      if (sub.status !== 'active' || sub.tier === 'starter') { skipped++; continue; }
      const cadenceMs = (ap.cadence === 'daily' ? 1 : 7) * 24*60*60*1000;
      if (Date.now() - (ap.lastGeneratedAt || 0) < cadenceMs) { skipped++; continue; }
      try { await generateAutopilotForUser(userDoc.id, u); generated++; }
      catch (e) { console.warn('[autopilot] user', userDoc.id, 'failed:', e.message); failed++; }
    }
    if (snap.size) console.log(`[autopilot] checked ${snap.size}, generated ${generated}, skipped ${skipped}, failed ${failed}`);
    return { checked: snap.size, generated, skipped, failed };
  } catch (err) {
    console.error('[autopilot] tick failed:', err.message);
    return { error: err.message };
  }
}

// Run hourly in-process; also exposed for cron-job.org if needed.
setInterval(() => autopilotTick(), 60 * 60 * 1000);

app.get('/api/autopilot/tick', async (req, res) => {
  const secret = process.env.SCHEDULER_SECRET;
  if (secret && req.query.secret !== secret) return res.status(401).send('nope');
  const result = await autopilotTick();
  res.json({ ok:true, ...result });
});

// User-triggered manual generation (from the UI "Generate now" button)
app.post('/api/autopilot/run-now', express.json(), async (req, res) => {
  const sub = await checkSubscription(req);
  if (!sub.uid) return res.status(401).json({ error:'auth' });
  if (!sub.active || sub.tier === 'starter') return res.status(402).json({ error:'tier', message:'AutoPilot requires Pro or Agency.' });
  try {
    const userSnap = await adminDb.collection('users').doc(sub.uid).get();
    const result = await generateAutopilotForUser(sub.uid, userSnap.data() || {});
    res.json({ ok:true, ...result });
  } catch (err) { res.status(500).json({ error:'generate-failed', message: err.message }); }
});

/* ============================================================
   LINKEDIN OAuth — direct posting to a user's own feed
   Scope: openid profile email w_member_social
   Setup steps documented in INTEGRATIONS_SETUP.md
   ============================================================ */
const LI_REDIRECT = () => `${APP_URL}/api/linkedin/callback`;

app.get('/api/linkedin/connect', async (req, res) => {
  if (!process.env.LINKEDIN_CLIENT_ID) return res.status(503).send('LinkedIn is not configured on this deployment.');
  // The Firebase ID token comes in via query for browser redirects (header is awkward for redirects).
  const token = req.query.token;
  if (!token || !adminAuth) return res.status(401).send('Sign in first, then click Connect again.');
  let uid;
  try { uid = (await adminAuth.verifyIdToken(token)).uid; } catch { return res.status(401).send('Invalid token.'); }
  // Sign state so the callback can't be forged from another uid.
  const secret = process.env.LINKEDIN_STATE_SECRET || 'stmz-state-fallback';
  const ts = Date.now();
  const payload = `${uid}.${ts}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0,16);
  const state = `${payload}.${sig}`;
  const params = new URLSearchParams({
    response_type:'code',
    client_id: process.env.LINKEDIN_CLIENT_ID,
    redirect_uri: LI_REDIRECT(),
    state,
    scope: 'openid profile email w_member_social',
  });
  res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`);
});

app.get('/api/linkedin/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) return res.redirect('/#/integrations?linkedin=error');
  // Verify state
  const parts = String(state).split('.');
  if (parts.length !== 3) return res.redirect('/#/integrations?linkedin=error');
  const [uid, ts, sig] = parts;
  const secret = process.env.LINKEDIN_STATE_SECRET || 'stmz-state-fallback';
  const expected = crypto.createHmac('sha256', secret).update(`${uid}.${ts}`).digest('hex').slice(0,16);
  if (sig !== expected || (Date.now() - parseInt(ts,10)) > 15*60*1000) return res.redirect('/#/integrations?linkedin=error');
  try {
    // Exchange code for token
    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        grant_type:'authorization_code',
        code,
        redirect_uri: LI_REDIRECT(),
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
    const { access_token, expires_in } = await tokenRes.json();
    // Get user info
    const meRes = await fetch('https://api.linkedin.com/v2/userinfo', { headers:{ Authorization:`Bearer ${access_token}` } });
    if (!meRes.ok) throw new Error(`userinfo ${meRes.status}`);
    const me = await meRes.json();
    const urn = `urn:li:person:${me.sub}`;
    if (adminDb) {
      await adminDb.collection('users').doc(uid).set({
        integrations: { linkedin: {
          accessToken: access_token, urn,
          name: me.name || '', email: me.email || '',
          connectedAt: Date.now(),
          expiresAt: Date.now() + (expires_in || 3600)*1000,
        } }
      }, { merge: true });
    }
    res.redirect('/#/integrations?linkedin=ok');
  } catch (err) {
    console.error('[linkedin] callback failed:', err.message);
    res.redirect('/#/integrations?linkedin=error');
  }
});

app.post('/api/linkedin/disconnect', express.json(), async (req, res) => {
  const sub = await checkSubscription(req);
  if (!sub.uid || !adminDb) return res.status(401).json({ error:'auth' });
  await adminDb.collection('users').doc(sub.uid).set({ integrations: { linkedin: null } }, { merge: true });
  res.json({ ok:true });
});

async function postToLinkedIn(integration, post) {
  const text = (post.hook ? post.hook + '\n\n' : '') + (post.caption || '') +
               (post.hashtags?.length ? '\n\n' + post.hashtags.join(' ') : '');
  const body = {
    author: integration.urn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };
  const r = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method:'POST',
    headers:{
      'Authorization': `Bearer ${integration.accessToken}`,
      'Content-Type':'application/json',
      'X-Restli-Protocol-Version':'2.0.0',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`linkedin ${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}

/* ============================================================
   WEBHOOK firing (universal — Make.com / Zapier / n8n / your own)
   ============================================================ */
async function fireWebhook(url, payload) {
  const r = await fetch(url, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'User-Agent':'STMZ-Kinetic/2.0' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`webhook ${r.status}`);
  return true;
}

// Test-fire endpoint so users can hit "test webhook" from the UI.
app.post('/api/integrations/test-webhook', express.json(), async (req, res) => {
  const sub = await checkSubscription(req);
  if (!sub.uid) return res.status(401).json({ error:'auth' });
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error:'invalid url' });
  try {
    await fireWebhook(url, {
      type:'stmz_test',
      message:'This is a test event from STMZ Kinetic. Your webhook is wired correctly.',
      sentAt: new Date().toISOString(),
    });
    res.json({ ok:true });
  } catch (err) { res.status(502).json({ error:'failed', message: err.message }); }
});

// Telegram — save bot token + chat ID, then test it
app.post('/api/telegram/save', express.json(), async (req, res) => {
  const sub = await checkSubscription(req);
  if (!sub.uid) return res.status(401).json({ error:'auth' });
  const { botToken, chatId } = req.body || {};
  if (!botToken || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) return res.status(400).json({ error:'invalid bot token format' });
  if (!chatId) return res.status(400).json({ error:'chat ID required' });
  if (!adminDb) return res.status(500).json({ error:'db not configured' });
  try {
    await adminDb.collection('users').doc(sub.uid).set({
      integrations: { telegram: { botToken: String(botToken), chatId: String(chatId), connectedAt: Date.now() }},
    }, { merge: true });
    res.json({ ok:true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/telegram/disconnect', express.json(), async (req, res) => {
  const sub = await checkSubscription(req);
  if (!sub.uid) return res.status(401).json({ error:'auth' });
  if (!adminDb) return res.status(500).json({ error:'db not configured' });
  try {
    const admin = require('firebase-admin');
    await adminDb.collection('users').doc(sub.uid).update({
      'integrations.telegram': admin.firestore.FieldValue.delete(),
    });
    res.json({ ok:true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/telegram/test', express.json(), async (req, res) => {
  const sub = await checkSubscription(req);
  if (!sub.uid) return res.status(401).json({ error:'auth' });
  if (!adminDb) return res.status(500).json({ error:'db not configured' });
  try {
    const snap = await adminDb.collection('users').doc(sub.uid).get();
    const integ = (snap.exists ? snap.data() : {}).integrations || {};
    if (!integ.telegram?.botToken || !integ.telegram?.chatId) return res.status(400).json({ error:'Telegram not configured' });
    await postToTelegram(integ.telegram, {
      hook: '✓ STMZ Kinetic test',
      caption: 'Your Telegram is connected. Future scheduled posts will arrive here.',
      cta: '',
      hashtags: [],
    });
    res.json({ ok:true });
  } catch (err) { res.status(502).json({ error:'failed', message: err.message }); }
});

/* ============================================================
   SCHEDULER — fires posts whose scheduledAt <= now
   Runs in-process every minute AND is exposed at /api/scheduler/tick
   so cron-job.org can wake it on free-tier hosting.
   ============================================================ */
const SCHED_INTERVAL_MS = 60 * 1000;

async function postToTelegram(integration, post) {
  // Bot tokens give us full posting power without any OAuth — anyone creates a
  // bot via @BotFather in 30 seconds. The chatId is the channel/group/user
  // the bot has been added to.
  const { botToken, chatId } = integration || {};
  if (!botToken || !chatId) throw new Error('Telegram not fully configured');

  const hashtagsArr = Array.isArray(post.hashtags) ? post.hashtags : [];
  const hashtagStr = hashtagsArr.map(h => h.startsWith('#') ? h : '#' + h).join(' ');
  const body = [post.hook, post.caption, post.cta, hashtagStr].filter(Boolean).join('\n\n').slice(0, 4000);

  // If there's an image, sendPhoto. Else sendMessage.
  if (post.imageUrl) {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: post.imageUrl, caption: body }),
    });
    if (!r.ok) throw new Error('telegram sendPhoto ' + r.status);
    const j = await r.json();
    if (!j.ok) throw new Error('telegram: ' + (j.description || 'failed'));
  } else {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: body }),
    });
    if (!r.ok) throw new Error('telegram sendMessage ' + r.status);
    const j = await r.json();
    if (!j.ok) throw new Error('telegram: ' + (j.description || 'failed'));
  }
  return true;
}

async function firePost(uid, ref, post) {
  if (!adminDb) return;
  const userSnap = await adminDb.collection('users').doc(uid).get();
  const userData = userSnap.exists ? userSnap.data() : {};
  const integ = userData.integrations || {};
  const log = [];
  let success = false;

  // 1. LinkedIn (only if platform is LinkedIn and user connected it)
  if (post.platform && /linkedin/i.test(post.platform) && integ.linkedin?.accessToken) {
    try {
      await postToLinkedIn(integ.linkedin, post);
      log.push('Posted to LinkedIn ✓');
      success = true;
    } catch (e) { log.push('LinkedIn failed: ' + e.message); }
  }

  // 2. Telegram (direct via Bot API, no OAuth needed)
  if (post.platform && /telegram/i.test(post.platform) && integ.telegram?.botToken && integ.telegram?.chatId) {
    try {
      await postToTelegram(integ.telegram, post);
      log.push('Posted to Telegram ✓');
      success = true;
    } catch (e) { log.push('Telegram failed: ' + e.message); }
  }

  // 2. Webhook (always, if configured — user routes to platforms via Make/Zapier)
  if (integ.webhookUrl) {
    try {
      // Send EVERYTHING Make.com / Zapier might need to post to any platform:
      // title, body, hashtags, CTA, media URL, brand info, plus pre-formatted
      // strings for the most common platforms so the user can just map a
      // single field to each downstream module without writing transforms.
      const brand = (userData.brands || []).find(b => b.id === post.brandId) || {};
      const hashtagsArr = Array.isArray(post.hashtags) ? post.hashtags : [];
      const hashtagStr = hashtagsArr.map(h => h.startsWith('#') ? h : '#' + h).join(' ');
      const title = (post.hook || '').slice(0, 100);
      const bodyText = (post.caption || '').trim();
      const cta = (post.cta || '').trim();

      const fullCaption = [bodyText, cta, hashtagStr].filter(Boolean).join('\n\n');

      await fireWebhook(integ.webhookUrl, {
        // Top-level identifiers
        type: 'stmz_post',
        platform: post.platform || 'unknown',
        postId: ref.id,
        firedAt: new Date().toISOString(),
        scheduledAt: post.scheduledAt || null,

        // Core content
        title,
        hook: post.hook || '',
        caption: bodyText,
        hashtags: hashtagsArr,
        hashtagString: hashtagStr,
        cta,

        // Pre-formatted strings for popular platforms (map one field per platform)
        instagram:    { caption: fullCaption,                                   mediaUrl: post.imageUrl || '' },
        facebook:     { message: fullCaption,                                   linkOrImage: post.imageUrl || '' },
        tiktok:       { description: [title, hashtagStr].filter(Boolean).join(' '), videoUrl: post.videoUrl || '' },
        youtubeShorts:{ title, description: bodyText + (cta?'\n\n'+cta:''), tags: hashtagsArr.map(h => h.replace(/^#/,'')), videoUrl: post.videoUrl || '' },
        twitterX:     { text: [title, bodyText].filter(Boolean).join('\n\n').slice(0, 270) + (hashtagStr ? ' '+hashtagStr.slice(0,20) : '') },
        threads:      { text: fullCaption.slice(0, 500) },
        pinterest:    { title, description: bodyText, link: post.linkUrl || '', imageUrl: post.imageUrl || '' },

        // Media
        imageUrl: post.imageUrl || null,
        videoUrl: post.videoUrl || null,

        // Brand context (so Make.com can route to the right client account)
        brand: {
          id: post.brandId || null,
          name: brand.name || '',
          handle: brand.handle || '',
        },
      });
      log.push('Webhook fired ✓');
      success = true;
    } catch (e) { log.push('Webhook failed: ' + e.message); }
  }

  // 3. No destination configured → mark as needing manual posting
  if (!log.length) log.push('No destination configured — kept as scheduled.');

  await ref.update({
    status: success ? 'posted' : (log[0].startsWith('No destination') ? 'scheduled' : 'failed'),
    postedAt: success ? Date.now() : null,
    log: log.join(' · '),
    lastTickAt: Date.now(),
  });
  return success;
}

async function schedulerTick() {
  if (!adminDb) return { skipped:true };
  try {
    const now = Date.now();
    const snap = await adminDb.collectionGroup('posts')
      .where('status', '==', 'scheduled')
      .where('scheduledAt', '<=', now)
      .limit(25)
      .get();
    let fired = 0, failed = 0;
    for (const doc of snap.docs) {
      const post = doc.data();
      // The parent of 'posts' is users/{uid}
      const uid = doc.ref.parent.parent.id;
      const ok = await firePost(uid, doc.ref, post);
      if (ok) fired++; else failed++;
    }
    if (snap.size) console.log(`[scheduler] tick: ${snap.size} due, ${fired} fired, ${failed} failed`);
    return { checked: snap.size, fired, failed };
  } catch (err) {
    console.error('[scheduler] tick failed:', err.message);
    return { error: err.message };
  }
}

setInterval(() => { schedulerTick(); }, SCHED_INTERVAL_MS);

app.get('/api/scheduler/tick', async (req, res) => {
  const secret = process.env.SCHEDULER_SECRET;
  if (secret && req.query.secret !== secret) return res.status(401).send('nope');
  const result = await schedulerTick();
  res.json({ ok:true, ...result });
});

/* ============================================================
   PADDLE webhook (unchanged)
   ============================================================ */
function verifyPaddleSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(signatureHeader.split(';').map(kv => kv.split('=').map(s=>s.trim())));
  const ts = parts.ts, h1 = parts.h1;
  if (!ts || !h1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(h1,'hex'), Buffer.from(expected,'hex')); } catch { return false; }
}

app.post('/api/paddle/webhook', express.raw({type:'*/*'}), async (req, res) => {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
  const sig = req.headers['paddle-signature'];
  if (secret && !verifyPaddleSignature(raw, sig, secret)) return res.status(401).send('invalid signature');
  let event; try { event = JSON.parse(raw); } catch { return res.status(400).send('bad json'); }
  const type = event?.event_type; const data = event?.data || {};
  const uid = data?.custom_data?.uid || data?.subscription?.custom_data?.uid;

  // Map the Paddle price id in the event to one of our three tiers.
  const priceId = data?.items?.[0]?.price?.id || data?.items?.[0]?.price_id || '';
  const tierMap = {
    [process.env.PADDLE_PRICE_STARTER || '']: 'starter',
    [process.env.PADDLE_PRICE_PRO     || '']: 'pro',
    [process.env.PADDLE_PRICE_AGENCY  || '']: 'agency',
  };
  const tier = tierMap[priceId] || 'pro'; // safe default

  const grant = ['transaction.completed','subscription.created','subscription.activated','subscription.updated'];
  const revoke = ['subscription.canceled','subscription.paused'];
  try {
    if (uid && adminDb) {
      if (grant.includes(type)) {
        await adminDb.collection('users').doc(uid).set({
          subscription: { status:'active', tier, expiresAt: Date.now() + 30*24*60*60*1000, plan: tier, updatedAt: Date.now() }
        }, { merge:true });
      } else if (revoke.includes(type)) {
        await adminDb.collection('users').doc(uid).set({
          subscription: { status:'canceled', updatedAt: Date.now() }
        }, { merge:true });
      }
    }
  } catch (err) { console.error('[paddle] firestore update failed:', err.message); }
  res.status(200).send('ok');
});

/* ============================================================
   Static + clean routes
   ============================================================ */
const PUBLIC_DIR = path.join(__dirname, 'public');

// Aggressively prevent browser caching of HTML & JS so a deploy takes
// effect immediately (was the cause of "old browsers don't see new modules").
// Static assets (CSS, SVG, manifest) cache normally.
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, filePath) => {
    if (/\.(html|js)$/.test(filePath) || filePath.endsWith('manifest.json') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

/* Image proxy — fixes canvas-CORS issues with image providers.
   Whitelisted upstreams only (prevents SSRF abuse).
   Used by video.js for video generation; UI <img> tags hit upstreams
   directly (so we don't burn server bandwidth on every thumbnail). */
const IMG_PROXY_WHITELIST = [
  'https://image.pollinations.ai/',
  'https://images.pexels.com/',
  'https://picsum.photos/',
  'https://videos.pexels.com/',
  'https://player.vimeo.com/',
  'https://download.pexels.com/',
];
app.get('/api/img-proxy', async (req, res) => {
  if (!proxyAllow(getClientIp(req))) return res.status(429).send('rate limited — try again in a minute');
  const url = req.query.url;
  if (!url || typeof url !== 'string') return res.status(400).send('url required');
  if (!IMG_PROXY_WHITELIST.some(prefix => url.startsWith(prefix))) {
    return res.status(400).send('upstream not allowed');
  }
  try {
    const ctrl = new AbortController();
    const tmo = setTimeout(() => ctrl.abort(), 60000);  // bumped for video files
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(tmo);
    if (!r.ok) return res.status(502).send(`upstream ${r.status}`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    // Stream large video files instead of buffering whole thing in memory
    if (r.body && r.body.pipe) {
      r.body.pipe(res);
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      res.end(buf);
    }
  } catch (err) {
    res.status(502).send('proxy failed: ' + (err.name === 'AbortError' ? 'timeout' : (err.message || 'unknown')));
  }
});

/* Stock VIDEO lookup — Pexels Videos API (same free key as photos).
   Used by video.js as PRIMARY source — actual moving video clips
   instead of still photos with zoom. */
app.get('/api/stock-video', async (req, res) => {
  if (!proxyAllow(getClientIp(req))) return res.status(429).json({ url: null, reason: 'rate-limited' });
  const query = (req.query.query || '').toString().trim();
  if (!query) return res.json({ url: null, reason: 'no-query' });
  const key = process.env.PEXELS_API_KEY;
  if (!key) return res.json({ url: null, reason: 'no-key' });
  try {
    const q = query.slice(0, 200);
    const orient = (req.query.orient || 'portrait').toString();
    const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&orientation=${orient}&per_page=5&size=medium`, {
      headers: { Authorization: key },
    });
    if (!r.ok) return res.json({ url: null, reason: `pexels ${r.status}` });
    const data = await r.json();
    const videos = data?.videos || [];
    if (!videos.length) return res.json({ url: null, reason: 'no-results' });
    const pick = videos[Math.floor(Math.random() * Math.min(videos.length, 5))];
    // Pick a moderate-size video file (smaller = faster download, still decent quality)
    const files = (pick.video_files || []).sort((a,b) => (a.width||0) - (b.width||0));
    const vfile = files.find(f => f.width >= 720 && f.width <= 1280)
              || files.find(f => f.width >= 480)
              || files[0];
    if (!vfile) return res.json({ url: null, reason: 'no-file' });
    res.json({
      url: vfile.link,
      duration: pick.duration,
      photographer: pick.user?.name,
      width: vfile.width,
      height: vfile.height,
    });
  } catch (err) {
    res.json({ url: null, reason: err.message });
  }
});

/* Text-to-speech proxy — StreamElements free TTS (no API key needed).
   Free, supports many voices (US/UK male & female), returns MP3.
   Used by video.js for AI voice narration on each scene. */
const TTS_VOICES = {
  // Male
  brian:   'Brian',     // UK male, warm
  matthew: 'Matthew',   // US male, news anchor
  joey:    'Joey',      // US male, casual
  // Female
  amy:     'Amy',       // UK female, friendly
  joanna:  'Joanna',    // US female, professional
  salli:   'Salli',     // US female, energetic
};
/* Languages supported for free voice narration via Google Translate TTS.
   Code → human label. StreamElements (English-only) is tried first for English;
   for every other language Google TTS is the free provider. ElevenLabs (if a
   key is set) gives premium multilingual voices and is always the final fallback. */
const TTS_LANGS = {
  en: 'English',        es: 'Spanish',       fr: 'French',       de: 'German',
  it: 'Italian',        pt: 'Portuguese',    nl: 'Dutch',        ru: 'Russian',
  ar: 'Arabic',         hi: 'Hindi',         ur: 'Urdu',         bn: 'Bengali',
  tr: 'Turkish',        id: 'Indonesian',    ms: 'Malay',        th: 'Thai',
  vi: 'Vietnamese',     ja: 'Japanese',      ko: 'Korean',       'zh-CN': 'Chinese (Mandarin)',
  pl: 'Polish',         uk: 'Ukrainian',     ro: 'Romanian',     el: 'Greek',
  sv: 'Swedish',        da: 'Danish',        fi: 'Finnish',      no: 'Norwegian',
  cs: 'Czech',          hu: 'Hungarian',     he: 'Hebrew',       fa: 'Persian',
  ta: 'Tamil',          te: 'Telugu',        ml: 'Malayalam',    fil: 'Filipino',
  af: 'Afrikaans',      sw: 'Swahili',       sr: 'Serbian',      sk: 'Slovak',
};

/* TTS provider chain — tries StreamElements, falls back to Google Translate TTS,
   then ElevenLabs if API key is configured. Returns the first one that works. */
async function ttsFromStreamElements(voice, text, signal) {
  const upstream = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text)}`;
  const r = await fetch(upstream, { signal, headers: { 'User-Agent': 'STMZ-Kinetic/1.0' }});
  if (!r.ok) throw new Error('streamelements ' + r.status);
  return { buf: Buffer.from(await r.arrayBuffer()), mime: 'audio/mpeg' };
}

async function ttsFromGoogleTranslate(text, signal, lang = 'en') {
  // Google's unofficial TTS endpoint — 200 char limit per request, supports
  // ~50 languages for free. We split long text into chunks and concatenate.
  const chunks = [];
  let remaining = text.replace(/\s+/g, ' ').trim();
  while (remaining.length) {
    let chunk;
    if (remaining.length <= 200) { chunk = remaining; remaining = ''; }
    else {
      // Cut at the last space before 200 chars (avoid cutting words in half)
      let cutAt = remaining.lastIndexOf(' ', 200);
      if (cutAt < 100) cutAt = 200; // fallback if no space found
      chunk = remaining.slice(0, cutAt);
      remaining = remaining.slice(cutAt).trim();
    }
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=${encodeURIComponent(lang)}&total=1&idx=0&textlen=${chunk.length}&client=tw-ob`;
    const r = await fetch(url, {
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Referer': 'https://translate.google.com/',
      },
    });
    if (!r.ok) throw new Error('google ' + r.status);
    chunks.push(Buffer.from(await r.arrayBuffer()));
  }
  return { buf: Buffer.concat(chunks), mime: 'audio/mpeg' };
}

async function ttsFromElevenLabs(voice, text, signal) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('elevenlabs no-key');
  // Map our voice IDs to ElevenLabs default voices. These are public, no extra setup.
  const ELEVEN_VOICES = {
    joanna:  'EXAVITQu4vr4xnSDxMaL', // Bella (US female)
    salli:   'jsCqWAovK2LkecY7zXl4', // Freya (US female, energetic)
    amy:     'XB0fDUnXU5powFXDhCwa', // Charlotte (UK female)
    matthew: 'TxGEqnHWrfWFTfGW9XjX', // Josh (US male, news)
    joey:    'VR6AewLTigWG4xSOukaG', // Arnold (US male, casual)
    brian:   'pNInz6obpgDQGcFmaJgB', // Adam (UK male, warm)
  };
  const vid = ELEVEN_VOICES[voice.toLowerCase()] || ELEVEN_VOICES.joanna;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}?optimize_streaming_latency=2`, {
    method: 'POST',
    signal,
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!r.ok) throw new Error('elevenlabs ' + r.status);
  return { buf: Buffer.from(await r.arrayBuffer()), mime: 'audio/mpeg' };
}

app.get('/api/tts', async (req, res) => {
  if (!proxyAllow(getClientIp(req))) return res.status(429).send('rate limited — try again in a minute');
  const text = (req.query.text || '').toString().trim();
  const voiceId = (req.query.voice || 'joanna').toString().toLowerCase();
  const lang = (req.query.lang || 'en').toString();
  if (!text) return res.status(400).send('text required');
  if (text.length > 600) return res.status(400).send('text too long (max 600 chars)');
  const voice = TTS_VOICES[voiceId] || TTS_VOICES.joanna;
  const isEnglish = lang === 'en' || lang === 'en-US' || lang === 'en-GB';

  const ctrl = new AbortController();
  const tmo = setTimeout(() => ctrl.abort(), 25000);

  // Provider order depends on language:
  // - English → StreamElements (best free voices) → Google → ElevenLabs
  // - Other languages → Google (free, multilingual) → ElevenLabs (premium)
  //   (StreamElements only speaks English, so it's skipped for other languages)
  const providers = isEnglish
    ? [
        { name: 'streamelements', fn: () => ttsFromStreamElements(voice, text, ctrl.signal) },
        { name: 'google',         fn: () => ttsFromGoogleTranslate(text, ctrl.signal, 'en') },
        { name: 'elevenlabs',     fn: () => ttsFromElevenLabs(voiceId, text, ctrl.signal) },
      ]
    : [
        { name: 'google',         fn: () => ttsFromGoogleTranslate(text, ctrl.signal, lang) },
        { name: 'elevenlabs',     fn: () => ttsFromElevenLabs(voiceId, text, ctrl.signal) },
      ];
  let lastErr = '';
  for (const p of providers) {
    try {
      const { buf, mime } = await p.fn();
      clearTimeout(tmo);
      if (!buf || buf.length < 256) { lastErr = p.name + ' empty'; continue; }
      console.log('[stmz/tts] ✓', p.name, '·', buf.length, 'bytes ·', text.slice(0, 40) + '…');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', mime);
      res.setHeader('X-TTS-Provider', p.name);
      return res.end(buf);
    } catch (err) {
      lastErr = `${p.name}: ${err.message || err.name}`;
      console.warn('[stmz/tts]', lastErr);
      // For ElevenLabs missing key, fail silently to next; for others, keep trying
      continue;
    }
  }
  clearTimeout(tmo);
  res.status(502).send('All TTS providers failed: ' + lastErr);
});

/* Stock photo lookup — Pexels free API (200/hr, 20k/month free).
   Used by video.js as PRIMARY image source for video scenes — instant,
   high-quality, reliable. Falls back to Pollinations + Picsum if not set
   or no results. User adds PEXELS_API_KEY in .env to enable. */
app.get('/api/stock-image', async (req, res) => {
  if (!proxyAllow(getClientIp(req))) return res.status(429).json({ url: null, reason: 'rate-limited' });
  const query = (req.query.query || '').toString().trim();
  if (!query) return res.json({ url: null, reason: 'no-query' });
  const key = process.env.PEXELS_API_KEY;
  if (!key) return res.json({ url: null, reason: 'no-key' });
  try {
    // Truncate very long queries (Pexels works better with concise terms)
    const q = query.slice(0, 200);
    // orientation portrait so it fits vertical videos better; client picks final crop
    const orient = (req.query.orient || 'landscape').toString();
    const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&orientation=${orient}&per_page=5`, {
      headers: { Authorization: key },
    });
    if (!r.ok) return res.json({ url: null, reason: `pexels ${r.status}` });
    const data = await r.json();
    const pick = data?.photos?.[Math.floor(Math.random() * Math.min(data.photos.length, 5))];
    if (!pick) return res.json({ url: null, reason: 'no-results' });
    res.json({
      url: pick.src?.large2x || pick.src?.large || pick.src?.original,
      photographer: pick.photographer,
      photographerUrl: pick.photographer_url,
    });
  } catch (err) {
    res.json({ url: null, reason: err.message });
  }
});
app.get('/privacy', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'terms.html')));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  const list = PROVIDERS.filter(p=>p.enabled()).map(p=>p.name).join(', ') || 'NONE (add a key)';
  console.log(`STMZ Kinetic running on ${APP_URL}`);
  console.log(`AI providers: ${list}`);
  console.log(`LinkedIn: ${process.env.LINKEDIN_CLIENT_ID ? 'enabled' : 'not configured'}`);
  console.log(`Scheduler: ${adminDb ? 'in-process every 60s' : 'disabled (no Firebase Admin)'}`);
});
