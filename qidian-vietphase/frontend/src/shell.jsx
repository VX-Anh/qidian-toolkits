// shell.jsx — LeftRail (novels list), TopBar, NewNovelModal

const { useState: useStateS, useEffect: useEffectS, useRef: useRefS } = React;

// ── Left Rail ─────────────────────────────────────────────────────────────
function LeftRail({ novels, currentSlug, onSelect, onNew, onOpenCmdk, serverOk, open, onClose }) {
  return (
    <>
    <div className={`rail-scrim ${open ? "open" : ""}`} onClick={onClose} />
    <aside className={`rail ${open ? "open" : ""}`}>
      <button className="icon-btn mobile-only rail-close" onClick={onClose} title="Đóng" aria-label="Đóng danh sách">
        <Icon name="cancel" size={15} />
      </button>
      <div className="rail-brand">
        <div className="brand-mark">A</div>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <span className="brand-name">AI-Translate</span>
          <span className="brand-sub">TaleStack · Trung → Việt</span>
        </div>
      </div>

      <div className="rail-section">
        <span>Truyện ({novels.length})</span>
        <button onClick={onNew} title="Thêm truyện">+</button>
      </div>

      <div className="rail-list">
        {novels.map(n => {
          const pct = n.total ? Math.round((n.done / n.total) * 100) : 0;
          return (
            <button
              type="button"
              key={n.slug}
              className={`rail-item ${currentSlug === n.slug ? "active" : ""}`}
              aria-current={currentSlug === n.slug ? "true" : undefined}
              onClick={() => onSelect(n.slug)}
              style={{ width: "calc(100% - 12px)", textAlign: "left" }}
            >
              <span className="ri-cover" style={{ fontFamily: "var(--font-mono)" }}>
                {n.cover_glyph}
              </span>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span className="ri-title">{n.vi_name}</span>
                <span style={{
                  fontSize: 10, color: "var(--fg-5)", fontFamily: "var(--font-mono)",
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  <span>{n.done}/{n.total}</span>
                  <span style={{ flex: 1, height: 2, background: "var(--bg-elevated)", borderRadius: 9999, overflow: "hidden" }}>
                    <span style={{ width: `${pct}%`, height: "100%", background: "var(--accent)" }} />
                  </span>
                  <span>{pct}%</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="rail-section" style={{ marginTop: "auto", borderTop: "1px solid var(--border)" }}>
        <span>Tiện ích</span>
      </div>
      <div style={{ padding: "4px 6px 8px" }}>
        <button type="button" className="rail-item" onClick={onOpenCmdk}
          style={{ fontSize: 12, width: "calc(100% - 12px)", textAlign: "left" }}>
          <Icon name="command" size={14} color="var(--fg-3)" />
          <span className="ri-title">Tìm & lệnh</span>
          <span className="kbd" aria-hidden="true">⌘K</span>
        </button>
      </div>

      <div className="rail-foot">
        <span className={`health-dot ${serverOk ? "" : "bad"}`} />
        <span style={{ flex: 1 }}>{serverOk ? "Server: ok" : "Mất kết nối"}</span>
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-5)" }}>v0.4.0</span>
      </div>
    </aside>
    </>
  );
}

// ── Top bar (breadcrumb + tabs + search + actions) ───────────────────────
const TAB_DEFS = [
  { id: "chapters", label: "Chương",     icon: "list" },
  { id: "glossary", label: "Thuật ngữ",  icon: "hash" },
  { id: "wiki",     label: "Story-Wiki", icon: "book" },
  { id: "output",   label: "Đọc",        icon: "bookOpen" },
  { id: "settings", label: "Cài đặt",    icon: "settings" },
];

function TopBar({
  novel, active, onTab, onOpenCmdk,
  showActivity, onToggleActivity, isRunning,
  tabCounts, onOpenRail, theme, onTheme,
}) {
  return (
    <div className="topbar">
      <button className="icon-btn mobile-only hamburger" onClick={onOpenRail} title="Mở danh sách truyện" aria-label="Mở danh sách truyện">
        <Icon name="list" size={16} />
      </button>
      <div className="crumb">
        <span style={{ color: "var(--fg-4)" }}>Workspace</span>
        <span className="crumb-sep">/</span>
        <b>{novel?.vi_name || "—"}</b>
        {novel && <span className="chip" style={{ marginLeft: 4 }}>{novel.genre}</span>}
      </div>

      <nav className="tabs">
        {TAB_DEFS.map(t => (
          <button
            key={t.id}
            className={`tab-btn ${active === t.id ? "active" : ""}`}
            aria-label={t.label}
            aria-current={active === t.id ? "page" : undefined}
            onClick={() => onTab(t.id)}
          >
            <Icon name={t.icon} size={14} />
            <span>{t.label}</span>
            {tabCounts?.[t.id] != null && <span className="count">{tabCounts[t.id]}</span>}
          </button>
        ))}
      </nav>

      <button className="search-pill" onClick={onOpenCmdk} aria-label="Tìm chương, thuật ngữ">
        <Icon name="search" size={13} />
        <span className="sp-text">Tìm chương, thuật ngữ…</span>
        <span className="kbd">⌘K</span>
      </button>

      <select className="input-field theme-select" aria-label="Giao diện sáng tối" title="Giao diện: Hệ thống / Sáng / Tối"
        value={theme} onChange={e => onTheme(e.target.value)}>
        <option value="system">Hệ thống</option>
        <option value="light">Sáng</option>
        <option value="dark">Tối</option>
      </select>

      <div className="desktop-only" style={{ display: "flex", gap: 4 }}>
        <IconBtn icon="activity" label="Hoạt động agent" active={showActivity} onClick={onToggleActivity}
          title={`${showActivity ? "Ẩn" : "Hiện"} bảng hoạt động${isRunning ? " (đang chạy)" : ""}`} />
      </div>
    </div>
  );
}

// ── New novel modal ──────────────────────────────────────────────────────
function NewNovelModal({ open, onClose, onCreate }) {
  const [slug, setSlug] = useStateS("");
  const [zh, setZh] = useStateS("");
  const [vi, setVi] = useStateS("");
  const [genre, setGenre] = useStateS("tiên hiệp");
  const [glyph, setGlyph] = useStateS("");

  function reset() { setSlug(""); setZh(""); setVi(""); setGenre("tiên hiệp"); setGlyph(""); }
  function submit() {
    if (!slug || !vi) return;
    onCreate({ slug, zh_name: zh, vi_name: vi, genre, cover_glyph: glyph || (zh[0] || "新"), done: 0, total: 0 });
    reset();
    onClose();
  }
  return (
    <Modal
      open={open}
      title="Tạo truyện mới"
      subtitle="Một thư mục rules/{slug}/novel.md sẽ được tạo."
      onClose={() => { reset(); onClose(); }}
      footer={<>
        <button className="btn ghost" onClick={() => { reset(); onClose(); }}>Hủy</button>
        <button className="btn primary" onClick={submit} disabled={!slug || !vi}>Tạo truyện</button>
      </>}
    >
      <div className="field">
        <label>Slug</label>
        <input className="input-field" placeholder="vd: thien-dien-quyet"
          value={slug} onChange={e => setSlug(e.target.value)} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Tên Trung</label>
          <input className="input-field" placeholder="vd: 天演诀"
            value={zh} onChange={e => setZh(e.target.value)} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Tên Việt</label>
          <input className="input-field" placeholder="vd: Thiên Diễn Quyết"
            value={vi} onChange={e => setVi(e.target.value)} />
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Thể loại</label>
          <select className="input-field" value={genre} onChange={e => setGenre(e.target.value)}>
            <option value="tiên hiệp">Tiên hiệp</option>
            <option value="võ hiệp">Võ hiệp</option>
            <option value="huyền huyễn">Huyền huyễn</option>
            <option value="đô thị">Đô thị</option>
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Ký tự bìa</label>
          <input className="input-field" placeholder="1 chữ Hán" maxLength={1}
            value={glyph} onChange={e => setGlyph(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

Object.assign(window, { LeftRail, TopBar, NewNovelModal });
