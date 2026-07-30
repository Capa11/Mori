import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../public/js/utils/urlUtils.js", import.meta.url),
  "utf8",
);
const { cleanUrl } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

test("history URL keys preserve content identifiers while removing trackers", () => {
  const first = cleanUrl(
    "https://www.youtube.com/watch?v=video-one&si=tracking&utm_source=share",
  );
  const second = cleanUrl("https://www.youtube.com/watch?v=video-two");

  assert.equal(first, "https://www.youtube.com/watch?v=video-one");
  assert.equal(second, "https://www.youtube.com/watch?v=video-two");
  assert.notEqual(first, second);
  assert.equal(
    cleanUrl("https://www.facebook.com/story.php?story_fbid=22&id=11&s=share"),
    "https://www.facebook.com/story.php?story_fbid=22&id=11",
  );
});

test("legacy Pixiv illustration URLs keep their content identity", () => {
  const first = cleanUrl(
    "https://www.pixiv.net/member_illust.php?mode=medium&illust_id=123&utm_source=share",
  );
  const second = cleanUrl(
    "https://www.pixiv.net/member_illust.php?illust_id=456",
  );

  assert.equal(
    first,
    "https://www.pixiv.net/member_illust.php?illust_id=123",
  );
  assert.notEqual(first, second);
});
