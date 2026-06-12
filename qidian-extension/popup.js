// ── DOM refs ──────────────────────────────────────────────────────────────────
const btnCapture     = document.getElementById('btnCapture');   // chụp ảnh → .jpg
const btnCopyTxt     = document.getElementById('btnCopyTxt');    // copy text → .txt
const statusEl       = document.getElementById('status');
const progressBar    = document.getElementById('progressBar');
const previewEl      = document.getElementById('preview');
const charCountEl    = document.getElementById('charCount');
const warningEl      = document.getElementById('warning');
const novelSlugInput = document.getElementById('novelSlug');

// ── Capture tuning ────────────────────────────────────────────────────────────
const FALLBACK_CROP_X = 600;
const FALLBACK_CROP_W = 695;
const CHUNK_H         = 1400;
const OVERLAP_H       = 120;
const SAFE_PADDING    = 20;
const JPEG_QUALITY    = 95;
const MAX_RETRY       = 2;
const PRE_SETTLE_MS   = 600;
const POST_SCROLL_MS  = 400;
const MIN_CHUNK_RATIO = 0.55;
const EXPORT_BASE_DIR = 'data/vietphase';

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
  const paragraphBottoms = paras
    .map(p => Math.round(p.getBoundingClientRect().bottom + sy))
    .filter((v, i, a) => Number.isFinite(v) && (i === 0 || v !== a[i - 1]));
  return {
    left:        Math.round(rect.left),
    width:       Math.round(rect.width),
    top:         Math.round(rect.top + sy),
    height:      el.scrollHeight,
    firstPTop:   firstP ? Math.round(firstP.getBoundingClientRect().top + sy)    : null,
    lastPBottom: lastP  ? Math.round(lastP.getBoundingClientRect().bottom + sy)  : null,
    paragraphBottoms,
  };
})()` ;

// ── Restore novel slug ────────────────────────────────────────────────────────
chrome.storage.local.get(['novel_slug'], (s) => {
  if (s.novel_slug) novelSlugInput.value = s.novel_slug;
});
novelSlugInput.addEventListener('input', () =>
  chrome.storage.local.set({ novel_slug: novelSlugInput.value.trim() }));

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(msg)   { statusEl.textContent = msg; }
function setProgress(pct) { progressBar.style.width = Math.min(100, pct) + '%'; }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function sanitizeFilename(name) {
  return (name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}
function normalizeSlug(input) {
  const s = (input || '').trim().toLowerCase();
  if (!s) return 'unknown';
  return s
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}
function extractChapterNumber(title) {
  const text = title || '';
  const patterns = [
    /第\s*(\d+)\s*章/i,        // Chinese: 第678章
    /ch(?:ươ|u)o?ng\s*(\d+)/i, // Vietnamese: Chương 678
    /\bchapter\s*(\d+)/i,      // English: Chapter 678
    /\b(\d{1,6})\b/,           // fallback: số đứng riêng đầu tiên
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  return 'unknown';
}
function buildExportDir(slug, chapterNumber) {
  return `${EXPORT_BASE_DIR}/${normalizeSlug(slug)}/${chapterNumber || 'unknown'}`;
}
function pickLastInRange(values, min, max) {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v > max) continue;
    if (v >= min) return v;
    break;
  }
  return null;
}

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

    // Phase 4: Chunked capture, ưu tiên cắt ở đáy đoạn <p> để tránh cắt ngang dòng
    const paragraphBottoms = Array.isArray(info.paragraphBottoms) ? info.paragraphBottoms : [];
    let y = startY;
    let idx = 0;
    while (y < endY) {
      const progressed = Math.max(0, y - startY);
      setProgress(Math.round((progressed / totalH) * 100));
      setStatus(`Chụp vùng ${idx + 1}...`);

      const targetEnd = Math.min(endY, y + CHUNK_H);
      const minSnapY = y + Math.floor(CHUNK_H * MIN_CHUNK_RATIO);
      const snappedEnd = paragraphBottoms.length ? pickLastInRange(paragraphBottoms, minSnapY, targetEnd) : null;
      const endAt = (snappedEnd && snappedEnd > y) ? Math.min(endY, snappedEnd + SAFE_PADDING) : targetEnd;

      const captureY = (idx === 0) ? y : Math.max(startY, y - OVERLAP_H);
      const captureH = Math.max(1, endAt - captureY);

      const data = await captureWithRetry(tabId, {
        x: cropX, y: captureY, width: cropW, height: captureH, scale: 1,
      });

      shots.push(`data:image/jpeg;base64,${data}`);
      y = endAt;
      idx++;
    }
  } finally {
    await dbgDetach(tabId);
  }

  return shots;
}

// ── Thao tác 1: Chụp ảnh → tải .jpg ───────────────────────────────────────────
btnCapture.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab.url?.includes('qidian.com/chapter/')) {
    setStatus('Hãy mở một trang chapter trên qidian.com.');
    return;
  }

  btnCapture.disabled = true;
  warningEl.style.display = 'block';
  previewEl.style.display = 'none';
  setProgress(0);

  try {
    const screenshots = await captureChapter(tab.id);
    if (!screenshots.length) {
      setStatus('Không tìm thấy vùng nội dung. Thử reload trang rồi chụp lại.');
      return;
    }

    setStatus(`Đang lưu ${screenshots.length} ảnh...`);
    const chapterName = sanitizeFilename(tab.title.replace(/_.*$/, '').replace(/ [-—].*$/, '').trim());
    const slug = normalizeSlug(novelSlugInput.value);
    const chapterNo = extractChapterNumber(chapterName);
    const exportDir = buildExportDir(slug, chapterNo);

    for (let i = 0; i < screenshots.length; i++) {
      const url = screenshots[i];
      const filename = `${exportDir}/${chapterName}_${String(i + 1).padStart(2, '0')}.jpg`;
      await new Promise(resolve => {
        chrome.downloads.download({ url, filename, saveAs: false }, resolve);
      });
      await wait(100);
    }

    setProgress(100);
    setStatus(`Đã lưu ${screenshots.length} ảnh vào Downloads/${exportDir}/`);
  } catch (err) {
    setStatus('Lỗi: ' + err.message);
  } finally {
    btnCapture.disabled = false;
    warningEl.style.display = 'none';
  }
});

// ── Thao tác 2: Copy text → tải .txt ──────────────────────────────────────────
// Đọc thẳng innerText của khối nội dung — bỏ qua được lớp chặn bôi đen/chuột phải
// của Qidian (không cần extension "Enable Right Click and Copy"). KHÔNG gỡ được
// lớp mã hóa font: nếu txt ra chữ Hán lộn xộn thì trang dùng font mã hóa, hãy chụp ảnh.
function cleanExtractedText(text) {
  return (text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => !/^\s*\d+\s*$/.test(line)) // bỏ dòng chỉ chứa số (badge đếm bình luận 段评)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')                // gộp dòng trống thừa
    .trim();
}

async function extractTextFromPage(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const SELECTORS = [
        "main[data-type='cjk']", "#j_chapterContent",
        ".read-content", ".chapter-content", "main.content",
      ];
      let best = '';
      for (const sel of SELECTORS) {
        const el = document.querySelector(sel);
        if (el) {
          const t = el.innerText.trim();
          if (t.length > best.length) best = t;
        }
      }
      return { title: document.title.replace(/ _.*$/, '').trim(), text: best };
    },
  });
  return result || { title: '', text: '' };
}

btnCopyTxt.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab.url?.includes('qidian.com/chapter/')) {
    setStatus('Hãy mở một trang chapter trên qidian.com.');
    return;
  }

  btnCopyTxt.disabled = true;
  setProgress(0);
  try {
    setStatus('Đang đọc nội dung từ trang...');
    const { title, text: rawText } = await extractTextFromPage(tab.id);
    const text = cleanExtractedText(rawText);
    if (!text || text.length < 50) {
      setStatus('Không lấy được nội dung (trang chặn hoặc dùng font mã hóa → hãy chụp ảnh).');
      return;
    }

    const safeTitle = sanitizeFilename(title.replace(/_.*$/, '').replace(/ [-—].*$/, '').trim());
    const slug      = normalizeSlug(novelSlugInput.value);
    const chapterNo = extractChapterNumber(safeTitle);
    const name      = `${buildExportDir(slug, chapterNo)}/${safeTitle}.txt`;

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    await new Promise(resolve =>
      chrome.downloads.download({ url, filename: name, saveAs: false }, resolve));
    URL.revokeObjectURL(url);

    // Hiện preview để mắt thường kiểm tra chữ có đúng không
    previewEl.textContent = text.slice(0, 600) + (text.length > 600 ? '…' : '');
    previewEl.style.display = 'block';
    charCountEl.textContent = `${text.length.toLocaleString()} ký tự`;
    setProgress(100);
    setStatus(`✓ Đã lưu text: ${name}`);
  } catch (err) {
    setStatus('Lỗi: ' + err.message);
  } finally {
    btnCopyTxt.disabled = false;
  }
});
