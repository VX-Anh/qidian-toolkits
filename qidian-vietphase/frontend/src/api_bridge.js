// api_bridge.js — chạy trước app: bọc fetch để chuyển sang /login khi API trả 401.

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

