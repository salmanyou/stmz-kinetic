/* ============================================================
   STMZ KINETIC — workspace app
   Sidebar shell + 7 views + post editor + AI generation.
   ============================================================ */

import {
  onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, getIdToken
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { auth, provider, paddleConfig, isConfigured, TIERS } from './firebase-config.js';
import { generatePostVideo, generateStoryVideo, downloadBlob } from './video.js';
import { Storage } from './storage.js';

/* ---------------- state ---------------- */
const DEMO_LIMIT = 3;
let user = null;
let subscribed = false;
let brands = [];
let activeBrandId = null;
let posts = [];           // cached library
let editingPostId = null;

/* ---------------- helpers ---------------- */
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); }
function fmtDate(ts) { if (!ts) return '—'; const d = new Date(ts); return d.toLocaleDateString(undefined, { month:'short', day:'numeric' }); }
function todayKey() { return 'stmz_demo_' + new Date().toISOString().slice(0, 10); }
function demoUsed() { return parseInt(localStorage.getItem(todayKey()) || '0', 10); }
function demoLeft() { return Math.max(0, DEMO_LIMIT - demoUsed()); }
function demoBump() { localStorage.setItem(todayKey(), String(demoUsed() + 1)); refreshSidebar(); }
async function authToken() { if (user) { try { return await getIdToken(user); } catch { return null; } } return null; }

function refreshSidebar() {
  $('libCount').textContent = posts.length;
  $('userInfo').textContent = user ? (user.displayName || user.email || 'Signed in') : 'Demo session';
  if (isFounder()) {
    $('planInfo').innerHTML = '<span style="color:var(--signal);font-weight:700">⭐ Founder · Unlimited</span>';
  } else if (subscribed && subscribed.tier) {
    const t = TIERS.find(x => x.id === subscribed.tier);
    const label = t ? t.name : (subscribed.tier.charAt(0).toUpperCase() + subscribed.tier.slice(1));
    $('planInfo').textContent = `${label} · $${t?.price || '—'}/mo`;
  } else {
    $('planInfo').textContent = `${demoLeft()} batches left today`;
  }
  $('upgradeBtn').style.display = (subscribed || isFounder()) ? 'none' : 'inline-flex';
  $('authLink').textContent = user ? 'Sign out' : 'Sign in';
}
function activeBrand() { return brands.find(b => b.id === activeBrandId) || null; }
function brandName(id) { const b = brands.find(b => b.id === id); return b ? b.name : '—'; }

/* ---------------- view switching ---------------- */
function showApp() {
  $('landing').classList.add('hidden');
  $('landingFooter').style.display = 'none';
  $('topNav').style.display = 'none';
  $('app').classList.add('active');
  if (!location.hash.startsWith('#/')) location.hash = '#/dashboard';
  else router();
}
function goHome() {
  $('app').classList.remove('active');
  $('landing').classList.remove('hidden');
  $('landingFooter').style.display = '';
  $('topNav').style.display = '';
  window.scrollTo(0, 0);
}
function launch(e) { if (e) e.preventDefault(); showApp(); if (!brands.length) newBrand(); }
function toggleSidebar() {
  const sb = $('sidebar');
  const open = !sb.classList.contains('open');
  sb.classList.toggle('open', open);
  document.body.classList.toggle('sidebar-locked', open);
  let scrim = document.getElementById('sbScrim');
  if (open) {
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.id = 'sbScrim';
      scrim.className = 'sb-scrim';
      scrim.onclick = () => toggleSidebar();
      document.body.appendChild(scrim);
    }
    scrim.classList.add('show');
  } else if (scrim) {
    scrim.classList.remove('show');
  }
}

/* ---------------- router ---------------- */
const VIEWS = {
  dashboard:    { title: 'Dashboard',    sub: 'welcome back',                     fn: renderDashboard    },
  generate:     { title: 'Generate',     sub: 'AI campaign builder',              fn: renderGenerate     },
  autopilot:    { title: 'AutoPilot',    sub: 'your week of content, on autopilot', fn: renderAutoPilot  },
  planner:      { title: 'Best Time to Post', sub: 'when to post + a month plan that fills itself', fn: renderPlanner },
  monthplan:    { title: '30-Day Content Plan', sub: 'one click → a full month of balanced, scheduled content', fn: renderMonthPlan },
  ideas:        { title: 'Ideas',        sub: 'fresh content ideas for your brand', fn: renderIdeas      },
  videostudio:  { title: 'Video Studio', sub: 'prompt → multi-scene AI video',    fn: renderVideoStudio  },
  contentlift:  { title: 'Content Lift', sub: 'paste a URL or text → a week of posts', fn: renderContentLift },
  bulkproducts: { title: 'Bulk Products', sub: 'CSV → multi-platform campaigns per product', fn: renderBulkProducts },
  replyassistant: { title: 'Reply Assistant', sub: 'paste a comment or DM → 3 brand-voiced replies', fn: renderReplyAssistant },
  analytics:    { title: 'Analytics',     sub: 'what works for you, what doesn\'t',  fn: renderAnalytics    },
  library:      { title: 'Library',      sub: 'every post you have ever made',    fn: renderLibrary      },
  calendar:     { title: 'Calendar',     sub: 'your scheduled posts',             fn: renderCalendar     },
  templates:    { title: 'Templates',    sub: 'campaign starters',                fn: renderTemplates    },
  assistant:    { title: 'AI Assistant', sub: 'chat with your brand in mind',     fn: renderAssistant    },
  integrations: { title: 'Connect',      sub: 'auto-post to your social accounts', fn: renderIntegrations },
  brands:       { title: 'Brand kit',    sub: 'every brand you manage',           fn: renderBrands       },
  support:      { title: 'Support',      sub: 'questions, issues, feedback',         fn: renderSupport      },
  settings:     { title: 'Settings',     sub: 'account &amp; subscription',           fn: renderSettings     },
};

function router() {
  if (!$('app').classList.contains('active')) return;
  const key = (location.hash.slice(2) || 'dashboard').split('/')[0];
  const v = VIEWS[key] || VIEWS.dashboard;
  $$('.nav-item').forEach(b => b.classList.toggle('on', b.dataset.view === key));
  $('viewTitle').textContent = v.title;
  $('viewSub').innerHTML = v.sub;
  $('sidebar').classList.remove('open');
  document.body.classList.remove('sidebar-locked');
  const _scrim = document.getElementById('sbScrim');
  if (_scrim) _scrim.classList.remove('show');
  v.fn();
}
window.addEventListener('hashchange', router);

/* ============================================================
   VIEW: DASHBOARD
   ============================================================ */
function renderDashboard() {
  const drafts = posts.filter(p => p.status === 'draft').length;
  const scheduled = posts.filter(p => p.status === 'scheduled').length;
  const postedTotal = posts.filter(p => p.status === 'posted').length;
  const pending = posts.filter(p => p.status === 'pending_approval').length;
  const now = Date.now(); const weekMs = 7 * 24 * 60 * 60 * 1000;
  const thisWeek = posts.filter(p => p.scheduledAt && p.scheduledAt >= now && p.scheduledAt < now + weekMs).length;
  const recent = posts.slice(0, 6);

  const bName = activeBrand()?.name || 'no brand yet';
  const apOn = autopilot?.enabled;
  const apNext = autopilot?.lastGeneratedAt
    ? autopilot.lastGeneratedAt + (autopilot.cadence === 'daily' ? 1 : 7) * 24*60*60*1000
    : null;

  $('main').innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="k">Active brand</div><div class="v" style="font-size:22px">${esc(bName)}</div></div>
      <div class="kpi"><div class="k">In library</div><div class="v">${posts.length}</div></div>
      <div class="kpi"><div class="k">Scheduled this week</div><div class="v">${thisWeek}</div></div>
      <div class="kpi"><div class="k">Drafts · pending · scheduled · posted</div><div class="v" style="font-size:20px">${drafts}<small>·${pending}·${scheduled}·${postedTotal}</small></div></div>
    </div>

    ${apOn ? `
    <div class="ap-hero" style="margin-top:18px">
      <h3>⊛ AutoPilot is generating your content</h3>
      <p>Next batch: <b class="signal">${apNext ? fmtDate(apNext) : 'on next tick'}</b> · ${autopilot.postsPerWeek || 5} posts/week · ${(autopilot.platforms||[]).join(' + ')}${pending?` · <a href="#" onclick="STMZ.apOpenApprovals();return false" class="signal">${pending} pending approval →</a>`:''}</p>
    </div>
    ` : (subscribed && subscribed.tier !== 'starter' ? `
    <div class="ap-hero" style="margin-top:18px">
      <h3>⊛ Switch on AutoPilot</h3>
      <p>You're on the ${subscribed.tier} tier. AutoPilot is included — turn it on and your content writes itself every week using past performance data.</p>
      <button class="btn primary" style="margin-top:10px" onclick="location.hash='#/autopilot'">Set up AutoPilot →</button>
    </div>
    ` : '')}

    <div class="section-title">Quick actions</div>
    <div class="qa-grid">
      <div class="qa" onclick="location.hash='#/generate'"><b>⚡ Generate a batch</b><span>AI campaign builder — pick platforms, get posts.</span></div>
      <div class="qa" onclick="location.hash='#/autopilot'"><b>⊛ AutoPilot</b><span>Set it up once, content writes itself weekly.</span></div>
      <div class="qa" onclick="location.hash='#/videostudio'"><b>🎥 Video Studio</b><span>Prompt → multi-scene AI video. Reels, TikTok, Shorts.</span></div>
      <div class="qa" onclick="location.hash='#/contentlift'"><b>⇪ Content Lift</b><span>Paste a URL or text → a week of posts.</span></div>
    </div>

    <div class="section-title">Recent posts <a href="#/library">view all →</a></div>
    ${recent.length ? `<div class="lib-grid">${recent.map(libCardHTML).join('')}</div>` : emptyLibraryHTML()}
  `;
}

/* ============================================================
   VIEW: GENERATE  (campaign builder)
   ============================================================ */
function renderGenerate(prefill = {}) {
  const def = { platforms:['Instagram','LinkedIn'], goal:'Grow awareness & followers', count:'7', days:'7', ...prefill };
  const plats = ['Instagram','TikTok','LinkedIn','Facebook','X / Twitter','Telegram'];

  $('main').innerHTML = `
    <div class="builder">
      <label class="fld">Platforms</label>
      <div class="chips" id="platChips">
        ${plats.map(p => `<span class="chip ${def.platforms.includes(p)?'on':''}" data-p="${esc(p)}">${esc(p)}</span>`).join('')}
      </div>
      <div class="row3" style="margin-top:16px">
        <div><label class="fld">Campaign goal</label>
          <select class="t" id="goal">
            ${['Grow awareness & followers','Drive sales / promote an offer','Launch a new product','Educate & build authority','Engagement & community'].map(g => `<option ${g===def.goal?'selected':''}>${esc(g)}</option>`).join('')}
          </select></div>
        <div><label class="fld">How many posts</label>
          <select class="t" id="count">${['3','7','14','30'].map(n => `<option ${n===def.count?'selected':''}>${n}</option>`).join('')}</select></div>
        <div><label class="fld">Spread over (days)</label>
          <select class="t" id="days">${['3','7','14','30'].map(n => `<option ${n===def.days?'selected':''}>${n}</option>`).join('')}</select></div>
      </div>
      <div style="margin-top:16px">
        <label class="fld">Content language 🌍</label>
        <select class="t" id="gen_lang" style="max-width:280px">
          ${[['en','English'],['ur','Urdu — اردو'],['ar','Arabic — العربية'],['hi','Hindi — हिन्दी'],['es','Spanish — Español'],['fr','French — Français'],['de','German — Deutsch'],['pt','Portuguese'],['id','Indonesian'],['tr','Turkish'],['bn','Bengali'],['ms','Malay'],['it','Italian'],['ru','Russian'],['ja','Japanese'],['ko','Korean'],['zh-CN','Chinese'],['th','Thai'],['vi','Vietnamese'],['fa','Persian'],['ta','Tamil'],['sw','Swahili']].map(([c,n])=>`<option value="${c}"${c==='en'?' selected':''}>${n}</option>`).join('')}
        </select>
        <p style="font-size:10.5px;color:var(--ink-faint);margin-top:5px">Posts (captions, hooks, hashtags) are written in this language. Free, 22 languages.</p>
      </div>
      <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn primary" id="genBtn" onclick="STMZ.runGenerate()">⚡ Generate &amp; save to library</button>
        <span class="quota" id="genStatus"></span>
      </div>
    </div>
    <div id="genResults" style="margin-top:24px"></div>
  `;
  $('platChips').addEventListener('click', e => { if (e.target.classList.contains('chip')) e.target.classList.toggle('on'); });
}

async function runGenerate() {
  const brand = activeBrand();
  if (!brand) { toast('Create a brand profile first.'); newBrand(); return; }
  const platforms = $$('.chip.on', $('platChips')).map(c => c.dataset.p);
  if (!platforms.length) { toast('Pick at least one platform.'); return; }
  if (!canRun()) return;

  const btn = $('genBtn'); btn.disabled = true;
  $('genStatus').textContent = 'Generating your batch…';
  $('genResults').innerHTML = '<div class="empty-big"><div class="ico">⚡</div><b>Building your content batch…</b><p>Writing posts and lining up images. This usually takes 10-30 seconds.</p></div>';

  try {
    const token = await authToken();
    const res = await fetch('/api/campaign', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) },
      body: JSON.stringify({ brand, platforms, goal:$('goal').value, count:parseInt($('count').value,10), days:parseInt($('days').value,10), lang:$('gen_lang')?.value || 'en' })
    });
    if (res.status === 402) { openPay(); throw new Error('limit'); }
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.message || 'The AI is busy, try again.'); }
    const data = await res.json();
    if (!data.subscribed) demoBump();

    // Save every post to the library with status=draft + scheduledAt = today+day-1
    const now = Date.now();
    $('genStatus').textContent = 'Finding the right photo for each post…';
    // Pexels-first: a real stock photo matching each post's stockQuery
    // (parallel, ~300ms total). Falls back to AI image if no match.
    const withImages = await resolvePostImages(data.posts || []);
    const enriched = withImages.map((p, i) => {
      const dayOffset = (Math.max(1, parseInt(p.day, 10) || (i+1)) - 1) * 24 * 60 * 60 * 1000;
      return {
        brandId: brand.id,
        platform: p.platform || platforms[0],
        hook: p.hook || p.theme || '',
        caption: p.caption || '',
        hashtags: Array.isArray(p.hashtags) ? p.hashtags : (typeof p.hashtags === 'string' ? p.hashtags.split(/\s+/) : []),
        cta: p.cta || '',
        imagePrompt: p.imagePrompt || '',
        stockQuery: p.stockQuery || '',
        imageUrl: p.imageUrl,
        status: 'draft',
        scheduledAt: now + dayOffset,
      };
    });
    const saved = await Storage.savePostsBulk(enriched);
    posts = [...saved, ...posts];
    refreshSidebar();
    $('genStatus').textContent = `Done — ${saved.length} posts saved to your library via ${data.provider}`;
    $('genResults').innerHTML = `
      <div class="section-title">Just generated <a href="#/library">open library →</a></div>
      <div class="lib-grid">${saved.map(libCardHTML).join('')}</div>
    `;
  } catch (err) {
    if (err.message !== 'limit') {
      $('genResults').innerHTML = `<div class="empty-big"><b>Hmm.</b><p>${esc(err.message)}</p></div>`;
      $('genStatus').textContent = '';
    }
  } finally {
    btn.disabled = false;
  }
}

function imgUrl(prompt) {
  const seed = Math.floor(Math.random() * 99999);
  const p = encodeURIComponent((prompt || 'minimal brand social media background').slice(0, 180));
  // turbo model = fastest; nofeed = skip the public feed (slightly faster).
  // If this URL fails to load, the global onerror handler swaps to Picsum.
  return `https://image.pollinations.ai/prompt/${p}?model=turbo&width=768&height=768&seed=${seed}&nologo=true&nofeed=true`;
}

/* Pexels-first post image: a REAL stock photo matching the post's stockQuery
   (instant + relevant), falling back to the AI-generated Pollinations image
   only when Pexels has no key/results. This is why post pictures match the
   post content instead of being random. */
async function resolvePostImage(stockQuery, imagePrompt) {
  const q = (stockQuery || '').toString().trim();
  if (q) {
    try {
      const r = await fetch(`/api/stock-image?query=${encodeURIComponent(q)}&orient=landscape`);
      if (r.ok) {
        const j = await r.json();
        if (j.url) return j.url;
      }
    } catch { /* fall through */ }
  }
  return imgUrl(imagePrompt || stockQuery);
}

/* Resolve images for a whole batch of AI posts in parallel. */
function resolvePostImages(posts) {
  return Promise.all((posts || []).map(async p => {
    p.imageUrl = await resolvePostImage(p.stockQuery, p.imagePrompt || p.hook);
    return p;
  }));
}

/* ============================================================
   VIEW: LIBRARY
   ============================================================ */
function renderLibrary() {
  $('main').innerHTML = `
    <div class="lib-bar">
      <input class="t" id="libSearch" placeholder="Search posts…" oninput="STMZ.refilterLibrary()">
      <select class="t" id="libBrand" onchange="STMZ.refilterLibrary()">
        <option value="">All brands</option>
        ${brands.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}
      </select>
      <select class="t" id="libPlatform" onchange="STMZ.refilterLibrary()">
        <option value="">All platforms</option>
        ${['Instagram','TikTok','LinkedIn','Facebook','X / Twitter','Telegram'].map(p => `<option>${p}</option>`).join('')}
      </select>
      <select class="t" id="libStatus" onchange="STMZ.refilterLibrary()">
        <option value="">All statuses</option>
        <option value="draft">Draft</option>
        <option value="pending_approval">Pending approval ⊛</option>
        <option value="scheduled">Scheduled</option>
        <option value="posted">Posted</option>
      </select>
      <button class="btn" onclick="STMZ.exportLibrary()">Export CSV ↓</button>
    </div>
    <div id="libBody"></div>
  `;
  refilterLibrary();
}

