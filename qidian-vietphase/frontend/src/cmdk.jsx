// cmdk.jsx — command palette overlay

const { useState: useStateK, useEffect: useEffectK, useRef: useRefK, useMemo: useMemoK } = React;

function CommandPalette({ open, onClose, novels, chapters, glossary, onAction }) {
  const [q, setQ] = useStateK("");
  const [sel, setSel] = useStateK(0);
  const inputRef = useRefK(null);

  useEffectK(() => {
    if (open) {
      setQ(""); setSel(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const items = useMemoK(() => {
    const Q = q.toLowerCase().trim();
    const out = [];

    // Actions
    const actions = [
      { id: "translate-all",   group: "Hành động", icon: "play",     label: "Dịch tất cả chương đang chờ" },
      { id: "extract-terms",   group: "Hành động", icon: "sparkles", label: "Trích xuất thuật ngữ mới" },
      { id: "new-novel",       group: "Hành động", icon: "plus",     label: "Tạo truyện mới…" },
      { id: "toggle-activity", group: "Hành động", icon: "activity", label: "Bật/tắt bảng hoạt động agent" },
      { id: "go-chapters",     group: "Điều hướng", icon: "list",    label: "Đi đến Chương",        sub: "G C" },
      { id: "go-glossary",     group: "Điều hướng", icon: "hash",    label: "Đi đến Thuật ngữ",     sub: "G T" },
      { id: "go-wiki",         group: "Điều hướng", icon: "book",    label: "Đi đến Story-Wiki",    sub: "G W" },
      { id: "go-output",       group: "Điều hướng", icon: "bookOpen",label: "Đi đến Bản dịch",      sub: "G B" },
      { id: "go-settings",     group: "Điều hướng", icon: "settings",label: "Đi đến Cài đặt",       sub: "G S" },
    ].filter(a => !Q || a.label.toLowerCase().includes(Q));
    out.push(...actions);

    // Novels
    novels.forEach(n => {
      const hay = `${n.vi_name} ${n.zh_name} ${n.slug}`.toLowerCase();
      if (!Q || hay.includes(Q)) {
        out.push({
          id: `novel:${n.slug}`, group: "Truyện", icon: "book",
          label: n.vi_name, sub: n.zh_name,
        });
      }
    });

    // Chapters (top 5)
    let chCount = 0;
    chapters.forEach(c => {
      if (chCount >= 5) return;
      const hay = `${c.zh_title} ${c.vi_title} ${c.chapter_num}`.toLowerCase();
      if (Q && hay.includes(Q)) {
        out.push({
          id: `chapter:${c.filename}`, group: "Chương", icon: "bookOpen",
          label: c.vi_title || c.zh_title,
          sub: `#${String(c.chapter_num).padStart(4, "0")}`,
        });
        chCount++;
      }
    });

    // Glossary
    if (Q) {
      let gCount = 0;
      Object.entries(glossary).forEach(([cat, list]) => {
        list.forEach(g => {
          if (gCount >= 6) return;
          if ((g.zh || "").includes(q) || (g.vi || "").toLowerCase().includes(Q)) {
            out.push({
              id: `gloss:${cat}:${g.zh}`, group: "Thuật ngữ", icon: "hash",
              label: `${g.zh} → ${g.vi}`, sub: g.notes?.slice(0, 40),
            });
            gCount++;
          }
        });
      });
    }

    return out;
  }, [q, novels, chapters, glossary]);

  useEffectK(() => { setSel(0); }, [q]);

  useEffectK(() => {
    if (!open) return;
    const h = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => Math.min(items.length - 1, s + 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = items[sel];
        if (item) { onAction(item); onClose(); }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, items, sel, onAction, onClose]);

  if (!open) return null;

  // Group items
  const groups = [];
  let lastGroup = null;
  items.forEach((it, idx) => {
    if (it.group !== lastGroup) {
      groups.push({ name: it.group, items: [] });
      lastGroup = it.group;
    }
    groups[groups.length - 1].items.push({ ...it, idx });
  });

  return (
    <div className="cmdk-scrim" onClick={onClose}>
      <div className="cmdk" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Tìm chương, thuật ngữ, hoặc lệnh…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <div className="cmdk-list">
          {groups.length === 0 && (
            <div style={{ padding: 32, textAlign: "center", color: "var(--fg-4)", fontSize: 13 }}>
              Không có kết quả nào.
            </div>
          )}
          {groups.map((g, gi) => (
            <React.Fragment key={gi}>
              <div className="cmdk-group">{g.name}</div>
              {g.items.map((it) => (
                <div
                  key={it.id}
                  className={`cmdk-item ${it.idx === sel ? "sel" : ""}`}
                  onMouseEnter={() => setSel(it.idx)}
                  onClick={() => { onAction(it); onClose(); }}
                >
                  <span className="ico"><Icon name={it.icon} size={14} /></span>
                  <span className="lbl">{it.label}</span>
                  {it.sub && <span className="sub">{it.sub}</span>}
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
        <div style={{
          padding: "8px 14px", borderTop: "1px solid var(--border)",
          display: "flex", gap: 12, fontSize: 10, color: "var(--fg-5)",
          background: "var(--bg-app)",
        }}>
          <span><span className="kbd">↑↓</span> chọn</span>
          <span><span className="kbd">↵</span> thực thi</span>
          <span><span className="kbd">esc</span> đóng</span>
          <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)" }}>{items.length} kết quả</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { CommandPalette });
