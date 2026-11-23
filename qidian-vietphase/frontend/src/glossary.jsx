// glossary.jsx — Thuật ngữ tab

const { useState: useStateG, useMemo: useMemoG, useEffect: useEffectG } = React;

const GLOSS_CATS = [
  { id: "characters", label: "Nhân vật",  icon: "user"  },
  { id: "places",     label: "Địa danh",  icon: "map"   },
  { id: "realms",     label: "Cảnh giới", icon: "layers"},
  { id: "skills",     label: "Pháp thuật / Kỹ năng", icon: "zap" },
];

function GlossaryScreen({ glossary, status = "ready", onReload, onAdd, onEdit, onDelete, onExtract, isExtracting }) {
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
  async function saveEdit() {
    // Chỉ đóng trình sửa khi lưu xong; lỗi (vd đang dịch, 409) giữ nguyên bản nháp.
    const ok = await onEdit(cat, editing, { zh: ez.trim(), vi: ev.trim(), notes: en.trim() });
    if (ok !== false) setEditing(null);
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
            aria-pressed={cat === g.id}
            onClick={() => setCat(g.id)}
          >
            <Icon name={g.icon} size={13} />
            <span>{g.label}</span>
            <span className="gt-count">{(glossary[g.id] || []).length}</span>
          </button>
        ))}

        <div className="card gloss-extract" style={{ padding: "16px 16px 12px", margin: "12px 8px" }}>
          <div className="gloss-extract-desc" style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 8 }}>
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
        </div>
      </aside>

      <div className="gloss-content">
        <div className="gloss-toolbar">
          <input
            className="input-field"
            type="search"
            aria-label="Tìm thuật ngữ"
            placeholder={`Tìm trong ${GLOSS_CATS.find(c => c.id === cat).label.toLowerCase()}…`}
            value={q}
            onChange={e => setQ(e.target.value)}
            style={{ width: 280, maxWidth: "100%" }}
          />
          <span style={{ fontSize: 11, color: "var(--fg-4)" }}>
            {items.length} / {(glossary[cat] || []).length} thuật ngữ
          </span>
          <div style={{ flex: 1 }} />
          <button
            className={`btn ${showAdd ? "primary" : "ghost"} sm`}
            aria-expanded={showAdd}
            onClick={() => setShowAdd(s => !s)}
          >
            <Icon name="plus" size={13} /> Thêm thuật ngữ
          </button>
        </div>

        {showAdd && (
          <div className="gloss-add-row">
            <input className="input-field" placeholder="Tiếng Trung" aria-label="Tiếng Trung"
              value={zh} onChange={e => setZh(e.target.value)} style={{ width: 140 }} />
            <span aria-hidden="true" style={{ color: "var(--fg-4)" }}>→</span>
            <input className="input-field" placeholder="Tiếng Việt" aria-label="Tiếng Việt"
              value={vi} onChange={e => setVi(e.target.value)} style={{ width: 200 }} />
            <input className="input-field" placeholder="Ghi chú" aria-label="Ghi chú"
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
                      <input className="input-field" value={ez} aria-label="Tiếng Trung"
                        onChange={e => setEz(e.target.value)} style={{ width: "100%" }} />
                    </td>
                    <td>
                      <input className="input-field" value={ev} aria-label="Tiếng Việt"
                        onChange={e => setEv(e.target.value)} style={{ width: "100%" }} />
                    </td>
                    <td>
                      <input className="input-field" value={en} aria-label="Ghi chú"
                        onChange={e => setEn(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter" && ez && ev) saveEdit(); if (e.key === "Escape") setEditing(null); }}
                        style={{ width: "100%" }} />
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button className="icon-btn" title="Lưu" aria-label="Lưu thuật ngữ" disabled={!ez || !ev} onClick={saveEdit}>
                          <Icon name="check" size={13} />
                        </button>
                        <button className="icon-btn" title="Huỷ" aria-label="Huỷ sửa" onClick={() => setEditing(null)}>
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
                        <button className="icon-btn" title="Sửa" aria-label={`Sửa thuật ngữ ${it.zh}`} onClick={() => startEdit(it)}>
                          <Icon name="edit" size={13} />
                        </button>
                        <button className="icon-btn" title="Xoá" aria-label={`Xoá thuật ngữ ${it.zh}`}
                          onClick={() => { if (confirm(`Xoá thuật ngữ "${it.zh} → ${it.vi}"?`)) onDelete(cat, it); }}>
                          <Icon name="cancel" size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              ))}
              {items.length === 0 && (
                <tr><td colSpan={4} style={{ padding: 0 }}>
                  {status === "loading" ? (
                    <StatusBlock kind="loading" title="Đang tải thuật ngữ…" />
                  ) : status === "error" ? (
                    <StatusBlock
                      kind="error"
                      title="Không tải được thuật ngữ"
                      desc={typeof navigator !== "undefined" && navigator.onLine === false
                        ? "Mất kết nối mạng. Kiểm tra mạng rồi thử lại."
                        : "Máy chủ không phản hồi. Thử lại sau giây lát."}
                      actions={onReload && (
                        <button className="btn sm" onClick={onReload}><Icon name="refresh" size={12} /> Thử lại</button>
                      )}
                    />
                  ) : q ? (
                    <StatusBlock
                      kind="empty"
                      title="Không tìm thấy thuật ngữ"
                      actions={<button className="btn sm" onClick={() => setQ("")}>Xoá tìm kiếm</button>}
                    />
                  ) : (
                    <StatusBlock
                      kind="empty"
                      title="Chưa có thuật ngữ trong nhóm này"
                      desc="Thêm tay, bôi đen trong màn đối chiếu, hoặc trích xuất từ các chương đã dịch."
                      actions={!showAdd && (
                        <button className="btn sm" onClick={() => setShowAdd(true)}><Icon name="plus" size={12} /> Thêm thuật ngữ</button>
                      )}
                    />
                  )}
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