function refilterLibrary() {
  const q = ($('libSearch')?.value || '').toLowerCase();
  const fb = $('libBrand')?.value || '';
  const fp = $('libPlatform')?.value || '';
  const fs = $('libStatus')?.value || '';
  const filtered = posts.filter(p => {
    if (fb && p.brandId !== fb) return false;
    if (fp && p.platform !== fp) return false;
    if (fs && p.status !== fs) return false;
    if (q) {
      const blob = (p.hook + ' ' + p.caption + ' ' + (p.hashtags || []).join(' ')).toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
  const body = $('libBody');
  body.innerHTML = filtered.length
    ? `<div class="lib-grid">${filtered.map(libCardHTML).join('')}</div>`
    : emptyLibraryHTML();
}

function libCardHTML(p) {
  const tags = (p.hashtags || []).slice(0, 4).join(' ');
  return `<div class="lib-card">
    <div class="head"><span class="plat">${esc(p.platform)}</span>
      <span class="status-pill status-${p.status||'draft'}">${esc(p.status||'draft')}</span></div>
    <div class="body">
      <div class="hook">${esc(p.hook || '(no hook)')}</div>
      <div class="cap">${esc((p.caption || '').slice(0, 220))}${(p.caption||'').length>220?'…':''}</div>
      <div style="font-family:var(--mono);font-size:11px;color:var(--ink-faint);margin-top:8px">
        ${esc(brandName(p.brandId))} · ${fmtDate(p.scheduledAt)} ${tags?`· <span class="signal">${esc(tags)}</span>`:''}
      </div>
    </div>
    <div class="foot">
      <button onclick="STMZ.editPost('${p.id}')">Edit</button>
      <button onclick="STMZ.cyclePostStatus('${p.id}')">Status</button>
      <button onclick="STMZ.copyPostById('${p.id}')">Copy</button>
    </div>
  </div>`;
}

function emptyLibraryHTML() {
  return `<div class="empty-big"><div class="ico">▤</div>
    <b>No posts in your library yet</b>
    <p>Generate your first batch and every post will appear here — drafts, scheduled, posted, all searchable.</p>
    <a class="btn primary" href="#/generate">⚡ Generate a batch</a></div>`;
}

async function exportLibrary() {
  const list = posts.length ? posts : [];
  if (!list.length) { toast('Nothing to export yet.'); return; }
  const head = ['ScheduledDate','Platform','Brand','Status','Hook','Caption','Hashtags','CTA','ImageURL'];
  const q = v => '"' + String(v==null?'':v).replace(/"/g,'""') + '"';
  const rows = list.map(p => [
    p.scheduledAt ? new Date(p.scheduledAt).toISOString().slice(0,10) : '',
    p.platform, brandName(p.brandId), p.status,
    p.hook, p.caption, (p.hashtags||[]).join(' '), p.cta, p.imageUrl
  ].map(q).join(','));
  const csv = head.join(',') + '\n' + rows.join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
  a.download = (activeBrand()?.name || 'stmz') + '-library.csv';
  a.click(); URL.revokeObjectURL(a.href);
  toast('CSV exported. Import into Buffer / Later / Hootsuite.');
}

/* ============================================================
   VIEW: CALENDAR
   ============================================================ */
let calCursor = new Date(); calCursor.setDate(1);

function renderCalendar() {
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  const monthLabel = calCursor.toLocaleDateString(undefined, { month:'long', year:'numeric' });
  const first = new Date(y, m, 1);
  const offset = first.getDay(); // 0..6
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);

  const cells = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, m, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const byDate = {};
  posts.forEach(p => {
    if (!p.scheduledAt) return;
    const dt = new Date(p.scheduledAt); dt.setHours(0,0,0,0);
    const key = dt.toISOString().slice(0,10);
    (byDate[key] = byDate[key] || []).push(p);
  });

  $('main').innerHTML = `
    <div class="cal-head">
      <h2>${esc(monthLabel)}</h2>
      <div class="nav">
        <button class="btn sm" onclick="STMZ.calNav(-1)">‹ Prev</button>
        <button class="btn sm" onclick="STMZ.calToday()">Today</button>
        <button class="btn sm" onclick="STMZ.calNav(1)">Next ›</button>
      </div>
    </div>
    <div class="cal-scroll"><div class="cal-grid">
      ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="cal-day-header">${d}</div>`).join('')}
      ${cells.map(cell => {
        if (!cell) return '<div class="cal-cell empty"></div>';
        const k = cell.toISOString().slice(0,10);
        const isToday = cell.getTime() === today.getTime();
        const items = byDate[k] || [];
        return `<div class="cal-cell ${isToday?'today':''}">
          <div class="date">${cell.getDate()}</div>
          ${items.slice(0,3).map(p => `<div class="cal-post" onclick="STMZ.editPost('${p.id}')">
            <div class="p-plat">${esc(p.platform)}</div>${esc((p.hook||p.caption||'').slice(0,40))}
          </div>`).join('')}
          ${items.length>3?`<div style="font-family:var(--mono);font-size:10px;color:var(--ink-faint)">+${items.length-3} more</div>`:''}
        </div>`;
      }).join('')}
    </div></div>
  `;
}
function calNav(d) { calCursor.setMonth(calCursor.getMonth() + d); renderCalendar(); }
function calToday() { calCursor = new Date(); calCursor.setDate(1); renderCalendar(); }

/* ============================================================
   VIEW: TEMPLATES
   ============================================================ */
const TEMPLATES = [
  { id:'launch', name:'Product launch week', desc:'7 posts building hype, revealing the product, and driving sales.',  platforms:['Instagram','LinkedIn','TikTok'], goal:'Launch a new product', count:'7',  days:'7',  tags:'launch · 7 posts' },
  { id:'sale',   name:'Holiday / flash sale', desc:'7 punchy posts for a limited-time offer with urgency built in.',     platforms:['Instagram','Facebook','X / Twitter'], goal:'Drive sales / promote an offer', count:'7', days:'5', tags:'sale · 7 posts' },
  { id:'tips',   name:'Weekly tips series',  desc:'14 educational posts that build authority and grow followers.',       platforms:['LinkedIn','Instagram'], goal:'Educate & build authority', count:'14', days:'14', tags:'tips · 14 posts' },
  { id:'story',  name:'Founder story series', desc:'7 personal posts telling the brand story — high engagement.',         platforms:['LinkedIn','Instagram'], goal:'Engagement & community', count:'7', days:'14', tags:'story · 7 posts' },
  { id:'cust',   name:'Customer spotlight',  desc:'7 social-proof posts featuring happy customers / reviews / results.',  platforms:['Instagram','Facebook','LinkedIn'], goal:'Engagement & community', count:'7', days:'7', tags:'social proof · 7 posts' },
  { id:'month',  name:'Whole-month plan',    desc:'30 posts spread across the month — a complete content engine.',       platforms:['Instagram','LinkedIn','Facebook'], goal:'Grow awareness & followers', count:'30', days:'30', tags:'30 posts · 30 days' },
];

function renderTemplates() {
  $('main').innerHTML = `
    <p class="intro" style="margin-bottom:22px">Tap a template — it pre-fills the generator with the right platforms, goal and post count. Tweak if needed, then generate.</p>
    <div class="tpl-grid">${TEMPLATES.map(t => `
      <div class="tpl-card" onclick="STMZ.useTemplate('${t.id}')">
        <div class="ix">${esc(t.id.toUpperCase())}</div>
        <h3>${esc(t.name)}</h3>
        <p>${esc(t.desc)}</p>
        <div class="tags">${esc(t.tags)}</div>
      </div>`).join('')}
    </div>`;
}

function useTemplate(id) {
  const t = TEMPLATES.find(x => x.id === id); if (!t) return;
  location.hash = '#/generate';
  setTimeout(() => renderGenerate(t), 10);
}

/* ============================================================
   VIEW: BRANDS
   ============================================================ */
function renderBrands() {
  if (!brands.length) {
    $('main').innerHTML = `<div class="empty-big"><div class="ico">◉</div>
      <b>No brands yet</b><p>Add your first brand to give the AI your voice, audience and offer.</p>
      <button class="btn primary" onclick="STMZ.newBrand()">+ Add a brand</button></div>`;
    return;
  }
  $('main').innerHTML = `
    <div style="margin-bottom:18px"><button class="btn primary" onclick="STMZ.newBrand()">+ Add a brand</button></div>
    <div class="brand-grid">${brands.map(b => `
      <div class="brand-card">
        <h3>${esc(b.name)}${b.id===activeBrandId?' <span class="status-pill status-scheduled" style="margin-left:6px">active</span>':''}</h3>
        <div class="meta">
          ${b.what?`<b>SELLS</b> ${esc(b.what)}<br>`:''}
          ${b.audience?`<b>FOR</b> ${esc(b.audience)}<br>`:''}
          ${b.tone?`<b>VOICE</b> ${esc(b.tone)}<br>`:''}
          ${b.offer?`<b>OFFER</b> ${esc(b.offer)}`:''}
        </div>
        <div class="acts">
          <button class="btn sm" onclick="STMZ.makeActive('${b.id}')">Use this</button>
          <button class="btn sm" onclick="STMZ.editBrandById('${b.id}')">Edit</button>
          <button class="btn sm" onclick="STMZ.removeBrand('${b.id}')" style="color:var(--danger);border-color:var(--danger)">Delete</button>
        </div>
      </div>`).join('')}</div>`;
}

async function makeActive(id) { activeBrandId = id; await Storage.setActiveBrand(id); renderBrandSelect(); renderBrands(); toast('Active brand switched.'); }
async function removeBrand(id) {
  if (!confirm('Delete this brand? Posts already in the library will stay but will reference a missing brand.')) return;
  await Storage.deleteBrand(id);
  brands = brands.filter(b => b.id !== id);
  if (activeBrandId === id) activeBrandId = brands[0]?.id || null;
  renderBrandSelect(); renderBrands(); toast('Brand deleted.');
}

/* ============================================================
   VIEW: SETTINGS
   ============================================================ */
/* ============================================================
   VIEW: SUPPORT — contact + feedback
   ============================================================ */
/* Support contact templates. Each card opens a chooser that works for
   EVERYONE: email app (mailto), Gmail web compose, or copy — because mailto
   silently does nothing on desktops with no mail app configured. */
const SUPPORT_TEMPLATES = {
  bug: {
    ico: '⚠', h: 'Report a bug', p: "Something isn't working. We'll fix it fast.",
    subject: 'STMZ Kinetic — Bug report',
    body: 'Hi,\n\nI hit a problem while using STMZ Kinetic.\n\nWhat happened:\n[Describe what you did and what went wrong]\n\nWhat I expected:\n[What you expected to happen instead]\n\nBrowser / device:\n[e.g. Chrome on Windows 11]\n',
  },
  billing: {
    ico: '$', h: 'Billing question', p: 'Subscription, invoices, refunds, plan changes.',
    subject: 'STMZ Kinetic — Billing question',
    body: 'Hi,\n\nI have a question about my subscription / billing.\n\n[Describe your question]\n',
  },
  feature: {
    ico: '★', h: 'Suggest a feature', p: 'An idea to make the product better.',
    subject: 'STMZ Kinetic — Feature request',
    body: 'Hi,\n\nI have a suggestion for STMZ Kinetic.\n\nWhat I want to do:\n[Describe the workflow]\n\nHow it would help me:\n[Why this matters for your business]\n',
  },
  account: {
    ico: '⌬', h: 'Account help', p: 'Sign-in, sync, missing data, anything account-related.',
    subject: 'STMZ Kinetic — Account help',
    body: 'Hi,\n\nI need help with my account.\n\n[Describe the issue — sign-in problem, data not appearing, etc.]\n',
  },
  partner: {
    ico: '⌘', h: 'Partnerships / press', p: 'Agency program, integrations, press, anything else.',
    subject: 'STMZ Kinetic — Partnership / press',
    body: 'Hi,\n\nI would like to discuss [partnership / press / agency program / something else].\n\n[Details]\n',
  },
  hi: {
    ico: '♡', h: 'Just say hi', p: "Tell us what is working for you. We read everything.",
    subject: 'STMZ Kinetic — Just want to say hi',
    body: 'Hi STMZ team,\n\n[Tell us how it is going — wins, losses, anything.]\n',
  },
};

const SUPPORT_EMAIL = 'support@stmzkinetic.com';

/* 1-click auto-posting setup. Point this at a published Make.com TEMPLATE
   (Make.com → your scenario → ⋯ → "Create a template" → publish → copy URL).
   Falls back to Make.com's sign-up page until you publish one. */
const MAKE_TEMPLATE_URL = 'https://www.make.com/en/register';
// ^ REPLACE with your published template URL when ready.

function supportSig() {
  return user
    ? `\n\n— Sent from STMZ Kinetic\nAccount: ${user.email || user.displayName || 'signed-in user'}`
    : '\n\n— Sent from STMZ Kinetic';
}

function supportContact(kind) {
  const t = SUPPORT_TEMPLATES[kind];
  if (!t) return;
  const subject = t.subject;
  const body = t.body + supportSig();
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(SUPPORT_EMAIL)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  const old = document.getElementById('_supModal'); if (old) old.remove();
  const m = document.createElement('div');
  m.className = 'modal-bg show';
  m.id = '_supModal';
  m.innerHTML = `
    <div class="modal" style="max-width:520px">
      <span class="x" onclick="document.getElementById('_supModal').remove()">✕ close</span>
      <h3 style="font-size:20px">${t.ico} ${esc(t.h)}</h3>
      <p style="font-size:13px;margin-bottom:14px">Pick whichever works for you — all three send to <b class="signal">${SUPPORT_EMAIL}</b>:</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <a class="btn primary" style="justify-content:center" href="${mailto}">✉ &nbsp;Open in my email app</a>
        <a class="btn" style="justify-content:center" href="${gmail}" target="_blank" rel="noopener">🌐 &nbsp;Compose in Gmail (web)</a>
        <button class="btn" onclick="STMZ.supportCopy('${kind}')" id="supCopyBtn">⧉ &nbsp;Copy email address + template</button>
      </div>
      <div style="background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-top:14px">
        <div style="font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:6px">Message preview</div>
        <div style="font-size:12px;color:var(--ink-dim);white-space:pre-wrap;max-height:160px;overflow-y:auto">Subject: ${esc(subject)}\n\n${esc(body)}</div>
      </div>
    </div>`;
  m.addEventListener('click', e => { if (e.target === m) m.remove(); });
  document.body.appendChild(m);
}

async function supportCopy(kind) {
  const t = SUPPORT_TEMPLATES[kind];
  const text = `To: ${SUPPORT_EMAIL}\nSubject: ${t.subject}\n\n${t.body + supportSig()}`;
  try {
    await navigator.clipboard.writeText(text);
    const b = $('supCopyBtn'); if (b) b.textContent = '✓ Copied — paste into any email';
  } catch {
    // Clipboard API can fail on http / older browsers — fall back to prompt
    window.prompt('Copy this, then paste into any email:', text);
  }
}

async function supportCopyEmail() {
  try {
    await navigator.clipboard.writeText(SUPPORT_EMAIL);
    toast('Email address copied ✓');
  } catch {
    window.prompt('Copy the address:', SUPPORT_EMAIL);
  }
}

function renderSupport() {
  $('main').innerHTML = `
    <p class="intro" style="margin-bottom:22px">Hit a bug, have a question, or want to suggest something? Send an email — replies usually within 24 hours.</p>

    <div class="support-hero">
      <div class="sh-line">Direct email</div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <a class="sh-mail" href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>
        <button class="btn sm" onclick="STMZ.supportCopyEmail()">⧉ Copy</button>
      </div>
      <p class="sh-sub">Mention what you were doing when the problem happened. Screenshots help a lot.</p>
    </div>

    <div class="section-title" style="margin-top:32px">Quick contact templates</div>
    <p style="font-size:13px;color:var(--ink-faint);margin-bottom:14px">Pick a topic — then choose email app, Gmail web, or copy. Works on every device.</p>

    <div class="support-grid">
      ${Object.entries(SUPPORT_TEMPLATES).map(([k, t]) => `
        <button class="support-card" onclick="STMZ.supportContact('${k}')" style="text-align:left;font-family:inherit;cursor:pointer">
          <div class="sc-ico">${t.ico}</div>
          <div class="sc-h">${esc(t.h)}</div>
          <div class="sc-p">${esc(t.p)}</div>
        </button>
      `).join('')}
    </div>

    <div class="support-faq" style="margin-top:36px">
      <div class="section-title">Before you email — common quick fixes</div>
      <details class="faq-item">
        <summary>The downloaded video won't open on Windows</summary>
        <p>Windows Media Player doesn't support <code>.webm</code> — the file is fine, just drag it onto a Chrome or Firefox tab to play it, or convert to MP4 at <a class="signal" href="https://cloudconvert.com/webm-to-mp4" target="_blank" rel="noopener">cloudconvert.com</a> (free, 30 seconds).</p>
      </details>
      <details class="faq-item">
        <summary>I'm hitting my brand-profile limit</summary>
        <p>Starter is 1 brand, Pro is 5, Agency is unlimited. Open <b>Settings → Subscription</b> to see your plan and upgrade if you need more.</p>
      </details>
      <details class="faq-item">
        <summary>The video doesn't show real motion — just a still photo</summary>
        <p>Real video clips come from Pexels Video and require a free Pexels API key set on the server. If you're the workspace owner, see <code>.env.example</code> or email us — we'll help you set it up in 2 minutes.</p>
      </details>
      <details class="faq-item">
        <summary>AutoPilot is greyed out</summary>
        <p>AutoPilot is included on Pro and Agency plans — open Settings → Subscription to upgrade.</p>
      </details>
      <details class="faq-item">
        <summary>Make.com / Zapier webhook not firing</summary>
        <p>The universal webhook is included on Pro and Agency plans. After upgrading, paste your Make.com webhook URL in <b>Connect → Connect everything else</b> and click <b>Send test</b> to verify it.</p>
      </details>
    </div>
  `;
}

function renderSettings() {
  const exp = subscribed ? new Date(subscribed.expiresAt || Date.now()).toLocaleDateString() : null;
  $('main').innerHTML = `
    <div class="settings-block">
      <h3>Account</h3>
      <div class="settings-row"><span class="k">Signed in as</span><span class="v">${user ? esc(user.email || user.displayName || 'Google user') : 'Not signed in'}</span></div>
      <div class="settings-row"><span class="k">Storage</span><span class="v">${user ? 'Cloud synced (Firestore)' : 'Local device only'}</span></div>
      ${user ? `<div class="settings-row"><span class="k">&nbsp;</span><button class="btn sm" onclick="STMZ.logout()">Sign out</button></div>`
             : `<div class="settings-row"><span class="k">&nbsp;</span><button class="btn sm primary" onclick="STMZ.login()">Sign in with Google</button></div>`}
    </div>

    <div class="settings-block">
      <h3>Subscription</h3>
      <div class="settings-row"><span class="k">Plan</span><span class="v ${subscribed?'signal':''}">${subscribed ? (() => {
        const t = TIERS.find(x => x.id === subscribed.tier);
        return t ? `${t.name} · $${t.price}/mo` : (subscribed.tier || 'Subscribed');
      })() : 'Demo · '+DEMO_LIMIT+' batches/day'}</span></div>
      ${subscribed && subscribed.expiresAt ? `<div class="settings-row"><span class="k">Renews / expires</span><span class="v">${new Date(subscribed.expiresAt).toLocaleDateString()}</span></div>` : ''}
      <div class="settings-row"><span class="k">&nbsp;</span>
        ${subscribed
          ? `<a class="btn sm" href="https://customer-portal.paddle.com" target="_blank" rel="noopener">Manage in Paddle ↗</a>`
          : `<button class="btn sm primary" onclick="STMZ.subscribe(event)">See plans</button>`}
      </div>
    </div>

    <div class="settings-block">
      <h3>Data</h3>
      <div class="settings-row"><span class="k">Posts in library</span><span class="v">${posts.length}</span></div>
      <div class="settings-row"><span class="k">Brand profiles</span><span class="v">${brands.length} / ${tierBrandLimit() === Number.MAX_SAFE_INTEGER ? '∞' : tierBrandLimit()} ${brands.length >= tierBrandLimit() ? '<span class="signal">— limit reached</span>' : ''}</span></div>
      <div class="settings-row"><span class="k">&nbsp;</span><button class="btn sm" onclick="STMZ.exportLibrary()">Export all as CSV ↓</button></div>
    </div>

    <div class="settings-block">
      <h3>Legal</h3>
      <div class="settings-row"><span class="k">Privacy policy</span><a class="btn sm" href="/privacy" target="_blank">Open ↗</a></div>
      <div class="settings-row"><span class="k">Terms of service</span><a class="btn sm" href="/terms" target="_blank">Open ↗</a></div>
    </div>
  `;
}

/* ============================================================
   POST EDITOR
   ============================================================ */
function editPost(id) {
  const p = posts.find(x => x.id === id); if (!p) return;
  editingPostId = id;
  $('p_platform').value = p.platform || 'Instagram';
  $('p_status').value = p.status || 'draft';
  $('p_date').value = p.scheduledAt ? new Date(p.scheduledAt).toISOString().slice(0,10) : '';
  $('p_hook').value = p.hook || '';
  $('p_caption').value = p.caption || '';
  $('p_hashtags').value = (p.hashtags || []).join(' ');
  $('p_imgprev').src = p.imageUrl || '';
  // Show LinkedIn and webhook buttons only if those integrations are configured
  if ($('liBtn')) $('liBtn').style.display = integrations.linkedin ? 'inline-flex' : 'none';
  if ($('webhookBtn')) $('webhookBtn').style.display = integrations.webhookUrl ? 'inline-flex' : 'none';
  // Performance fields — only meaningful once a post is actually posted
  const perf = p.performance || {};
  $('p_likes').value    = perf.likes    ?? '';
  $('p_comments').value = perf.comments ?? '';
  $('p_shares').value   = perf.shares   ?? '';
  $('p_reach').value    = perf.reach    ?? '';
  $('p_notes').value    = perf.notes    ?? '';
  $('perfRow').style.display = (p.status === 'posted') ? 'block' : 'none';
  // Switch performance visibility when status dropdown changes
  $('p_status').onchange = () => { $('perfRow').style.display = ($('p_status').value === 'posted') ? 'block' : 'none'; };
  $('postModal').classList.add('show');
}
function closePost() { $('postModal').classList.remove('show'); editingPostId = null; }

/* Re-roll the post's photo: Pexels returns one of the top-5 matches for the
   stockQuery (random pick server-side), so each click gives a different but
   still RELEVANT photo. Falls back to a fresh AI image if Pexels is empty. */
async function regenPostImage() {
  const p = posts.find(x => x.id === editingPostId); if (!p) return;
  const btn = $('p_imgRegen'); const st = $('p_imgStatus');
  btn.disabled = true; if (st) st.textContent = 'finding photo…';
  try {
    const q = p.stockQuery || p.imagePrompt || p.hook || p.caption?.slice(0, 60) || '';
    p.imageUrl = await resolvePostImage(q, p.imagePrompt || p.hook);
    $('p_imgprev').src = p.imageUrl;
    await Storage.savePost(p);
    if (st) st.textContent = '✓ updated';
    setTimeout(() => { if (st) st.textContent = ''; }, 2000);
  } catch (e) {
    if (st) st.textContent = 'failed — try again';
  } finally { btn.disabled = false; }
}

async function savePost() {
  const p = posts.find(x => x.id === editingPostId); if (!p) return;
  p.platform = $('p_platform').value;
  p.status = $('p_status').value;
  const d = $('p_date').value;
  p.scheduledAt = d ? new Date(d + 'T09:00:00').getTime() : null;
  p.hook = $('p_hook').value.trim();
  p.caption = $('p_caption').value.trim();
  p.hashtags = $('p_hashtags').value.trim().split(/\s+/).filter(Boolean);
  // Performance — only persisted if anything is set; lets us sort by it later.
  const perf = {
    likes:    parseInt($('p_likes').value, 10) || 0,
    comments: parseInt($('p_comments').value, 10) || 0,
    shares:   parseInt($('p_shares').value, 10) || 0,
    reach:    parseInt($('p_reach').value, 10) || 0,
    notes:    $('p_notes').value.trim(),
  };
  if (perf.likes || perf.comments || perf.shares || perf.reach || perf.notes) {
    p.performance = perf;
  } else {
    delete p.performance;
  }
  await Storage.savePost(p);
  closePost(); router(); toast('Post saved.');
}

async function deletePost() {
  if (!editingPostId) return;
  if (!confirm('Delete this post?')) return;
  await Storage.deletePost(editingPostId);
  posts = posts.filter(p => p.id !== editingPostId);
  refreshSidebar(); closePost(); router(); toast('Post deleted.');
}

async function aiRewritePost() {
  if (!canRun()) return;
  const cap = $('p_caption').value.trim();
  if (!cap) { toast('Nothing to rewrite yet.'); return; }
  const brand = activeBrand();
  const orig = cap; $('p_caption').value = 'Rewriting…';
  try {
    const token = await authToken();
    const res = await fetch('/api/generate', { method:'POST',
      headers:{'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{})},
      body: JSON.stringify({ tool:'writer',
        context: brand ? `Brand: ${brand.name}. Voice: ${brand.tone}. Audience: ${brand.audience}.` : '',
        prompt: `Rewrite this ${$('p_platform').value} caption with a fresh angle in the brand voice. Return only the caption:\n\n${orig}` })
    });
    if (res.status === 402) { openPay(); $('p_caption').value = orig; return; }
    const d = await res.json();
    if (d.text) { $('p_caption').value = d.text; if (!d.subscribed) demoBump(); }
    else $('p_caption').value = orig;
  } catch { $('p_caption').value = orig; toast('Rewrite failed.'); }
}

function copyPostText() {
  const text = ($('p_hook').value ? $('p_hook').value + '\n\n' : '') + $('p_caption').value + '\n\n' + $('p_hashtags').value;
  navigator.clipboard.writeText(text.trim()); toast('Copied.');
}

async function cyclePostStatus(id) {
  const p = posts.find(x => x.id === id); if (!p) return;
  const order = ['draft','scheduled','posted'];
  p.status = order[(order.indexOf(p.status) + 1) % order.length];
  await Storage.savePost(p);
  router(); refreshSidebar();
}
function copyPostById(id) {
  const p = posts.find(x => x.id === id); if (!p) return;
  const t = (p.hook ? p.hook + '\n\n' : '') + (p.caption || '') + (p.hashtags?.length ? '\n\n' + p.hashtags.join(' ') : '');
  navigator.clipboard.writeText(t.trim()); toast('Post copied.');
}

/* ============================================================
   VIEW: IDEAS (AI content idea generator)
   ============================================================ */
let cachedIdeas = [];

function renderIdeas() {
  $('main').innerHTML = `
    <p class="intro" style="margin-bottom:18px">Get 10 fresh content ideas tailored to your active brand. Click any idea to turn it into a draft post in the library.</p>
    <div class="builder" style="margin-top:0">
      <label class="fld">Optional: focus theme (leave blank for a mix)</label>
      <input class="t" id="ideaTheme" placeholder="e.g. summer launch, customer wins, behind the scenes">
      <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn primary" id="ideaBtn" onclick="STMZ.runIdeas()">✦ Generate 10 ideas</button>
        <span class="quota" id="ideaStatus"></span>
      </div>
    </div>
    <div id="ideaResults">${cachedIdeas.length ? renderIdeaCards(cachedIdeas) : ''}</div>
  `;
}

function renderIdeaCards(ideas) {
  return `<div class="ideas-grid">${ideas.map((idea, i) => `
    <div class="idea-card">
      <div class="ix">IDEA ${String(i+1).padStart(2,'0')}</div>
      <h4>${esc(idea.title || '(no title)')}</h4>
      <div class="angle">${esc(idea.angle || '')}</div>
      <div class="meta">${idea.platform_hint?`<span>${esc(idea.platform_hint)}</span>`:''}${idea.format?`<span>· ${esc(idea.format)}</span>`:''}</div>
      <div class="acts">
        <button onclick="STMZ.ideaToPost(${i})">⚡ Make into post</button>
        <button onclick="STMZ.copyIdea(${i})">⧉ Copy</button>
      </div>
    </div>`).join('')}
  </div>`;
}

async function runIdeas() {
  const brand = activeBrand();
  if (!brand) { toast('Create a brand first.'); newBrand(); return; }
  if (!canRun()) return;
  const btn = $('ideaBtn'); btn.disabled = true;
  $('ideaStatus').textContent = 'Generating fresh ideas…';
  try {
    const token = await authToken();
    const r = await fetch('/api/ideas', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) },
      body: JSON.stringify({ brand, theme: $('ideaTheme').value.trim() })
    });
    if (r.status === 402) { openPay(); throw new Error('limit'); }
    if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.message || 'AI is busy.'); }
    const data = await r.json();
    if (!data.subscribed) demoBump();
    cachedIdeas = data.ideas || [];
    $('ideaStatus').textContent = `${cachedIdeas.length} ideas via ${data.provider}`;
    $('ideaResults').innerHTML = renderIdeaCards(cachedIdeas);
  } catch (err) {
    if (err.message !== 'limit') { $('ideaStatus').textContent = err.message; }
  } finally { btn.disabled = false; }
}

async function ideaToPost(i) {
  const idea = cachedIdeas[i]; const brand = activeBrand();
  if (!idea || !brand) return;
  const newPost = {
    brandId: brand.id,
    platform: idea.platform_hint || 'Instagram',
    hook: idea.title || '',
    caption: idea.angle || '',
    hashtags: [],
    cta: '',
    imagePrompt: idea.title || '',
    stockQuery: idea.stockQuery || idea.title || '',
    imageUrl: await resolvePostImage(idea.stockQuery || idea.title, idea.title || idea.angle),
    status: 'draft',
    scheduledAt: Date.now() + 24*60*60*1000,
  };
  const saved = await Storage.savePost(newPost);
  posts = [saved, ...posts];
  refreshSidebar();
  toast('Idea saved to library as a draft.');
  editPost(saved.id);
}

function copyIdea(i) {
  const idea = cachedIdeas[i]; if (!idea) return;
  navigator.clipboard.writeText(`${idea.title}\n${idea.angle}`); toast('Idea copied.');
}

/* ============================================================
   VIEW: ASSISTANT (chat with brand context)
   ============================================================ */
const chatHistory = [];

function renderAssistant() {
  const brand = activeBrand();
  const brandLine = brand ? `Talking with your brand <span class="signal">${esc(brand.name)}</span> in context.` : 'No active brand — answers will be generic until you add one.';
  $('main').innerHTML = `
    <div class="chat-wrap">
      <p class="intro">${brandLine} Ask anything — planning a campaign, what to post next, how to handle a tricky reply, copy tweaks. Your messages stay in this browser.</p>
      <div class="chat-window" id="chatWindow">${
        chatHistory.length
          ? chatHistory.map(m => `<div class="chat-msg ${m.role==='user'?'u':'a'}">${esc(m.text)}</div>`).join('')
          : `<div class="chat-empty"><div class="ico">◑</div><b>Start the conversation</b><br><span>Try: "Give me 3 post ideas for a summer sale"</span></div>`
      }</div>
      <div class="chat-input-row">
        <textarea class="t" id="chatInput" placeholder="Type a message — Enter to send, Shift+Enter for newline" onkeydown="if(event.key==='Enter'&amp;&amp;!event.shiftKey){event.preventDefault();STMZ.sendChat()}"></textarea>
        <button class="btn primary" onclick="STMZ.sendChat()">Send</button>
      </div>
    </div>`;
  const w = $('chatWindow'); w.scrollTop = w.scrollHeight;
}

async function sendChat() {
  const inp = $('chatInput'); const text = inp.value.trim(); if (!text) return;
  if (!canRun()) return;
  const w = $('chatWindow');
  if (w.querySelector('.chat-empty')) w.innerHTML = '';
  const uMsg = document.createElement('div'); uMsg.className = 'chat-msg u'; uMsg.textContent = text;
  w.appendChild(uMsg);
  chatHistory.push({ role:'user', text });
  inp.value = '';
  const tMsg = document.createElement('div'); tMsg.className = 'chat-msg a thinking'; tMsg.textContent = 'thinking…';
  w.appendChild(tMsg); w.scrollTop = w.scrollHeight;
  try {
    const brand = activeBrand();
    const context = brand
      ? `BRAND CONTEXT — Name: ${brand.name}. Sells: ${brand.what}. Audience: ${brand.audience}. Voice: ${brand.tone}. Offer: ${brand.offer}.\n\nRECENT CONVERSATION:\n${chatHistory.slice(-8).map(m=>`${m.role}: ${m.text}`).join('\n')}`
      : `RECENT CONVERSATION:\n${chatHistory.slice(-8).map(m=>`${m.role}: ${m.text}`).join('\n')}`;
    const token = await authToken();
    const r = await fetch('/api/generate', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) },
      body: JSON.stringify({ tool:'assistant', context, prompt: text })
    });
    if (r.status === 402) { tMsg.remove(); openPay(); return; }
    const d = await r.json();
    if (d.text) {
      tMsg.classList.remove('thinking'); tMsg.textContent = d.text;
      chatHistory.push({ role:'assistant', text: d.text });
      if (!d.subscribed) demoBump();
    } else {
      tMsg.classList.remove('thinking'); tMsg.textContent = '(no response — try again)';
    }
    w.scrollTop = w.scrollHeight;
  } catch (err) {
    tMsg.classList.remove('thinking'); tMsg.textContent = 'Error: ' + err.message;
  }
}

/* ============================================================
   VIEW: INTEGRATIONS (LinkedIn OAuth + webhook URL)
   ============================================================ */
let integrations = {};

async function loadIntegrations() {
  try { integrations = await Storage.getIntegrations() || {}; } catch { integrations = {}; }
}

function renderIntegrations() {
  // Flash messages from OAuth callback redirects
  const flash = location.search.includes('linkedin=ok') ? 'LinkedIn connected ✓'
              : location.search.includes('linkedin=error') ? 'LinkedIn connection failed. Try again.' : '';
  if (flash) {
    toast(flash);
    history.replaceState({}, '', location.pathname + location.hash);
    loadIntegrations().then(renderIntegrations);
    return;
  }

  const li = integrations.linkedin;
  const wh = integrations.webhookUrl;
  const expiresWarning = li?.expiresAt && Date.now() > li.expiresAt - 3*24*60*60*1000
    ? '<p style="color:var(--danger);font-size:12px;margin-top:6px">Token expires soon — reconnect.</p>' : '';

  $('main').innerHTML = `
    <p class="intro" style="margin-bottom:22px">Connect destinations once and STMZ Kinetic posts on your schedule. <b>LinkedIn</b> posts directly. The <b>universal webhook</b> handles everything else through Make.com, Zapier, n8n, or your own backend — Instagram, TikTok, X, Facebook, WhatsApp, anywhere you have an account.</p>

    <div class="integ-grid">

      <div class="integ-card">
        <div class="head">
          <h3>in &nbsp;LinkedIn — direct posting</h3>
          <span class="integ-status ${li?'connected':'disconnected'}">${li?'connected':'not connected'}</span>
        </div>
        <div class="desc">Connect once. Every LinkedIn post you schedule publishes straight to your feed at the right time. No copy-paste, no third-party app.</div>
        ${li ? `
          <div style="font-family:var(--mono);font-size:11px;color:var(--ink-dim);margin-bottom:14px">
            Connected as <b class="signal">${esc(li.name || li.email || 'LinkedIn user')}</b><br>
            Connected ${fmtDate(li.connectedAt)} · expires ${fmtDate(li.expiresAt)}
            ${expiresWarning}
          </div>
          <div class="integ-actions">
            <button class="btn sm" onclick="STMZ.linkedinDisconnect()">Disconnect</button>
          </div>` : `
          <div class="integ-actions">
            <button class="btn primary sm" onclick="STMZ.linkedinConnect()">⇡ Connect LinkedIn</button>
          </div>`}
        <div class="integ-help">
          Sign-in opens LinkedIn's own login screen. Your password never touches our servers. Disconnect any time.
        </div>
      </div>

      <div class="integ-card">
        <div class="head">
          <h3>✈ &nbsp;Telegram — direct posting</h3>
          <span class="integ-status ${integrations.telegram?'connected':'disconnected'}">${integrations.telegram?'connected':'not connected'}</span>
        </div>
        <div class="desc">Post to a Telegram channel, group or chat directly through your own bot. Free, takes 30 seconds to set up — no OAuth window, no approvals, no fees.</div>
        ${integrations.telegram ? `
          <div style="font-family:var(--mono);font-size:11px;color:var(--ink-dim);margin-bottom:14px">
            Bot connected · chat <b class="signal">${esc(integrations.telegram.chatId || '')}</b><br>
            Connected ${fmtDate(integrations.telegram.connectedAt)}
          </div>
          <div class="integ-actions">
            <button class="btn primary sm" onclick="STMZ.tgTest()">Send test message</button>
            <button class="btn sm" onclick="STMZ.tgDisconnect()" style="color:var(--danger);border-color:var(--danger)">Disconnect</button>
          </div>` : `
          <div class="integ-actions" style="flex-direction:column;align-items:stretch">
            <input class="t" id="tgBotToken" placeholder="Bot token from @BotFather (123456:ABC-DEF…)">
            <input class="t" id="tgChatId" placeholder="Chat ID — channel @username or numeric ID">
            <div style="display:flex;gap:6px">
              <button class="btn primary sm" onclick="STMZ.tgSave()">Save &amp; connect</button>
              <button class="btn sm" onclick="STMZ.tgHelp()">How to get these</button>
            </div>
          </div>`}
        <div class="integ-help">
          ${integrations.telegram ? 'Your bot will post here every time you schedule a Telegram post in the library, or AutoPilot runs.' : 'Telegram allows direct bot posting — no app review like Instagram/TikTok/Facebook need.'}
        </div>
      </div>

      <div class="integ-card">
        <div class="head">
          <h3>⇄ &nbsp;Connect everything else (Instagram, TikTok, Facebook, YouTube, X…)</h3>
          <span class="integ-status ${wh?'connected':'disconnected'}">${wh?'connected':'not connected'}</span>
        </div>
        <div class="desc">Instagram, TikTok, Facebook Pages, YouTube Shorts and WhatsApp each require Meta / TikTok app-review approval that takes 6–12 weeks — there is no realistic shortcut. The pragmatic path: one free <a class="signal" href="https://www.make.com" target="_blank" rel="noopener">Make.com</a> webhook routes to all of them. (This is how Buffer / Hootsuite started too.)</div>

        <div class="oneclick-box">
          <div class="oneclick-head"><span class="oneclick-badge">FASTEST</span> 1-click setup — we built the automation for you</div>
          <p class="oneclick-sub">Don't want to build anything manually? Click below. It opens our ready-made Make.com automation — you just sign in, connect your social accounts, and turn it on. Takes about 2 minutes.</p>
          <a class="btn primary" id="oneClickBtn" href="${MAKE_TEMPLATE_URL}" target="_blank" rel="noopener" onclick="STMZ.oneClickConnect(event)">⚡ Set up auto-posting in 1 click →</a>
          <p class="oneclick-note">After it opens: sign into Make.com (free) → connect Facebook/Instagram → copy the webhook URL it shows → paste it below → Save. <a class="signal" href="#" onclick="STMZ.showWebhookHelp();return false">Full guide →</a></p>
        </div>

        <div class="integ-actions" style="flex-direction:column;align-items:stretch">
          <label class="fld" style="margin-top:4px">Or paste your webhook URL manually</label>
          <input class="t" id="webhookInput" value="${esc(wh || '')}" placeholder="Paste your Make.com / Zapier link here…">
          <div style="display:flex;gap:6px">
            <button class="btn primary sm" onclick="STMZ.saveWebhook()">Save</button>
            <button class="btn sm" onclick="STMZ.testWebhook()">Send test</button>
            ${wh?`<button class="btn sm" onclick="STMZ.clearWebhook()" style="color:var(--danger);border-color:var(--danger)">Remove</button>`:''}
          </div>
        </div>
        <div class="integ-help">
          <b>Don't have a Make.com account yet?</b> It takes 5 minutes to set up — free, 1,000 actions a month included. <a class="signal" href="#" onclick="STMZ.showWebhookHelp();return false">Step-by-step guide →</a>
        </div>
      </div>

      <div class="integ-card">
        <div class="head">
          <h3>↗ &nbsp;Manual share (no setup)</h3>
          <span class="integ-status connected">always on</span>
        </div>
        <div class="desc">Every post has a one-tap share button — to Twitter, LinkedIn, Facebook, WhatsApp, Telegram, or your phone's native share sheet (which opens Instagram, TikTok, anything installed).</div>
        <div class="integ-actions">
          <a class="btn sm" href="#/library">Open library →</a>
        </div>
        <div class="integ-help">Best when you want manual control over every post. No setup required.</div>
      </div>

    </div>
  `;
}

async function linkedinConnect() {
  if (!user) { toast('Sign in first.'); await login(); if (!user) return; }
  const token = await authToken();
  if (!token) { toast('Could not get auth token.'); return; }
  window.location.href = `/api/linkedin/connect?token=${encodeURIComponent(token)}`;
}

async function linkedinDisconnect() {
  if (!confirm('Disconnect LinkedIn? Scheduled LinkedIn posts will stop auto-posting until you reconnect.')) return;
  const token = await authToken();
  await fetch('/api/linkedin/disconnect', { method:'POST', headers:{ Authorization:'Bearer '+token, 'Content-Type':'application/json' } });
  await loadIntegrations(); renderIntegrations(); toast('LinkedIn disconnected.');
}

/* 1-click auto-posting: opens the pre-built Make.com template in a new tab
   and nudges the user to paste back the webhook URL when they return. */
function oneClickConnect(e) {
  if (!canUseWebhook()) {
    if (e) e.preventDefault();
    showUpgradePrompt('Auto-posting to Instagram / TikTok / Facebook (via Make.com) is included on Pro and Agency. Upgrade to enable.');
    return;
  }
  toast('Make.com is opening in a new tab — sign in, connect your accounts, then paste the webhook URL back here.');
  setTimeout(() => {
    const inp = $('webhookInput');
    if (inp) { inp.focus(); inp.scrollIntoView({ behavior:'smooth', block:'center' }); }
  }, 1200);
}

async function saveWebhook() {
  if (!canUseWebhook()) {
    showUpgradePrompt('Universal webhook (Instagram / TikTok / Facebook routing via Make.com) is included on Pro and Agency. Upgrade to enable.');
    return;
  }
  const url = $('webhookInput').value.trim();
  if (url && !/^https?:\/\//.test(url)) { toast('URL must start with https:// or http://'); return; }
  integrations.webhookUrl = url || null;
  await Storage.setIntegration('webhookUrl', url || null);
  renderIntegrations();
  toast(url ? 'Webhook saved.' : 'Webhook cleared.');
}

async function clearWebhook() {
  integrations.webhookUrl = null;
  await Storage.setIntegration('webhookUrl', null);
  renderIntegrations();
  toast('Webhook cleared.');
}

async function testWebhook() {
  const url = $('webhookInput').value.trim();
  if (!url) { toast('Enter a URL first.'); return; }
  if (!user) { toast('Sign in to use the test endpoint.'); return; }
  toast('Sending test event…');
  try {
    const token = await authToken();
    const r = await fetch('/api/integrations/test-webhook', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+token },
      body: JSON.stringify({ url }),
    });
    const d = await r.json();
    toast(d.ok ? 'Test sent ✓ — check your Make/Zapier' : ('Failed: ' + (d.message || 'unknown')));
  } catch { toast('Test failed.'); }
}

/* ============ TELEGRAM direct posting (bot token, no OAuth) ============ */
async function tgSave() {
  const botToken = $('tgBotToken')?.value.trim() || '';
  const chatId = $('tgChatId')?.value.trim() || '';
  if (!botToken || !chatId) { toast('Bot token AND chat ID required.'); return; }
  if (!user) { toast('Sign in first.'); return; }
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    toast('That doesn\'t look like a Bot token. It should look like 123456789:ABC-DEF…'); return;
  }
  try {
    const token = await authToken();
    const r = await fetch('/api/telegram/save', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+token },
      body: JSON.stringify({ botToken, chatId }),
    });
    const d = await r.json();
    if (d.ok) {
      integrations.telegram = { botToken, chatId, connectedAt: Date.now() };
      toast('Telegram connected ✓');
      renderIntegrations();
    } else { toast('Failed: ' + (d.error || 'unknown')); }
  } catch (e) { toast('Failed: ' + e.message); }
}

async function tgDisconnect() {
  if (!user) return;
  if (!confirm('Disconnect Telegram? Your bot token will be removed from your account.')) return;
  try {
    const token = await authToken();
    await fetch('/api/telegram/disconnect', {
      method:'POST',
      headers:{ Authorization:'Bearer '+token },
    });
    integrations.telegram = null;
    renderIntegrations();
    toast('Telegram disconnected.');
  } catch { toast('Disconnect failed.'); }
}

async function tgTest() {
  if (!user || !integrations.telegram) { toast('Connect Telegram first.'); return; }
  toast('Sending test…');
  try {
    const token = await authToken();
    const r = await fetch('/api/telegram/test', {
      method:'POST',
      headers:{ Authorization:'Bearer '+token },
    });
    const d = await r.json();
    toast(d.ok ? 'Test sent ✓ — check your Telegram' : ('Failed: ' + (d.message || d.error || 'unknown')));
  } catch { toast('Test failed.'); }
}

function tgHelp() {
  const m = document.createElement('div');
  m.className = 'modal-bg show';
  m.id = '_tgHelp';
  m.innerHTML = `
    <div class="modal" style="max-width:560px">
      <span class="x" onclick="document.getElementById('_tgHelp').remove()">✕ close</span>
      <h3>Connect Telegram in 4 steps</h3>
      <p style="color:var(--ink-dim);font-size:14px;line-height:1.55;margin-top:10px">Telegram is the only major platform besides LinkedIn that allows direct posting without weeks of approvals. Setup takes 1 minute.</p>
      <ol style="padding-left:20px;font-size:13.5px;line-height:1.7;color:var(--ink);margin-top:14px">
        <li>Open Telegram. Search for <b>@BotFather</b> (official, verified).</li>
        <li>Send <code>/newbot</code>, give it a name and a username ending in <code>bot</code>. BotFather replies with a <b>bot token</b> like <code>123456789:ABCDEF-ghi…</code> — copy it.</li>
        <li>Add your bot to the channel or group where you want posts to appear. Make it an <b>admin</b> with "Post messages" permission.</li>
        <li>For the <b>Chat ID</b>: if it's a public channel, use <code>@yourchannel</code>. If private/group, send a message in it, then visit <code>https://api.telegram.org/bot&lt;YOUR_TOKEN&gt;/getUpdates</code> and look for the chat <code>id</code> number.</li>
      </ol>
      <p style="color:var(--ink-dim);font-size:13px;line-height:1.55;margin-top:14px">Paste both into the fields and click <b>Save &amp; connect</b>. Then schedule a post with platform set to "Telegram" and it'll publish at the scheduled time.</p>
      <button class="btn primary" style="width:100%;margin-top:14px" onclick="document.getElementById('_tgHelp').remove()">Got it</button>
    </div>`;
  document.body.appendChild(m);
}

/* In-app guide for non-technical users: no repo references, no JSON shapes,
   just the 5 steps to wire Make.com to STMZ in plain English. */
function showWebhookHelp() {
  const m = document.createElement('div');
  m.className = 'modal-bg show';
  m.id = '_whHelp';
  m.innerHTML = `
    <div class="modal" style="max-width:720px">
      <span class="x" onclick="document.getElementById('_whHelp').remove()">✕ close</span>
      <h3>Connect Instagram, TikTok, Facebook, YouTube — step by step</h3>
      <p style="color:var(--ink-dim);font-size:14px;line-height:1.55">One Make.com scenario can route to <b>every</b> platform you use. Free tier (1,000 ops/month) is enough for ~30 posts/day across all your accounts.</p>

      <ol style="padding-left:20px;font-size:13.5px;line-height:1.7;color:var(--ink);margin-top:14px">
        <li><b>Sign up at <a class="signal" href="https://www.make.com" target="_blank" rel="noopener">make.com</a></b> — free, no card.</li>
        <li>Click <b>Create a new scenario</b>. Search <b>Webhooks</b>, pick <b>Custom webhook</b>. Click <b>Add</b>, name it "STMZ", click <b>Save &amp; Copy the URL</b>.</li>
        <li><b>Paste that URL</b> in the field on the previous page → <b>Save</b> → <b>Send test</b>. Make.com will show "Successfully determined" — that means it's connected and now knows what your data looks like.</li>
        <li>In Make.com, click the <b>+</b> after the webhook to add the platform you want to post to. For each, map the fields shown below:</li>
      </ol>

      <div style="background:var(--bg-2);border:1px solid var(--line);border-radius:8px;padding:14px 18px;margin-top:14px;font-family:var(--mono);font-size:11.5px;line-height:1.7">
        <div style="color:var(--signal);margin-bottom:8px"><b>What gets sent in every webhook call:</b></div>
        <code>title</code>, <code>caption</code>, <code>hashtags</code>, <code>hashtagString</code>, <code>cta</code>,
        <code>imageUrl</code>, <code>videoUrl</code>, <code>platform</code>, <code>scheduledAt</code>,
        <code>brand.name</code>, plus pre-formatted blocks per platform (mapped below).
      </div>

      <div style="margin-top:18px">
        <div style="font-family:var(--display);font-size:14px;color:var(--signal);margin-bottom:8px"><b>Field maps for each platform:</b></div>

        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <tr style="border-bottom:1px solid var(--line)">
            <td style="padding:8px 6px;color:var(--ink);width:130px"><b>Instagram for Business</b><br><small style="color:var(--ink-faint)">via Make module</small></td>
            <td style="padding:8px 6px;color:var(--ink-dim)">Caption → <code style="font-family:var(--mono)">instagram.caption</code><br>Image URL → <code style="font-family:var(--mono)">instagram.mediaUrl</code> <i style="color:var(--ink-faint)">(or videoUrl for Reels)</i></td>
          </tr>
          <tr style="border-bottom:1px solid var(--line)">
            <td style="padding:8px 6px;color:var(--ink)"><b>TikTok</b><br><small style="color:var(--ink-faint)">via Make module</small></td>
            <td style="padding:8px 6px;color:var(--ink-dim)">Description → <code style="font-family:var(--mono)">tiktok.description</code><br>Video URL → <code style="font-family:var(--mono)">tiktok.videoUrl</code></td>
          </tr>
          <tr style="border-bottom:1px solid var(--line)">
            <td style="padding:8px 6px;color:var(--ink)"><b>Facebook Pages</b><br><small style="color:var(--ink-faint)">via Make module</small></td>
            <td style="padding:8px 6px;color:var(--ink-dim)">Message → <code style="font-family:var(--mono)">facebook.message</code><br>Link/Image → <code style="font-family:var(--mono)">facebook.linkOrImage</code></td>
          </tr>
          <tr style="border-bottom:1px solid var(--line)">
            <td style="padding:8px 6px;color:var(--ink)"><b>YouTube Shorts</b><br><small style="color:var(--ink-faint)">via Make module</small></td>
            <td style="padding:8px 6px;color:var(--ink-dim)">Title → <code style="font-family:var(--mono)">youtubeShorts.title</code><br>Description → <code style="font-family:var(--mono)">youtubeShorts.description</code><br>Tags → <code style="font-family:var(--mono)">youtubeShorts.tags</code><br>Video → <code style="font-family:var(--mono)">youtubeShorts.videoUrl</code></td>
          </tr>
          <tr style="border-bottom:1px solid var(--line)">
            <td style="padding:8px 6px;color:var(--ink)"><b>X / Twitter</b><br><small style="color:var(--ink-faint)">via Make module</small></td>
            <td style="padding:8px 6px;color:var(--ink-dim)">Tweet text → <code style="font-family:var(--mono)">twitterX.text</code></td>
          </tr>
          <tr style="border-bottom:1px solid var(--line)">
            <td style="padding:8px 6px;color:var(--ink)"><b>Threads / Pinterest</b></td>
            <td style="padding:8px 6px;color:var(--ink-dim)"><code style="font-family:var(--mono)">threads.text</code> · <code style="font-family:var(--mono)">pinterest.title</code> + <code style="font-family:var(--mono)">pinterest.description</code></td>
          </tr>
          <tr>
            <td style="padding:8px 6px;color:var(--ink)"><b>Anywhere else</b></td>
            <td style="padding:8px 6px;color:var(--ink-dim)">Use the raw fields — <code style="font-family:var(--mono)">title</code>, <code style="font-family:var(--mono)">caption</code>, <code style="font-family:var(--mono)">hashtagString</code>, <code style="font-family:var(--mono)">imageUrl</code>, <code style="font-family:var(--mono)">videoUrl</code>, etc.</td>
          </tr>
        </table>
      </div>

      <div style="background:rgba(189,243,109,0.07);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-top:18px">
        <p style="font-size:13px;line-height:1.55;margin:0"><b class="signal">Route multiple platforms from one scenario:</b> add a <b>Router</b> module after the webhook in Make.com. Set a filter on each branch — for example, branch 1 fires if <code style="font-family:var(--mono)">platform = instagram</code>, branch 2 if <code style="font-family:var(--mono)">platform = tiktok</code>, etc. STMZ Kinetic puts the platform name in every payload so routing is automatic.</p>
      </div>

      <ol style="padding-left:20px;font-size:13.5px;line-height:1.7;color:var(--ink);margin-top:18px">
        <li value="5"><b>Turn the scenario ON</b> in Make.com (top-right toggle).</li>
        <li>Done. Every scheduled or AutoPilot post in STMZ Kinetic flows to your platforms at the right time.</li>
      </ol>

      <button class="btn primary" style="width:100%;margin-top:18px" onclick="document.getElementById('_whHelp').remove()">Got it</button>
    </div>`;
  document.body.appendChild(m);
}

/* ============================================================
   SHARE — Web Share API on mobile, deep links on desktop
   ============================================================ */
function buildPostText() {
  const hook = $('p_hook').value.trim();
  const cap = $('p_caption').value.trim();
  const tags = $('p_hashtags').value.trim();
  return [hook, cap, tags].filter(Boolean).join('\n\n');
}

async function shareNative() {
  const text = buildPostText();
  if (!text) { toast('Nothing to share yet.'); return; }
  if (navigator.share) {
    try { await navigator.share({ text, url: location.origin }); toast('Shared.'); }
    catch (e) { if (e.name !== 'AbortError') console.warn(e); }
  } else {
    navigator.clipboard.writeText(text);
    toast('Web Share not available — copied to clipboard.');
  }
}

function shareTo(platform) {
  const text = buildPostText(); if (!text) { toast('Nothing to share yet.'); return; }
  const enc = encodeURIComponent(text);
  const url = encodeURIComponent(location.origin);
  let target = '';
  switch (platform) {
    case 'twitter':  target = `https://twitter.com/intent/tweet?text=${enc}`; break;
    case 'linkedin': target = `https://www.linkedin.com/sharing/share-offsite/?url=${url}&summary=${enc}`; break;
    case 'facebook': target = `https://www.facebook.com/sharer/sharer.php?u=${url}&quote=${enc}`; break;
    case 'whatsapp': target = `https://wa.me/?text=${enc}`; break;
    case 'telegram': target = `https://t.me/share/url?url=${url}&text=${enc}`; break;
    default: return;
  }
  window.open(target, '_blank', 'noopener,width=720,height=640');
}

