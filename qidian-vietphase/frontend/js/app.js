// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  currentNovel: null,
  chapters: [],
  novelProfile: null,
  currentGlossarySection: 'characters',
  activeJobId: null,
  eventSource: null,
  isRunning: false,
  filter: { query: '', status: 'all' },
  translationView: null,  // { filename, chapter } | null
};

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const bg     = { info: '#1e293b', error: '#450a0a', success: '#052e16' }[type] ?? '#1e293b';
  const border = { info: '#334155', error: '#7f1d1d', success: '#14532d' }[type] ?? '#334155';
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;bottom:1.25rem;right:1.25rem;z-index:9999;
    padding:10px 16px;border-radius:8px;font-size:0.875rem;color:#e2e8f0;
    background:${bg};border:1px solid ${border};box-shadow:0 4px 12px #0008;
    animation:fadeInUp .2s ease;max-width:360px;`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3000);
  setTimeout(() => el.remove(), 3400);
}

// ── Utils ─────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  },
  async put(url, body) {
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  },
  async delete(url) {
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  },
};

function statusBadge(status) {
  if (status === 'ocr') return '<span class="badge badge-ocr">⚙ OCR</span>';
  const labels = { pending: 'Chờ', in_progress: '⟳ Đang dịch', done: '✓ Xong', failed: '✗ Lỗi' };
  return `<span class="badge badge-${status}">${labels[status] || status}</span>`;
}

function reviewBadge(status) {
  if (!status) return '—';
  if (status === 'ok') return '<span class="badge badge-review-ok">✓ OK</span>';
  if (status === 'needs_fix') return '<span class="badge badge-review-fix">⚠ Sửa</span>';
  return `<span class="badge">${status}</span>`;
}

function updateRetranslateBtn() {
  const count = state.chapters.filter(c => c.review_status === 'needs_fix').length;
  $('retranslateCount').textContent = count;
  $('btnRetranslate').classList.toggle('hidden', count === 0 || state.isRunning);
}

function log(msg, cls = 'log-info') {
  $('logContainer').classList.remove('hidden');
  const box = $('logBox');
  const line = document.createElement('div');
  line.className = `log-line ${cls}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ── Health check ──────────────────────────────────────────────────────────────
let _healthOk = null;

async function checkHealth() {
  try {
    await fetch('/health');
    if (_healthOk !== true) {
      _healthOk = true;
      const dot = $('statusDot');
      dot.style.background = '#22c55e'; // green-500
      dot.title = 'Server đang chạy';
    }
  } catch {
    if (_healthOk !== false) {
      _healthOk = false;
      const dot = $('statusDot');
      dot.style.background = '#ef4444'; // red-500
      dot.title = 'Không kết nối được server';
    }
  }
}

checkHealth();
setInterval(checkHealth, 10_000);

// ── Log auto-collapse ─────────────────────────────────────────────────────────
let _logCollapseTimer = null;

function scheduleLogCollapse() {
  clearTimeout(_logCollapseTimer);
  _logCollapseTimer = setTimeout(() => {
    const box = $('logBox');
    if (box.style.display !== 'none') {
      box.style.display = 'none';
      $('btnToggleLog').textContent = 'Mở rộng';
    }
  }, 30_000);
}

function cancelLogCollapse() {
  clearTimeout(_logCollapseTimer);
  _logCollapseTimer = null;
}

// ── Job running state ──────────────────────────────────────────────────────────
function setJobRunning(running) {
  state.isRunning = running;
  $('btnTranslateAll').disabled = running;
  $('btnTranslateAll').textContent = running ? '⟳ Đang dịch...' : 'Dịch tất cả';
  $('btnCancelJob').classList.toggle('hidden', !running);
  if (!running) {
    scheduleLogCollapse();
    $('streamPanel').classList.add('hidden');
    $('streamContent').textContent = '';
  } else {
    $('btnRetranslate').classList.add('hidden');
    cancelLogCollapse();
  }
  updateTranslateBtn();
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(s => s.classList.add('hidden'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.remove('hidden');

    if (btn.dataset.tab === 'glossary') renderGlossary();
    if (btn.dataset.tab === 'output') renderOutputSidebar();
    if (btn.dataset.tab === 'settings') loadNovelEditor();
  });
});

// ── Novel Select ──────────────────────────────────────────────────────────────
async function loadNovels() {
  try {
    const novels = await api.get('/api/novels');
    const sel = $('novelSelect');
    sel.innerHTML = '<option value="">-- Chọn truyện --</option>';
    novels.forEach(n => {
      const opt = document.createElement('option');
      opt.value = n.slug;
      opt.textContent = `${n.vi_name} (${n.zh_name})`;
      sel.appendChild(opt);
    });
  } catch (err) {
    toast(`Không tải được danh sách truyện: ${err.message}`, 'error');
  }
}

