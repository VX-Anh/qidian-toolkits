// app.jsx — main App component, wired to real backend API

const {
  useState: useStateA,
  useEffect: useEffectA,
  useMemo: useMemoA,
  useCallback: useCbA,
  useRef: useRefA,
} = React;

// ── Tweak defaults ────────────────────────────────────────────────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "indigo",
  "density": "cozy",
  "layout": "rail",
  "showActivity": true,
  "fontReading": "serif",
  "showGlossInline": true
}/*EDITMODE-END*/;

// ── Favicon ───────────────────────────────────────────────────────────────────
// Backend không phục vụ /favicon.ico → trình duyệt báo 404 trong console. Gắn icon
// SVG nội tuyến (chữ "A" trên nền accent) nếu trang chưa khai báo icon.
(function vpEnsureFavicon() {
  try {
    if (document.querySelector('link[rel~="icon"]')) return;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
      + '<rect width="32" height="32" rx="7" fill="#4f46e5"/>'
      + '<text x="16" y="22.5" font-family="Georgia,serif" font-size="19" font-weight="700" fill="#fff" text-anchor="middle">A</text></svg>';
    const link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.href = "data:image/svg+xml," + encodeURIComponent(svg);
    document.head.appendChild(link);
  } catch { /* không có DOM — bỏ qua */ }
})();

// ── API helpers ───────────────────────────────────────────────────────────────
// Lỗi HTTP kèm `detail` từ FastAPI; message vẫn bắt đầu bằng mã status (code cũ
// kiểm tra kiểu startsWith("409")).
async function apiError(r) {
  let detail = r.statusText;
  try { const j = await r.json(); if (j && j.detail) detail = j.detail; } catch { /* không phải JSON */ }
  const e = new Error(`${r.status} ${detail}`);
  e.status = r.status;
  return e;
}

const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw await apiError(r);
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await apiError(r);
    return r.json();
  },
  async put(url, body) {
    const r = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await apiError(r);
    return r.json();
  },
  async del(url) {
    const r = await fetch(url, { method: "DELETE" });
    if (!r.ok) throw await apiError(r);
    return r.json();
  },
};

// ── Hash routing ──────────────────────────────────────────────────────────────
// Màn đọc dùng #/{slug}/output/{chương}, thêm /doi-chieu khi mở đối chiếu.
const VALID_TABS = ["chapters", "glossary", "wiki", "output", "settings"];

// Đoạn hash mã hoá sai (vd "%E0%A4%A") làm decodeURIComponent ném URIError → coi như không có.
function safeDecodeHashPart(s) {
  if (!s) return null;
  try { return decodeURIComponent(s); } catch { return null; }
}

