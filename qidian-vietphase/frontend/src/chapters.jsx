// chapters.jsx — main workbench: chapter table + live agent activity rail

const { useState: useStateC, useEffect: useEffectC, useRef: useRefC, useMemo: useMemoC } = React;

function ChaptersScreen({
  chapters, isRunning, agents, showActivity,
  filter, onFilter,
  checked, onToggleCheck, onSelectAll, onClearSel,
  onTranslateAll, onTranslateSelected, onCancel, onRetry,
  onOpenChapter, onUpload, onUploadImages, onImportFolder, ocrBanner,
}) {
  const visible = useMemoC(() => {
    return chapters.filter(c => {
      if (filter.status !== "all" && c.status !== filter.status) return false;
      if (filter.query) {
        const q = filter.query.toLowerCase();
        return String(c.chapter_num).includes(q)
          || (c.zh_title || "").toLowerCase().includes(q)
          || (c.vi_title || "").toLowerCase().includes(q);
      }
      return true;
    });
  }, [chapters, filter]);

  const done = chapters.filter(c => c.status === "done").length;
  const total = chapters.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const checkedCount = Object.values(checked).filter(Boolean).length;
  const hasChecked = checkedCount > 0;
  const allVisibleChecked = visible.length > 0 && visible.every(c => checked[c.filename]);

  return (
    <div className="workbench" data-activity={showActivity ? "shown" : "hidden"}>
      <div className="work">
        {/* Toolbar */}
        <div className="work-toolbar">
          {!hasChecked ? (
            <>
              <button className="btn" onClick={() => document.getElementById("dummy-upload").click()}>
                <Icon name="upload" size={14} /> Upload .txt
              </button>
              <input
                id="dummy-upload"
                type="file"
                multiple
                accept=".txt"
                style={{ display: "none" }}
                onChange={(e) => { onUpload?.(e.target.files); e.target.value = ""; }}
              />
              <OcrUploadButton onUploadImages={onUploadImages} />
              <button className="btn ghost" title="Quét thư mục vietphase/ để import chương ảnh có sẵn" onClick={onImportFolder}>
                <Icon name="refresh" size={13} /> Quét thư mục
              </button>
              <button className="btn primary" onClick={onTranslateAll} disabled={isRunning}>
                <Icon name="play" size={12} />
                {isRunning ? "Đang dịch…" : "Dịch tất cả"}
              </button>
              {chapters.some(c => c.status === "failed") && (
                <button className="btn" onClick={onRetry}>
                  <Icon name="refresh" size={13} />
                  Dịch lại lỗi ({chapters.filter(c => c.status === "failed").length})
                </button>
              )}
            </>
          ) : (
            <>
              <span className="chip accent">
                {checkedCount} đã chọn
                <button onClick={onClearSel} style={{ background: "none", border: 0, color: "inherit", marginLeft: 4, padding: 0, fontSize: 12 }}>✕</button>
              </span>
              <button className="btn primary" onClick={onTranslateSelected} disabled={isRunning}>
                <Icon name="play" size={12} /> Dịch {checkedCount} chương
              </button>
              <button className="btn ghost"><Icon name="download" size={13} /> Tải xuống</button>
              <button className="btn ghost"><Icon name="more" size={14} /></button>
            </>
          )}

          {isRunning && !hasChecked && (
            <button className="btn danger" onClick={onCancel}>
              <Icon name="cancel" size={13} /> Hủy
            </button>
          )}

          <div className="spacer" />

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 11, color: "var(--fg-4)", fontFamily: "var(--font-mono)" }}>
              {done} / {total}
            </span>
            <div style={{ width: 140, height: 4, background: "var(--bg-elevated)", borderRadius: 9999, overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)", transition: "width 0.3s" }} />
            </div>
            <span style={{ fontSize: 11, color: "var(--accent)", fontFamily: "var(--font-mono)", minWidth: 32, textAlign: "right" }}>
              {pct}%
            </span>
          </div>
        </div>

        {/* Filters */}
        <div className="work-filters">
          <div style={{ position: "relative", flex: 1, maxWidth: 320 }}>
            <input
              className="input-field"
              placeholder="Tìm theo số chương hoặc tên…"
              value={filter.query}
              onChange={e => onFilter({ ...filter, query: e.target.value })}
              style={{ width: "100%", paddingLeft: 30 }}
            />
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", display: "flex" }}>
              <Icon name="search" size={13} color="var(--fg-4)" />
            </span>
          </div>

          <StatusFilterPills filter={filter} onFilter={onFilter} chapters={chapters} />

          <div className="spacer" style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "var(--fg-5)" }}>
            {visible.length} / {total} chương
          </span>
        </div>

        {/* OCR live banner */}
        {ocrBanner && ocrBanner.active && (
          <div className="ocr-banner">
            <span className="ocr-spinner" />
            <span className="ocr-banner-title">{ocrBanner.title || "OCR đang xử lý"}</span>
            {(ocrBanner.total > 0 || ocrBanner.page != null) && (
              <OcrProgress page={ocrBanner.page || 0} total={ocrBanner.total || 0} />
            )}
            {ocrBanner.preview && (
              <span className="ocr-banner-preview">{ocrBanner.preview}</span>
            )}
            <span className="ocr-banner-count">{ocrBanner.charCount ? `${ocrBanner.charCount.toLocaleString()} ký tự` : ""}</span>
          </div>
        )}

        {/* Table */}
        <div className="work-body">
          <table className="ch-table">
            <thead>
              <tr>
                <th style={{ width: 32, paddingLeft: 20 }}>
                  <input
                    type="checkbox"
                    checked={allVisibleChecked}
                    onChange={() => allVisibleChecked ? onClearSel() : onSelectAll(visible)}
                  />
                </th>
                <th style={{ width: 60 }}>#</th>
                <th style={{ width: "26%" }}>Tên Trung</th>
                <th>Tên Việt</th>
                <th style={{ width: 110 }}>Trạng thái</th>
                <th style={{ width: 80 }}>Thuật ngữ</th>
                <th style={{ width: 80, paddingRight: 20 }}>Review</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(ch => (
                <ChapterRow
                  key={ch.filename}
                  ch={ch}
                  checked={!!checked[ch.filename]}
                  onToggle={() => onToggleCheck(ch.filename)}
                  onOpen={() => onOpenChapter(ch)}
                />
              ))}
              {visible.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: "center", padding: 40, color: "var(--fg-4)" }}>
                  Không có chương nào khớp bộ lọc.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ActivityRail agents={agents} isRunning={isRunning} />
    </div>
  );
}

