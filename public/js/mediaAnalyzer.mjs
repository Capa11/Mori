import { normalizeDownloads } from "./utils/downloadSelection.mjs";

const SOURCE_PAIRS = {
  tiktok: ["tiktokio", "snaptik"],
  instagram: ["indown", "downreels"],
  youtube: ["gg", "mobi"],
  twitter: ["tweeload", "tvd"],
  spotify: ["spotidown", "spotmate"],
};

export function validateMediaUrl(value) {
  if (typeof value !== "string") {
    throw new Error("The shared link is invalid.");
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8192) {
    throw new Error("The shared link is invalid.");
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("The shared link is invalid.");
  }

  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Only normal HTTP or HTTPS links are supported.");
  }

  parsed.hash = "";
  return parsed.toString();
}

export function detectPlatform(value) {
  const url = new URL(validateMediaUrl(value));
  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  if (/(^|\.)tiktok\.com$/.test(host)) return "tiktok";
  if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
  if (
    /(^|\.)youtube\.com$/.test(host) ||
    host === "youtu.be"
  )
    return "youtube";
  if (
    /(^|\.)twitter\.com$/.test(host) ||
    host === "x.com" ||
    /(^|\.)fixupx\.com$/.test(host) ||
    /(^|\.)fxtwitter\.com$/.test(host) ||
    /(^|\.)vxtwitter\.com$/.test(host)
  )
    return "twitter";
  if (/(^|\.)spotify\.com$/.test(host)) return "spotify";
  if (/(^|\.)pinterest\.com$/.test(host) || host === "pin.it")
    return "pinterest";
  if (host === "music.apple.com") return "applemusic";
  if (/(^|\.)facebook\.com$/.test(host) || host === "fb.watch")
    return "facebook";
  if (
    /(^|\.)xiaohongshu\.com$/.test(host) ||
    /(^|\.)xhslink\.(com|cn)$/.test(host)
  )
    return "rednote";
  if (/(^|\.)douyin\.com$/.test(host)) return "douyin";
  if (
    /(^|\.)bilibili\.(com|tv)$/.test(host) ||
    host === "b23.tv" ||
    host === "bili.im"
  )
    return "bilibili";
  if (/(^|\.)threads\.(net|com)$/.test(host)) return "threads";
  if (/(^|\.)bandcamp\.com$/.test(host)) return "bandcamp";
  if (/(^|\.)pixiv\.net$/.test(host)) return "pixiv";

  throw new Error("This link is not supported by Mori yet.");
}

function sourceOrder(platform, preference) {
  const pair = SOURCE_PAIRS[platform];
  if (!pair) return [];
  return preference === "server2" ? [pair[1], pair[0]] : pair;
}

function youtubeOptions(mode, quality) {
  if (mode === "audio") {
    return { formats: ["mp3"] };
  }
  if (mode === "video") {
    const selected =
      quality === "lowest"
        ? "360p"
        : /^\d{3,4}$/.test(String(quality || ""))
          ? `${quality}p`
          : "1080p";
    return { formats: ["mp4"], qualities: [selected] };
  }
  return {};
}

async function runSourcedScraper(platform, url, preference, options) {
  const sources = sourceOrder(platform, preference);
  let lastError = null;

  for (const source of sources) {
    let response;
    if (platform === "tiktok") {
      const module = await import("./scrapers/tiktok.js");
      module.setTikTokSource(source);
      response = await module.scrapeTikTok(url);
    } else if (platform === "instagram") {
      const module = await import("./scrapers/instagram.js");
      module.setInstagramSource(source);
      response = await module.scrapeInstagram(url);
    } else if (platform === "youtube") {
      const module = await import("./scrapers/youtube.js");
      module.setYouTubeSource(source);
      response = await module.scrapeYouTube(
        url,
        youtubeOptions(options.mode, options.quality),
      );
    } else if (platform === "twitter") {
      const module = await import("./scrapers/twitter.js");
      module.setTwitterSource(source);
      response = await module.scrapeTwitter(url);
    } else if (platform === "spotify") {
      const module = await import("./scrapers/spotify.js");
      module.setSpotifySource(source);
      response = await module.scrapeSpotify(url);
    }

    const normalized = normalizeDownloads(response?.result?.downloads, url);
    const hasRequestedFormat =
      options.mode === "audio"
        ? normalized.some((item) => item.kind === "audio")
        : options.mode === "video"
          ? platform === "spotify" ||
            normalized.some((item) => ["video", "image"].includes(item.kind))
          : normalized.length > 0;

    if (response?.status && hasRequestedFormat) {
      return response;
    }
    lastError = new Error(
      response?.message ||
        `${platform} server ${source} did not return the requested format.`,
    );
  }

  throw lastError || new Error(`Unable to analyze this ${platform} link.`);
}

async function runSingleScraper(platform, url) {
  const loaders = {
    pinterest: async () =>
      (await import("./scrapers/pinterest.js")).scrapePinterest(url),
    applemusic: async () =>
      (await import("./scrapers/applemusic.js")).scrapeAppleMusic(url),
    facebook: async () =>
      (await import("./scrapers/facebook.js")).scrapeFacebook(url),
    rednote: async () =>
      (await import("./scrapers/rednote.js")).scrapeRedNote(url),
    douyin: async () =>
      (await import("./scrapers/douyin.js")).scrapeDouyin(url),
    bilibili: async () =>
      (await import("./scrapers/bilibili.js")).scrapeBilibili(url),
    threads: async () =>
      (await import("./scrapers/threads.js")).scrapeThreads(url),
    bandcamp: async () =>
      (await import("./scrapers/bandcamp.js")).scrapeBandcamp(url),
    pixiv: async () => (await import("./scrapers/pixiv.js")).scrapePixiv(url),
  };

  const response = await loaders[platform]();
  if (!response?.status || !response.result?.downloads?.length) {
    throw new Error(response?.message || "No downloadable media was found.");
  }
  return response;
}

export async function analyzeMedia(
  value,
  { serverPreference = "server1", mode = "manual", quality = "best" } = {},
) {
  const url = validateMediaUrl(value);
  const platform = detectPlatform(url);

  const response = SOURCE_PAIRS[platform]
    ? await runSourcedScraper(platform, url, serverPreference, {
        mode,
        quality,
      })
    : await runSingleScraper(platform, url);

  return {
    platform,
    sourceUrl: url,
    ...response.result,
    downloads: response.result.downloads,
  };
}
