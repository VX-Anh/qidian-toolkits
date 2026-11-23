// settings.jsx — novel.md structured editor

const { useState: useStateSt } = React;

// ── novel.md parse/serialize helpers ──────────────────────────────────
function stGetFm(md, key) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return "";
  const line = m[1].split("\n").find(l => l.startsWith(key + ":"));
  if (!line) return "";
  return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
}

function stSetFm(md, key, value) {
  const m = md.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!m) return md;
  const lines = m[2].split("\n");
  let found = false;
  const next = lines.map(l => {
    if (l.startsWith(key + ":")) { found = true; return `${key}: ${value}`; }
    return l;
  });
  if (!found) next.push(`${key}: ${value}`);
  return m[1] + next.join("\n") + m[3] + md.slice(m[0].length);
}

function stGetPrompt(md) {
  const m = md.match(/## Prompt dịch\s*\n([\s\S]*?)(?=\n## |$)/);
  return m ? m[1].trim() : "";
}

function stSetPrompt(md, value) {
  const re = /(## Prompt dịch\s*\n)([\s\S]*?)(?=\n## |$)/;
  if (!re.test(md)) return md;
  return md.replace(re, `$1\n${value}\n`);
}

function SettingsScreen({ novel, novelMd, mdStatus = "ready", onReloadMd, onChange, onSave }) {
  const [tab, setTab] = useStateSt("config"); // config | raw

  if (!novel) {
    return (
      <div className="empty-state">
        <StatusBlock kind="empty" title="Chọn một truyện để chỉnh sửa cài đặt" />
      </div>
    );
  }
  // Chưa có novel.md của truyện này: không hiện form (tránh sửa trên bản rỗng).
  const mdReady = mdStatus === "ready";

  return (
    <div className="settings-layout">
      <div className="settings-main">
        <div className="settings-head" style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          flexWrap: "wrap", gap: 8, marginBottom: 4,
        }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, overflowWrap: "anywhere" }}>{novel.vi_name}</h2>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--fg-4)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
              rules/{novel.slug}/novel.md
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <SegControl
              value={tab}
              onChange={setTab}
              options={[
                { v: "config", lbl: "Cấu hình", icon: "settings" },
                { v: "raw",    lbl: "Markdown", icon: "edit" },
              ]}
            />
            <button className="btn success sm" onClick={onSave} disabled={!mdReady}>
              <Icon name="save" size={12} /> Lưu thay đổi
            </button>
          </div>
        </div>

        {!mdReady ? (
          <div className="settings-card">
            {mdStatus === "error" ? (
              <StatusBlock
                kind="error"
                title="Không tải được novel.md"
                desc={typeof navigator !== "undefined" && navigator.onLine === false
                  ? "Mất kết nối mạng. Kiểm tra mạng rồi thử lại."
                  : "Máy chủ không trả về file cấu hình của truyện này."}
                actions={onReloadMd && (
                  <button className="btn sm" onClick={onReloadMd}><Icon name="refresh" size={12} /> Thử lại</button>
                )}
              />
            ) : (
              <StatusBlock kind="loading" title="Đang tải novel.md…" />
            )}
          </div>
        ) : tab === "config" ? (
          <>
            <div className="settings-card">
              <div className="settings-card-h">
                <span className="label">Hồ sơ truyện</span>
              </div>
              <div className="settings-card-body">
                <div className="settings-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))", gap: 14 }}>
                  <div className="field">
                    <label htmlFor="st-zh">Tên Trung</label>
                    <input id="st-zh" className="input-field" defaultValue={novel.zh_name} readOnly />
                  </div>
                  <div className="field">
                    <label htmlFor="st-vi">Tên Việt</label>
                    <input id="st-vi" className="input-field" defaultValue={novel.vi_name} readOnly />
                  </div>
                  <div className="field">
                    <label htmlFor="st-genre">Thể loại</label>
                    <select
                      id="st-genre"
                      className="input-field"
                      value={stGetFm(novelMd, "genre") || novel.genre || "tiên hiệp"}
                      onChange={e => onChange(stSetFm(novelMd, "genre", e.target.value))}
                    >
                      <option value="tiên hiệp">Tiên hiệp</option>
                      <option value="võ hiệp">Võ hiệp</option>
                      <option value="huyền huyễn">Huyền huyễn</option>
                      <option value="đô thị">Đô thị</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="st-status">Trạng thái</label>
                    <select
                      id="st-status"
                      className="input-field"
                      value={stGetFm(novelMd, "status") || "đang dịch"}
                      onChange={e => onChange(stSetFm(novelMd, "status", e.target.value))}
                    >
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
                    aria-label="Prompt dịch"
                    value={stGetPrompt(novelMd)}
                    onChange={e => onChange(stSetPrompt(novelMd, e.target.value))}
                    style={{ minHeight: 140 }}
                  />
                </div>
              </div>
            </div>

            <div className="settings-card">
              <div className="settings-card-h">
                <span className="label">Pipeline</span>
              </div>
              <div className="settings-card-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))", gap: 14 }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label id="st-model-lbl">Model</label>
                  {/* Model chọn trên server (MODEL_TRANSLATE / MODEL_LIGHT / MODEL_VISION trong .env) */}
                  <div className="input-field" aria-labelledby="st-model-lbl" style={{ color: "var(--fg-3)" }} title="Đổi trong .env của server">
                    Claude · Sonnet dịch, Haiku việc phụ
                  </div>
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="st-conc">Concurrency</label>
                  <input id="st-conc" className="input-field" type="number" defaultValue={3} min={1} max={10} />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="st-chunk">Chunk size (chars)</label>
                  <input id="st-chunk" className="input-field" type="number" defaultValue={1200} step={100} />
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="settings-card" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <div className="settings-card-h">
              <span className="label">novel.md</span>
              <span style={{ fontSize: 10, color: "var(--fg-4)", fontFamily: "var(--font-mono)" }}>
                YAML frontmatter + Markdown
              </span>
            </div>
            <textarea
              className="settings-raw"
              aria-label="Nội dung novel.md"
              spellCheck={false}
              value={novelMd}
              onChange={e => onChange(e.target.value)}
              style={{
                flex: 1, minHeight: 480, resize: "vertical",
                background: "var(--bg-elevated)",
                border: 0, borderTop: "1px solid var(--border)",
                borderRadius: 0,
                padding: 16,
                fontFamily: "var(--font-mono)", fontSize: 12,
                color: "var(--fg-2)",
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
        <button className="btn sm" style={{ justifyContent: "center" }} onClick={onSave} disabled={!mdReady}>
          <Icon name="save" size={12} /> Lưu novel.md
        </button>
      </aside>
    </div>
  );
}

Object.assign(window, { SettingsScreen });
