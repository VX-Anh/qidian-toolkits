function extractChapter() {
  const title = document.title.replace(/ _.*$/, "").trim();

  const SELECTORS = [
    "main[data-type='cjk']",
    "#j_chapterContent",
    ".read-content",
    ".chapter-content",
    "main.content",
  ];

  let text = "";
  for (const sel of SELECTORS) {
    const el = document.querySelector(sel);
    if (el) {
      const candidate = el.innerText.trim();
      if (candidate.length > text.length) {
        text = candidate;
      }
    }
  }

  return { title, text, chars: text.length };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "extract") {
    sendResponse(extractChapter());
  }
});
