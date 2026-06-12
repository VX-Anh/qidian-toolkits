// glossary.jsx — Thuật ngữ tab

const { useState: useStateG, useMemo: useMemoG, useEffect: useEffectG } = React;

const GLOSS_CATS = [
  { id: "characters", label: "Nhân vật",  icon: "user"  },
  { id: "places",     label: "Địa danh",  icon: "map"   },
  { id: "realms",     label: "Cảnh giới", icon: "layers"},
  { id: "skills",     label: "Pháp thuật / Kỹ năng", icon: "zap" },
];

function GlossaryScreen({ glossary, onAdd, onEdit, onDelete, onExtract, isExtracting }) {
  const [cat, setCat] = useStateG("characters");
  const [q, setQ] = useStateG("");
  const [showAdd, setShowAdd] = useStateG(false);

  // local add form
  const [zh, setZh] = useStateG("");
  const [vi, setVi] = useStateG("");
  const [notes, setNotes] = useStateG("");

  // inline edit state — keyed by the original item so it survives re-sorts
  const [editing, setEditing] = useStateG(null); // { zh, vi, notes } original
  const [ez, setEz] = useStateG("");
  const [ev, setEv] = useStateG("");
  const [en, setEn] = useStateG("");

  // reset edit row when switching category
  useEffectG(() => { setEditing(null); }, [cat]);

  function startEdit(it) {
    setEditing(it);
    setEz(it.zh || ""); setEv(it.vi || ""); setEn(it.notes || "");
  }
  function saveEdit() {
    onEdit(cat, editing, { zh: ez.trim(), vi: ev.trim(), notes: en.trim() });
    setEditing(null);
  }
  const isEditing = (it) =>
    editing && editing.zh === it.zh && editing.vi === it.vi && editing.notes === it.notes;

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
                <th style={{ width: 84 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                isEditing(it) ? (
                  <tr key={i} className="gloss-editing">
                    <td>
                      <input className="input-field" value={ez}
                        onChange={e => setEz(e.target.value)} style={{ width: "100%" }} />
                    </td>
                    <td>
                      <input className="input-field" value={ev}
                        onChange={e => setEv(e.target.value)} style={{ width: "100%" }} />
                    </td>
                    <td>
                      <input className="input-field" value={en}
                        onChange={e => setEn(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter" && ez && ev) saveEdit(); if (e.key === "Escape") setEditing(null); }}
                        style={{ width: "100%" }} />
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button className="icon-btn" title="Lưu" disabled={!ez || !ev} onClick={saveEdit}>
                          <Icon name="check" size={13} />
                        </button>
                        <button className="icon-btn" title="Huỷ" onClick={() => setEditing(null)}>
                          <Icon name="cross" size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={i}>
                    <td className="zh">{it.zh}</td>
                    <td className="vi">{it.vi}</td>
                    <td className="notes">{it.notes}</td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button className="icon-btn" title="Sửa" onClick={() => startEdit(it)}>
                          <Icon name="edit" size={13} />
                        </button>
                        <button className="icon-btn" title="Xoá"
                          onClick={() => { if (confirm(`Xoá thuật ngữ "${it.zh} → ${it.vi}"?`)) onDelete(cat, it); }}>
                          <Icon name="cancel" size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              ))}
              {items.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: "center", padding: 32, color: "var(--fg-4)" }}>
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
