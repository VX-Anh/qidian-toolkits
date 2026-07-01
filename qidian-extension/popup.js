// ── DOM refs ──────────────────────────────────────────────────────────────────
const btnCapture     = document.getElementById('btnCapture');   // chụp ảnh → .jpg
const btnCopyTxt     = document.getElementById('btnCopyTxt');    // copy text → .txt
const btnSendServer  = document.getElementById('btnSendServer'); // gửi text → server
const statusEl       = document.getElementById('status');
const progressBar    = document.getElementById('progressBar');
const previewEl      = document.getElementById('preview');
const charCountEl    = document.getElementById('charCount');
const warningEl      = document.getElementById('warning');
const novelSlugInput = document.getElementById('novelSlug');
const serverUrlInput = document.getElementById('serverUrl');

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
const DEFAULT_SERVER  = 'http://localhost:9999';

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

// ── Restore novel slug + server URL ───────────────────────────────────────────
chrome.storage.local.get(['novel_slug', 'server_url'], (s) => {
  if (s.novel_slug) novelSlugInput.value = s.novel_slug;
  serverUrlInput.value = s.server_url || DEFAULT_SERVER;
});
novelSlugInput.addEventListener('input', () =>
  chrome.storage.local.set({ novel_slug: novelSlugInput.value.trim() }));
serverUrlInput.addEventListener('input', () =>
  chrome.storage.local.set({ server_url: serverUrlInput.value.trim() }));

// Bỏ dấu "/" cuối để khi nối path không sinh "//". Rỗng → mặc định localhost.
function getServerUrl() {
  return (serverUrlInput.value.trim() || DEFAULT_SERVER).replace(/\/+$/, '');
}

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

// ── Lớp 0: phân tích chất lượng text (phát hiện font mã hóa / PUA) ─────────────
// Đếm tỉ lệ ký tự Private Use Area trên ký tự non-whitespace để phát hiện trang
// render bằng custom font (nhìn đúng nhưng innerText ra ký tự PUA rác). Trả cả
// metrics để log/debug, không chỉ một boolean. CÓ 3 BẢN COPY của hàm này (bản này +
// trong scanPageContext + trong scanDomSelectors) vì injected func chạy ở world khác,
// mất closure và không thể truyền qua string (CSP chặn eval) — nếu sửa, sửa cả 3.
function analyzeText(text) {
  let total = 0, pua = 0, suspicious = 0, cjk = 0, extA = 0;
  for (const ch of text || '') {
    if (/\s/.test(ch)) continue;            // tính trên ký tự non-whitespace
    total++;
    const cp = ch.codePointAt(0);
    const isPua =
      (cp >= 0xE000 && cp <= 0xF8FF) ||      // BMP PUA
      (cp >= 0xF0000 && cp <= 0xFFFFD) ||    // Supplementary PUA-A
      (cp >= 0x100000 && cp <= 0x10FFFD);    // Supplementary PUA-B
    const isExtA = (cp >= 0x3400 && cp <= 0x4DBF); // CJK Ext A (chữ Hán cực hiếm)
    const isCjk =
      (cp >= 0x3400 && cp <= 0x9FFF) ||      // CJK + Ext A
      (cp >= 0x20000 && cp <= 0x323AF);      // CJK Ext B..H
    if (isPua) pua++;
    else if (!isCjk && cp > 0xFFFF) suspicious++;
    if (isExtA) extA++;
    if (isCjk) cjk++;
  }
  const puaRatio = total ? pua / total : 1;
  const extARatio = total ? extA / total : 0;
  return {
    total, pua, suspicious, cjk, extA, puaRatio, extARatio,
    // Tín hiệu mã hóa CHÍNH là class r-font-encrypt (xử lý ở scanDomSelectors), KHÔNG
    // dùng extARatio để quyết garbled: chương sạch vẫn có thể có ít chữ Ext A và sẽ bị
    // báo nhầm. extARatio chỉ giữ để log/debug.
    garbled: total < 20 || puaRatio > 0.03 || (pua > 20 && cjk < pua),
  };
}

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