$('novelSelect').addEventListener('change', async (e) => {
  state.currentNovel = e.target.value || null;
  stopOcrPolling();
  hideOcrBanner();
  if (!state.currentNovel) return;
  try {
    state.novelProfile = await api.get(`/api/novels/${state.currentNovel}`);
    await loadChapters();
  } catch (err) {
    toast(`Lỗi tải truyện: ${err.message}`, 'error');
  }
});

// ── OCR Live Banner ───────────────────────────────────────────────────────────
let _ocrPollTimer = null;
let _ocrActiveStream = null;

function startOcrPolling() {
  if (_ocrPollTimer) return;
  _ocrPollTimer = setInterval(checkOcrJobs, 2000);
}

function stopOcrPolling() {
  clearInterval(_ocrPollTimer);
  _ocrPollTimer = null;
}

async function checkOcrJobs() {
  if (!state.currentNovel) return;
  try {
    const jobs = await api.get(`/api/ocr/jobs?novel_slug=${state.currentNovel}`);
    if (jobs.length > 0) {
      showOcrBanner(jobs[0].job_id, jobs[0].chapter_title);
    } else {
      hideOcrBanner();
    }
  } catch { /* ignore */ }
}

function showOcrBanner(jobId, chapterTitle) {
  $('ocrLiveBanner').classList.remove('hidden');
  $('ocrBannerTitle').textContent = chapterTitle || '';

  if (_ocrActiveStream?.jobId === jobId) return;
  if (_ocrActiveStream) _ocrActiveStream.es.close();

  const es = new EventSource(`/api/ocr/stream/${jobId}`);
  _ocrActiveStream = { jobId, es };
  let charCount = 0;

  es.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      if (event.type === 'ocr_token') {
        charCount += event.text.length;
        const preview = $('ocrBannerPreview');
        preview.textContent = (preview.textContent + event.text).slice(-400);
        $('ocrBannerCharCount').textContent = `${charCount.toLocaleString()} ký tự`;
      } else if (event.type === 'ocr_done') {
        es.close();
        _ocrActiveStream = null;
        $('ocrBannerTitle').textContent = (chapterTitle || '') + ' ✓';
        $('ocrBannerCharCount').textContent = `${event.char_count.toLocaleString()} ký tự — xong`;
        setTimeout(() => { hideOcrBanner(); loadChapters(); }, 2000);
      } else if (event.type === 'ocr_error') {
        es.close();
        _ocrActiveStream = null;
        $('ocrBannerTitle').textContent = (chapterTitle || '') + ' ✗ ' + event.msg;
        setTimeout(hideOcrBanner, 3000);
      }
    } catch { /* ignore */ }
  };
  es.onerror = () => { es.close(); _ocrActiveStream = null; };
}

function hideOcrBanner() {
  $('ocrLiveBanner').classList.add('hidden');
  $('ocrBannerPreview').textContent = '';
  $('ocrBannerCharCount').textContent = '';
  if (_ocrActiveStream) { _ocrActiveStream.es.close(); _ocrActiveStream = null; }
}

// ── Chapters ──────────────────────────────────────────────────────────────────
async function loadChapters() {
  if (!state.currentNovel) return;
  try {
    state.chapters = await api.get(`/api/chapters?novel_slug=${state.currentNovel}`);
    renderChapterTable();
    renderOutputSidebar();
    updateRetranslateBtn();
    startOcrPolling();
  } catch (err) {
    toast(`Lỗi tải danh sách chương: ${err.message}`, 'error');
  }
}

function matchesFilter(ch) {
  const { query, status } = state.filter;
  if (status !== 'all' && ch.status !== status) return false;
  if (query) {
    const q = query.toLowerCase();
    return (
      String(ch.chapter_num).includes(q) ||
      (ch.zh_title || '').toLowerCase().includes(q) ||
      (ch.vi_title || '').toLowerCase().includes(q)
    );
  }
  return true;
}

function getFilteredChapters() {
  return state.chapters.filter(matchesFilter);
}

