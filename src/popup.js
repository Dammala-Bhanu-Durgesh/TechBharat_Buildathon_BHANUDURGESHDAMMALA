const statusEl = document.querySelector("#status");
const buttons = [...document.querySelectorAll("button")];

async function send(mode) {
  statusEl.textContent = "Opening summarizer...";
  buttons.forEach((button) => {
    button.disabled = true;
  });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("http")) {
      throw new Error("Open an http or https page first.");
    }
    await chrome.runtime.sendMessage({ type: "START_SUMMARY", tabId: tab.id, mode });
    window.close();
  } catch (error) {
    statusEl.textContent = error.message || "Could not start summarization.";
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}

document.querySelector("#page").addEventListener("click", () => send("page"));
document.querySelector("#selection").addEventListener("click", () => send("selection"));
document.querySelector("#region").addEventListener("click", () => send("region"));
