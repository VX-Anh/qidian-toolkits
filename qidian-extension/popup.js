// ── DOM refs ──────────────────────────────────────────────────────────────────
const btnCapture     = document.getElementById('btnCapture');    // chụp ảnh → .jpg
const btnSendImages  = document.getElementById('btnSendImages');  // chụp ảnh → OCR server
const btnCopyTxt     = document.getElementById('btnCopyTxt');     // copy text → .txt
const btnSendServer  = document.getElementById('btnSendServer');  // gửi text → server
const statusEl       = document.getElementById('status');
const progressBar    = document.getElementById('progressBar');
const previewEl      = document.getElementById('preview');
const charCountEl    = document.getElementById('charCount');
const warningEl      = document.getElementById('warning');
const novelSlugInput = document.getElementById('novelSlug');
const serverUrlInput = document.getElementById('serverUrl');
const apiTokenInput  = document.getElementById('apiToken');

// ── Capture tuning ────────────────────────────────────────────────────────────
const FALLBACK_CROP_X = 600;
const FALLBACK_CROP_W = 695;
const CHUNK_H         = 1400;
const OVERLAP_H       = 120;
const SAFE_PADDING    = 20;
const MAX_RETRY       = 2;
const PRE_SETTLE_MS   = 600;
const POST_SCROLL_MS  = 400;
const FONT_WAIT_MS    = 12000; // deadline tổng chờ font mã hóa Qidian load xong
const FONT_POLL_MS    = 200;   // chu kỳ poll document.fonts.check()
const FONT_SETTLE_MS  = 250;   // đệm sau khi font ready + paint để chắc chắn vẽ xong
const MIN_CHUNK_RATIO = 0.55;
const EXPORT_BASE_DIR = 'data/vietphase';
const DEFAULT_SERVER  = 'http://localhost:9999';
const NATIVE_HOST_NAME        = 'com.qidian.screenshot_host';
const CHUNK_SCROLL_SETTLE_MS  = 150; // đệm sau khi cuộn thật tới từng chunk, trước khi chụp
const VIEWPORT_MARGIN         = 20;  // đệm an toàn dưới viewport thật khi tính chunk cao tối đa

// Đo vùng nội dung. Chạy qua chrome.scripting.executeScript({func: detectContentBounds})
// — KHÔNG dùng string+eval (CSP của trang chặn unsafe-eval trong injected script).
function detectContentBounds() {
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
    viewportHeight: window.innerHeight,
  };
}

// Chờ ĐÚNG font mã hóa đang áp lên khối nội dung load xong (thay vì tin
// document.fonts.ready — nó resolve sớm khi font nạp lazy chưa được request).
// Chạy qua chrome.scripting.executeScript({func: waitForEncryptedFont, args:[waitMs,pollMs]}).
async function waitForEncryptedFont(waitMs, pollMs) {
  const t0 = performance.now();
  const SYSTEM_FONTS = new Set(['serif','sans-serif','monospace','cursive','fantasy',
    'system-ui','ui-serif','ui-sans-serif','ui-monospace','segoe ui','arial','helvetica',
    'helvetica neue','tahoma','verdana','times new roman','georgia','pingfang sc',
    'pingfang tc','hiragino sans gb','microsoft yahei','simsun','simhei','stheiti',
    'noto sans cjk sc','source han sans sc','source han sans cn','wenquanyi micro hei']);

  // Ưu tiên phần tử mang class encrypt (cùng selector với scanDomSelectors);
  // fallback: khối nội dung như detectContentBounds.
  let el = document.querySelector("[class*='r-font-encrypt'], main[class*='encrypt']");
  const encrypted = !!el;
  if (!el) {
    const SELS = ["main[data-type='cjk']","#j_chapterContent",".read-content",".chapter-content"];
    for (const s of SELS) { el = document.querySelector(s); if (el) break; }
  }
  if (!el) return { encrypted: false, loaded: true, family: null, waitedMs: 0 };

  // Tách font-family, loại font hệ thống — còn lại là web-font tùy biến (font mã
  // hóa Qidian là font tên ngẫu nhiên đứng đầu danh sách).
  const families = getComputedStyle(el).fontFamily
    .split(',')
    .map(f => f.trim().replace(/^["']|["']$/g, ''))
    .filter(f => f && !SYSTEM_FONTS.has(f.toLowerCase()));
  if (!families.length) return { encrypted, loaded: !encrypted, family: null, waitedMs: 0 };

  // Sample text lấy từ chính nội dung để check đúng dải glyph đang dùng.
  const sampleText = (el.textContent || '').replace(/\s+/g, '').slice(0, 30) || '一';
  const specs = families.map(f => '16px "' + f + '"');

  // Ép trình duyệt request font nếu nó đang nạp lazy (không chờ kết quả ở đây —
  // vòng poll fonts.check() bên dưới mới là nguồn sự thật).
  for (const spec of specs) { try { document.fonts.load(spec, sampleText); } catch (e) {} }

  const deadline = t0 + waitMs;
  const check = () => specs.every(spec => {
    try { return document.fonts.check(spec, sampleText); } catch (e) { return true; }
  });
  let loaded = check();
  while (!loaded && performance.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    loaded = check();
  }

  // Font loaded ≠ đã paint: chờ 2 frame để trình duyệt vẽ lại xong.
  if (loaded) await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  return { encrypted, loaded, family: families.join(', '),
           waitedMs: Math.round(performance.now() - t0) };
}

// Cuộn THẬT tới y (tọa độ tuyệt đối tài liệu), chờ 2 khung paint, rồi báo lại vị
// trí cuộn thực tế đạt được (có thể bị kẹp ở cuối trang) + tọa độ màn hình của
// viewport hiện tại. LƯU Ý: dù MDN mô tả window.screenY là đỉnh VIEWPORT (dưới
// thanh tab/toolbar), thực tế đo được trên Chrome lại là đỉnh CỬA SỔ NGOÀI (kể
// cả thanh tab) — ảnh chụp thử bị dính nguyên thanh tab ở trên vì tin thẳng giá
// trị này. Phải tự bù chênh lệch bằng outerHeight-innerHeight (xem toPhysicalRect).
function scrollAndReport(y) {
  window.scrollTo(0, y);
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      resolve({
        scrollY: window.scrollY,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        screenX: window.screenX,
        screenY: window.screenY,
        devicePixelRatio: window.devicePixelRatio || 1,
      });
    }));
  });
}