function renderChapterTable() {
  const tbody = $('chapterTable');
  tbody.innerHTML = '';

  const done  = state.chapters.filter(c => c.status === 'done').length;
  const total = state.chapters.length;
  if (total > 0) {
    const pct = Math.round((done / total) * 100);
    $('progressBar').classList.remove('hidden');
    $('progressFill').style.width = `${pct}%`;
    $('progressText').textContent = `${done} / ${total} chương`;
  }

  const visible = getFilteredChapters();
  const countEl = $('filterCount');
  countEl.textContent = visible.length < total ? `${visible.length} / ${total}` : `${total} chương`;

  visible.forEach(ch => {
    const tr = document.createElement('tr');
    tr.dataset.filename = ch.filename;

    const tdCheck = document.createElement('td');
    tdCheck.className = 'px-3 py-3';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'chapter-check';
    cb.dataset.file = ch.filename;
    tdCheck.appendChild(cb);

    const tdNum = document.createElement('td');
    tdNum.className = 'px-4 py-3 text-gray-400 font-mono';
    tdNum.textContent = String(ch.chapter_num).padStart(4, '0');

    const tdZh = document.createElement('td');
    tdZh.className = 'px-4 py-3 text-gray-200';
    tdZh.textContent = ch.zh_title || ch.filename;

    const tdVi = document.createElement('td');
    tdVi.className = 'px-4 py-3 text-indigo-300';
    tdVi.textContent = ch.vi_title || '—';

    const tdStatus = document.createElement('td');
    tdStatus.className = 'px-4 py-3';
    tdStatus.innerHTML = statusBadge(ch.status);

    const tdReview = document.createElement('td');
    tdReview.className = 'px-4 py-3';
    tdReview.innerHTML = reviewBadge(ch.review_status || null);
    if (ch.review_status) {
      tdReview.style.cursor = 'pointer';
      tdReview.title = 'Click để xem chi tiết review';
      tdReview.addEventListener('click', () => viewReview(ch));
    }

    const tdView = document.createElement('td');
    tdView.className = 'px-4 py-3 flex items-center gap-2';

    const btnOpen = document.createElement('button');
    btnOpen.className = 'text-xs font-medium text-indigo-400 hover:text-indigo-200 transition';
    btnOpen.textContent = 'Mở';
    btnOpen.addEventListener('click', () => openTranslationView(ch.filename));
    tdView.appendChild(btnOpen);

    if (ch.status === 'done') {
      const btnView = document.createElement('button');
      btnView.className = 'text-xs text-indigo-400 hover:text-indigo-300';
      btnView.textContent = 'Xem';
      btnView.addEventListener('click', () => viewOutput(ch.filename));
      tdView.appendChild(btnView);
    }
    const btnSrc = document.createElement('button');
    btnSrc.className = 'text-xs text-gray-500 hover:text-gray-300';
    btnSrc.textContent = 'Gốc';
    btnSrc.addEventListener('click', () => viewSource(ch.filename));
    tdView.appendChild(btnSrc);

    tr.append(tdCheck, tdNum, tdZh, tdVi, tdStatus, tdReview, tdView);
    tbody.appendChild(tr);
  });

  document.querySelectorAll('.chapter-check').forEach(cb => {
    cb.addEventListener('change', updateTranslateBtn);
  });
}

// Cập nhật 1 hàng mà không rebuild cả bảng
function updateChapterRow(filename, status) {
  const ch = state.chapters.find(c => c.filename === filename);
  if (ch) ch.status = status;

  // Cập nhật progress bar
  const done  = state.chapters.filter(c => c.status === 'done').length;
  const total = state.chapters.length;
  if (total > 0) {
    $('progressFill').style.width = `${Math.round((done / total) * 100)}%`;
    $('progressText').textContent = `${done} / ${total} chương`;
  }

  const tr = document.querySelector(`#chapterTable tr[data-filename="${CSS.escape(filename)}"]`);

  // Nếu row không có trong DOM (bị filter ẩn)
  if (!tr) {
    if (ch && matchesFilter(ch)) renderChapterTable(); // cần hiện lại
    return;
  }

  // Nếu row có trong DOM nhưng filter hiện tại không match (vd filter "done" nhưng status -> in_progress)
  if (ch && !matchesFilter(ch)) {
    tr.remove();
    const countEl = $('filterCount');
    const vis = getFilteredChapters().length;
    countEl.textContent = vis < total ? `${vis} / ${total}` : `${total} chương`;
    return;
  }

  const cells = tr.querySelectorAll('td');
  cells[4].innerHTML = statusBadge(status);
  // cells[5] = review badge — không thay đổi ở đây, chỉ update qua handleEvent review_summary
  cells[6].innerHTML = '';
  if (status === 'done') {
    const btn = document.createElement('button');
    btn.className = 'text-xs text-indigo-400 hover:text-indigo-300';
    btn.textContent = 'Xem';
    btn.addEventListener('click', () => viewOutput(filename));
    cells[6].appendChild(btn);
  } else {
    cells[6].textContent = status === 'in_progress' ? '' : '—';
  }
}

function updateTranslateBtn() {
  const checked = document.querySelectorAll('.chapter-check:checked').length;
  $('btnTranslateSelected').disabled = state.isRunning || checked === 0;
}

$('checkAll').addEventListener('change', (e) => {
  document.querySelectorAll('.chapter-check').forEach(cb => cb.checked = e.target.checked);
  updateTranslateBtn();
});

$('btnSelectAll').addEventListener('click', () => {
  document.querySelectorAll('.chapter-check').forEach(cb => cb.checked = true);
  $('checkAll').checked = true;
  updateTranslateBtn();
});

// Filter
$('filterSearch').addEventListener('input', (e) => {
  state.filter.query = e.target.value.trim();
  renderChapterTable();
});

$('filterStatus').addEventListener('change', (e) => {
  state.filter.status = e.target.value;
  renderChapterTable();
});