async function postToLinkedIn() {
  if (!editingPostId) return;
  const p = posts.find(x => x.id === editingPostId); if (!p) return;
  if (!integrations.linkedin) { toast('Connect LinkedIn first.'); location.hash = '#/integrations'; closePost(); return; }
  toast('Queuing for immediate posting…');
  p.platform = 'LinkedIn';
  p.scheduledAt = Date.now() - 1000;
  p.status = 'scheduled';
  await Storage.savePost(p);
  toast('Queued — the scheduler will fire within ~60 seconds.');
  closePost();
}

async function shareViaWebhook() {
  if (!integrations.webhookUrl) { toast('Set a webhook URL first (Connect tab).'); return; }
  if (!editingPostId) return;
  const p = posts.find(x => x.id === editingPostId); if (!p) return;
  p.scheduledAt = Date.now() - 1000;
  p.status = 'scheduled';
  await Storage.savePost(p);
  toast('Queued for webhook firing within ~60 seconds.');
  closePost();
}

/* ============================================================
   VIDEO MAKER — Canvas + MediaRecorder, no third-party service
   ============================================================ */
function openVideoModal() {
  if (!editingPostId) { toast('Open a post first, then click Make video.'); return; }
  $('v_status').textContent = '';
  $('v_prog').style.display = 'none';
  $('v_bar').style.width = '0%';
  $('v_makeBtn').disabled = false;
  $('v_makeBtn').textContent = '▶ Generate video';
  $('videoModal').classList.add('show');
}
function closeVideoModal() { $('videoModal').classList.remove('show'); }

