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
    output:   chapters.filter(c => c.status === "done").length,
  }), [chapters, glossary]);

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
        if (mapped.length > 0) setCurrentSlug(mapped[0].slug);
      })
      .catch(err => setToast({ msg: `Lỗi tải danh sách truyện: ${err.message}`, type: "error" }));
  }, []);

  // Load data when slug changes
  useEffectA(() => {
    if (!currentSlug) return;
    loadChapters(currentSlug);
    loadGlossary(currentSlug);
    loadNovelMd(currentSlug);
  }, [currentSlug]);

  // ── SSE / Translation ─────────────────────────────────────────────────
  function startTranslation(filenames) {
    if (!currentSlug) { setToast({ msg: "Chọn truyện trước!", type: "error" }); return; }
    if (isRunning) return;
    const body = { novel_slug: currentSlug };
    if (filenames && filenames.length) body.chapter_filenames = filenames;
    api.post("/api/translate/start", body)
      .then(({ job_id }) => {
        activeJobIdRef.current = job_id;
        setIsRunning(true);
        listenToJob(job_id);
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

  function listenToJob(jobId) {
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
        } else if (type === "done" && agent === "orchestrator") {
          setIsRunning(false);
          setToast({ msg: "Dịch xong!", type: "success" });
          if (esRef.current) { esRef.current.close(); esRef.current = null; }
          if (currentSlug) { loadChapters(currentSlug); loadGlossary(currentSlug); }
        } else if (type === "cancelled") {
          setIsRunning(false);
          if (esRef.current) { esRef.current.close(); esRef.current = null; }
          if (currentSlug) loadChapters(currentSlug);
        } else if (type === "error" && event.file) {
          setChapters(prev => prev.map(c =>
            c.filename === event.file
              ? { ...c, status: "failed", error: event.error || event.msg || "Lỗi không xác định" }
              : c
          ));
        } else if (type === "error") {
          // Orchestrator-level fatal error (no chapter file)
          setToast({ msg: `Lỗi: ${event.msg || event.error || "không xác định"}`, type: "error" });
        } else if (type === "review_summary") {
          // Refresh review badges/issues from DB after the batch is reviewed
          if (currentSlug) loadChapters(currentSlug);
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
          if (e.key === "b") { setTab("output");   window._lastG = 0; }
          if (e.key === "s") { setTab("settings"); window._lastG = 0; }
        }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────
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
    if (item.id === "go-output")       setTab("output");
    if (item.id === "go-settings")     setTab("settings");
    if (item.id.startsWith("novel:"))  setCurrentSlug(item.id.slice(6));
    if (item.id.startsWith("chapter:")) {
      const ch = chapters.find(c => c.filename === item.id.slice(8));
      if (ch) setOpenChapter(ch);
    }
    if (item.id.startsWith("gloss:"))  setTab("glossary");
    setCmdkOpen(false);
  };

  // ── Live streamed text for the open chapter ─────────────────────────
  const liveTextForOpen = openChapter ? (streamingTexts[openChapter.filename] || "") : "";
  const isStreamingOpen = openChapter ? openChapter.status === "in_progress" : false;

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
          onSelect={(slug) => {
            setCurrentSlug(slug);
            setChapters([]);
            setGlossary({ characters: [], places: [], realms: [], skills: [] });
            setChecked({});
            setStreamingTexts({});
            setOpenChapter(null);
          }}
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
              onExtract={() => setToast({ msg: "Đang trích xuất thuật ngữ từ AI…", type: "info" })}
            />
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
            startTranslation([openChapter.filename]);
            setToast({ msg: "Bắt đầu dịch lại chương này…", type: "info" });
          }}
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