// ── Translate ─────────────────────────────────────────────────────────────────
async function startTranslation(filenames) {
  if (!state.currentNovel) { toast('Chọn truyện trước!', 'error'); return; }
  if (state.isRunning) return;

  try {
    const body = { novel_slug: state.currentNovel };
    if (filenames) body.chapter_filenames = filenames;
    const { job_id } = await api.post('/api/translate/start', body);
    state.activeJobId = job_id;
    setJobRunning(true);
    listenToJob(job_id);
  } catch (err) {
    toast(`Không thể bắt đầu dịch: ${err.message}`, 'error');
  }
}

async function cancelJob() {
  if (!state.activeJobId) return;
  try {
    await api.delete(`/api/translate/jobs/${state.activeJobId}`);
  } catch {
    // ignore — still clean up UI
  }
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  setJobRunning(false);
  log('Job đã bị hủy.', 'log-info');
  toast('Đã hủy.', 'info');
  await loadChapters();
}

function listenToJob(jobId) {
  if (state.eventSource) state.eventSource.close();

  const es = new EventSource(`/api/translate/stream/${jobId}`);
  state.eventSource = es;

  es.onmessage = (e) => {
    try { handleEvent(JSON.parse(e.data)); } catch { /* malformed */ }
  };

  es.onerror = () => {
    es.close();
    state.eventSource = null;
    // Chỉ báo lỗi nếu job vẫn đang chạy (chưa nhận done/cancelled)
    if (state.isRunning) {
      log('✗ Mất kết nối với server.', 'log-error');
      toast('Mất kết nối. Kiểm tra server còn chạy không.', 'error');
      setJobRunning(false);
      loadChapters();
    }
  };
}

function handleEvent(event) {
  const { agent, type } = event;

  if (type === 'start') {
    log(`Bắt đầu: ${event.file || event.novel || ''}`, 'log-info');
    if (event.file) updateChapterRow(event.file, 'in_progress');
  } else if (type === 'queued') {
    log(`Hàng đợi: ${event.count} chương`, 'log-info');
  } else if (type === 'tool_call') {
    log(`  → Tool: ${(event.tools || []).join(', ')}`, 'log-tool');
  } else if (type === 'tool_result') {
    if (!event.success) log(`  ✗ Tool ${event.tool}: ${event.preview}`, 'log-error');
  } else if (type === 'token' && agent?.startsWith('translator:')) {
    const file = agent.replace('translator:', '');
    if (state.translationView?.filename === file) {
      const tv = $('tvTranslation');
      tv.textContent += event.text;
      tv.scrollTop = tv.scrollHeight;
      $('tvTranslateStatus').textContent = '⚡ Đang dịch...';
    }
    const panel = $('streamPanel');
    const content = $('streamContent');
    panel.classList.remove('hidden');
    $('streamTitle').textContent = file;
    content.textContent += event.text;
    content.scrollTop = content.scrollHeight;
  } else if (type === 'done' && agent?.startsWith('translator:')) {
    const file = agent.replace('translator:', '');
    log(`  ✓ Xong: ${file}`, 'log-done');
    updateChapterRow(file, 'done');
    $('streamContent').textContent = '';
    if (state.translationView?.filename === file) {
      $('tvStatusBadge').innerHTML = statusBadge('done');
      $('tvTranslateStatus').textContent = '✓ Đã dịch xong';
    }
  } else if (type === 'done' && agent?.startsWith('reviewer:')) {
    const file = agent.replace('reviewer:', '');
    log(`  📝 Review xong: ${file}`, 'log-info');
  } else if (type === 'reviewing') {
    log(`🔍 Đang review ${event.count} chương...`, 'log-info');
  } else if (type === 'review_summary') {
    (event.reviews || []).forEach(r => {
      const ch = state.chapters.find(c => c.filename === r.filename);
      if (ch) { ch.review_status = r.status; ch.review_issues = r.issues; }
      const row = document.querySelector(`#chapterTable tr[data-filename="${CSS.escape(r.filename)}"]`);
      if (row) {
        const td = row.querySelectorAll('td')[5];
        td.innerHTML = reviewBadge(r.status);
        td.style.cursor = 'pointer';
        td.title = 'Click để xem chi tiết review';
        td.onclick = () => viewReview(ch || { filename: r.filename, review_status: r.status, review_issues: r.issues });
      }
    });
    const needsFix = (event.reviews || []).filter(r => r.status === 'needs_fix').length;
    const okCount  = (event.reviews || []).filter(r => r.status === 'ok').length;
    log(`📊 Review xong: ${okCount} OK, ${needsFix} cần sửa`, needsFix > 0 ? 'log-error' : 'log-done');
    if (needsFix > 0) toast(`${needsFix} chương cần dịch lại`, 'info');
    updateRetranslateBtn();
  } else if (type === 'done' && agent === 'orchestrator') {
    log('✓ Hoàn thành tất cả!', 'log-done');
    toast('Dịch xong!', 'success');
    setJobRunning(false);
    loadChapters();
  } else if (type === 'cancelled') {
    log('Job đã bị hủy.', 'log-info');
    setJobRunning(false);
    loadChapters();
  } else if (type === 'error') {
    log(`✗ Lỗi: ${event.error || event.msg}`, 'log-error');
  } else if (type === 'extracting') {
    log('Đang trích xuất thuật ngữ mới...', 'log-info');
  } else if (type === 'skip') {
    log(`  → Bỏ qua (đã dịch): ${event.file}`, 'log-info');
  }
}

