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

// ── API helpers ───────────────────────────────────────────────────────────────
const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  },
  async put(url, body) {
    const r = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  },
  async del(url) {
    const r = await fetch(url, { method: "DELETE" });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  },
};

// ── Hash routing ──────────────────────────────────────────────────────────────
// URL có dạng  #/{novel_slug}/{tab}  để vào thẳng từng trang.
const VALID_TABS = ["chapters", "glossary", "wiki", "output", "settings"];

function parseHash() {
  const parts = (location.hash || "").replace(/^#\/?/, "").split("/");
  return {
    slug: parts[0] ? decodeURIComponent(parts[0]) : null,
    tab: parts[1] || null,
    chapter: parts[2] ? decodeURIComponent(parts[2]) : null,  // số chương
  };
}

function buildHash(slug, tab, chapter) {
  let h = `#/${encodeURIComponent(slug)}/${tab}`;
  if (chapter != null && chapter !== "") h += `/${encodeURIComponent(chapter)}`;
  return h;
}

function App() {
  // ── Tweaks ───────────────────────────────────────────────────────────
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);

  useEffectA(() => {
    document.documentElement.setAttribute("data-accent", tweaks.accent);
    document.documentElement.setAttribute("data-density", tweaks.density);
  }, [tweaks.accent, tweaks.density]);

  // ── Core state ───────────────────────────────────────────────────────
  const [novels, setNovels] = useStateA([]);
  const [currentSlug, setCurrentSlug] = useStateA(null);
  const [tab, setTab] = useStateA("chapters");
  const [chapters, setChapters] = useStateA([]);
  const [glossary, setGlossary] = useStateA({ characters: [], places: [], realms: [], skills: [] });
  const [wikiEntities, setWikiEntities] = useStateA([]);
  const [novelMd, setNovelMd] = useStateA("");

  const [isRunning, setIsRunning] = useStateA(false);
  const [checked, setChecked] = useStateA({});
  const [filter, setFilter] = useStateA({ status: "all", query: "" });
  const [cmdkOpen, setCmdkOpen] = useStateA(false);
  const [newOpen, setNewOpen] = useStateA(false);
  const [openChapter, setOpenChapter] = useStateA(null);
  const [toast, setToast] = useStateA({ msg: null, type: "info" });
  // streaming tokens keyed by filename (persists after done until novel reload)
  const [streamingTexts, setStreamingTexts] = useStateA({});
  // OCR live banner: { active, jobId, title, preview, charCount }
  const [ocrBanner, setOcrBanner] = useStateA(null);

  const esRef = useRefA(null);
  const activeJobIdRef = useRefA(null);
  const openChapterRef = useRefA(null);
  useEffectA(() => { openChapterRef.current = openChapter; }, [openChapter]);
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
    try {
      const data = await api.get(`/api/chapters?novel_slug=${slug}`);
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
    } catch (err) {
      setToast({ msg: `Lỗi tải chương: ${err.message}`, type: "error" });
    }
  }

  async function loadGlossary(slug) {
    try {
      const data = await api.get(`/api/novels/${slug}`);
      setGlossary({
        characters: data.characters || [],
        places:     data.places     || [],
        realms:     data.realms     || [],
        skills:     data.skills     || [],
      });
    } catch { /* ignore */ }
  }

  async function loadNovelMd(slug) {
    try {
      const data = await api.get(`/api/novels/${slug}/raw`);
      setNovelMd(data.content || "");
    } catch { /* ignore */ }
  }

  async function loadWiki(slug) {
    try {
      const data = await api.get(`/api/wiki/${slug}/entities`);
      setWikiEntities(Array.isArray(data) ? data : []);
    } catch { setWikiEntities([]); }
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
          const { slug: hashSlug, tab: hashTab, chapter: hashChapter } = parseHash();
          const slug = mapped.some(n => n.slug === hashSlug) ? hashSlug : mapped[0].slug;
          setCurrentSlug(slug);
          if (hashTab && VALID_TABS.includes(hashTab)) setTab(hashTab);
          if (hashChapter) pendingChapterRef.current = hashChapter;  // mở khi chương nạp xong
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
    const chNum = openChapter ? openChapter.chapter_num : null;
    const want = buildHash(currentSlug, tab, chNum);
    if (location.hash === want) { prevOpenRef.current = openChapter; return; }

    const justOpened = !prevOpenRef.current && openChapter;
    if (justOpened) history.pushState(null, "", want);
    else            history.replaceState(null, "", want);
    prevOpenRef.current = openChapter;
  }, [currentSlug, tab, openChapter]);

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
      const { slug, tab: t, chapter } = parseHash();
      if (slug && slug !== currentSlugRef.current && novels.some(n => n.slug === slug)) {
        selectNovel(slug);
      }
      if (t && VALID_TABS.includes(t)) setTab(t);
      // Mở/đóng chương theo URL.
      if (chapter) {
        const ch = chaptersRef.current.find(c => String(c.chapter_num) === String(chapter));
        if (ch) setOpenChapter(ch);
        else pendingChapterRef.current = chapter;  // đổi truyện xong sẽ mở
      } else if (openChapterRef.current) {
        setOpenChapter(null);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [novels]);

  // Load data when slug changes
  useEffectA(() => {
    if (!currentSlug) return;
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
          if (currentSlugRef.current === jobSlug) { loadChapters(jobSlug); loadGlossary(jobSlug); loadWiki(jobSlug); }
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
      if (esRef.current === es) {
        setIsRunning(false);
        esRef.current = null;
      }
    };
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
      if (esRef.current === es) { setIsRunning(false); esRef.current = null; }
    };
  }

  // ── File upload ──────────────────────────────────────────────────────
  async function handleUpload(files) {
    if (!currentSlug) { setToast({ msg: "Chọn truyện trước khi upload!", type: "error" }); return; }
    const txtFiles = [...files].filter(f => f.name.endsWith(".txt"));
    if (!txtFiles.length) { setToast({ msg: "Chỉ chấp nhận file .txt", type: "error" }); return; }
    const fd = new FormData();
    fd.append("novel_slug", currentSlug);
    txtFiles.forEach(f => fd.append("files", f));
    try {
      const r = await fetch("/api/chapters/upload", { method: "POST", body: fd });
      const { saved, errors } = await r.json();
      if (saved.length) {
        setToast({ msg: `Đã upload ${saved.length} file`, type: "success" });
        loadChapters(currentSlug);
      }
      (errors || []).forEach(e => setToast({ msg: e, type: "error" }));
    } catch (err) {
      setToast({ msg: `Upload thất bại: ${err.message}`, type: "error" });
    }
  }

  // ── OCR image upload → server OCR → new chapter ───────────────────────
  const ocrEsRef = useRefA(null);

  function streamOcrJob(jobId, title) {
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
          if (currentSlug) loadChapters(currentSlug);
        } else if (ev.type === "ocr_error") {
          es.close(); ocrEsRef.current = null;
          setToast({ msg: `OCR lỗi: ${ev.msg}`, type: "error" });
          setOcrBanner(null);
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { es.close(); if (ocrEsRef.current === es) ocrEsRef.current = null; };
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
    if (!currentSlug) { setToast({ msg: "Chọn truyện trước khi upload ảnh!", type: "error" }); return; }
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
      streamOcrJob(job_id, `OCR ${imgs.length} ảnh · ${engineLabel}`);
    } catch (err) {
      setToast({ msg: `Upload ảnh thất bại: ${err.message}`, type: "error" });
    }
  }

  // On novel switch / mount, pick up any in-flight OCR job
  useEffectA(() => {
    if (!currentSlug) return;
    api.get(`/api/ocr/jobs?novel_slug=${currentSlug}`)
      .then(jobs => {
        if (jobs.length > 0 && !ocrEsRef.current) {
          streamOcrJob(jobs[0].job_id, jobs[0].chapter_title || "OCR đang xử lý");
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
      await api.put(`/api/novels/${currentSlug}/raw`, { content });
      await loadGlossary(currentSlug);
      setToast({ msg: "Đã thêm thuật ngữ", type: "success" });
    } catch (err) {
      setToast({ msg: `Lỗi thêm thuật ngữ: ${err.message}`, type: "error" });
    }
  }

  // ── Glossary edit / delete ───────────────────────────────────────────
  const glossRow = (it) => `| ${it.zh} | ${it.vi} | ${it.notes || ""} |`;

  async function onEditGloss(cat, oldItem, newItem) {
    if (!currentSlug) return;
    if (!newItem.zh || !newItem.vi) {
      setToast({ msg: "Cần nhập cả tiếng Trung và tiếng Việt", type: "error" });
      return;
    }
    try {
      const rawData = await api.get(`/api/novels/${currentSlug}/raw`);
      const oldRow = glossRow(oldItem).trim();
      const newRow = glossRow(newItem);
      const lines = rawData.content.split("\n");
      const idx = lines.findIndex(l => l.trim() === oldRow);
      if (idx === -1) throw new Error("Không tìm thấy dòng thuật ngữ trong novel.md");
      lines[idx] = newRow;
      await api.put(`/api/novels/${currentSlug}/raw`, { content: lines.join("\n") });
      await loadGlossary(currentSlug);
      setToast({ msg: "Đã cập nhật thuật ngữ", type: "success" });
    } catch (err) {
      setToast({ msg: `Lỗi sửa thuật ngữ: ${err.message}`, type: "error" });
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
      await api.put(`/api/novels/${currentSlug}/raw`, { content: lines.join("\n") });
      await loadGlossary(currentSlug);
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
    } catch (err) {
      setToast({ msg: `Lỗi lưu bản gốc: ${err.message}`, type: "error" });
    }
  }

  async function onSaveOutputText(filename, text) {
    try {
      await api.put(`/api/chapters/${encodeURIComponent(filename)}/output`, { content: text });
      setToast({ msg: "Đã lưu bản dịch", type: "success" });
    } catch (err) {
      setToast({ msg: `Lỗi lưu bản dịch: ${err.message}`, type: "error" });
    }
  }

  // ── Novel.md save ────────────────────────────────────────────────────
  async function saveNovelMd() {
    if (!currentSlug) return;
    try {
      await api.put(`/api/novels/${currentSlug}/raw`, { content: novelMd });
      await loadGlossary(currentSlug);
      setToast({ msg: "Đã lưu novel.md", type: "success" });
    } catch (err) {
      setToast({ msg: `Lỗi lưu: ${err.message}`, type: "error" });
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
      setCurrentSlug(n.slug);
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
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────
  function selectNovel(slug) {
    if (slug === currentSlugRef.current) return;
    setCurrentSlug(slug);
    setChapters([]);
    setGlossary({ characters: [], places: [], realms: [], skills: [] });
    setWikiEntities([]);
    setChecked({});
    setStreamingTexts({});
    setOpenChapter(null);
    pendingChapterRef.current = null;
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
    if (item.id === "extract-terms")   setToast({ msg: "Đang trích xuất thuật ngữ…", type: "info" });
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
      <div className="app" data-layout={tweaks.layout}>
        <LeftRail
          novels={novelsWithStats}
          currentSlug={currentSlug}
          onSelect={selectNovel}
          onNew={() => setNewOpen(true)}
          onOpenCmdk={() => setCmdkOpen(true)}
          serverOk={true}
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
          />

          {tab === "chapters" && (
            <ChaptersScreen
              chapters={chapters}
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
              onAdd={onAddGloss}
              onEdit={onEditGloss}
              onDelete={onDeleteGloss}
              onExtract={() => setToast({ msg: "Đang trích xuất thuật ngữ từ AI…", type: "info" })}
            />
          )}

          {tab === "wiki" && (
            <WikiScreen entities={wikiEntities} novelSlug={currentSlug} />
          )}

          {tab === "output" && (
            <OutputScreen
              chapters={chapters}
              novel={currentNovel}
              onOpen={setOpenChapter}
              mode={tweaks.fontReading}
            />
          )}

          {tab === "settings" && (
            <SettingsScreen
              novel={currentNovel}
              novelMd={novelMd}
              onChange={setNovelMd}
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

      <Toast message={toast.msg} type={toast.type} onDone={() => setToast({ msg: null })} />

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
            onChange={v => setTweak("fontReading", v)}
          />
        </TweakSection>

        <TweakSection label="Layout">
          <TweakToggle
            label="Show agent activity rail"
            value={tweaks.showActivity}
            onChange={v => setTweak("showActivity", v)}
          />
        </TweakSection>

        <TweakSection label="Debug">
          <TweakToggle
            label="Agents running"
            value={isRunning}
            onChange={v => { if (!v) cancelJob(); }}
          />
          <TweakButton label="Open command palette (⌘K)" onClick={() => setCmdkOpen(true)} />
        </TweakSection>
      </TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