function parseHash() {
  const parts = (location.hash || "").replace(/^#\/?/, "").split("/");
  const tab = VALID_TABS.includes(parts[1]) ? parts[1] : "chapters";
  const chapter = safeDecodeHashPart(parts[2]);
  return {
    slug: safeDecodeHashPart(parts[0]),
    tab,
    readerChapter: tab === "output" ? chapter : null,
    chapter: tab !== "output" || parts[3] === "doi-chieu" ? chapter : null,
  };
}

function buildHash(slug, tab, chapter, readerChapter) {
  let h = `#/${encodeURIComponent(slug)}/${tab}`;
  const num = chapter ?? (tab === "output" ? readerChapter : null);
  if (num != null) h += `/${encodeURIComponent(num)}`;
  if (tab === "output" && chapter != null) h += "/doi-chieu";
  return h;
}

// Kiểu chữ đọc lưu riêng (setTweak chỉ báo cho host chỉnh thiết kế, không tự lưu).
const FONT_READING_KEY = "vp:reader:font:v1";
const FONT_READING_VALUES = ["serif", "sans"];
function loadFontReading() {
  try {
    const v = localStorage.getItem(FONT_READING_KEY);
    if (FONT_READING_VALUES.includes(v)) return v;
  } catch { /* Bộ nhớ bị chặn → dùng mặc định. */ }
  return TWEAK_DEFAULTS.fontReading;
}
const APP_TWEAK_INITIAL = { ...TWEAK_DEFAULTS, fontReading: loadFontReading() };

function App() {
  // ── Tweaks ───────────────────────────────────────────────────────────
  const [tweaks, setTweak] = useTweaks(APP_TWEAK_INITIAL);

  // Kiểu chữ đọc: Tweaks và bảng "Aa" cùng sửa giá trị này; lưu localStorage để tải lại vẫn giữ.
  const setFontReading = useCbA((value) => {
    if (!FONT_READING_VALUES.includes(value)) return;
    setTweak("fontReading", value);
    try { localStorage.setItem(FONT_READING_KEY, value); } catch { /* Vẫn áp dụng trong phiên này. */ }
  }, [setTweak]);

  useEffectA(() => {
    document.documentElement.setAttribute("data-accent", tweaks.accent);
    document.documentElement.setAttribute("data-density", tweaks.density);
  }, [tweaks.accent, tweaks.density]);

  const [theme, setTheme] = useStateA(() => {
    try {
      const saved = localStorage.getItem("vp:theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch { /* Dùng giao diện hệ thống khi không đọc được tuỳ chọn. */ }
    return "system";
  });

  useEffectA(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system"
        ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  function changeTheme(value) {
    setTheme(value);
    try { localStorage.setItem("vp:theme", value); } catch { /* Vẫn áp dụng trong phiên này. */ }
  }

  // ── Core state ───────────────────────────────────────────────────────
  const [novels, setNovels] = useStateA([]);
  const [currentSlug, setCurrentSlug] = useStateA(null);
  const [tab, setRouteTab] = useStateA("chapters");
  const [readerChapter, setReaderChapter] = useStateA(null);
  // Bản dịch vừa lưu trong overlay đối chiếu → màn đọc cập nhật nội dung chương đó.
  const [savedOutput, setSavedOutput] = useStateA(null);   // { filename, content, n }
  const [chaptersStatus, setChaptersStatus] = useStateA("loading");
  const [chapters, setChapters] = useStateA([]);
  const [glossary, setGlossary] = useStateA({ characters: [], places: [], realms: [], skills: [] });
  const [glossaryStatus, setGlossaryStatus] = useStateA("loading");
  const glossarySlugRef = useRefA(null);
  const outSaveSeqRef = useRefA({});   // filename → lượt lưu bản dịch mới nhất (tính từ lúc gửi)   // glossary đang hiện thuộc truyện nào
  const [wikiEntities, setWikiEntities] = useStateA([]);
  const [wikiStatus, setWikiStatus] = useStateA("loading");
  const [novelMd, setNovelMd] = useStateA("");
  const [novelMdStatus, setNovelMdStatus] = useStateA("loading");

  const [isRunning, setIsRunning] = useStateA(false);
  const [checked, setChecked] = useStateA({});
  const [filter, setFilter] = useStateA({ status: "all", query: "" });
  const [cmdkOpen, setCmdkOpen] = useStateA(false);
  const [railOpen, setRailOpen] = useStateA(false);  // mobile: off-canvas drawer
  const [newOpen, setNewOpen] = useStateA(false);
  const [openChapter, setOpenChapter] = useStateA(null);
  const [toast, setToast] = useStateA({ msg: null, type: "info" });
  // streaming tokens keyed by filename (persists after done until novel reload)
  const [streamingTexts, setStreamingTexts] = useStateA({});
  // OCR live banner: { active, jobId, title, preview, charCount }
  const [ocrBanner, setOcrBanner] = useStateA(null);

  const esRef = useRefA(null);
  const activeJobIdRef = useRefA(null);
  // Luôn phản ánh truyện đang hiển thị — để guard SSE không nạp dữ liệu job cũ
  // vào truyện khác khi người dùng đổi truyện giữa lúc đang dịch.
  const currentSlugRef = useRefA(null);
  useEffectA(() => { currentSlugRef.current = currentSlug; }, [currentSlug]);
  // Bản chương mới nhất cho hash listener đọc mà không cần phụ thuộc effect.
  const chaptersRef = useRefA([]);
  useEffectA(() => { chaptersRef.current = chapters; }, [chapters]);
  // Số chương cần mở từ URL khi danh sách chương chưa nạp xong.
  const pendingChapterRef = useRefA(null);
  // Chương mở ở lần đồng bộ URL trước — để phân biệt "vừa mở" (push) vs còn lại (replace).
  const prevOpenRef = useRefA(null);
  const syncedHashRef = useRefA(null);
  const chapterRequestRef = useRefA(0);

  // ── Computed ─────────────────────────────────────────────────────────
  const currentNovel = useMemoA(() => {
    const n = novels.find(n => n.slug === currentSlug);
    if (!n) return n;
    return {
      ...n,
      done: chapters.filter(c => c.status === "done").length,
      total: chapters.length,
    };
  }, [novels, currentSlug, chapters]);

  const agents = useMemoA(() => {
    const inProgress = chapters.filter(c => c.status === "in_progress");
    const list = inProgress.map((c, i) => ({
      id: `t${i}`,
      name: `Translator-${i + 1}`,
      role: "TranslatorAgent",
      chapter: c.vi_title || c.zh_title,
      progress: c.progress || 0,
      state: "running",
      log: [{ sym: "·", text: "Đang dịch…", cls: "l-think" }],
    }));
    if (list.length > 0) {
      list.push({
        id: "ex", name: "Extractor", role: "ExtractorAgent",
        chapter: "queued", progress: 0, state: "idle",
        log: [{ sym: "·", text: "waiting for batch completion", cls: "l-think" }],
      });
    }
    return list;
  }, [chapters]);

  const tabCounts = useMemoA(() => ({
    chapters: chapters.length,
    glossary: Object.values(glossary).reduce((a, l) => a + l.length, 0),
    wiki:     wikiEntities.length,
    output:   chapters.filter(c => c.status === "done").length,
  }), [chapters, glossary, wikiEntities]);

  // ── Data loading ─────────────────────────────────────────────────────
  async function loadChapters(slug) {
    if (currentSlugRef.current !== slug) return;
    const request = ++chapterRequestRef.current;
    try {
      const data = await api.get(`/api/chapters?novel_slug=${encodeURIComponent(slug)}`);
      if (currentSlugRef.current !== slug || chapterRequestRef.current !== request) return;
      setChapters(prev => data.map(ch => {
        // Preserve any live progress already tracked in the UI
        const existing = prev.find(c => c.filename === ch.filename);
        return {
          chapter_num: ch.chapter_num,
          filename: ch.filename,
          zh_title: ch.zh_title || ch.filename,
          vi_title: ch.vi_title || "",
          status: ch.status || "pending",
          glossary_hits: 0,
          reviewed: ch.review_status === "ok",
          review_status: ch.review_status || null,
          review_issues: ch.review_issues || null,
          summary: ch.summary || null,
          translated_path: ch.translated_path || null,
          ocr_job_id: ch.ocr_job_id || null,
          source_kind: ch.ocr_job_id ? "image" : "text",
          page_count: 0,
          error: ch.error,
          progress: ch.status === "in_progress" ? (existing?.progress || 50) : 0,
        };
      }));
      setChaptersStatus("ready");
    } catch (err) {
      if (currentSlugRef.current !== slug || chapterRequestRef.current !== request) return;
      setChaptersStatus("error");
      setToast({ msg: `Lỗi tải chương: ${err.message}`, type: "error" });
    }
  }

  async function loadGlossary(slug) {
    try {
      const data = await api.get(`/api/novels/${encodeURIComponent(slug)}`);
      if (currentSlugRef.current !== slug) return;
      glossarySlugRef.current = slug;
      setGlossary({
        characters: data.characters || [],
        places:     data.places     || [],
        realms:     data.realms     || [],
        skills:     data.skills     || [],
      });
      setGlossaryStatus("ready");
    } catch {
      // Nạp lại nền thất bại khi đã có dữ liệu của đúng truyện: giữ nguyên.
      // Chưa có gì của truyện này → báo lỗi (không hiện như danh sách rỗng).
      if (currentSlugRef.current === slug && glossarySlugRef.current !== slug) setGlossaryStatus("error");
    }
  }

  // novel.md đang sửa trong Settings: nhớ nó thuộc truyện nào, version lúc tải, và
  // có đang sửa dở không — để (1) không lưu nội dung truyện A sang truyện B, (2) không
  // ghi đè thay đổi của extractor/glossary (server trả 409), (3) nạp lại nền không
  // xoá bản đang sửa dở.
  const novelMdMeta = useRefA({ slug: null, version: null, dirty: false });

  async function loadNovelMd(slug, { force = false } = {}) {
    try {
      const data = await api.get(`/api/novels/${encodeURIComponent(slug)}/raw`);
      if (currentSlugRef.current !== slug) return;
      const m = novelMdMeta.current;
      if (m.dirty && m.slug === slug && !force) return;   // giữ bản đang sửa dở
      novelMdMeta.current = { slug, version: data.version ?? null, dirty: false };
      window.__vpSettingsDirty = false;
      setNovelMd(data.content || "");
      setNovelMdStatus("ready");
    } catch {
      // Lỗi nạp lại nền khi đã có bản tải trước đó: giữ nguyên, chỉ báo lỗi khi chưa có gì.
      if (currentSlugRef.current === slug && novelMdMeta.current.slug !== slug) setNovelMdStatus("error");
    }
  }

  function editNovelMd(value) {
    novelMdMeta.current.dirty = true;
    window.__vpSettingsDirty = true;
    setNovelMd(value);
  }

  // Đóng tab/reload khi Settings còn sửa dở novel.md → trình duyệt hỏi lại.
  useEffectA(() => {
    const h = (e) => {
      if (novelMdMeta.current.dirty) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);

  async function loadWiki(slug) {
    try {
      const data = await api.get(`/api/wiki/${encodeURIComponent(slug)}/entities`);
      if (currentSlugRef.current !== slug) return;
      setWikiEntities(Array.isArray(data) ? data : []);
      setWikiStatus("ready");
    } catch {
      // Giữ danh sách đang có (nạp lại nền khi đang dịch có thể lỗi tạm thời).
      if (currentSlugRef.current === slug) setWikiStatus("error");
    }
  }

  // Load novels on mount
  useEffectA(() => {
    api.get("/api/novels")
      .then(data => {
        const mapped = data.map(n => ({
          slug: n.slug,
          zh_name: n.zh_name || "",
          vi_name: n.vi_name || n.slug,
          genre: n.genre || "",
          style: n.style || "",
          done: 0, total: 0,
          last_active: "",
          cover_glyph: (n.zh_name || "?")[0],
        }));
        setNovels(mapped);
        if (mapped.length > 0) {
          // Vào thẳng truyện/trang/chương theo URL nếu hợp lệ, nếu không lấy truyện đầu.
          const route = parseHash();
          const slug = mapped.some(n => n.slug === route.slug) ? route.slug : mapped[0].slug;
          setCurrentSlug(slug);
          setRouteTab(route.tab);
          if (slug === route.slug) {
            setReaderChapter(route.readerChapter);
            pendingChapterRef.current = route.chapter;
          }
        }
      })
      .catch(err => setToast({ msg: `Lỗi tải danh sách truyện: ${err.message}`, type: "error" }));
  }, []);

  // ── Đồng bộ state → URL và URL → state ───────────────────────────────
  // state → hash: mỗi khi đổi truyện / tab / chương đang mở, cập nhật URL.
  //  • Mở chương  → pushState (tạo entry để bấm Back đóng được chương).
  //  • Còn lại    → replaceState (đổi tab/truyện/prev-next/đóng chương: không tạo rác history).
  useEffectA(() => {
    if (!currentSlug) return;
    const chNum = openChapter?.chapter_num ?? pendingChapterRef.current;
    const want = buildHash(currentSlug, tab, chNum, readerChapter);
    if (location.hash !== want) {
      if (!prevOpenRef.current && openChapter) history.pushState(null, "", want);
      else history.replaceState(null, "", want);
    }
    syncedHashRef.current = want;
    prevOpenRef.current = openChapter;
  }, [currentSlug, tab, openChapter, readerChapter]);

  // Mở chương đang chờ từ URL khi danh sách chương vừa nạp xong.
  useEffectA(() => {
    if (pendingChapterRef.current == null) return;
    const want = String(pendingChapterRef.current);
    const ch = chapters.find(c => String(c.chapter_num) === want);
    if (ch) { setOpenChapter(ch); pendingChapterRef.current = null; }
  }, [chapters]);

  // hash → state: back/forward hoặc sửa URL thủ công.
  useEffectA(() => {
    const onHash = () => {
      if (!currentSlugRef.current) return;
      const { slug, tab: nextTab, readerChapter: nextReaderChapter, chapter } = parseHash();
      const changedNovel = slug && slug !== currentSlugRef.current && novels.some(n => n.slug === slug);
      const ch = !changedNovel && chapter
        ? chaptersRef.current.find(c => String(c.chapter_num) === chapter)
        : null;
      const rejected = changedNovel
        ? !selectNovel(slug)
        : window.__vpDirty && ch?.chapter_num !== prevOpenRef.current?.chapter_num
          && !window.confirm("Đang sửa dở chưa lưu. Bỏ thay đổi?");
      if (rejected) {
        history.replaceState(null, "", syncedHashRef.current);
        return;
      }
      setRouteTab(nextTab);
      setReaderChapter(nextReaderChapter);
      pendingChapterRef.current = ch ? null : chapter;
      setOpenChapter(ch || null);
      // Trình duyệt đã tạo entry cho URL đang mở.
      prevOpenRef.current = ch || null;
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [novels]);

  // Load data when slug changes
  useEffectA(() => {
    if (!currentSlug) return;
    // Xoá dữ liệu truyện cũ ngay để không hiện/lưu nhầm trong lúc chờ tải.
    novelMdMeta.current = { slug: null, version: null, dirty: false };
    setNovelMd("");
    setNovelMdStatus("loading");
    setWikiStatus("loading");
    if (glossarySlugRef.current !== currentSlug) setGlossaryStatus("loading");
    loadChapters(currentSlug);
    loadGlossary(currentSlug);
    loadNovelMd(currentSlug);
    loadWiki(currentSlug);
  }, [currentSlug]);

  // ── SSE / Translation ─────────────────────────────────────────────────
  function startTranslation(filenames, { force = false, runWiki = true } = {}) {
    if (!currentSlug) { setToast({ msg: "Chọn truyện trước!", type: "error" }); return; }
    if (isRunning) return;
    const jobSlug = currentSlug;          // truyện gắn với job này
    const body = { novel_slug: jobSlug };
    if (filenames && filenames.length) body.chapter_filenames = filenames;
    if (force) body.force = true;         // dịch lại kể cả chương đã xong
    if (!runWiki) body.run_wiki = false;  // chỉ dịch, không tự đưa vào Wiki
    api.post("/api/translate/start", body)
      .then(({ job_id }) => {
        activeJobIdRef.current = job_id;
        setIsRunning(true);
        listenToJob(job_id, jobSlug);
        setToast({ msg: "Bắt đầu dịch…", type: "info" });
      })
      .catch(err => setToast({ msg: `Không thể bắt đầu dịch: ${err.message}`, type: "error" }));
  }

  function cancelJob() {
    const jobId = activeJobIdRef.current;
    if (jobId) api.del(`/api/translate/jobs/${jobId}`).catch(() => {});
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setIsRunning(false);
    setToast({ msg: "Đã hủy.", type: "info" });
    if (currentSlug) loadChapters(currentSlug);
  }

  function listenToJob(jobId, jobSlug) {
    if (esRef.current) esRef.current.close();
    const es = new EventSource(`/api/translate/stream/${jobId}`);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        const { agent, type } = event;

        if (type === "start" && event.file) {
          const file = event.file;
          // Clear any stale streamed text from a previous run of this chapter
          setStreamingTexts(prev => { const next = { ...prev }; delete next[file]; return next; });
          setChapters(prev => prev.map(c =>
            c.filename === file ? { ...c, status: "in_progress", progress: 0 } : c
          ));
        } else if (type === "token" && agent?.startsWith("translator:")) {
          const file = agent.replace("translator:", "");
          // Accumulate streaming text (read by TranslationView via liveText prop)
          setStreamingTexts(prev => ({ ...prev, [file]: (prev[file] || "") + (event.text || "") }));
          // Increment progress
          setChapters(prev => prev.map(c =>
            c.filename === file ? { ...c, progress: Math.min(99, (c.progress || 0) + 1) } : c
          ));
        } else if (type === "done" && agent?.startsWith("translator:")) {
          const file = agent.replace("translator:", "");
          // Keep streamingTexts[file] so the just-finished translation stays visible.
          setChapters(prev => prev.map(c =>
            c.filename === file ? { ...c, status: "done", progress: 100 } : c
          ));
        } else if (type === "wiki_ingest" && agent === "orchestrator") {
          setToast({ msg: `Đang xây Story-Wiki (${event.count} chương)…`, type: "info" });
        } else if (type === "wiki_done" && agent === "orchestrator") {
          if (currentSlugRef.current === jobSlug) loadWiki(jobSlug);
        } else if (type === "done" && agent === "orchestrator") {
          setIsRunning(false);
          setToast({ msg: "Dịch xong!", type: "success" });
          if (esRef.current) { esRef.current.close(); esRef.current = null; }
          if (currentSlugRef.current === jobSlug) { loadChapters(jobSlug); loadGlossary(jobSlug); loadNovelMd(jobSlug); loadWiki(jobSlug); }
        } else if (type === "cancelled") {
          setIsRunning(false);
          if (esRef.current) { esRef.current.close(); esRef.current = null; }
          if (currentSlugRef.current === jobSlug) loadChapters(jobSlug);
        } else if (type === "error" && event.file) {
          setChapters(prev => prev.map(c =>
            c.filename === event.file
              ? { ...c, status: "failed", error: event.error || event.msg || "Lỗi không xác định" }
              : c
          ));
        } else if (type === "error") {
          // Orchestrator-level fatal error (no chapter file) → kết thúc job,
          // tắt spinner thay vì để quay mãi.
          setIsRunning(false);
          if (esRef.current) { esRef.current.close(); esRef.current = null; }
          setToast({ msg: `Lỗi: ${event.msg || event.error || "không xác định"}`, type: "error" });
          if (currentSlugRef.current === jobSlug) loadChapters(jobSlug);
        } else if (type === "review_summary") {
          // Refresh review badges/issues from DB after the batch is reviewed
          if (currentSlugRef.current === jobSlug) loadChapters(jobSlug);
        }
      } catch { /* ignore malformed */ }
    };

    es.onerror = () => {
      // readyState CONNECTING = trình duyệt đang tự kết nối lại (mạng chập chờn):
      // job vẫn chạy, server phát lại lịch sử khi nối lại → giữ nguyên trạng thái.
      // CLOSED = job không còn (404 / server tắt) → kết thúc ở phía UI.
      if (es.readyState !== EventSource.CLOSED) return;
      if (esRef.current === es) {
        setIsRunning(false);
        esRef.current = null;
        if (currentSlugRef.current === jobSlug) loadChapters(jobSlug);
      }
    };
  }

  // ── Trích thuật ngữ (ExtractorAgent) ─────────────────────────────────
  function runExtract() {
    if (!currentSlug) { setToast({ msg: "Chọn truyện trước!", type: "error" }); return; }
    if (isRunning) { setToast({ msg: "Đang có tác vụ chạy, đợi xong đã.", type: "error" }); return; }
    const jobSlug = currentSlug;
    api.post("/api/translate/extract", { novel_slug: jobSlug })
      .then(({ job_id }) => {
        activeJobIdRef.current = job_id;
        setIsRunning(true);
        listenToJob(job_id, jobSlug);   // kết thúc bằng event done → nạp lại glossary/novel.md
        setToast({ msg: "Đang trích xuất thuật ngữ…", type: "info" });
      })
      .catch(err => setToast({ msg: `Không thể trích thuật ngữ: ${err.message}`, type: "error" }));
  }

  // ── Đưa chương vào Story-Wiki (bước riêng, tách khỏi dịch) ────────────
  function ingestWiki(filenames) {
    if (!currentSlug) { setToast({ msg: "Chọn truyện trước!", type: "error" }); return; }
    if (isRunning) { setToast({ msg: "Đang có tác vụ chạy, đợi xong đã.", type: "error" }); return; }
    if (!filenames || !filenames.length) return;
    const jobSlug = currentSlug;
    api.post("/api/translate/wiki", { novel_slug: jobSlug, chapter_filenames: filenames })
      .then(({ job_id }) => {
        activeJobIdRef.current = job_id;
        setIsRunning(true);
        listenToWikiJob(job_id, jobSlug);
        setToast({ msg: "Đang đưa vào Story-Wiki…", type: "info" });
      })
      .catch(err => setToast({ msg: `Không thể đưa vào Wiki: ${err.message}`, type: "error" }));
  }

  function listenToWikiJob(jobId, jobSlug) {
    if (esRef.current) esRef.current.close();
    const es = new EventSource(`/api/translate/stream/${jobId}`);
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        const { agent, type } = event;
        if (type === "wiki_done" && agent === "orchestrator") {
          setIsRunning(false);
          if (esRef.current) { esRef.current.close(); esRef.current = null; }
          if (currentSlugRef.current === jobSlug) loadWiki(jobSlug);
          setToast({ msg: "Đã cập nhật Story-Wiki!", type: "success" });
        } else if (type === "error") {
          setToast({ msg: `Lỗi Wiki: ${event.error || event.msg || "không xác định"}`, type: "error" });
        }
      } catch { /* ignore malformed */ }
    };
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) return;   // đang tự kết nối lại
      if (esRef.current === es) { setIsRunning(false); esRef.current = null; }
    };
  }

  // ── File upload ──────────────────────────────────────────────────────
  async function handleUpload(files) {
    if (!currentSlug) { setToast({ msg: "Chọn truyện trước khi tải lên!", type: "error" }); return; }
    const txtFiles = [...files].filter(f => f.name.endsWith(".txt"));
    if (!txtFiles.length) { setToast({ msg: "Chỉ chấp nhận file .txt", type: "error" }); return; }
    const slug = currentSlug;   // giữ cố định: người dùng có thể đổi truyện trong lúc chờ
    const fd = new FormData();
    fd.append("novel_slug", slug);
    txtFiles.forEach(f => fd.append("files", f));
    try {
      const r = await fetch("/api/chapters/upload", { method: "POST", body: fd });
      if (!r.ok) throw await apiError(r);
      const { saved = [], errors = [] } = await r.json();
      if (saved.length && currentSlugRef.current === slug) loadChapters(slug);
      if (errors.length) {
        setToast({
          msg: `${saved.length ? `Đã tải lên ${saved.length} file. ` : ""}Lỗi ${errors.length} file: ${errors.join(" · ")}`,
          type: "error",
        });
      } else if (saved.length) {
        setToast({ msg: `Đã tải lên ${saved.length} file`, type: "success" });
      }
    } catch (err) {
      setToast({ msg: `Tải lên thất bại: ${err.message}`, type: "error" });
    }
  }

  // ── OCR image upload → server OCR → new chapter ───────────────────────
  const ocrEsRef = useRefA(null);

  function streamOcrJob(jobId, title, jobSlug) {
    if (ocrEsRef.current) ocrEsRef.current.close();
    const es = new EventSource(`/api/ocr/stream/${jobId}`);
    ocrEsRef.current = es;
    let charCount = 0;
    let preview = "";
    setOcrBanner({ active: true, jobId, title: title || "OCR đang xử lý", preview: "", charCount: 0 });

    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === "ocr_token") {
          charCount += (ev.text || "").length;
          preview = (preview + (ev.text || "")).slice(-300);
          setOcrBanner(b => b && b.jobId === jobId ? { ...b, preview, charCount } : b);
        } else if (ev.type === "ocr_progress") {
          // PaddleOCR: tiến trình theo trang (page/total) + dòng log
          setOcrBanner(b => b && b.jobId === jobId
            ? { ...b, preview: ev.msg || b.preview, page: ev.page, total: ev.total }
            : b);
        } else if (ev.type === "ocr_done") {
          es.close(); ocrEsRef.current = null;
          setOcrBanner({ active: true, jobId, title: (title || "OCR") + " ✓", preview: ev.preview || "", charCount: ev.char_count || charCount });
          setToast({ msg: `OCR xong: ${ev.filename}`, type: "success" });
          setTimeout(() => setOcrBanner(null), 2500);
          if (jobSlug && currentSlugRef.current === jobSlug) loadChapters(jobSlug);
        } else if (ev.type === "ocr_error") {
          es.close(); ocrEsRef.current = null;
          setToast({ msg: `OCR lỗi: ${ev.msg}`, type: "error" });
          setOcrBanner(null);
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) return;   // đang tự kết nối lại
      if (ocrEsRef.current === es) { ocrEsRef.current = null; setOcrBanner(null); }
    };
  }

  async function handleImportFolder() {
    if (!currentSlug) { setToast({ msg: "Chọn truyện trước!", type: "error" }); return; }
    try {
      const { imported } = await api.post(`/api/chapters/import?novel_slug=${encodeURIComponent(currentSlug)}`, {});
      setToast({ msg: imported > 0 ? `Đã import ${imported} chương từ thư mục` : "Không tìm thấy chương mới", type: imported > 0 ? "success" : "info" });
      loadChapters(currentSlug);
    } catch (err) {
      setToast({ msg: `Lỗi quét thư mục: ${err.message}`, type: "error" });
    }
  }

  async function handleUploadImages(files, engine = "paddle") {
    if (!currentSlug) { setToast({ msg: "Chọn truyện trước khi tải ảnh lên!", type: "error" }); return; }
    const imgs = [...files].filter(f => f.type.startsWith("image/"));
    if (!imgs.length) { setToast({ msg: "Chỉ chấp nhận file ảnh", type: "error" }); return; }
    const fd = new FormData();
    fd.append("novel_slug", currentSlug);
    fd.append("chapter_title", "");
    fd.append("engine", engine);
    imgs.forEach(f => fd.append("images", f));
    const engineLabel = engine === "paddle" ? "PaddleOCR" : "AI";
    try {
      const r = await fetch("/api/ocr/upload", { method: "POST", body: fd });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const { job_id } = await r.json();
      setToast({ msg: `Đang OCR ${imgs.length} ảnh (${engineLabel})…`, type: "info" });
      streamOcrJob(job_id, `OCR ${imgs.length} ảnh · ${engineLabel}`, fd.get("novel_slug"));
    } catch (err) {
      setToast({ msg: `Tải ảnh lên thất bại: ${err.message}`, type: "error" });
    }
  }

  // On novel switch / mount, pick up any in-flight OCR job
  useEffectA(() => {
    if (!currentSlug) return;
    const slug = currentSlug;
    api.get(`/api/ocr/jobs?novel_slug=${encodeURIComponent(slug)}`)
      .then(jobs => {
        if (currentSlugRef.current !== slug) return;
        if (jobs.length > 0 && !ocrEsRef.current) {
          streamOcrJob(jobs[0].job_id, jobs[0].chapter_title || "OCR đang xử lý", slug);
        }
      })
      .catch(() => {});
  }, [currentSlug]);

  // ── Glossary add ─────────────────────────────────────────────────────
  async function onAddGloss(cat, item) {
    if (!currentSlug) return;
    try {
      const rawData = await api.get(`/api/novels/${currentSlug}/raw`);
      const sectionMap = {
        characters: "Nhân vật",
        places:     "Địa danh",
        realms:     "Cảnh giới tu luyện",
        skills:     "Kỹ năng / Pháp thuật",
      };
      const section = sectionMap[cat] || "Nhân vật";
      const newRow = `| ${item.zh} | ${item.vi} | ${item.notes || ""} |`;
      let content = rawData.content;
      const marker = `## ${section}`;
      if (content.includes(marker)) {
        const idx = content.indexOf(marker) + marker.length;
        const next = content.indexOf("\n## ", idx);
        const insertAt = next === -1 ? content.length : next;
        content = content.slice(0, insertAt) + "\n" + newRow + content.slice(insertAt);
      } else {
        content += `\n\n${marker}\n\n| Tiếng Trung | Tiếng Việt | Ghi chú |\n|---|---|---|\n${newRow}\n`;
      }
      await api.put(`/api/novels/${encodeURIComponent(currentSlug)}/raw`, { content, version: rawData.version });
      await loadGlossary(currentSlug);
      await loadNovelMd(currentSlug);
      setToast({ msg: "Đã thêm thuật ngữ", type: "success" });
    } catch (err) {
      setToast({ msg: `Lỗi thêm thuật ngữ: ${err.message}`, type: "error" });
    }
  }

  // ── Glossary edit / delete ───────────────────────────────────────────
  const glossRow = (it) => `| ${it.zh} | ${it.vi} | ${it.notes || ""} |`;

  // Trả true khi lưu xong (trình sửa đóng), false khi lỗi/huỷ (giữ bản nháp).
  async function onEditGloss(cat, oldItem, newItem) {
    if (!currentSlug) return false;
    if (!newItem.zh || !newItem.vi) {
      setToast({ msg: "Cần nhập cả tiếng Trung và tiếng Việt", type: "error" });
      return false;
    }
    const slug = currentSlug;
    const oldVi = (oldItem.vi || "").trim();
    const newVi = newItem.vi.trim();
    const renaming = !!oldVi && oldVi !== newVi;
    try {
      // Đổi tên Việt: hỏi trước. Đồng ý → (1) lưu phần khác của dòng (chữ Hán, ghi chú) với
      // tên CŨ, rồi (2) máy chủ đổi tên trong bản dịch + bảng + âm đã chốt trong MỘT lần có
      // sao lưu — hash sau cùng khớp, hoàn tác được. Từ chối → chỉ sửa dòng trong bảng.
      let apply = false;
      if (renaming) {
        const pv = await previewRename(slug, oldVi, newVi);
        apply = pv.total ? confirmRename(pv, oldVi, newVi) : true;
      }
      const target = apply ? { ...newItem, vi: oldVi } : newItem;
      await replaceGlossRow(slug, oldItem, target);
      if (apply) {
        let r;
        try {
          r = await api.post(`/api/names/${encodeURIComponent(slug)}/rename/apply`,
                             { old_vi: oldVi, new_vi: newVi });
        } catch (err) {
          // Đổi tên lỗi (vd đang dịch) → trả dòng về như cũ để bảng không đổi nửa vời và
          // trình sửa (so theo zh/vi/ghi chú) vẫn giữ bản nháp.
          await replaceGlossRow(slug, target, oldItem).catch(() => {});
          throw err;
        }
        if (r.files) setToast({
          msg: `Đã thay ${r.replaced} chỗ trong ${r.files} chương`, type: "success",
          action: r.backup_id ? { label: "Hoàn tác", onClick: () => onUndoNames(slug, r.backup_id) } : undefined,
        });
        await loadChapters(slug);
      }
      await loadGlossary(slug);
      await loadNovelMd(slug);
      if (!apply || !renaming) setToast({ msg: "Đã cập nhật thuật ngữ", type: "success" });
      return true;
    } catch (err) {
      await loadGlossary(slug).catch(() => {});
      setToast({ msg: `Lỗi sửa thuật ngữ: ${err.message}`, type: "error" });
      return false;
    }
  }

  async function replaceGlossRow(slug, oldItem, newItem) {
    const oldRow = glossRow(oldItem).trim();
    const newRow = glossRow(newItem);
    if (oldRow === newRow.trim()) return;
    const rawData = await api.get(`/api/novels/${slug}/raw`);
    const lines = rawData.content.split("\n");
    const idx = lines.findIndex(l => l.trim() === oldRow);
    if (idx === -1) throw new Error("Không tìm thấy dòng thuật ngữ trong novel.md");
    lines[idx] = newRow;
    await api.put(`/api/novels/${encodeURIComponent(slug)}/raw`, { content: lines.join("\n"), version: rawData.version });
  }

  function previewRename(slug, oldVi, newVi) {
    return api.post(`/api/names/${encodeURIComponent(slug)}/rename/preview`, { old_vi: oldVi, new_vi: newVi });
  }

  function confirmRename(pv, oldVi, newVi) {
    const list = pv.chapters.slice(0, 8).map(c => `• Chương ${c.chapter_num}: ${c.count} chỗ`).join("\n");
    const more = pv.chapters.length > 8 ? `\n… và ${pv.chapters.length - 8} chương khác` : "";
    const keep = pv.protected?.length ? `\n\nGiữ nguyên trong tên dài hơn: ${pv.protected.join(", ")}` : "";
    return window.confirm(
      `Áp dụng «${oldVi}» → «${newVi}» cho ${pv.total} chỗ trong ${pv.chapters.length} chương đã dịch?\n\n${list}${more}${keep}\n\nBản dịch cũ được sao lưu trên máy chủ. Chọn Huỷ để chỉ sửa trong bảng thuật ngữ.`
    );
  }

  // Kiểm + tự sửa tên riêng cho mọi chương đã dịch của truyện.
  async function onCheckNames() {
    if (!currentSlug) return;
    const slug = currentSlug;
    try {
      setToast({ msg: "Đang kiểm tên riêng…", type: "info" });
      const r = await api.post(`/api/names/${encodeURIComponent(slug)}/check`, {});
      await loadChapters(slug);
      setToast({
        msg: `Đã kiểm ${r.checked} chương: tự sửa ${r.fixed} chỗ, ${r.issues} vấn đề cần xem`,
        type: r.issues ? "info" : "success",
        action: r.backup_id ? { label: "Hoàn tác", onClick: () => onUndoNames(slug, r.backup_id) } : undefined,
      });
    } catch (err) {
      setToast({ msg: `Lỗi kiểm tên: ${err.message}`, type: "error" });
    }
  }

  // Hoàn tác một lần đổi tên / tự sửa tên (máy chủ từ chối nếu file đã đổi sau đó).
  async function onUndoNames(slug, backupId) {
    try {
      const r = await api.post(`/api/names/${encodeURIComponent(slug)}/rename/undo`, { backup_id: backupId });
      await loadChapters(slug);
      if (r.novel_md) { await loadGlossary(slug); await loadNovelMd(slug); }
      setToast({ msg: `Đã hoàn tác ${r.restored} chương`, type: "success" });
    } catch (err) {
      setToast({ msg: `Không hoàn tác được: ${err.message}`, type: "error" });
    }
  }

  async function onDeleteGloss(cat, item) {
    if (!currentSlug) return;
    try {
      const rawData = await api.get(`/api/novels/${currentSlug}/raw`);
      const oldRow = glossRow(item).trim();
      const lines = rawData.content.split("\n");
      const idx = lines.findIndex(l => l.trim() === oldRow);
      if (idx === -1) throw new Error("Không tìm thấy dòng thuật ngữ trong novel.md");
      lines.splice(idx, 1);
      await api.put(`/api/novels/${encodeURIComponent(currentSlug)}/raw`, { content: lines.join("\n"), version: rawData.version });
      await loadGlossary(currentSlug);
      await loadNovelMd(currentSlug);
      setToast({ msg: "Đã xoá thuật ngữ", type: "success" });
    } catch (err) {
      setToast({ msg: `Lỗi xoá thuật ngữ: ${err.message}`, type: "error" });
    }
  }

  // ── In-pane edits from TranslationView (sửa bản gốc / bản dịch) ───────
  async function onSaveSourceText(filename, text) {
    try {
      await api.put(`/api/chapters/${encodeURIComponent(filename)}/source`, { content: text });
      setToast({ msg: "Đã lưu bản gốc", type: "success" });
      return true;
    } catch (err) {
      setToast({ msg: `Lỗi lưu bản gốc: ${err.message} — bản nháp vẫn giữ trong ô sửa`, type: "error" });
      return false;
    }
  }

  async function onSaveOutputText(filename, text) {
    try {
      const seq = (outSaveSeqRef.current[filename] || 0) + 1;
      outSaveSeqRef.current[filename] = seq;
      await api.put(`/api/chapters/${encodeURIComponent(filename)}/output`, { content: text });
      // Phản hồi của lượt lưu cũ về sau lượt mới → không phát bản cũ sang màn đọc.
      if (outSaveSeqRef.current[filename] === seq) {
        setSavedOutput(prev => ({ filename, content: text, n: (prev?.n || 0) + 1 }));
      }
      setToast({ msg: "Đã lưu bản dịch", type: "success" });
      return true;
    } catch (err) {
      setToast({ msg: `Lỗi lưu bản dịch: ${err.message} — bản nháp vẫn giữ trong ô sửa`, type: "error" });
      return false;
    }
  }

  // ── Novel.md save ────────────────────────────────────────────────────
  async function saveNovelMd() {
    if (!currentSlug) return;
    const meta = novelMdMeta.current;
    if (meta.slug !== currentSlug) {
      setToast({ msg: "novel.md chưa tải xong cho truyện này — thử lại sau giây lát", type: "error" });
      return;
    }
    try {
      await api.put(`/api/novels/${encodeURIComponent(currentSlug)}/raw`,
                    { content: novelMd, version: meta.version });
      novelMdMeta.current.dirty = false;
      await loadGlossary(currentSlug);
      await loadNovelMd(currentSlug, { force: true });
      setToast({ msg: "Đã lưu novel.md", type: "success" });
    } catch (err) {
      if (String(err.message).startsWith("409")) {
        const reload = window.confirm(
          "novel.md vừa bị thay đổi ở nơi khác (extractor hoặc thêm/sửa thuật ngữ).\n\n"
          + "OK = tải bản mới nhất (bỏ phần bạn đang sửa)\n"
          + "Cancel = giữ bản đang sửa để bạn copy lại phần cần giữ");
        if (reload) await loadNovelMd(currentSlug, { force: true });
        else setToast({ msg: "Chưa lưu — novel.md trên server đã khác bản bạn đang sửa", type: "error" });
      } else {
        setToast({ msg: `Lỗi lưu: ${err.message}`, type: "error" });
      }
    }
  }

  // ── Create novel ─────────────────────────────────────────────────────
  async function onCreateNovel(n) {
    try {
      await api.post("/api/novels", {
        slug: n.slug,
        zh_name: n.zh_name,
        vi_name: n.vi_name,
        genre: n.genre,
      });
      const novel = {
        slug: n.slug,
        zh_name: n.zh_name,
        vi_name: n.vi_name,
        genre: n.genre,
        style: "",
        done: 0, total: 0,
        last_active: "",
        cover_glyph: n.cover_glyph || (n.zh_name || "?")[0],
      };
      setNovels(ns => [...ns, novel]);
      selectNovel(n.slug);
      setToast({ msg: `Đã tạo truyện "${n.vi_name}"`, type: "success" });
    } catch (err) {
      setToast({ msg: `Lỗi tạo truyện: ${err.message}`, type: "error" });
    }
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────
  useEffectA(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdkOpen(o => !o);
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
        if (e.key === "g") { window._lastG = Date.now(); return; }
        if (window._lastG && Date.now() - window._lastG < 700) {
          if (e.key === "c") { setTab("chapters"); window._lastG = 0; }
          if (e.key === "t") { setTab("glossary"); window._lastG = 0; }
          if (e.key === "w") { setTab("wiki");     window._lastG = 0; }
          if (e.key === "b") { setTab("output");   window._lastG = 0; }
          if (e.key === "s") { setTab("settings"); window._lastG = 0; }
        }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [tab]);

  // ── Handlers ─────────────────────────────────────────────────────────
  function selectNovel(slug) {
    setRailOpen(false);  // đóng drawer mobile khi chọn truyện
    if (slug === currentSlugRef.current) return true;
    const dirty = novelMdMeta.current.dirty || window.__vpDirty;
    if (dirty && !window.confirm("Đang sửa dở chưa lưu (novel.md hoặc chương). Bỏ thay đổi và chuyển truyện?")) return false;
    currentSlugRef.current = slug;
    chapterRequestRef.current++;
    chaptersRef.current = [];
    setCurrentSlug(slug);
    setReaderChapter(null);
    setChaptersStatus("loading");
    setChapters([]);
    setGlossary({ characters: [], places: [], realms: [], skills: [] });
    glossarySlugRef.current = null;
    setGlossaryStatus("loading");
    setWikiEntities([]);
    setWikiStatus("loading");
    setChecked({});
    setStreamingTexts({});
    setOpenChapter(null);
    pendingChapterRef.current = null;
    return true;
  }

  function setTab(nextTab) {
    if (nextTab === tab) return;
    setRouteTab(nextTab);
    if (nextTab !== "output") setReaderChapter(null);
    pendingChapterRef.current = null;
  }

  function reloadReaderChapters() {
    if (!currentSlug) return;
    setChaptersStatus("loading");
    loadChapters(currentSlug);
  }

  const toggleCheck = (fn) => setChecked(c => ({ ...c, [fn]: !c[fn] }));
  const selectAll = (visible) => {
    const next = { ...checked };
    visible.forEach(c => next[c.filename] = true);
    setChecked(next);
  };
  const clearSel = () => setChecked({});

  const navChapter = (dir) => {
    if (!openChapter) return;
    const idx = chapters.findIndex(c => c.filename === openChapter.filename);
    const next = chapters[idx + dir];
    if (next) setOpenChapter(next);
  };

  // Keep the open chapter in sync with live status updates from the table
  useEffectA(() => {
    if (!openChapter) return;
    const fresh = chapters.find(c => c.filename === openChapter.filename);
    if (fresh && fresh.status !== openChapter.status) setOpenChapter(fresh);
  }, [chapters]);

  const onCmdkAction = (item) => {
    if (item.id === "translate-all")   startTranslation(null);
    if (item.id === "extract-terms")   runExtract();
    if (item.id === "new-novel")       setNewOpen(true);
    if (item.id === "toggle-activity") setTweak("showActivity", !tweaks.showActivity);
    if (item.id === "go-chapters")     setTab("chapters");
    if (item.id === "go-glossary")     setTab("glossary");
    if (item.id === "go-wiki")         setTab("wiki");
    if (item.id === "go-output")       setTab("output");
    if (item.id === "go-settings")     setTab("settings");
    if (item.id.startsWith("novel:"))  selectNovel(item.id.slice(6));
    if (item.id.startsWith("chapter:")) {
      const ch = chapters.find(c => c.filename === item.id.slice(8));
      if (ch) setOpenChapter(ch);
    }
    if (item.id.startsWith("gloss:"))  setTab("glossary");
    setCmdkOpen(false);
  };

  // ── Live streamed text for the open chapter ─────────────────────────
  const liveTextForOpen = openChapter ? (streamingTexts[openChapter.filename] || "") : "";
  // Chỉ coi là "đang dịch" khi thực sự có job đang chạy. Chương kẹt 'in_progress'
  // mà không có job (server từng bị gián đoạn) sẽ không bị khoá nút Dịch lại.
  const isStreamingOpen = openChapter
    ? openChapter.status === "in_progress" && isRunning
    : false;

  // ── Novels with updated done/total ──────────────────────────────────
  const novelsWithStats = useMemoA(() =>
    novels.map(n =>
      n.slug === currentSlug
        ? { ...n, done: chapters.filter(c => c.status === "done").length, total: chapters.length }
        : n
    ),
  [novels, currentSlug, chapters]);

  return (
    <>
      <div className="app" data-layout={tweaks.layout} data-reading={tab === "output" ? "true" : undefined}>
        <LeftRail
          novels={novelsWithStats}
          currentSlug={currentSlug}
          onSelect={selectNovel}
          onNew={() => setNewOpen(true)}
          onOpenCmdk={() => setCmdkOpen(true)}
          serverOk={true}
          open={railOpen}
          onClose={() => setRailOpen(false)}
        />

        <main className="main">
          <TopBar
            novel={currentNovel}
            active={tab}
            onTab={setTab}
            onOpenCmdk={() => setCmdkOpen(true)}
            showActivity={tweaks.showActivity}
            onToggleActivity={() => setTweak("showActivity", !tweaks.showActivity)}
            isRunning={isRunning}
            tabCounts={tabCounts}
            theme={theme}
            onTheme={changeTheme}
            onOpenRail={() => setRailOpen(true)}
          />

          {tab === "chapters" && (
            <ChaptersScreen
              chapters={chapters}
              chaptersStatus={chaptersStatus}
              onReloadChapters={reloadReaderChapters}
              isRunning={isRunning}
              agents={agents}
              showActivity={tweaks.showActivity}
              filter={filter}
              onFilter={setFilter}
              checked={checked}
              onToggleCheck={toggleCheck}
              onSelectAll={selectAll}
              onClearSel={clearSel}
              onTranslateAll={() => startTranslation(null)}
              onCheckNames={onCheckNames}
              onTranslateSelected={() => {
                const selected = Object.keys(checked).filter(k => checked[k]);
                startTranslation(selected);
              }}
              onCancel={cancelJob}
              onRetry={() => {
                const failed = chapters.filter(c => c.status === "failed").map(c => c.filename);
                startTranslation(failed);
              }}
              onOpenChapter={setOpenChapter}
              onUpload={handleUpload}
              onUploadImages={handleUploadImages}
              onImportFolder={handleImportFolder}
              ocrBanner={ocrBanner}
            />
          )}

          {tab === "glossary" && (
            <GlossaryScreen
              glossary={glossary}
              status={glossaryStatus}
              onReload={() => { if (currentSlug) { setGlossaryStatus("loading"); loadGlossary(currentSlug); } }}
              onAdd={onAddGloss}
              onEdit={onEditGloss}
              onDelete={onDeleteGloss}
              onExtract={runExtract}
              isExtracting={isRunning}
            />
          )}

          {tab === "wiki" && (
            <WikiScreen
              entities={wikiEntities}
              novelSlug={currentSlug}
              status={wikiStatus}
              onReload={() => { if (currentSlug) { setWikiStatus("loading"); loadWiki(currentSlug); } }}
            />
          )}

          {tab === "output" && (
            <OutputScreen
              key={currentSlug}
              chapters={chapters}
              chaptersStatus={chaptersStatus}
              onReloadChapters={reloadReaderChapters}
              novel={currentNovel}
              routeChapter={readerChapter}
              savedOutput={savedOutput}
              onReadChapter={num => setReaderChapter(String(num))}
              onOpen={setOpenChapter}
              onGoChapters={() => setTab("chapters")}
              onOpenRail={() => setRailOpen(true)}
              suspendKeys={!!openChapter || cmdkOpen || railOpen || newOpen}
              fontMode={tweaks.fontReading}
              onFontMode={setFontReading}
            />
          )}

          {tab === "settings" && (
            <SettingsScreen
              novel={currentNovel}
              novelMd={novelMd}
              mdStatus={novelMdStatus}
              onReloadMd={() => { if (currentSlug) { setNovelMdStatus("loading"); loadNovelMd(currentSlug, { force: true }); } }}
              onChange={editNovelMd}
              onSave={saveNovelMd}
            />
          )}
        </main>
      </div>

      {openChapter && (
        <TranslationView
          chapter={openChapter}
          novel={currentNovel}
          novelSlug={currentSlug}
          glossary={glossary}
          liveText={liveTextForOpen}
          isStreaming={isStreamingOpen}
          onClose={() => setOpenChapter(null)}
          onPrev={() => navChapter(-1)}
          onNext={() => navChapter(1)}
          onRetranslate={() => {
            startTranslation([openChapter.filename], { force: true, runWiki: false });
            setToast({ msg: "Bắt đầu dịch lại chương này…", type: "info" });
          }}
          onIngestWiki={() => ingestWiki([openChapter.filename])}
          onAddTerm={onAddGloss}
          onSaveSource={(text) => onSaveSourceText(openChapter.filename, text)}
          onSaveOutput={(text) => onSaveOutputText(openChapter.filename, text)}
        />
      )}

      <NewNovelModal open={newOpen} onClose={() => setNewOpen(false)} onCreate={onCreateNovel} />

      <CommandPalette
        open={cmdkOpen}
        onClose={() => setCmdkOpen(false)}
        novels={novelsWithStats}
        chapters={chapters}
        glossary={glossary}
        onAction={onCmdkAction}
      />

      <Toast message={toast.msg} type={toast.type} action={toast.action} onDone={() => setToast({ msg: null })} />

      <TweaksPanel title="Tweaks">
        <TweakSection label="Visual">
          <TweakColor
            label="Accent"
            value={tweaks.accent}
            options={["indigo", "emerald", "amber", "rose"]}
            onChange={v => setTweak("accent", v)}
          />
          <TweakRadio
            label="Density"
            value={tweaks.density}
            options={["compact", "cozy", "spacious"]}
            onChange={v => setTweak("density", v)}
          />
          <TweakRadio
            label="Reading font"
            value={tweaks.fontReading}
            options={["serif", "sans"]}
            onChange={setFontReading}
          />
        </TweakSection>

        <TweakSection label="Layout">
          <TweakToggle
            label="Show agent activity rail"
            value={tweaks.showActivity}
            onChange={v => setTweak("showActivity", v)}
          />
        </TweakSection>

        <TweakSection label="Phím tắt">
          <TweakButton label="Open command palette (⌘K)" onClick={() => setCmdkOpen(true)} />
        </TweakSection>
      </TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