// ── Lớp 1: quét page context (world: MAIN) tìm candidate text sạch ─────────────
// Chạy ở MAIN world để đọc được biến JS của trang (window.content, JSON nhúng…) mà
// content script ở isolated world KHÔNG thấy. Lưu ý MAIN world: func bị serialize →
// MẤT closure, nên analyzeText phải nằm BÊN TRONG injected func; kết quả trả về phải
// structured-clone được (chỉ string/number/plain object). Page có thể monkey-patch
// JSON/Array nên bọc try/catch từng bước. Đây là best effort — biến có thể bị dọn
// sau render hoặc đổi tên → luôn có Lớp 2 + chụp ảnh làm lưới an toàn.
async function scanPageContext(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        // ── analyzeText: BẢN COPY (MAIN world mất closure, không tham chiếu ngoài) ──
        function analyzeText(text) {
          let total = 0, pua = 0, suspicious = 0, cjk = 0, extA = 0;
          for (const ch of text || '') {
            if (/\s/.test(ch)) continue;
            total++;
            const cp = ch.codePointAt(0);
            const isPua =
              (cp >= 0xE000 && cp <= 0xF8FF) ||
              (cp >= 0xF0000 && cp <= 0xFFFFD) ||
              (cp >= 0x100000 && cp <= 0x10FFFD);
            const isExtA = (cp >= 0x3400 && cp <= 0x4DBF);
            const isCjk =
              (cp >= 0x3400 && cp <= 0x9FFF) ||
              (cp >= 0x20000 && cp <= 0x323AF);
            if (isPua) pua++;
            else if (!isCjk && cp > 0xFFFF) suspicious++;
            if (isExtA) extA++;
            if (isCjk) cjk++;
          }
          const puaRatio = total ? pua / total : 1;
          const extARatio = total ? extA / total : 0;
          return {
            total, pua, suspicious, cjk, extA, puaRatio, extARatio,
            garbled: total < 20 || puaRatio > 0.03 || (pua > 20 && cjk < pua),
          };
        }

        // Chấm điểm candidate: ưu tiên text sạch, CJK nhiều, ít cấu trúc JSON/HTML.
        function scoreCandidate(text) {
          const m = analyzeText(text);
          if (m.garbled || m.cjk < 50) return null;
          // phạt nếu trông giống JSON/HTML metadata hơn là văn xuôi
          let structural = 0;
          try {
            structural = (text.match(/[{}\[\]]|":|https?:\/\/|<\/?[a-z]/gi) || []).length;
          } catch (_) {}
          const score = m.cjk - m.pua * 5 - structural * 2;
          return { score, metrics: m };
        }

        const candidates = [];
        function consider(text, source) {
          if (typeof text !== 'string' || text.length < 200) return;
          let scored = null;
          try { scored = scoreCandidate(text); } catch (_) {}
          if (scored) candidates.push({ text, source, ...scored });
        }

        // (a) biến window theo whitelist key (KHÔNG stringify toàn bộ window)
        try {
          const KEY_RE = /content|chapter|read|initial|state/i;
          for (const key of Object.keys(window)) {
            if (!KEY_RE.test(key)) continue;
            let val;
            try { val = window[key]; } catch (_) { continue; }
            if (typeof val === 'string') consider(val, `window.${key}`);
          }
        } catch (_) {}

        // (b) JSON nhúng trong <script type="application/json"> / #__NEXT_DATA__
        try {
          const blocks = document.querySelectorAll(
            'script[type="application/json"], #__NEXT_DATA__'
          );
          for (const s of blocks) {
            const raw = s.textContent || '';
            if (raw.length < 200) continue;
            let obj = null;
            try { obj = JSON.parse(raw); } catch (_) { continue; }
            // recursive walk: CHỈ lấy string dài (> 500), giới hạn độ sâu/số node
            const stack = [obj];
            let visited = 0;
            while (stack.length && visited < 5000) {
              const cur = stack.pop();
              visited++;
              if (typeof cur === 'string') {
                if (cur.length > 500) consider(cur, `json:${s.id || s.type}`);
              } else if (cur && typeof cur === 'object') {
                for (const k of Object.keys(cur)) {
                  try { stack.push(cur[k]); } catch (_) {}
                }
              }
            }
          }
        } catch (_) {}

        if (!candidates.length) return null;
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        return { text: best.text, source: best.source, metrics: best.metrics };
      },
    });
    return result || null;
  } catch (_) {
    // MAIN world có thể bị page chặn / executeScript lỗi → coi như không có candidate
    return null;
  }
}