async function startRetranslate() {
  if (!state.currentNovel) { toast('Chọn truyện trước!', 'error'); return; }
  if (state.isRunning) return;
  try {
    const checked = [...document.querySelectorAll('.chapter-check:checked')].map(cb => cb.dataset.file);
    const body = { novel_slug: state.currentNovel };
    if (checked.length) body.chapter_filenames = checked;
    const { job_id, count } = await api.post('/api/translate/retranslate', body);
    log(`Dịch lại ${count} chương...`, 'log-info');
    state.activeJobId = job_id;
    setJobRunning(true);
    listenToJob(job_id);
  } catch (err) {
    toast(`Không thể dịch lại: ${err.message}`, 'error');
  }
}

$('btnTranslateSelected').addEventListener('click', () => {
  const checked = [...document.querySelectorAll('.chapter-check:checked')].map(cb => cb.dataset.file);
  startTranslation(checked);
});
$('btnTranslateAll').addEventListener('click', () => startTranslation(null));
$('btnRetranslate').addEventListener('click', startRetranslate);
$('btnCancelJob').addEventListener('click', cancelJob);

// ── Log controls ──────────────────────────────────────────────────────────────
$('btnClearLog').addEventListener('click', () => {
  cancelLogCollapse();
  $('logBox').innerHTML = '';
});

$('btnClearStream').addEventListener('click', () => {
  $('streamContent').textContent = '';
});

$('btnToggleLog').addEventListener('click', () => {
  cancelLogCollapse();
  const box = $('logBox');
  const btn = $('btnToggleLog');
  const collapsed = box.style.display === 'none';
  box.style.display = collapsed ? '' : 'none';
  btn.textContent = collapsed ? 'Thu gọn' : 'Mở rộng';
});

$('logBox').addEventListener('click', cancelLogCollapse);

// ── Glossary ──────────────────────────────────────────────────────────────────
function renderGlossary() {
  if (!state.novelProfile) return;
  const terms = state.novelProfile[state.currentGlossarySection] || [];
  const tbody = $('glossaryTable');
  tbody.innerHTML = '';
  terms.forEach(t => {
    const tr = document.createElement('tr');

    const tdZh = document.createElement('td');
    tdZh.className = 'px-4 py-3 font-mono';
    tdZh.textContent = t.zh;

    const tdVi = document.createElement('td');
    tdVi.className = 'px-4 py-3 text-indigo-300';
    tdVi.textContent = t.vi;

    const tdNotes = document.createElement('td');
    tdNotes.className = 'px-4 py-3 text-gray-500 text-xs';
    tdNotes.textContent = t.notes || '';

    const tdDel = document.createElement('td');
    tdDel.className = 'px-3 py-3';
    const delBtn = document.createElement('button');
    delBtn.className = 'text-gray-600 hover:text-red-400 transition text-xs';
    delBtn.textContent = '✕';
    delBtn.title = `Xóa "${t.zh}"`;
    delBtn.addEventListener('click', () => deleteGlossaryTerm(t.zh));
    tdDel.appendChild(delBtn);

    tr.append(tdZh, tdVi, tdNotes, tdDel);
    tbody.appendChild(tr);
  });
}

async function deleteGlossaryTerm(zh) {
  if (!state.currentNovel) return;
  const sectionMap = {
    characters: 'Nhân vật',
    places:     'Địa danh',
    realms:     'Cảnh giới tu luyện',
    skills:     'Kỹ năng / Pháp thuật',
  };
  const targetSection = sectionMap[state.currentGlossarySection];

  try {
    const raw = await api.get(`/api/novels/${state.currentNovel}/raw`);
    const lines = raw.content.split('\n');
    let inSection = false;
    let removed = false;

    const filtered = lines.filter(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('## ')) {
        inSection = trimmed === `## ${targetSection}`;
        return true;
      }
      if (inSection && !removed) {
        // Match first cell of markdown table row
        const firstCell = trimmed.split('|')[1]?.trim();
        if (firstCell === zh) { removed = true; return false; }
      }
      return true;
    });

    if (!removed) { toast('Không tìm thấy thuật ngữ trong file', 'error'); return; }

    await api.put(`/api/novels/${state.currentNovel}/raw`, { content: filtered.join('\n') });
    state.novelProfile = await api.get(`/api/novels/${state.currentNovel}`);
    renderGlossary();
    toast('Đã xóa thuật ngữ', 'success');
  } catch (err) {
    toast(`Lỗi xóa: ${err.message}`, 'error');
  }
}

document.querySelectorAll('.glossary-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.glossary-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.currentGlossarySection = btn.dataset.section;
    renderGlossary();
  });
});

