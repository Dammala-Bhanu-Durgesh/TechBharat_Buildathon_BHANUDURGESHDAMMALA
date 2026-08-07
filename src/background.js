const sessions = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["provider", "model", "language", "privacyMode"], (settings) => {
    const provider = settings.provider || "openrouter";
    chrome.storage.sync.set({
      provider,
      model: settings.model || (provider === "openrouter" ? "openrouter/free" : "gpt-4.1-mini"),
      language: settings.language || "same",
      privacyMode: settings.privacyMode ?? true
    });
  });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const modeByCommand = {
    "summarize-page": "page",
    "summarize-selection": "selection",
    "summarize-region": "region"
  };
  if (modeByCommand[command] && tab?.id) {
    await startSummary(tab.id, modeByCommand[command]);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_SUMMARY") {
    startSummary(message.tabId, message.mode).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (message.type === "CAPTURE_READY") {
    handleCapture(sender.tab?.id, message.payload);
    return false;
  }

  if (message.type === "ASK_FOLLOWUP") {
    handleFollowUp(sender.tab?.id, message);
    return false;
  }

  return false;
});

async function startSummary(tabId, mode) {
  await ensureContentScript(tabId);
  await chrome.tabs.sendMessage(tabId, { type: "BEGIN_CAPTURE", mode });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["src/content.js"]
    });
  }
}

async function handleCapture(tabId, capture) {
  if (!tabId) return;
  const sessionId = crypto.randomUUID();
  const settings = await chrome.storage.sync.get({
    provider: "openrouter",
    apiKey: "",
    model: "openrouter/free",
    language: "same",
    privacyMode: true
  });

  const enrichedCapture = await enrichCaptureForDifficultPages(capture);
  let sourceText = settings.privacyMode ? redactSensitive(enrichedCapture.text || "") : enrichedCapture.text || "";

  let screenshotDataUrl = "";
  if (enrichedCapture.mode === "region" || (!sourceText.trim() && looksLikePdf(enrichedCapture.url))) {
    screenshotDataUrl = await tryCaptureVisibleTab(enrichedCapture.region);
    if (!sourceText.trim() && screenshotDataUrl) {
      enrichedCapture.extractionNotes = [
        ...(enrichedCapture.extractionNotes || []),
        "No selectable PDF text was exposed by Chrome's PDF viewer, so the visible page screenshot was used as a fallback."
      ];
    }
  }

  sessions.set(sessionId, {
    title: enrichedCapture.title || "Current page",
    url: enrichedCapture.url || "",
    mode: enrichedCapture.mode,
    text: sourceText,
    summary: "",
    createdAt: new Date().toISOString()
  });

  if (!sourceText.trim() && !screenshotDataUrl) {
    send(tabId, {
      type: "SUMMARY_ERROR",
      sessionId,
      error: "I could not read useful text from this page. It may be blocked, empty, or rendered in a way extensions cannot inspect. Try Draw region so I can summarize the visible screen."
    });
    return;
  }

  if (!settings.apiKey) {
    send(tabId, {
      type: "SUMMARY_ERROR",
      sessionId,
      error: "Add your API key in Settings before summarizing. OpenRouter free keys start with sk-or-v1-. The extension stores the key in chrome.storage.sync and never ships a key in the bundle."
    });
    return;
  }

  send(tabId, { type: "SUMMARY_STARTED", sessionId });

  try {
    await streamSummary({
      tabId,
      sessionId,
      provider: settings.provider,
      apiKey: settings.apiKey,
      model: settings.model,
      language: settings.language,
      capture: {
        ...enrichedCapture,
        text: sourceText,
        screenshotDataUrl
      }
    });
  } catch (error) {
    send(tabId, {
      type: "SUMMARY_ERROR",
      sessionId,
      error: friendlyError(error)
    });
  }
}