async function makeVideo() {
  const p = posts.find(x => x.id === editingPostId);
  if (!p) { toast('Post not found.'); return; }
  const [w, h] = $('v_size').value.split('x').map(Number);
  const secs = parseInt($('v_secs').value, 10);
  const btn = $('v_makeBtn');
  btn.disabled = true; btn.textContent = '⏳ Rendering…';
  $('v_prog').style.display = 'block';
  $('v_status').textContent = `Rendering ${secs}s at ${w}×${h}…`;
  try {
    const blob = await generatePostVideo({
      post: {
        hook: p.hook,
        caption: p.caption,
        hashtags: p.hashtags || [],
        imageUrl: p.imageUrl,
      },
      size: { w, h },
      seconds: secs,
      onProgress: (t) => { $('v_bar').style.width = (t * 100).toFixed(0) + '%'; },
    });
    const safeName = (p.hook || 'stmz-video').toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,40).replace(/^-|-$/g,'') || 'stmz-video';
    downloadBlob(blob, `${safeName}-${w}x${h}.webm`);
    $('v_status').textContent = `✓ Done · ${(blob.size/1024/1024).toFixed(1)} MB · downloaded`;
    btn.textContent = '↻ Generate again';
    btn.disabled = false;
    toast('Video downloaded. Open in your photos or upload to your scheduler.');
  } catch (err) {
    console.error(err);
    $('v_status').textContent = 'Failed: ' + err.message;
    btn.disabled = false; btn.textContent = '▶ Generate video';
  }
}

/* ============================================================
   V7: REPLY ASSISTANT — paste a comment/DM → 3 brand-voiced replies
   ============================================================ */
let _replyResult = null;

function renderReplyAssistant() {
  $('main').innerHTML = `
    <p class="intro" style="margin-bottom:18px">Paste any comment, DM, or email and get three reply options written in your brand voice. Click one to copy it — done in 10 seconds, not 10 minutes.</p>
    <div class="builder" style="margin-top:0">
      <label class="fld">The message you received</label>
      <textarea class="t" id="rply_msg" rows="5" placeholder="Paste the comment, DM, email or review you need to reply to. Any language."></textarea>
      <div class="row" style="margin-top:14px">
        <div style="grid-column:1/-1">
          <label class="fld">Reply tone</label>
          <select class="t" id="rply_tone">
            <option value="warm">Warm — kind, human</option>
            <option value="direct">Direct — quick, no fluff</option>
            <option value="witty">Witty — light humour</option>
            <option value="apologetic">Apologetic — for complaints</option>
            <option value="sales">Sales-y — move toward booking/buying</option>
          </select>
        </div>
      </div>
      <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn primary" id="rplyBtn" onclick="STMZ.runReply()">↩ Generate 3 replies</button>
        <span class="quota" id="rply_status"></span>
      </div>
    </div>
    <div id="rply_results">${_replyResult ? renderReplyResult(_replyResult) : ''}</div>
  `;
}

function renderReplyResult(d) {
  const intentLabel = ({ question:'❓ Question', praise:'❤ Praise', complaint:'⚠ Complaint', 'sales-lead':'🎯 Sales lead', troll:'🛑 Troll', other:'• Other' })[d.intent] || '•';
  return `
    <div class="section-title" style="margin-top:28px">Detected intent <small style="font-family:var(--mono);color:var(--ink-faint);font-size:11px">${intentLabel}</small></div>
    <div class="reply-grid">
      ${(d.replies || []).map((r, i) => `
        <div class="reply-card">
          <div class="rlbl">${esc(r.label || 'Option '+(i+1))}</div>
          <div class="rtext">${esc(r.text || '')}</div>
          <div class="racts">
            <button class="btn sm primary" onclick="STMZ.copyReply(${i})">⧉ Copy &amp; use</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function runReply() {
  const msg = $('rply_msg').value.trim();
  if (!msg) { toast('Paste the message first.'); return; }
  if (!canRun()) return;
  const btn = $('rplyBtn'); btn.disabled = true;
  $('rply_status').textContent = 'Writing replies…';
  try {
    const token = await authToken();
    const r = await fetch('/api/reply', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) },
      body: JSON.stringify({ message: msg, brand: (activeBrand() || {}), tone: $('rply_tone').value }),
    });
    if (r.status === 402) { openPay(); throw new Error('limit'); }
    if (!r.ok) throw new Error('AI is busy.');
    const data = await r.json();
    if (!data.subscribed) demoBump();
    _replyResult = data;
    $('rply_status').textContent = `Ready · ${data.replies?.length || 0} options · via ${data.provider}`;
    $('rply_results').innerHTML = renderReplyResult(data);
  } catch (err) {
    if (err.message !== 'limit') $('rply_status').textContent = err.message;
  } finally { btn.disabled = false; }
}

function copyReply(i) {
  const r = _replyResult?.replies?.[i]; if (!r) return;
  navigator.clipboard.writeText(r.text);
  toast('Reply copied — paste it into the platform.');
}

/* ============================================================
   V7: ANALYTICS — what's working for this brand, with AI insights
   ============================================================ */
let _insights = null;

/* ============================================================
   VIEW: BEST TIME TO POST — posting-time heatmap + AI month plan
   ============================================================ */

// Research-backed best posting windows per platform (local time, by weekday).
// These are sensible defaults every scheduler uses; we refine with the user's
// own performance data when they have enough measured posts.
const BEST_TIMES = {
  Instagram: { label:'Instagram', best:['Mon 11:00','Tue 13:00','Wed 11:00','Thu 13:00','Fri 11:00','Sat 10:00','Sun 16:00'], peakHours:[11,13,19] },
  LinkedIn:  { label:'LinkedIn',  best:['Tue 09:00','Tue 11:00','Wed 09:00','Wed 12:00','Thu 09:00','Thu 11:00'],            peakHours:[8,10,12] },
  TikTok:    { label:'TikTok',    best:['Tue 18:00','Wed 19:00','Thu 18:00','Fri 19:00','Sat 11:00','Sun 16:00'],            peakHours:[18,19,21] },
  Facebook:  { label:'Facebook',  best:['Mon 13:00','Wed 13:00','Thu 13:00','Fri 14:00','Sat 12:00'],                       peakHours:[9,13,15] },
  'X / Twitter': { label:'X / Twitter', best:['Mon 09:00','Tue 12:00','Wed 09:00','Thu 12:00','Fri 09:00'],                 peakHours:[8,12,17] },
  Telegram:  { label:'Telegram',  best:['Mon 20:00','Wed 20:00','Fri 21:00','Sun 19:00'],                                   peakHours:[12,20,21] },
};
const WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// Derive the best hour for a platform — uses the user's own top-performing
// posts if they've logged enough engagement, otherwise the research defaults.
function bestHourFor(platform, brandId) {
  const def = BEST_TIMES[platform] || BEST_TIMES.Instagram;
  const measured = posts.filter(p =>
    p.brandId === brandId && p.platform === platform && p.status === 'posted' &&
    p.performance && p.scheduledAt &&
    ((p.performance.likes||0)+(p.performance.comments||0)+(p.performance.shares||0)) > 0
  );
  if (measured.length >= 4) {
    // Find the hour band that earned the most engagement for THIS user
    const byHour = {};
    measured.forEach(p => {
      const h = new Date(p.scheduledAt).getHours();
      const s = (p.performance.likes||0)+(p.performance.comments||0)*2+(p.performance.shares||0)*3;
      byHour[h] = (byHour[h]||0) + s;
    });
    const top = Object.entries(byHour).sort((a,b)=>b[1]-a[1])[0];
    if (top) return { hour: parseInt(top[0],10), source:'your data' };
  }
  return { hour: def.peakHours[1] ?? 12, source:'proven benchmarks' };
}

/* ============================================================
   VIEW: 30-DAY CONTENT PLAN
   One click → a full month of strategically-balanced posts,
   auto-scheduled across 30 days at each platform's best time.
   Reuses /api/campaign (no server change) + the BEST_TIMES table.
   ============================================================ */

const CONTENT_MIX = [
  { key:'educational', label:'Educational / How-to', pct:0.30, hint:'teach something useful, a tip, a how-to, a myth-bust' },
  { key:'engagement',  label:'Engagement / Question', pct:0.20, hint:'a question, a poll-style prompt, a "this or that", something that invites replies' },
  { key:'story',       label:'Story / Behind-the-scenes', pct:0.20, hint:'a behind-the-scenes moment, a founder story, a lesson learned' },
  { key:'promotional', label:'Promotional / Offer', pct:0.15, hint:'highlight the product/offer with a clear call to action' },
  { key:'socialproof', label:'Social proof / Testimonial', pct:0.15, hint:'a testimonial-style post, a result, a case-study angle, a review' },
];