$('btnAddTerm').addEventListener('click', async () => {
  const zh    = $('termZh').value.trim();
  const vi    = $('termVi').value.trim();
  const type  = $('termType').value;
  const notes = $('termNotes').value.trim();
  if (!zh || !vi) { toast('Nhập tiếng Trung và tiếng Việt', 'error'); return; }
  if (!state.currentNovel) { toast('Chọn truyện trước!', 'error'); return; }

  try {
    const raw = await api.get(`/api/novels/${state.currentNovel}/raw`);
    const sectionMap = { character: 'Nhân vật', place: 'Địa danh', realm: 'Cảnh giới tu luyện', skill: 'Kỹ năng / Pháp thuật' };
    const section = sectionMap[type] || 'Nhân vật';
    const newRow = `| ${zh} | ${vi} | ${notes} |`;
    let content = raw.content;
    const marker = `## ${section}`;
    if (content.includes(marker)) {
      const idx = content.indexOf(marker) + marker.length;
      const next = content.indexOf('\n## ', idx);
      const insertAt = next === -1 ? content.length : next;
      content = content.slice(0, insertAt) + '\n' + newRow + content.slice(insertAt);
    } else {
      content += `\n\n${marker}\n\n| Tiếng Trung | Tiếng Việt | Ghi chú |\n|---|---|---|\n${newRow}\n`;
    }
    await api.put(`/api/novels/${state.currentNovel}/raw`, { content });
    state.novelProfile = await api.get(`/api/novels/${state.currentNovel}`);
    $('termZh').value = '';
    $('termVi').value = '';
    $('termNotes').value = '';
    renderGlossary();
    toast('Đã thêm thuật ngữ', 'success');
  } catch (err) {
    toast(`Lỗi thêm thuật ngữ: ${err.message}`, 'error');
  }
});

$('btnExtractTerms').addEventListener('click', async () => {
  if (!state.currentNovel) { toast('Chọn truyện trước!', 'error'); return; }
  try {
    const { job_id } = await api.post('/api/translate/extract', { novel_slug: state.currentNovel });
    log('Bắt đầu trích xuất thuật ngữ...', 'log-info');
    setJobRunning(true);
    document.querySelector('[data-tab="chapters"]').click();
    listenToJob(job_id);
  } catch (err) {
    toast(`Lỗi trích xuất: ${err.message}`, 'error');
  }
});

// ── Output Editor ─────────────────────────────────────────────────────────────
let _currentOutputFile = null;
let _outputSaveTimer = null;

function renderOutputSidebar() {
  const done = state.chapters.filter(c => c.status === 'done');
  const sidebar = $('outputSidebar');
  sidebar.innerHTML = '';
  $('outputSidebarCount').textContent = done.length ? `${done.length}` : '';

  done.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'output-sidebar-item w-full text-left px-3 py-2 hover:bg-gray-800 transition truncate';
    if (c.filename === _currentOutputFile) btn.classList.add('active');
    btn.dataset.file = c.filename;

    const num = document.createElement('span');
    num.className = 'text-gray-500 font-mono text-xs mr-2';
    num.textContent = String(c.chapter_num).padStart(4, '0');

    const title = document.createElement('span');
    title.className = 'text-gray-200';
    title.textContent = c.vi_title || c.zh_title || c.filename;

    btn.append(num, title);
    btn.addEventListener('click', () => loadOutputChapter(c.filename));
    sidebar.appendChild(btn);
  });
}

async function loadOutputChapter(filename) {
  try {
    const data = await api.get(`/api/chapters/${encodeURIComponent(filename)}/output`);
    _currentOutputFile = filename;

    // Normalize line endings (Windows \r\n → \n)
    const content = data.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const editor = $('outputEditor');
    editor.value = content;

    $('outputPlaceholder').style.display = 'none';
    $('outputTitle').textContent = data.vi_title || filename;
    $('outputToolbar').classList.remove('hidden');
    $('outputToolbar').style.display = 'flex';
    $('outputSaveStatus').classList.add('hidden');

    // Highlight sidebar
    document.querySelectorAll('.output-sidebar-item').forEach(b => {
      b.classList.toggle('active', b.dataset.file === filename);
    });

    editor.focus();
  } catch (err) {
    toast(`Không tải được bản dịch: ${err.message}`, 'error');
  }
}

function _outputNavStep(delta) {
  const done = state.chapters.filter(c => c.status === 'done');
  if (!done.length) return;
  const idx = done.findIndex(c => c.filename === _currentOutputFile);
  const next = done[idx + delta];
  if (next) loadOutputChapter(next.filename);
}

function _on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
}

_on('btnPrevChapter', 'click', () => _outputNavStep(-1));
_on('btnNextChapter', 'click', () => _outputNavStep(1));

_on('btnCopyOutput', 'click', async () => {
  const text = $('outputEditor').value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Đã sao chép vào clipboard', 'success');
  } catch {
    toast('Trình duyệt chặn clipboard — hãy chọn tất cả và sao chép tay', 'error');
  }
});