// ── Restore novel slug + server URL ───────────────────────────────────────────
chrome.storage.local.get(['novel_slug', 'server_url', 'api_token'], (s) => {
  if (s.novel_slug) novelSlugInput.value = s.novel_slug;
  serverUrlInput.value = s.server_url || DEFAULT_SERVER;
  apiTokenInput.value = s.api_token || '';
});
novelSlugInput.addEventListener('input', () =>
  chrome.storage.local.set({ novel_slug: novelSlugInput.value.trim() }));
serverUrlInput.addEventListener('input', () =>
  chrome.storage.local.set({ server_url: serverUrlInput.value.trim() }));
apiTokenInput.addEventListener('input', () =>
  chrome.storage.local.set({ api_token: apiTokenInput.value.trim() }));

// Bỏ dấu "/" cuối để khi nối path không sinh "//". Rỗng → mặc định localhost.
function getServerUrl() {
  return (serverUrlInput.value.trim() || DEFAULT_SERVER).replace(/\/+$/, '');
}

// Header xác thực cho server bật API_TOKEN (rỗng = server chạy local không auth).
function authHeaders() {
  const t = apiTokenInput.value.trim();
  return t ? { 'X-API-Token': t } : {};
}

// EventSource không gắn được header → truyền token qua query.
function withToken(url) {
  const t = apiTokenInput.value.trim();
  return t ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}` : url;
}

// Manifest cấp sẵn quyền cho qidian, localhost và aico.io.vn (+ subdomain). Server khác → xin quyền
// cho đúng origin đó (optional_host_permissions). Gọi ngay đầu click handler để
// còn trong user gesture.
async function ensureServerPermission() {
  let origin;
  try { origin = new URL(getServerUrl()).origin; }
  catch (_) { setStatus('Server URL không hợp lệ.'); return false; }
  const origins = [`${origin}/*`];
  if (await chrome.permissions.contains({ origins })) return true;
  const ok = await chrome.permissions.request({ origins });
  if (!ok) setStatus(`Chưa cấp quyền truy cập ${origin} — không gửi được.`);
  return ok;
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

// ── Native Messaging: chụp màn hình THẬT qua qidian_screenshot_host.py ────────
// Không còn dùng chrome.debugger/CDP cho việc chụp (né lỗi Chromium render sai
// glyph khi captureBeyondViewport chụp vùng "ngoài viewport" chưa từng paint
// thật — xem qidian-extension/docs/native-screenshot-tool-plan.md). Host native
// đọc thẳng pixel màn hình bằng mss, y hệt Windows Snipping Tool.
function openNativeCapturePort() {
  // Port tự mở lại nếu host đã ngắt (crash, message quá lớn...) — trước đây sau
  // một lần ngắt, mọi lần thử lại đều báo "đang bận" và che mất lỗi thật.
  let port = null;
  let pending = null;
  let parts = [];   // host chia ảnh lớn thành nhiều message {part,total,chunk}

  function settle(fn, value) {
    if (!pending) return;
    const p = pending; pending = null; parts = [];
    p[fn](value);
  }

  function connect() {
    const p = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    p.onMessage.addListener((msg) => {
      if (!pending) return;
      if (msg && msg.ok && typeof msg.total === 'number') {
        parts[msg.part] = msg.chunk;
        if (parts.filter(x => x !== undefined).length < msg.total) return;  // chờ đủ phần
        settle('resolve', { ok: true, dataUrl: parts.join('') });
      } else {
        settle('resolve', msg);   // ping / lỗi / định dạng cũ có dataUrl
      }
    });
    p.onDisconnect.addListener(() => {
      if (port === p) port = null;
      settle('reject', new Error(chrome.runtime.lastError?.message ||
        'Native host đã ngắt kết nối — đã cài đặt qidian-extension/native-host/install.ps1 chưa?'));
    });
    return p;
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      if (pending) { reject(new Error('native port đang bận (gọi chồng lệnh)')); return; }
      pending = { resolve, reject };
      try {
        if (!port) port = connect();
        port.postMessage(msg);
      } catch (err) {
        port = null;
        settle('reject', err);
      }
    });
  }
  return { send, disconnect: () => { if (port) port.disconnect(); port = null; } };
}

async function captureViaNativeHost(nativePort, rect) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      if (attempt > 0) await wait(300 * attempt);
      const resp = await nativePort.send({ action: 'capture', ...rect });
      if (!resp.ok) throw new Error(resp.error || 'native host trả lỗi không rõ');
      return resp.dataUrl;
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// Quy đổi tọa độ CSS-px trong viewport hiện tại (sau khi đã cuộn) sang tọa độ
// VẬT LÝ trên màn hình thật, để native host chụp đúng vùng. window.screenX/screenY
// đã bao gồm vị trí cửa sổ + chiều cao thanh công cụ trình duyệt.
function toPhysicalRect(scrollInfo, viewportRelX, viewportRelY, width, height) {
  const dpr = scrollInfo.devicePixelRatio || 1;
  // Bù chênh lệch giữa "đỉnh cửa sổ ngoài" (window.screenY đo được thực tế) và
  // "đỉnh viewport nội dung" (dưới thanh tab/toolbar) — xem ghi chú ở scrollAndReport.
  const chromeUIHeight = Math.max(0, (scrollInfo.outerHeight || 0) - (scrollInfo.innerHeight || 0));
  return {
    x: Math.round((scrollInfo.screenX + viewportRelX) * dpr),
    y: Math.round((scrollInfo.screenY + chromeUIHeight + viewportRelY) * dpr),
    width: Math.round(width * dpr),
    height: Math.round(height * dpr),
  };
}

async function captureChapter(tabId) {
  const shots = [];

  // Toạ độ chụp quy đổi từ CSS px × devicePixelRatio. Khi zoom trang khác 100%,
  // innerHeight (CSS px, có zoom) và outerHeight (không zoom) lệch nhau → vùng
  // chụp lệch, mất dòng đầu/cuối mỗi đoạn. Bắt buộc zoom 100%.
  const zoom = await chrome.tabs.getZoom(tabId);
  if (Math.abs(zoom - 1) > 0.01) {
    throw new Error(`Trang đang zoom ${Math.round(zoom * 100)}% — đặt về 100% (Ctrl+0) rồi chụp lại.`);
  }
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  if (win.state !== 'maximized' && win.state !== 'fullscreen') {
    // Cửa sổ thường có viền resize vô hình ~7px làm lệch toạ độ dọc; overlap giữa
    // các đoạn thường bù được, nhưng phóng to cửa sổ là chắc ăn nhất.
    setStatus('Lưu ý: nên phóng to (maximize) cửa sổ Chrome để vùng chụp chính xác.');
  }

  const nativePort = openNativeCapturePort();

  try {
    // Phase 1: Pre-scroll để ổn định JS/ads động trước khi đo
    setStatus('Đang ổn định trang...');
    await chrome.scripting.executeScript({
      target: { tabId }, func: () => window.scrollTo(0, document.body.scrollHeight),
    });
    await wait(PRE_SETTLE_MS);
    await chrome.scripting.executeScript({
      target: { tabId }, func: () => window.scrollTo(0, 0),
    });
    await wait(POST_SCROLL_MS);

    // Phase 1.5: CHỜ ĐÚNG FONT MÃ HÓA LOAD + PAINT XONG trước khi đo/chụp.
    // Qidian dùng font mã hóa (r-font-encrypt): mã ký tự trong DOM bị xáo trộn,
    // chỉ hiển thị ĐÚNG khi web-font tùy biến đã được apply. document.fonts.ready
    // KHÔNG đủ tin (resolve sớm khi font nạp lazy chưa được request), nên
    // waitForEncryptedFont chủ động ép load (fonts.load) rồi poll fonts.check()
    // cho chính font đang áp lên khối nội dung, kèm double-rAF chờ paint. Quá
    // hạn mà font chưa load → DỪNG hẳn thay vì âm thầm chụp ảnh hỏng.
    setStatus('Đang chờ font mã hóa load...');
    const [{ result: fontInfo }] = await chrome.scripting.executeScript({
      target: { tabId }, func: waitForEncryptedFont, args: [FONT_WAIT_MS, FONT_POLL_MS],
    });
    if (fontInfo?.encrypted && !fontInfo.loaded) {
      throw new Error(
        `Font mã hóa chưa load xong sau ${Math.round(FONT_WAIT_MS / 1000)}s — hãy reload trang rồi chụp lại.`);
    }
    await wait(FONT_SETTLE_MS);

    // Phase 2: Detect element bounds sau khi DOM ổn định
    const [{ result: info }] = await chrome.scripting.executeScript({
      target: { tabId }, func: detectContentBounds,
    });
    if (!info) return [];

    // KHÔNG gọi chrome.windows.update({focused:true}) ở đây: nó chuyển focus
    // OS sang cửa sổ Chrome, mà popup extension tự đóng ngay khi mất focus —
    // giết cả tiến trình chụp đang chạy dở. Chấp nhận đánh đổi: giả định cửa
    // sổ Chrome đã ở trên cùng vì người dùng vừa bấm nút trong chính popup đó.

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

    // Chụp giờ đọc đúng pixel màn hình thật (không còn captureBeyondViewport) —
    // mỗi chunk phải cuộn thật vào trong viewport rồi mới chụp được, nên chiều
    // cao mỗi chunk phải nằm gọn trong viewport thật, trừ hao OVERLAP_H (chunk
    // sau lùi lại OVERLAP_H) + SAFE_PADDING (snap có thể vượt nhẹ) + đệm an toàn.
    const effectiveChunkH = Math.max(300,
      Math.min(CHUNK_H, info.viewportHeight - SAFE_PADDING - VIEWPORT_MARGIN - OVERLAP_H));

    // Phase 4: Chunked capture, ưu tiên cắt ở đáy đoạn <p> để tránh cắt ngang dòng
    const paragraphBottoms = Array.isArray(info.paragraphBottoms) ? info.paragraphBottoms : [];
    let y = startY;
    let idx = 0;
    while (y < endY) {
      const progressed = Math.max(0, y - startY);
      setProgress(Math.round((progressed / totalH) * 100));
      setStatus(`Chụp vùng ${idx + 1}...`);

      const targetEnd = Math.min(endY, y + effectiveChunkH);
      const minSnapY = y + Math.floor(effectiveChunkH * MIN_CHUNK_RATIO);
      const snappedEnd = paragraphBottoms.length ? pickLastInRange(paragraphBottoms, minSnapY, targetEnd) : null;
      const endAt = (snappedEnd && snappedEnd > y) ? Math.min(endY, snappedEnd + SAFE_PADDING) : targetEnd;

      const captureY = (idx === 0) ? y : Math.max(startY, y - OVERLAP_H);
      const captureH = Math.max(1, endAt - captureY);

      // Cuộn THẬT tới vùng cần chụp, chờ paint xong, đọc lại vị trí cuộn/màn
      // hình thực tế (có thể bị kẹp ở cuối trang, khác với captureY yêu cầu).
      const [{ result: scrollInfo }] = await chrome.scripting.executeScript({
        target: { tabId }, func: scrollAndReport, args: [captureY],
      });
      await wait(CHUNK_SCROLL_SETTLE_MS);

      const viewportRelY = captureY - scrollInfo.scrollY;
      const clipH = Math.max(1, Math.min(captureH, scrollInfo.innerHeight - viewportRelY));
      const rect = toPhysicalRect(scrollInfo, cropX, viewportRelY, cropW, clipH);

      const dataUrl = await captureViaNativeHost(nativePort, rect);
      shots.push(dataUrl);

      // Nếu viewport thật buộc phải chụp ngắn hơn dự kiến (hiếm — vd kẹp cuối
      // trang), tiếp tục đúng từ điểm ĐÃ chụp thay vì endAt lý thuyết, để không
      // mất nội dung ở khoảng bị hụt.
      y = (clipH < captureH) ? (captureY + clipH) : endAt;
      idx++;
    }
  } finally {
    nativePort.disconnect();
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

// ── Thao tác 1b: Chụp ảnh → gửi thẳng lên server OCR (POST /api/ocr/upload) ────
// Không tải .jpg về Downloads mà POST multipart các ảnh lên backend; backend chạy
// OCR (PaddleOCR mặc định) rồi phát tiến trình qua SSE /api/ocr/stream/{job_id}.
function streamOcr(server, jobId) {
  return new Promise((resolve) => {
    const es = new EventSource(withToken(`${server}/api/ocr/stream/${jobId}`));
    let tokenText = '';
    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      switch (msg.type) {
        case 'ocr_progress':
          setStatus(msg.msg || 'Đang OCR…');
          if (msg.total) setProgress(Math.round((msg.page / msg.total) * 100));
          break;
        case 'ocr_token': // chỉ engine gemini stream token; paddle không có
          tokenText += msg.text || '';
          previewEl.textContent = tokenText.slice(-600);
          previewEl.style.display = 'block';
          break;
        case 'ocr_done':
          setProgress(100);
          previewEl.textContent = (msg.preview || '').slice(0, 600);
          previewEl.style.display = 'block';
          charCountEl.textContent = `${(msg.char_count || 0).toLocaleString()} ký tự`;
          setStatus(`✓ OCR xong: ${msg.filename}`);
          es.close();
          resolve();
          break;
        case 'ocr_error':
          setStatus(`⚠ OCR lỗi: ${msg.msg}`);
          es.close();
          resolve();
          break;
      }
    };
    // Stream đóng bằng sentinel None ở server → EventSource coi là lỗi kết nối; nếu
    // chưa nhận ocr_done/ocr_error thì cũng dừng để không treo nút.
    es.onerror = () => { es.close(); resolve(); };
  });
}

btnSendImages.addEventListener('click', async () => {
  if (!(await ensureServerPermission())) return;
  const tab = await getActiveTab();
  if (!tab.url?.includes('qidian.com/chapter/')) {
    setStatus('Hãy mở một trang chapter trên qidian.com.');
    return;
  }
  const slug = normalizeSlug(novelSlugInput.value);
  if (slug === 'unknown') {
    setStatus('Hãy nhập Novel Slug trước khi gửi ảnh lên server.');
    return;
  }

  btnSendImages.disabled = true;
  warningEl.style.display = 'block';
  previewEl.style.display = 'none';
  setProgress(0);

  try {
    const screenshots = await captureChapter(tab.id);
    if (!screenshots.length) {
      setStatus('Không tìm thấy vùng nội dung. Thử reload trang rồi chụp lại.');
      return;
    }
    warningEl.style.display = 'none';

    const form = new FormData();
    form.append('novel_slug', slug);
    // Title thô của tab (dạng "第675章 天演 - ..._起点中文网") để backend tự tách
    // tên chương chuẩn; engine để trống → server dùng OCR_DEFAULT_ENGINE (paddle).
    form.append('chapter_title', tab.title || '');
    for (let i = 0; i < screenshots.length; i++) {
      const blob = await (await fetch(screenshots[i])).blob();
      form.append('images', blob, `shot_${String(i + 1).padStart(2, '0')}.jpg`);
    }

    const server = getServerUrl();
    setStatus(`Đang gửi ${screenshots.length} ảnh lên ${server} để OCR...`);
    const resp = await fetch(`${server}/api/ocr/upload`, { method: 'POST', body: form, headers: authHeaders() });
    if (resp.status === 401) throw new Error("server từ chối (401) — kiểm tra API token");
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    const ctype = resp.headers.get('content-type') || '';
    if (!ctype.includes('application/json')) {
      throw new Error('phản hồi không phải JSON — kiểm tra lại Server URL có đúng backend không');
    }
    const { job_id, engine } = await resp.json();
    setStatus(`OCR (${engine}) đang chạy trên server…`);
    await streamOcr(server, job_id);
  } catch (err) {
    setStatus(`Lỗi gửi ảnh OCR: ${err.message} (server đã chạy ở ${getServerUrl()}?)`);
  } finally {
    btnSendImages.disabled = false;
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
  if (!(await ensureServerPermission())) return;
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
    const resp = await fetch(`${server}/api/chapters/upload`, { method: 'POST', body: form, headers: authHeaders() });
    if (resp.status === 401) throw new Error("server từ chối (401) — kiểm tra API token");
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