function renderMonthPlan() {
  const brand = activeBrand();
  if (!brand) {
    $('main').innerHTML = `<div class="empty-big"><div class="ico">▦</div><b>Add a brand first</b><p>The 30-Day Plan writes a full month of content in your brand's voice.</p><button class="btn primary" onclick="STMZ.newBrand()">Create a brand</button></div>`;
    return;
  }
  const platforms = Object.keys(BEST_TIMES);
  $('main').innerHTML = `
    <div class="ap-hero">
      <h3>▦ A full month of content — planned, written, and scheduled in one click</h3>
      <p>The hardest part of social media isn't writing one post — it's deciding <em>what to post every day for a month</em> without repeating yourself. This builds a complete 30-day calendar with a healthy <b>mix</b> of post types (educational, engagement, story, promo, social-proof), writes every one in your brand voice, finds a matching image, and drops each onto its best day &amp; time. You approve in the calendar — nothing posts without you.</p>
      <div class="ap-status-row">
        <div class="ap-status-item">Posts created<b id="mpCount">30</b></div>
        <div class="ap-status-item">Spread over<b>30 days</b></div>
        <div class="ap-status-item">For<b style="font-size:13px">${esc(brand.name)}</b></div>
      </div>
    </div>

    <div class="section-title">Your content mix</div>
    <p class="intro" style="margin-top:-6px;margin-bottom:14px">This is the balance a real content strategist would aim for — varied, not repetitive. We'll generate your month around it.</p>
    <div class="mix-grid">
      ${CONTENT_MIX.map(m=>`<div class="mix-card"><div class="mix-pct">${Math.round(m.pct*100)}%</div><div class="mix-label">${esc(m.label)}</div></div>`).join('')}
    </div>

    <div class="section-title" style="margin-top:28px">Build my month</div>
    <div class="builder">
      <div class="row3">
        <div>
          <label class="fld">Posts per week</label>
          <select class="t" id="mp_freq" onchange="STMZ.mpUpdateCount()">
            <option value="3">3 — light (12/mo)</option>
            <option value="5" selected>5 — weekdays (20/mo)</option>
            <option value="7">7 — daily (30/mo)</option>
          </select>
        </div>
        <div>
          <label class="fld">Platforms</label>
          <select class="t" id="mp_plats" multiple style="height:auto;min-height:96px">
            ${platforms.map(p=>`<option value="${esc(p)}"${['Instagram','LinkedIn'].includes(p)?' selected':''}>${esc(p)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="fld">Main goal this month</label>
          <select class="t" id="mp_goal">
            <option value="grow awareness and followers">Grow awareness &amp; followers</option>
            <option value="drive sales and conversions">Drive sales &amp; conversions</option>
            <option value="build engagement and community">Build engagement &amp; community</option>
            <option value="launch a new product or offer">Launch a product / offer</option>
            <option value="establish authority and trust">Establish authority &amp; trust</option>
          </select>
          <label class="fld" style="margin-top:10px">Start from</label>
          <input class="t" id="mp_start" type="date" value="${new Date().toISOString().slice(0,10)}">
          <p style="font-size:10.5px;color:var(--ink-faint);margin-top:8px">Hold Ctrl / Cmd to pick more than one platform.</p>
        </div>
      </div>
      <div id="mp_status" style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);min-height:20px;margin-top:14px"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
        <button class="btn primary" id="mp_runBtn" onclick="STMZ.monthPlanGenerate()">▦ Generate my 30-day plan</button>
        <button class="btn" onclick="location.hash='#/calendar'">Open calendar →</button>
      </div>
      <p class="hint" style="margin-top:14px">Tip: on the free demo this creates a small sample. Subscribe for the full month in one go.</p>
    </div>
  `;
}

function mpUpdateCount() {
  const f = parseInt($('mp_freq')?.value, 10) || 5;
  const total = f === 3 ? 12 : f === 7 ? 30 : 20;
  const el = $('mpCount'); if (el) el.textContent = total;
}

async function monthPlanGenerate() {
  const brand = activeBrand();
  if (!brand) return;
  if (!canRun()) return;

  const freq = parseInt($('mp_freq').value, 10) || 5;
  const total = freq === 3 ? 12 : freq === 7 ? 30 : 20;
  const platsSel = Array.from($('mp_plats').selectedOptions).map(o=>o.value);
  const plats = platsSel.length ? platsSel : ['Instagram','LinkedIn'];
  const goal = $('mp_goal').value;
  const startStr = $('mp_start').value;
  const start = startStr ? new Date(startStr+'T00:00:00') : new Date();
  const status = $('mp_status');
  const btn = $('mp_runBtn');

  const typeList = [];
  CONTENT_MIX.forEach(m => { for (let i=0;i<Math.round(m.pct*total);i++) typeList.push(m); });
  while (typeList.length < total) typeList.push(CONTENT_MIX[0]);
  typeList.length = total;

  const mixDesc = CONTENT_MIX.map(m => `${Math.round(m.pct*100)}% ${m.label} (${m.hint})`).join('; ');
  const strategicGoal =
    `${goal}. Build a balanced 30-day content calendar using this content-type mix: ${mixDesc}. ` +
    `Vary the angle of every post so none feel repetitive; make each one feel native to its platform.`;

  btn.disabled = true;
  status.textContent = `Writing your ${total}-post month plan… this can take 20–40 seconds.`;

  try {
    const token = await authToken();
    const res = await fetch('/api/campaign', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) },
      body: JSON.stringify({ brand, platforms: plats, goal: strategicGoal, count: total, days: 30, lang: $('gen_lang')?.value || 'en' })
    });
    if (res.status === 402) { openPay(); btn.disabled=false; return; }
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.message || 'The AI is busy — try again.'); }
    const data = await res.json();
    if (!data.subscribed) demoBump();

    status.textContent = 'Finding a matching image for each post…';
    const withImages = await resolvePostImages(data.posts || []);

    const enriched = withImages.map((p, i) => {
      const platform = p.platform || plats[i % plats.length];
      const t = BEST_TIMES[platform] || BEST_TIMES.Instagram;
      const week = Math.floor(i / freq);
      const slot = t.best[i % t.best.length];
      const [wd, hm] = slot.split(' ');
      const targetWd = WD.indexOf(wd);
      const [hh, mm] = hm.split(':').map(n=>parseInt(n,10));
      const d = new Date(start);
      d.setDate(d.getDate() + week*7);
      const delta = (targetWd - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + delta);
      d.setHours(hh, mm, 0, 0);
      return {
        brandId: brand.id,
        platform,
        hook: p.hook || p.theme || '',
        caption: p.caption || '',
        hashtags: Array.isArray(p.hashtags) ? p.hashtags : (typeof p.hashtags === 'string' ? p.hashtags.split(/\s+/) : []),
        cta: p.cta || '',
        imagePrompt: p.imagePrompt || '',
        stockQuery: p.stockQuery || '',
        imageUrl: p.imageUrl,
        status: 'scheduled',
        scheduledAt: d.getTime(),
      };
    });
    const saved = await Storage.savePostsBulk(enriched);
    posts = [...saved, ...posts];
    refreshSidebar();
    btn.disabled = false;
    status.innerHTML = `<span style="color:var(--ok)">✓ ${saved.length} posts created and scheduled across the next 30 days.</span> <a href="#/calendar" class="signal">Review in calendar →</a>`;
    toast(`Your 30-day plan is ready — ${saved.length} posts scheduled`);
  } catch (err) {
    btn.disabled = false;
    status.innerHTML = `<span style="color:var(--danger)">${esc(err.message || 'Something went wrong — try again.')}</span>`;
  }
}

function renderPlanner() {
  const brand = activeBrand();
  if (!brand) {
    $('main').innerHTML = `<div class="empty-big"><div class="ico">◷</div><b>Add a brand first</b><p>Best Time to Post tunes itself to each brand you manage.</p><button class="btn primary" onclick="STMZ.newBrand()">Create a brand</button></div>`;
    return;
  }

  const platforms = Object.keys(BEST_TIMES);
  // Build the weekly heatmap: rows = platforms, cols = days, cells shaded by how good that day is
  const dayScore = (plat, wdShort) => {
    const t = BEST_TIMES[plat];
    if (!t) return 0;
    return t.best.filter(s => s.startsWith(wdShort)).length;
  };
  const heatRows = platforms.map(plat => {
    const cells = WD.map(d => {
      const n = dayScore(plat, d);
      const lvl = n >= 2 ? 3 : n === 1 ? 2 : 1;
      return `<td class="heat heat-${lvl}" title="${plat} · ${d}">${n ? '●'.repeat(n) : '·'}</td>`;
    }).join('');
    const bh = bestHourFor(plat, brand.id);
    const hh = String(bh.hour).padStart(2,'0');
    return `<tr><td class="heat-plat">${esc(plat)}</td>${cells}<td class="heat-best">${hh}:00<span class="heat-src">${bh.source}</span></td></tr>`;
  }).join('');

  // Count this brand's unscheduled drafts — the planner can place them
  const drafts = posts.filter(p => p.brandId === brand.id && p.status === 'draft');

  $('main').innerHTML = `
    <div class="ap-hero">
      <h3>◷ Post when your audience is actually online</h3>
      <p>Most posts flop because of <em>timing</em>, not content. This shows the best windows for every platform, then can auto-schedule your drafts into those slots — so your calendar fills itself with good timing.</p>
      <div class="ap-status-row">
        <div class="ap-status-item">Drafts ready to schedule<b>${drafts.length}</b></div>
        <div class="ap-status-item">Platforms covered<b>${platforms.length}</b></div>
        <div class="ap-status-item">Tuned to<b style="font-size:13px">${esc(brand.name)}</b></div>
      </div>
    </div>

    <div class="section-title">Best posting windows this week</div>
    <p class="intro" style="margin-top:-6px;margin-bottom:14px">More dots = stronger window. The right column is the single best hour — it switches to <span class="signal">your own data</span> once you've logged engagement on a few posts.</p>
    <div class="planner-heat-wrap">
      <table class="planner-heat">
        <thead><tr><th>Platform</th>${WD.map(d=>`<th>${d}</th>`).join('')}<th>Best hour</th></tr></thead>
        <tbody>${heatRows}</tbody>
      </table>
    </div>

    <div class="section-title" style="margin-top:30px">Fill my month — automatically</div>
    <div class="builder">
      <p class="hint" style="margin-bottom:14px">Pick how often you want to post. We'll take your unscheduled drafts (and generate fresh ones if you run out), then drop each onto its platform's best day + time across the next 4 weeks. You approve everything in the calendar afterwards — nothing posts without you.</p>
      <div class="row3">
        <div>
          <label class="fld">Posts per week</label>
          <select class="t" id="pl_freq">
            <option value="3">3 — light &amp; steady</option>
            <option value="5" selected>5 — weekdays</option>
            <option value="7">7 — daily</option>
            <option value="14">14 — twice daily</option>
          </select>
        </div>
        <div>
          <label class="fld">Across platforms</label>
          <select class="t" id="pl_plats" multiple style="height:auto;min-height:96px">
            ${platforms.map(p=>`<option value="${esc(p)}"${['Instagram','LinkedIn'].includes(p)?' selected':''}>${esc(p)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="fld">Start from</label>
          <input class="t" id="pl_start" type="date" value="${new Date().toISOString().slice(0,10)}">
          <p style="font-size:10.5px;color:var(--ink-faint);margin-top:8px">Hold Ctrl / Cmd to pick more than one platform.</p>
        </div>
      </div>
      <div id="pl_status" style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);min-height:20px;margin-top:14px"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
        <button class="btn primary" id="pl_runBtn" onclick="STMZ.plannerFill()">◷ Build my 4-week plan</button>
        <button class="btn" onclick="location.hash='#/calendar'">Open calendar →</button>
      </div>
    </div>
  `;
}

// Auto-schedule drafts (and generate more if needed) into best-time slots.
async function plannerFill() {
  const brand = activeBrand();
  if (!brand) return;
  const freq = parseInt($('pl_freq').value, 10) || 5;
  const platsSel = Array.from($('pl_plats').selectedOptions).map(o=>o.value);
  const plats = platsSel.length ? platsSel : ['Instagram','LinkedIn'];
  const startStr = $('pl_start').value;
  const start = startStr ? new Date(startStr+'T00:00:00') : new Date();
  const status = $('pl_status');
  const btn = $('pl_runBtn');

  if (!canRun()) return;

  const totalNeeded = freq * 4; // 4 weeks
  let pool = posts.filter(p => p.brandId === brand.id && p.status === 'draft');

  btn.disabled = true;
  status.textContent = `Planning ${totalNeeded} posts across ${plats.length} platform(s)…`;

  // If not enough drafts, generate more to fill the plan.
  if (pool.length < totalNeeded) {
    const shortfall = totalNeeded - pool.length;
    status.textContent = `Writing ${shortfall} new post(s) to complete the plan…`;
    try {
      const token = await authToken();
      const res = await fetch('/api/campaign', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) },
        body: JSON.stringify({ brand, platforms: plats, goal:'Grow awareness & followers', count: shortfall, days: 28, lang: 'en' })
      });
      if (res.status === 402) { openPay(); btn.disabled = false; return; }
      if (res.ok) {
        const data = await res.json();
        if (!data.subscribed) demoBump();
        const now = Date.now();
        for (const item of (data.posts || [])) {
          const np = {
            id: 'p_'+now+'_'+Math.random().toString(36).slice(2,7),
            brandId: brand.id,
            platform: item.platform || plats[0],
            hook: item.hook || '',
            caption: item.caption || '',
            hashtags: item.hashtags || '',
            status: 'draft',
            scheduledAt: null,
            stockQuery: item.stockQuery || '',
            imagePrompt: item.imagePrompt || '',
            createdAt: now,
          };
          const saved = await Storage.savePost(np);
          posts = [saved, ...posts];
        }
        pool = posts.filter(p => p.brandId === brand.id && p.status === 'draft');
      }
    } catch (e) { /* fall through with whatever drafts exist */ }
  }

  // Build the schedule slots: for each week, distribute `freq` posts across the
  // chosen platforms, each at that platform's best day+hour.
  const slots = [];
  for (let week = 0; week < 4; week++) {
    for (let i = 0; i < freq; i++) {
      const plat = plats[(week*freq + i) % plats.length];
      const t = BEST_TIMES[plat] || BEST_TIMES.Instagram;
      const pick = t.best[i % t.best.length];           // "Tue 09:00"
      const [wd, hm] = pick.split(' ');
      const targetWd = WD.indexOf(wd);
      const [hh, mm] = hm.split(':').map(n=>parseInt(n,10));
      const d = new Date(start);
      d.setDate(d.getDate() + week*7);
      // advance to the target weekday within that week
      const delta = (targetWd - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + delta);
      d.setHours(hh, mm, 0, 0);
      slots.push({ plat, when: d.getTime() });
    }
  }
  slots.sort((a,b)=>a.when-b.when);

  // Assign drafts to slots, preferring drafts whose platform matches the slot.
  let scheduled = 0;
  const used = new Set();
  for (const slot of slots) {
    let cand = pool.find(p => !used.has(p.id) && p.platform === slot.plat);
    if (!cand) cand = pool.find(p => !used.has(p.id));
    if (!cand) break;
    used.add(cand.id);
    cand.status = 'scheduled';
    cand.platform = slot.plat;
    cand.scheduledAt = slot.when;
    await Storage.savePost(cand);
    scheduled++;
  }

  btn.disabled = false;
  if (scheduled === 0) {
    status.innerHTML = `<span style="color:var(--danger)">No drafts available to schedule. Generate some in the Generate tab first, then come back.</span>`;
  } else {
    status.innerHTML = `<span style="color:var(--ok)">✓ Scheduled ${scheduled} posts at their best times over the next 4 weeks.</span> <a href="#/calendar" class="signal">Review in calendar →</a>`;
    toast(`${scheduled} posts scheduled at peak times`);
  }
}

function renderAnalytics() {
  const brand = activeBrand();
  if (!brand) {
    $('main').innerHTML = `<p class="intro">Add a brand first.</p>`;
    return;
  }
  const brandPosts = posts.filter(p => p.brandId === brand.id);
  const posted = brandPosts.filter(p => p.status === 'posted');
  const withPerf = posted.filter(p =>
    p.performance && ((p.performance.likes||0)+(p.performance.comments||0)+(p.performance.shares||0)) > 0
  );

  // Aggregate stats
  const score = p => (p.performance?.likes||0) + (p.performance?.comments||0)*2 + (p.performance?.shares||0)*3;
  const totalLikes = withPerf.reduce((s,p) => s + (p.performance.likes||0), 0);
  const totalComments = withPerf.reduce((s,p) => s + (p.performance.comments||0), 0);
  const totalShares = withPerf.reduce((s,p) => s + (p.performance.shares||0), 0);
  const totalReach = withPerf.reduce((s,p) => s + (p.performance.reach||0), 0);

  // Per-platform
  const platMap = {};
  withPerf.forEach(p => {
    const k = p.platform || 'Other';
    platMap[k] = platMap[k] || { count:0, score:0 };
    platMap[k].count++;
    platMap[k].score += score(p);
  });
  const platRows = Object.entries(platMap).map(([k,v]) => ({ name:k, count:v.count, avg: v.count ? Math.round(v.score/v.count) : 0 })).sort((a,b) => b.avg - a.avg);
  const maxAvg = Math.max(1, ...platRows.map(r => r.avg));

  // Top 5
  const top5 = [...withPerf].sort((a,b) => score(b) - score(a)).slice(0,5);

  $('main').innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="k">Posts measured</div><div class="v">${withPerf.length}<small>/ ${posted.length} posted</small></div></div>
      <div class="kpi"><div class="k">Total likes</div><div class="v">${totalLikes}</div></div>
      <div class="kpi"><div class="k">Total comments</div><div class="v">${totalComments}</div></div>
      <div class="kpi"><div class="k">Total shares · reach</div><div class="v" style="font-size:22px">${totalShares}<small>·${totalReach}</small></div></div>
    </div>

    ${withPerf.length < 3 ? `
      <div class="ap-hero" style="margin-top:18px">
        <h3>⊕ Add engagement numbers to unlock insights</h3>
        <p>Open any posted entry in the library, set its status to <b>Posted</b>, and fill in likes / comments / shares. We need at least 3 measured posts to find patterns. <a href="#/library" class="signal">Open library →</a></p>
      </div>
    ` : `
      <div class="section-title">Performance by platform</div>
      <div class="bar-list">
        ${platRows.map(r => `
          <div class="bar-row">
            <div class="bar-lbl">${esc(r.name)} <small>· ${r.count} post${r.count>1?'s':''}</small></div>
            <div class="bar-track"><div class="bar-fill" style="width:${(r.avg/maxAvg*100).toFixed(0)}%"></div></div>
            <div class="bar-val">${r.avg}</div>
          </div>
        `).join('')}
      </div>

      <div class="section-title">Top 5 posts</div>
      <div class="lib-grid">
        ${top5.map(p => `
          <div class="lib-card" onclick="STMZ.editPost('${p.id}')">
            <img src="${esc(p.imageUrl||'')}" loading="lazy" alt="">
            <div class="body">
              <div style="font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--signal)">${esc(p.platform)}</div>
              <div class="hook">${esc(p.hook||'')}</div>
              <div class="cap" style="display:flex;gap:14px;font-family:var(--mono);font-size:11.5px;color:var(--ink-dim)">
                <span>♡ ${p.performance.likes||0}</span><span>💬 ${p.performance.comments||0}</span><span>↻ ${p.performance.shares||0}</span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>

      <div class="section-title">AI insights <button class="btn sm" onclick="STMZ.runInsights()" id="insightsBtn" style="margin-left:8px">${_insights ? '↻ Refresh' : '✦ Generate insights'}</button></div>
      <div id="insightsBox">${_insights ? renderInsightsBox(_insights) : `<p style="color:var(--ink-faint);font-size:13px">Click "Generate insights" — the AI will read your performance data and tell you what is working.</p>`}</div>
    `}
  `;
}

function renderInsightsBox(d) {
  if (d.thin) return `<p style="color:var(--ink-faint);font-size:13px">${esc(d.message)}</p>`;
  return `
    <div class="ap-hero">
      <h3>What's working for you</h3>
      <p style="font-size:14.5px;line-height:1.6;color:var(--ink)">${esc(d.actionable || '')}</p>
      <div style="display:flex;gap:18px;margin-top:14px;flex-wrap:wrap">
        <div class="ap-status-item">BEST PLATFORM<b>${esc(d.bestPlatform || '—')}</b></div>
        <div class="ap-status-item">BEST TIME<b>${esc(d.bestTimeOfDay || '—')}</b></div>
      </div>
      ${d.topThemes?.length ? `<p style="margin-top:14px;font-size:13px"><b class="signal">Top patterns:</b> ${d.topThemes.map(t => `<span class="chip">${esc(t)}</span>`).join(' ')}</p>` : ''}
      ${d.lowThemes?.length ? `<p style="font-size:13px;color:var(--ink-dim)"><b>Avoid:</b> ${d.lowThemes.map(t => `<span class="chip dim">${esc(t)}</span>`).join(' ')}</p>` : ''}
    </div>
  `;
}

async function runInsights() {
  const brand = activeBrand();
  if (!brand) return;
  if (!canRun()) return;
  const btn = $('insightsBtn'); if (btn) { btn.disabled = true; btn.textContent = '⏳ Reading your data…'; }
  try {
    const brandPosts = posts.filter(p => p.brandId === brand.id);
    const token = await authToken();
    const r = await fetch('/api/insights', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) },
      body: JSON.stringify({ posts: brandPosts, brand }),
    });
    if (r.status === 402) { openPay(); return; }
    const d = await r.json();
    if (!d.subscribed && !d.thin) demoBump();
    _insights = d;
    $('insightsBox').innerHTML = renderInsightsBox(d);
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '✦ Generate insights'; }
    toast('Failed: ' + err.message);
  }
}

/* ============================================================
   V7: BULK PRODUCTS — paste/upload CSV of products → campaigns
   ============================================================ */
let _bulkResult = null;

function renderBulkProducts() {
  $('main').innerHTML = `
    <p class="intro" style="margin-bottom:18px">Have a Shopify export, a product list, or 20 SKUs you need posts for? Paste the list (one product per line, or CSV with name, description, price) — AI writes a multi-platform campaign for each product. Built for e-commerce sellers and product launches.</p>
    <div class="builder" style="margin-top:0">
      <label class="fld">Product list — one per line, OR CSV (name, description, price, category)</label>
      <textarea class="t" id="bp_text" rows="8" placeholder="Examples:&#10;Leather sandals, Handmade in Karachi, $35, Footwear&#10;Cotton kurta, Lightweight summer wear, $45, Apparel&#10;Beaded clutch, Hand-stitched evening bag, $55, Accessories&#10;&#10;Or just one product per line if you don't have a CSV."></textarea>
      <div class="row" style="margin-top:14px">
        <div><label class="fld">Posts per product</label>
          <select class="t" id="bp_n">
            <option value="2">2 posts each</option>
            <option value="3" selected>3 posts each</option>
            <option value="4">4 posts each</option>
            <option value="5">5 posts each</option>
          </select></div>
        <div><label class="fld">Default platforms</label>
          <input class="t" id="bp_plat" value="Instagram, LinkedIn, TikTok" placeholder="Instagram, LinkedIn, TikTok"></div>
      </div>
      <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn primary" id="bpBtn" onclick="STMZ.runBulk()">⊞ Generate the campaign</button>
        <span class="quota" id="bp_status"></span>
      </div>
    </div>
    <div id="bp_results">${_bulkResult ? renderBulkResult(_bulkResult) : ''}</div>
  `;
}

function parseProductList(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.map(line => {
    const parts = line.split(',').map(s => s.trim());
    return {
      name: parts[0] || '',
      description: parts[1] || '',
      price: parts[2] || '',
      category: parts[3] || '',
    };
  }).filter(p => p.name);
}

async function runBulk() {
  const text = $('bp_text').value.trim();
  if (!text) { toast('Paste your products first.'); return; }
  const products = parseProductList(text);
  if (!products.length) { toast('Could not read any products. Check the format.'); return; }
  if (products.length > 20) { toast('Maximum 20 products per batch. Split it up.'); return; }
  if (!canRun()) return;
  const btn = $('bpBtn'); btn.disabled = true;
  $('bp_status').textContent = `Writing campaigns for ${products.length} product${products.length>1?'s':''}…`;
  try {
    const token = await authToken();
    const r = await fetch('/api/bulk-products', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) },
      body: JSON.stringify({ products, brand: (activeBrand() || {}), postsPerProduct: parseInt($('bp_n').value,10) }),
    });
    if (r.status === 402) { openPay(); throw new Error('limit'); }
    if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.message || 'AI is busy.'); }
    const d = await r.json();
    if (!d.subscribed) demoBump();
    // Pexels-first image for every post of every product (parallel)
    $('bp_status').textContent = 'Finding the right photo for each post…';
    await Promise.all((d.campaign || []).flatMap(prod =>
      (prod.posts || []).map(async p => {
        p.imageUrl = await resolvePostImage(p.stockQuery || prod.productName, p.imagePrompt || p.hook || prod.productName);
      })
    ));
    _bulkResult = d;
    const totalPosts = (d.campaign || []).reduce((s,c) => s + (c.posts?.length || 0), 0);
    $('bp_status').textContent = `${totalPosts} posts across ${d.campaign?.length || 0} products`;
    $('bp_results').innerHTML = renderBulkResult(d);
  } catch (err) {
    if (err.message !== 'limit') $('bp_status').textContent = err.message;
  } finally { btn.disabled = false; }
}

