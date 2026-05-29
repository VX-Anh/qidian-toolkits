// glossary.jsx — Thuật ngữ tab

const { useState: useStateG, useMemo: useMemoG } = React;

const GLOSS_CATS = [
  { id: "characters", label: "Nhân vật",  icon: "user"  },
  { id: "places",     label: "Địa danh",  icon: "map"   },
  { id: "realms",     label: "Cảnh giới", icon: "layers"},
  { id: "skills",     label: "Pháp thuật / Kỹ năng", icon: "zap" },
];

function GlossaryScreen({ glossary, onAdd, onExtract, isExtracting }) {
  const [cat, setCat] = useStateG("characters");
  const [q, setQ] = useStateG("");
  const [showAdd, setShowAdd] = useStateG(false);

  // local add form
  const [zh, setZh] = useStateG("");
  const [vi, setVi] = useStateG("");
  const [notes, setNotes] = useStateG("");

  const items = useMemoG(() => {
    const list = glossary[cat] || [];
    if (!q) return list;
    const Q = q.toLowerCase();
    return list.filter(it =>
      (it.zh || "").includes(q) ||
      (it.vi || "").toLowerCase().includes(Q) ||
      (it.notes || "").toLowerCase().includes(Q)
    );
  }, [glossary, cat, q]);

  return (
    <div className="glossary-layout">
      <aside className="glossary-tabs">
        {GLOSS_CATS.map(g => (
          <button
            key={g.id}
            className={`glossary-tab ${cat === g.id ? "active" : ""}`}
            onClick={() => setCat(g.id)}
          >
            <Icon name={g.icon} size={13} />
            <span>{g.label}</span>
            <span className="gt-count">{(glossary[g.id] || []).length}</span>
          </button>
        ))}

        <div style={{
          padding: "16px 16px 12px", margin: "12px 8px",
          background: "var(--bg-elevated)", border: "1px solid var(--border)",
          borderRadius: 6,
        }}>
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 8 }}>
            Trích xuất tự động thuật ngữ mới từ các chương đã dịch.
          </div>
          <button
            className="btn primary sm"
            onClick={onExtract}
            disabled={isExtracting}
            style={{ width: "100%", justifyContent: "center" }}
          >
            <Icon name="sparkles" size={12} />
            {isExtracting ? "Đang trích xuất…" : "Trích xuất từ AI"}
          </button>
          <div style={{ fontSize: 10, color: "var(--fg-5)", marginTop: 6, fontFamily: "var(--font-mono)" }}>
            +12 thuật ngữ từ batch trước
          </div>
        </div>
      </aside>

      <div className="gloss-content">
        <div className="gloss-toolbar">
          <input
            className="input-field"
            placeholder={`Tìm trong ${GLOSS_CATS.find(c => c.id === cat).label.toLowerCase()}…`}
            value={q}
            onChange={e => setQ(e.target.value)}
            style={{ width: 280 }}
          />
          <span style={{ fontSize: 11, color: "var(--fg-5)" }}>
            {items.length} / {(glossary[cat] || []).length} thuật ngữ
          </span>
          <div style={{ flex: 1 }} />
          <button
            className={`btn ${showAdd ? "primary" : "ghost"} sm`}
            onClick={() => setShowAdd(s => !s)}
          >
            <Icon name="plus" size={13} /> Thêm thuật ngữ
          </button>
        </div>

        {showAdd && (
          <div className="gloss-add-row">
            <input className="input-field" placeholder="Tiếng Trung"
              value={zh} onChange={e => setZh(e.target.value)} style={{ width: 140 }} />
            <span style={{ color: "var(--fg-5)" }}>→</span>
            <input className="input-field" placeholder="Tiếng Việt"
              value={vi} onChange={e => setVi(e.target.value)} style={{ width: 200 }} />
            <input className="input-field" placeholder="Ghi chú"
              value={notes} onChange={e => setNotes(e.target.value)} style={{ flex: 1 }} />
            <button className="btn primary sm" disabled={!zh || !vi}
              onClick={() => {
                onAdd(cat, { zh, vi, notes });
                setZh(""); setVi(""); setNotes("");
              }}
            >
              <Icon name="plus" size={12} /> Thêm
            </button>
          </div>
        )}

        <div className="gloss-table-wrap">
          <table className="gloss-table">
            <thead>
              <tr>
                <th style={{ width: 160 }}>Tiếng Trung</th>
                <th style={{ width: 240 }}>Tiếng Việt</th>
                <th>Ghi chú</th>
                <th style={{ width: 90 }}>Dùng</th>
                <th style={{ width: 50 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i}>
                  <td className="zh">{it.zh}</td>
                  <td className="vi">{it.vi}</td>
                  <td className="notes">{it.notes}</td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-4)" }}>
                    {Math.floor(Math.random() * 80) + 1} chương
                  </td>
                  <td>
                    <button className="icon-btn" title="Sửa">
                      <Icon name="edit" size={13} />
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: "center", padding: 32, color: "var(--fg-4)" }}>
                  Không tìm thấy thuật ngữ.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { GlossaryScreen });
