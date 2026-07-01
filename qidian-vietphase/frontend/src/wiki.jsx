// wiki.jsx — Story-Wiki tab: thực thể giàu ngữ cảnh (alias, mô tả, quan hệ)
// Dữ liệu từ /api/wiki/{slug}/entities (+ /entity/{zh} cho quan hệ).

const { useState: useStateW, useMemo: useMemoW, useEffect: useEffectW } = React;

const WIKI_TYPES = [
  { id: "character", label: "Nhân vật", icon: "user"   },
  { id: "place",     label: "Địa danh", icon: "map"    },
  { id: "realm",     label: "Cảnh giới", icon: "layers"},
  { id: "skill",     label: "Kỹ năng",  icon: "zap"    },
  { id: "other",     label: "Khác",     icon: "hash"   },
];
const WIKI_TYPE = Object.fromEntries(WIKI_TYPES.map(t => [t.id, t]));

const LBL = {
  fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase",
  color: "var(--fg-5)", fontWeight: 600,
};

// Biến mô tả thành các node React, in đậm + click được khi gặp tên thực thể khác.
function linkifyDesc(text, entities, currentZh, onSelect) {
  if (!text) return null;
  // Tên ≤1 ký tự bị bỏ qua: dễ false-link vào tên dài hơn / chữ thường trong câu.
  const names = [];
  const add = (name, zh) => { if (name && name.length > 1) names.push([name, zh]); };
  entities.forEach(e => {
    if (e.zh === currentZh) return;
    add(e.vi, e.zh);
    add(e.zh, e.zh);
    (e.aliases || []).forEach(a => add(a, e.zh));
  });
  names.sort((a, b) => b[0].length - a[0].length);

  let nodes = [text];
  names.forEach(([name, zh]) => {
    if (!name) return;
    const next = [];
    nodes.forEach(node => {
      if (typeof node !== "string") { next.push(node); return; }
      let rest = node, idx;
      while ((idx = rest.indexOf(name)) !== -1) {
        if (idx > 0) next.push(rest.slice(0, idx));
        next.push({ name, zh });
        rest = rest.slice(idx + name.length);
      }
      if (rest) next.push(rest);
    });
    nodes = next;
  });

  return nodes.map((n, i) => typeof n === "string"
    ? <React.Fragment key={i}>{n}</React.Fragment>
    : <span key={i} onClick={() => onSelect(n.zh)}
        style={{ color: "var(--accent)", cursor: "pointer", fontWeight: 500 }}>
        {n.name}
      </span>);
}