async function handleFollowUp(tabId, message) {
  if (!tabId) return;
  const session = sessions.get(message.sessionId);
  if (!session) {
    send(tabId, {
      type: "FOLLOWUP_ERROR",
      error: "The captured context is no longer available. Please summarize the page again."
    });
    return;
  }

  const settings = await chrome.storage.sync.get({
    provider: "openrouter",
    apiKey: "",
    model: "openrouter/free",
    language: "same",
    privacyMode: true
  });

  if (!settings.apiKey) {
    send(tabId, {
      type: "FOLLOWUP_ERROR",
      error: "Add your API key in Settings before asking follow-up questions."
    });
    return;
  }

  try {
    await streamFollowUp({
      tabId,
      sessionId: message.sessionId,
      provider: settings.provider,
      apiKey: settings.apiKey,
      model: settings.model,
      language: settings.language,
      session,
      question: message.question
    });
  } catch (error) {
    send(tabId, {
      type: "FOLLOWUP_ERROR",
      error: friendlyError(error)
    });
  }
}

async function streamSummary({ tabId, sessionId, provider, apiKey, model, language, capture }) {
  const prompt = buildSummaryPrompt(capture, language);
  const input = [{
    role: "user",
    content: [{ type: "input_text", text: prompt }]
  }];

  if (capture.screenshotDataUrl) {
    input[0].content.push({
      type: "input_image",
      image_url: capture.screenshotDataUrl
    });
  }

  let fullText = "";
  let streamedText = "";
  const streamGate = createSummaryStreamGate((delta) => {
    streamedText += delta;
    send(tabId, { type: "SUMMARY_DELTA", sessionId, delta });
  });
  await streamResponsesApi({
    provider,
    apiKey,
    model,
    input,
    onDelta(delta) {
      fullText += delta;
      streamGate.push(delta);
    }
  });

  fullText = sanitizeSummaryMarkdown(fullText, capture, language);

  if (!fullText.trim()) {
    fullText = buildExtractiveFallback(capture, language);
  }

  const session = sessions.get(sessionId);
  if (session) {
    session.summary = fullText;
  }
  if (streamedText !== fullText) {
    send(tabId, { type: "SUMMARY_REPLACE", sessionId, markdown: fullText });
  }
  send(tabId, { type: "SUMMARY_DONE", sessionId, markdown: fullText });
}

async function streamFollowUp({ tabId, sessionId, provider, apiKey, model, language, session, question }) {
  send(tabId, { type: "FOLLOWUP_STARTED" });
  const outputLanguage = resolveOutputLanguage(language, session.text);
  const prompt = [
    "Answer the user's follow-up using only the captured context below.",
    "If the context does not contain the answer, say that clearly.",
    `Output language: ${outputLanguage}.`,
    "",
    `Source title: ${session.title}`,
    `Source URL: ${session.url}`,
    "",
    "Previous summary:",
    session.summary || "(none yet)",
    "",
    "Captured context:",
    session.text.slice(0, 90000),
    "",
    `Question: ${question}`
  ].join("\n");

  let fullText = "";
  await streamResponsesApi({
    provider,
    apiKey,
    model,
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    onDelta(delta) {
      fullText += delta;
      send(tabId, { type: "FOLLOWUP_DELTA", delta });
    }
  });

  send(tabId, { type: "FOLLOWUP_DONE", markdown: fullText });
}

