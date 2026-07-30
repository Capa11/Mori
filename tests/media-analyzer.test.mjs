import test from "node:test";
import assert from "node:assert/strict";

import {
  detectPlatform,
  validateMediaUrl,
} from "../public/js/mediaAnalyzer.mjs";

test("validates ordinary HTTP links and rejects unsafe schemes or credentials", () => {
  assert.equal(
    validateMediaUrl("https://example.com/watch?v=1"),
    "https://example.com/watch?v=1",
  );
  assert.throws(() => validateMediaUrl("javascript:alert(1)"));
  assert.throws(() => validateMediaUrl("file:///tmp/video.mp4"));
  assert.throws(() => validateMediaUrl("https://user:secret@example.com/video"));
});

test("routes every supported source without substring host confusion", () => {
  const cases = [
    ["https://vm.tiktok.com/example", "tiktok"],
    ["https://www.instagram.com/reel/example", "instagram"],
    ["https://youtu.be/abcdefghijk", "youtube"],
    ["https://x.com/user/status/1", "twitter"],
    ["https://open.spotify.com/track/1", "spotify"],
    ["https://pin.it/example", "pinterest"],
    ["https://music.apple.com/us/album/example/1", "applemusic"],
    ["https://fb.watch/example", "facebook"],
    ["https://xhslink.com/example", "rednote"],
    ["https://www.douyin.com/video/1", "douyin"],
    ["https://b23.tv/example", "bilibili"],
    ["https://www.threads.net/@user/post/1", "threads"],
    ["https://artist.bandcamp.com/track/example", "bandcamp"],
    ["https://www.pixiv.net/artworks/1", "pixiv"],
  ];
  for (const [url, platform] of cases) {
    assert.equal(detectPlatform(url), platform);
  }
  assert.throws(() => detectPlatform("https://youtube.com.evil.example/video"));
});