function WikiScreen({ entities, novelSlug }) {
  const [typeFilter, setTypeFilter] = useStateW("all");
  const [q, setQ] = useStateW("");
  const [selZh, setSelZh] = useStateW(null);
  const [detail, setDetail] = useStateW(null);

  const counts = useMemoW(() => {
    const c = { all: entities.length };
    WIKI_TYPES.forEach(t => (c[t.id] = 0));
    entities.forEach(e => { c[e.type] = (c[e.type] || 0) + 1; });
    return c;
  }, [entities]);

  const filtered = useMemoW(() => {
    let list = entities;
    if (typeFilter !== "all") list = list.filter(e => e.type === typeFilter);
    if (q) {
      const Q = q.toLowerCase();
      list = list.filter(e =>
        (e.zh || "").includes(q) ||
        (e.vi || "").toLowerCase().includes(Q) ||
        (e.description || "").toLowerCase().includes(Q) ||
        (e.aliases || []).some(a => a.includes(q)));
    }
    return list;
  }, [entities, typeFilter, q]);

  const byZh = useMemoW(() => {
    const m = {};
    entities.forEach(e => {
      m[e.zh] = e;
      (e.aliases || []).forEach(a => { if (!m[a]) m[a] = e; });
    });
    return m;
  }, [entities]);

  // Giữ lựa chọn hợp lệ khi đổi truyện / đổi bộ lọc
  useEffectW(() => {
    if (filtered.length === 0) { setSelZh(null); return; }
    if (!filtered.some(e => e.zh === selZh)) setSelZh(filtered[0].zh);
  }, [filtered]);

  // Tải chi tiết (kèm quan hệ) khi đổi lựa chọn
  useEffectW(() => {
    if (!selZh || !novelSlug) { setDetail(null); return; }
    let alive = true;
    fetch(`/api/wiki/${novelSlug}/entity/${encodeURIComponent(selZh)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive) setDetail(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [selZh, novelSlug]);

  const sel = (detail && detail.zh === selZh)
    ? detail
    : entities.find(e => e.zh === selZh) || null;

  const nameOf = (zh) => {
    const e = byZh[zh];
    return e ? (e.vi || e.zh) : zh;
  };

  if (entities.length === 0) {
    return (
      <div className="glossary-layout">
        <div style={{
          gridColumn: "1 / -1", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 10, color: "var(--fg-4)",
        }}>
          <Icon name="book" size={32} color="var(--fg-5)" />
          <div style={{ fontSize: 14, color: "var(--fg-3)" }}>Chưa có dữ liệu Story-Wiki</div>
          <div style={{ fontSize: 12, maxWidth: 360, textAlign: "center" }}>
            Dịch vài chương — WikiAgent sẽ tự trích thực thể, quan hệ và sự kiện từ nội dung.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="glossary-layout">
      {/* Cột lọc theo loại */}
      <aside className="glossary-tabs">
        <button
          className={`glossary-tab ${typeFilter === "all" ? "active" : ""}`}
          onClick={() => setTypeFilter("all")}
        >
          <Icon name="list" size={13} />
          <span>Tất cả</span>
          <span className="gt-count">{counts.all}</span>
        </button>
        {WIKI_TYPES.map(t => (
          <button
            key={t.id}
            className={`glossary-tab ${typeFilter === t.id ? "active" : ""}`}
            onClick={() => setTypeFilter(t.id)}
          >
            <Icon name={t.icon} size={13} />
            <span>{t.label}</span>
            <span className="gt-count">{counts[t.id] || 0}</span>
          </button>
        ))}
      </aside>

      {/* Nội dung: toolbar + (danh sách | chi tiết) */}
      <div className="gloss-content">
        <div className="gloss-toolbar">
          <input
            className="input-field"
            placeholder="Tìm thực thể (Hán / Việt / mô tả)…"
            value={q}
            onChange={e => setQ(e.target.value)}
            style={{ width: 280 }}
          />
          <span style={{ fontSize: 11, color: "var(--fg-5)" }}>
            {filtered.length} thực thể
          </span>
        </div>

        <div className="wiki-split" style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {/* Danh sách thực thể */}
          <div className="wiki-ent-list" style={{
            width: 300, borderRight: "1px solid var(--border)",
            overflowY: "auto", flexShrink: 0,
          }}>
            {filtered.map(e => (
              <div
                key={e.zh}
                onClick={() => setSelZh(e.zh)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "9px 14px", cursor: "pointer",
                  borderLeft: "2px solid " + (selZh === e.zh ? "var(--accent)" : "transparent"),
                  background: selZh === e.zh ? "var(--bg-elevated)" : "transparent",
                }}
              >
                <Icon name={(WIKI_TYPE[e.type] || WIKI_TYPE.other).icon} size={13}
                  color="var(--fg-4)" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, color: "var(--fg-1)", whiteSpace: "nowrap",
                    overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {e.vi || <span style={{ color: "var(--fg-4)" }}>(chưa có tên Việt)</span>}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--fg-5)", fontFamily: "var(--font-mono)" }}>
                    {e.zh}{e.first_chapter ? ` · ch.${e.first_chapter}` : ""}
                  </div>
                </div>
                <span style={{ fontSize: 10, color: "var(--fg-5)", fontFamily: "var(--font-mono)" }}>
                  ×{e.freq}
                </span>
              </div>
            ))}
            {filtered.length === 0 && (
              <div style={{ padding: 24, textAlign: "center", color: "var(--fg-4)", fontSize: 12 }}>
                Không có thực thể.
              </div>
            )}
          </div>

          {/* Bảng chi tiết */}
          <div className="wiki-ent-detail" style={{ flex: 1, overflowY: "auto", padding: 24, minWidth: 0 }}>
            {!sel ? (
              <div style={{ color: "var(--fg-4)", fontSize: 13 }}>Chọn một thực thể để xem chi tiết.</div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <Icon name={(WIKI_TYPE[sel.type] || WIKI_TYPE.other).icon} size={18}
                    color="var(--accent)" />
                  <h2 style={{ margin: 0, fontSize: 20, color: "var(--fg-1)" }}>
                    {sel.vi || sel.zh}
                  </h2>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--fg-4)" }}>
                    {sel.zh}
                  </span>
                  <span className="chip">{(WIKI_TYPE[sel.type] || WIKI_TYPE.other).label}</span>
                  {sel.status && sel.status !== "approved" && (
                    <span className="chip" style={{ color: "var(--fg-4)" }}>{sel.status}</span>
                  )}
                </div>

                <div style={{
                  display: "flex", gap: 16, marginTop: 10,
                  fontSize: 11, color: "var(--fg-5)", fontFamily: "var(--font-mono)",
                }}>
                  {sel.first_chapter != null && <span>Xuất hiện từ chương {sel.first_chapter}</span>}
                  <span>Tần suất ×{sel.freq}</span>
                </div>

                {(sel.aliases && sel.aliases.length > 0) && (
                  <div style={{ marginTop: 16 }}>
                    <div style={LBL}>Tên gọi khác</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                      {sel.aliases.map((a, i) => (
                        <span key={i} className="chip" style={{ fontFamily: "var(--font-mono)" }}>{a}</span>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ marginTop: 16 }}>
                  <div style={LBL}>Mô tả</div>
                  <p style={{ margin: "6px 0 0", fontSize: 14, lineHeight: 1.6, color: "var(--fg-2)" }}>
                    {sel.description
                      ? linkifyDesc(sel.description, entities, sel.zh, setSelZh)
                      : <span style={{ color: "var(--fg-4)" }}>Chưa có mô tả.</span>}
                  </p>
                </div>

                <div style={{ marginTop: 20 }}>
                  <div style={LBL}>
                    Quan hệ {sel.relationships ? `(${sel.relationships.length})` : ""}
                  </div>
                  {(!sel.relationships || sel.relationships.length === 0) ? (
                    <div style={{ fontSize: 12, color: "var(--fg-4)", marginTop: 6 }}>
                      Chưa ghi nhận quan hệ.
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                      {sel.relationships.map((r, i) => {
                        const otherZh = r.from_zh === sel.zh ? r.to_zh : r.from_zh;
                        const outgoing = r.from_zh === sel.zh;
                        return (
                          <div key={i} style={{
                            display: "flex", alignItems: "center", gap: 8,
                            fontSize: 13, padding: "6px 10px",
                            background: "var(--bg-surface)", border: "1px solid var(--border)",
                            borderRadius: 6,
                          }}>
                            <Icon name={outgoing ? "forward" : "back"} size={13} color="var(--fg-4)" />
                            {r.type && <span className="chip" style={{ fontSize: 10 }}>{r.type}</span>}
                            <span
                              onClick={() => setSelZh(otherZh)}
                              style={{ color: "var(--accent)", cursor: "pointer", fontWeight: 500 }}
                            >
                              {nameOf(otherZh)}
                            </span>
                            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-5)" }}>
                              {otherZh}
                            </span>
                            {r.description && (
                              <span style={{ color: "var(--fg-4)", fontSize: 12 }}>— {r.description}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { WikiScreen });
