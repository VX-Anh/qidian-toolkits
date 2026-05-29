// output.jsx — reading view for finished translations

const { useState: useStateO, useEffect: useEffectO } = React;

function OutputScreen({ chapters, novel, onOpen, mode }) {
  const done = chapters.filter(c => c.status === "done");
  const [selected, setSelected] = useStateO(done[done.length - 1]?.filename || null);
  const [content, setContent] = useStateO("");
  const [loading, setLoading] = useStateO(false);

  // Sync selected when done list changes (first load)
  useEffectO(() => {
    if (!selected && done.length > 0) {
      setSelected(done[done.length - 1].filename);
    }
  }, [done.length]);

  // Fetch content when selected changes
  useEffectO(() => {
    if (!selected) { setContent(""); return; }
    setLoading(true);
    setContent("");
    fetch(`/api/chapters/${encodeURIComponent(selected)}/output`)
      .then(r => r.json())
      .then(d => {
        setContent((d.content || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
        setLoading(false);
      })
      .catch(() => { setContent(""); setLoading(false); });
  }, [selected]);

  const copyToClipboard = () => {
    if (!content) return;
    navigator.clipboard.writeText(content).catch(() => {});
  };

  const downloadTxt = () => {
    if (!content || !selected) return;
    const ch = done.find(c => c.filename === selected);
    const title = ch?.vi_title || selected;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const ch = done.find(c => c.filename === selected) || done[done.length - 1];

  return (
    <div className="reader">
      <aside className="reader-sidebar">
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
          <span className="label">Bản dịch ({done.length})</span>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" title="Lọc"><Icon name="filter" size={13} /></button>
        </div>
        <div className="reader-list">
          {done.slice().reverse().map(c => (
            <div
              key={c.filename}
              className={`reader-list-item ${c.filename === selected ? "active" : ""}`}
              onClick={() => setSelected(c.filename)}
            >
              <div className="num">
                Chương {String(c.chapter_num).padStart(4, "0")}
                {!c.reviewed && <span style={{ color: "var(--amber-400)", marginLeft: 6 }}>● chưa duyệt</span>}
              </div>
              <div className="title">{c.vi_title?.replace(/^Chương \d+ — /, "") || c.zh_title}</div>
            </div>
          ))}
        </div>
      </aside>

      <div className="reader-main">
        <div className="reader-toolbar">
          <button className="icon-btn" title="Chương trước"
            onClick={() => {
              const idx = done.findIndex(c => c.filename === selected);
              if (idx > 0) setSelected(done[idx - 1].filename);
            }}>
            <Icon name="prev" size={14} />
          </button>
          <button className="icon-btn" title="Chương sau"
            onClick={() => {
              const idx = done.findIndex(c => c.filename === selected);
              if (idx < done.length - 1) setSelected(done[idx + 1].filename);
            }}>
            <Icon name="next" size={14} />
          </button>
          <div style={{ width: 1, height: 16, background: "var(--border)", margin: "0 6px" }} />
          <span style={{ fontSize: 11, color: "var(--fg-5)", fontFamily: "var(--font-mono)" }}>
            {ch ? (ch.vi_title?.replace(/^Chương \d+ — /, "") || ch.zh_title || "") : ""}
          </span>
          <div style={{ flex: 1 }} />
          {!loading && content && <span style={{ fontSize: 11, color: "var(--fg-5)" }}>Đã lưu ✓</span>}
          <button className="btn ghost sm" onClick={() => ch && onOpen(ch)}>
            <Icon name="layers" size={12} /> Đối chiếu
          </button>
          <button className="btn ghost sm" onClick={copyToClipboard}><Icon name="copy" size={12} /> Sao chép</button>
          <button className="btn ghost sm" onClick={downloadTxt}><Icon name="download" size={12} /> .txt</button>
        </div>

        <div className="reader-body">
          {loading ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-4)", fontSize: 13 }}>
              Đang tải…
            </div>
          ) : !content ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-4)", fontSize: 13 }}>
              {done.length === 0 ? "Chưa có chương nào được dịch." : "Chọn một chương để đọc."}
            </div>
          ) : (
            <article className="reader-page">
              <div className="meta">
                {novel?.vi_name} · {novel?.genre}
              </div>
              <h1>{ch?.vi_title || "—"}</h1>
              <div style={{
                display: "flex", gap: 16, marginBottom: 32,
                fontSize: 11, color: "var(--fg-4)", fontFamily: "var(--font-mono)",
              }}>
                <span>{content.length} ký tự</span>
                <span>·</span>
                <span>~{Math.round(content.split(/\s+/).length / 200)} phút đọc</span>
              </div>
              {content.split("\n\n").map((para, i) => (
                para.trim() ? (
                  <p key={i}>
                    {i === 0 && <span className="drop">{para.charAt(0)}</span>}
                    {i === 0 ? para.slice(1) : para}
                  </p>
                ) : null
              ))}
            </article>
          )}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { OutputScreen });
