// output.jsx — màn ĐỌC bản dịch: cột đọc tập trung, mục lục, trước/sau, bảng "Aa",
// nhớ chương + đoạn đang đọc theo từng truyện (localStorage, mọi truy cập bọc try/catch).

const {
  useState: useStateO, useEffect: useEffectO, useRef: useRefO,
  useMemo: useMemoO, useLayoutEffect: useLayoutEffectO, useCallback: useCallbackO,
} = React;

// ── localStorage ───────────────────────────────────────────────────────────────
const RD_PREFS_KEY = "vp:reader:prefs:v1";
const RD_PROGRESS_PREFIX = "vp:reader:progress:v1:";
const RD_LH_OPTIONS = [1.5, 1.7, 1.9, 2.1];
const RD_BG_OPTIONS = [
  { v: "auto", label: "Theo giao diện" },
  { v: "light", label: "Sáng" },
  { v: "sepia", label: "Sepia" },
  { v: "dark", label: "Tối" },
];
const RD_SIZE_MIN = 14;
const RD_SIZE_MAX = 28;
const RD_PREFS_DEFAULT = { size: 18, lh: 1.9, bg: "auto" };

function rdLoad(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch { return null; }
}

function rdSave(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* bộ nhớ bị chặn/đầy — bỏ qua */ }
}

// Chỉ nhận số thật (typeof number). Không gọi Number(): JSON hợp lệ như
// {"valueOf":null,"toString":null} làm Number() ném TypeError, còn [18] hay "18" bị ép thành số.
function rdNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

// Giá trị hỏng / ngoài khoảng → dùng mặc định từng trường.
function rdSanitizePrefs(p) {
  const out = { ...RD_PREFS_DEFAULT };
  if (!p || typeof p !== "object" || Array.isArray(p)) return out;
  const size = rdNum(p.size);
  if (size >= RD_SIZE_MIN && size <= RD_SIZE_MAX) out.size = Math.round(size);
  const lh = rdNum(p.lh);
  if (RD_LH_OPTIONS.includes(lh)) out.lh = lh;
  if (typeof p.bg === "string" && RD_BG_OPTIONS.some(o => o.v === p.bg)) out.bg = p.bg;
  return out;
}

// Tiến độ: { num, filename, para (đoạn đầu đang thấy), pin (tỉ lệ đã cuộn trong đoạn đó), frac }.
// Số chương hỏng → bỏ cả tiến độ; trường vị trí hỏng → 0.
function rdLoadProgress(slug) {
  if (!slug) return null;
  const p = rdLoad(RD_PROGRESS_PREFIX + slug);
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const num = rdNum(p.num);
  if (!Number.isFinite(num)) return null;
  const para = rdNum(p.para);
  const frac = rdNum(p.frac);
  const pin = rdNum(p.pin);
  return {
    num,
    filename: typeof p.filename === "string" ? p.filename : null,
    para: Number.isInteger(para) && para >= 0 ? para : 0,
    frac: frac >= 0 && frac <= 1 ? frac : 0,
    pin: pin >= 0 && pin <= 1 ? pin : 0,
  };
}

// scrollTop cần đặt khi khôi phục. Tìm thấy đoạn → đầu đoạn + phần đã cuộn trong đoạn
// (đoạn dài nhiều màn hình không bị kéo về đầu đoạn); không thấy → tỉ lệ cuộn cả chương.
function rdRestoreTop({ paraTop, paraHeight, pin, frac, max, offset }) {
  let top;
  if (typeof paraTop === "number") top = paraTop + (pin || 0) * (paraHeight || 0) - offset;
  else top = (frac || 0) * max;
  return Math.round(Math.min(Math.max(0, max), Math.max(0, top)));
}

// Nội dung, lỗi và quyền xuất gắn với đúng một lượt tải: mỗi lần chọn chương (kể cả quay
// lại đúng file cũ: A → B → A) hay bấm thử lại đều tăng nonce, nên kết quả cũ không khớp.
function rdLoadKey(filename, nonce) {
  return filename ? `${filename}\n${nonce}` : null;
}

function rdViewState(filename, key, res) {
  if (!filename) return { phase: "idle", content: "", error: null, canExport: false };
  if (!res || res.key !== key) return { phase: "loading", content: "", error: null, canExport: false };
  if (res.error) return { phase: "error", content: "", error: res.error, canExport: false };
  const content = typeof res.content === "string" ? res.content : "";
  if (!content.trim()) return { phase: "empty", content: "", error: null, canExport: false };
  return { phase: "ready", content, error: null, canExport: true };
}

// ── Tiện ích ───────────────────────────────────────────────────────────────────
const RD_TOP_OFFSET = 72;   // chừa chỗ cho thanh trên khi đo/khôi phục vị trí

// Vị trí đầu phần tử trong vùng cuộn (không phụ thuộc offsetParent).
function rdParaTop(box, el) {
  return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
}

function rdIsTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el.isContentEditable;
}

