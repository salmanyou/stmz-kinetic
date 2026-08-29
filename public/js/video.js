/* ============================================================
   STMZ KINETIC — Video generator (browser-native, no deps)
   ------------------------------------------------------------
   Generates a social-media video from a post's image + text
   using Canvas + MediaRecorder. Completely free, runs entirely
   in the user's browser, no third-party service.

   Output: WebM (universally supported on Android, web, YouTube
   Shorts, Telegram, WhatsApp). For Instagram / TikTok / X you
   may need to convert WebM → MP4 (free at cloudconvert.com).
   ============================================================ */

const SAFE_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Arabic", "Noto Sans Devanagari", "Noto Sans CJK SC", "Noto Sans JP", "Noto Sans KR", "Noto Sans Bengali", "Noto Sans Thai", "Arial Unicode MS", sans-serif';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Canvas-safe URL: route through our same-origin proxy to avoid CORS taint.
function canvasSafeUrl(url) {
  if (!url) return url;
  if (url.startsWith('https://image.pollinations.ai/') ||
      url.startsWith('https://images.pexels.com/') ||
      url.startsWith('https://videos.pexels.com/') ||
      url.startsWith('https://player.vimeo.com/') ||
      url.startsWith('https://download.pexels.com/') ||
      url.startsWith('https://picsum.photos/')) {
    return `/api/img-proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

// Hard-timeout image loader with size validation.
// Returns the Image element OR throws on timeout / load error / 0-size image.
function loadImageWithTimeout(url, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let done = false;
    const finalize = (ok, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ok ? resolve(img) : reject(err || new Error('image load failed'));
    };
    const timer = setTimeout(() => finalize(false, new Error('timeout after ' + timeoutMs + 'ms')), timeoutMs);
    img.onload = () => {
      // Validate the image actually has pixels (a proxy that returned an error
      // page would set naturalWidth/Height to 0 once decoded).
      if (img.naturalWidth < 16 || img.naturalHeight < 16) {
        finalize(false, new Error(`image too small: ${img.naturalWidth}x${img.naturalHeight}`));
      } else {
        finalize(true);
      }
    };
    img.onerror = (e) => finalize(false, new Error('decode error'));
    img.src = url;
  });
}

/* Multi-source image fetcher used by video generation.
   Accepts EITHER a string (legacy) OR { stockQuery, imagePrompt }.
   1. Pexels search using stockQuery (short, concrete, photographable).
   2. Pollinations turbo using imagePrompt (longer, more specific).
   3. Picsum (random but always works).
   4. Returns null — caller renders gradient + text only.
   Console-logs every step for DevTools debugging. */
async function fetchSceneImage(promptOrObj, { orientation = 'landscape' } = {}) {
  const log = (...args) => console.log('[stmz/image]', ...args);
  const isObj = promptOrObj && typeof promptOrObj === 'object';
  const stockQuery   = isObj ? (promptOrObj.stockQuery   || '') : '';
  const imagePrompt  = isObj ? (promptOrObj.imagePrompt  || promptOrObj.fallback || '') : (promptOrObj || '');
  const pexelsQuery  = (stockQuery || imagePrompt).slice(0, 80).trim();
  const polPrompt    = (imagePrompt || stockQuery).slice(0, 180).trim();
  if (!pexelsQuery && !polPrompt) return null;

  // ---- 1. Pexels (instant, professional) ----
  if (pexelsQuery) {
    try {
      const r = await fetch(`/api/stock-image?query=${encodeURIComponent(pexelsQuery)}&orient=${orientation}`);
      if (r.ok) {
        const j = await r.json();
        if (j.url) {
          try {
            log('Pexels ←', pexelsQuery, '→', j.url);
            const img = await loadImageWithTimeout(canvasSafeUrl(j.url), { timeoutMs: 20000 });
            return img;
          } catch (e) { log('Pexels load failed:', e.message); }
        } else {
          log('Pexels skipped:', j.reason);
        }
      }
    } catch (e) { log('Pexels fetch error:', e.message); }
  }

  // ---- 2. Pollinations turbo (free AI gen) ----
  if (polPrompt) {
    try {
      const seed = Math.floor(Math.random() * 9_000_000);
      const polUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(polPrompt)}?model=turbo&width=1024&height=1024&seed=${seed}&nologo=true&nofeed=true`;
      log('Pollinations ←', polPrompt.slice(0, 60));
      const img = await loadImageWithTimeout(canvasSafeUrl(polUrl), { timeoutMs: 35000 });
      return img;
    } catch (e) { log('Pollinations failed:', e.message); }
  }

  // ---- 3. Picsum (always returns SOMETHING) ----
  try {
    const seedStr = pexelsQuery || polPrompt;
    const seed = Math.abs(Array.from(seedStr).reduce((a,c) => (a*31+c.charCodeAt(0))|0, 0));
    const picsumUrl = `https://picsum.photos/seed/${seed}/1024/1024`;
    log('Picsum ←', picsumUrl);
    const img = await loadImageWithTimeout(canvasSafeUrl(picsumUrl), { timeoutMs: 15000 });
    return img;
  } catch (e) { log('Picsum failed:', e.message); }

  log('All sources failed — scene renders with gradient only');
  return null;
}

/* Load a video clip element (returns HTMLVideoElement, not Image).
   Used so the canvas drawImage call gets MOTION, not just a still frame.
   Video element is muted (we add narration separately), loops if shorter
   than scene duration. */