function renderBulkResult(d) {
  if (!d.campaign?.length) return '';
  return `
    <div class="section-title" style="margin-top:28px">Generated campaign</div>
    <div style="display:flex;flex-direction:column;gap:24px">
      ${d.campaign.map((prod, pi) => `
        <div class="bulk-product">
          <h4>${esc(prod.productName)}</h4>
          <div class="lib-grid">
            ${(prod.posts || []).map((p, i) => `
              <div class="lib-card">
                <img src="${esc(p.imageUrl)}" loading="lazy" alt="">
                <div class="body">
                  <div style="font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--signal)">${esc(p.platform)}</div>
                  <div class="hook">${esc(p.hook || '')}</div>
                  <div class="cap">${esc((p.caption || '').slice(0,150))}${(p.caption||'').length>150?'…':''}</div>
                </div>
                <div class="foot">
                  <button class="btn sm" onclick="STMZ.saveBulkPost(${pi},${i})">💾 Save</button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
    <div style="margin-top:16px;display:flex;gap:10px">
      <button class="btn primary" onclick="STMZ.saveAllBulk()">💾 Save the whole campaign to library</button>
    </div>
  `;
}

async function saveBulkPost(pi, i) {
  const p = _bulkResult?.campaign?.[pi]?.posts?.[i]; if (!p) return;
  const brand = activeBrand(); if (!brand) return;
  const saved = await Storage.savePost({
    brandId: brand.id, platform: p.platform || 'Instagram',
    hook: p.hook || '', caption: p.caption || '',
    hashtags: p.hashtags || [], cta: p.cta || '',
    imagePrompt: p.imagePrompt || '', imageUrl: p.imageUrl,
    status:'draft', scheduledAt: Date.now() + (pi+1)*24*60*60*1000,
    source:'bulk-products',
  });
  posts.unshift(saved); refreshSidebar();
  toast('Saved.');
}

async function saveAllBulk() {
  if (!_bulkResult?.campaign?.length) return;
  const brand = activeBrand(); if (!brand) return;
  let count = 0, day = 1;
  for (const prod of _bulkResult.campaign) {
    for (const p of (prod.posts || [])) {
      const saved = await Storage.savePost({
        brandId: brand.id, platform: p.platform || 'Instagram',
        hook: p.hook || '', caption: p.caption || '',
        hashtags: p.hashtags || [], cta: p.cta || '',
        imagePrompt: p.imagePrompt || '', imageUrl: p.imageUrl,
        status:'draft', scheduledAt: Date.now() + day*24*60*60*1000,
        source:'bulk-products',
      });
      posts.unshift(saved); count++; day++;
    }
  }
  _bulkResult = null;
  refreshSidebar();
  toast(`✓ ${count} posts saved as drafts.`);
  location.hash = '#/library';
}

/* ============================================================
   V6: CONTENT LIFT — paste URL or text → 5-7 post campaign
   ------------------------------------------------------------
   Solves the "I have stuff to say but no time to post" loop.
   User pastes a URL (article, blog, transcript) OR pastes the
   text directly. AI extracts the 5-7 best ideas in the source
   and writes one platform-native post per idea, ready to save.
   ============================================================ */
let _liftPosts = [];
let _liftMode = 'text';

function renderContentLift() {
  $('main').innerHTML = `
    <p class="intro" style="margin-bottom:18px">Drop a blog post, article, podcast transcript, your own notes or a YouTube transcript URL — Content Lift extracts the best ideas and turns them into a week of platform-native posts in your brand voice.</p>

    <div class="builder" style="margin-top:0">
      <div class="tab-row" style="display:flex;gap:6px;margin-bottom:12px">
        <button class="btn ${_liftMode==='text'?'primary':''} sm" id="liftTabText" onclick="STMZ.liftMode('text')">⌨ Paste text</button>
        <button class="btn ${_liftMode==='url'?'primary':''} sm" id="liftTabUrl" onclick="STMZ.liftMode('url')">🔗 From a URL</button>
      </div>

      <div id="liftInputText" style="${_liftMode==='text'?'':'display:none'}">
        <label class="fld">Paste any content you want turned into posts</label>
        <textarea class="t" id="lift_text" rows="8" placeholder="Paste an article, your blog post, notes, a transcript, a newsletter, an email you wrote — anything textual. Minimum ~100 characters."></textarea>
      </div>
      <div id="liftInputUrl" style="${_liftMode==='url'?'':'display:none'}">
        <label class="fld">URL of the article, blog post or transcript</label>
        <input class="t" id="lift_url" placeholder="https://example.com/your-article">
        <p style="font-size:11.5px;color:var(--ink-faint);margin-top:6px;line-height:1.5">Works for most public blogs and articles. Won't work for sites that block bots, paywalled content, or pages that need JavaScript to render. In those cases, copy the article text and use "Paste text" instead.</p>
      </div>

      <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn primary" id="liftBtn" onclick="STMZ.runLift()">⇪ Generate the campaign</button>
        <span class="quota" id="lift_status"></span>
      </div>
    </div>

    <div id="lift_results">${_liftPosts.length ? renderLiftResults() : ''}</div>
  `;
}

function liftMode(m) {
  _liftMode = m;
  $('liftTabText').classList.toggle('primary', m === 'text');
  $('liftTabUrl').classList.toggle('primary', m === 'url');
  $('liftInputText').style.display = m === 'text' ? '' : 'none';
  $('liftInputUrl').style.display = m === 'url' ? '' : 'none';
}

function renderLiftResults() {
  return `
    <div class="section-title" style="margin-top:28px">Generated posts <small style="font-family:var(--mono);color:var(--ink-faint);font-size:11px">${_liftPosts.length} ready</small></div>
    <div class="lib-grid" id="liftGrid"></div>
    <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn primary" onclick="STMZ.saveAllLift()">💾 Save all to library</button>
      <button class="btn" onclick="STMZ.runLift()">↻ Regenerate</button>
    </div>`;
}

async function runLift() {
  if (!canRun()) return;
  const brand = activeBrand();
  if (!brand) { toast('Add a brand first.'); newBrand(); return; }
  const body = { brand };
  if (_liftMode === 'url') {
    const url = $('lift_url').value.trim();
    if (!url) { toast('Paste the URL first.'); return; }
    body.source = 'url'; body.url = url;
  } else {
    const text = $('lift_text').value.trim();
    if (text.length < 100) { toast('Need at least ~100 characters of source text.'); return; }
    body.source = 'text'; body.content = text;
  }

  const btn = $('liftBtn'); btn.disabled = true;
  $('lift_status').textContent = _liftMode === 'url' ? 'Fetching the page…' : 'Reading the source…';

  try {
    const token = await authToken();
    const r = await fetch('/api/content-lift', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) },
      body: JSON.stringify(body),
    });
    if (r.status === 402) { openPay(); throw new Error('limit'); }
    if (!r.ok) {
      const e = await r.json().catch(()=>({}));
      throw new Error(e.message || 'Generation failed.');
    }
    const data = await r.json();
    if (!data.subscribed) demoBump();

    $('lift_status').textContent = 'Finding the right photo for each post…';
    _liftPosts = await resolvePostImages(data.posts || []);
    $('lift_status').textContent = `${_liftPosts.length} posts written · via ${data.provider}`;
    $('lift_results').innerHTML = renderLiftResults();
    renderLiftGrid();
  } catch (err) {
    if (err.message !== 'limit') $('lift_status').textContent = err.message;
  } finally { btn.disabled = false; }
}

function renderLiftGrid() {
  const brand = activeBrand();
  const grid = $('liftGrid'); if (!grid) return;
  grid.innerHTML = _liftPosts.map((p, i) => `
    <div class="lib-card">
      <img src="${esc(p.imageUrl)}" loading="lazy" alt="">
      <div class="body">
        <div style="font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--signal)">${esc(p.platform || 'Post')}</div>
        <div class="hook">${esc(p.hook || '')}</div>
        <div class="cap">${esc((p.caption || '').slice(0, 200))}${(p.caption||'').length>200?'…':''}</div>
        ${p.hashtags?.length ? `<div style="font-size:11.5px;color:var(--ink-faint);font-family:var(--mono)">${esc(p.hashtags.join(' '))}</div>` : ''}
      </div>
      <div class="foot">
        <button class="btn sm" onclick="STMZ.saveOneLift(${i})">💾 Save</button>
        <button class="btn sm" onclick="STMZ.dropOneLift(${i})">✕ Drop</button>
      </div>
    </div>
  `).join('');
}

async function saveOneLift(i) {
  const p = _liftPosts[i]; if (!p) return;
  const brand = activeBrand(); if (!brand) return;
  const saved = await Storage.savePost({
    brandId: brand.id,
    platform: p.platform || 'Instagram',
    hook: p.hook || '',
    caption: p.caption || '',
    hashtags: p.hashtags || [],
    cta: p.cta || '',
    imagePrompt: p.imagePrompt || '',
    imageUrl: p.imageUrl,
    status: 'draft',
    scheduledAt: Date.now() + (i + 1) * 24 * 60 * 60 * 1000,
    source: 'content-lift',
  });
  posts = [saved, ...posts];
  refreshSidebar();
  _liftPosts.splice(i, 1);
  renderLiftGrid();
  toast('Saved to library.');
}

async function saveAllLift() {
  if (!_liftPosts.length) return;
  const brand = activeBrand(); if (!brand) return;
  let saved = 0;
  for (let i = 0; i < _liftPosts.length; i++) {
    const p = _liftPosts[i];
    const out = await Storage.savePost({
      brandId: brand.id,
      platform: p.platform || 'Instagram',
      hook: p.hook || '',
      caption: p.caption || '',
      hashtags: p.hashtags || [],
      cta: p.cta || '',
      imagePrompt: p.imagePrompt || '',
      imageUrl: p.imageUrl,
      status: 'draft',
      scheduledAt: Date.now() + (i + 1) * 24 * 60 * 60 * 1000,
      source: 'content-lift',
    });
    posts.unshift(out);
    saved++;
  }
  _liftPosts = [];
  refreshSidebar();
  toast(`✓ ${saved} posts saved to library as drafts.`);
  location.hash = '#/library';
}

function dropOneLift(i) {
  _liftPosts.splice(i, 1);
  renderLiftGrid();
}

/* ============================================================
   V5: VIDEO STUDIO — prompt → multi-scene AI video
   ------------------------------------------------------------
   Type a prompt → AI writes a 3-5 scene script + image prompts
   → server returns the script → browser generates an image per
   scene via Pollinations (free) → MediaRecorder stitches all
   scenes into a single WebM with crossfades + Ken Burns motion.
   Total cost: 1 AI call per video. Free.
   ============================================================ */
let _videoScript = null;
let _videoBlob = null;
let _videoBlobUrl = null;

function renderVideoStudio() {
  const tier = currentTier();
  const maxSec = tier.maxVideoSec || 30;
  $('main').innerHTML = `
    <p class="intro" style="margin-bottom:18px">Type any prompt — AI writes the script, fetches real video clips or stock photos from Pexels per scene, then renders the final video in your browser. Optional voice narration + your own music. <b>Free, no third-party render service.</b></p>
    <div class="builder" style="margin-top:0">
      <label class="fld">What's the video about?</label>
      <textarea class="t" id="vs_prompt" rows="3" placeholder="e.g. Announce our 30% summer sale on handmade leather sandals — free delivery this week across Pakistan"></textarea>
      <div class="row" style="margin-top:14px">
        <div><label class="fld">Aspect ratio</label>
          <select class="t" id="vs_aspect">
            <option value="1080x1920">9:16 Vertical (Reels, TikTok, Shorts)</option>
            <option value="1080x1080">1:1 Square (Instagram, LinkedIn)</option>
            <option value="1920x1080">16:9 Wide (YouTube, X)</option>
          </select></div>
        <div><label class="fld">Target length</label>
          <select class="t" id="vs_length" onchange="STMZ.vsLengthChanged(this)">
            <option value="15">15 seconds — quick hook</option>
            <option value="30" selected>30 seconds — standard Reel</option>
            <option value="60" ${maxSec < 60 ? 'disabled' : ''}>60 seconds — full ad${maxSec < 60 ? ' 🔒 Pro' : ''}</option>
            <option value="90" ${maxSec < 90 ? 'disabled' : ''}>90 seconds — story Reel${maxSec < 90 ? ' 🔒 Pro' : ''}</option>
            <option value="120" ${maxSec < 120 ? 'disabled' : ''}>120 seconds — long-form${maxSec < 120 ? ' 🔒 Agency' : ''}</option>
          </select>
          <p style="font-size:11px;color:var(--ink-faint);margin-top:6px;line-height:1.5" id="vs_lenNote">Your <b>${tier.name}</b> plan supports up to <b>${maxSec}s</b> videos. ${maxSec < 120 ? `<a class="signal" href="#" onclick="STMZ.openPay();return false;">Upgrade for longer →</a>` : ''}</p>
        </div>
      </div>
      <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn primary" id="vsScriptBtn" onclick="STMZ.vsGenerateScript()">✦ Generate the script</button>
        <span class="quota" id="vs_status"></span>
      </div>
    </div>
    <div id="vs_scriptResult"></div>
  `;
}

function vsLengthChanged(sel) {
  const sec = parseInt(sel.value, 10);
  const tier = currentTier();
  const max = tier.maxVideoSec || 30;
  const note = $('vs_lenNote');
  if (sec > max) {
    // Reset to the closest allowed length and prompt to upgrade
    const allowed = [...sel.options].filter(o => parseInt(o.value,10) <= max).pop();
    if (allowed) sel.value = allowed.value;
    if (note) note.innerHTML = `<b style="color:var(--signal)">Locked</b> — ${sec}s requires ${sec === 120 ? 'Agency' : 'Pro'}. Reset to ${sel.value}s.`;
    setTimeout(() => openPay(), 200);
    return;
  }
  if (note) note.textContent = `Your ${tier.name} plan supports up to ${max}s videos.`;
}

async function vsGenerateScript() {
  const prompt = $('vs_prompt').value.trim();
  if (!prompt) { toast('Type what the video should be about.'); return; }
  if (!canRun()) return;
  const btn = $('vsScriptBtn'); btn.disabled = true;
  $('vs_status').textContent = 'Writing the script…';

  // Compute scene count from target length — roughly 1 scene per 4-5 seconds.
  const targetSec = parseInt($('vs_length')?.value, 10) || 30;
  const tier = currentTier();
  const cappedSec = Math.min(targetSec, tier.maxVideoSec || 30);
  const sceneCount = Math.max(3, Math.min(24, Math.round(cappedSec / 4.5)));

  try {
    const token = await authToken();
    const langCode = $('vs_lang')?.value || 'en';
    const r = await fetch('/api/video-script', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) },
      body: JSON.stringify({ prompt, brand: (activeBrand() || {}), scenes: sceneCount, targetSec: cappedSec, lang: langCode })
    });
    if (r.status === 402) { openPay(); throw new Error('limit'); }
    if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.message || 'AI is busy.'); }
    const data = await r.json();
    if (!data.subscribed) demoBump();
    _videoScript = data;
    _videoBlob = null;
    $('vs_status').textContent = `Script ready · ${data.scenes?.length || 0} scenes · via ${data.provider}`;
    renderScriptPreview(data);
  } catch (err) {
    if (err.message !== 'limit') $('vs_status').textContent = err.message;
  } finally { btn.disabled = false; }
}

function renderScriptPreview(script) {
  $('vs_scriptResult').innerHTML = `
    <div class="section-title" style="margin-top:32px">"${esc(script.title || 'Untitled')}" <small style="font-family:var(--mono);color:var(--ink-faint);font-size:11px">~${script.totalSeconds || ''}s</small></div>
    <div class="scene-grid">
      ${(script.scenes || []).map((s, i) => `
        <div class="scene-card" id="vs_scene_${i}">
          <div class="ix">SCENE ${i+1} · ${s.duration||3}s</div>
          <div class="cap" contenteditable="true" data-scene="${i}" data-field="caption" onblur="STMZ.vsEditScene(this)">${esc(s.caption || '')}</div>
          <div class="prm-lbl" style="margin-top:8px">🗣 voice says (click to edit):</div>
          <div class="prm" contenteditable="true" data-scene="${i}" data-field="narration" onblur="STMZ.vsEditScene(this)" style="background:rgba(189,243,109,0.04);border-left:2px solid var(--signal);padding-left:10px">${esc(s.narration || s.caption || '')}</div>
          <div class="prm-lbl" style="margin-top:8px">visual prompt (click to edit):</div>
          <div class="prm" contenteditable="true" data-scene="${i}" data-field="imagePrompt" onblur="STMZ.vsEditScene(this)">${esc(s.imagePrompt || '')}</div>
          ${s.stockQuery ? `<div class="prm-lbl" style="margin-top:6px">stock search keyword:</div><div class="prm" contenteditable="true" data-scene="${i}" data-field="stockQuery" onblur="STMZ.vsEditScene(this)">${esc(s.stockQuery)}</div>` : ''}
        </div>
      `).join('')}
    </div>

    <div class="section-title" style="margin-top:24px;font-size:12px;color:var(--ink-faint);text-transform:uppercase;letter-spacing:.08em">Style &amp; audio <span style="opacity:.5">— optional</span></div>
    <div class="builder vs-style" style="margin-top:8px">
      <div class="row">
        <div>
          <label class="fld">Caption color</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="color" id="vs_capColor" value="#e7ffd0" class="t" style="height:42px;width:62px;padding:3px;cursor:pointer">
            <span style="font-family:var(--mono);font-size:11px;color:var(--ink-faint)">match your brand</span>
          </div>
        </div>
        <div>
          <label class="fld">Caption position</label>
          <select class="t" id="vs_capPos">
            <option value="bottom" selected>Bottom (default for Reels)</option>
            <option value="middle">Middle (eye level)</option>
            <option value="top">Top</option>
          </select>
        </div>
      </div>
      <div class="row" style="margin-top:12px">
        <div>
          <label class="fld">Caption style</label>
          <select class="t" id="vs_capStyle">
            <option value="bold" selected>Bold — punchy, sans-serif</option>
            <option value="modern">Modern — black weight, condensed</option>
            <option value="classic">Classic — serif, editorial</option>
          </select>
        </div>
        <div>
          <label class="fld">Subtitle animation</label>
          <select class="t" id="vs_subMode">
            <option value="word-by-word" selected>Word-by-word — TikTok / Reels style ⭐</option>
            <option value="static">Static — whole caption at once</option>
          </select>
          <p style="font-size:10.5px;color:var(--ink-faint);margin-top:4px;line-height:1.4">Word-by-word: each word pops in as the voice speaks it, with a highlight chip — the high-retention style that wins on TikTok &amp; Reels.</p>
        </div>
      </div>
      <div class="row" style="margin-top:12px">
        <div>
          <label class="fld">Voice narration</label>
          <select class="t" id="vs_voice">
            <option value="none">No voice — silent video</option>
            <optgroup label="Female voices">
              <option value="joanna" selected>Joanna — US, professional</option>
              <option value="salli">Salli — US, energetic</option>
              <option value="amy">Amy — UK, friendly</option>
            </optgroup>
            <optgroup label="Male voices">
              <option value="matthew">Matthew — US, news anchor</option>
              <option value="joey">Joey — US, casual</option>
              <option value="brian">Brian — UK, warm</option>
            </optgroup>
          </select>
          <button class="btn sm" onclick="STMZ.vsTestVoice()" style="margin-top:6px;font-size:11px">🔊 Test this voice</button>
          <span id="vs_testVoiceStatus" style="font-size:11px;color:var(--ink-faint);margin-left:8px"></span>
        </div>
        <div>
          <label class="fld">Voice &amp; caption language 🌍</label>
          <select class="t" id="vs_lang">
            <option value="en" selected>English</option>
            <option value="es">Spanish — Español</option>
            <option value="fr">French — Français</option>
            <option value="de">German — Deutsch</option>
            <option value="it">Italian — Italiano</option>
            <option value="pt">Portuguese — Português</option>
            <option value="nl">Dutch — Nederlands</option>
            <option value="ru">Russian — Русский</option>
            <option value="ar">Arabic — العربية</option>
            <option value="hi">Hindi — हिन्दी</option>
            <option value="ur">Urdu — اردو</option>
            <option value="bn">Bengali — বাংলা</option>
            <option value="tr">Turkish — Türkçe</option>
            <option value="id">Indonesian — Bahasa</option>
            <option value="ms">Malay — Melayu</option>
            <option value="th">Thai — ไทย</option>
            <option value="vi">Vietnamese — Tiếng Việt</option>
            <option value="ja">Japanese — 日本語</option>
            <option value="ko">Korean — 한국어</option>
            <option value="zh-CN">Chinese — 中文</option>
            <option value="pl">Polish — Polski</option>
            <option value="uk">Ukrainian — Українська</option>
            <option value="ro">Romanian — Română</option>
            <option value="el">Greek — Ελληνικά</option>
            <option value="sv">Swedish — Svenska</option>
            <option value="fa">Persian — فارسی</option>
            <option value="ta">Tamil — தமிழ்</option>
            <option value="te">Telugu — తెలుగు</option>
            <option value="fil">Filipino</option>
            <option value="sw">Swahili — Kiswahili</option>
          </select>
          <p style="font-size:10.5px;color:var(--ink-faint);margin-top:5px;line-height:1.4">The AI writes the script, the voice speaks it, and the on-screen captions all appear in this language. Free, 30 languages.</p>
        </div>
      </div>
      <div class="row" style="margin-top:12px">
        <div>
          <label class="fld">Watermark</label>
          <select class="t" id="vs_watermark">
            <option value="show" selected>"made with stmz" (default)</option>
            <option value="hide">Hide watermark</option>
          </select>
        </div>
        <div></div>
      </div>
      <div style="margin-top:14px">
        <label class="fld">Audio (optional)</label>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <label for="vs_audio" class="btn sm" style="cursor:pointer;margin:0">🎵 Choose an audio file…</label>
          <input type="file" id="vs_audio" accept="audio/*" style="display:none" onchange="STMZ.vsAudioPicked(this)">
          <span id="vs_audioName" style="font-family:var(--mono);font-size:11.5px;color:var(--ink-faint)">no audio · silent video</span>
          <button class="btn sm" id="vs_audioClear" onclick="STMZ.vsAudioClear()" style="display:none">✕ remove</button>
        </div>
        <p style="font-size:11px;color:var(--ink-faint);margin-top:6px;line-height:1.5">
          Loops to cover the full video length. Note: Instagram and TikTok replace uploaded audio with their licensed library on upload — add their trending audio in-app for best reach. Works as expected on LinkedIn, YouTube Shorts, WhatsApp and direct downloads.
        </p>
      </div>
    </div>

    <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="btn primary" id="vsMakeBtn" onclick="STMZ.vsMakeVideo()">🎬 Generate the video</button>
      <button class="btn" onclick="STMZ.vsGenerateScript()">↻ Re-do the script</button>
      <span class="quota" id="vs_makeStatus"></span>
    </div>
    <div class="v-progress" id="vs_prog" style="display:none;margin-top:10px"><div class="bar" id="vs_bar"></div></div>
    <div id="vs_doneBox"></div>
  `;
}

