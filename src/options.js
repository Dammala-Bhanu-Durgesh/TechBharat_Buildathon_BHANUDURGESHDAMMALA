const form = document.querySelector("#settings");
const statusEl = document.querySelector("#status");

async function load() {
  const settings = await chrome.storage.sync.get({
    provider: "openrouter",
    apiKey: "",
    model: "openrouter/free",
    language: "same",
    privacyMode: true
  });

  form.provider.value = settings.provider;
  form.apiKey.value = settings.apiKey;
  form.model.value = settings.model;
  form.language.value = settings.language;
  form.privacyMode.checked = settings.privacyMode;
}

form.provider.addEventListener("change", () => {
  if (!form.model.value.trim() || form.model.value === "gpt-4.1-mini" || form.model.value === "openrouter/free") {
    form.model.value = form.provider.value === "openrouter" ? "openrouter/free" : "gpt-4.1-mini";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.sync.set({
    provider: form.provider.value,
    apiKey: form.apiKey.value.trim(),
    model: form.model.value.trim() || (form.provider.value === "openrouter" ? "openrouter/free" : "gpt-4.1-mini"),
    language: form.language.value,
    privacyMode: form.privacyMode.checked
  });
  statusEl.textContent = "Saved.";
  setTimeout(() => {
    statusEl.textContent = "";
  }, 1800);
});

load();