async function streamResponsesApi({ provider, apiKey, model, input, onDelta }) {
  if (provider === "openrouter") {
    return streamOpenRouterChatCompletions({ apiKey, model, input, onDelta });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input,
      stream: true,
      temperature: 0.2,
      max_output_tokens: 900
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Model request failed (${response.status}): ${body.slice(0, 600)}`);
  }

    let sawTextDelta = false;
    await readSse(response, (parsed) => {
      if (parsed.type === "response.output_text.delta" && parsed.delta) {
        sawTextDelta = true;
        onDelta(parsed.delta);
      }
      if (parsed.type === "response.output_text.done" && parsed.text && !sawTextDelta) {
        onDelta(parsed.text);
      }
      if (parsed.type === "response.refusal.delta" && parsed.delta) {
        onDelta(parsed.delta);
      }
      if (parsed.type === "response.failed") {
        throw new Error(parsed.response?.error?.message || "The model could not complete the request.");
      }
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function streamOpenRouterChatCompletions({ apiKey, model, input, onDelta }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://techbharat.local",
        "X-Title": "TechBharat Screen Summarizer"
      },
      body: JSON.stringify({
        model,
        messages: input.map(convertResponsesInputToChatMessage),
        stream: true,
        temperature: 0.2,
        max_tokens: 900,
        reasoning: { exclude: true }
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Model request failed (${response.status}): ${body.slice(0, 600)}`);
    }

    await readSse(response, (parsed) => {
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content) onDelta(delta.content);
      if (parsed.error?.message) {
        throw new Error(parsed.error.message);
      }
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function convertResponsesInputToChatMessage(message) {
  const parts = Array.isArray(message.content) ? message.content : [{ type: "input_text", text: String(message.content || "") }];
  return {
    role: message.role,
    content: parts.map((part) => {
      if (part.type === "input_image") {
        return { type: "image_url", image_url: { url: part.image_url } };
      }
      return { type: "text", text: part.text || "" };
    })
  };
}

async function readSse(response, onJson) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const event of events) {
      const dataLines = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      for (const dataLine of dataLines) {
        if (!dataLine || dataLine === "[DONE]") continue;
        onJson(JSON.parse(dataLine));
      }
    }
  }
}

function createSummaryStreamGate(onVisibleDelta) {
  let buffer = "";
  let started = false;

  return {
    push(delta) {
      if (started) {
        onVisibleDelta(delta);
        return;
      }

      buffer += delta;
      const startIndex = findFirstSummaryHeading(buffer);
      if (startIndex === -1) return;

      started = true;
      onVisibleDelta(buffer.slice(startIndex));
      buffer = "";
    }
  };
}

