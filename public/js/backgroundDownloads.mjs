const SAFE_HEADER_NAMES = new Set(["user-agent", "referer", "accept"]);
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

function plugin() {
  return window.Capacitor?.Plugins?.BackgroundDownloader || null;
}

function safePathPart(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[\\:*?"<>|\u0000-\u001f]/g, "")
    .split("/")
    .map((part) => part.trim().replace(/^\.+$/, ""))
    .filter((part) => part && part !== "..")
    .join("/")
    .replace(/^\/+|\/+$/g, "");
  return cleaned || fallback;
}

function platformFolder(sourceUrl) {
  const value = String(sourceUrl || "").toLowerCase();
  if (value.includes("tiktok") || value.includes("douyin")) return "TikTok";
  if (value.includes("instagram")) return "Instagram";
  if (value.includes("youtube") || value.includes("youtu.be")) return "YouTube";
  if (value.includes("twitter") || value.includes("x.com")) return "Twitter";
  if (value.includes("facebook") || value.includes("fb.watch"))
    return "Facebook";
  if (value.includes("pinterest") || value.includes("pin.it"))
    return "Pinterest";
  if (value.includes("bilibili") || value.includes("b23.tv"))
    return "Bilibili";
  if (value.includes("pixiv")) return "Pixiv";
  if (value.includes("spotify")) return "Spotify";
  if (value.includes("bandcamp")) return "Bandcamp";
  if (value.includes("music.apple")) return "Apple Music";
  if (value.includes("rednote") || value.includes("xiaohongshu"))
    return "RedNote";
  if (value.includes("threads")) return "Threads";
  return "Other";
}

function extensionFrom(item, resolvedUrl) {
  const allowedByKind = {
    audio: ["mp3", "m4a", "aac", "opus", "ogg", "oga", "wav", "flac"],
    image: ["jpg", "jpeg", "png", "webp", "gif"],
    video: ["mp4", "mkv", "mov", "webm"],
    archive: ["zip"],
  };
  const defaults = {
    audio: "mp3",
    image: "jpg",
    video: "mp4",
    archive: "zip",
    unknown: "bin",
  };
  const allowed = allowedByKind[item.kind] || [];
  let pathname = "";
  try {
    pathname = new URL(resolvedUrl).pathname;
  } catch {}
  const urlExtension = pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  if (urlExtension && allowed.includes(urlExtension)) return urlExtension;

  const label = `${item.type || ""} ${item.quality || ""}`.toLowerCase();
  const labelExtension = allowed.find((extension) =>
    new RegExp(`\\b${extension}\\b`, "i").test(label),
  );
  return labelExtension || defaults[item.kind] || defaults.unknown;
}

function mimeFor(kind, extension) {
  const exact = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    opus: "audio/opus",
    ogg: kind === "video" ? "video/ogg" : "audio/ogg",
    oga: "audio/ogg",
    wav: "audio/wav",
    flac: "audio/flac",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    webm: "video/webm",
    zip: "application/zip",
  };
  return exact[extension] || "application/octet-stream";
}

