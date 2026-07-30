/**
 * Pure download-option normalization and selection helpers.
 *
 * Scrapers currently expose human-readable `type` and `quality` values rather
 * than a shared media schema. This module converts those values into a stable
 * representation that can be consumed by the normal app, the Android share
 * popup, or a native background-download bridge.
 */

const AUDIO_ONLY_HOSTS = [
  /(^|\.)spotify\.com$/i,
  /(^|\.)music\.apple\.com$/i,
  /(^|\.)bandcamp\.com$/i,
];

const AUDIO_SIGNAL =
  /\b(mp3|audio|music|m4a|aac|opus|ogg|oga|wav|flac)\b|\b\d{2,4}\s*k(?:bps)?\b/i;
const IMAGE_SIGNAL =
  /\b(image|photo|picture|page|jpg|jpeg|png|webp|gif)\b/i;
const VIDEO_SIGNAL =
  /\b(video|mp4|mkv|mov|avi|webm|m3u8|ugoira)\b|\b(?:\d{2,5}\s*[x×]\s*\d{2,5}|\d{3,4}\s*p(?:\d{2})?|[248]k|full\s*hd|fhd|qhd|uhd|hd|sd)\b/i;
const ARCHIVE_SIGNAL = /\b(zip|archive)\b/i;

function asText(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function getRawUrl(download) {
  const raw = download?.url;
  if (typeof raw === "string") return raw.trim();
  if (!raw || typeof raw !== "object") return "";
  return asText(raw.url || raw.src || raw.downloadUrl);
}

function getValidHttpUrl(download) {
  let value = getRawUrl(download);
  if (!value) return "";
  if (value.startsWith("//")) value = `https:${value}`;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    // Preserve the exact supplied URL (including signed query parameters).
    return value;
  } catch (_) {
    return "";
  }
}

function isUnsupportedSegmentedMedia(download, url) {
  const path = getUrlPath(url);
  const label = `${asText(download?.type)} ${asText(download?.quality)}`;
  return (
    /\.(?:m3u8|mpd|m4s)$/i.test(path) ||
    /\b(?:m3u8|hls|dash(?:\s+manifest)?)\b/i.test(label)
  );
}

function getUrlPath(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch (_) {
    return "";
  }
}