_on('btnDownloadOutput', 'click', () => {
  const text = $('outputEditor').value;
  if (!text || !_currentOutputFile) return;
  const title = $('outputTitle').textContent || _currentOutputFile;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
});

_on('btnSaveEdit', 'click', async () => {
  if (!_currentOutputFile) return;
  try {
    await api.put(`/api/chapters/${encodeURIComponent(_currentOutputFile)}/output`,
      { content: $('outputEditor').value });
    const status = $('outputSaveStatus');
    status.classList.remove('hidden');
    clearTimeout(_outputSaveTimer);
    _outputSaveTimer = setTimeout(() => status.classList.add('hidden'), 2500);
    toast('Đã lưu bản dịch', 'success');
  } catch (err) {
    toast(`Lỗi lưu: ${err.message}`, 'error');
  }
});

// Xem nhanh từ bảng chương → chuyển sang tab output
async function viewOutput(filename) {
  document.querySelector('[data-tab="output"]').click();
  await loadOutputChapter(filename);
}

// Xem file gốc tiếng Trung
async function viewSource(filename) {
  try {
    const data = await api.get(`/api/chapters/${encodeURIComponent(filename)}/source`);
    $('modalSourceTitle').textContent = filename;
    $('modalSourceContent').textContent = data.content;
    $('modalSource').classList.remove('hidden');
  } catch (err) {
    toast(`Không tải được file gốc: ${err.message}`, 'error');
  }
}

function viewReview(ch) {
  $('modalReviewTitle').textContent = ch.filename;
  $('modalReviewStatus').innerHTML = reviewBadge(ch.review_status);
  $('modalReviewContent').textContent = ch.review_issues || '(Không có ghi chú)';
  $('modalReview').classList.remove('hidden');
}

$('btnCloseReview').addEventListener('click', () => $('modalReview').classList.add('hidden'));
$('modalReview').addEventListener('click', (e) => {
  if (e.target === $('modalReview')) $('modalReview').classList.add('hidden');
});

$('btnCloseSource').addEventListener('click', () => $('modalSource').classList.add('hidden'));
$('modalSource').addEventListener('click', (e) => {
  if (e.target === $('modalSource')) $('modalSource').classList.add('hidden');
});

// ── Settings (novel.md editor) ────────────────────────────────────────────────
async function loadNovelEditor() {
  if (!state.currentNovel) {
    $('novelEditor').value = '';
    $('novelEditor').placeholder = 'Chọn truyện để chỉnh sửa novel.md...';
    return;
  }
  try {
    const raw = await api.get(`/api/novels/${state.currentNovel}/raw`);
    $('novelEditor').value = raw.content;
  } catch (err) {
    toast(`Lỗi tải novel.md: ${err.message}`, 'error');
  }
}

$('btnSaveNovel').addEventListener('click', async () => {
  if (!state.currentNovel) { toast('Chọn truyện trước!', 'error'); return; }
  try {
    const content = $('novelEditor').value;
    await api.put(`/api/novels/${state.currentNovel}/raw`, { content });
    state.novelProfile = await api.get(`/api/novels/${state.currentNovel}`);
    toast('Đã lưu novel.md', 'success');
  } catch (err) {
    toast(`Lỗi lưu: ${err.message}`, 'error');
  }
});

// ── New Novel Modal ───────────────────────────────────────────────────────────
$('btnNewNovel').addEventListener('click', () => $('modalNewNovel').classList.remove('hidden'));
$('btnCancelNovel').addEventListener('click', () => $('modalNewNovel').classList.add('hidden'));

$('btnCreateNovel').addEventListener('click', async () => {
  const body = {
    slug:    $('newSlug').value.trim(),
    zh_name: $('newZhName').value.trim(),
    vi_name: $('newViName').value.trim(),
    genre:   $('newGenre').value,
  };
  if (!body.slug || !body.vi_name) { toast('Nhập slug và tên Việt', 'error'); return; }
  try {
    await api.post('/api/novels', body);
    $('modalNewNovel').classList.add('hidden');
    await loadNovels();
    $('novelSelect').value = body.slug;
    $('novelSelect').dispatchEvent(new Event('change'));
    toast(`Đã tạo truyện: ${body.vi_name}`, 'success');
  } catch (err) {
    toast(`Lỗi tạo truyện: ${err.message}`, 'error');
  }
});