function findFirstSummaryHeading(text) {
  const match = text.match(/(?:^|\n)\s*#{1,3}\s*(?:Two-line summary|Key points|Actions, decisions, and numbers|Caveats)\b/i);
  return match ? match.index + match[0].search(/#{1,3}/) : -1;
}

function buildSummaryPrompt(capture, language) {
  const outputLanguage = resolveOutputLanguage(language, capture.text || "");
  const modeDescription = {
    page: "whole visible/readable page",
    selection: "selected text",
    region: "user drawn screen region"
  }[capture.mode] || "captured content";

  const chunks = chunkText(capture.text || "", 9000).slice(0, 4);
  const chunkTextBlock = chunks.map((chunk, index) => `--- Chunk ${index + 1} of ${chunks.length} ---\n${chunk}`).join("\n\n");

  return [
    "You are summarizing content a user deliberately captured in their browser.",
    "Return only the final Markdown summary. Do not explain your plan, constraints, or reasoning.",
    "Be faithful. Do not invent facts. If extraction is incomplete, say what may be missing.",
    "Do not repeat the same fact, article, person, place, or action item in multiple bullets.",
    "Do not use bold, italic, code formatting, tables, or blockquotes.",
    "Return Markdown with exactly these four headings, in this order: ## Two-line summary, ## Key points, ## Actions, decisions, and numbers, ## Caveats.",
    "Under Two-line summary, write exactly two real source-grounded bullets.",
    "Under Key points, write concise bullets grounded in the captured source.",
    "Under Actions, decisions, and numbers, list detected action items, decisions, dates, metrics, prices, percentages, names, or IDs. If none are present, write one bullet: None detected.",
    "Under Caveats, list extraction limits, blocked frames, or uncertainty.",
    "",
    `Output language: ${outputLanguage}.`,
    outputLanguage === "Telugu" ? "Write the summary in Telugu script. Do not switch to English unless a proper noun, brand name, model name, URL, or technical term is normally written in English." : "",
    `Capture mode: ${modeDescription}.`,
    `Page title: ${capture.title || "unknown"}`,
    `URL: ${capture.url || "unknown"}`,
    capture.extractionNotes?.length ? `Extraction notes: ${capture.extractionNotes.join("; ")}` : "",
    "",
    "Captured text:",
    chunkTextBlock || "(No readable text was extracted. If an image is attached, summarize only what is visually clear.)"
  ].filter(Boolean).join("\n");
}

function sanitizeSummaryMarkdown(markdown, capture, language) {
  let output = String(markdown || "").replace(/\r\n?/g, "\n").trim();
  if (!output) return "";

  const firstHeading = findFirstSummaryHeading(output);
  if (firstHeading > 0) {
    output = output.slice(firstHeading).trim();
  }

  output = output
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1");

  const sections = {
    "Two-line summary": [],
    "Key points": [],
    "Actions, decisions, and numbers": [],
    "Caveats": []
  };
  let current = "";

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = normalizeSectionHeading(line);
    if (heading) {
      current = heading;
      continue;
    }
    if (!current) continue;

    const bullet = stripBullet(line);
    if (bullet && !isTemplateOrReasoningLine(bullet)) sections[current].push(bullet);
  }

  if (!Object.values(sections).some((items) => items.length)) {
    return buildExtractiveFallback(capture, language);
  }

  sections["Two-line summary"] = uniqueBullets(sections["Two-line summary"]).slice(0, 2);
  sections["Key points"] = uniqueBullets(sections["Key points"]).slice(0, 8);
  sections["Actions, decisions, and numbers"] = uniqueBullets(sections["Actions, decisions, and numbers"]).slice(0, 8);
  sections["Caveats"] = uniqueBullets(sections["Caveats"]).slice(0, 4);

  if (!sections["Two-line summary"].length && !sections["Key points"].length) {
    return buildExtractiveFallback(capture, language);
  }

  if (sections["Two-line summary"].length < 2) {
    const fallbackLines = selectFallbackLines(capture).slice(0, 2);
    while (sections["Two-line summary"].length < 2) {
      sections["Two-line summary"].push(fallbackLines[sections["Two-line summary"].length] || "No additional concise summary line was produced.");
    }
  }

  if (!sections["Key points"].length) {
    sections["Key points"] = selectFallbackLines(capture).slice(0, 5);
  }

  if (!sections["Actions, decisions, and numbers"].length) {
    sections["Actions, decisions, and numbers"] = ["None detected"];
  }

  if (!sections["Caveats"].length) {
    sections["Caveats"] = capture.extractionNotes?.length
      ? capture.extractionNotes
      : ["No specific extraction caveats were detected."];
  }

  return [
    "## Two-line summary",
    ...sections["Two-line summary"].map((item) => `- ${item}`),
    "",
    "## Key points",
    ...sections["Key points"].map((item) => `- ${item}`),
    "",
    "## Actions, decisions, and numbers",
    ...sections["Actions, decisions, and numbers"].map((item) => `- ${item}`),
    "",
    "## Caveats",
    ...sections["Caveats"].map((item) => `- ${item}`)
  ].join("\n");
}

function normalizeSectionHeading(line) {
  const cleaned = line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/[:\-]\s*$/, "")
    .trim()
    .toLowerCase();

  const sectionNames = [
    "Two-line summary",
    "Key points",
    "Actions, decisions, and numbers",
    "Caveats"
  ];
  return sectionNames.find((name) => name.toLowerCase() === cleaned) || "";
}

function stripBullet(line) {
  return line
    .replace(/^[-*•]\s*/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .trim();
}

function isTemplateOrReasoningLine(text) {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const exactTemplateLines = new Set([
    "first line.",
    "second line.",
    "bullet points grounded in the source.",
    "action items, decisions, dates, metrics, prices, percentages, names or ids. write 'none detected' if none are present.",
    "extraction limits, blocked frames, or uncertainty.",
    "we must output only that markdown, no extra text."
  ]);
  return exactTemplateLines.has(normalized) ||
    normalized.startsWith("we need to ") ||
    normalized.startsWith("now extract ") ||
    normalized.startsWith("let's ") ||
    normalized.startsWith("i need to ") ||
    normalized.includes("the instruction");
}

function uniqueBullets(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const cleaned = item.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cleaned);
  }
  return unique;
}

