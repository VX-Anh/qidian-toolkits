// components.jsx — primitives shared across screens

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ── Icon — wraps Lucide outline icons via inline SVG. Stroke 1.5, square caps.
function Icon({ name, size = 16, color = "currentColor", className = "" }) {
  const paths = ICONS[name];
  if (!paths) return null;
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}
    >
      {paths.map((d, i) => (
        d.startsWith("c:")
          ? <circle key={i} cx={d.split(",")[1]} cy={d.split(",")[2]} r={d.split(",")[3]} />
          : d.startsWith("r:")
          ? <rect key={i} x={d.split(",")[1]} y={d.split(",")[2]} width={d.split(",")[3]} height={d.split(",")[4]} rx={d.split(",")[5] || 0} />
          : d.startsWith("l:")
          ? <line key={i} x1={d.split(",")[1]} y1={d.split(",")[2]} x2={d.split(",")[3]} y2={d.split(",")[4]} />
          : <path key={i} d={d} />
      ))}
    </svg>
  );
}

// Inline lucide-style icon paths (1.5px stroke, ~24×24, simple geometry).
const ICONS = {
  search:   ["c:,11,11,7", "M21 21l-4.3-4.3"],
  sparkles: ["M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1"],
  play:     ["M6 4l14 8L6 20z"],
  pause:    ["r:,6,4,4,16,1", "r:,14,4,4,16,1"],
  cancel:   ["c:,12,12,9", "l:,8,8,16,16"],
  check:    ["M5 12l5 5L20 7"],
  cross:    ["M6 6l12 12 M18 6L6 18"],
  upload:   ["M12 16V4 M5 11l7-7 7 7 M4 20h16"],
  download: ["M12 4v12 M5 13l7 7 7-7 M4 20h16"],
  copy:     ["r:,9,3,12,12,2", "M5 15V5a2 2 0 0 1 2-2h10"],
  save:     ["M5 4h11l3 3v13H5z", "M8 4v6h8V4 M8 20v-6h8v6"],
  plus:     ["M12 5v14 M5 12h14"],
  filter:   ["M3 5h18 M6 12h12 M10 19h4"],
  list:     ["M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01"],
  book:     ["M4 4h14a2 2 0 0 1 2 2v13a1 1 0 0 1-1.4.9L13 17.5 7.4 19.9A1 1 0 0 1 6 19V6a2 2 0 0 1 2-2"],
  bookOpen: ["M3 5a2 2 0 0 1 2-2h5v17H5a2 2 0 0 1-2-2z M21 5a2 2 0 0 0-2-2h-5v17h5a2 2 0 0 0 2-2z"],
  settings: ["c:,12,12,3", "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"],
  activity: ["M22 12h-4l-3 9L9 3l-3 9H2"],
  alert:    ["M12 9v4 M12 17h.01", "M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"],
  back:     ["M19 12H5 M12 19l-7-7 7-7"],
  forward:  ["M5 12h14 M12 5l7 7-7 7"],
  prev:     ["M15 18l-6-6 6-6"],
  next:     ["M9 6l6 6-6 6"],
  more:     ["c:,12,5,1", "c:,12,12,1", "c:,12,19,1"],
  hash:     ["M4 9h16 M4 15h16 M10 3 8 21 M16 3l-2 18"],
  edit:     ["M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7", "M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"],
  user:     ["c:,12,7,4", "M4 21v-1a7 7 0 0 1 14 0v1"],
  map:      ["M9 3 3 6v15l6-3 6 3 6-3V3l-6 3z", "l:,9,3,9,18", "l:,15,6,15,21"],
  zap:      ["M13 2 3 14h7l-1 8 10-12h-7z"],
  layers:   ["m12 3 8 5-8 5-8-5z M4 13l8 5 8-5 M4 18l8 5 8-5"],
  command:  ["M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"],
  refresh:  ["M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15 6.7L3 16 M3 21v-5h5"],
  panel:    ["r:,3,3,18,18,2", "l:,15,3,15,21"],
  arrowDown:["M12 5v14 M5 12l7 7 7-7"],
  arrowUp:  ["M12 19V5 M5 12l7-7 7 7"],
  chevron:  ["M6 9l6 6 6-6"],
};

// ── Status badge
function Badge({ status, label }) {
  const map = {
    pending:     "Chờ",
    queued:      "Trong hàng",
    in_progress: "Đang dịch",
    done:        "Xong",
    failed:      "Lỗi",
    review:      "Cần xem",
  };
  const ico = {
    pending: null,
    queued: "·",
    in_progress: <span className="spin" style={{ marginRight: 2 }}>⟳</span>,
    done: "✓",
    failed: "✗",
    review: "!",
  }[status];
  return (
    <span className={`badge ${status}`}>
      {ico && <span style={{ marginRight: 2 }}>{ico}</span>}
      {label || map[status] || status}
    </span>
  );
}

// ── Modal
function Modal({ open, title, subtitle, children, footer, onClose, width = 460 }) {
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" style={{ width }} onClick={e => e.stopPropagation()}>
        <div className="modal-h">
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

// ── Toast
function Toast({ message, type = "info", onDone }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => onDone(), 2400);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  return (
    <div className={`toast ${type}`}>
      <span className="toast-ico">{type === "success" ? "✓" : type === "error" ? "✗" : "·"}</span>
      <span>{message}</span>
    </div>
  );
}

// ── IconBtn — square icon button used in toolbars
function IconBtn({ icon, label, active, onClick, title }) {
  return (
    <button
      className={`icon-btn ${active ? "active" : ""}`}
      onClick={onClick}
      title={title || label}
      aria-label={title || label}
    >
      <Icon name={icon} size={16} />
    </button>
  );
}

// ── OCR progress bar — determinate (page/total) or indeterminate (no total)
function OcrProgress({ page = 0, total = 0, width = 150 }) {
  const has = total > 0;
  const pct = has ? Math.min(100, Math.round((page / total) * 100)) : 0;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ width, height: 4, background: "var(--bg-elevated)", borderRadius: 9999, overflow: "hidden", display: "inline-block", position: "relative" }}>
        <span
          className={has ? "" : "ocr-indeterminate"}
          style={has
            ? { display: "block", width: `${pct}%`, height: "100%", background: "var(--accent)", transition: "width 0.3s var(--ease)" }
            : { display: "block", width: "40%", height: "100%", background: "var(--accent)" }}
        />
      </span>
      <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--accent)", whiteSpace: "nowrap" }}>
        {has ? `Trang ${page}/${total} · ${pct}%` : "đang xử lý…"}
      </span>
    </span>
  );
}

Object.assign(window, { Icon, Badge, Modal, Toast, IconBtn, OcrProgress });