function sanitizedTitle(title) {
  const value = String(title || "Mori Media")
    .replace(/#[^\s#]+/g, "")
    .replace(/[\\/:*?"<>|#%&{}[\]()@$^+=~`';,\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return value || "Mori Media";
}

function fileNameFor(item, title, sourceUrl, extension, batchIndex) {
  const cleanTitle = sanitizedTitle(title);
  const timestamp = Date.now();
  const batchSuffix =
    Number.isInteger(batchIndex) && batchIndex >= 0
      ? `_${String(batchIndex + 1).padStart(2, "0")}`
      : "";
  const template = localStorage.getItem("mori_filename") || "default";

  if (template === "title-platform") {
    return `${cleanTitle}_${platformFolder(sourceUrl)}${batchSuffix}_${timestamp}.${extension}`;
  }
  if (template === "title-date") {
    const date = new Date().toISOString().slice(0, 10);
    return `${cleanTitle}_${date}${batchSuffix}_${timestamp}.${extension}`;
  }
  return `${cleanTitle}${batchSuffix}_${timestamp}.${extension}`;
}

function subfolderFor(item, sourceUrl) {
  const base =
    item.kind === "audio"
      ? localStorage.getItem("mori_music_path") || "Mori/Music"
      : localStorage.getItem("mori_download_path") || "Mori";
  const normalized = safePathPart(base, item.kind === "audio" ? "Mori/Music" : "Mori");
  return localStorage.getItem("mori_auto_folder") === "true"
    ? `${normalized}/${platformFolder(sourceUrl)}`
    : normalized;
}

function headersFor(item, resolvedUrl, sourceUrl) {
  const headers = { "User-Agent": DEFAULT_USER_AGENT };
  const combined = `${resolvedUrl} ${sourceUrl || ""}`.toLowerCase();
  let sourceHost = "";
  try {
    sourceHost = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {}
  const twitterSource =
    sourceHost === "x.com" ||
    sourceHost === "twitter.com" ||
    sourceHost.endsWith(".twitter.com") ||
    sourceHost.endsWith(".fixupx.com") ||
    sourceHost.endsWith(".fxtwitter.com") ||
    sourceHost.endsWith(".vxtwitter.com");
  const bilibiliSource =
    sourceHost === "b23.tv" ||
    sourceHost === "bili.im" ||
    sourceHost === "bilibili.com" ||
    sourceHost.endsWith(".bilibili.com") ||
    sourceHost === "bilibili.tv" ||
    sourceHost.endsWith(".bilibili.tv");

  if (combined.includes("ytmp3.mobi") || combined.includes("ytdown")) {
    headers.Referer = "https://ytmp3.mobi/";
  } else if (combined.includes("ugoira")) {
    headers.Referer = "https://ugoira.com/";
  } else if (combined.includes("pximg.net") || combined.includes("pixiv.net")) {
    headers.Referer = "https://www.pixiv.net/";
  } else if (
    combined.includes("bilibili") ||
    combined.includes("bilivideo") ||
    combined.includes("bstarstatic") ||
    combined.includes("akamaized.net") ||
    bilibiliSource
  ) {
    headers.Referer = "https://www.bilibili.tv/";
  } else if (combined.includes("twimg.com")) {
    headers.Referer = "https://twitter.com/";
  } else if (
    combined.includes("tweeload") ||
    combined.includes("acxcdn.com") ||
    twitterSource
  ) {
    headers.Referer = "https://tweeload.com/";
  }

  for (const [name, value] of Object.entries(item.headers || {})) {
    if (
      SAFE_HEADER_NAMES.has(name.toLowerCase()) &&
      typeof value === "string" &&
      value.length <= 1024 &&
      !/[\r\n]/.test(value)
    ) {
      headers[name] = value;
    }
  }
  return headers;
}

async function resolveDownloadUrl(item, onStatus) {
  let url = item.url;
  const needsResolving =
    (url.includes("ytdown") ||
      url.includes("worker") ||
      (url.includes("token=") && url.includes("snapsave"))) &&
    !/\.(mp4|mp3|m4a|zip|jpg|jpeg|png|webp|gif)(\?|$)/i.test(url);

  if (!needsResolving) return url;

  const http = window.Capacitor?.Plugins?.CapacitorHttp;
  if (!http) throw new Error("The native URL resolver is unavailable.");

  for (let attempt = 0; attempt < 15; attempt += 1) {
    onStatus?.(`Preparing media… ${attempt + 1}/15`);
    try {
      const response = await http.get({ url });
      let data = response?.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          const match = data.match(/"fileUrl"\s*:\s*"([^"]+)"/);
          if (match) data = { fileUrl: match[1] };
        }
      }
      const resolved = data?.fileUrl || data?.url || data?.download_url;
      if (typeof resolved === "string" && /^https?:\/\//i.test(resolved)) {
        return resolved;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error("The media server did not finish preparing this file.");
}

export function validateBackgroundDownloadUrl(value) {
  const parsed = new URL(value);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    isPrivateNetworkHost(parsed.hostname)
  ) {
    throw new Error("The media server returned an unsafe download link.");
  }
  parsed.hash = "";
  return parsed.toString();
}

function isPrivateNetworkHost(value) {
  const host = String(value || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan")
  ) {
    return true;
  }

  if (host.includes(":")) {
    return (
      host === "::" ||
      host === "::1" ||
      /^f[cd]/i.test(host) ||
      /^fe[89ab]/i.test(host) ||
      /^ff/i.test(host) ||
      host.startsWith("::ffff:") ||
      host.includes("%")
    );
  }

  if (!host.includes(".")) return true;
  if (!/^\d+(?:\.\d+){3}$/.test(host)) {
    return /^\d+$/.test(host);
  }
  const octets = host.split(".").map(Number);
  if (
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export async function queueBackgroundDownloads(
  items,
  { title, sourceUrl, wifiOnly = false, incognito = false, onStatus } = {},
) {
  const downloader = plugin();
  if (!downloader?.enqueue) {
    throw new Error("Background downloading is unavailable in this build.");
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("No downloadable media was selected.");
  }

  const queued = [];
  const failures = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    try {
      onStatus?.(
        items.length > 1
          ? `Preparing ${index + 1} of ${items.length}…`
          : "Preparing download…",
      );
      const resolvedUrl = validateBackgroundDownloadUrl(
        await resolveDownloadUrl(item, onStatus),
      );
      const extension = extensionFrom(item, resolvedUrl);
      const fileName = fileNameFor(
        item,
        title,
        sourceUrl,
        extension,
        items.length > 1 ? index : null,
      );
      const subfolder = subfolderFor(item, sourceUrl);
      const result = await downloader.enqueue({
        url: resolvedUrl,
        fileName,
        subfolder,
        mimeType: mimeFor(item.kind, extension),
        title: sanitizedTitle(title),
        description: item.displayLabel || "Mori download",
        sourceUrl,
        kind: item.kind,
        wifiOnly: Boolean(wifiOnly),
        incognito: Boolean(incognito),
        headers: headersFor(item, resolvedUrl, sourceUrl),
      });
      queued.push({ ...result, item, fileName, subfolder });
    } catch (error) {
      failures.push({ item, error });
    }
  }

  if (!queued.length) {
    throw failures[0]?.error || new Error("Unable to start the download.");
  }
  return { queued, failures };
}

export async function consumeCompletedBackgroundDownloads() {
  const downloader = plugin();
  if (!downloader?.consumeCompleted) return { downloads: [], failures: [] };
  const result = await downloader.consumeCompleted();
  return {
    downloads: Array.isArray(result?.downloads) ? result.downloads : [],
    failures: Array.isArray(result?.failures) ? result.failures : [],
  };
}

export async function dismissSharePopup() {
  await plugin()?.dismissShare?.();
}

export async function openMainApp(url = "") {
  await plugin()?.openMainApp?.({ url });
}
