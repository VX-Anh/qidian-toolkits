// settings.jsx — novel.md structured editor

const { useState: useStateSt } = React;

function SettingsScreen({ novel, novelMd, onChange, onSave }) {
  const [tab, setTab] = useStateSt("config"); // config | raw

  if (!novel) {
    return <div className="empty-state">Chọn một truyện để chỉnh sửa cài đặt.</div>;
  }

  return (
    <div className="settings-layout">
      <div className="settings-main">
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: 4,
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{novel.vi_name}</h2>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--fg-4)", fontFamily: "var(--font-mono)" }}>
              rules/{novel.slug}/novel.md
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <SegControl
              value={tab}
              onChange={setTab}
              options={[
                { v: "config", lbl: "Cấu hình", icon: "settings" },
                { v: "raw",    lbl: "Markdown", icon: "edit" },
              ]}
            />
            <button className="btn success sm" onClick={onSave}>
              <Icon name="save" size={12} /> Lưu thay đổi
            </button>
          </div>
        </div>

        {tab === "config" ? (
          <>
            <div className="settings-card">
              <div className="settings-card-h">
                <span className="label">Hồ sơ truyện</span>
              </div>
              <div className="settings-card-body">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div className="field">
                    <label>Tên Trung</label>
                    <input className="input-field" defaultValue={novel.zh_name} readOnly />
                  </div>
                  <div className="field">
                    <label>Tên Việt</label>
                    <input className="input-field" defaultValue={novel.vi_name} readOnly />
                  </div>
                  <div className="field">
                    <label>Thể loại</label>
                    <select className="input-field" defaultValue={novel.genre}>
                      <option value="tiên hiệp">Tiên hiệp</option>
                      <option value="võ hiệp">Võ hiệp</option>
                      <option value="huyền huyễn">Huyền huyễn</option>
                      <option value="đô thị">Đô thị</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Trạng thái</label>
                    <select className="input-field" defaultValue="đang dịch">
                      <option>đang dịch</option>
                      <option>tạm dừng</option>
                      <option>hoàn thành</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>

            <div className="settings-card">
              <div className="settings-card-h">
                <span className="label">Prompt dịch (system prompt cho TranslatorAgent)</span>
              </div>
              <div className="settings-card-body">
                <div className="field" style={{ marginBottom: 0 }}>
                  <textarea
                    defaultValue={`Bạn là dịch giả tiểu thuyết tiên hiệp Trung-Việt chuyên nghiệp.
Dịch sang tiếng Việt tự nhiên, trang trọng, ưu tiên từ Hán Việt cho thuật ngữ tu luyện.
Giữ nguyên cấu trúc đoạn văn gốc. Không thêm bình luận hay giải thích ngoài bản dịch.
Tên riêng phải dịch đúng theo bảng thuật ngữ.`}
                    style={{ minHeight: 140 }}
                    readOnly
                  />
                </div>
              </div>
            </div>

            <div className="settings-card">
              <div className="settings-card-h">
                <span className="label">Pipeline</span>
              </div>
              <div className="settings-card-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Model</label>
                  <select className="input-field" defaultValue="gpt-4o-mini">
                    <option>gpt-4o</option>
                    <option>gpt-4o-mini</option>
                    <option>claude-haiku-4-5</option>
                    <option>claude-sonnet-4-5</option>
                  </select>
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Concurrency</label>
                  <input className="input-field" type="number" defaultValue={3} min={1} max={10} />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Chunk size (chars)</label>
                  <input className="input-field" type="number" defaultValue={1200} step={100} />
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="settings-card" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <div className="settings-card-h">
              <span className="label">novel.md</span>
              <span style={{ fontSize: 10, color: "var(--fg-5)", fontFamily: "var(--font-mono)" }}>
                YAML frontmatter + Markdown
              </span>
            </div>
            <textarea
              value={novelMd}
              onChange={e => onChange(e.target.value)}
              style={{
                flex: 1, minHeight: 480, resize: "vertical",
                background: "var(--bg-elevated)",
                border: 0, borderTop: "1px solid var(--border)",
                borderRadius: 0,
                padding: 16,
                fontFamily: "var(--font-mono)", fontSize: 12,
                color: "var(--fg-2)", outline: "none",
                lineHeight: 1.6,
              }}
            />
          </div>
        )}
      </div>

      <aside className="settings-side">
        <div className="label">Thống kê truyện</div>
        <div className="kv">
          <span className="k">Tiến độ</span>
          <span className="v" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>{novel.done} / {novel.total}</span>
            <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
              ({Math.round((novel.done / Math.max(novel.total, 1)) * 100)}%)
            </span>
          </span>
        </div>
        <div className="kv">
          <span className="k">Slug</span>
          <span className="v" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{novel.slug}</span>
        </div>

        <div className="label" style={{ marginTop: 8 }}>Hành động</div>
        <button className="btn sm" style={{ justifyContent: "center" }} onClick={onSave}>
          <Icon name="save" size={12} /> Lưu novel.md
        </button>
      </aside>
    </div>
  );
}

Object.assign(window, { SettingsScreen });