function buildExtractiveFallback(capture, _language) {
  const lines = selectFallbackLines(capture).slice(0, 12);
  const actionLines = lines.filter(looksLikeActionNumberOrDate).slice(0, 6);
  const caveat = "The model returned an empty or unusable response, so these bullets are extracted directly from readable page text.";
  const title = cleanFallbackLine(capture.title || "Captured page");
  const firstLine = lines[0] || "No concise source text could be extracted.";
  const outputLanguage = "";
  return [
    "## Two-line summary",
    `- ${title}`,
    `- ${firstLine}`,
    "",
    "## Key points",
    ...lines.slice(1, 7).map((line) => `- ${line}`),
    "",
    "## Actions, decisions, and numbers",
    ...(actionLines.length ? actionLines.map((line) => `- ${line}`) : ["- None detected"]),
    "",
    "## Caveats",
    `- ${caveat}`,
    outputLanguage === "Telugu" ? "- ఈ ఫాల్‌బ్యాక్ భాగాలు పేజీ నుంచి నేరుగా తీసుకున్నవి; పూర్తి సహజ తెలుగు సారాంశం కోసం మళ్లీ ప్రయత్నించండి." : ""
  ].filter(Boolean).join("\n");
}

function selectFallbackLines(capture) {
  const title = cleanFallbackLine(capture.title || "");
  const seen = new Set([title.toLowerCase()]);
  const candidates = [];

  for (const line of dedupeLines(capture.text || "")) {
    const cleaned = cleanFallbackLine(line);
    if (!cleaned || shouldSkipFallbackLine(cleaned, title)) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(cleaned);
  }

  return candidates;
}

function cleanFallbackLine(line) {
  return String(line || "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function shouldSkipFallbackLine(line, title) {
  const normalized = line.toLowerCase();
  if (title && normalized === title.toLowerCase()) return true;
  if (normalized.startsWith("page title:")) return true;
  if (normalized.startsWith("latest telugu news | breaking news telugu")) return true;
  if (normalized.includes("online edition of the largest circulated")) return true;
  if (normalized === "home" || normalized === "trending") return true;
  return normalized.length < 20;
}

function looksLikeActionNumberOrDate(line) {
  return /(?:\b\d{1,4}\b|rs\.?|%|percent|crore|lakh|august|january|february|march|april|may|june|july|september|october|november|december|[0-9]+\/[0-9]+)/i.test(line);
}

function dedupeLines(text) {
  const seen = new Set();
  const lines = [];
  for (const rawLine of text.split(/\n+/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (line.length < 20) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line.slice(0, 220));
  }
  return lines;
}

function resolveOutputLanguage(language, text) {
  if (language !== "same") return language;
  return detectDominantIndicLanguage(text) || "the dominant language of the captured source";
}

function detectDominantIndicLanguage(text = "") {
  const ranges = [
    ["Telugu", /[\u0C00-\u0C7F]/g],
    ["Hindi", /[\u0900-\u097F]/g],
    ["Tamil", /[\u0B80-\u0BFF]/g],
    ["Bengali", /[\u0980-\u09FF]/g],
    ["Marathi", /[\u0900-\u097F]/g]
  ];
  let best = ["", 0];
  for (const [name, regex] of ranges) {
    const count = (text.match(regex) || []).length;
    if (count > best[1]) best = [name, count];
  }
  return best[1] >= 20 ? best[0] : "";
}

function chunkText(text, size) {
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    chunks.push(text.slice(cursor, cursor + size));
    cursor += size;
  }
  return chunks;
}