/* Audio file pick handler — stash on window for vsMakeVideo to read. */
let _vsAudioFile = null;
function vsTestVoice() {
  const voice = $('vs_voice')?.value || 'none';
  const lang = $('vs_lang')?.value || 'en';
  const status = $('vs_testVoiceStatus');
  if (voice === 'none') { if (status) status.textContent = 'Pick a voice first.'; return; }
  if (status) status.textContent = 'Loading…';
  // Localized sample sentences so the test actually demos the chosen language.
  const SAMPLES = {
    en: 'Hello! This is a preview of the voice narration for your video.',
    es: '¡Hola! Esta es una vista previa de la narración de voz para tu vídeo.',
    fr: 'Bonjour ! Ceci est un aperçu de la narration vocale de votre vidéo.',
    de: 'Hallo! Dies ist eine Vorschau der Sprachausgabe für Ihr Video.',
    it: 'Ciao! Questa è un\'anteprima della narrazione vocale per il tuo video.',
    pt: 'Olá! Esta é uma prévia da narração de voz para o seu vídeo.',
    ar: 'مرحبا! هذه معاينة للتعليق الصوتي للفيديو الخاص بك.',
    hi: 'नमस्ते! यह आपके वीडियो के लिए आवाज़ का एक नमूना है।',
    ur: 'السلام علیکم! یہ آپ کی ویڈیو کے لیے آواز کا نمونہ ہے۔',
    bn: 'নমস্কার! এটি আপনার ভিডিওর জন্য ভয়েসের একটি নমুনা।',
    tr: 'Merhaba! Bu, videonuz için ses anlatımının bir önizlemesidir.',
    id: 'Halo! Ini adalah pratinjau narasi suara untuk video Anda.',
    ru: 'Привет! Это предварительный просмотр озвучки для вашего видео.',
    ja: 'こんにちは！これはあなたのビデオの音声ナレーションのプレビューです。',
    ko: '안녕하세요! 이것은 동영상의 음성 해설 미리보기입니다.',
    'zh-CN': '你好！这是您视频的语音旁白预览。',
    th: 'สวัสดี! นี่คือตัวอย่างเสียงบรรยายสำหรับวิดีโอของคุณ',
    vi: 'Xin chào! Đây là bản xem trước phần lồng tiếng cho video của bạn.',
  };
  const sample = SAMPLES[lang] || SAMPLES.en;
  const url = `/api/tts?voice=${encodeURIComponent(voice)}&lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(sample)}`;
  const audio = new Audio(url);
  audio.preload = 'auto';
  audio.onerror = () => { if (status) status.textContent = '✗ TTS service unavailable. Try again in a minute.'; };
  audio.onplaying = () => { if (status) status.textContent = '▶ playing — if you hear it, voice will work.'; };
  audio.onended = () => { if (status) status.textContent = '✓ Voice works. Generate your video.'; };
  audio.play().catch(e => {
    if (status) status.textContent = '✗ Browser blocked audio — click the button again.';
    console.warn('[stmz/test-voice]', e.message);
  });
}

function vsAudioPicked(input) {
  const f = input.files?.[0];
  if (!f) return;
  if (f.size > 15 * 1024 * 1024) { toast('Audio file must be under 15 MB.'); input.value = ''; return; }
  _vsAudioFile = f;
  $('vs_audioName').textContent = `${f.name} · ${(f.size/1024/1024).toFixed(1)} MB`;
  $('vs_audioName').style.color = 'var(--signal)';
  $('vs_audioClear').style.display = '';
}
function vsAudioClear() {
  _vsAudioFile = null;
  $('vs_audio').value = '';
  $('vs_audioName').textContent = 'no audio · silent video';
  $('vs_audioName').style.color = 'var(--ink-faint)';
  $('vs_audioClear').style.display = 'none';
}

function vsEditScene(el) {
  if (!_videoScript) return;
  const idx = parseInt(el.dataset.scene, 10);
  const field = el.dataset.field;
  if (!_videoScript.scenes[idx]) return;
  _videoScript.scenes[idx][field] = el.innerText.trim();
}

async function vsMakeVideo() {
  if (!_videoScript) return;
  // Free any previous blob URL so we don't leak memory across regenerations
  if (_videoBlobUrl) { try { URL.revokeObjectURL(_videoBlobUrl); } catch {} _videoBlobUrl = null; }

  // ====== CRITICAL: PRE-WARM AUDIO CONTEXT BEFORE ANY AWAITS ======
  // The click on "Generate the video" gives us a user-gesture token. Browsers
  // require this token to be FRESH when an AudioContext goes from suspended
  // to running. If we wait until inside generateStoryVideo (after fetches),
  // the gesture is stale and audio is silently blocked → silent video.
  // Creating + resuming the context synchronously here keeps the gesture fresh.
  const voiceChoice = $('vs_voice')?.value || 'none';
  const needAudio = voiceChoice !== 'none' || !!_vsAudioFile;
  let preWarmedAudioCtx = null;
  if (needAudio) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        preWarmedAudioCtx = new Ctx();
        // Don't await — just start the resume. We're synchronous still here,
        // gesture is fresh, browser will (usually) allow it.
        preWarmedAudioCtx.resume();
      }
    } catch (e) { console.warn('[stmz] audio prewarm failed:', e); }
  }

  const [w, h] = $('vs_aspect').value.split('x').map(Number);
  const btn = $('vsMakeBtn'); btn.disabled = true; btn.textContent = '⏳ Generating…';
  $('vs_prog').style.display = 'block';
  $('vs_bar').style.width = '0%';

  // Pass narration (what the voice speaks) + caption (what shows on-screen)
  // + visuals. video.js uses narration for TTS, caption for the on-screen text.
  const scenes = _videoScript.scenes.map((s, i) => ({
    caption: s.caption,
    narration: s.narration || s.caption || '',
    duration: Math.max(2, Math.min(5, parseInt(s.duration,10) || 3)),
    stockQuery: s.stockQuery || '',
    imagePrompt: (s.imagePrompt || s.caption || '') + ' cinematic lifestyle photography',
  }));

  // Read style controls (with sensible fallbacks if they're not in the DOM
  // because the user hit Make from an older session)
  const style = {
    captionColor:    $('vs_capColor')?.value     || '#e7ffd0',
    captionPosition: $('vs_capPos')?.value       || 'bottom',
    captionStyle:    $('vs_capStyle')?.value     || 'bold',
    subtitleMode:    $('vs_subMode')?.value      || 'word-by-word',
    narrationLang:   $('vs_lang')?.value         || 'en',
    showWatermark:   ($('vs_watermark')?.value   || 'show') !== 'hide',
    brandName:       activeBrand()?.name || '',
  };

  try {
    let blob;
    let usedFallback = false;

    // Try once with the user's full settings (voice + audio if requested)
    try {
      blob = await generateStoryVideo({
        scenes,
        size: { w, h },
        style,
        audioFile: _vsAudioFile,
        voice: voiceChoice,
        preWarmedAudioCtx,
        onProgress: (t) => { $('vs_bar').style.width = (t * 100).toFixed(0) + '%'; },
        onStatus: (msg) => { $('vs_makeStatus').textContent = msg; },
      });
    } catch (firstErr) {
      const hadAudio = voiceChoice !== 'none' || _vsAudioFile;
      if (!hadAudio) throw firstErr;
      console.warn('[stmz] full-audio render failed, retrying silent:', firstErr.message);
      $('vs_makeStatus').textContent = `Audio capture blocked by browser — retrying without audio…`;
      $('vs_bar').style.width = '0%';
      blob = await generateStoryVideo({
        scenes,
        size: { w, h },
        style,
        audioFile: null,
        voice: 'none',
        onProgress: (t) => { $('vs_bar').style.width = (t * 100).toFixed(0) + '%'; },
        onStatus: (msg) => { $('vs_makeStatus').textContent = msg; },
      });
      usedFallback = true;
    }

    _videoBlob = blob;
    const safeName = (_videoScript.title || 'stmz-story').toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,40).replace(/^-|-$/g,'') || 'stmz-story';
    const blobUrl = URL.createObjectURL(blob);
    _videoBlobUrl = blobUrl;
    downloadBlob(blob, `${safeName}-${w}x${h}.webm`);
    const audioLabel = usedFallback ? ' (silent — audio fallback)' :
      (_vsAudioFile && voiceChoice !== 'none' ? ' (voice + music)' :
       (voiceChoice !== 'none' ? ' (with voice)' :
       (_vsAudioFile ? ' (with music)' : '')));
    $('vs_makeStatus').textContent = `✓ Done · ${(blob.size/1024/1024).toFixed(1)} MB${audioLabel}`;
    btn.textContent = '↻ Generate again';
    btn.disabled = false;
    $('vs_doneBox').innerHTML = `
      <div class="ap-hero" style="margin-top:18px">
        <h3>✓ Your video is ready</h3>
        <video controls playsinline preload="metadata" src="${blobUrl}" style="width:100%;max-width:380px;border-radius:8px;background:#000;margin:14px 0;display:block"></video>
        ${usedFallback ? `<div style="background:rgba(255,200,80,0.08);border:1px solid rgba(255,200,80,0.3);padding:10px 14px;border-radius:6px;font-size:12.5px;line-height:1.5;margin-bottom:12px"><b>⚠ Silent video</b> — your browser blocked audio capture during recording. Workarounds: <b>(1)</b> reload the page and try again immediately after clicking Generate (don't switch tabs first), <b>(2)</b> use Chrome or Edge instead of Firefox/Safari, <b>(3)</b> add audio in your video editor after exporting.</div>` : ''}
        <p style="font-size:13.5px;line-height:1.55;margin-bottom:10px"><b>It downloaded automatically</b> to your Downloads folder. The preview above plays in your browser — that's the same file.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:14px 0">
          <button class="btn primary" onclick="STMZ.vsSaveAsPost()">💾 Save as draft post</button>
          <button class="btn" onclick="STMZ.vsRedownload()">⇣ Download again</button>
          <a class="btn" href="${blobUrl}" target="_blank" rel="noopener">↗ Open in new tab</a>
        </div>
        <div style="background:rgba(189,243,109,0.07);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-top:14px">
          <p style="font-size:13px;line-height:1.55;margin:0"><b class="signal">Can't open the file on your computer?</b> Windows Media Player and some default players don't support <code>.webm</code> — that's normal, the file is fine. Three ways to play or convert it:</p>
          <ol style="font-size:12.5px;line-height:1.7;margin:8px 0 0 22px;color:var(--ink-dim)">
            <li><b>Easiest:</b> drag the downloaded file onto any browser tab (Chrome, Firefox, Edge) — plays instantly.</li>
            <li><b>Convert to MP4 (Instagram &amp; TikTok need this):</b> <a class="signal" href="https://cloudconvert.com/webm-to-mp4" target="_blank" rel="noopener">cloudconvert.com</a> — free, no signup, 30 seconds.</li>
            <li><b>Install <a class="signal" href="https://www.videolan.org/vlc/" target="_blank" rel="noopener">VLC</a></b> (free, plays everything) and set it as default for video files.</li>
          </ol>
          <p style="font-size:12px;line-height:1.55;margin-top:10px;color:var(--ink-faint)">LinkedIn, YouTube Shorts, WhatsApp, Telegram and most modern social apps accept <code>.webm</code> directly — no conversion needed for those.</p>
        </div>
      </div>
    `;
  } catch (err) {
    $('vs_makeStatus').textContent = 'Failed: ' + err.message;
    btn.disabled = false; btn.textContent = '🎬 Generate the video';
  }
}

function vsRedownload() {
  if (!_videoBlob || !_videoScript) return;
  const [w, h] = $('vs_aspect').value.split('x').map(Number);
  const safeName = (_videoScript.title || 'stmz-story').toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,40);
  downloadBlob(_videoBlob, `${safeName}-${w}x${h}.webm`);
}

async function vsSaveAsPost() {
  if (!_videoScript) return;
  const brand = activeBrand();
  if (!brand) { toast('Add a brand first.'); newBrand(); return; }
  const caption = (_videoScript.scenes || []).map(s => s.caption).join(' · ');
  const newPost = {
    brandId: brand.id,
    platform: 'Instagram',
    hook: _videoScript.title || 'Video',
    caption,
    hashtags: [],
    cta: _videoScript.endCaption || '',
    imagePrompt: _videoScript.scenes?.[0]?.imagePrompt || '',
    stockQuery: _videoScript.scenes?.[0]?.stockQuery || '',
    imageUrl: await resolvePostImage(_videoScript.scenes?.[0]?.stockQuery, _videoScript.scenes?.[0]?.imagePrompt || _videoScript.title),
    status: 'draft',
    scheduledAt: Date.now() + 24*60*60*1000,
    source: 'video-studio',
    isVideo: true,
    videoScenes: (_videoScript.scenes || []).map(s => ({ caption: s.caption, imagePrompt: s.imagePrompt, duration: s.duration })),
  };
  const saved = await Storage.savePost(newPost);
  posts = [saved, ...posts];
  refreshSidebar();
  toast('Saved to library as a draft. Open it to schedule or share.');
  location.hash = '#/library';
}

/* ============================================================
   V4: AUTOPILOT — config + run-now + approval queue
   ============================================================ */
let autopilot = null;

async function loadAutoPilot() {
  try { autopilot = await Storage.getAutoPilot() || null; } catch { autopilot = null; }
  const badge = $('apBadge'); if (badge) badge.style.display = (autopilot?.enabled) ? 'inline-block' : 'none';
}

function renderAutoPilot() {
  const brand = activeBrand();
  if (!brand) {
    $('main').innerHTML = `<p class="intro">Add your first brand to set up AutoPilot.</p>
      <button class="btn primary" onclick="STMZ.newBrand()">+ Add a brand</button>`;
    return;
  }
  const ap = autopilot || { enabled:false, brandId:brand.id, postsPerWeek:5, platforms:['Instagram','LinkedIn'], cadence:'weekly', autoSchedule:false, contentMix:'30% educational, 25% engagement, 20% behind-the-scenes, 15% social proof, 10% offer' };
  const nextRunMs = ap.lastGeneratedAt ? (ap.lastGeneratedAt + (ap.cadence==='daily'?1:7)*24*60*60*1000) : null;
  const pending = posts.filter(p => p.status === 'pending_approval').length;

  $('main').innerHTML = `
    <div class="ap-hero">
      <h3>${ap.enabled ? '⊛ AutoPilot is ON' : '⊛ AutoPilot is OFF'}</h3>
      <p>${ap.enabled
        ? 'Every week the system generates your content using your brand profile and past top-performing posts. ' + (ap.autoSchedule ? 'Posts auto-schedule directly to your calendar.' : 'Posts wait in the approval queue — you review and approve.')
        : 'Turn AutoPilot on and the system will generate your week of content automatically — using insights from your top-performing past posts. Pro &amp; Agency tiers only.'}</p>
      <div class="ap-status-row">
        <div class="ap-status-item">LAST RUN<b>${ap.lastGeneratedAt ? fmtDate(ap.lastGeneratedAt) : '—'}</b></div>
        <div class="ap-status-item">NEXT RUN<b>${nextRunMs ? fmtDate(nextRunMs) : 'when enabled'}</b></div>
        <div class="ap-status-item">PENDING APPROVAL<b>${pending}</b></div>
        <div class="ap-status-item">POSTS / WEEK<b>${ap.postsPerWeek || 5}</b></div>
      </div>
    </div>

    <div class="ap-toggle">
      <div class="lbl"><b>Enable AutoPilot</b><small>Pro or Agency tier required. Generates weekly using your active brand.</small></div>
      <div class="switch ${ap.enabled?'on':''}" onclick="STMZ.apToggleEnabled()"></div>
    </div>

    <h3 style="margin:24px 0 12px;font-family:var(--display);font-weight:600;font-size:17px">Configuration</h3>
    <div class="ap-cfg-grid">
      <div>
        <label class="fld">Posts per week</label>
        <select class="t" id="ap_postsPerWeek">
          ${[3,5,7,10,14,21].map(n=>`<option ${ap.postsPerWeek===n?'selected':''}>${n}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="fld">Cadence</label>
        <select class="t" id="ap_cadence">
          <option value="weekly" ${ap.cadence!=='daily'?'selected':''}>Weekly batch (every Monday)</option>
          <option value="daily" ${ap.cadence==='daily'?'selected':''}>Daily batch</option>
        </select>
      </div>
      <div style="grid-column:1/-1">
        <label class="fld">Platforms</label>
        <div class="ap-platforms">
          ${['Instagram','LinkedIn','TikTok','Facebook','X / Twitter','Telegram'].map(pl => {
            const checked = (ap.platforms||[]).includes(pl);
            return `<label><input type="checkbox" class="ap_pl" value="${pl}" ${checked?'checked':''}><span>${pl}</span></label>`;
          }).join('')}
        </div>
      </div>
      <div style="grid-column:1/-1">
        <label class="fld">Content mix (free text — the AI uses this)</label>
        <input class="t" id="ap_mix" value="${esc(ap.contentMix || '')}" placeholder="e.g. 30% educational, 30% behind-the-scenes, 20% offer, 20% engagement">
      </div>
    </div>

    <div class="ap-toggle" style="margin-top:14px">
      <div class="lbl"><b>Auto-schedule (skip approval)</b><small>If on, generated posts are scheduled directly. If off, they sit in the Approval queue.</small></div>
      <div class="switch ${ap.autoSchedule?'on':''}" onclick="STMZ.apToggleAutoSchedule()"></div>
    </div>

    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:18px">
      <button class="btn primary" onclick="STMZ.apSave()">Save settings</button>
      <button class="btn" onclick="STMZ.apRunNow()" id="apRunBtn">▶ Generate this week now</button>
      ${pending > 0 ? `<button class="btn" onclick="STMZ.apOpenApprovals()">${pending} pending — review &amp; approve →</button>` : ''}
    </div>
  `;
}

function apToggleEnabled() {
  if (!canUseAutoPilot()) {
    showUpgradePrompt('AutoPilot is a Pro and Agency feature — it writes your content every week using past performance data. Upgrade to turn it on.');
    return;
  }
  autopilot = autopilot || { brandId: activeBrandId, postsPerWeek:5, platforms:['Instagram','LinkedIn'], cadence:'weekly', autoSchedule:false };
  autopilot.enabled = !autopilot.enabled;
  autopilot.brandId = activeBrandId;
  renderAutoPilot();
}
function apToggleAutoSchedule() {
  autopilot = autopilot || { brandId: activeBrandId, postsPerWeek:5, platforms:['Instagram','LinkedIn'], cadence:'weekly' };
  autopilot.autoSchedule = !autopilot.autoSchedule;
  renderAutoPilot();
}

async function apSave() {
  autopilot = autopilot || {};
  autopilot.brandId = activeBrandId;
  autopilot.postsPerWeek = parseInt($('ap_postsPerWeek').value, 10) || 5;
  autopilot.cadence = $('ap_cadence').value;
  autopilot.platforms = Array.from(document.querySelectorAll('.ap_pl:checked')).map(el => el.value);
  autopilot.contentMix = $('ap_mix').value.trim();
  if (!autopilot.platforms.length) autopilot.platforms = ['Instagram','LinkedIn'];
  await Storage.setAutoPilot(autopilot);
  await loadAutoPilot();
  toast(autopilot.enabled ? 'AutoPilot settings saved.' : 'Saved — turn the switch ON to start.');
  renderAutoPilot();
}

async function apRunNow() {
  if (!user) { toast('Sign in first to use AutoPilot.'); await login(); return; }
  if (!subscribed || subscribed.tier === 'starter') {
    toast('AutoPilot is a Pro / Agency feature.');
    openPay(); return;
  }
  await apSave();   // make sure latest config is on server
  const btn = $('apRunBtn'); btn.disabled = true; btn.textContent = '⏳ Generating your week…';
  try {
    const token = await authToken();
    const r = await fetch('/api/autopilot/run-now', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+token },
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || 'failed');
    posts = await Storage.listPosts();
    refreshSidebar();
    toast(`✓ Generated ${d.generated} posts. ${autopilot.autoSchedule?'Scheduled directly.':'Review them in Approval queue.'}`);
    renderAutoPilot();
  } catch (err) {
    toast('Failed: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = '▶ Generate this week now';
  }
}

function apOpenApprovals() {
  location.hash = '#/library';
  setTimeout(() => {
    const filterEl = $('libStatus'); if (filterEl) { filterEl.value = 'pending_approval'; refilterLibrary(); }
  }, 100);
}

/* ============================================================
   V4: CAPTION VARIANTS — 3 alternative versions
   ============================================================ */
function openVariants() {
  if (!editingPostId) return;
  const p = posts.find(x => x.id === editingPostId); if (!p) return;
  const cap = $('p_caption').value.trim();
  if (!cap) { toast('Write a caption first, then generate variants.'); return; }
  if (!canRun()) return;
  $('variantsList').innerHTML = `<div style="text-align:center;padding:30px;color:var(--ink-faint);font-family:var(--mono);font-size:12px">Generating 3 variants…</div>`;
  $('variantsModal').classList.add('show');
  (async () => {
    try {
      const token = await authToken();
      const r = await fetch('/api/variants', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) },
        body: JSON.stringify({ caption: cap, brand: (activeBrand() || {}), count:3 })
      });
      if (r.status === 402) { closeVariants(); openPay(); return; }
      if (!r.ok) throw new Error('AI is busy.');
      const d = await r.json();
      if (!d.subscribed) demoBump();
      const labels = ['Bolder', 'More direct', 'More conversational'];
      $('variantsList').innerHTML = (d.variants || []).map((v, i) => `
        <div class="variant-card" onclick="STMZ.useVariant(${i})">
          <div class="vlbl">Variant ${i+1} — ${labels[i] || 'alternative'}</div>
          <div class="vtext">${esc(v)}</div>
        </div>
      `).join('');
      window._variants = d.variants || [];
    } catch (err) {
      $('variantsList').innerHTML = `<div style="padding:20px;color:var(--danger)">Failed: ${err.message}</div>`;
    }
  })();
}
function closeVariants() { $('variantsModal').classList.remove('show'); }
function useVariant(i) {
  const v = (window._variants || [])[i]; if (!v) return;
  $('p_caption').value = v;
  closeVariants();
  toast('Caption replaced with variant ' + (i+1) + '. Save to keep it.');
}

/* ============================================================
   V4: REPURPOSE — adapt this post for another platform
   ============================================================ */
let _repurposed = null;

function openRepurpose() {
  if (!editingPostId) return;
  const p = posts.find(x => x.id === editingPostId); if (!p) return;
  $('rp_target').value = (p.platform === 'LinkedIn' ? 'Instagram' : 'LinkedIn');
  $('rp_status').textContent = '';
  $('rp_result').style.display = 'none';
  $('rp_result').innerHTML = '';
  $('rp_saveBtn').style.display = 'none';
  $('rp_runBtn').disabled = false; $('rp_runBtn').textContent = '▶ Generate adapted version';
  _repurposed = null;
  $('repurposeModal').classList.add('show');
}
function closeRepurpose() { $('repurposeModal').classList.remove('show'); }

