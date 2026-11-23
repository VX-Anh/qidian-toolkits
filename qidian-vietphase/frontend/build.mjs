// build.mjs — build frontend cho production (không cần khi dev).
//
// Dev:  index.html nạp React bản development + Babel standalone, Babel biên dịch
//       ~5k dòng JSX ngay trong trình duyệt mỗi lần tải trang (chậm trên điện thoại).
// Prod: script này biên dịch trước toàn bộ JSX thành dist/app.js (minify), dùng React
//       bản production tự host trong dist/vendor/, và sinh dist/index.html.
//       Backend tự phục vụ dist/index.html khi có và DEV_MODE tắt.
//
// Chạy:  node frontend/build.mjs      (cần Node ≥18 + npm; Dockerfile tự chạy)
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ESBUILD = "esbuild@0.24.0";
const REACT_VERSION = "18.3.1";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");

const html = readFileSync(join(here, "index.html"), "utf8");

// 1. Các file JSX theo đúng thứ tự trong index.html (thứ tự = phụ thuộc).
const babelSrcs = [...html.matchAll(/<script type="text\/babel"[^>]*src="\/static\/([^"]+)"[^>]*><\/script>/g)]
  .map(m => m[1]);
if (!babelSrcs.length) throw new Error("Không tìm thấy script text/babel nào trong index.html");

// Mỗi file từng chạy như một classic script riêng (chung global scope), nên ghép
// nối tiếp giữ nguyên ngữ nghĩa. Bọc từng file trong comment để dễ đọc source map.
const joined = babelSrcs
  .map(src => `/* ── ${src} ── */\n${readFileSync(join(here, src), "utf8")}`)
  .join("\n;\n");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "vendor"), { recursive: true });

// execSync với chuỗi lệnh cố định (không có input người dùng) — chạy được npx/npm
// trên cả Windows (.cmd) lẫn Linux.
const appJs = execSync(`npx --yes ${ESBUILD} --loader=jsx --minify --target=es2019 --charset=utf8`,
  { input: joined, maxBuffer: 64 * 1024 * 1024 }).toString();
writeFileSync(join(dist, "app.js"), appJs);

// 2. React production UMD, tự host (không phụ thuộc CDN khi chạy).
const tmp = mkdtempSync(join(tmpdir(), "vp-react-"));
try {
  execSync(`npm install --no-save --no-audit --no-fund --prefix "${tmp}" react@${REACT_VERSION} react-dom@${REACT_VERSION}`,
    { stdio: "inherit" });
  copyFileSync(join(tmp, "node_modules/react/umd/react.production.min.js"), join(dist, "vendor/react.production.min.js"));
  copyFileSync(join(tmp, "node_modules/react-dom/umd/react-dom.production.min.js"), join(dist, "vendor/react-dom.production.min.js"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// 3. dist/index.html: bỏ React dev + Babel + các script JSX + script auto-reload dev.
const ver = (f) => createHash("sha256").update(readFileSync(join(dist, f))).digest("hex").slice(0, 10);
let out = html
  .replace(/\s*<script src="https:\/\/unpkg\.com\/react@[^"]+"[^>]*><\/script>/, "")
  .replace(/\s*<script src="https:\/\/unpkg\.com\/react-dom@[^"]+"[^>]*><\/script>/, "")
  .replace(/\s*<script src="https:\/\/unpkg\.com\/@babel\/standalone@[^"]+"[^>]*><\/script>/, "")
  .replace(/\s*<!-- Design system components[^>]*-->/, "")
  .replace(/\s*<script type="text\/babel"[^>]*><\/script>/g, "")
  .replace(/\s*<script>\s*\/\/ Dev auto-reload[\s\S]*?<\/script>/, "");
if (/unpkg\.com|text\/babel|_dev\/ping/.test(out)) {
  throw new Error("dist/index.html còn sót script dev — kiểm tra lại index.html");
}
const vendor = [
  `<script src="/static/dist/vendor/react.production.min.js?v=${ver("vendor/react.production.min.js")}"></script>`,
  `<script src="/static/dist/vendor/react-dom.production.min.js?v=${ver("vendor/react-dom.production.min.js")}"></script>`,
].join("\n  ");
out = out
  .replace('<div id="root"></div>', `<div id="root"></div>\n\n  ${vendor}`)
  .replace("</body>", `  <script src="/static/dist/app.js?v=${ver("app.js")}"></script>\n</body>`);
writeFileSync(join(dist, "index.html"), out);

console.log(`Build xong: dist/app.js (${(appJs.length / 1024).toFixed(0)} KB, ${babelSrcs.length} file JSX)`);
