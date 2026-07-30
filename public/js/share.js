import { analyzeMedia } from "./mediaAnalyzer.mjs";
import {
  buildDownloadPlan,
  isBandcampSource,
  normalizeDownloads,
  selectPreferredAudio,
  selectPreferredVideo,
} from "./utils/downloadSelection.mjs";
import {
  dismissSharePopup,
  openMainApp,
  queueBackgroundDownloads,
} from "./backgroundDownloads.mjs";
import { cleanUrl } from "./utils/urlUtils.js";

const savedTheme = localStorage.getItem("mori_theme");
if (savedTheme === "light" || savedTheme === "dark") {
  document.documentElement.dataset.theme = savedTheme;
}

const elements = {
  close: document.getElementById("shareCloseBtn"),
  analyzing: document.getElementById("shareAnalyzing"),
  analyzingMessage: document.querySelector("#shareAnalyzing p"),
  error: document.getElementById("shareError"),
  errorMessage: document.getElementById("shareErrorMessage"),
  retry: document.getElementById("shareRetryBtn"),
  openApp: document.getElementById("shareOpenAppBtn"),
  result: document.getElementById("shareResult"),
  thumbnail: document.getElementById("shareThumbnail"),
  title: document.getElementById("shareTitle"),
  source: document.getElementById("shareSource"),
  modeTabs: document.getElementById("shareModeTabs"),
  qualityList: document.getElementById("shareQualityList"),
  destination: document.getElementById("shareDestination"),
  remember: document.getElementById("shareRememberChoice"),
  rememberRow: document
    .getElementById("shareRememberChoice")
    ?.closest(".remember-choice"),
  download: document.getElementById("shareDownloadBtn"),
  success: document.getElementById("shareSuccess"),
  successMessage: document.getElementById("shareSuccessMessage"),
};

const state = {
  token: 0,
  sharedUrl: "",
  result: null,
  options: [],
  activeMode: "video",
  batchItems: null,
};

function showOnly(section) {
  for (const candidate of [
    elements.analyzing,
    elements.error,
    elements.result,
    elements.success,
  ]) {
    candidate.hidden = candidate !== section;
  }
}

function messageFrom(error) {
  const text = String(error?.message || error || "Unable to prepare this link.")
    .replace(/https?:\/\/\S+/gi, "the media server")
    .replace(/\s+/g, " ")
    .trim();
  if (/timeout|timed out/i.test(text)) {
    return "The media server took too long. Check your connection and retry.";
  }
  if (/network|connection|offline/i.test(text)) {
    return "Mori could not reach the media server. Check your connection.";
  }
  return text.slice(0, 220);
}

function setAnalyzingMessage(message) {
  if (elements.analyzingMessage) elements.analyzingMessage.textContent = message;
}

function showError(error) {
  elements.errorMessage.textContent = messageFrom(error);
  showOnly(elements.error);
}

function getPreference() {
  const storedAction = localStorage.getItem("mori_share_action");
  const autoDownload = localStorage.getItem("mori_auto_download") === "true";
  const action = autoDownload
    ? ["video", "audio", "images"].includes(storedAction)
      ? storedAction
      : "video"
    : "ask";
  return {
    action,
    quality: localStorage.getItem("mori_share_quality") || "best",
    server:
      localStorage.getItem("mori_prefer_server") === "server2"
        ? "server2"
        : "server1",
    wifiOnly: localStorage.getItem("mori_wifi_only") === "true",
  };
}

function saveResultToHistory(result, sourceUrl) {
  if (localStorage.getItem("mori_incognito") === "true") return;

  let history;
  try {
    history = JSON.parse(localStorage.getItem("mori_history") || "[]");
  } catch {
    history = [];
  }
  if (!Array.isArray(history)) history = [];

  const cleanSource = cleanUrl(sourceUrl);
  const existingIndex = history.findIndex((item) => {
    const itemUrl = cleanUrl(String(item?.url || ""));
    const itemSourceUrl = cleanUrl(String(item?.sourceUrl || ""));
    return itemUrl === cleanSource || itemSourceUrl === cleanSource;
  });
  const existing = existingIndex >= 0 ? history[existingIndex] : null;
  if (existingIndex >= 0) history.splice(existingIndex, 1);

  history.unshift({
    title: String(result.title || "Shared media").trim(),
    thumbnail: result.thumbnail || "",
    url: sourceUrl,
    sourceUrl,
    timestamp: Date.now(),
    downloads: result.downloads || [],
    localFiles: existing?.localFiles || [],
    localUri: existing?.localUri || null,
    localThumbnail: existing?.localThumbnail || null,
  });
  localStorage.setItem("mori_history", JSON.stringify(history.slice(0, 100)));
}

function availableGroups() {
  const video = state.options.filter((item) => item.kind === "video");
  const audio = state.options.filter((item) => item.kind === "audio");
  const photos = state.options.filter((item) =>
    ["image", "archive", "unknown"].includes(item.kind),
  );
  return { video, audio, photos };
}