function StatusFilterPills({ filter, onFilter, chapters }) {
  const counts = useMemoC(() => {
    const c = { all: chapters.length, pending: 0, queued: 0, in_progress: 0, done: 0, failed: 0 };
    chapters.forEach(ch => { c[ch.status] = (c[ch.status] || 0) + 1; });
    return c;
  }, [chapters]);

  const opts = [
    { v: "all",         lbl: "Tất cả" },
    { v: "in_progress", lbl: "Đang dịch" },
    { v: "queued",      lbl: "Hàng đợi" },
    { v: "done",        lbl: "Xong" },
    { v: "failed",      lbl: "Lỗi" },
    { v: "pending",     lbl: "Chờ" },
  ];

  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      {opts.map(o => {
        const active = filter.status === o.v;
        const count = counts[o.v] || 0;
        if (o.v !== "all" && count === 0) return null;
        return (
          <button
            key={o.v}
            onClick={() => onFilter({ ...filter, status: o.v })}
            style={{
              padding: "4px 10px", borderRadius: 9999, fontSize: 11,
              background: active ? "var(--indigo-950)" : "transparent",
              color: active ? "var(--accent)" : "var(--fg-3)",
              border: `1px solid ${active ? "var(--indigo-900)" : "var(--border)"}`,
              fontFamily: "inherit", fontWeight: 500,
              display: "inline-flex", alignItems: "center", gap: 4,
            }}
          >
            {o.lbl}
            <span style={{ color: active ? "var(--accent)" : "var(--fg-5)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ChapterRow({ ch, checked, onToggle, onOpen }) {
  return (
    <tr
      className={`row ${checked ? "selected" : ""} ${ch.status === "in_progress" ? "active" : ""}`}
    >
      <td onClick={e => e.stopPropagation()}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
      </td>
      <td className="ch-num">{String(ch.chapter_num).padStart(4, "0")}</td>
      <td className="ch-zh">
        {ch.source_kind === "image" && (
          <span className="src-chip image" title={`Nguồn ảnh (${ch.page_count} trang)`} style={{ marginRight: 6, marginLeft: 0 }}>
            <Icon name="panel" size={9} /> OCR
          </span>
        )}
        {ch.zh_title}
      </td>
      <td>
        {ch.status === "in_progress" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="ch-mini-stream">
              {ch.vi_title || "Đang khởi tạo bản dịch…"}
              <span className="caret" style={{ color: "var(--accent)" }}>▍</span>
            </span>
            <span style={{ fontSize: 10, color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
              {Math.round(ch.progress || 0)}%
            </span>
          </div>
        ) : ch.status === "failed" ? (
          <span style={{ color: "var(--red-400)", fontSize: 12 }}>
            <Icon name="alert" size={12} color="var(--red-400)" />
            <span style={{ marginLeft: 6 }}>{ch.error}</span>
          </span>
        ) : ch.vi_title ? (
          <span className="ch-vi">{ch.vi_title}</span>
        ) : (
          <span className="ch-vi empty">—</span>
        )}
      </td>
      <td><Badge status={ch.status} /></td>
      <td>
        {ch.glossary_hits > 0 && (
          <span className="ch-glossary-hits">{ch.glossary_hits} hits</span>
        )}
      </td>
      <td style={{ textAlign: "right" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
          {ch.review_status === "needs_fix" && (
            <span className="src-chip" style={{ background: "var(--amber-900)", color: "var(--amber-300)", border: "1px solid var(--amber-700)" }} title={ch.review_issues || "Cần sửa"}>
              <Icon name="alert" size={9} /> Cần sửa
            </span>
          )}
          {ch.review_status === "ok" && (
            <span style={{ color: "var(--emerald-400)", fontSize: 11, display: "inline-flex", alignItems: "center", gap: 3 }}>
              <Icon name="check" size={11} /> OK
            </span>
          )}
          <button
            onClick={onOpen}
            style={{
              background: "none", border: 0, color: "var(--accent)",
              fontSize: 11, cursor: "pointer", fontFamily: "inherit",
              display: "inline-flex", alignItems: "center", gap: 4,
            }}
          >
            <Icon name={ch.status === "done" ? "bookOpen" : "forward"} size={11} />
            {ch.status === "done" ? "Xem" : "Mở"}
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Activity rail (right side) ──────────────────────────────────────────
function ActivityRail({ agents, isRunning }) {
  return (
    <aside className="activity">
      <div className="activity-h">
        <span className={`live-dot ${isRunning ? "" : "idle"}`} />
        <span className="label">Hoạt động agent</span>
        <span style={{ fontSize: 10, color: "var(--fg-5)", fontFamily: "var(--font-mono)" }}>
          {agents.filter(a => a.state === "running").length}/{agents.length}
        </span>
      </div>
      <div className="activity-body">
        {agents.map(a => <AgentCard key={a.id} agent={a} />)}

        {agents.length === 0 && !isRunning && (
          <div style={{ padding: "24px 16px", textAlign: "center", fontSize: 11, color: "var(--fg-5)" }}>
            Không có agent nào đang chạy.
          </div>
        )}
      </div>
    </aside>
  );
}

function AgentCard({ agent }) {
  return (
    <div className={`agent-card ${agent.state === "running" ? "active" : ""}`}>
      <div className="agent-card-h">
        <span className={`live-dot ${agent.state === "running" ? "" : "idle"}`} style={{ width: 6, height: 6 }} />
        <span className="agent-name">{agent.name}</span>
        <span className="agent-tag">{agent.role}</span>
      </div>
      <div className="agent-chapter">{agent.chapter}</div>
      <div className="agent-log">
        {agent.log.slice(-4).map((l, i) => (
          <div key={i} className={l.cls}>
            <span style={{ marginRight: 4 }}>{l.sym}</span>{l.text}
          </div>
        ))}
      </div>
      {agent.progress > 0 && (
        <div className="tiny-progress">
          <div className="fill" style={{ width: `${agent.progress}%` }} />
        </div>
      )}
    </div>
  );
}

// ── OCR upload button with engine picker (Paddle default + AI) ──────────
function OcrUploadButton({ onUploadImages }) {
  const [menuOpen, setMenuOpen] = useStateC(false);
  const engineRef = useRefC("paddle");
  const inputRef = useRefC(null);

  const pick = (engine) => {
    engineRef.current = engine;
    setMenuOpen(false);
    inputRef.current?.click();
  };

  const item = {
    display: "flex", alignItems: "center", gap: 8, width: "100%",
    padding: "8px 10px", background: "none", border: 0, color: "var(--fg-1)",
    fontSize: 12, fontFamily: "inherit", borderRadius: 4, textAlign: "left", cursor: "pointer",
  };

  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      <button
        className="btn"
        title="OCR ảnh bằng PaddleOCR (offline) — bấm mũi tên để đổi engine"
        onClick={() => pick("paddle")}
        style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
      >
        <Icon name="panel" size={13} /> OCR ảnh
      </button>
      <button
        className="btn"
        title="Chọn engine OCR"
        onClick={() => setMenuOpen(o => !o)}
        style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, marginLeft: 1, padding: "6px 6px" }}
      >
        <Icon name="chevron" size={12} />
      </button>

      {menuOpen && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 29 }} onClick={() => setMenuOpen(false)} />
          <div style={{
            position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 30,
            background: "var(--bg-surface)", border: "1px solid var(--border)",
            borderRadius: 6, boxShadow: "var(--shadow-modal)", minWidth: 230, padding: 4,
          }}>
            <button style={item} onClick={() => pick("paddle")}
              onMouseEnter={e => e.currentTarget.style.background = "var(--bg-elevated)"}
              onMouseLeave={e => e.currentTarget.style.background = "none"}>
              <Icon name="zap" size={13} color="var(--accent)" />
              <span style={{ flex: 1 }}>PaddleOCR <span style={{ color: "var(--fg-5)" }}>· offline, mặc định</span></span>
            </button>
            <button style={item} onClick={() => pick("openai")}
              onMouseEnter={e => e.currentTarget.style.background = "var(--bg-elevated)"}
              onMouseLeave={e => e.currentTarget.style.background = "none"}>
              <Icon name="sparkles" size={13} color="var(--fg-3)" />
              <span style={{ flex: 1 }}>OCR bằng AI <span style={{ color: "var(--fg-5)" }}>· OpenAI vision</span></span>
            </button>
          </div>
        </>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => { onUploadImages?.(e.target.files, engineRef.current); e.target.value = ""; }}
      />
    </div>
  );
}

Object.assign(window, { ChaptersScreen, OcrUploadButton });
