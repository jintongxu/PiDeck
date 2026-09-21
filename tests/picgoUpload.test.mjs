import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { decodePicGoImageDataUrl, extractPicGoUrl } = loadTsCommonJs("src/main/projects/picgoUpload.ts");

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

test("decodePicGoImageDataUrl accepts supported clipboard images", () => {
  const decoded = decodePicGoImageDataUrl(PNG_DATA_URL);
  assert.equal(decoded.extension, ".png");
  assert.deepEqual([...decoded.bytes], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("extractPicGoUrl accepts PicGo success payload and rejects unsafe URLs", () => {
  assert.equal(extractPicGoUrl({ success: true, result: ["https://img.example/a.png"] }), "https://img.example/a.png");
  assert.throws(() => extractPicGoUrl({ success: false, result: ["https://img.example/a.png"] }), /PICGO_RESPONSE_INVALID/);
  assert.throws(() => extractPicGoUrl({ success: true, result: ["file:///tmp/a.png"] }), /PICGO_RESPONSE_INVALID/);
});

test("decodePicGoImageDataUrl rejects unsupported or malformed data", () => {
  assert.throws(() => decodePicGoImageDataUrl("data:text/plain;base64,QQ=="), /PICGO_IMAGE_INVALID/);
  assert.throws(() => decodePicGoImageDataUrl("data:image/png;base64,not-base64!"), /PICGO_IMAGE_INVALID/);
  assert.throws(() => decodePicGoImageDataUrl("data:image/png;base64,"), /PICGO_IMAGE_INVALID/);
});
