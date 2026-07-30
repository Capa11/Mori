import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDownloadPlan,
  isAudioOnlySource,
  isWatermarked,
  normalizeDownload,
  normalizeDownloads,
  parseAudioBitrate,
  parseVideoHeight,
  selectPreferredAudio,
  selectPreferredVideo,
} from "../public/js/utils/downloadSelection.mjs";

const source = "https://www.youtube.com/watch?v=abcdefghijk";

function normalized(downloads, sourceUrl = source) {
  return normalizeDownloads(downloads, sourceUrl);
}

test("parses scraper resolution and bitrate labels", () => {
  assert.equal(parseVideoHeight("MP4 1080p60"), 1080);
  assert.equal(parseVideoHeight("1920x1080"), 1080);
  assert.equal(parseVideoHeight("720 x 1280 portrait"), 720);
  assert.equal(parseVideoHeight("Full HD"), 1080);
  assert.equal(parseVideoHeight("4K UHD"), 2160);
  assert.equal(parseAudioBitrate("High quality MP3 320 kbps"), 320);
  assert.equal(parseAudioBitrate("AUDIO 128k"), 128);
});

test("classifies arbitrary labels from audio-only source hosts", () => {
  for (const sourceUrl of [
    "https://open.spotify.com/track/abc",
    "https://music.apple.com/us/album/example/123",
    "https://artist.bandcamp.com/album/example",
  ]) {
    assert.equal(isAudioOnlySource(sourceUrl), true);
    assert.equal(
      normalizeDownload(
        { type: "Download", url: "https://cdn.example/file" },
        0,
        sourceUrl,
      ).kind,
      "audio",
    );
  }
});

test("normalizes URL objects and rejects non-HTTP download schemes", () => {
  assert.equal(
    normalizeDownload({
      type: "VIDEO",
      url: { src: "https://cdn.example/video.mp4?token=1" },
    }).url,
    "https://cdn.example/video.mp4?token=1",
  );
  assert.equal(
    normalizeDownload({ type: "VIDEO", url: "file:///tmp/video.mp4" }),
    null,
  );
  assert.equal(
    normalizeDownload({ type: "VIDEO", url: "javascript:alert(1)" }),
    null,
  );
});

test("rejects segmented streams that cannot be saved as complete media", () => {
  for (const download of [
    { type: "HLS 1080p", url: "https://cdn.example/master.m3u8" },
    { type: "DASH", url: "https://cdn.example/manifest.mpd" },
    { type: "AUDIO MP3", url: "https://cdn.example/audio.m4s" },
  ]) {
    assert.equal(normalizeDownload(download), null);
  }
  assert.notEqual(
    normalizeDownload({
      type: "VIDEO 720p",
      url: "https://cdn.example/video.mp4",
    }),
    null,
  );
});

test("deduplicates exact URLs while preserving distinct signed URLs", () => {
  const items = normalized([
    {
      type: "VIDEO",
      quality: "720p",
      url: "https://cdn.example/video.mp4?token=one",
      isMirror: true,
    },
    {
      type: "VIDEO",
      quality: "720p",
      url: "https://cdn.example/video.mp4?token=one",
      isMirror: false,
    },
    {
      type: "VIDEO",
      quality: "720p",
      url: "https://cdn.example/video.mp4?token=two",
    },
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0].isMirror, false);
  assert.equal(items[1].url.endsWith("token=two"), true);
});

test("selects exact, nearest-lower, nearest-above, best, and lowest video", () => {
  const items = normalized([
    { type: "MP4 1080p", url: "https://cdn.example/1080.mp4" },
    { type: "MP4 720p", url: "https://cdn.example/720.mp4" },
    { type: "MP4 480p", url: "https://cdn.example/480.mp4" },
    { type: "MP4 360p", url: "https://cdn.example/360.mp4" },
    { type: "MP3", url: "https://cdn.example/audio.mp3" },
  ]);

  assert.equal(selectPreferredVideo(items, "720").height, 720);
  assert.equal(selectPreferredVideo(items, "600").height, 480);
  assert.equal(selectPreferredVideo(items, "240").height, 360);
  assert.equal(selectPreferredVideo(items, "best").height, 1080);
  assert.equal(selectPreferredVideo(items, "lowest").height, 360);
  assert.equal(selectPreferredVideo(items, "high").height, 1080);
  assert.equal(selectPreferredVideo(items, "medium").height, 720);
  assert.equal(selectPreferredVideo(items, "low").height, 360);
});

test("uses Instagram quality fields and Facebook quality-in-type", () => {
  const instagram = normalized(
    [
      {
        type: "VIDEO",
        quality: "1080p",
        url: "https://cdn.example/ig-high.mp4",
      },
      {
        type: "VIDEO",
        quality: "720p",
        url: "https://cdn.example/ig-medium.mp4",
      },
    ],
    "https://instagram.com/reel/example",
  );
  assert.equal(selectPreferredVideo(instagram, 720).quality, "720p");

  const facebook = normalized(
    [
      { type: "HD", url: "https://cdn.example/fb-hd.mp4" },
      { type: "SD", url: "https://cdn.example/fb-sd.mp4" },
    ],
    "https://facebook.com/watch/example",
  );
  assert.equal(selectPreferredVideo(facebook, "best").type, "HD");
  assert.equal(selectPreferredVideo(facebook, "lowest").type, "SD");
});

test("resolution outranks Twitter's overloaded mirror flag", () => {
  const items = normalized(
    [
      {
        type: "640x360",
        url: "https://video.twimg.com/360.mp4",
        isMirror: false,
      },
      {
        type: "1920x1080",
        url: "https://video.twimg.com/1080.mp4",
        isMirror: true,
      },
    ],
    "https://x.com/user/status/123",
  );

  assert.equal(selectPreferredVideo(items, "best").height, 1080);
});

