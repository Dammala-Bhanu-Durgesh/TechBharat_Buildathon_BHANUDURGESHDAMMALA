# TechBharat Screen Summarizer

Manifest V3 Chrome extension for TechBharat Cohort #2 Buildathon Use Case A: on-screen summarization.

## What It Does

- Starts from the toolbar popup or keyboard shortcuts.
- Captures the whole page, the current text selection, or a user-drawn screen region.
- Extracts readable page text, same-origin iframe text, and notes blocked frames or fallback behavior.
- Handles long pages by chunking captured text before sending it to the model.
- Detects arXiv PDF links and uses arXiv metadata/abstract when Chrome's PDF viewer hides the text layer.
- Falls back to a visible screenshot for PDFs that expose no readable text.
- Streams a structured Markdown summary directly inside the page.
- Supports follow-up questions against the captured context without re-capturing.
- Copies the summary to clipboard or exports it as Markdown (`.md`) or a Word-compatible document (`.doc`).
- Redacts emails, Indian phone numbers, PAN numbers, and Aadhaar-like identifiers by default.
- For region capture, sends cropped visible-screen imagery when Chrome permits screenshot capture.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder: `Tech Bharat`.
5. Open the extension **Settings** page and add your API key.

No API key is committed to the repository or shipped in the extension bundle. The key is stored in `chrome.storage.sync`.

## Free Key Option

Use OpenRouter for a free starting path:

1. Create an account at `https://openrouter.ai/`.
2. Open `https://openrouter.ai/settings/keys`.
3. Create and copy an API key. It usually starts with `sk-or-v1-`.
4. In this extension's settings, set **Provider** to `OpenRouter`.
5. Set **Model** to `openrouter/free`.
6. Paste the key and save.

## Shortcuts

- `Ctrl+Shift+Y`: summarize page.
- `Ctrl+Shift+U`: summarize selection.
- `Ctrl+Shift+L`: draw region.

Chrome may reserve some shortcuts. You can edit them at `chrome://extensions/shortcuts`.

## Permissions

- `activeTab`: lets the extension act only on the tab the user deliberately invokes.
- `scripting`: injects the content script after the user clicks or presses a shortcut.
- `storage`: stores the user-supplied API key and preferences.
- `tabs`: finds the active tab and captures the visible region for region summaries.
- `https://api.openai.com/*`: sends user-approved captures to the model API.
- `https://openrouter.ai/*`: sends user-approved captures to OpenRouter when selected.
- `https://arxiv.org/*` and `https://export.arxiv.org/*`: fetches arXiv paper metadata for PDF viewer pages.

The extension does not scrape in the background. Capture starts only after a toolbar action or shortcut.

## Demo Flow

1. Open any test page and click **Summarize page**.
2. Watch the in-page panel show a loading state immediately and stream the structured summary.
3. Ask a follow-up question in the panel.
4. Select text and use **Summarize selection**.
5. Use **Draw region** on a chart or dashboard area.
6. Test a blocked or restricted page and confirm the extension reports a clear failure instead of fabricating a summary.

## Notes For Judges

This is a loadable unpacked extension. It intentionally avoids a build step so the submitted files can be inspected and run directly.