function preferredItem(mode, items) {
  const preference = getPreference();
  if (mode === "video") {
    return selectPreferredVideo(items, preference.quality) || items[0] || null;
  }
  if (mode === "audio") {
    return selectPreferredAudio(items) || items[0] || null;
  }
  return items[0] || null;
}

function displaySize(item) {
  const raw =
    item.original?.size ||
    item.original?.fileSize ||
    item.original?.filesize ||
    item.original?.contentLength;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw !== "number" || raw <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = raw;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function createQualityOption(item, selected, value) {
  const label = document.createElement("label");
  label.className = `quality-option${selected ? " is-selected" : ""}`;

  const input = document.createElement("input");
  input.type = "radio";
  input.name = "shareQuality";
  input.value = value;
  input.checked = selected;

  const copy = document.createElement("span");
  copy.className = "quality-option-copy";

  const title = document.createElement("span");
  title.className = "quality-option-title";
  title.textContent = item.displayLabel || item.type || "Download";

  const meta = document.createElement("span");
  meta.className = "quality-option-meta";
  const size = displaySize(item);
  meta.textContent =
    size ||
    (item.height
      ? `${item.height}p`
      : item.bitrateKbps
        ? `${item.bitrateKbps} kbps`
        : item.kind.toUpperCase());

  copy.append(title, meta);
  label.append(input, copy);
  input.addEventListener("change", () => {
    elements.qualityList
      .querySelectorAll(".quality-option")
      .forEach((option) => option.classList.remove("is-selected"));
    label.classList.add("is-selected");
  });
  return label;
}

function createBatchOption(labelText, metaText) {
  const item = {
    displayLabel: labelText,
    type: labelText,
    kind: state.activeMode === "audio" ? "audio" : "image",
    original: { size: metaText },
  };
  return createQualityOption(item, true, "batch");
}

function destinationFor(mode) {
  const base =
    mode === "audio"
      ? localStorage.getItem("mori_music_path") || "Mori/Music"
      : localStorage.getItem("mori_download_path") || "Mori";
  return `Downloads / ${base}`;
}

function renderOptions(mode) {
  const groups = availableGroups();
  const items = groups[mode] || [];
  state.activeMode = mode;
  state.batchItems = null;
  elements.qualityList.replaceChildren();
  elements.destination.textContent = destinationFor(mode);

  elements.modeTabs.querySelectorAll(".mode-tab").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });

  const imageOnly =
    mode === "photos" &&
    items.length > 1 &&
    state.options.every((item) => item.kind === "image");
  const bandcampAlbum =
    mode === "audio" &&
    items.length > 1 &&
    isBandcampSource(state.sharedUrl);
  const canRemember =
    mode === "video" ||
    mode === "audio" ||
    (mode === "photos" &&
      items.length > 0 &&
      items.every((item) => item.kind === "image"));
  if (elements.rememberRow) elements.rememberRow.hidden = !canRemember;
  if (!canRemember) elements.remember.checked = false;

  if (imageOnly || bandcampAlbum) {
    state.batchItems = items;
    elements.qualityList.append(
      createBatchOption(
        imageOnly ? `All photos (${items.length})` : `All tracks (${items.length})`,
        imageOnly ? "Gallery" : "Album",
      ),
    );
    return;
  }

  const preferred = preferredItem(mode, items);
  items.forEach((item) => {
    elements.qualityList.append(
      createQualityOption(item, item === preferred, String(item.index)),
    );
  });
}

function configureModeTabs() {
  const groups = availableGroups();
  const labels = {
    video: "Video",
    audio: "Audio",
    photos: groups.photos.some((item) => item.kind === "image")
      ? "Photos"
      : "Files",
  };

  let firstAvailable = null;
  elements.modeTabs.querySelectorAll(".mode-tab").forEach((button) => {
    const mode = button.dataset.mode;
    const available = (groups[mode] || []).length > 0;
    button.hidden = !available;
    button.disabled = !available;
    button.textContent = labels[mode];
    if (!firstAvailable && available) firstAvailable = mode;
  });

  const preference = getPreference();
  const preferredGroup =
    preference.action === "images" ? "photos" : preference.action;
  const preferredMode =
    preference.action !== "ask" && groups[preferredGroup]?.length
      ? preferredGroup
      : firstAvailable;
  if (!preferredMode) throw new Error("No usable download option was found.");
  renderOptions(preferredMode);
}