test("mirror is a tie-breaker for otherwise equivalent quality", () => {
  const items = normalized([
    {
      type: "VIDEO",
      quality: "720p",
      url: "https://cdn.example/mirror.mp4",
      isMirror: true,
    },
    {
      type: "VIDEO",
      quality: "720p",
      url: "https://cdn.example/direct.mp4",
      isMirror: false,
    },
  ]);

  assert.equal(selectPreferredVideo(items, "best").url.includes("direct"), true);
});

test("clean video is preferred over a higher watermarked variant", () => {
  assert.equal(isWatermarked("VIDEO_WM"), true);
  assert.equal(isWatermarked("Video without watermark"), false);

  const items = normalized([
    {
      type: "VIDEO_WM",
      quality: "2160p",
      url: "https://cdn.example/playwm/2160.mp4",
    },
    {
      type: "VIDEO",
      quality: "720p",
      url: "https://cdn.example/clean/720.mp4",
    },
  ]);
  assert.equal(selectPreferredVideo(items, "best").height, 720);

  const onlyWatermarked = normalized([
    {
      type: "VIDEO_WM",
      quality: "1080p",
      url: "https://cdn.example/playwm/1080.mp4",
    },
  ]);
  assert.equal(selectPreferredVideo(onlyWatermarked, "best").height, 1080);
});

test("selects the highest known audio bitrate and never treats video as audio", () => {
  const items = normalized([
    {
      type: "MP3 128k",
      url: "https://cdn.example/audio-128.mp3",
      isMirror: false,
    },
    {
      type: "AUDIO 320 kbps",
      url: "https://cdn.example/audio-320.m4a",
      isMirror: true,
    },
    { type: "MP4 1080p", url: "https://cdn.example/video.mp4" },
  ]);

  assert.equal(selectPreferredAudio(items).bitrateKbps, 320);
  const plan = buildDownloadPlan(items.map((item) => item.original), {
    mode: "audio",
    sourceUrl: source,
  });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].bitrateKbps, 320);

  const noAudio = buildDownloadPlan(
    [{ type: "VIDEO", url: "https://cdn.example/only-video.mp4" }],
    { mode: "audio", sourceUrl: source },
  );
  assert.equal(noAudio.reason, "no-audio");
  assert.deepEqual(noAudio.items, []);
});

test("video planning downloads every image for an image-only gallery", () => {
  const plan = buildDownloadPlan(
    [
      { type: "PHOTO", url: "https://cdn.example/one.jpg" },
      { type: "PAGE 2", url: "https://cdn.example/two.png" },
      { type: "IMAGE", url: "https://cdn.example/three.webp" },
    ],
    {
      mode: "video",
      quality: "720",
      sourceUrl: "https://www.pixiv.net/en/artworks/123",
    },
  );

  assert.equal(plan.reason, "image-gallery");
  assert.equal(plan.isBatch, true);
  assert.equal(plan.items.length, 3);
  assert.equal(plan.items.every((item) => item.kind === "image"), true);
});

test("mixed posts choose one preferred video instead of unrelated images", () => {
  const plan = buildDownloadPlan(
    [
      { type: "IMAGE", url: "https://cdn.example/cover.jpg" },
      {
        type: "VIDEO",
        quality: "720p",
        url: "https://cdn.example/video.mp4",
      },
    ],
    {
      mode: "video",
      quality: "best",
      sourceUrl: "https://instagram.com/p/example",
    },
  );

  assert.equal(plan.reason, "preferred-video");
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].kind, "video");
});

test("Bandcamp audio mode preserves every distinct album track", () => {
  const plan = buildDownloadPlan(
    [
      { type: "01. Download", url: "https://cdn.example/track-one" },
      { type: "02. Download", url: "https://cdn.example/track-two" },
      { type: "03. Download", url: "https://cdn.example/track-three" },
    ],
    {
      mode: "audio",
      sourceUrl: "https://artist.bandcamp.com/album/a-record",
    },
  );

  assert.equal(plan.reason, "audio-collection");
  assert.equal(plan.isBatch, true);
  assert.deepEqual(
    plan.items.map((item) => item.type),
    ["01. Download", "02. Download", "03. Download"],
  );
  assert.equal(plan.items.every((item) => item.kind === "audio"), true);
});

test("Pixiv Ugoira and pages retain distinct kinds in manual mode", () => {
  const plan = buildDownloadPlan(
    {
      sourceUrl: "https://www.pixiv.net/en/artworks/123",
      downloads: [
        {
          type: "UGOIRA (MP4)",
          url: "https://ugoira.com/api/mp4/123",
        },
        {
          type: "UGOIRA (GIF)",
          url: "https://pixiv.re/123.gif",
        },
        {
          type: "UGOIRA (ZIP)",
          url: "https://i.pximg.net/123.zip?token=abc",
        },
        { type: "PAGE 1", url: "https://pixiv.re/123.jpg" },
      ],
    },
    { mode: "manual" },
  );

  assert.deepEqual(
    plan.items.map((item) => item.kind),
    ["video", "image", "archive", "image"],
  );
});

test("auto mode accepts a scraper wrapper and falls back to natural audio", () => {
  const plan = buildDownloadPlan(
    {
      status: true,
      result: {
        sourceUrl: "https://open.spotify.com/track/abc",
        downloads: [
          { type: "MP3 128k", url: "https://cdn.example/128.mp3" },
          { type: "MP3 320k", url: "https://cdn.example/320.mp3" },
        ],
      },
    },
    { mode: "auto" },
  );

  assert.equal(plan.reason, "preferred-audio");
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].bitrateKbps, 320);
});