async function runRepurpose() {
  if (!editingPostId) return;
  if (!canRun()) return;
  const p = posts.find(x => x.id === editingPostId); if (!p) return;
  const toPlatform = $('rp_target').value;
  const btn = $('rp_runBtn'); btn.disabled = true; btn.textContent = '⏳ Adapting…';
  $('rp_status').textContent = `Adapting for ${toPlatform}…`;
  try {
    const token = await authToken();
    const r = await fetch('/api/repurpose', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) },
      body: JSON.stringify({
        hook: $('p_hook').value, caption: $('p_caption').value,
        hashtags: $('p_hashtags').value.split(/\s+/).filter(Boolean),
        fromPlatform: $('p_platform').value, toPlatform,
        brand: (activeBrand() || {}),
      })
    });
    if (r.status === 402) { closeRepurpose(); openPay(); return; }
    if (!r.ok) throw new Error('AI is busy.');
    const d = await r.json();
    if (!d.subscribed) demoBump();
    _repurposed = { ...d, platform: toPlatform };
    $('rp_status').textContent = `Adapted for ${toPlatform} via ${d.provider || 'AI'}`;
    $('rp_result').style.display = 'block';
    $('rp_result').innerHTML = `
      <div class="rp-result">
        <div class="rp-field"><div class="rp-label">Hook</div><div class="rp-value">${esc(d.hook || '')}</div></div>
        <div class="rp-field"><div class="rp-label">Caption</div><div class="rp-value">${esc(d.caption || '')}</div></div>
        <div class="rp-field"><div class="rp-label">Hashtags</div><div class="rp-value">${esc((d.hashtags || []).join(' '))}</div></div>
        ${d.cta ? `<div class="rp-field"><div class="rp-label">CTA</div><div class="rp-value">${esc(d.cta)}</div></div>` : ''}
      </div>`;
    $('rp_saveBtn').style.display = 'inline-flex';
  } catch (err) {
    $('rp_status').textContent = 'Failed: ' + err.message;
  } finally {
    btn.disabled = false; btn.textContent = '↻ Generate again';
  }
}

async function saveRepurposed() {
  if (!_repurposed) return;
  const brand = activeBrand(); if (!brand) return;
  const newPost = {
    brandId: brand.id,
    platform: _repurposed.platform,
    hook: _repurposed.hook || '',
    caption: _repurposed.caption || '',
    hashtags: _repurposed.hashtags || [],
    cta: _repurposed.cta || '',
    imagePrompt: _repurposed.imagePrompt || '',
    stockQuery: _repurposed.stockQuery || '',
    imageUrl: await resolvePostImage(_repurposed.stockQuery, _repurposed.imagePrompt || _repurposed.hook),
    status: 'draft',
    scheduledAt: Date.now() + 24*60*60*1000,
    source: 'repurpose',
  };
  const saved = await Storage.savePost(newPost);
  posts = [saved, ...posts];
  refreshSidebar();
  closeRepurpose();
  toast('Adapted version saved as a new draft.');
  editPost(saved.id);
}

/* ============================================================
   BRAND MODAL
   ============================================================ */
function renderBrandSelect() {
  const sel = $('brandSel');
  if (!brands.length) { sel.innerHTML = '<option value="">No brand yet</option>'; return; }
  sel.innerHTML = brands.map(b => `<option value="${b.id}" ${b.id===activeBrandId?'selected':''}>${esc(b.name)}</option>`).join('');
}
async function selectBrand(id) { activeBrandId = id; await Storage.setActiveBrand(id); router(); }

function newBrand() {
  // Pre-flight tier check — show the upgrade flow before opening the form.
  if (brands.length >= tierBrandLimit()) {
    const t = currentTier();
    const limit = tierBrandLimit();
    showUpgradePrompt(`Your ${t.name} plan allows ${limit} brand profile${limit > 1 ? 's' : ''}. Upgrade to add more.`);
    return;
  }
  fillBrandFields(null); $('brandTitle').textContent = 'New brand'; $('brandModal').classList.add('show');
}
function editBrand() { const b = activeBrand(); if (!b) return newBrand(); fillBrandFields(b); $('brandTitle').textContent = 'Edit brand'; $('brandModal').classList.add('show'); }
function editBrandById(id) { const b = brands.find(x => x.id === id); if (!b) return; fillBrandFields(b); $('brandTitle').textContent = 'Edit brand'; $('brandModal').classList.add('show'); }
function fillBrandFields(b) {
  $('b_name').value = b?.name || ''; $('b_what').value = b?.what || '';
  $('b_aud').value = b?.audience || ''; $('b_tone').value = b?.tone || ''; $('b_offer').value = b?.offer || '';
  $('brandModal').dataset.editing = b?.id || '';
}
function closeBrand() { $('brandModal').classList.remove('show'); }

/* ============================================================
   TIER HELPERS — single source of truth for "can the user do X?"
   ============================================================ */
/* ============================================================
   FOUNDER MODE — unlimited access for the admin emails in this list.
   Edit this list (and the ADMIN_EMAILS env var on the server) with
   YOUR Gmail address. Founder mode bypasses every tier limit on the
   client. The server enforces the same bypass via its env var.
   ============================================================ */
const ADMIN_EMAILS = [
  'salmanyousafpk571@gmail.com',
];
function isFounder() {
  const e = (user?.email || '').toLowerCase();
  return !!e && ADMIN_EMAILS.map(x => x.toLowerCase()).includes(e);
}
const FOUNDER_TIER = {
  id: 'founder', name: 'Founder', price: 0,
  brands: Infinity, postsPerMonth: null,
  linkedin: true, webhook: true, priority: true, maxVideoSec: 120,
};

function currentTier() {
  if (isFounder()) return FOUNDER_TIER;
  // Returns the tier object the user is currently on.
  // `subscribed` is either `false` (no sub) or `{ expiresAt, tier }`.
  if (subscribed && subscribed.tier) {
    const t = TIERS.find(x => x.id === subscribed.tier);
    if (t) return t;
  }
  return { id:'free', name:'Free', price:0, brands:1, postsPerMonth:null, linkedin:false, webhook:false, priority:false };
}
function tierBrandLimit() {
  const t = currentTier();
  return t.brands === Infinity ? Number.MAX_SAFE_INTEGER : (t.brands || 1);
}
function canAddMoreBrands() {
  if (isFounder()) return true;
  const editing = $('brandModal')?.dataset.editing;
  if (editing) return true;  // editing an existing brand is always allowed
  return brands.length < tierBrandLimit();
}
function canUseAutoPilot() {
  if (isFounder()) return true;
  if (!subscribed) return false;
  const t = currentTier();
  return t.id === 'pro' || t.id === 'agency';
}
function canUseWebhook() {
  if (isFounder()) return true;
  if (!subscribed) return false;
  return !!currentTier().webhook;
}
function showUpgradePrompt(reason) {
  if (isFounder()) return;  // founders never see upgrade prompts
  const t = currentTier();
  toast(reason);
  setTimeout(() => openPay(), 600);
}

async function saveBrand() {
  const name = $('b_name').value.trim();
  if (!name) { toast('Brand name is required.'); return; }
  const editing = $('brandModal').dataset.editing;
  // Tier limit: block if creating a new brand would exceed the plan limit.
  if (!editing && !canAddMoreBrands()) {
    const t = currentTier();
    const limit = tierBrandLimit();
    showUpgradePrompt(`Your ${t.name} plan allows ${limit} brand profile${limit > 1 ? 's' : ''}. Upgrade to add more.`);
    return;
  }
  const data = {
    id: editing || undefined,
    name, what: $('b_what').value.trim(), audience: $('b_aud').value.trim(),
    tone: $('b_tone').value.trim(), offer: $('b_offer').value.trim(),
  };
  const saved = await Storage.saveBrand(data);
  const i = brands.findIndex(b => b.id === saved.id);
  if (i >= 0) brands[i] = saved; else brands.push(saved);
  if (!activeBrandId) { activeBrandId = saved.id; await Storage.setActiveBrand(saved.id); }
  renderBrandSelect(); closeBrand(); router(); toast('Brand saved.');
}

/* ============================================================
   GATING (demo limit, paywall)
   ============================================================ */
function canRun() {
  if (subscribed) return true;
  if (demoLeft() > 0) return true;
  openPay(); return false;
}

function openPay() {
  $('payHeading').textContent = subscribed ? 'Manage your plan' : 'Choose your plan';
  $('signInNote').innerHTML = user ? '' : 'Tip: <a class="signal" href="#" onclick="STMZ.login();return false;">sign in</a> first so your subscription stays linked to you.';
  renderTierGrid();
  $('payModal').classList.add('show');
}
function closePay() { $('payModal').classList.remove('show'); }

function renderTierGrid() {
  const currentTier = subscribed?.tier || null;
  const grid = $('tierGrid');
  if (!grid) return;
  grid.innerHTML = TIERS.map(t => {
    const featured = t.id === 'pro';
    const current = currentTier === t.id;
    const brandsLine = t.brands === Infinity ? 'Unlimited brands' : `${t.brands} brand${t.brands>1?'s':''}`;
    const postsLine = t.postsPerMonth ? `${t.postsPerMonth} posts / month` : 'Unlimited posts';
    return `
      <div class="tier-card ${featured?'featured':''} ${current?'current':''}">
        ${featured ? '<div class="ribbon">Most popular</div>' : ''}
        <h4>${t.name}</h4>
        <div class="price">$${t.price}<small> / month</small></div>
        <ul>
          <li>${brandsLine}</li>
          <li>${postsLine}</li>
          <li class="${t.linkedin?'':'off'}">LinkedIn direct posting</li>
          <li class="${t.webhook?'':'off'}">Universal webhook (Instagram, TikTok, X, etc.)</li>
          <li class="${t.priority?'':'off'}">Priority AI (faster, larger context)</li>
          <li>${t.id==='agency'?'Team seats coming soon':'Email support'}</li>
        </ul>
        <button class="btn ${featured?'primary':''}" onclick="STMZ.subscribe('${t.id}')">${current?'Current plan':'Choose '+t.name}</button>
      </div>
    `;
  }).join('');
}

/* ============================================================
   ONBOARDING WIZARD (first-time user, no brands yet)
   ============================================================ */
let onbStep = 1;
const ONB_FLAG = 'stmz_onb_done';

function maybeStartOnboarding() {
  if (localStorage.getItem(ONB_FLAG)) return false;
  if (brands && brands.length > 0) { localStorage.setItem(ONB_FLAG, '1'); return false; }
  if (!$('app').classList.contains('active')) return false;
  onbStep = 1;
  showOnbStep(1);
  $('onbModal').classList.add('show');
  return true;
}

function showOnbStep(n) {
  [1,2,3].forEach(i => {
    const el = $('onbStep'+i); if (el) el.style.display = (i===n) ? 'block' : 'none';
  });
  document.querySelectorAll('#onbProgress .dot').forEach((d, idx) => {
    d.classList.toggle('active', (idx+1) <= n);
  });
}

async function onbNext() {
  if (onbStep === 1) { onbStep = 2; showOnbStep(2); return; }
  if (onbStep === 2) {
    const name = $('onb_name').value.trim();
    const what = $('onb_what').value.trim();
    if (!name || !what) { toast('Brand name and what you sell are required.'); return; }
    const brand = { id: uuid(), name, what, audience: $('onb_audience').value.trim(), tone: $('onb_tone').value, offer: '' };
    brands = [...brands, brand];
    activeBrandId = brand.id;
    await Storage.saveBrand(brand);
    await Storage.setActiveBrandId(brand.id);
    renderBrandSelect();
    onbStep = 3; showOnbStep(3); return;
  }
}
function onbBack() { if (onbStep > 1) { onbStep--; showOnbStep(onbStep); } }
function onbSkip() { localStorage.setItem(ONB_FLAG,'1'); $('onbModal').classList.remove('show'); }
function onbFinish(dest) {
  localStorage.setItem(ONB_FLAG, '1');
  $('onbModal').classList.remove('show');
  location.hash = '#/' + (dest || 'dashboard');
}

/* ============================================================
   AUTH + PADDLE
   ------------------------------------------------------------
   Sign-in tries a popup first (fastest, no page reload). Some
   browser setups silently hang the popup instead of erroring
   (stale FedCM/third-party-cookie state, certain extensions) —
   so if it hasn't resolved within POPUP_TIMEOUT_MS, we abandon
   it and fall back to a full-page redirect sign-in instead,
   which doesn't depend on popup/cookie communication at all.
   ============================================================ */
const POPUP_TIMEOUT_MS = 8000;

async function login() {
  if (!isConfigured) { toast('Add your Firebase keys in firebase-config.js to enable sign-in.'); return; }
  showSignInOverlay();
  try {
    await Promise.race([
      signInWithPopup(auth, provider),
      new Promise((_, reject) => setTimeout(() => reject(new Error('popup-timeout')), POPUP_TIMEOUT_MS)),
    ]);
    closePay();
    hideSignInOverlay();
  } catch (e) {
    console.warn('[stmz] popup sign-in did not complete, falling back to redirect:', e && e.message);
    // Any popup failure (blocked, hung, closed, third-party-cookie issues) —
    // fall back to redirect, which works even when popups can't.
    if (e && e.code === 'auth/popup-closed-by-user') {
      // User deliberately closed it — don't force a redirect on them.
      hideSignInOverlay();
      return;
    }
    try {
      updateSignInOverlay('Popup sign-in isn\u2019t completing here — redirecting you to Google instead\u2026');
      await signInWithRedirect(auth, provider);
      // Page navigates away here; nothing after this line runs.
    } catch (e2) {
      console.warn('[stmz] redirect sign-in also failed:', e2);
      hideSignInOverlay();
      toast('Sign-in is having trouble in this browser. Try clearing site data, a different browser, or contact support@stmzkinetic.com.');
    }
  }
}
function showSignInOverlay() {
  if (document.getElementById('signinOverlay')) return;
  const o = document.createElement('div');
  o.id = 'signinOverlay';
  o.innerHTML = `
    <div class="so-card">
      <div class="so-spinner"></div>
      <h3 class="so-title">Signing you in…</h3>
      <p class="so-sub" id="signinOverlaySub">A Google sign-in popup is opening. If you don't see it, check your browser's popup blocker.</p>
    </div>`;
  document.body.appendChild(o);
}
function updateSignInOverlay(msg) {
  const el = document.getElementById('signinOverlaySub');
  if (el) el.textContent = msg;
}
function hideSignInOverlay() {
  const o = document.getElementById('signinOverlay');
  if (o) o.remove();
}
async function logout() {
  try { await signOut(auth); } catch {}
  // Privacy: nuke any cached workspace data from this browser so the next
  // visitor (or a different Google account in the same browser) doesn't see
  // anything that was tied to the previous signed-in user.
  try { Storage.clearAllLocal(); } catch {}
  // Hard reload to reset all in-memory state.
  location.reload();
}
function toggleAuth(e) { if (e) e.preventDefault(); user ? logout() : login(); }

async function refreshSub() {
  subscribed = false;
  const t = await authToken();
  if (t) {
    try {
      const r = await fetch('/api/me', { headers:{ Authorization:'Bearer '+t } });
      const d = await r.json();
      if (d.active) subscribed = { expiresAt: d.expiresAt, tier: d.tier || 'pro' };
    } catch {}
  }
  refreshSidebar();
}

if (isConfigured && auth) {
  // If we just came back from a redirect sign-in (fallback path), surface
  // any error here — onAuthStateChanged below handles the success case.
  getRedirectResult(auth).catch(e => {
    console.warn('[stmz] redirect sign-in result error:', e);
    toast('Sign-in didn\u2019t complete. Please try again or contact support@stmzkinetic.com.');
  }).finally(() => hideSignInOverlay());

  onAuthStateChanged(auth, async (u) => {
    user = u;
    Storage.setUser(u);
    if (u) await Storage.migrateLocalToCloud();
    brands = await Storage.listBrands();
    activeBrandId = await Storage.getActiveBrandId() || (brands[0] && brands[0].id) || null;
    if (activeBrandId && !brands.find(b => b.id === activeBrandId)) activeBrandId = brands[0]?.id || null;
    posts = await Storage.listPosts();
    await loadIntegrations();
    await loadAutoPilot();
    renderBrandSelect();
    await refreshSub();
    router();
    maybeStartOnboarding();
    hideSignInOverlay();
  });
} else {
  (async () => {
    brands = await Storage.listBrands();
    activeBrandId = await Storage.getActiveBrandId() || (brands[0] && brands[0].id) || null;
    posts = await Storage.listPosts();
    await loadIntegrations();
    await loadAutoPilot();
    renderBrandSelect(); refreshSidebar(); router();
    maybeStartOnboarding();
  })();
}

let paddleReady = false;
function initPaddle() {
  if (paddleReady || !window.Paddle || paddleConfig.clientToken.startsWith('PASTE_')) return;
  try {
    window.Paddle.Environment.set(paddleConfig.environment);
    window.Paddle.Initialize({
      token: paddleConfig.clientToken,
      eventCallback: (ev) => { if (ev.name === 'checkout.completed') { toast('Payment complete — unlocking…'); setTimeout(refreshSub, 4000); } }
    });
    paddleReady = true;
  } catch (e) { console.warn('Paddle init', e); }
}

async function subscribe(tierId) {
  if (typeof tierId === 'object' && tierId?.preventDefault) { tierId.preventDefault(); tierId = 'pro'; } // legacy call signature
  tierId = tierId || 'pro';
  if (!user) { toast('Sign in first so we can link your subscription.'); await login(); if (!user) return; }
  initPaddle();
  // Pick the right Paddle price id for the tier
  const priceMap = { starter: paddleConfig.priceStarter, pro: paddleConfig.pricePro, agency: paddleConfig.priceAgency };
  const priceId = priceMap[tierId] || paddleConfig.priceId;
  if (!paddleReady || !priceId || priceId.startsWith('PASTE_')) {
    toast('Payments not configured yet — see PADDLE_PAYONEER_SETUP.md');
    return;
  }
  window.Paddle.Checkout.open({
    items: [{ priceId, quantity: 1 }],
    customer: { email: user.email },
    customData: { uid: user.uid, tier: tierId }
  });
}

/* ============================================================
   BOOT
   ============================================================ */

/* GLOBAL IMAGE FALLBACK
   If ANY <img> on ANY page fails to load (Pollinations down, network blip,
   404, slow CDN), swap to a deterministic Picsum photo so the user never
   sees an empty image area. Capture-phase listener runs before the img's
   own onerror; works for images injected at any time. */
document.addEventListener('error', (e) => {
  const el = e.target;
  if (!el || el.tagName !== 'IMG') return;
  if (el.dataset.stmzFallback) return;
  el.dataset.stmzFallback = '1';
  const seedSrc = (el.alt || el.src || 'stmz' + Math.random()).slice(0, 80);
  let seed = 0;
  for (let i = 0; i < seedSrc.length; i++) seed = (seed * 31 + seedSrc.charCodeAt(i)) | 0;
  el.src = `https://picsum.photos/seed/${Math.abs(seed)}/768/768`;
}, true);  // capture phase = we beat the element's own onerror

if ('serviceWorker' in navigator) {
  // Single registration; the controllerchange listener auto-reloads tabs
  // when a new SW takes over (sw.js itself calls skipWaiting on install
  // and clients.claim on activate, so the chain Just Works).
  let _reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_reloaded) return;
    _reloaded = true;
    location.reload();
  });
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      // Check for updates every 10 min so long-open tabs catch deploys.
      setInterval(() => reg.update().catch(()=>{}), 10 * 60 * 1000);
    } catch (e) { console.warn('[STMZ] SW registration failed:', e); }
  });
}
$('yr') && ($('yr').textContent = new Date().getFullYear());

window.STMZ = {
  launch, goHome, toggleSidebar, toggleAuth, login, logout, subscribe, closePay,
  selectBrand, newBrand, editBrand, editBrandById, closeBrand, saveBrand, makeActive, removeBrand,
  runGenerate, refilterLibrary, exportLibrary, useTemplate, calNav, calToday,
  editPost, closePost, savePost, deletePost, aiRewritePost, copyPostText, cyclePostStatus, copyPostById,
  // Phase 2: ideas, assistant, integrations, share
  runIdeas, ideaToPost, copyIdea,
  sendChat,
  linkedinConnect, linkedinDisconnect,
  saveWebhook, clearWebhook, testWebhook, showWebhookHelp, oneClickConnect,
  tgSave, tgDisconnect, tgTest, tgHelp,
  supportContact, supportCopy, supportCopyEmail,
  regenPostImage,
  shareNative, shareTo, postToLinkedIn, shareViaWebhook,
  // Phase 2.5: onboarding
  onbNext, onbBack, onbSkip, onbFinish,
  // Phase 3: video maker
  openVideoModal, closeVideoModal, makeVideo,
  // Phase 4: autopilot, variants, repurpose
  apToggleEnabled, apToggleAutoSchedule, apSave, apRunNow, apOpenApprovals,
  // Best Time to Post planner
  plannerFill,
  renderMonthPlan, monthPlanGenerate, mpUpdateCount,
  openVariants, closeVariants, useVariant,
  openRepurpose, closeRepurpose, runRepurpose, saveRepurposed,
  // Phase 5: video studio
  vsGenerateScript, vsEditScene, vsMakeVideo, vsRedownload, vsSaveAsPost,
  vsAudioPicked, vsAudioClear, vsLengthChanged, vsTestVoice,
  openPay,
  // Phase 6: content lift
  liftMode, runLift, saveOneLift, saveAllLift, dropOneLift,
  // Phase 7: reply assistant, analytics, bulk products
  runReply, copyReply,
  runInsights,
  runBulk, saveBulkPost, saveAllBulk,
};

/* Service worker auto-update wiring above ensures users always get the
   newest deploy on next page load (controllerchange listener + sw.js's
   own skipWaiting / clients.claim). No second registration needed. */

console.log('%cSTMZ Kinetic %cv6.5', 'color:#bdf36d;font-weight:bold;font-family:monospace', 'color:#666;font-family:monospace');
