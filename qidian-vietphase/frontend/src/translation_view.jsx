// translation_view.jsx — full-page overlay.
//   • image-sourced chapter (has ocr_job_id): 3-pane  Ảnh | OCR | Bản dịch
//   • text chapter: 2-pane  Bản gốc | Bản dịch
// Static data (source text, pre-translate segments, OCR images, saved output)
// is fetched here; live streaming tokens come in via the `liveText` prop.
// In-pane editing (sửa bản gốc / bản dịch) + thêm thuật ngữ từ bôi đen được
// truyền lên qua các callback onSaveSource / onSaveOutput / onAddTerm.

const { useState: useStateT, useEffect: useEffectT, useMemo: useMemoT, useRef: useRefT, useCallback: useCbT } = React;

function TranslationView({
  chapter, novel, novelSlug, glossary,
  liveText, isStreaming,
  onClose, onNext, onPrev, onRetranslate, onIngestWiki,
  onAddTerm, onSaveSource, onSaveOutput,
}) {
  const isImage = !!chapter?.ocr_job_id;

  // Mobile: hẹp → mặc định mở 1 pane (đối chiếu nhiều cột không đọc được).
  const isNarrow = () => typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches;
  const defaultView = (img) => isNarrow() ? (img ? "ocr+vi" : "translated") : (img ? "all" : "split");

  // view modes:
  //   text:  "split" | "source" | "translated"
  //   image: "all" | "img+ocr" | "ocr+vi"
  const [view, setView] = useStateT(defaultView(isImage));
  const [showGloss, setShowGloss] = useStateT(true);
  const [tone, setTone] = useStateT("trang trọng");
  const [pageIdx, setPageIdx] = useStateT(0);

  // ── fetched (static) data ──────────────────────────────────────────
  const [sourceText, setSourceText] = useStateT("");
  const [segments, setSegments] = useStateT(null);   // pre-translate segments
  const [subCount, setSubCount] = useStateT(0);
  const [images, setImages] = useStateT([]);         // OCR image URLs
  const [outputText, setOutputText] = useStateT("");

  // ── run-OCR-on-existing-images state ───────────────────────────────
  const [ocrRunning, setOcrRunning] = useStateT(false);
  const [ocrStatus, setOcrStatus] = useStateT("");
  const [ocrMenu, setOcrMenu] = useStateT(false);
  const [ocrPage, setOcrPage] = useStateT(0);
  const [ocrTotal, setOcrTotal] = useStateT(0);
  const ocrEsRef = useRefT(null);

  // Fetch source text + pre-translate segments (re-callable after OCR)
  const loadSource = useCbT(() => {
    if (!chapter) return;
    const fn = encodeURIComponent(chapter.filename);
    fetch(`/api/chapters/${fn}/source`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setSourceText(d.content || ""))
      .catch(() => {});
    if (novelSlug) {
      fetch(`/api/chapters/${fn}/pretranslate?novel_slug=${encodeURIComponent(novelSlug)}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) { setSegments(d.segments || []); setSubCount(d.substitution_count || 0); } })
        .catch(() => {});
    }
  }, [chapter?.filename, novelSlug]);

  useEffectT(() => {
    if (!chapter) return;
    const fn = encodeURIComponent(chapter.filename);
    setView(defaultView(isImage));
    setPageIdx(0);
    setSourceText(""); setSegments(null); setSubCount(0);
    setImages([]); setOutputText("");
    setOcrRunning(false); setOcrStatus(""); setOcrMenu(false);
    setOcrPage(0); setOcrTotal(0);

    loadSource();

    if (chapter.status === "done") {
      fetch(`/api/chapters/${fn}/output`)
        .then(r => r.ok ? r.json() : null)
        .then(d => d && setOutputText((d.content || "").replace(/\r\n/g, "\n")))
        .catch(() => {});
    }

    if (chapter.ocr_job_id && novelSlug) {
      const job = chapter.ocr_job_id;
      fetch(`/api/ocr/${encodeURIComponent(novelSlug)}/${encodeURIComponent(job)}/images`)
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (d && d.images) {
            setImages(d.images.map(n => `/api/ocr/${encodeURIComponent(novelSlug)}/${encodeURIComponent(job)}/images/${encodeURIComponent(n)}`));
          }
        })
        .catch(() => {});
    }
  }, [chapter?.filename]);

  // Cleanup OCR stream on unmount
  useEffectT(() => () => { if (ocrEsRef.current) ocrEsRef.current.close(); }, []);

  const runOcr = (engine) => {
    setOcrMenu(false);
    if (!novelSlug || !chapter || ocrRunning) return;
    setOcrRunning(true);
    setOcrStatus("Đang khởi tạo OCR…");
    setOcrPage(0); setOcrTotal(0);
    fetch("/api/ocr/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ novel_slug: novelSlug, filename: chapter.filename, engine }),
    })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
      .then(({ job_id }) => {
        if (ocrEsRef.current) ocrEsRef.current.close();
        const es = new EventSource(`/api/ocr/stream/${job_id}`);
        ocrEsRef.current = es;
        let done = false;
        es.onmessage = (e) => {
          try {
            const ev = JSON.parse(e.data);
            if (ev.type === "ocr_progress") {
              if (ev.msg) setOcrStatus(ev.msg);
              if (ev.total != null) setOcrTotal(ev.total);
              if (ev.page != null) setOcrPage(ev.page);
            }
            else if (ev.type === "ocr_token") setOcrStatus(s => (s + (ev.text || "")).slice(-120));
            else if (ev.type === "ocr_done") {
              done = true;
              es.close(); ocrEsRef.current = null;
              setOcrRunning(false); setOcrStatus("");
              loadSource();
            } else if (ev.type === "ocr_error") {
              done = true;
              es.close(); ocrEsRef.current = null;
              setOcrRunning(false); setOcrStatus("Lỗi OCR: " + (ev.msg || ""));
            }
          } catch { /* ignore */ }
        };
        // Nếu kết nối SSE rớt giữa chừng (OCR lâu 2-4'), vẫn cố lấy lại text:
        // poll source vài lần cho tới khi có nội dung.
        es.onerror = () => {
          es.close();
          if (ocrEsRef.current === es) ocrEsRef.current = null;
          if (done) return;
          setOcrStatus("Mất kết nối stream — đang chờ kết quả OCR…");
          let tries = 0;
          const iv = setInterval(() => {
            tries += 1;
            fetch(`/api/chapters/${encodeURIComponent(chapter.filename)}/source`)
              .then(r => r.ok ? r.json() : null)
              .then(d => {
                if (d && (d.content || "").trim()) {
                  clearInterval(iv);
                  setOcrRunning(false); setOcrStatus("");
                  loadSource();
                } else if (tries >= 60) {  // ~5 phút
                  clearInterval(iv);
                  setOcrRunning(false);
                  setOcrStatus("Hết thời gian chờ OCR. Thử bấm Chạy OCR lại.");
                }
              })
              .catch(() => {});
          }, 5000);
        };
      })
      .catch(err => { setOcrRunning(false); setOcrStatus("Lỗi: " + err.message); });
  };

  useEffectT(() => {
    const h = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onPrev(); }
      if (e.key === "ArrowRight" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onNext(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, onNext, onPrev]);

  if (!chapter) return null;

  const flatGlossary = useMemoT(() => {
    const arr = [];
    Object.entries(glossary).forEach(([cat, items]) => items.forEach(i => arr.push({ ...i, cat })));
    return arr.sort((a, b) => b.zh.length - a.zh.length);
  }, [glossary]);

  // Which panes are shown
  const showImage = isImage && (view === "all" || view === "img+ocr");
  const showSource = isImage
    ? (view === "all" || view === "img+ocr" || view === "ocr+vi")
    : (view === "split" || view === "source");
  const showVi = isImage
    ? (view === "all" || view === "ocr+vi")
    : (view === "split" || view === "translated");
  const cols = [showImage, showSource, showVi].filter(Boolean).length;

  const viewOpts = isImage
    ? [
        { v: "all",     lbl: "Cả ba",      icon: "layers" },
        { v: "img+ocr", lbl: "Ảnh + OCR",  icon: "panel" },
        { v: "ocr+vi",  lbl: "OCR + Dịch", icon: "bookOpen" },
      ]
    : [
        { v: "source",     lbl: "Nguồn",     icon: "panel" },
        { v: "split",      lbl: "Đối chiếu", icon: "layers" },
        { v: "translated", lbl: "Bản dịch",  icon: "bookOpen" },
      ];

  // Translated text:
  //   • while streaming → show the live stream (may be empty → placeholder)
  //   • otherwise → just-finished stream if present, else the saved output
  const translated = isStreaming ? (liveText || "") : (liveText || outputText);

  return (
    <div className="tv-overlay">
      <div className="tv-head">
        <button className="btn ghost sm" onClick={onClose}>
          <Icon name="back" size={13} /> Danh sách
        </button>
        <div style={{ width: 1, height: 16, background: "var(--border)" }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-5)" }}>
          {String(chapter.chapter_num).padStart(4, "0")}
        </span>
        <span style={{ fontWeight: 600, fontSize: 14, color: "var(--fg-1)" }}>
          {chapter.vi_title || chapter.zh_title}
        </span>
        <Badge status={chapter.status} />
        {isImage && (
          <span className="src-chip image" title="Nguồn ảnh + OCR">
            <Icon name="panel" size={9} /> OCR{images.length ? ` · ${images.length} trang` : ""}
          </span>
        )}

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <SegControl value={view} onChange={setView} options={viewOpts} />
          <button
            className={`btn sm ${showGloss ? "" : "ghost"}`}
            onClick={() => setShowGloss(!showGloss)}
            title="Bật/tắt highlight thuật ngữ"
          >
            <Icon name="hash" size={12} /> Glossary
          </button>
          {isImage && (
            <div style={{ position: "relative", display: "inline-flex" }}>
              <button
                className="btn sm"
                onClick={() => runOcr("paddle")}
                disabled={ocrRunning || images.length === 0}
                title="Chạy OCR trên ảnh của chương này (PaddleOCR offline)"
                style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
              >
                {ocrRunning
                  ? <><span className="spin" style={{ marginRight: 4 }}>⟳</span> Đang OCR…</>
                  : <><Icon name="panel" size={12} /> Chạy OCR</>}
              </button>
              <button
                className="btn sm"
                onClick={() => setOcrMenu(o => !o)}
                disabled={ocrRunning || images.length === 0}
                title="Chọn engine OCR"
                style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, marginLeft: 1, padding: "4px 5px" }}
              >
                <Icon name="chevron" size={11} />
              </button>
              {ocrMenu && (
                <>
                  <div style={{ position: "fixed", inset: 0, zIndex: 41 }} onClick={() => setOcrMenu(false)} />
                  <div style={{
                    position: "absolute", top: "100%", right: 0, marginTop: 4, zIndex: 42,
                    background: "var(--bg-surface)", border: "1px solid var(--border)",
                    borderRadius: 6, boxShadow: "var(--shadow-modal)", minWidth: 210, padding: 4,
                  }}>
                    <button className="btn ghost sm" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => runOcr("paddle")}>
                      <Icon name="zap" size={12} color="var(--accent)" /> PaddleOCR (offline)
                    </button>
                    <button className="btn ghost sm" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => runOcr("openai")}>
                      <Icon name="sparkles" size={12} /> OCR bằng AI (OpenAI)
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <div style={{ width: 1, height: 16, background: "var(--border)", margin: "0 4px" }} />
          <button className="btn ghost sm" onClick={onPrev} title="Chương trước (⌘←)">
            <Icon name="prev" size={13} />
          </button>
          <button className="btn ghost sm" onClick={onNext} title="Chương sau (⌘→)">
            <Icon name="next" size={13} />
          </button>
          <button className="btn primary sm" onClick={onRetranslate} disabled={isStreaming}>
            <Icon name="play" size={12} /> {isStreaming ? "Đang dịch…" : "Dịch lại"}
          </button>
          <button className="btn ghost sm" onClick={onIngestWiki} disabled={isStreaming || isImage}
            title={isImage ? "Chương ảnh không có nguồn để trích Wiki" : "Trích thực thể/quan hệ vào Story-Wiki"}>
            <Icon name="layers" size={12} /> Đưa vào Wiki
          </button>
        </div>
      </div>

      <div className="tv-body" data-cols={cols}>
        {showImage && (
          <ImagePane images={images} pageIdx={pageIdx} onPage={setPageIdx} />
        )}

        {showSource && (
          <OcrPane
            isImage={isImage}
            sourceText={sourceText}
            segments={segments}
            subCount={subCount}
            glossary={flatGlossary}
            highlight={showGloss}
            chapter={chapter}
            ocrRunning={ocrRunning}
            ocrStatus={ocrStatus}
            ocrPage={ocrPage}
            ocrTotal={ocrTotal}
            onAddTerm={onAddTerm}
            onSaveSource={(text) => { setSourceText(text); setSegments(null); onSaveSource?.(text); }}
          />
        )}

        {showVi && (
          <ViPane
            chapter={chapter}
            tone={tone}
            onTone={setTone}
            translated={translated}
            isStreaming={isStreaming}
            onSaveOutput={onSaveOutput}
          />
        )}
      </div>
    </div>
  );
}

// ── Image pane (left) ──────────────────────────────────────────────────
function ImagePane({ images, pageIdx, onPage }) {
  const [zoom, setZoom] = useStateT(100);
  const url = images[pageIdx];

  return (
    <div className="tv-pane img">
      <div className="tv-pane-h">
        <span className="label">Ảnh gốc</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-4)" }}>
          {images.length ? `Trang ${pageIdx + 1} / ${images.length}` : "—"}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <button className="btn ghost sm" onClick={() => onPage(Math.max(0, pageIdx - 1))} disabled={pageIdx === 0}>
            <Icon name="prev" size={12} />
          </button>
          <button className="btn ghost sm" onClick={() => onPage(Math.min(images.length - 1, pageIdx + 1))} disabled={pageIdx >= images.length - 1}>
            <Icon name="next" size={12} />
          </button>
          <div className="zoom-ctrl">
            <button onClick={() => setZoom(z => Math.max(25, z - 10))}>−</button>
            <span className="zoom-val">{zoom}%</span>
            <button onClick={() => setZoom(z => Math.min(200, z + 10))}>+</button>
            <button onClick={() => setZoom(100)} title="Reset" style={{ borderLeft: "1px solid var(--border)", padding: "3px 6px" }}>
              <Icon name="refresh" size={11} />
            </button>
          </div>
        </div>
      </div>
      <div className="tv-pane-body">
        <div className="img-stage">
          {url ? (
            <img src={url} alt={`Trang ${pageIdx + 1}`} style={{ width: `${zoom}%`, height: "auto" }} />
          ) : (
            <span style={{ color: "var(--fg-5)", fontSize: 12 }}>Không có ảnh.</span>
          )}
        </div>
        {images.length > 0 && (
          <div className="filmstrip">
            {images.map((p, i) => (
              <div
                key={i}
                className={`film-thumb ${i === pageIdx ? "active" : ""}`}
                onClick={() => onPage(i)}
              >
                <img src={p} alt="" />
                <span className="pg-num">{i + 1}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── OCR / source pane (middle) ─────────────────────────────────────────
function OcrPane({ isImage, sourceText, segments, subCount, glossary, highlight, chapter, ocrRunning, ocrStatus, ocrPage, ocrTotal, onAddTerm, onSaveSource }) {
  // Default ON: show the source with glossary proper-nouns pre-replaced to
  // Vietnamese (the "VietPhase" step that runs before AI translation) — this
  // matches the panel's purpose ("Bản gốc đã thay tên").
  const [phased, setPhased] = useStateT(true);
  const [showOriginal, setShowOriginal] = useStateT(false);
  const [editing, setEditing] = useStateT(false);
  const [draft, setDraft] = useStateT("");
  const [sel, setSel] = useStateT(null);       // { text, x, y } current selection
  const [adding, setAdding] = useStateT(null);  // { zh, x, y } add-term form
  const bodyRef = useRefT(null);

  // Reset editor + selection state whenever the chapter changes.
  useEffectT(() => { setEditing(false); setSel(null); setAdding(null); }, [chapter?.filename]);

  // Dismiss the selection popover on an outside click.
  useEffectT(() => {
    if (!sel) return;
    const clear = (e) => {
      if (e.target.closest && (e.target.closest(".term-pop") || e.target.closest(".term-form"))) return;
      setSel(null);
    };
    document.addEventListener("mousedown", clear);
    return () => document.removeEventListener("mousedown", clear);
  }, [sel]);

  const enterEdit = () => { setDraft(sourceText || ""); setEditing(true); setSel(null); };
  const commitEdit = () => { onSaveSource?.(draft); setEditing(false); };

  const onBodyMouseUp = () => {
    const s = window.getSelection();
    const text = s && s.toString().trim();
    if (!text) { setSel(null); return; }
    const rect = s.getRangeAt(0).getBoundingClientRect();
    setSel({ text, x: rect.left + rect.width / 2, y: rect.top });
  };

  const charCount = sourceText.length;
  // Real substitution count from backend pre-translate, else count glossary hits in text.
  const replaceCount = useMemoT(() => {
    if (subCount) return subCount;
    if (!sourceText) return 0;
    let n = 0;
    glossary.forEach(g => {
      if (!g.zh) return;
      const re = new RegExp(g.zh.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
      const m = sourceText.match(re);
      if (m) n += m.length;
    });
    return n;
  }, [sourceText, glossary, subCount]);

  return (
    <div className={`tv-pane ${isImage ? "ocr" : "zh"}`}>
      <div className="tv-pane-h">
        <span className="label">{isImage ? "Kết quả OCR" : "Bản gốc 中"}</span>
        {editing && <span className="editor-dirty-dot" title="Có thay đổi chưa lưu" />}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--fg-5)", fontFamily: "var(--font-mono)" }}>
          {(editing ? draft.length : charCount)} ký tự
        </span>
        {editing ? (
          <>
            <button className="btn success sm" onClick={commitEdit}><Icon name="save" size={11} /> Lưu</button>
            <button className="btn ghost sm" onClick={() => setEditing(false)}>Hủy</button>
          </>
        ) : (
          <>
            <button
              className={`btn ${phased ? "primary" : ""} sm`}
              onClick={() => setPhased(p => !p)}
              title="Thay thuật ngữ glossary (Hán → Việt) trong văn bản gốc trước khi gửi cho AI dịch"
            >
              <Icon name="sparkles" size={11} /> VietPhase trước
            </button>
            <button className="btn ghost sm" onClick={enterEdit} title="Sửa nội dung bản gốc">
              <Icon name="edit" size={11} /> Sửa
            </button>
          </>
        )}
      </div>

      {!editing && (
      <div className={`phase-bar ${phased ? "" : "idle"}`}>
        <Icon name={phased ? "sparkles" : "hash"} size={12} />
        {phased ? (
          <>
            <span>Đã thay thuật ngữ</span>
            <span className="ph-stat">{replaceCount} lượt thay</span>
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11 }}>
                <input type="checkbox" checked={showOriginal} onChange={e => setShowOriginal(e.target.checked)} />
                Hiện bản Hán gốc
              </label>
            </span>
          </>
        ) : (
          <>
            <span>Có {replaceCount} lượt khớp glossary trong văn bản này.</span>
            <button className="btn sm" onClick={() => setPhased(true)} style={{ marginLeft: "auto" }}>
              <Icon name="sparkles" size={11} /> Thay thuật ngữ trước khi dịch
            </button>
          </>
        )}
      </div>
      )}

      {ocrRunning && !editing && (
        <div className="phase-bar" style={{ background: "linear-gradient(90deg, var(--indigo-950), transparent)", flexWrap: "wrap" }}>
          <span className="spin">⟳</span>
          <OcrProgress page={ocrPage || 0} total={ocrTotal || 0} width={120} />
          <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {ocrStatus || "Đang OCR…"}
          </span>
        </div>
      )}

      {editing ? (
        <textarea
          className="pane-editor"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Nội dung bản gốc…"
          autoFocus
        />
      ) : (
        <div
          ref={bodyRef}
          className={isImage ? "ocr-text" : "tv-pane-body"}
          style={isImage ? { flex: 1, overflowY: "auto" } : null}
          onMouseUp={onBodyMouseUp}
        >
          {!sourceText && !ocrRunning ? (
            <div style={{ color: "var(--fg-4)", fontSize: 13, fontStyle: "italic" }}>
              {isImage
                ? "Chưa có text OCR cho chương này. Bấm “Chạy OCR” ở thanh trên để nhận dạng từ ảnh."
                : "Không có nội dung gốc."}
            </div>
          ) : ocrStatus && ocrStatus.startsWith("Lỗi") ? (
            <div style={{ color: "var(--red-400)", fontSize: 13 }}>{ocrStatus}</div>
          ) : (
            <SourceText
              segments={segments}
              rawText={sourceText}
              glossary={glossary}
              highlight={highlight}
              phased={phased}
              showOriginal={showOriginal}
            />
          )}
        </div>
      )}

      {sel && !adding && (
        <TermPop x={sel.x} y={sel.y} onAdd={() => { setAdding({ zh: sel.text, x: sel.x, y: sel.y }); setSel(null); }} />
      )}
      {adding && (
        <AddTermForm
          zh={adding.zh} x={adding.x} y={adding.y}
          onSubmit={(cat, item) => { onAddTerm?.(cat, item); setAdding(null); const s = window.getSelection(); if (s) s.removeAllRanges(); }}
          onCancel={() => setAdding(null)}
        />
      )}
    </div>
  );
}

// ── Vietnamese translation pane (right) ────────────────────────────────
function ViPane({ chapter, tone, onTone, translated, isStreaming, onSaveOutput }) {
  const [override, setOverride] = useStateT(null); // local saved edit
  const [editing, setEditing] = useStateT(false);
  const [draft, setDraft] = useStateT("");

  useEffectT(() => { setOverride(null); setEditing(false); }, [chapter?.filename]);

  const display = override != null ? override : translated;

  const copyToClipboard = () => {
    if (!display) return;
    navigator.clipboard.writeText(display).catch(() => {});
  };
  const enterEdit = () => { setDraft(display || ""); setEditing(true); };
  const commitEdit = () => { setOverride(draft); onSaveOutput?.(draft); setEditing(false); };

  return (
    <div className="tv-pane vi">
      <div className="tv-pane-h">
        <span className="label">Bản dịch Việt</span>
        {editing && <span className="editor-dirty-dot" title="Có thay đổi chưa lưu" />}
        {isStreaming && (
          <span className="badge in_progress" style={{ marginLeft: 8 }}>
            <span className="spin" style={{ marginRight: 2 }}>⟳</span> Đang dịch…
          </span>
        )}
        {editing ? (
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button className="btn success sm" onClick={commitEdit}><Icon name="save" size={11} /> Lưu</button>
            <button className="btn ghost sm" onClick={() => setEditing(false)}>Hủy</button>
          </div>
        ) : (
          <>
            <span className="chip" style={{ marginLeft: "auto" }}>
              <Icon name="user" size={11} /> tone: {tone}
            </span>
            <select
              className="input-field"
              value={tone}
              onChange={e => onTone(e.target.value)}
              style={{ fontSize: 11, padding: "2px 8px" }}
            >
              <option value="trang trọng">Trang trọng</option>
              <option value="phổ thông">Phổ thông</option>
              <option value="cô đọng">Cô đọng</option>
            </select>
            <button className="btn ghost sm" onClick={copyToClipboard}>
              <Icon name="copy" size={11} /> Sao chép
            </button>
            <button className="btn ghost sm" onClick={enterEdit} disabled={isStreaming} title="Sửa bản dịch">
              <Icon name="edit" size={11} /> Sửa
            </button>
          </>
        )}
      </div>
      {editing ? (
        <textarea
          className="pane-editor"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Bản dịch tiếng Việt…"
          autoFocus
        />
      ) : (
        <div className="tv-pane-body">
          {!display && !isStreaming && (
            <span style={{ color: "var(--fg-4)", fontStyle: "italic", fontSize: 13 }}>
              Chương chưa được dịch. Nhấn “Dịch lại” để bắt đầu.
            </span>
          )}
          {!display && isStreaming && (
            <span style={{ color: "var(--fg-4)", fontStyle: "italic", fontSize: 13 }}>
              Đang khởi tạo bản dịch…<span className="caret" style={{ color: "var(--accent)" }}>▍</span>
            </span>
          )}
          {display && (
            <span style={{ whiteSpace: "pre-wrap" }}>
              {display}
              {isStreaming && <span className="caret" style={{ color: "var(--accent)" }}>▍</span>}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Floating popover offering to add the current selection as a term ───
function TermPop({ x, y, onAdd }) {
  return (
    <div className="term-pop" style={{ left: x, top: y - 6 }}>
      <button className="btn primary sm" onClick={onAdd}>
        <Icon name="plus" size={11} /> Thêm thuật ngữ
      </button>
    </div>
  );
}

const TERM_CATS = [
  { id: "characters", label: "Nhân vật", icon: "user" },
  { id: "places",     label: "Địa danh", icon: "map" },
  { id: "realms",     label: "Cảnh giới", icon: "layers" },
  { id: "skills",     label: "Kỹ năng", icon: "zap" },
];

function AddTermForm({ zh, x, y, onSubmit, onCancel }) {
  const [cat, setCat] = useStateT("characters");
  const [z, setZ] = useStateT(zh);
  const [vi, setVi] = useStateT("");
  const [notes, setNotes] = useStateT("");
  const viRef = useRefT(null);
  useEffectT(() => { const t = setTimeout(() => viRef.current?.focus(), 30); return () => clearTimeout(t); }, []);

  const submit = () => { if (z.trim() && vi.trim()) onSubmit(cat, { zh: z.trim(), vi: vi.trim(), notes: notes.trim() }); };

  const left = Math.min(Math.max(170, x), window.innerWidth - 170);
  const top = Math.max(200, y - 6);

  return (
    <div className="term-form" style={{ left, top }} onMouseDown={e => e.stopPropagation()}>
      <h4><Icon name="hash" size={12} color="var(--accent)" /> Thêm thuật ngữ vào glossary</h4>
      <div className="seg">
        {TERM_CATS.map(c => (
          <button key={c.id} className={cat === c.id ? "on" : ""} onClick={() => setCat(c.id)}>
            <Icon name={c.icon} size={11} /> {c.label}
          </button>
        ))}
      </div>
      <div className="row">
        <input className="input-field" value={z} onChange={e => setZ(e.target.value)}
          style={{ width: 110, fontFamily: "var(--font-mono)" }} placeholder="中" />
        <span className="arrow">→</span>
        <input ref={viRef} className="input-field" value={vi} onChange={e => setVi(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }}
          style={{ flex: 1 }} placeholder="Tiếng Việt" />
      </div>
      <input className="input-field" value={notes} onChange={e => setNotes(e.target.value)}
        placeholder="Ghi chú (tuỳ chọn)"
        onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }} />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        <button className="btn ghost sm" onClick={onCancel}>Hủy</button>
        <button className="btn primary sm" onClick={submit} disabled={!z.trim() || !vi.trim()}>
          <Icon name="plus" size={11} /> Thêm
        </button>
      </div>
    </div>
  );
}

// Renders source text. If backend pre-translate `segments` exist, use them
// (real term substitution); otherwise fall back to client-side glossary
// highlighting of the raw text.
function SourceText({ segments, rawText, glossary, highlight, phased = false, showOriginal = false }) {
  if (segments && segments.length) {
    return (
      <span style={{ whiteSpace: "pre-wrap" }}>
        {segments.map((s, i) => {
          if (s.type === "term") {
            if (phased) {
              return (
                <span key={i} className="phased" title={`${s.zh} → ${s.vi}`}>
                  {s.vi}
                  {showOriginal && <span className="original">{s.zh}</span>}
                </span>
              );
            }
            if (highlight) {
              return (
                <span key={i} className="gloss" title={`${s.zh} → ${s.vi}`}>{s.zh}</span>
              );
            }
            return <React.Fragment key={i}>{s.zh}</React.Fragment>;
          }
          return <React.Fragment key={i}>{s.content}</React.Fragment>;
        })}
      </span>
    );
  }

  // Fallback: raw text + client-side glossary highlight
  if (!rawText) return null;
  const terms = glossary.map(g => g.zh).filter(Boolean);
  if (terms.length === 0 || (!highlight && !phased)) {
    return <span style={{ whiteSpace: "pre-wrap" }}>{rawText}</span>;
  }
  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "g");
  const parts = rawText.split(re);
  return (
    <span style={{ whiteSpace: "pre-wrap" }}>
      {parts.map((p, i) => {
        const g = glossary.find(x => x.zh === p);
        if (g) {
          if (phased) {
            return (
              <span key={i} className="phased" title={`${g.zh} → ${g.vi}`}>
                {g.vi}
                {showOriginal && <span className="original">{g.zh}</span>}
              </span>
            );
          }
          if (highlight) {
            return <span key={i} className="gloss" title={`${g.vi} — ${g.notes || ""}`}>{p}</span>;
          }
        }
        return <React.Fragment key={i}>{p}</React.Fragment>;
      })}
    </span>
  );
}

function SegControl({ value, onChange, options }) {
  return (
    <div style={{
      display: "inline-flex",
      background: "var(--bg-elevated)",
      border: "1px solid var(--border)",
      borderRadius: 6,
      padding: 2,
      gap: 2,
    }}>
      {options.map(o => {
        const active = value === o.v;
        return (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            style={{
              padding: "4px 10px", borderRadius: 4,
              fontSize: 11, fontWeight: 500,
              background: active ? "var(--bg-app)" : "transparent",
              color: active ? "var(--fg-1)" : "var(--fg-3)",
              border: 0,
              display: "inline-flex", alignItems: "center", gap: 4,
              fontFamily: "inherit",
            }}
          >
            <Icon name={o.icon} size={11} />
            {o.lbl}
          </button>
        );
      })}
    </div>
  );
}

Object.assign(window, { TranslationView, SegControl });