// ── Translation View ──────────────────────────────────────────────────────────
async function openTranslationView(filename) {
  if (!state.currentNovel) { toast('Chọn truyện trước!', 'error'); return; }
  const chapter = state.chapters.find(c => c.filename === filename) || { filename };
  state.translationView = { filename, chapter };

  $('translationView').classList.remove('hidden');
  document.querySelector('main').classList.add('hidden');
  document.querySelector('nav').classList.add('hidden');

  $('tvChapterNum').textContent = String(chapter.chapter_num || '').padStart(4, '0');
  $('tvChapterTitle').textContent = chapter.zh_title || filename;
  $('tvStatusBadge').innerHTML = statusBadge(chapter.status || 'pending');
  $('tvTranslation').textContent = '';
  $('tvPreTranslate').innerHTML = '';
  $('tvTranslateStatus').textContent = '';
  $('tvTermCount').classList.add('hidden');

  try {
    const data = await api.get(
      `/api/chapters/${encodeURIComponent(filename)}/pretranslate?novel_slug=${state.currentNovel}`
    );
    renderPreTranslate(data.segments);
    if (data.substitution_count > 0) {
      $('tvTermCount').textContent = `${data.substitution_count} tên đã thay`;
      $('tvTermCount').classList.remove('hidden');
    }
  } catch (err) {
    $('tvPreTranslate').textContent = `Lỗi tải pre-translate: ${err.message}`;
  }

  if (chapter.status === 'done') {
    try {
      const out = await api.get(`/api/chapters/${encodeURIComponent(filename)}/output`);
      $('tvTranslation').textContent = out.content;
      $('tvTranslateStatus').textContent = '✓ Đã dịch xong';
    } catch { /* ignore */ }
  }

  // Load OCR filmstrip if chapter has ocr_job_id
  $('tvImageStrip').classList.add('hidden');
  $('tvImageList').innerHTML = '';
  const jobId = chapter?.ocr_job_id;
  if (jobId) {
    try {
      const { images } = await api.get(`/api/ocr/${state.currentNovel}/${jobId}/images`);
      if (images.length > 0) renderImageFilmstrip(state.currentNovel, jobId, images);
    } catch { /* ignore */ }
  }
}

function renderImageFilmstrip(novelSlug, jobId, filenames) {
  const strip = $('tvImageList');
  strip.innerHTML = '';
  $('tvImageCount').textContent = `${filenames.length} ảnh`;
  filenames.forEach((name, i) => {
    const url = `/api/ocr/${novelSlug}/${jobId}/images/${name}`;
    const thumb = document.createElement('img');
    thumb.className = 'ocr-thumb';
    thumb.src = url;
    thumb.alt = `Ảnh ${i + 1}`;
    thumb.title = `Ảnh ${i + 1}/${filenames.length} — click để xem`;
    thumb.addEventListener('click', () => openImageLightbox(url, i + 1, filenames.length));
    strip.appendChild(thumb);
  });
  $('tvImageStrip').classList.remove('hidden');
}

function openImageLightbox(url, index, total) {
  const modal = $('modalSource');
  $('modalSourceTitle').textContent = `Ảnh OCR ${index}/${total}`;
  const contentEl = $('modalSourceContent');
  // Replace <pre> content with image
  contentEl.innerHTML = '';
  const img = document.createElement('img');
  img.src = url;
  img.style.cssText = 'max-width:100%;height:auto;display:block;margin:0 auto';
  contentEl.appendChild(img);
  modal.classList.remove('hidden');
}

function closeTranslationView() {
  state.translationView = null;
  $('translationView').classList.add('hidden');
  document.querySelector('main').classList.remove('hidden');
  document.querySelector('nav').classList.remove('hidden');
}

function renderPreTranslate(segments) {
  const el = $('tvPreTranslate');
  el.innerHTML = '';
  for (const seg of segments) {
    if (seg.type === 'text') {
      el.appendChild(document.createTextNode(seg.content));
    } else {
      const span = document.createElement('span');
      span.className = 'term-highlight';
      span.textContent = seg.vi;
      span.title = `${seg.zh} → ${seg.vi}`;
      el.appendChild(span);
    }
  }
}

// ── Upload .txt ───────────────────────────────────────────────────────────────
async function handleFileUpload(files) {
  if (!files.length) return;
  if (!state.currentNovel) { toast('Chọn truyện trước khi upload', 'error'); return; }

  const txtFiles = [...files].filter(f => f.name.endsWith('.txt'));
  if (!txtFiles.length) { toast('Chỉ chấp nhận file .txt', 'error'); return; }

  const formData = new FormData();
  formData.append('novel_slug', state.currentNovel);
  txtFiles.forEach(f => formData.append('files', f));

  try {
    const r = await fetch('/api/chapters/upload', { method: 'POST', body: formData });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const { saved, errors } = await r.json();

    if (saved.length) {
      toast(`Đã upload ${saved.length} file`, 'success');
      await loadChapters();
    }
    errors.forEach(e => toast(e, 'error'));
  } catch (err) {
    toast(`Upload thất bại: ${err.message}`, 'error');
  }
}

// Button mở file picker
$('btnUpload').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  handleFileUpload(e.target.files);
  e.target.value = ''; // reset để upload lại cùng file nếu cần
});

// Drag & drop lên bảng chương
const dropZone = $('chapterDropZone');
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', (e) => {
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFileUpload(e.dataTransfer.files);
});

$('btnBackToList').addEventListener('click', closeTranslationView);
$('btnTranslateThis').addEventListener('click', () => {
  if (!state.translationView) return;
  $('tvTranslation').textContent = '';
  $('tvTranslateStatus').textContent = '⚡ Đang dịch...';
  startTranslation([state.translationView.filename]);
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadNovels();
