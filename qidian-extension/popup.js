const btnCapture      = document.getElementById('btnCapture');
const btnTest         = document.getElementById('btnTest');
const btnDownload     = document.getElementById('btnDownload');
const statusEl        = document.getElementById('status');
const progressBar     = document.getElementById('progressBar');
const previewEl       = document.getElementById('preview');
const charCountEl     = document.getElementById('charCount');
const warningEl       = document.getElementById('warning');
const novelSlugInput  = document.getElementById('novelSlug');
const autoPushEl      = document.getElementById('autoPush');
const autoTranslateEl = document.getElementById('autoTranslate');
const autoOcrEl       = document.getElementById('autoOcr');
const pushStatusEl    = document.getElementById('pushStatus');

let savedText  = '';
let savedTitle = '';

const FALLBACK_CROP_X = 600;
const FALLBACK_CROP_W = 695;
const CHUNK_H         = 1400;
const OVERLAP_H       = 40;
const SAFE_PADDING    = 20;
const JPEG_QUALITY    = 95;
const MAX_RETRY       = 2;
const PRE_SETTLE_MS   = 600;
const POST_SCROLL_MS  = 400;

const DETECT_EXPR = `(function() {
  const SELS = ["main[data-type='cjk']","#j_chapterContent",".read-content",".chapter-content"];
  let el = null;
  for (const s of SELS) { el = document.querySelector(s); if (el) break; }
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const sy = window.scrollY;
  const paras = Array.from(el.querySelectorAll('p')).filter(p => p.innerText.trim().length > 0);
  const firstP = paras[0];
  const lastP  = paras[paras.length - 1];
  return {
    left:        Math.round(rect.left),
    width:       Math.round(rect.width),
    top:         Math.round(rect.top + sy),
    height:      el.scrollHeight,
    firstPTop:   firstP ? Math.round(firstP.getBoundingClientRect().top + sy)    : null,
    lastPBottom: lastP  ? Math.round(lastP.getBoundingClientRect().bottom + sy)  : null,
  };
})()` ;

const VIETPHASE_URL = 'http://localhost:9999';

chrome.storage.local.get(['novel_slug', 'auto_push', 'auto_translate', 'auto_ocr'], (s) => {
  if (s.novel_slug)     novelSlugInput.value    = s.novel_slug;
  if (s.auto_push)      autoPushEl.checked      = s.auto_push;
  if (s.auto_translate) autoTranslateEl.checked = s.auto_translate;
  if (s.auto_ocr)       autoOcrEl.checked       = s.auto_ocr;

  // Auto-OCR: nếu đang bật và popup mở trên chapter page → tự chụp ngay
  if (s.auto_ocr) {
    getActiveTab().then(tab => {
      if (tab?.url?.includes('qidian.com/chapter/')) {
        runCapture(tab);
      }
    });
  }
});

novelSlugInput.addEventListener('input', () =>
  chrome.storage.local.set({ novel_slug: novelSlugInput.value.trim() }));
autoPushEl.addEventListener('change', () =>
  chrome.storage.local.set({ auto_push: autoPushEl.checked }));
autoTranslateEl.addEventListener('change', () =>
  chrome.storage.local.set({ auto_translate: autoTranslateEl.checked }));
autoOcrEl.addEventListener('change', () =>
  chrome.storage.local.set({ auto_ocr: autoOcrEl.checked }));

function setStatus(msg)    { statusEl.textContent = msg; }
function setProgress(pct)  { progressBar.style.width = Math.min(100, pct) + '%'; }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ── Chrome DevTools Protocol helpers ────────────────────────────────────────
function dbgAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function dbgDetach(tabId) {
  return new Promise(resolve => chrome.debugger.detach({ tabId }, resolve));
}

function dbgSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, result => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

// ── Capture chapter via CDP ──────────────────────────────────────────────────
async function captureWithRetry(tabId, clipParams) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      if (attempt > 0) await wait(300 * attempt);
      const { data } = await dbgSend(tabId, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: JPEG_QUALITY,
        captureBeyondViewport: true,
        clip: clipParams,
      });
      return data;
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

