// Kiểm tra tương phản chữ theo WCAG AA, dùng trực tiếp bảng màu của ứng dụng.
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../tokens.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const blocks = new Map([...css.matchAll(/(:root[^{}]*)\{([^{}]*)\}/g)].map(
  ([, selector, body]) => [
    selector.trim(),
    Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(
      ([, name, value]) => [name, value.trim()],
    )),
  ],
));

function luminance(tokens, name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`Token tham chiếu vòng: --${name}`);
  seen.add(name);
  const value = tokens[name];
  const alias = value?.match(/^var\(--([\w-]+)\)$/);
  if (alias) return luminance(tokens, alias[1], seen);
  if (!/^#[\da-f]{6}$/i.test(value)) {
    throw new Error(`Cần màu hex 6 chữ số cho --${name}: ${value}`);
  }
  const [r, g, b] = value.slice(1).match(/../g).map(hex => {
    const c = parseInt(hex, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function check(label, tokens, pairs) {
  let minimum = Infinity;
  for (const [fg, bg] of pairs) {
    const a = luminance(tokens, fg);
    const b = luminance(tokens, bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    minimum = Math.min(minimum, ratio);
    if (ratio < 4.5) {
      console.error(`${label}: --${fg} / --${bg} = ${ratio.toFixed(2)}:1 (< 4.5:1)`);
      process.exitCode = 1;
    }
  }
  console.log(`${label}: ${pairs.length} cặp, thấp nhất ${minimum.toFixed(2)}:1`);
}

function block(selector) {
  if (!blocks.has(selector)) throw new Error(`Thiếu bảng màu ${selector}`);
  return blocks.get(selector);
}

const surfaces = [
  "bg-app", "bg-surface", "bg-elevated", "bg-input", "bg-hover", "accent-bg", "accent-hover-bg",
];
const appPairs = ["fg-1", "fg-2", "fg-3", "fg-4", "fg-5", "accent"]
  .flatMap(fg => surfaces.map(bg => [fg, bg]));
appPairs.push(
  ["on-accent", "accent-fill"], ["on-accent", "accent-fill-hover"],
  ["success", "success-bg"], ["warn", "warn-bg"], ["danger", "danger-bg"],
  ["on-accent", "success-fill"], ["on-accent", "success-fill-hover"],
  ["on-accent", "danger-fill"], ["fg-image-label", "bg-image-label"],
  ...["success", "warn", "danger"].flatMap(fg => (
    ["bg-app", "bg-surface", "bg-elevated"].map(bg => [fg, bg])
  )),
);
for (const theme of ["dark", "light"]) {
  const selector = `:root[data-theme="${theme}"]`;
  const tokens = { ...block(":root"), ...block(selector) };
  check(theme, tokens, appPairs);
  for (const accent of ["emerald", "amber", "rose"]) {
    const accentSelector = `[data-accent="${accent}"]`;
    const accentTokens = block(":root" + accentSelector);
    const lightOverrides = theme === "light" ? block(selector + accentSelector) : {};
    check(`${theme}/${accent}`, { ...tokens, ...accentTokens, ...lightOverrides }, appPairs);
  }
}

for (const theme of ["light", "sepia", "dark"]) {
  const prefix = `reader-${theme}`;
  const pairs = ["fg", "muted", "accent"].map(role => [`${prefix}-${role}`, `${prefix}-bg`]);
  check(`Nền đọc ${theme}`, block(":root"), pairs);
}

// ── Cặp màu thực tế trong vùng đọc ───────────────────────────────────────────
// Nền đọc độc lập với theme app, nên chữ của phần tử nền trong suốt (StatusBlock, nút
// ghost/secondary) phải lấy màu nền đọc. Đọc màu chữ khai báo trong reader.css rồi kiểm
// mọi tổ hợp theme app × nền đọc: --rd-* → bảng màu nền đọc, --fg-* … → token của theme app.
const readerCss = readFileSync(new URL("../src/reader.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const READER_TEXT = [
  ["StatusBlock tiêu đề", ".rd-scroll .status-block-title"],
  ["StatusBlock mô tả", ".rd-scroll .status-block-message"],
  ["Nút ghost", ".rd-scroll .btn.ghost"],
  ["Nút ghost (hover)", ".rd-scroll .btn.ghost:hover:not(:disabled)"],
  ["Nút secondary", ".rd-scroll .btn.secondary"],
  ["Nút secondary (hover)", ".rd-scroll .btn.secondary:hover:not(:disabled)"],
  ["Ghi chú chương", ".rd-note"],
  ["Hết chương", ".rd-end-none"],
];
function readerColor(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = readerCss.match(new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^{}]*)\\}`, "m"));
  if (!m) throw new Error(`reader.css thiếu rule ${selector}`);
  const color = m[1].match(/(?:^|;)\s*color:\s*var\(--([\w-]+)\)/);
  if (!color) throw new Error(`reader.css: ${selector} cần color: var(--token)`);
  const bg = m[1].match(/(?:^|;)\s*background:\s*([^;]+)/);
  if (bg && bg[1].trim() !== "transparent") {
    throw new Error(`reader.css: ${selector} cần nền trong suốt (đang ${bg[1].trim()})`);
  }
  return color[1];
}
for (const theme of ["dark", "light"]) {
  const appTokens = { ...block(":root"), ...block(`:root[data-theme="${theme}"]`) };
  for (const bg of ["light", "sepia", "dark"]) {
    const tokens = { ...appTokens };
    const pairs = READER_TEXT.map(([label, selector]) => {
      const fg = readerColor(selector);
      const rd = fg.match(/^rd-(fg|muted|accent)$/);
      const name = rd ? `reader-${bg}-${rd[1]}` : fg;
      tokens[`__${label}`] = `var(--${name})`;
      return [`__${label}`, `reader-${bg}-bg`];
    });
    check(`App ${theme} × nền đọc ${bg}`, tokens, pairs);
  }
}