// ── Lớp 2: innerText nhiều selector, chấm điểm TỪNG selector (isolated world) ──
// Không lấy "chuỗi dài nhất" (dễ dính cả menu/comment/recommendation). Thay vào đó
// mỗi selector chạy analyzeText, ưu tiên !garbled + CJK cao + độ dài hợp lý.
async function scanDomSelectors(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    // KHÔNG truyền analyzeText qua string + new Function: CSP của trang chặn unsafe-eval
    // trong injected script → throw → text rỗng → báo nhầm "trang chặn". Nhúng thẳng
    // bản copy analyzeText vào trong func này (nếu sửa heuristic, sửa cả 3 bản).
    func: () => {
      function analyzeText(text) {
        let total = 0, pua = 0, suspicious = 0, cjk = 0, extA = 0;
        for (const ch of text || '') {
          if (/\s/.test(ch)) continue;
          total++;
          const cp = ch.codePointAt(0);
          const isPua =
            (cp >= 0xE000 && cp <= 0xF8FF) ||
            (cp >= 0xF0000 && cp <= 0xFFFFD) ||
            (cp >= 0x100000 && cp <= 0x10FFFD);
          const isExtA = (cp >= 0x3400 && cp <= 0x4DBF);
          const isCjk =
            (cp >= 0x3400 && cp <= 0x9FFF) ||
            (cp >= 0x20000 && cp <= 0x323AF);
          if (isPua) pua++;
          else if (!isCjk && cp > 0xFFFF) suspicious++;
          if (isExtA) extA++;
          if (isCjk) cjk++;
        }
        const puaRatio = total ? pua / total : 1;
        const extARatio = total ? extA / total : 0;
        return {
          total, pua, suspicious, cjk, extA, puaRatio, extARatio,
          garbled: total < 20 || puaRatio > 0.03 || (pua > 20 && cjk < pua),
        };
      }

      // Layout mới của Qidian: khối chương là <main id="c-<id>" class="content ...">,
      // id động theo chapter nên dùng prefix selector. `main[id^='c-']` + `main.content`
      // bắt được layout này; phần còn lại giữ cho layout cũ.
      const SELECTORS = [
        "main[id^='c-']", "main.content", "main[data-type='cjk']",
        "#j_chapterContent", "#j_chapterBox",
        ".read-content", ".read-content.j_readContent", ".chapter-content",
        "main .content",
      ];
      // Cờ chắc chắn nhất: class r-font-encrypt nghĩa là trang render bằng font mã hóa.
      // Nếu thấy nó, đánh dấu garbled bất kể analyzeText (font có thể map sang ký tự
      // CJK "thật nhưng sai", không phải lúc nào cũng PUA).
      let fontEncrypted = false;
      try {
        fontEncrypted = !!document.querySelector(
          "[class*='r-font-encrypt'], main[class*='encrypt']"
        );
      } catch (_) {}

      let best = null;
      const seen = new Set();
      for (const sel of SELECTORS) {
        let el;
        try { el = document.querySelector(sel); } catch (_) { continue; }
        if (!el || seen.has(el)) continue;
        seen.add(el);
        const t = (el.innerText || '').trim();
        if (!t) continue;
        const m = analyzeText(t);
        if (fontEncrypted) m.garbled = true; // ép cờ khi trang dùng font mã hóa
        const score = (m.garbled ? -1e9 : 0) + m.cjk - m.pua * 5;
        if (!best || score > best.score) best = { text: t, source: `dom:${sel}`, metrics: m, score };
      }
      if (!best) {
        return { title: document.title, text: '', source: null,
          metrics: fontEncrypted ? { garbled: true } : null, fontEncrypted };
      }
      return { title: document.title, text: best.text, source: best.source,
        metrics: best.metrics, fontEncrypted };
    },
  });
  return result || { title: '', text: '', source: null, metrics: null };
}