async function captureChapter(tabId) {
  await dbgAttach(tabId);
  const shots = [];

  try {
    // Phase 1: Pre-scroll để ổn định JS/ads động trước khi đo
    setStatus('Đang ổn định trang...');
    await dbgSend(tabId, 'Runtime.evaluate', {
      expression: 'window.scrollTo(0, document.body.scrollHeight)',
      returnByValue: false,
    });
    await wait(PRE_SETTLE_MS);
    await dbgSend(tabId, 'Runtime.evaluate', {
      expression: 'window.scrollTo(0, 0)',
      returnByValue: false,
    });
    await wait(POST_SCROLL_MS);

    // Phase 2: Detect element bounds sau khi DOM ổn định
    const { result } = await dbgSend(tabId, 'Runtime.evaluate', {
      expression: DETECT_EXPR,
      returnByValue: true,
    });
    if (!result.value) return [];
    const info = result.value;

    // Phase 3: Tính vùng crop từ DOM thực tế
    const cropX = (info.left > 0) ? info.left : FALLBACK_CROP_X;
    const cropW = (info.width > 0) ? info.width : FALLBACK_CROP_W;

    let startY, endY;
    if (info.firstPTop !== null && info.lastPBottom !== null) {
      startY = Math.max(0, info.firstPTop - SAFE_PADDING);
      endY   = info.lastPBottom + SAFE_PADDING;
    } else {
      startY = Math.max(0, info.top - SAFE_PADDING);
      endY   = info.top + info.height + SAFE_PADDING;
    }
    const totalH = endY - startY;
    if (totalH <= 0) return [];

    // Phase 4: Chunked capture với overlap để tránh cắt ký tự tại ranh giới
    let y = startY;
    let idx = 0;
    while (y < endY) {
      setProgress(Math.round((idx * CHUNK_H / totalH) * 80));
      setStatus(`Chụp vùng ${idx + 1}...`);

      const captureY = (idx === 0) ? y : Math.max(startY, y - OVERLAP_H);
      const captureH = Math.min(CHUNK_H + OVERLAP_H, endY - captureY);

      const data = await captureWithRetry(tabId, {
        x: cropX, y: captureY, width: cropW, height: captureH, scale: 1,
      });

      shots.push(`data:image/jpeg;base64,${data}`);
      y += CHUNK_H;
      idx++;
    }
  } finally {
    await dbgDetach(tabId);
  }

  return shots;
}

