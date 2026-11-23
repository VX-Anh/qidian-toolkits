// api_bridge.js — empty initial globals; App.jsx populates from real API

// Server bật API_TOKEN mà chưa đăng nhập → mọi /api/* trả 401: chuyển sang /login.
(function () {
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const r = await origFetch(input, init);
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (r.status === 401 && url.startsWith("/api/") && location.pathname !== "/login") {
      location.href = "/login";
    }
    return r;
  };
})();

window.NOVELS   = [];
window.CHAPTERS = [];
window.GLOSSARY = { characters: [], places: [], realms: [], skills: [] };
window.AGENTS   = [];
window.NOVEL_MD_DEFAULT = '';
window.SOURCE_TEXT      = '';
window.TRANSLATED_TEXT  = '';
window.OCR_PAGES        = [];