// ── Pipeline tổng: Lớp 1 (MAIN) → Lớp 2 (DOM) → Lớp 3 (quyết định) ────────────
async function extractTextFromPage(tabId) {
  const dom = await scanDomSelectors(tabId);
  // Title qidian dạng "第X章 ... _《Truyện》 - 起点中文网" → cắt từ "_" đầu tiên.
  const title = (dom.title || '').split('_')[0].replace(/ [-—].*$/, '').trim();

  // Trang dùng font mã hóa (class r-font-encrypt): KHÔNG lấy text dù layer nào.
  // Biến page context có thể vẫn là bản đã giải mã, nhưng không có bằng chứng nên
  // ưu tiên an toàn — báo garbled để người dùng chụp ảnh.
  if (dom.fontEncrypted) {
    console.log('[extract] font-encrypted page → buộc garbled');
    return { title, text: '', source: 'r-font-encrypt', metrics: dom.metrics, garbled: true };
  }

  // Lớp 1: candidate sạch từ page context → ưu tiên
  const ctx = await scanPageContext(tabId);
  if (ctx && ctx.metrics && !ctx.metrics.garbled) {
    console.log('[extract] page-context', ctx.source,
      'puaRatio', (ctx.metrics.puaRatio ?? 0).toFixed(4),
      'extARatio', (ctx.metrics.extARatio ?? 0).toFixed(4), 'len', ctx.text.length);
    return { title, text: ctx.text, source: ctx.source, metrics: ctx.metrics, garbled: false };
  }

  // Lớp 2: DOM innerText
  if (dom.text && dom.metrics) {
    console.log('[extract]', dom.source,
      'puaRatio', (dom.metrics.puaRatio ?? 0).toFixed(4),
      'extARatio', (dom.metrics.extARatio ?? 0).toFixed(4),
      'len', dom.text.length, 'garbled', dom.metrics.garbled);
    return {
      title, text: dom.text, source: dom.source,
      metrics: dom.metrics, garbled: !!dom.metrics.garbled,
    };
  }

  // Không có gì
  return { title, text: '', source: null, metrics: null, garbled: false };
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
    const { title, text: rawText, garbled } = await extractTextFromPage(tab.id);
    const text = cleanExtractedText(rawText);
    if (garbled) {
      setStatus("Trang dùng font mã hóa — hãy bấm '📷 Chụp ảnh' để OCR thay vì lấy text.");
      return;
    }
    if (!text || text.length < 50) {
      setStatus('Không lấy được nội dung (trang chặn → thử reload, hoặc hãy chụp ảnh).');
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

// ── Thao tác 3: Gửi text thẳng lên server (POST /api/chapters/upload) ──────────
// Đọc innerText như nút "Copy text", nhưng thay vì tải .txt về Downloads thì gửi
// multipart lên backend. Backend tự ghi vào input_dir + đăng ký DB; tên file
// (kèm số chương) được suy từ field name của UploadFile nên phải đặt đúng .txt.
btnSendServer.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab.url?.includes('qidian.com/chapter/')) {
    setStatus('Hãy mở một trang chapter trên qidian.com.');
    return;
  }
  const slug = normalizeSlug(novelSlugInput.value);
  if (slug === 'unknown') {
    setStatus('Hãy nhập Novel Slug trước khi gửi lên server.');
    return;
  }

  btnSendServer.disabled = true;
  setProgress(0);
  try {
    setStatus('Đang đọc nội dung từ trang...');
    const { title, text: rawText, garbled } = await extractTextFromPage(tab.id);
    const text = cleanExtractedText(rawText);
    if (garbled) {
      setStatus("Trang dùng font mã hóa — hãy bấm '📷 Chụp ảnh' để OCR thay vì gửi text rác.");
      return;
    }
    if (!text || text.length < 50) {
      setStatus('Không lấy được nội dung (trang chặn → thử reload, hoặc hãy chụp ảnh).');
      return;
    }

    const safeTitle = sanitizeFilename(title.replace(/_.*$/, '').replace(/ [-—].*$/, '').trim());
    const filename  = `${safeTitle}.txt`;
    const blob      = new Blob([text], { type: 'text/plain;charset=utf-8' });

    const form = new FormData();
    form.append('novel_slug', slug);
    form.append('files', blob, filename);

    const server = getServerUrl();
    setStatus(`Đang gửi lên ${server}...`);
    const resp = await fetch(`${server}/api/chapters/upload`, { method: 'POST', body: form });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    // Xác minh là JSON trước khi parse — nếu URL trỏ nhầm (vd vào một trang HTML
    // bất kỳ trả 200) thì báo lỗi rõ ràng thay vì "Unexpected token <".
    const ctype = resp.headers.get('content-type') || '';
    if (!ctype.includes('application/json')) {
      throw new Error('phản hồi không phải JSON — kiểm tra lại Server URL có đúng backend không');
    }
    const data = await resp.json();

    const saved  = data.saved?.length || 0;
    const errors = data.errors || [];
    previewEl.textContent = text.slice(0, 600) + (text.length > 600 ? '…' : '');
    previewEl.style.display = 'block';
    charCountEl.textContent = `${text.length.toLocaleString()} ký tự`;
    setProgress(100);
    if (errors.length) {
      setStatus(`⚠ Server báo lỗi: ${errors.join('; ')}`);
    } else {
      setStatus(`✓ Đã gửi lên server (${saved} file): ${filename}`);
    }
  } catch (err) {
    setStatus(`Lỗi gửi server: ${err.message} (server đã chạy ở ${getServerUrl()}?)`);
  } finally {
    btnSendServer.disabled = false;
  }
});