// ── Convert data URL to Blob ─────────────────────────────────────────────────
function dataUrlToBlob(dataUrl) {
  const [meta, data] = dataUrl.split(',');
  const mime = meta.match(/:(.*?);/)[1];
  const bytes = atob(data);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ── Upload ảnh → VietPhase OCR, stream kết quả về popup ─────────────────────
async function uploadAndStreamOcr(screenshots, novelSlug, chapterTitle) {
  const form = new FormData();
  form.append('novel_slug', novelSlug);
  form.append('chapter_title', chapterTitle);
  screenshots.forEach((url, i) =>
    form.append('images', dataUrlToBlob(url), `shot_${String(i + 1).padStart(2, '0')}.jpg`)
  );

  setStatus(`Đang upload ${screenshots.length} ảnh lên VietPhase...`);
  setProgress(85);

  const res = await fetch(`${VIETPHASE_URL}/api/ocr/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload thất bại (HTTP ${res.status})`);
  const { job_id } = await res.json();

  setStatus('Đang OCR với OpenAI...');
  previewEl.textContent = '';
  previewEl.style.display = 'block';

  return new Promise((resolve, reject) => {
    const es = new EventSource(`${VIETPHASE_URL}/api/ocr/stream/${job_id}`);
    let accumulated = '';

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);

        if (event.type === 'ocr_token') {
          accumulated += event.text;
          previewEl.textContent = accumulated.slice(0, 600);
          setProgress(90 + Math.min(9, Math.floor(accumulated.length / 200)));
        } else if (event.type === 'ocr_done') {
          es.close();
          setProgress(100);
          charCountEl.textContent = `${event.char_count.toLocaleString()} ký tự`;
          previewEl.textContent = event.preview + (event.char_count > 400 ? '…' : '');
          savedText = event.preview;
          resolve(event.filename);
        } else if (event.type === 'ocr_error') {
          es.close();
          reject(new Error(event.msg));
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => { es.close(); reject(new Error('Mất kết nối SSE với VietPhase')); };
  });
}

// ── VietPhase auto-translate trigger ────────────────────────────────────────
function setPushStatus(msg, color = '#6ee7b7') {
  pushStatusEl.textContent = msg;
  pushStatusEl.style.color = color;
  pushStatusEl.style.display = msg ? 'block' : 'none';
}

async function triggerTranslation(slug, filename) {
  const res = await fetch(`${VIETPHASE_URL}/api/translate/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ novel_slug: slug, chapter_filenames: [filename] }),
  });
  if (!res.ok) throw new Error(`Kích hoạt dịch thất bại (HTTP ${res.status})`);
}

// ── Shared capture + OCR flow ─────────────────────────────────────────────────
async function runCapture(tab) {
  const slug = novelSlugInput.value.trim();
  savedTitle = tab.title.replace(/_.*$/, '').replace(/ [-—].*$/, '').trim();

  btnCapture.disabled = true;
  btnDownload.style.display = 'none';
  previewEl.style.display = 'none';
  warningEl.style.display = 'block';
  setPushStatus('');

  try {
    setProgress(0);
    const screenshots = await captureChapter(tab.id);

    if (!screenshots.length) {
      setStatus('Không tìm thấy vùng nội dung. Thử reload trang rồi chụp lại.');
      return;
    }

    const filename = await uploadAndStreamOcr(screenshots, slug || 'unknown', tab.title);
    btnDownload.style.display = 'block';
    setStatus(`✓ Đã lưu: ${filename}`);
    setPushStatus(`✓ Vào VietPhase: ${filename}`, '#6ee7b7');

    if (autoTranslateEl.checked && slug) {
      setPushStatus('Đang kích hoạt dịch...', '#fbbf24');
      await triggerTranslation(slug, filename);
      setPushStatus('✓ Đang dịch trên VietPhase', '#6ee7b7');
    }
  } catch (err) {
    setStatus('Lỗi: ' + err.message);
    setPushStatus('', '');
  } finally {
    btnCapture.disabled = false;
    warningEl.style.display = 'none';
  }
}

// ── Main capture button ──────────────────────────────────────────────────────
btnCapture.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab.url?.includes('qidian.com/chapter/')) {
    setStatus('Hãy mở một trang chapter trên qidian.com.');
    return;
  }
  await runCapture(tab);
});

// ── Test: capture only, download as images ───────────────────────────────────
btnTest.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab.url?.includes('qidian.com/chapter/')) {
    setStatus('Hãy mở một trang chapter trên qidian.com.');
    return;
  }

  btnTest.disabled = true;
  warningEl.style.display = 'block';
  setProgress(0);

  try {
    const screenshots = await captureChapter(tab.id);
    if (!screenshots.length) {
      setStatus('Không tìm thấy vùng nội dung!');
      return;
    }

    setStatus(`Đang lưu ${screenshots.length} ảnh...`);
    const chapterName = tab.title.replace(/_.*$/, '').replace(/ [-—].*$/, '').replace(/[\\/:*?"<>|]/g, '_').trim();

    for (let i = 0; i < screenshots.length; i++) {
      const url = screenshots[i];
      const filename = `qidian_test/${chapterName}_${String(i + 1).padStart(2, '0')}.jpg`;
      await new Promise(resolve => {
        chrome.downloads.download({ url, filename, saveAs: false }, resolve);
      });
      await wait(100);
    }

    setProgress(100);
    setStatus(`Đã lưu ${screenshots.length} ảnh vào thư mục Downloads/qidian_test/`);
  } catch (err) {
    setStatus('Lỗi: ' + err.message);
  } finally {
    btnTest.disabled = false;
    warningEl.style.display = 'none';
  }
});

// ── Download preview text ────────────────────────────────────────────────────
btnDownload.addEventListener('click', () => {
  if (!savedText) return;
  const blob = new Blob([savedText], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const name = savedTitle.replace(/[\\/:*?"<>|]/g, '_') + '.txt';
  chrome.downloads.download({ url, filename: name, saveAs: false }, () => {
    setStatus(`Đã tải: ${name}`);
    URL.revokeObjectURL(url);
  });
});