/* Load a video clip element using the BLOB URL trick: fetch the bytes
   through our proxy, create a same-origin Object URL from the Blob, then
   set that as the video src. This avoids the canvas-tainting issue that
   plagues remote <video> elements + canvas.drawImage + MediaRecorder.

   Returns { video, blobUrl } so the caller can revoke the URL after use. */
async function loadVideoClip(url, { timeoutMs = 60000 } = {}) {
  // Fetch through the proxy (which is same-origin for us)
  const proxied = canvasSafeUrl(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let blob;
  try {
    const r = await fetch(proxied, { signal: ctrl.signal });
    if (!r.ok) { clearTimeout(t); throw new Error('video proxy ' + r.status); }
    blob = await r.blob();
  } finally { clearTimeout(t); }
  if (!blob || blob.size < 4096) throw new Error('video too small');

  // Build same-origin blob URL — no CORS, no taint, no MediaRecorder issues
  const blobUrl = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.loop = true;
  v.preload = 'auto';

  await new Promise((resolve, reject) => {
    let done = false;
    const finalize = (ok, err) => {
      if (done) return;
      done = true;
      clearTimeout(loadTimer);
      ok ? resolve() : reject(err || new Error('video decode failed'));
    };
    const loadTimer = setTimeout(() => finalize(false, new Error('video load timeout')), 20000);
    v.onloadeddata = () => {
      if (v.videoWidth < 16 || v.videoHeight < 16) finalize(false, new Error('video too small'));
      else finalize(true);
    };
    v.onerror = () => finalize(false, new Error('video element error'));
    v.src = blobUrl;
  });
  return { video: v, blobUrl };
}

/* Try Pexels Video first (real motion), fall back to fetchSceneImage (stills). */
async function fetchSceneMedia(promptOrObj, { orientation = 'portrait', preferVideo = true } = {}) {
  const log = (...args) => console.log('[stmz/video]', ...args);
  const isObj = promptOrObj && typeof promptOrObj === 'object';
  const stockQuery = isObj ? (promptOrObj.stockQuery || '') : '';
  const imagePrompt = isObj ? (promptOrObj.imagePrompt || '') : (promptOrObj || '');
  const query = (stockQuery || imagePrompt).slice(0, 80).trim();

  if (preferVideo && query) {
    try {
      const r = await fetch(`/api/stock-video?query=${encodeURIComponent(query)}&orient=${orientation}`);
      if (r.ok) {
        const j = await r.json();
        if (j.url) {
          try {
            log('Pexels video ←', query);
            const { video, blobUrl } = await loadVideoClip(j.url);
            return { kind: 'video', el: video, blobUrl };
          } catch (e) { log('Video clip load failed, falling back to still:', e.message); }
        } else { log('No video for', query, '·', j.reason); }
      }
    } catch (e) { log('Video fetch error:', e.message); }
  }

  // Fall back to still image (Pexels photo → Pollinations → Picsum)
  const img = await fetchSceneImage(promptOrObj, { orientation });
  return img ? { kind: 'image', el: img } : null;
}

/* Generate a TTS audio Audio element for a caption. Uses StreamElements
   via our /api/tts proxy. Returns { audio: HTMLAudioElement, duration: seconds }
   or null if it failed. */
async function loadTTS(text, voiceId, lang = 'en') {
  if (!text || !voiceId || voiceId === 'none') return null;
  try {
    const url = `/api/tts?voice=${encodeURIComponent(voiceId)}&lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(text.slice(0, 500))}`;
    // Pre-fetch to ensure it's available
    const r = await fetch(url);
    if (!r.ok) { console.warn('[stmz/tts] upstream failed', r.status); return null; }
    const blob = await r.blob();
    const audio = new Audio(URL.createObjectURL(blob));
    audio.preload = 'auto';
    await new Promise((resolve) => {
      const done = () => resolve();
      audio.onloadedmetadata = done;
      audio.oncanplaythrough = done;
      audio.onerror = done;
      setTimeout(done, 8000);  // hard timeout
    });
    const dur = isFinite(audio.duration) ? audio.duration : 3;
    return { audio, duration: dur };
  } catch (e) {
    console.warn('[stmz/tts] error:', e);
    return null;
  }
}

// Legacy single-URL loader (used for posts that already have a Pollinations URL).
function loadImage(url, { retries = 1 } = {}) {
  return new Promise((resolve, reject) => {
    const tryOnce = (src, attemptsLeft) => {
      loadImageWithTimeout(src, { timeoutMs: 30000 })
        .then(resolve)
        .catch(e => {
          if (attemptsLeft > 0) setTimeout(() => tryOnce(src, attemptsLeft - 1), 1500);
          else reject(e);
        });
    };
    tryOnce(canvasSafeUrl(url), retries);
  });
}

function wrapText(ctx, text, x, y, maxW, lineH) {
  const words = (text || '').split(/\s+/);
  let line = '';
  const lines = [];
  for (let i = 0; i < words.length; i++) {
    const test = line + words[i] + ' ';
    const m = ctx.measureText(test);
    if (m.width > maxW && line) { lines.push(line.trim()); line = words[i] + ' '; }
    else line = test;
  }
  if (line.trim()) lines.push(line.trim());
  lines.forEach((ln, i) => ctx.fillText(ln, x, y + i * lineH));
  return lines.length;
}

async function renderSlide(ctx, slide, W, H, t) {
  // Background
  ctx.fillStyle = '#0a0b0a';
  ctx.fillRect(0, 0, W, H);

  // Image (cover-fit, with a slow zoom over time t = 0..1)
  if (slide._img) {
    const img = slide._img;
    const zoom = 1.05 + t * 0.08;                      // gentle Ken Burns
    const scale = Math.max(W / img.width, H / img.height) * zoom;
    const dw = img.width * scale, dh = img.height * scale;
    const dx = (W - dw) / 2 + (t - 0.5) * 20;
    const dy = (H - dh) / 2 + (t - 0.5) * 12;
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  // Dark gradient overlay so text reads
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.4, 'rgba(0,0,0,0.20)');
  grad.addColorStop(1, 'rgba(0,0,0,0.75)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Hook (top, big)
  if (slide.hook) {
    const hookSize = Math.round(W * 0.062);
    ctx.font = `700 ${hookSize}px ${SAFE_FONT}`;
    ctx.fillStyle = '#e7ffd0';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 18;
    wrapText(ctx, slide.hook, W/2, H*0.28, W*0.86, hookSize * 1.15);
    ctx.shadowBlur = 0;
  }

  // Caption (middle, smaller)
  if (slide.caption) {
    const capSize = Math.round(W * 0.035);
    ctx.font = `500 ${capSize}px ${SAFE_FONT}`;
    ctx.fillStyle = '#f4f5f0';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 12;
    wrapText(ctx, slide.caption.slice(0, 220), W/2, H*0.55, W*0.84, capSize * 1.35);
    ctx.shadowBlur = 0;
  }

  // Hashtags (bottom)
  if (slide.hashtags && slide.hashtags.length) {
    const tagSize = Math.round(W * 0.028);
    ctx.font = `500 ${tagSize}px ${SAFE_FONT}`;
    ctx.fillStyle = '#c0d896';
    ctx.textAlign = 'center';
    const tagLine = slide.hashtags.slice(0, 6).join('  ');
    ctx.fillText(tagLine, W/2, H * 0.88);
  }

  // Branding watermark (faint)
  ctx.font = `500 ${Math.round(W*0.018)}px ${SAFE_FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.textAlign = 'right';
  ctx.fillText('made with stmz', W - W*0.04, H - W*0.025);
}

/**
 * Generate a single-post video.
 * @param {Object} opts
 * @param {Object} opts.post     - { hook, caption, hashtags, imageUrl }
 * @param {Object} opts.size     - { w, h }  e.g. {w:1080,h:1080} square, {w:1080,h:1920} 9:16
 * @param {Number} opts.seconds  - total duration
 * @param {Function} opts.onProgress - (0..1)
 * @returns {Promise<Blob>}      - WebM video
 */
export async function generatePostVideo({ post, size, seconds = 6, onProgress }) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    throw new Error('Your browser does not support video capture. Try Chrome, Edge or Firefox.');
  }

  const W = size?.w || 1080, H = size?.h || 1080;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Pre-load the image (so the first frame isn't blank).
  // Tries: provided imageUrl first → Pexels search by prompt → Pollinations → Picsum.
  // Guarantees the video isn't completely blank even if everything else fails.
  if (post.imageUrl) {
    try {
      post._img = await loadImage(post.imageUrl, { retries: 1 });
    } catch (e) {
      console.warn('Original image failed, falling back to multi-source:', e.message);
      try {
        post._img = await fetchSceneImage(post.hook || post.caption || 'lifestyle photography', { orientation: H > W ? 'portrait' : 'landscape' });
      } catch (e2) { console.warn('Multi-source also failed, text-only video:', e2.message); }
    }
  }

  // Pick best mime type the browser supports
  const candidates = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
  const mime = candidates.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

  const stopped = new Promise(res => { recorder.onstop = res; });
  recorder.start(100);

  // Render frames for `seconds` seconds at 30fps
  const totalFrames = seconds * 30;
  const start = performance.now();
  for (let f = 0; f < totalFrames; f++) {
    const t = f / totalFrames;
    await renderSlide(ctx, post, W, H, t);
    if (onProgress) onProgress(t);
    // Pace to real time so the canvas stream stays in sync
    const target = start + (f + 1) * (1000 / 30);
    const wait = target - performance.now();
    if (wait > 0) await sleep(wait);
  }

  recorder.stop();
  await stopped;
  if (onProgress) onProgress(1);
  const blob = new Blob(chunks, { type: mime });
  console.log('[stmz/video] post video blob:', blob.size, 'bytes, mime:', mime);
  if (blob.size < 1024) {
    throw new Error(`Video render produced ${blob.size} bytes — your browser may have blocked the capture. Try: (1) reload the page, (2) try Chrome or Edge.`);
  }
  return blob;
}

/** Trigger a download of a blob with a given filename. */
export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/**
 * Generate a MULTI-SCENE story video — the V5 prompt-to-video feature.
 * Each scene has its own AI image and on-screen caption with crossfade transitions.
 * @param {Object} opts
 * @param {Array}  opts.scenes  - [{ caption, imageUrl, duration }, ...]
 * @param {Object} opts.size    - { w, h }
 * @param {Function} opts.onProgress - called with 0..1 throughout
 * @param {Function} opts.onStatus   - called with status text
 * @returns {Promise<Blob>}
 */
/* Convert a user-uploaded audio file into a MediaStream that can be mixed
   into the canvas-captured video stream. Loops the audio to cover the full
   video length. Returns { stream, source, audioCtx } so we can stop it
   cleanly after recording. */
async function makeAudioStream(audioFile) {
  if (!audioFile) return null;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('AudioContext not supported in this browser');
    const audioCtx = new AudioCtx();
    const buf = await audioFile.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(buf);
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.loop = true;
    // Tiny duck so beats don't clip in playback
    const gain = audioCtx.createGain();
    gain.gain.value = 0.85;
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(dest);
    source.start();
    return { stream: dest.stream, source, audioCtx };
  } catch (err) {
    console.warn('[stmz/audio] failed to decode audio:', err.message);
    return null;
  }
}

export async function generateStoryVideo({ scenes, size, style = {}, audioFile = null, voice = 'none', preWarmedAudioCtx = null, onProgress, onStatus }) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    throw new Error('Your browser does not support video capture. Use Chrome, Edge or Firefox.');
  }
  if (!scenes || !scenes.length) throw new Error('No scenes provided.');

  const W = size?.w || 1080, H = size?.h || 1920;
  const styleOpts = {
    captionColor:    style.captionColor    || '#e7ffd0',
    captionPosition: style.captionPosition || 'bottom',
    captionStyle:    style.captionStyle    || 'bold',
    subtitleMode:    style.subtitleMode    || 'word-by-word',
    showWatermark:   style.showWatermark !== false,
    brandName:       style.brandName       || '',
  };

  // Track every blob URL we create so we can revoke them after recording
  // (prevents memory leaks across multiple video generations).
  const blobUrlsToRevoke = [];

  // ---- AUDIO CONTEXT SETUP ----
  // CRITICAL: prefer the AudioContext already resumed in the click handler.
  // That context is still inside the user-gesture window. If we create one
  // here (after several awaits), the browser autoplay policy will leave it
  // suspended and MediaRecorder will hang waiting for audio data.
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioCtx = preWarmedAudioCtx || null;
  const useTTS = voice && voice !== 'none';
  const useMusic = !!audioFile;
  let audioBlocked = false;

  if ((useTTS || useMusic) && !audioCtx && AudioCtx) {
    // No pre-warm — last resort attempt (often blocked by autoplay policy).
    try {
      audioCtx = new AudioCtx();
      if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch {}
      }
    } catch {}
  }
  if (audioCtx && audioCtx.state !== 'running') {
    try { await audioCtx.resume(); } catch {}
  }
  if (audioCtx && audioCtx.state !== 'running') {
    audioBlocked = true;
    try { await audioCtx.close(); } catch {}
    audioCtx = null;
  }
  console.log('[stmz/audio] final AudioContext state:', audioCtx?.state || 'none', 'preWarmed=', !!preWarmedAudioCtx);
  if (audioBlocked && onStatus) {
    onStatus('Browser blocked audio capture — rendering silent video.');
  }

  // ---- Phase 1a: load video clip OR still image per scene (0–30%) ----
  // Strategy: Pexels Video API first (real motion) → still photo → gradient.
  // Videos are downloaded as Blob and loaded via same-origin blob URL, which
  // prevents the canvas-tainting that previously caused 0-byte recordings.
  const isPortrait = H > W;
  let mediaFails = 0;
  let videosLoaded = 0;
  for (let i = 0; i < scenes.length; i++) {
    if (onStatus) onStatus(`Loading clip ${i+1} of ${scenes.length}…`);
    try {
      const media = await fetchSceneMedia({
        stockQuery:  scenes[i].stockQuery || '',
        imagePrompt: scenes[i].imagePrompt || scenes[i].caption || scenes[i].hook || 'lifestyle photography',
      }, { orientation: isPortrait ? 'portrait' : 'landscape', preferVideo: true });

      if (media?.kind === 'video') {
        scenes[i]._video = media.el;
        if (media.blobUrl) blobUrlsToRevoke.push(media.blobUrl);
        videosLoaded++;
      } else if (media?.kind === 'image') {
        scenes[i]._img = media.el;
      } else {
        mediaFails++;
      }
    } catch (e) { console.warn('[stmz/video] scene', i, 'media error:', e); mediaFails++; }
    if (onProgress) onProgress((i + 1) / scenes.length * 0.30);
  }
  if (videosLoaded > 0 && onStatus) {
    onStatus(`${videosLoaded} real video clip${videosLoaded>1?'s':''} loaded · ${scenes.length - videosLoaded - mediaFails} still photo${(scenes.length - videosLoaded - mediaFails)===1?'':'s'}`);
  } else if (mediaFails === scenes.length && onStatus) {
    onStatus(`All image sources unavailable — rendering text-only. Add PEXELS_API_KEY for stock photos.`);
  } else if (mediaFails > 0 && onStatus) {
    onStatus(`${mediaFails} scene(s) text-only — proceeding.`);
  }

  // ---- Phase 1b: load + DECODE TTS as AudioBuffer (we'll mix everything into one buffer in 1d) ----
  if (useTTS && audioCtx) {
    for (let i = 0; i < scenes.length; i++) {
      if (onStatus) onStatus(`Generating voice ${i+1} of ${scenes.length}…`);
      try {
        // Use the narration field if the AI provided one (a full sentence
        // for the voice to speak). Fall back to caption only if narration is
        // missing (older scripts, manual edits).
        const speakText = (scenes[i].narration || scenes[i].caption || '').toString().slice(0, 500);
        const narrationLang = style.narrationLang || 'en';
        const url = `/api/tts?voice=${encodeURIComponent(voice)}&lang=${encodeURIComponent(narrationLang)}&text=${encodeURIComponent(speakText)}`;
        const r = await fetch(url);
        if (r.ok) {
          const arrayBuf = await r.arrayBuffer();
          // decodeAudioData accepts the ArrayBuffer directly. Some browsers
          // require the callback form, so we wrap in a Promise.
          const audioBuf = await new Promise((resolve, reject) => {
            audioCtx.decodeAudioData(arrayBuf.slice(0), resolve, reject);
          });
          if (audioBuf && audioBuf.duration > 0) {
            scenes[i]._ttsAudioBuffer = audioBuf;
            scenes[i]._ttsDur = audioBuf.duration;
            const ttsDur = Math.ceil(audioBuf.duration + 0.4);
            scenes[i].duration = Math.max(scenes[i].duration || 2, ttsDur);
            console.log('[stmz/tts] scene', i, 'decoded ·', audioBuf.duration.toFixed(2) + 's');
          }
        } else { console.warn('[stmz/tts] scene', i, 'http', r.status); }
      } catch (e) { console.warn('[stmz/tts] scene', i, 'decode failed:', e.message || e); }
      if (onProgress) onProgress(0.30 + (i + 1) / scenes.length * 0.25);
    }
  }

  // ---- Phase 1c: load background music if provided ----
  let musicBuffer = null;
  if (useMusic && audioCtx) {
    if (onStatus) onStatus('Decoding background audio…');
    try {
      const buf = await audioFile.arrayBuffer();
      musicBuffer = await new Promise((resolve, reject) => {
        audioCtx.decodeAudioData(buf.slice(0), resolve, reject);
      });
    } catch (e) { console.warn('Music decode failed:', e); }
    if (onProgress) onProgress(0.55);
  }

  // ---- Phase 1d: PRE-MIX all audio into one AudioBuffer ----
  // This is the most reliable approach: render everything offline into ONE
  // buffer, then play that single buffer at recorder.start(). Avoids the
  // multi-source scheduling issues that broke V11-V17.
  let mixedAudioBuffer = null;
  const hasAnyTTS = scenes.some(s => s._ttsAudioBuffer);
  if (audioCtx && (hasAnyTTS || musicBuffer)) {
    if (onStatus) onStatus('Mixing audio track…');
    try {
      const sr = audioCtx.sampleRate;
      // Total duration = sum of scene durations (TTS extends them already)
      const totalSec = scenes.reduce((sum, s) => sum + (s.duration || 3), 0);
      const numFrames = Math.ceil(totalSec * sr);
      const offline = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, numFrames, sr);

      // Schedule each scene's TTS at its scene start
      let cum = 0;
      for (let i = 0; i < scenes.length; i++) {
        if (scenes[i]._ttsAudioBuffer) {
          const src = offline.createBufferSource();
          src.buffer = scenes[i]._ttsAudioBuffer;
          src.connect(offline.destination);
          src.start(cum);
        }
        cum += scenes[i].duration || 3;
      }

      // Music plays under everything, looped, ducked if voice is present
      if (musicBuffer) {
        const ms = offline.createBufferSource();
        ms.buffer = musicBuffer;
        ms.loop = true;
        const g = offline.createGain();
        g.gain.value = hasAnyTTS ? 0.35 : 0.75;
        ms.connect(g);
        g.connect(offline.destination);
        ms.start(0);
      }

      mixedAudioBuffer = await offline.startRendering();
      console.log('[stmz/audio] pre-mix rendered:', mixedAudioBuffer.duration.toFixed(2) + 's @', sr + 'Hz');
    } catch (e) {
      console.warn('[stmz/audio] pre-mix failed:', e.message || e);
      mixedAudioBuffer = null;
    }
    if (onProgress) onProgress(0.60);
  }

  // ---- Phase 2: render & record (60–100%) ----
  if (onStatus) onStatus('Setting up recorder…');

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Paint one frame BEFORE captureStream — gives the stream a real first frame
  // (some browsers produce 0-byte output if the canvas is never drawn before stream creation).
  ctx.fillStyle = '#0a0b0a';
  ctx.fillRect(0, 0, W, H);

  // ONLY add audio to the recording stream if we have a pre-mixed buffer
  // AND a running AudioContext. Otherwise MediaRecorder may hang waiting for
  // audio data that never arrives.
  const haveAudio = !!mixedAudioBuffer;
  let audioDest = null;
  if (audioCtx && audioCtx.state === 'running' && haveAudio) {
    audioDest = audioCtx.createMediaStreamDestination();
  }
  console.log('[stmz/video] audio routing:',
    'ctx=', audioCtx?.state,
    'mixedBuffer=', haveAudio ? mixedAudioBuffer.duration.toFixed(2)+'s' : 'no',
    'audioDest=', !!audioDest);

  const videoStream = canvas.captureStream(30);
  const stream = audioDest
    ? new MediaStream([...videoStream.getVideoTracks(), ...audioDest.stream.getAudioTracks()])
    : videoStream;
  console.log('[stmz/video] stream tracks:',
    stream.getVideoTracks().length, 'video,',
    stream.getAudioTracks().length, 'audio');

  const candidates = audioDest
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=opus', 'video/webm']
    : ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
  const mime = candidates.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
  console.log('[stmz/video] using codec:', mime);
  const chunks = [];
  recorder.ondataavailable = e => {
    if (e.data && e.data.size) {
      chunks.push(e.data);
      console.log('[stmz/video] chunk', chunks.length, '·', e.data.size, 'bytes');
    }
  };
  recorder.onerror = e => console.error('[stmz/video] recorder error:', e);
  const stopped = new Promise(res => { recorder.onstop = res; });

  // Frame counts (based on possibly-adjusted scene durations)
  const sceneFrameCounts = scenes.map(s => Math.max(60, (s.duration || 3) * 30));
  const totalFrames = sceneFrameCounts.reduce((a, b) => a + b, 0);

  if (onStatus) onStatus('Recording…');
  recorder.start(250);

  // Warm-up pause for canvas + audio destination to stabilize
  await sleep(150);

  const startTime = performance.now();

  // === SINGLE-SOURCE AUDIO PLAYBACK ===
  // Everything (TTS + music) was pre-mixed into ONE AudioBuffer in Phase 1d.
  // We play that one buffer through ONE BufferSource. Connected to BOTH the
  // recording destination AND speakers so the graph definitely processes
  // frames (Chromium otherwise optimises silent-output graphs away).
  let mixedSource = null;
  if (mixedAudioBuffer && audioDest) {
    try {
      mixedSource = audioCtx.createBufferSource();
      mixedSource.buffer = mixedAudioBuffer;
      mixedSource.connect(audioDest);
      mixedSource.connect(audioCtx.destination);
      // Start a tiny moment after now so the connection is solid
      mixedSource.start(audioCtx.currentTime + 0.02);
      console.log('[stmz/audio] ▶ pre-mixed track started');
    } catch (e) { console.warn('[stmz/audio] mixed-source start failed:', e); }
  }

  // Visual render loop — drives the canvas at 30fps.
  // Audio is being played by the single pre-mixed BufferSource (started above).
  // Video clips play silently in background; canvas.drawImage(video) captures each frame.
  let frameIdx = 0;

  for (let s = 0; s < scenes.length; s++) {
    const scene = scenes[s];
    const sceneFrames = sceneFrameCounts[s];
    const FADE = 5;

    if (scene._video) {
      try {
        scene._video.currentTime = 0;
        await scene._video.play();
      } catch (e) { console.warn('[stmz/video] play() failed for scene', s, ':', e.message); }
    }

    for (let f = 0; f < sceneFrames; f++) {
      const t = f / sceneFrames;
      renderStoryFrame(ctx, scene, W, H, t, f, sceneFrames, FADE, styleOpts, s);

      frameIdx++;
      if (onProgress) onProgress(0.60 + (frameIdx / totalFrames) * 0.40);

      const target = startTime + frameIdx * (1000 / 30);
      const wait = target - performance.now();
      if (wait > 0) await sleep(wait);
    }

    if (scene._video) {
      try { scene._video.pause(); } catch {}
    }
  }

  // Let final chunk flush
  await sleep(300);
  recorder.stop();
  await stopped;

  // Revoke blob URLs (free the video memory we held)
  for (const u of blobUrlsToRevoke) {
    try { URL.revokeObjectURL(u); } catch {}
  }

  // Clean up audio
  if (mixedSource) { try { mixedSource.stop(); } catch {} }
  if (audioCtx) { try { await audioCtx.close(); } catch {} }

  if (onProgress) onProgress(1);

  // Safety: never hand back an empty blob.
  const blob = new Blob(chunks, { type: mime });
  console.log('[stmz/video] recorded blob:', blob.size, 'bytes, mime:', mime, 'chunks:', chunks.length);
  if (blob.size < 1024) {
    // If audio was requested but rendering failed, the most likely cause was
    // audio routing — surface that clearly.
    const hadAudio = audioDest !== null;
    throw new Error(hadAudio
      ? `Video render failed (${blob.size} bytes) — usually means audio routing was blocked by your browser. Turn off "Voice narration" + remove any audio file and retry, the silent version always works.`
      : `Video render failed (${blob.size} bytes) — try Chrome or Edge if you're on Safari, or reload and retry.`);
  }
  return blob;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function renderStoryFrame(ctx, scene, W, H, t, frame, totalFrames, FADE, styleOpts = {}, sceneIndex = 0) {
  const captionColor    = styleOpts.captionColor    || '#e7ffd0';
  const captionPosition = styleOpts.captionPosition || 'bottom';
  const captionStyle    = styleOpts.captionStyle    || 'bold';
  const showWatermark   = styleOpts.showWatermark !== false;
  const brandName       = styleOpts.brandName       || '';

  // Background — VIDEO (real motion, blob URL = no taint), still IMAGE, or gradient.
  if (scene._video) {
    ctx.fillStyle = '#0a0b0a';
    ctx.fillRect(0, 0, W, H);
    let vAlpha = 1;
    if (frame < FADE) vAlpha = frame / FADE;
    if (frame > totalFrames - FADE) vAlpha = (totalFrames - frame) / FADE;
    vAlpha = Math.max(0, Math.min(1, vAlpha));

    ctx.globalAlpha = vAlpha;
    const vid = scene._video;
    const vw = vid.videoWidth || W, vh = vid.videoHeight || H;
    // The video is already moving — just a tiny zoom on top for cinematic feel
    const zoom = 1.0 + t * 0.03;
    const scale = Math.max(W / vw, H / vh) * zoom;
    const dw = vw * scale, dh = vh * scale;
    const dx = (W - dw) / 2;
    const dy = (H - dh) / 2;
    try { ctx.drawImage(vid, dx, dy, dw, dh); } catch (e) { /* skip frame if video not ready */ }
    ctx.globalAlpha = 1;
  } else if (scene._img) {
    ctx.fillStyle = '#0a0b0a';
    ctx.fillRect(0, 0, W, H);
    let imgAlpha = 1;
    if (frame < FADE) imgAlpha = frame / FADE;
    if (frame > totalFrames - FADE) imgAlpha = (totalFrames - frame) / FADE;
    imgAlpha = Math.max(0, Math.min(1, imgAlpha));

    ctx.globalAlpha = imgAlpha;
    const img = scene._img;

    // ── Varied Ken Burns: rotate through 5 patterns by scene index so a
    //    multi-scene video doesn't feel like one repeating zoom-in. ──
    const pattern = sceneIndex % 5;
    let zoom, panX, panY;
    switch (pattern) {
      case 0: // zoom in (classic)
        zoom = 1.02 + t * 0.10;
        panX = (t - 0.5) * 14;
        panY = (t - 0.5) * 8;
        break;
      case 1: // zoom out (reveal — great for wide shots)
        zoom = 1.12 - t * 0.10;
        panX = (t - 0.5) * -10;
        panY = (t - 0.5) * -6;
        break;
      case 2: // slow pan right (cinematic landscape feel)
        zoom = 1.06;
        panX = (t - 0.5) * 40;
        panY = (t - 0.5) * 5;
        break;
      case 3: // slow pan left (counter-balance)
        zoom = 1.06;
        panX = (t - 0.5) * -40;
        panY = (t - 0.5) * 5;
        break;
      case 4: // zoom in + drift up (heroic feel — final-CTA scenes)
        zoom = 1.04 + t * 0.08;
        panX = (t - 0.5) * 6;
        panY = (t - 0.5) * -22;
        break;
    }

    const scale = Math.max(W / img.width, H / img.height) * zoom;
    const dw = img.width * scale, dh = img.height * scale;
    const dx = (W - dw) / 2 + panX;
    const dy = (H - dh) / 2 + panY;
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.globalAlpha = 1;
  } else {
    // No image — paint a slow-moving gradient using the scene caption as a seed.
    const seedStr = scene.caption || 'scene';
    const seed = Array.from(seedStr).reduce((a,c) => (a * 31 + c.charCodeAt(0)) | 0, 0);
    const h1 = Math.abs(seed) % 360;
    const h2 = (h1 + 40 + (t * 30)) % 360;
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, `hsl(${h1}, 55%, 18%)`);
    grad.addColorStop(0.5, `hsl(${(h1+h2)/2}, 50%, 12%)`);
    grad.addColorStop(1, `hsl(${h2}, 60%, 8%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    const cx = W * (0.3 + Math.sin(t * Math.PI) * 0.4);
    const cy = H * (0.4 + Math.cos(t * Math.PI * 0.7) * 0.3);
    const radial = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.6);
    radial.addColorStop(0, `hsla(${h2}, 80%, 60%, 0.18)`);
    radial.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, W, H);
  }

  // Dark gradient overlay for text readability — adapts to caption position
  const grad2 = ctx.createLinearGradient(0, 0, 0, H);
  if (captionPosition === 'top') {
    grad2.addColorStop(0, 'rgba(0,0,0,0.78)');
    grad2.addColorStop(0.45, 'rgba(0,0,0,0.10)');
    grad2.addColorStop(1, 'rgba(0,0,0,0.45)');
  } else if (captionPosition === 'middle') {
    grad2.addColorStop(0, 'rgba(0,0,0,0.40)');
    grad2.addColorStop(0.5, 'rgba(0,0,0,0.50)');
    grad2.addColorStop(1, 'rgba(0,0,0,0.40)');
  } else { // bottom (default)
    grad2.addColorStop(0, 'rgba(0,0,0,0.45)');
    grad2.addColorStop(0.45, 'rgba(0,0,0,0.10)');
    grad2.addColorStop(1, 'rgba(0,0,0,0.78)');
  }
  ctx.fillStyle = grad2;
  ctx.fillRect(0, 0, W, H);

  // Caption — word-by-word reveal (TikTok style) or full static reveal,
  // per styleOpts.subtitleMode. Word-by-word uses the NARRATION text and times
  // each word to when the voice speaks it.
  if (scene.caption || scene.narration) {
    let textAlpha = 1;
    if (frame < FADE) textAlpha = frame / FADE;
    if (frame > totalFrames - FADE) textAlpha = (totalFrames - frame) / FADE;
    textAlpha = Math.max(0, Math.min(1, textAlpha));

    // Style-driven font + sizing
    const isPortrait = H > W;
    let capSize, fontWeight, fontFamily;
    if (captionStyle === 'modern') {
      capSize = Math.round(W * (isPortrait ? 0.085 : 0.062));
      fontWeight = '900';
      fontFamily = SAFE_FONT;
    } else if (captionStyle === 'classic') {
      capSize = Math.round(W * (isPortrait ? 0.07 : 0.052));
      fontWeight = '600';
      fontFamily = `Georgia, "Times New Roman", serif`;
    } else { // bold (default)
      capSize = Math.round(W * (isPortrait ? 0.075 : 0.055));
      fontWeight = '800';
      fontFamily = SAFE_FONT;
    }

    // Y position based on captionPosition
    let yPos;
    if (captionPosition === 'top')         yPos = H * (isPortrait ? 0.18 : 0.16);
    else if (captionPosition === 'middle') yPos = H * 0.5;
    else                                   yPos = H * (isPortrait ? 0.68 : 0.62);

    ctx.font = `${fontWeight} ${capSize}px ${fontFamily}`;
    // Parse hex → rgba
    const hex = captionColor.replace('#','');
    const r = parseInt(hex.length === 3 ? hex[0]+hex[0] : hex.slice(0,2), 16);
    const g = parseInt(hex.length === 3 ? hex[1]+hex[1] : hex.slice(2,4), 16);
    const b = parseInt(hex.length === 3 ? hex[2]+hex[2] : hex.slice(4,6), 16);
    ctx.textAlign = 'center';
    ctx.shadowColor = `rgba(0,0,0,${textAlpha * 0.85})`;
    ctx.shadowBlur = 24;

    const subtitleMode = styleOpts.subtitleMode || 'word-by-word';
    const useWordByWord = subtitleMode === 'word-by-word' && scene.narration && scene.narration.trim();

    if (useWordByWord) {
      // ─── TikTok-style word-by-word reveal ───
      // Words appear synchronized with voice. Latest word gets a brief "pop"
      // scale animation + a signal-green highlight chip behind it.
      const words = scene.narration.trim().split(/\s+/).filter(Boolean);
      if (words.length) {
        // Estimate timing: spread words evenly over the audio duration (or
        // 88% of scene duration if no audio info). Reveal starts at frame 2.
        const audioFrames = (scene._ttsDur ? scene._ttsDur * 30 : totalFrames * 0.88);
        const startOffset = 2; // tiny lead-in
        const framesPerWord = Math.max(3, audioFrames / words.length);
        const visibleCount = Math.min(words.length, Math.max(0, Math.floor((frame - startOffset) / framesPerWord) + 1));

        if (visibleCount > 0) {
          const visible = words.slice(0, visibleCount);
          const latestIdx = visibleCount - 1;
          const framesSinceLatest = (frame - startOffset) - (latestIdx * framesPerWord);
          // Pop animation: scale 1.18 → 1.0 over 5 frames
          const popScale = framesSinceLatest < 5 ? 1.18 - (framesSinceLatest / 5) * 0.18 : 1.0;

          // Wrap visible words into lines that fit
          const maxLineWidth = W * 0.85;
          const lines = [];   // each entry: array of { word, isLatest }
          let line = [];
          let lineW = 0;
          const spaceW = ctx.measureText(' ').width;
          for (let i = 0; i < visible.length; i++) {
            const w = visible[i];
            const ww = ctx.measureText(w).width;
            const tentative = lineW + (line.length ? spaceW : 0) + ww;
            if (tentative > maxLineWidth && line.length) {
              lines.push(line);
              line = [{ word: w, isLatest: i === latestIdx }];
              lineW = ww;
            } else {
              line.push({ word: w, isLatest: i === latestIdx });
              lineW = tentative;
            }
          }
          if (line.length) lines.push(line);

          // Render lines bottom-up so the latest sits naturally
          const lineHeight = capSize * 1.20;
          const totalLinesHeight = lines.length * lineHeight;
          // Anchor at yPos (vertical centre of caption block)
          const startY = yPos - totalLinesHeight / 2 + lineHeight / 2;

          for (let li = 0; li < lines.length; li++) {
            const lineWords = lines[li];
            const lineText = lineWords.map(o => o.word).join(' ');
            const lineTotalW = ctx.measureText(lineText).width;
            let x = (W - lineTotalW) / 2;
            const y = startY + li * lineHeight;

            for (const { word: w, isLatest } of lineWords) {
              const ww = ctx.measureText(w).width;
              const cx = x + ww / 2;

              // Highlight chip behind the latest word
              if (isLatest && framesSinceLatest < 8) {
                const chipAlpha = textAlpha * Math.max(0, 1 - framesSinceLatest / 12);
                ctx.save();
                ctx.shadowBlur = 0;
                ctx.fillStyle = `rgba(189,243,109,${chipAlpha * 0.85})`;
                const padX = capSize * 0.18;
                const padY = capSize * 0.12;
                const chipH = capSize * 1.0;
                const radius = capSize * 0.18;
                roundRect(ctx, cx - ww/2 - padX, y - chipH/2 - padY * 0.4, ww + padX * 2, chipH + padY * 0.8, radius);
                ctx.fill();
                ctx.restore();
              }

              // Word text — with pop scale on latest
              ctx.save();
              ctx.shadowColor = `rgba(0,0,0,${textAlpha * 0.85})`;
              ctx.shadowBlur = 24;
              ctx.translate(cx, y);
              if (isLatest) ctx.scale(popScale, popScale);
              // Latest word is dark text on chip; older words use captionColor on shadow
              ctx.fillStyle = isLatest && framesSinceLatest < 8
                ? `rgba(10,11,10,${textAlpha})`
                : `rgba(${r},${g},${b},${textAlpha})`;
              ctx.fillText(w, 0, 0);
              ctx.restore();

              x += ww + spaceW;
            }
          }
        }
      }
    } else {
      // ─── Static caption (legacy / "static" mode) ───
      ctx.fillStyle = `rgba(${r},${g},${b},${textAlpha})`;
      wrapText(ctx, scene.caption || scene.narration, W/2, yPos, W * 0.85, capSize * 1.18);
    }
    ctx.shadowBlur = 0;
  }

  // Brand name (top-left), optional
  if (brandName) {
    ctx.font = `600 ${Math.round(W * 0.022)}px ${SAFE_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.textAlign = 'left';
    ctx.fillText(brandName, W * 0.04, H * 0.06);
  }

  // Watermark — opt-out for paid tiers
  if (showWatermark) {
    ctx.font = `500 ${Math.round(W * 0.018)}px ${SAFE_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.textAlign = 'right';
    ctx.fillText('made with stmz', W - W * 0.04, H - W * 0.025);
  }
}
