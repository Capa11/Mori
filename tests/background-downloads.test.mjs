import test from "node:test";
import assert from "node:assert/strict";

import { validateBackgroundDownloadUrl } from "../public/js/backgroundDownloads.mjs";

test("accepts public media URLs and removes fragments", () => {
  assert.equal(
    validateBackgroundDownloadUrl(
      "https://cdn.example.com/video.mp4?token=one#unused",
    ),
    "https://cdn.example.com/video.mp4?token=one",
  );
  assert.equal(
    validateBackgroundDownloadUrl("http://8.8.8.8/media"),
    "http://8.8.8.8/media",
  );
  assert.equal(
    validateBackgroundDownloadUrl(
      "https://[2606:4700:4700::1111]/media",
    ),
    "https://[2606:4700:4700::1111]/media",
  );
});

test("rejects credentials and private or local network targets", () => {
  for (const url of [
    "https://user:secret@example.com/media",
    "http://localhost/media",
    "http://service.internal/media",
    "http://127.0.0.1/media",
    "http://10.1.2.3/media",
    "http://100.64.1.2/media",
    "http://169.254.1.2/media",
    "http://172.31.2.3/media",
    "http://192.168.1.2/media",
    "http://198.18.0.1/media",
    "http://[::1]/media",
    "http://[fd00::1]/media",
    "http://[fe80::1]/media",
  ]) {
    assert.throws(() => validateBackgroundDownloadUrl(url));
  }
});