function getSourceHost(sourceUrl) {
  try {
    return new URL(sourceUrl).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

export function isAudioOnlySource(sourceUrl) {
  const host = getSourceHost(sourceUrl);
  return AUDIO_ONLY_HOSTS.some((pattern) => pattern.test(host));
}

export function isBandcampSource(sourceUrl) {
  const host = getSourceHost(sourceUrl);
  return /(^|\.)bandcamp\.com$/i.test(host);
}

export function parseVideoHeight(value) {
  const text = asText(value).toLowerCase();
  if (!text) return null;

  const dimensions = [
    ...text.matchAll(/\b(\d{2,5})\s*[x×]\s*(\d{2,5})\b/g),
  ];
  if (dimensions.length) {
    return Math.max(
      ...dimensions.map((match) =>
        Math.min(Number(match[1]), Number(match[2])),
      ),
    );
  }

  const progressive = [...text.matchAll(/\b(\d{3,4})\s*p(?:\d{2})?\b/g)];
  if (progressive.length) {
    return Math.max(...progressive.map((match) => Number(match[1])));
  }

  if (/\b8k\b/.test(text)) return 4320;
  if (/\b4k\b|\buhd\b/.test(text)) return 2160;
  if (/\b2k\b|\bqhd\b/.test(text)) return 1440;
  if (/\bfhd\b|\bfull\s*hd\b/.test(text)) return 1080;
  if (/\bhd\b|\bhq\b/.test(text)) return 720;
  if (/\bsd\b/.test(text)) return 480;
  return null;
}

export function parseAudioBitrate(value) {
  const text = asText(value).toLowerCase();
  if (!text) return null;

  const matches = [
    ...text.matchAll(/\b(\d{2,4})\s*k(?:bps)?\b/g),
    ...text.matchAll(/\b(\d{2,4})\s*kb\/s\b/g),
  ];
  if (!matches.length) return null;
  return Math.max(...matches.map((match) => Number(match[1])));
}

function hasNoWatermarkMarker(value) {
  return /\b(?:without|no)[\s_-]*watermark\b/i.test(value);
}

export function isWatermarked(value) {
  const text = asText(value);
  if (!text || hasNoWatermarkMarker(text)) return false;
  return (
    /\bwith[\s_-]*watermark\b|\bwatermarked\b|\bwatermark\b/i.test(text) ||
    /(?:^|[_-])wm(?:[_-]|$)/i.test(text) ||
    /\bplaywm\b/i.test(text)
  );
}

function inferKind({ type, quality, mimeType, url, sourceUrl }) {
  const path = getUrlPath(url);
  const labelSignal = `${type} ${quality}`;
  const signal = `${labelSignal} ${mimeType} ${path}`;

  if (
    ARCHIVE_SIGNAL.test(labelSignal) ||
    /application\/(?:zip|x-zip-compressed)/i.test(mimeType) ||
    /\.zip$/i.test(path)
  ) {
    return "archive";
  }

  if (
    isAudioOnlySource(sourceUrl) ||
    AUDIO_SIGNAL.test(signal) ||
    /^audio\//i.test(mimeType) ||
    /\.(?:mp3|m4a|aac|opus|ogg|oga|wav|flac)$/i.test(path)
  ) {
    return "audio";
  }

  if (
    IMAGE_SIGNAL.test(signal) ||
    /^image\//i.test(mimeType) ||
    /\.(?:jpe?g|png|webp|gif)$/i.test(path)
  ) {
    return "image";
  }

  if (
    VIDEO_SIGNAL.test(signal) ||
    /^video\//i.test(mimeType) ||
    /\.(?:mp4|mkv|mov|avi|webm|m3u8)$/i.test(path)
  ) {
    return "video";
  }

  return "unknown";
}

function createDisplayLabel(type, quality) {
  if (!quality || type.toLowerCase().includes(quality.toLowerCase())) {
    return type;
  }
  return `${type} - ${quality}`;
}

export function normalizeDownload(download, index = 0, sourceUrl = "") {
  if (!download || typeof download !== "object") return null;

  const url = getValidHttpUrl(download);
  if (!url) return null;
  if (isUnsupportedSegmentedMedia(download, url)) return null;

  const type = asText(download.type) || "DOWNLOAD";
  const quality = asText(download.quality);
  const mimeType = asText(
    download.mimeType || download.contentType || download.mime,
  );
  const label = `${type} ${quality}`.trim();
  const kind = inferKind({ type, quality, mimeType, url, sourceUrl });

  return {
    url,
    type,
    quality,
    displayLabel: createDisplayLabel(type, quality),
    kind,
    height: kind === "video" ? parseVideoHeight(label) : null,
    bitrateKbps: kind === "audio" ? parseAudioBitrate(label) : null,
    isMirror: download.isMirror === true || download.isMirror === "true",
    watermarked: kind === "video" && isWatermarked(`${label} ${getUrlPath(url)}`),
    isRender: download.isRender === true || download.isRender === "true",
    headers:
      download.headers && typeof download.headers === "object"
        ? { ...download.headers }
        : {},
    sourceUrl,
    index,
    original: download,
  };
}

function duplicateScore(item) {
  let score = 0;
  if (item.kind !== "unknown") score += 8;
  if (!item.watermarked) score += 4;
  if (!item.isMirror) score += 2;
  if (item.height !== null || item.bitrateKbps !== null || item.quality)
    score += 1;
  return score;
}

/**
 * Normalizes options and removes only exact-URL duplicates. Signed URLs with
 * different query strings intentionally remain distinct.
 */
export function normalizeDownloads(downloads, sourceUrl = "") {
  if (!Array.isArray(downloads)) return [];

  const normalized = [];
  const positions = new Map();

  downloads.forEach((download, index) => {
    const item = normalizeDownload(download, index, sourceUrl);
    if (!item) return;

    const existingPosition = positions.get(item.url);
    if (existingPosition === undefined) {
      positions.set(item.url, normalized.length);
      normalized.push(item);
      return;
    }

    const existing = normalized[existingPosition];
    if (duplicateScore(item) > duplicateScore(existing)) {
      normalized[existingPosition] = item;
    }
  });

  return normalized;
}

function stableTieBreak(a, b) {
  if (a.watermarked !== b.watermarked) return a.watermarked ? 1 : -1;
  if (a.isMirror !== b.isMirror) return a.isMirror ? 1 : -1;
  if (a.isRender !== b.isRender) return a.isRender ? 1 : -1;
  return a.index - b.index;
}

function semanticVideoScore(item) {
  const label = `${item.type} ${item.quality}`;
  if (/\b(original|best|max(?:imum)?|high)\b/i.test(label)) return 3;
  if (/\bmedium\b/i.test(label)) return 2;
  if (/\b(low|min(?:imum)?)\b/i.test(label)) return 1;
  return 0;
}

function preferredQualityValue(preference) {
  const value = asText(preference || "best").toLowerCase();
  if (["best", "auto", "highest", "high"].includes(value)) {
    return { strategy: "best" };
  }
  if (["lowest", "minimum"].includes(value)) {
    return { strategy: "lowest" };
  }
  if (value === "medium") return { strategy: "target", height: 720 };
  if (value === "low") return { strategy: "target", height: 360 };

  const explicit = value.match(/(\d{3,4})/);
  if (explicit) {
    return { strategy: "target", height: Number(explicit[1]) };
  }
  return { strategy: "best" };
}

function bestTie(items) {
  return [...items].sort(stableTieBreak)[0] || null;
}

/**
 * Selects one video. Resolution always outranks the mirror flag; this is
 * necessary because the Twitter scrapers label later, distinct qualities as
 * mirrors. Watermarked variants are ignored when any clean video exists.
 */
export function selectPreferredVideo(items, preference = "best") {
  const videos = (Array.isArray(items) ? items : []).filter(
    (item) => item?.kind === "video",
  );
  if (!videos.length) return null;

  const cleanVideos = videos.filter((item) => !item.watermarked);
  const candidates = cleanVideos.length ? cleanVideos : videos;
  const numeric = candidates.filter(
    (item) => Number.isFinite(item.height) && item.height > 0,
  );
  const preferred = preferredQualityValue(preference);

  if (numeric.length) {
    let selectedHeight;
    if (preferred.strategy === "best") {
      selectedHeight = Math.max(...numeric.map((item) => item.height));
    } else if (preferred.strategy === "lowest") {
      selectedHeight = Math.min(...numeric.map((item) => item.height));
    } else {
      const atOrBelow = numeric.filter(
        (item) => item.height <= preferred.height,
      );
      selectedHeight = atOrBelow.length
        ? Math.max(...atOrBelow.map((item) => item.height))
        : Math.min(...numeric.map((item) => item.height));
    }
    return bestTie(numeric.filter((item) => item.height === selectedHeight));
  }

  const ordered = [...candidates].sort((a, b) => {
    const scoreDifference = semanticVideoScore(b) - semanticVideoScore(a);
    if (scoreDifference !== 0) {
      return preferred.strategy === "lowest"
        ? -scoreDifference
        : scoreDifference;
    }
    return stableTieBreak(a, b);
  });
  return ordered[0] || null;
}

export function selectPreferredAudio(items) {
  const audio = (Array.isArray(items) ? items : []).filter(
    (item) => item?.kind === "audio",
  );
  if (!audio.length) return null;

  return [...audio].sort((a, b) => {
    const aBitrate = Number.isFinite(a.bitrateKbps) ? a.bitrateKbps : -1;
    const bBitrate = Number.isFinite(b.bitrateKbps) ? b.bitrateKbps : -1;
    if (aBitrate !== bBitrate) return bBitrate - aBitrate;
    return stableTieBreak(a, b);
  })[0];
}

function unpackInput(input, explicitSourceUrl) {
  if (Array.isArray(input)) {
    return { downloads: input, sourceUrl: explicitSourceUrl || "" };
  }

  const result =
    input?.result && typeof input.result === "object" ? input.result : input;
  return {
    downloads: Array.isArray(result?.downloads) ? result.downloads : [],
    sourceUrl:
      explicitSourceUrl || asText(result?.sourceUrl || input?.sourceUrl),
  };
}

function finishPlan(mode, preferredQuality, normalizedItems, items, reason) {
  return {
    mode,
    preferredQuality,
    items,
    normalizedItems,
    isBatch: items.length > 1,
    reason,
  };
}

/**
 * Builds a deterministic download plan.
 *
 * Modes:
 * - manual: return every valid option for the compact chooser.
 * - video: select one preferred video; for image-only posts, return all images.
 * - audio: select the best audio, or every Bandcamp album track.
 * - auto: video first, then an image gallery, then source-appropriate audio.
 * - images: return every image.
 */
export function buildDownloadPlan(input, options = {}) {
  const requestedMode = asText(options.mode || "manual").toLowerCase();
  const mode = ["manual", "video", "audio", "auto", "images"].includes(
    requestedMode,
  )
    ? requestedMode
    : "manual";
  const preferredQuality = options.quality || "best";
  const unpacked = unpackInput(input, options.sourceUrl);
  const normalizedItems = normalizeDownloads(
    unpacked.downloads,
    unpacked.sourceUrl,
  );

  if (!normalizedItems.length) {
    return finishPlan(mode, preferredQuality, normalizedItems, [], "empty");
  }

  if (mode === "manual") {
    return finishPlan(
      mode,
      preferredQuality,
      normalizedItems,
      normalizedItems,
      "manual",
    );
  }

  const images = normalizedItems.filter((item) => item.kind === "image");
  const audio = normalizedItems.filter((item) => item.kind === "audio");

  if (mode === "images") {
    return finishPlan(
      mode,
      preferredQuality,
      normalizedItems,
      images,
      images.length ? "image-gallery" : "no-images",
    );
  }

  if (mode === "audio") {
    if (!audio.length) {
      return finishPlan(
        mode,
        preferredQuality,
        normalizedItems,
        [],
        "no-audio",
      );
    }
    const items = isBandcampSource(unpacked.sourceUrl)
      ? audio
      : [selectPreferredAudio(audio)].filter(Boolean);
    return finishPlan(
      mode,
      preferredQuality,
      normalizedItems,
      items,
      items.length > 1 ? "audio-collection" : "preferred-audio",
    );
  }

  const preferredVideo = selectPreferredVideo(
    normalizedItems,
    preferredQuality,
  );
  if (preferredVideo) {
    return finishPlan(
      mode,
      preferredQuality,
      normalizedItems,
      [preferredVideo],
      "preferred-video",
    );
  }

  if (images.length) {
    return finishPlan(
      mode,
      preferredQuality,
      normalizedItems,
      images,
      "image-gallery",
    );
  }

  if (mode === "auto" && audio.length) {
    const items = isBandcampSource(unpacked.sourceUrl)
      ? audio
      : [selectPreferredAudio(audio)].filter(Boolean);
    return finishPlan(
      mode,
      preferredQuality,
      normalizedItems,
      items,
      items.length > 1 ? "audio-collection" : "preferred-audio",
    );
  }

  return finishPlan(
    mode,
    preferredQuality,
    normalizedItems,
    [],
    "no-video",
  );
}