function showManualResult(result) {
  state.result = result;
  state.options = normalizeDownloads(result.downloads, state.sharedUrl);
  if (!state.options.length) {
    throw new Error("The media server returned no safe download links.");
  }

  elements.title.textContent = String(result.title || "Shared media")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  try {
    elements.source.textContent = new URL(state.sharedUrl).hostname.replace(
      /^www\./,
      "",
    );
  } catch {
    elements.source.textContent = "Shared link";
  }

  if (result.thumbnail && /^https?:\/\//i.test(result.thumbnail)) {
    elements.thumbnail.hidden = false;
    elements.thumbnail.referrerPolicy = "no-referrer";
    elements.thumbnail.src = result.thumbnail;
    elements.thumbnail.onerror = () => {
      elements.thumbnail.hidden = true;
    };
  } else {
    elements.thumbnail.hidden = true;
  }

  configureModeTabs();
  showOnly(elements.result);
}

function selectedItems() {
  if (state.batchItems?.length) return state.batchItems;
  const selected = elements.qualityList.querySelector(
    'input[name="shareQuality"]:checked',
  );
  if (!selected) return [];
  const index = Number(selected.value);
  return state.options.filter((item) => item.index === index).slice(0, 1);
}

function rememberSelection(items) {
  if (!elements.remember.checked || !items.length) return;
  const action =
    state.activeMode === "audio"
      ? "audio"
      : state.activeMode === "photos" &&
          items.every((item) => item.kind === "image")
        ? "images"
        : "video";
  localStorage.setItem("mori_share_action", action);
  localStorage.setItem("mori_auto_download", "true");
  if (action === "video" && items[0].height) {
    localStorage.setItem("mori_share_quality", String(items[0].height));
  }
}

async function queueItems(items, automatic = false) {
  if (!items.length) {
    throw new Error(
      state.activeMode === "audio"
        ? "This source did not provide an audio-only download."
        : "Choose a download option first.",
    );
  }

  if (!automatic) {
    elements.download.disabled = true;
    elements.download.querySelector("span").textContent = "Starting…";
  }
  setAnalyzingMessage("Starting the background download…");
  if (automatic) showOnly(elements.analyzing);

  const queued = await queueBackgroundDownloads(items, {
    title: state.result?.title || "Mori Media",
    sourceUrl: state.sharedUrl,
    wifiOnly: getPreference().wifiOnly,
    incognito: localStorage.getItem("mori_incognito") === "true",
    onStatus: setAnalyzingMessage,
  });

  elements.successMessage.textContent =
    queued.queued.length === 1
      ? `Downloading in the background to ${destinationFor(state.activeMode)}.`
      : `${queued.queued.length} downloads started in the background.`;
  if (queued.failures.length) {
    elements.successMessage.textContent += ` ${queued.failures.length} item could not be queued.`;
  }
  showOnly(elements.success);
  window.setTimeout(() => dismissSharePopup(), 1400);
}

async function runAnalysis() {
  const token = ++state.token;
  const preference = getPreference();
  showOnly(elements.analyzing);
  setAnalyzingMessage(
    preference.action === "ask"
      ? "Finding the available video and audio options…"
      : "Preparing your saved download preference…",
  );

  try {
    const result = await analyzeMedia(state.sharedUrl, {
      serverPreference: preference.server,
      mode: preference.action === "ask" ? "manual" : preference.action,
      quality: preference.quality,
    });
    if (token !== state.token) return;

    state.result = result;
    saveResultToHistory(result, state.sharedUrl);

    if (preference.action !== "ask") {
      const plan = buildDownloadPlan(result, {
        mode: preference.action,
        quality: preference.quality,
        sourceUrl: state.sharedUrl,
      });
      if (plan.items.length) {
        state.activeMode =
          plan.items[0].kind === "audio"
            ? "audio"
            : plan.items[0].kind === "image"
              ? "photos"
              : "video";
        await queueItems(plan.items, true);
        return;
      }
    }

    showManualResult(result);
  } catch (error) {
    if (token === state.token) showError(error);
  }
}

function getSharedUrl() {
  const value = new URLSearchParams(window.location.search).get("url") || "";
  if (!value || value.length > 8192) {
    throw new Error("Mori did not receive a valid shared link.");
  }
  const parsed = new URL(value);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Mori did not receive a valid shared link.");
  }
  parsed.hash = "";
  return parsed.toString();
}

elements.close.addEventListener("click", () => dismissSharePopup());
document.querySelector(".share-overlay")?.addEventListener("click", (event) => {
  if (event.target.classList.contains("share-overlay")) {
    dismissSharePopup();
  }
});
elements.openApp.addEventListener("click", () => openMainApp(state.sharedUrl));
elements.retry.addEventListener("click", runAnalysis);
elements.modeTabs.addEventListener("click", (event) => {
  const button = event.target.closest(".mode-tab:not(:disabled)");
  if (button) renderOptions(button.dataset.mode);
});
elements.download.addEventListener("click", async () => {
  const items = selectedItems();
  try {
    await queueItems(items);
    rememberSelection(items);
  } catch (error) {
    elements.download.disabled = false;
    elements.download.querySelector("span").textContent = "Download";
    showError(error);
  }
});

try {
  state.sharedUrl = getSharedUrl();
  runAnalysis();
} catch (error) {
  showError(error);
}