function rdTitle(ch) {
  if (!ch) return "";
  return ch.vi_title?.replace(/^Chương \d+\s*[—–-]\s*/, "") || ch.zh_title || "";
}

// Chương done gần nhất: lớn nhất ≤ num, không có thì nhỏ nhất.
function rdNearest(done, num) {
  if (!done.length) return null;
  let best = null;
  for (const c of done) if (c.chapter_num <= num) best = c;
  return best || done[0];
}

function rdHasIcon(name) {
  try { return typeof ICONS !== "undefined" && !!ICONS[name]; } catch { return false; }
}

function useRdMobile() {
  const q = "(max-width: 768px)";
  const get = () => { try { return window.matchMedia(q).matches; } catch { return false; } };
  const [m, setM] = useStateO(get);
  useEffectO(() => {
    let mq;
    try { mq = window.matchMedia(q); } catch { return; }
    const h = () => setM(mq.matches);
    mq.addEventListener ? mq.addEventListener("change", h) : mq.addListener(h);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", h) : mq.removeListener(h); };
  }, []);
  return m;
}

// StatusBlock dùng chung (components.jsx); thiếu thì dùng bản tối giản để không vỡ màn.
function RdStatus(props) {
  const SB = window.StatusBlock;
  if (typeof SB === "function") return <SB {...props} />;
  const { kind, title, desc, actions } = props;
  return (
    <div className="status-block rd-status-fallback" role={kind === "error" ? "alert" : "status"} data-kind={kind}>
      {kind === "loading" && <span className="spin" aria-hidden="true">⟳</span>}
      {title && <div className="rd-status-title">{title}</div>}
      {desc && <div className="rd-status-desc">{desc}</div>}
      {actions && <div className="rd-status-actions">{actions}</div>}
    </div>
  );
}