async function enrichCaptureForDifficultPages(capture) {
  if (!looksLikePdf(capture.url)) return capture;

  const arxivId = getArxivId(capture.url);
  if (!arxivId) {
    return {
      ...capture,
      extractionNotes: [
        ...(capture.extractionNotes || []),
        "This appears to be a PDF. Chrome's built-in PDF viewer may not expose the full document text to extensions."
      ]
    };
  }

  try {
    const metadata = await fetchArxivMetadata(arxivId);
    if (!metadata) return capture;
    const paperText = [
      `arXiv paper ID: ${arxivId}`,
      `Title: ${metadata.title}`,
      `Authors: ${metadata.authors.join(", ")}`,
      metadata.published ? `Published: ${metadata.published}` : "",
      metadata.updated ? `Updated: ${metadata.updated}` : "",
      metadata.categories ? `Categories: ${metadata.categories}` : "",
      "",
      "Abstract:",
      metadata.summary
    ].filter(Boolean).join("\n");

    return {
      ...capture,
      title: metadata.title || capture.title,
      text: `${paperText}\n\n${capture.text || ""}`.trim(),
      extractionNotes: [
        ...(capture.extractionNotes || []),
        "Detected an arXiv PDF and used the arXiv API metadata/abstract because Chrome's PDF viewer does not expose the full PDF text like a normal web page."
      ]
    };
  } catch (error) {
    return {
      ...capture,
      extractionNotes: [
        ...(capture.extractionNotes || []),
        `arXiv metadata fallback failed: ${error.message || "unknown error"}.`
      ]
    };
  }
}

function looksLikePdf(url = "") {
  return /\.pdf(?:[?#].*)?$/i.test(url) || /\/pdf\//i.test(url);
}

function getArxivId(url = "") {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("arxiv.org")) return "";
    const match = parsed.pathname.match(/\/pdf\/([^/?#]+)(?:\.pdf)?/i);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

async function fetchArxivMetadata(id) {
  const response = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
  if (!response.ok) {
    throw new Error(`arXiv API returned ${response.status}`);
  }
  const xml = await response.text();
  if (!/<entry[\s>]/.test(xml)) return null;

  return {
    title: cleanXml(extractXml(xml, "title")),
    summary: cleanXml(extractXml(xml, "summary")),
    published: cleanXml(extractXml(xml, "published")).slice(0, 10),
    updated: cleanXml(extractXml(xml, "updated")).slice(0, 10),
    categories: [...xml.matchAll(/<category[^>]+term="([^"]+)"/g)].map((match) => decodeXml(match[1])).join(", "),
    authors: [...xml.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g)].map((match) => cleanXml(match[1]))
  };
}

function extractXml(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1] : "";
}

function cleanXml(value) {
  return decodeXml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function redactSensitive(text) {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:\+?91[-.\s]?)?[6-9]\d{9}\b/g, "[redacted-phone]")
    .replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, "[redacted-pan]")
    .replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, "[redacted-aadhaar-like-id]");
}

async function tryCaptureVisibleTab(region) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
    if (!region) return dataUrl;
    return await cropDataUrl(dataUrl, region);
  } catch {
    return "";
  }
}

async function cropDataUrl(dataUrl, region) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = bitmap.width / Math.max(1, region.viewportWidth);
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(region.width * scale)),
    Math.max(1, Math.round(region.height * scale))
  );
  const ctx = canvas.getContext("2d");
  ctx.drawImage(
    bitmap,
    Math.round(region.left * scale),
    Math.round(region.top * scale),
    Math.round(region.width * scale),
    Math.round(region.height * scale),
    0,
    0,
    canvas.width,
    canvas.height
  );
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToDataUrl(blob);
}

function blobToDataUrl(blob) {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return `data:${blob.type};base64,${btoa(binary)}`;
  });
}

function send(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

function friendlyError(error) {
  const message = error?.message || "Something went wrong while summarizing.";
  if (error?.name === "AbortError") return "The model took too long to respond. Try summarizing a selection or drawn region, or retry with a smaller page section.";
  if (message.includes("401")) return "The API key was rejected. Check Settings and try again.";
  if (message.includes("429")) return "The model API is rate limited right now. Please retry in a moment.";
  if (message.includes("Failed to fetch")) return "The model request could not reach the API. Check your connection or extension permissions.";
  return message;
}
