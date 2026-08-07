(() => {
  if (window.__techBharatSummarizerLoaded) return;
  window.__techBharatSummarizerLoaded = true;

  let activeSessionId = "";
  let currentMarkdown = "";
  let followUpMarkdown = "";
  let host;
  let shadow;
  let els = {};

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "BEGIN_CAPTURE") {
      beginCapture(message.mode);
      return false;
    }

    if (message.type === "SUMMARY_STARTED") {
      activeSessionId = message.sessionId;
      currentMarkdown = "";
      setLoading("Reading the captured context...");
      return false;
    }

    if (message.type === "SUMMARY_DELTA") {
      activeSessionId = message.sessionId;
      currentMarkdown += message.delta;
      renderMarkdown(currentMarkdown);
      setLoading("Streaming summary...");
      return false;
    }

    if (message.type === "SUMMARY_REPLACE") {
      activeSessionId = message.sessionId;
      currentMarkdown = message.markdown || "";
      renderMarkdown(currentMarkdown);
      return false;
    }

    if (message.type === "SUMMARY_DONE") {
      activeSessionId = message.sessionId;
      currentMarkdown = message.markdown || currentMarkdown;
      renderMarkdown(currentMarkdown);
      setReady();
      return false;
    }

    if (message.type === "SUMMARY_ERROR") {
      activeSessionId = message.sessionId || activeSessionId;
      showError(message.error);
      return false;
    }

    if (message.type === "FOLLOWUP_STARTED") {
      followUpMarkdown = "";
      els.answer.textContent = "Thinking...";
      return false;
    }

    if (message.type === "FOLLOWUP_DELTA") {
      followUpMarkdown += message.delta;
      els.answer.textContent = stripInlineMarkdown(followUpMarkdown);
      return false;
    }

    if (message.type === "FOLLOWUP_DONE") {
      followUpMarkdown = message.markdown || followUpMarkdown;
      els.answer.textContent = stripInlineMarkdown(followUpMarkdown);
      return false;
    }

    if (message.type === "FOLLOWUP_ERROR") {
      els.answer.textContent = message.error;
      return false;
    }

    return false;
  });

  async function beginCapture(mode) {
    ensurePanel();
    resetPanel();
    setLoading(mode === "region" ? "Draw a region on the page..." : "Capturing page content...");

    if (mode === "region") {
      const region = await chooseRegion();
      if (!region) {
        showError("Region capture was cancelled.");
        return;
      }
      const capture = buildCapture("region", region);
      chrome.runtime.sendMessage({ type: "CAPTURE_READY", payload: capture });
      return;
    }

    const capture = buildCapture(mode);
    chrome.runtime.sendMessage({ type: "CAPTURE_READY", payload: capture });
  }

  function buildCapture(mode, region = null) {
    const extractionNotes = [];
    let text = "";

    if (mode === "selection") {
      text = getSelectionText();
      if (!text.trim()) {
        extractionNotes.push("No text selection was found, so the whole page was captured instead.");
        text = extractVisibleText(document, null, extractionNotes);
      }
    } else {
      text = [
        extractPriorityText(document, region, extractionNotes),
        extractVisibleText(document, region, extractionNotes)
      ].filter(Boolean).join("\n\n");
    }

    if (mode === "page") {
      const iframeText = collectSameOriginIframeText(extractionNotes);
      if (iframeText) text += `\n\n${iframeText}`;
    }

    return {
      mode,
      title: document.title,
      url: location.href,
      text: normalizeCapturedText(text).slice(0, captureBudgetFor(location.hostname)),
      region,
      extractionNotes
    };
  }

  function getSelectionText() {
    const selected = window.getSelection()?.toString() || "";
    if (selected.trim()) return selected;

    const active = document.activeElement;
    if (active && ["TEXTAREA", "INPUT"].includes(active.tagName)) {
      return active.value.slice(active.selectionStart || 0, active.selectionEnd || 0);
    }
    return "";
  }

  function extractPriorityText(doc, region, notes) {
    const hostname = location.hostname;
    const parts = [
      `Page title: ${doc.title || ""}`,
      metaContent("description"),
      metaContent("og:title"),
      metaContent("og:description")
    ];

    if (/github\.com$/i.test(hostname)) {
      parts.push(extractGithubText(doc));
      notes.push("Used GitHub-aware extraction to prioritize pull request title, description, comments, and code/diff text.");
    } else if (/(thehindu\.com|eenadu\.net)$/i.test(hostname)) {
      parts.push(extractNewsText(doc, region));
      notes.push("Used news-aware extraction to prioritize article, headline, and main content text.");
    }

    return normalizeCapturedText(parts.filter(Boolean).join("\n"));
  }

  function metaContent(name) {
    const selector = `meta[name="${name}"], meta[property="${name}"]`;
    return document.querySelector(selector)?.content || "";
  }

  function extractGithubText(doc) {
    const selectors = [
      ".js-issue-title",
      ".gh-header-title",
      ".gh-header-meta",
      ".timeline-comment .comment-body",
      ".js-comment-body",
      ".markdown-body",
      ".file-info",
      ".blob-code",
      "table.diff-table"
    ];
    return textFromSelectors(doc, selectors, 28000);
  }

  function extractNewsText(doc, region) {
    const selectors = [
      "main",
      "article",
      "[role='main']",
      "h1",
      "h2",
      "h3",
      ".title",
      ".headline",
      ".story-card",
      ".lead",
      ".articlebodycontent",
      ".article-section",
      ".section-container"
    ];
    return textFromSelectors(doc, selectors, 22000, region);
  }

  function textFromSelectors(doc, selectors, budget, region = null) {
    const chunks = [];
    let captured = 0;
    const seenElements = new Set();

    for (const selector of selectors) {
      for (const element of doc.querySelectorAll(selector)) {
        if (seenElements.has(element) || shouldSkip(element) || !isVisible(element)) continue;
        if (region && !nodeIntersectsRegion(element, region)) continue;
        seenElements.add(element);
        const value = normalizeText(element.innerText || element.textContent || "");
        if (!value) continue;
        chunks.push(value);
        captured += value.length;
        if (captured >= budget) return chunks.join("\n");
      }
    }

    return chunks.join("\n");
  }

  function extractVisibleText(doc, region, notes) {
    const pieces = [];
    const budget = captureBudgetFor(location.hostname) + 8000;
    let capturedChars = 0;
    const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const value = normalizeText(node.nodeValue || "");
        if (!value || value.length < 2) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || shouldSkip(parent)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
        if (region && !nodeIntersectsRegion(parent, region)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) {
      const value = walker.currentNode.nodeValue || "";
      pieces.push(value);
      capturedChars += value.length;
      if (capturedChars > budget) {
        notes.push("The page is longer than the fast capture budget; later text was omitted after prioritizing visible readable content.");
        break;
      }
    }

    return pieces.join("\n");
  }

  function collectSameOriginIframeText(notes) {
    const chunks = [];
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument?.body) {
          const text = extractVisibleText(frame.contentDocument, null, notes);
          if (text.trim()) chunks.push(`Iframe: ${frame.title || frame.src || "embedded frame"}\n${text}`);
        }
      } catch {
        notes.push(`An iframe could not be read because browser security blocked access: ${frame.src || "unknown source"}.`);
      }
    }
    return chunks.join("\n\n");
  }

  function shouldSkip(element) {
    return Boolean(element.closest("script, style, noscript, svg, canvas, video, audio, [aria-hidden='true'], #techbharat-summarizer-host"));
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function nodeIntersectsRegion(element, region) {
    const rect = element.getBoundingClientRect();
    return rect.right >= region.left &&
      rect.left <= region.left + region.width &&
      rect.bottom >= region.top &&
      rect.top <= region.top + region.height;
  }

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function normalizeCapturedText(text) {
    const seen = new Map();
    const lines = text
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter((line) => line.length > 1);

    const cleaned = [];
    for (const line of lines) {
      const key = line.toLowerCase();
      const count = seen.get(key) || 0;
      if (count >= 1 && line.length > 18) continue;
      if (count >= 2) continue;
      seen.set(key, count + 1);
      cleaned.push(line);
    }

    return cleaned.join("\n");
  }

  function captureBudgetFor(hostname) {
    if (/github\.com$/i.test(hostname)) return 32000;
    if (/(thehindu\.com|eenadu\.net)$/i.test(hostname)) return 26000;
    return 45000;
  }

  function chooseRegion() {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.id = "techbharat-region-overlay";
      overlay.innerHTML = "<div class='tb-region-help'>Drag over the area to summarize. Press Esc to cancel.</div><div class='tb-region-box'></div>";
      document.documentElement.appendChild(overlay);

      const box = overlay.querySelector(".tb-region-box");
      let startX = 0;
      let startY = 0;
      let dragging = false;

      const cleanup = (result) => {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
        resolve(result);
      };

      const onKey = (event) => {
        if (event.key === "Escape") cleanup(null);
      };

      overlay.addEventListener("pointerdown", (event) => {
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        overlay.setPointerCapture(event.pointerId);
      });

      overlay.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        const left = Math.min(startX, event.clientX);
        const top = Math.min(startY, event.clientY);
        const width = Math.abs(event.clientX - startX);
        const height = Math.abs(event.clientY - startY);
        Object.assign(box.style, {
          left: `${left}px`,
          top: `${top}px`,
          width: `${width}px`,
          height: `${height}px`
        });
      });

      overlay.addEventListener("pointerup", (event) => {
        if (!dragging) return;
        dragging = false;
        const left = Math.min(startX, event.clientX);
        const top = Math.min(startY, event.clientY);
        const width = Math.abs(event.clientX - startX);
        const height = Math.abs(event.clientY - startY);
        if (width < 12 || height < 12) {
          cleanup(null);
          return;
        }
        cleanup({
          left,
          top,
          width,
          height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1
        });
      });

      document.addEventListener("keydown", onKey);
    });
  }

  function ensurePanel() {
    if (host) return;
    host = document.createElement("div");
    host.id = "techbharat-summarizer-host";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; color-scheme: light; }
        .panel {
          background: #fbfbf8;
          border: 1px solid #c7ccd4;
          border-radius: 8px;
          box-shadow: 0 22px 60px rgba(15, 18, 24, 0.28);
          color: #181b20;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 14px;
          line-height: 1.45;
          max-height: min(760px, calc(100vh - 40px));
          overflow: hidden;
          position: fixed;
          right: 20px;
          top: 20px;
          width: min(460px, calc(100vw - 40px));
          z-index: 2147483647;
        }
        header {
          align-items: center;
          background: #20334a;
          color: #fff;
          display: flex;
          gap: 8px;
          justify-content: space-between;
          padding: 10px 12px;
        }
        header strong { font-size: 14px; }
        .toolbar { display: flex; gap: 6px; }
        button {
          background: #ecefeb;
          border: 1px solid #c4c9d1;
          border-radius: 7px;
          color: #16191e;
          cursor: pointer;
          font: inherit;
          font-size: 12px;
          font-weight: 650;
          padding: 6px 8px;
        }
        select {
          background: rgba(255,255,255,0.14);
          border: 1px solid rgba(255,255,255,0.28);
          border-radius: 7px;
          color: #fff;
          cursor: pointer;
          font: inherit;
          font-size: 12px;
          font-weight: 650;
          padding: 6px 6px;
        }
        select option {
          color: #16191e;
        }
        header button {
          background: rgba(255,255,255,0.14);
          border-color: rgba(255,255,255,0.28);
          color: #fff;
        }
        .status {
          align-items: center;
          border-bottom: 1px solid #d8dce2;
          color: #49515d;
          display: flex;
          gap: 8px;
          min-height: 24px;
          padding: 8px 12px;
        }
        .spinner {
          animation: spin 900ms linear infinite;
          border: 2px solid #d3d8df;
          border-top-color: #1d4f91;
          border-radius: 50%;
          display: none;
          height: 14px;
          width: 14px;
        }
        .loading .spinner { display: inline-block; }
        .body {
          max-height: min(490px, calc(100vh - 230px));
          overflow: auto;
          padding: 12px;
        }
        .body h2 {
          font-size: 15px;
          margin: 14px 0 6px;
        }
        .body h2:first-child { margin-top: 0; }
        .body ul { margin: 6px 0 10px; padding-left: 20px; }
        .body li { margin: 3px 0; }
        .body p { margin: 6px 0; }
        .error { color: #94372f; white-space: pre-wrap; }
        form {
          border-top: 1px solid #d8dce2;
          display: grid;
          gap: 8px;
          padding: 10px 12px 12px;
        }
        textarea {
          border: 1px solid #b9c0ca;
          border-radius: 8px;
          box-sizing: border-box;
          font: inherit;
          min-height: 62px;
          padding: 8px;
          resize: vertical;
          width: 100%;
        }
        .answer {
          background: #f0f2ed;
          border-radius: 8px;
          max-height: 160px;
          overflow: auto;
          padding: 8px;
          white-space: pre-wrap;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
      <section class="panel" aria-live="polite">
        <header>
          <strong>Screen summary</strong>
          <div class="toolbar">
            <button type="button" data-action="copy">Copy</button>
            <select data-role="export-format" title="Choose export format">
              <option value="md">.md</option>
              <option value="doc">.doc</option>
            </select>
            <button type="button" data-action="export">Export</button>
            <button type="button" data-action="close">Close</button>
          </div>
        </header>
        <div class="status"><span class="spinner"></span><span data-role="status">Ready</span></div>
        <div class="body" data-role="summary"></div>
        <form data-role="followup">
          <textarea placeholder="Ask a follow-up about this captured context"></textarea>
          <button type="submit">Ask follow-up</button>
          <div class="answer" data-role="answer"></div>
        </form>
      </section>
    `;
    document.documentElement.appendChild(host);

    els = {
      panel: shadow.querySelector(".panel"),
      statusRow: shadow.querySelector(".status"),
      status: shadow.querySelector("[data-role='status']"),
      summary: shadow.querySelector("[data-role='summary']"),
      followup: shadow.querySelector("[data-role='followup']"),
      question: shadow.querySelector("textarea"),
      answer: shadow.querySelector("[data-role='answer']"),
      exportFormat: shadow.querySelector("[data-role='export-format']")
    };

    shadow.addEventListener("click", handlePanelClick);
    els.followup.addEventListener("submit", askFollowUp);
  }

  function resetPanel() {
    currentMarkdown = "";
    followUpMarkdown = "";
    els.summary.textContent = "";
    els.answer.textContent = "";
    els.question.value = "";
    host.style.display = "block";
  }

  function setLoading(text) {
    els.status.textContent = text;
    els.statusRow.classList.add("loading");
  }

  function setReady() {
    els.status.textContent = "Ready for follow-up questions";
    els.statusRow.classList.remove("loading");
  }

  function showError(error) {
    els.status.textContent = "Could not summarize";
    els.statusRow.classList.remove("loading");
    els.summary.innerHTML = "";
    const pre = document.createElement("div");
    pre.className = "error";
    pre.textContent = error;
    els.summary.appendChild(pre);
  }

  function renderMarkdown(markdown) {
    els.summary.innerHTML = "";
    const fragment = document.createDocumentFragment();
    let list = null;
    const renderedBullets = new Set();

    for (const rawLine of normalizeSummaryMarkdown(markdown).split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        list = null;
        continue;
      }

      if (line.startsWith("## ")) {
        list = null;
        const h2 = document.createElement("h2");
        h2.textContent = line.slice(3);
        fragment.appendChild(h2);
      } else if (line.startsWith("- ")) {
        if (!list) {
          list = document.createElement("ul");
          fragment.appendChild(list);
        }
        const item = document.createElement("li");
        const bulletText = line.slice(2).trim();
        const bulletKey = bulletText.toLowerCase().replace(/\s+/g, " ");
        if (renderedBullets.has(bulletKey)) continue;
        renderedBullets.add(bulletKey);
        item.textContent = stripInlineMarkdown(bulletText);
        list.appendChild(item);
      } else {
        list = null;
        const p = document.createElement("p");
        p.textContent = stripInlineMarkdown(line);
        fragment.appendChild(p);
      }
    }

    els.summary.appendChild(fragment);
  }

  function normalizeSummaryMarkdown(markdown) {
    const sectionNames = [
      "Two-line summary",
      "Key points",
      "Actions, decisions, and numbers",
      "Caveats"
    ];
    let output = markdown.replace(/\r\n?/g, "\n").trim();

    for (const sectionName of sectionNames) {
      const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      output = output.replace(new RegExp(`(^|\\n)#{0,2}\\s*${escaped}\\s*[-:]\\s*`, "gi"), `\n## ${sectionName}\n- `);
    }

    output = output.replace(/\s+-\s+(?=[A-Z0-9"'])/g, "\n- ");
    output = output.replace(/\n{3,}/g, "\n\n");
    return output.trim();
  }

  function stripInlineMarkdown(text) {
    return String(text || "")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/__([^_\n]+)__/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1");
  }

  async function handlePanelClick(event) {
    const action = event.target?.dataset?.action;
    if (!action) return;
    if (action === "close") {
      host.style.display = "none";
    }
    if (action === "copy") {
      await navigator.clipboard.writeText(currentMarkdown);
      els.status.textContent = "Copied summary";
    }
    if (action === "export") {
      exportSummary(els.exportFormat.value);
    }
  }

  function askFollowUp(event) {
    event.preventDefault();
    const question = els.question.value.trim();
    if (!question || !activeSessionId) return;
    chrome.runtime.sendMessage({
      type: "ASK_FOLLOWUP",
      sessionId: activeSessionId,
      question
    });
  }

  function exportSummary(format) {
    const title = document.title || "summary";
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "summary";
    const isDoc = format === "doc";
    const blob = new Blob(
      [isDoc ? markdownToWordHtml(currentMarkdown, title) : currentMarkdown],
      { type: isDoc ? "application/msword" : "text/markdown" }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slug}-summary.${isDoc ? "doc" : "md"}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    els.status.textContent = isDoc ? "Word document exported" : "Markdown exported";
  }

  function markdownToWordHtml(markdown, title) {
    const body = [];
    let listOpen = false;

    for (const rawLine of normalizeSummaryMarkdown(markdown).split("\n")) {
      const line = stripInlineMarkdown(rawLine.trim());
      if (!line) {
        if (listOpen) {
          body.push("</ul>");
          listOpen = false;
        }
        continue;
      }

      if (line.startsWith("## ")) {
        if (listOpen) {
          body.push("</ul>");
          listOpen = false;
        }
        body.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
      } else if (line.startsWith("- ")) {
        if (!listOpen) {
          body.push("<ul>");
          listOpen = true;
        }
        body.push(`<li>${escapeHtml(line.slice(2))}</li>`);
      } else {
        if (listOpen) {
          body.push("</ul>");
          listOpen = false;
        }
        body.push(`<p>${escapeHtml(line)}</p>`);
      }
    }

    if (listOpen) body.push("</ul>");

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Calibri, Arial, sans-serif; font-size: 12pt; line-height: 1.35; color: #111; }
    h1 { font-size: 18pt; margin: 0 0 14pt; }
    h2 { font-size: 14pt; margin: 14pt 0 6pt; color: #1f3b57; }
    ul { margin: 0 0 10pt 18pt; padding: 0; }
    li { margin: 3pt 0; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title || "Screen summary")}</h1>
  ${body.join("\n  ")}
</body>
</html>`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const regionStyles = document.createElement("style");
  regionStyles.textContent = `
    #techbharat-region-overlay {
      background: rgba(15, 24, 32, 0.16);
      cursor: crosshair;
      inset: 0;
      position: fixed;
      z-index: 2147483646;
    }
    #techbharat-region-overlay .tb-region-help {
      background: #20334a;
      border-radius: 8px;
      color: #fff;
      font: 13px/1.4 Inter, system-ui, sans-serif;
      left: 50%;
      padding: 8px 12px;
      position: fixed;
      top: 16px;
      transform: translateX(-50%);
    }
    #techbharat-region-overlay .tb-region-box {
      background: rgba(29, 79, 145, 0.16);
      border: 2px solid #1d4f91;
      box-sizing: border-box;
      position: fixed;
    }
  `;
  document.documentElement.appendChild(regionStyles);
})();