// ── Màn đọc ────────────────────────────────────────────────────────────────────
function OutputScreen({
  chapters = [], chaptersStatus = "ready", onReloadChapters, novel, routeChapter = null,
  onReadChapter, onOpen, onGoChapters, onOpenRail, suspendKeys = false, fontMode = "serif", onFontMode,
  savedOutput = null,
}) {
  const slug = novel?.slug || null;
  const isMobile = useRdMobile();

  const done = useMemoO(
    () => chapters.filter(c => c.status === "done").slice().sort((a, b) => a.chapter_num - b.chapter_num),
    [chapters],
  );

  // Chương đang đọc (giữ bản chụp để vẫn hiện khi chương rời khỏi danh sách done).
  const [cur, setCur] = useStateO(null);
  const [missing, setMissing] = useStateO(null);   // { num } khi routeChapter không đọc được
  const [loadRes, setLoadRes] = useStateO(null);   // { key, content, error: { msg, offline } | null }
  const [loadSeq, setLoadSeq] = useStateO(0);      // tăng mỗi lượt chọn chương / thử lại
  const [copied, setCopied] = useStateO("");

  const [prefs, setPrefs] = useStateO(() => rdSanitizePrefs(rdLoad(RD_PREFS_KEY)));
  const [tocOpen, setTocOpen] = useStateO(() => {
    try { return !window.matchMedia("(max-width: 768px)").matches; } catch { return true; }
  });
  const [aaOpen, setAaOpen] = useStateO(false);
  const [barsHidden, setBarsHidden] = useStateO(false);

  const scrollRef = useRefO(null);
  const restoreRef = useRefO(null);     // { filename, para, pin, frac } chờ khôi phục sau khi render
  const initRef = useRefO(false);
  const saveTimer = useRefO(null);
  const saveFnRef = useRefO(null);      // hàm lưu vị trí của chương đang hiện (chờ chạy)
  const lastTopRef = useRefO(0);
  const tocBtnRef = useRefO(null);
  const tocCloseRef = useRefO(null);
  const aaBtnRef = useRefO(null);
  const aaPanelRef = useRefO(null);
  const tocListRef = useRefO(null);
  const tocAsideRef = useRefO(null);
  // Tăng khi áp bản dịch vừa lưu: GET đang chạy từ trước đó (thành công hay lỗi) bị bỏ.
  const contentRevRef = useRefO(0);

  const filename = cur?.filename || null;
  const loadKey = rdLoadKey(filename, loadSeq);
  // Suy ra ngay trong render: đổi chương / thử lại thì lần render đầu đã là "loading",
  // không ghép tiêu đề chương mới với nội dung hay lỗi của lần tải trước.
  const view = rdViewState(filename, loadKey, loadRes);
  const content = view.content;
  const error = view.error;
  const curNum = cur?.chapter_num;
  const curStillDone = !!cur && done.some(c => c.filename === cur.filename);
  const prevCh = cur ? [...done].reverse().find(c => c.chapter_num < curNum) || null : null;
  const nextCh = cur ? done.find(c => c.chapter_num > curNum) || null : null;

  // Lưu ngay vị trí đang chờ (debounce) của chương đang hiện, khi DOM còn đó.
  const flushSave = useCallbackO(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const fn = saveFnRef.current;
    if (fn && fn.pending) { fn.pending = false; fn(); }
  }, []);

  // ── Chuyển chương ────────────────────────────────────────────────────────────
  const go = useCallbackO((ch, { restore = null, notify = true } = {}) => {
    if (!ch) return;
    flushSave();   // chốt tiến độ chương đang rời đi trước khi ghi tiến độ chương mới
    saveFnRef.current = null;   // closure của chương cũ không được ghi nữa (kể cả lúc dọn dẹp)
    restoreRef.current = restore ? { filename: ch.filename, ...restore } : null;
    setMissing(null);
    setCur(ch);
    setLoadSeq(n => n + 1);   // lượt tải mới: kết quả/lỗi của lượt trước (kể cả cùng file) bị bỏ
    setBarsHidden(false);
    lastTopRef.current = 0;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (!restore && slug) {
      rdSave(RD_PROGRESS_PREFIX + slug, { num: ch.chapter_num, filename: ch.filename, para: 0, frac: 0, at: Date.now() });
    }
    if (notify && onReadChapter) onReadChapter(ch.chapter_num);
  }, [slug, onReadChapter, flushSave]);

  // Chọn theo routeChapter → tiến độ đã nhớ → chương done đầu tiên.
  const resolve = useCallbackO((route) => {
    if (route != null && route !== "") {
      const n = Number(route);
      const hit = Number.isFinite(n) ? done.find(c => c.chapter_num === n) : null;
      const prog = rdLoadProgress(slug);
      if (!hit) {
        // URL do chính trình đọc ghi (trùng tiến độ đã nhớ) mà chương đó không còn bản dịch,
        // vd tải lại tab sau khi chương bị đưa đi dịch lại → khôi phục phiên: mở chương gần nhất.
        // Link sâu người dùng tự mở tới chương chưa dịch → báo thiếu bản dịch.
        if (prog && done.length && Number.isFinite(n) && prog.num === n) { go(rdNearest(done, n)); return; }
        setCur(null); setMissing({ num: route }); return;
      }
      go(hit, { restore: prog && prog.num === hit.chapter_num ? { para: prog.para, pin: prog.pin, frac: prog.frac } : null, notify: false });
      return;
    }
    if (!done.length) return;
    const prog = rdLoadProgress(slug);
    if (prog) {
      const same = done.find(c => c.chapter_num === prog.num);
      if (same) { go(same, { restore: { para: prog.para, pin: prog.pin, frac: prog.frac } }); return; }
      go(rdNearest(done, prog.num));   // chương đã nhớ không còn bản dịch → chương gần nhất
      return;
    }
    go(done[0]);
  }, [done, slug, go]);

  // Route đã xử lý gần nhất. Route đổi lúc danh sách đang tải/lỗi thì giữ lại, xử lý khi "ready".
  const handledRouteRef = useRefO(undefined);

  // Không có chương nào để hiện (chưa có bản dịch lúc xử lý route, vd bỏ số chương khỏi URL
  // của truyện chưa dịch chương nào) mà giờ đã có chương dịch xong → chọn lại theo route/tiến độ.
  useEffectO(() => {
    if (!initRef.current || chaptersStatus !== "ready") return;
    if (cur || missing || !done.length) return;
    if (handledRouteRef.current !== routeChapter) return;   // route mới: để effect route xử lý
    resolve(routeChapter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, chaptersStatus, cur, missing]);

  // Lần đầu danh sách chương sẵn sàng.
  useEffectO(() => {
    if (initRef.current || chaptersStatus !== "ready") return;
    if (!done.length && !routeChapter) return;   // empty state; chờ có chương
    initRef.current = true;
    handledRouteRef.current = routeChapter;
    resolve(routeChapter);
  }, [chaptersStatus, done, routeChapter, resolve]);

  // URL đổi từ bên ngoài (gõ hash, Back) → theo URL, khi danh sách chương sẵn sàng.
  useEffectO(() => {
    if (!initRef.current || chaptersStatus !== "ready") return;
    if (handledRouteRef.current === routeChapter) return;
    handledRouteRef.current = routeChapter;
    if (routeChapter == null || routeChapter === "") {
      // Bỏ số chương khỏi URL: đang hiện chương thì giữ; đang báo "chưa có bản dịch" → tiến độ.
      if (!missing) return;
      setMissing(null);
      resolve(null);
      return;
    }
    if (cur && !missing && String(cur.chapter_num) === String(routeChapter)) return;
    if (missing && String(missing.num) === String(routeChapter)) return;
    resolve(routeChapter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeChapter, chaptersStatus]);

  // Đang ở StatusBlock "chưa có bản dịch" mà chương đó vừa dịch xong → mở luôn.
  useEffectO(() => {
    if (!missing) return;
    const n = Number(missing.num);
    const hit = done.find(c => c.chapter_num === n);
    if (hit) go(hit, { notify: false });
  }, [done, missing, go]);

  // Cập nhật bản chụp chương (tiêu đề, reviewed) khi danh sách đổi, không tải lại nội dung.
  useEffectO(() => {
    if (!cur) return;
    const fresh = chapters.find(c => c.filename === cur.filename);
    if (fresh && fresh !== cur && (fresh.vi_title !== cur.vi_title || fresh.reviewed !== cur.reviewed || fresh.status !== cur.status)) {
      setCur(fresh);
    }
  }, [chapters, cur]);

  // ── Tải nội dung: chỉ phụ thuộc filename + retry ─────────────────────────────
  useEffectO(() => {
    if (!filename) return;
    let alive = true;   // đổi chương nhanh → bỏ response cũ
    const key = loadKey;
    const rev = contentRevRef.current;
    const stale = () => !alive || contentRevRef.current !== rev;
    fetch(`/api/chapters/${encodeURIComponent(filename)}/output`)
      .then(async r => {
        if (!r.ok) {
          let detail = r.statusText;
          try { detail = (await r.json()).detail || detail; } catch { /* ignore */ }
          throw new Error(detail || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then(d => {
        if (stale()) return;
        const text = typeof d?.content === "string" ? d.content : "";
        setLoadRes({ key, content: text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), error: null });
      })
      .catch(err => {
        if (stale()) return;
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        setLoadRes({ key, content: "", error: { msg: err?.message || "Lỗi không rõ", offline } });
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename, loadSeq]);

  // Bản dịch chương đang đọc vừa được lưu (overlay đối chiếu) → thay nội dung ngay, giữ vị trí cuộn.
  // Sao chép / tải .txt đọc từ `content` nên cũng lấy bản mới.
  useEffectO(() => {
    if (!savedOutput || !filename || savedOutput.filename !== filename) return;
    const text = String(savedOutput.content || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    contentRevRef.current++;
    // Nội dung đổi → giữ nguyên vị trí cuộn hiện tại (không nhảy về đầu chương).
    const box = scrollRef.current;
    if (box && text !== content) restoreRef.current = { filename, keepTop: box.scrollTop };
    setLoadRes({ key: loadKey, content: text, error: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedOutput]);

  // Có mạng lại → tự thử lại.
  useEffectO(() => {
    if (!error) return;
    const h = () => setLoadSeq(n => n + 1);
    window.addEventListener("online", h);
    return () => window.removeEventListener("online", h);
  }, [error]);

  const paras = useMemoO(() => content.split("\n").map(s => s.trim()).filter(Boolean), [content]);
  const readMin = useMemoO(() => {
    const syl = content.split(/\s+/).filter(Boolean).length;
    return syl ? Math.max(1, Math.round(syl / 250)) : 0;
  }, [content]);

  // ── Khôi phục vị trí sau khi nội dung render ─────────────────────────────────
  useLayoutEffectO(() => {
    const box = scrollRef.current;
    if (!box || !paras.length) return;
    const r = restoreRef.current;
    restoreRef.current = null;
    if (!r || r.filename !== filename) { box.scrollTop = 0; return; }
    if (r.keepTop != null) {
      box.scrollTop = Math.min(r.keepTop, Math.max(0, box.scrollHeight - box.clientHeight));
      lastTopRef.current = box.scrollTop;
      return;
    }
    const el = box.querySelector(`[data-para="${r.para}"]`);
    box.scrollTop = rdRestoreTop({
      paraTop: el ? rdParaTop(box, el) : null,
      paraHeight: el ? el.offsetHeight : 0,
      pin: r.pin, frac: r.frac,
      max: box.scrollHeight - box.clientHeight,
      offset: RD_TOP_OFFSET,
    });
    lastTopRef.current = box.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paras]);

  // ── Lưu vị trí khi cuộn (~400ms) + ẩn/hiện thanh trên mobile ─────────────────
  // useLayoutEffect: phần dọn dẹp chạy trước khi DOM bị gỡ (đổi truyện/tab), nên
  // lần lưu đang chờ vẫn đo được vị trí thật thay vì bị huỷ.
  useLayoutEffectO(() => {
    const box = scrollRef.current;
    if (!box) return;
    const save = () => {
      saveTimer.current = null;
      if (!slug || !cur || !paras.length || !box.isConnected) return;
      // Chỉ đo khi DOM đang hiện đúng chương này (dọn dẹp sau khi DOM đã đổi thì bỏ qua).
      const page = box.querySelector(".rd-page");
      if (!page || page.dataset.file !== cur.filename) return;
      const top = box.scrollTop;
      const boxTop = box.getBoundingClientRect().top;
      let para = 0, pin = 0;
      const nodes = box.querySelectorAll("[data-para]");
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        const elTop = r.top - boxTop + top;
        if (elTop + r.height > top + RD_TOP_OFFSET) {
          para = Number(el.dataset.para) || 0;
          pin = r.height > 0 ? Math.min(1, Math.max(0, (top + RD_TOP_OFFSET - elTop) / r.height)) : 0;
          break;
        }
      }
      const max = box.scrollHeight - box.clientHeight;
      const frac = max > 0 ? Math.min(1, Math.max(0, top / max)) : 0;
      rdSave(RD_PROGRESS_PREFIX + slug, { num: cur.chapter_num, filename: cur.filename, para, pin, frac, at: Date.now() });
    };
    save.pending = false;
    saveFnRef.current = save;
    const onScroll = () => {
      const top = box.scrollTop;
      const dy = top - lastTopRef.current;
      if (Math.abs(dy) > 8) {
        setBarsHidden(dy > 0 && top > 80);
        lastTopRef.current = top;
      }
      save.pending = true;
      if (!saveTimer.current) saveTimer.current = setTimeout(() => { save.pending = false; save(); }, 400);
    };
    // Đóng tab / chuyển app trên điện thoại trong vòng 400ms sau lần cuộn cuối.
    const onHide = () => { if (document.visibilityState !== "visible") flushSave(); };
    box.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", flushSave);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      box.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", flushSave);
      document.removeEventListener("visibilitychange", onHide);
      // Chuyển chương qua go() đã chốt (và xoá hàng chờ) trước khi ghi chương mới, nên
      // ở đây chỉ còn lần lưu của chính chương này: rời màn, đổi truyện, cập nhật danh sách.
      flushSave();
      if (saveFnRef.current === save) saveFnRef.current = null;
    };
  }, [slug, cur, paras, flushSave]);

  // ── Bàn phím: ←/→ chuyển chương, Esc đóng bảng Aa / mục lục ─────────────────
  useEffectO(() => {
    const h = (e) => {
      if (suspendKeys || e.defaultPrevented) return;
      if (e.key === "Escape") {
        if (aaOpen) { setAaOpen(false); aaBtnRef.current?.focus(); return; }
        // Mobile: drawer đang mở. Desktop: đang thao tác trong cột mục lục (focus nằm trong đó).
        const inToc = tocAsideRef.current?.contains(document.activeElement);
        if (tocOpen && (isMobile || inToc)) { e.preventDefault(); setTocOpen(false); tocBtnRef.current?.focus(); }
        return;
      }
      // Drawer mobile là dialog modal: Tab / Shift+Tab chỉ đi vòng trong drawer.
      if (e.key === "Tab" && isMobile && tocOpen && tocAsideRef.current) {
        const items = [...tocAsideRef.current.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        const inside = tocAsideRef.current.contains(document.activeElement);
        if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (aaOpen || (isMobile && tocOpen)) return;
      if (rdIsTyping(e.target) || rdIsTyping(document.activeElement)) return;
      if (e.key === "ArrowLeft" && prevCh) { e.preventDefault(); go(prevCh); }
      else if (e.key === "ArrowRight" && nextCh) { e.preventDefault(); go(nextCh); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [suspendKeys, aaOpen, tocOpen, isMobile, prevCh, nextCh, go]);

  // Drawer mục lục mobile mở → focus nút đóng, cuộn tới chương đang đọc.
  useEffectO(() => {
    if (!tocOpen) return;
    if (isMobile) tocCloseRef.current?.focus();
    const active = tocListRef.current?.querySelector('[aria-current="true"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }, [tocOpen, isMobile]);

  // Qua lại desktop ↔ mobile: desktop mặc định mở cột mục lục, mobile đóng drawer.
  useEffectO(() => { setTocOpen(!isMobile); }, [isMobile]);

  // Bảng Aa: focus phần tử đầu, bấm ra ngoài thì đóng.
  useEffectO(() => {
    if (!aaOpen) return;
    aaPanelRef.current?.querySelector("button")?.focus();
    const h = (e) => {
      if (aaPanelRef.current?.contains(e.target) || aaBtnRef.current?.contains(e.target)) return;
      setAaOpen(false);
    };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [aaOpen]);

  const updatePrefs = (patch) => {
    setPrefs(p => {
      const next = rdSanitizePrefs({ ...p, ...patch });
      rdSave(RD_PREFS_KEY, next);
      return next;
    });
  };

  const canExport = view.canExport;

  const copyToClipboard = () => {
    if (!canExport) return;
    try {
      navigator.clipboard.writeText(content)
        .then(() => setCopied("Đã sao chép chương vào bộ nhớ tạm."))
        .catch(() => setCopied("Không sao chép được — trình duyệt chặn bộ nhớ tạm."));
    } catch { setCopied("Không sao chép được — trình duyệt chặn bộ nhớ tạm."); }
  };
  useEffectO(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(""), 2400);
    return () => clearTimeout(t);
  }, [copied]);

  const downloadTxt = () => {
    if (!canExport || !cur) return;
    const title = cur.vi_title || cur.filename;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  };

  const pickFromToc = (c) => {
    go(c);
    if (isMobile) {
      setTocOpen(false);
      // Mục vừa bấm sắp bị ẩn → đưa focus sang vùng đọc (đọc tiếp được bằng phím ngay).
      scrollRef.current?.focus({ preventScroll: true });
    }
  };

  const toggleToc = () => setTocOpen(o => !o);
  const closeToc = () => { setTocOpen(false); tocBtnRef.current?.focus(); };

  // Focus (Tab/Shift+Tab) đi vào thanh đang ẩn → hiện lại, không để focus nằm ngoài màn.
  const showBars = () => { if (barsHidden) setBarsHidden(false); };

  // Chạm vào vùng đọc khi thanh đang ẩn → hiện lại.
  const onBodyClick = (e) => {
    if (!barsHidden) return;
    if (e.target.closest && e.target.closest("button, a")) return;
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).length) return;
    setBarsHidden(false);
  };

  // ── Nội dung vùng đọc theo trạng thái ────────────────────────────────────────
  const btn = (label, onClick, kind = "secondary", icon = null) => (
    <button type="button" className={`btn ${kind}`} onClick={onClick}>
      {icon && <Icon name={icon} size={14} />} {label}
    </button>
  );

  let body;
  if (chaptersStatus === "loading" && !cur) {
    body = <RdStatus kind="loading" title="Đang tải danh sách chương…" />;
  } else if (chaptersStatus === "error" && !cur) {
    body = (
      <RdStatus kind="error" title="Không tải được danh sách chương"
        desc="Kiểm tra kết nối rồi thử lại."
        actions={onReloadChapters ? btn("Thử lại", onReloadChapters, "primary", "refresh") : null} />
    );
  } else if (missing) {
    const near = rdNearest(done, Number(missing.num) || 0);
    body = (
      <RdStatus kind="empty" title={`Chương ${missing.num} chưa có bản dịch`}
        desc={done.length ? "Chương này chưa dịch xong hoặc không tồn tại. Chọn chương khác để đọc tiếp." : "Truyện này chưa có chương nào được dịch."}
        actions={<>
          {done.length > 0 && btn("Mở mục lục", () => setTocOpen(true), "secondary", "list")}
          {near && btn(`Đọc chương ${near.chapter_num} gần nhất`, () => go(near), "primary", "bookOpen")}
          {!done.length && onGoChapters && btn("Về danh sách chương", onGoChapters, "primary", "list")}
        </>} />
    );
  } else if (!done.length && !cur) {
    body = (
      <RdStatus kind="empty" title="Chưa có chương nào được dịch"
        desc="Tải chương lên và chạy dịch ở danh sách chương, bản dịch sẽ hiện ở đây."
        actions={onGoChapters ? btn("Về danh sách chương", onGoChapters, "primary", "list") : null} />
    );
  } else if (!cur) {
    // Danh sách vừa "ready" nhưng effect chọn chương chưa chạy (render đầu tiên):
    // chưa có chương nào để hiện — không được rơi xuống nhánh dùng cur.chapter_num.
    body = <RdStatus kind="loading" title="Đang mở chương…" />;
  } else if (view.phase === "loading") {
    body = (
      <div className="rd-loading">
        <RdStatus kind="loading" title={`Đang tải chương ${cur?.chapter_num ?? ""}…`} />
        <div className="rd-skel" aria-hidden="true">
          <span className="skeleton" /><span className="skeleton" /><span className="skeleton" /><span className="skeleton short" />
        </div>
      </div>
    );
  } else if (view.phase === "empty") {
    body = (
      <RdStatus kind="empty" title={`Chương ${cur.chapter_num} chưa có nội dung`}
        desc="File bản dịch của chương này đang trống. Thử tải lại, hoặc mở đối chiếu để kiểm tra."
        actions={<>
          {btn("Tải lại", () => setLoadSeq(n => n + 1), "secondary", "refresh")}
          {nextCh && btn(`Đọc chương ${nextCh.chapter_num}`, () => go(nextCh), "primary", "next")}
        </>} />
    );
  } else if (error) {
    body = (
      <RdStatus kind="error"
        title={error.offline ? "Mất kết nối mạng" : `Không tải được chương ${cur?.chapter_num ?? ""}`}
        desc={error.offline ? "Bản dịch sẽ tự tải lại khi có mạng." : error.msg}
        actions={btn("Thử lại", () => setLoadSeq(n => n + 1), "primary", error.offline ? "wifiOff" : "refresh")} />
    );
  } else {
    body = (
      <article className="rd-page" lang="vi" data-file={cur.filename}>
        {!curStillDone && (
          <div className="rd-note" role="status">
            Chương này đang được dịch lại hoặc không còn bản dịch — đang hiện bản đã tải.
          </div>
        )}
        <div className="rd-meta">
          {[novel?.vi_name, novel?.genre].filter(Boolean).join(" · ")}
        </div>
        <h1 className="rd-h1">
          <span className="rd-h1-num">Chương {cur.chapter_num}</span>
          {rdTitle(cur)}
        </h1>
        {readMin > 0 && <div className="rd-time">~{readMin} phút đọc</div>}
        {paras.map((p, i) => <p key={i} data-para={i}>{p}</p>)}
        <nav className="rd-end" aria-label="Chương tiếp theo">
          {nextCh ? (
            <button type="button" className="btn primary rd-end-next" onClick={() => go(nextCh)}>
              <span className="rd-end-label">Chương sau ›</span>
              <span className="rd-end-title">Chương {nextCh.chapter_num}{rdTitle(nextCh) ? ` — ${rdTitle(nextCh)}` : ""}</span>
            </button>
          ) : (
            <div className="rd-end-none">
              Đã hết chương đã dịch.
              {onGoChapters && <button type="button" className="btn ghost sm" onClick={onGoChapters}>Về danh sách chương</button>}
            </div>
          )}
        </nav>
      </article>
    );
  }

  const navDisabled = (ch) => ({ disabled: !ch, "aria-disabled": !ch ? "true" : undefined });

  const titleText = cur ? `Chương ${cur.chapter_num}${rdTitle(cur) ? ` · ${rdTitle(cur)}` : ""}` : (novel?.vi_name || "Đọc");

  return (
    <div className="rd"
      data-bg={prefs.bg}
      data-font={fontMode === "sans" ? "sans" : "serif"}
      data-toc={tocOpen ? "open" : "closed"}
      data-bars={barsHidden ? "hidden" : "shown"}
      style={{ "--rd-size": `${prefs.size}px`, "--rd-lh": prefs.lh }}>

      {/* Mục lục: cột trái trên desktop, drawer trên mobile */}
      <div className="rd-toc-scrim" onClick={closeToc} aria-hidden="true" />
      <aside className="rd-toc" id="rd-toc" ref={tocAsideRef} aria-label="Mục lục chương"
        role={isMobile ? "dialog" : undefined} aria-modal={isMobile && tocOpen ? "true" : undefined}
        aria-hidden={!tocOpen ? "true" : undefined}>
        <div className="rd-toc-h">
          <span className="label">Mục lục ({done.length})</span>
          <div style={{ flex: 1 }} />
          <button type="button" ref={tocCloseRef} className="icon-btn" onClick={closeToc} aria-label="Đóng mục lục" title="Đóng mục lục">
            <Icon name="cross" size={16} />
          </button>
        </div>
        <ol className="rd-toc-list" ref={tocListRef}>
          {done.map(c => {
            const active = cur && c.filename === cur.filename;
            return (
              <li key={c.filename}>
                <button type="button" className="rd-toc-item" aria-current={active ? "true" : undefined}
                  onClick={() => pickFromToc(c)}>
                  <span className="rd-toc-num">
                    Chương {c.chapter_num}
                    {!c.reviewed && <span className="rd-toc-unrev">· chưa duyệt</span>}
                  </span>
                  <span className="rd-toc-title">{rdTitle(c) || c.filename}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </aside>

      <div className="rd-main">
        {/* Thanh trên */}
        <div className="rd-bar rd-top" role="toolbar" aria-label="Điều khiển đọc" onFocus={showBars}>
          {onOpenRail && (
            <button type="button" className="icon-btn rd-mobile-only" onClick={onOpenRail} aria-label="Danh sách truyện" title="Danh sách truyện">
              {rdHasIcon("menu") ? <Icon name="menu" size={18} /> : <span aria-hidden="true">☰</span>}
            </button>
          )}
          {onGoChapters && (
            <button type="button" className="icon-btn rd-mobile-only" onClick={onGoChapters} aria-label="Về danh sách chương" title="Về danh sách chương">
              <Icon name="prev" size={18} />
            </button>
          )}
          <button type="button" ref={tocBtnRef} className="icon-btn" onClick={toggleToc}
            aria-label={tocOpen ? "Ẩn mục lục" : "Mở mục lục"} aria-expanded={tocOpen} aria-controls="rd-toc"
            title="Mục lục">
            <Icon name="list" size={16} />
          </button>
          <button type="button" className="icon-btn rd-desktop-only" onClick={() => go(prevCh)} {...navDisabled(prevCh)}
            aria-label="Chương trước" title="Chương trước (←)">
            <Icon name="prev" size={16} />
          </button>
          <button type="button" className="icon-btn rd-desktop-only" onClick={() => go(nextCh)} {...navDisabled(nextCh)}
            aria-label="Chương sau" title="Chương sau (→)">
            <Icon name="next" size={16} />
          </button>
          <span className="rd-bar-title" title={titleText}>{titleText}</span>
          <button type="button" className="btn ghost sm rd-desktop-only" onClick={() => cur && onOpen && onOpen(cur)} disabled={!cur}>
            <Icon name="layers" size={13} /> Đối chiếu
          </button>
          <button type="button" className="btn ghost sm rd-desktop-only" onClick={copyToClipboard} disabled={!canExport}>
            <Icon name="copy" size={13} /> Sao chép
          </button>
          <button type="button" className="btn ghost sm rd-desktop-only" onClick={downloadTxt} disabled={!canExport}>
            <Icon name="download" size={13} /> .txt
          </button>
          <div className="rd-aa-wrap">
            <button type="button" ref={aaBtnRef} className="icon-btn rd-aa-btn" onClick={() => setAaOpen(o => !o)}
              aria-label="Tuỳ chỉnh hiển thị đọc" aria-expanded={aaOpen} aria-controls="rd-aa" title="Cỡ chữ, giãn dòng, nền">
              <span aria-hidden="true">Aa</span>
            </button>
            {aaOpen && (
              <div className="rd-aa" id="rd-aa" ref={aaPanelRef} role="dialog" aria-label="Tuỳ chỉnh hiển thị đọc">
                <div className="rd-aa-row">
                  <span className="rd-aa-label" id="rd-aa-size">Cỡ chữ</span>
                  <div className="rd-aa-stepper" role="group" aria-labelledby="rd-aa-size">
                    <button type="button" className="btn secondary sm" onClick={() => updatePrefs({ size: prefs.size - 1 })}
                      disabled={prefs.size <= RD_SIZE_MIN} aria-label="Giảm cỡ chữ">A−</button>
                    <output className="rd-aa-val" aria-live="polite">{prefs.size}px</output>
                    <button type="button" className="btn secondary sm" onClick={() => updatePrefs({ size: prefs.size + 1 })}
                      disabled={prefs.size >= RD_SIZE_MAX} aria-label="Tăng cỡ chữ">A+</button>
                  </div>
                </div>
                <div className="rd-aa-row">
                  <span className="rd-aa-label" id="rd-aa-lh">Giãn dòng</span>
                  <div className="seg rd-seg" role="radiogroup" aria-labelledby="rd-aa-lh">
                    {RD_LH_OPTIONS.map(v => (
                      <button type="button" key={v} role="radio" aria-checked={prefs.lh === v}
                        className={prefs.lh === v ? "active" : ""} onClick={() => updatePrefs({ lh: v })}>{v}</button>
                    ))}
                  </div>
                </div>
                <div className="rd-aa-row">
                  <span className="rd-aa-label" id="rd-aa-bg">Nền</span>
                  <div className="rd-swatches" role="radiogroup" aria-labelledby="rd-aa-bg">
                    {RD_BG_OPTIONS.map(o => (
                      <button type="button" key={o.v} role="radio" aria-checked={prefs.bg === o.v}
                        className={`rd-swatch ${prefs.bg === o.v ? "active" : ""}`} data-swatch={o.v}
                        onClick={() => updatePrefs({ bg: o.v })}>
                        <span className="rd-swatch-dot" aria-hidden="true" />{o.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="rd-aa-row">
                  <span className="rd-aa-label" id="rd-aa-font">Kiểu chữ</span>
                  <div className="seg rd-seg" role="radiogroup" aria-labelledby="rd-aa-font">
                    {[{ v: "serif", label: "Có chân" }, { v: "sans", label: "Không chân" }].map(o => (
                      <button type="button" key={o.v} role="radio" aria-checked={fontMode === o.v}
                        className={`${fontMode === o.v ? "active" : ""} rd-font-${o.v}`}
                        onClick={() => onFontMode && onFontMode(o.v)} disabled={!onFontMode}>{o.label}</button>
                    ))}
                  </div>
                </div>
                <div className="rd-aa-row rd-mobile-only rd-aa-tools">
                  <button type="button" className="btn ghost sm" onClick={() => { setAaOpen(false); cur && onOpen && onOpen(cur); }} disabled={!cur}>
                    <Icon name="layers" size={13} /> Đối chiếu
                  </button>
                  <button type="button" className="btn ghost sm" onClick={copyToClipboard} disabled={!canExport}>
                    <Icon name="copy" size={13} /> Sao chép
                  </button>
                  <button type="button" className="btn ghost sm" onClick={downloadTxt} disabled={!canExport}>
                    <Icon name="download" size={13} /> .txt
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="rd-scroll" ref={scrollRef} onClick={onBodyClick} tabIndex={-1}>
          {body}
        </div>

        {/* Thanh dưới (mobile) */}
        <nav className="rd-bar rd-bottom rd-mobile-only" aria-label="Điều hướng chương" onFocus={showBars}>
          <button type="button" className="rd-nav-btn" onClick={() => go(prevCh)} {...navDisabled(prevCh)}>
            <Icon name="prev" size={18} /> Trước
          </button>
          <button type="button" className="rd-nav-btn" onClick={toggleToc} aria-expanded={tocOpen} aria-controls="rd-toc">
            <Icon name="list" size={18} /> Mục lục
          </button>
          <button type="button" className="rd-nav-btn" onClick={() => go(nextCh)} {...navDisabled(nextCh)}>
            Sau <Icon name="next" size={18} />
          </button>
        </nav>

        <div className="sr-only" aria-live="polite">{copied}</div>
        {copied && <div className="rd-flash" aria-hidden="true">{copied}</div>}
      </div>
    </div>
  );
}

Object.assign(window, { OutputScreen });
