// Coordinate conversion for the UI element rectangles collected from a page.
//
// Two coordinate spaces meet here:
//   * CSS viewport pixels — what getBoundingClientRect() reports. They are
//     relative to the visible viewport, never to the document, because
//     chrome.tabs.captureVisibleTab() only records what is on screen.
//   * Decoded screenshot pixels — what the captured PNG is measured in, and the
//     space every OCR word box lives in.
//
// Browser zoom, devicePixelRatio and OS display scaling all fold into the ratio
// between those two spaces, so the scales are derived from the actual bitmap
// size rather than from any single one of those factors. Horizontal and
// vertical scales are derived independently: a capture is not guaranteed to
// preserve the viewport aspect ratio exactly (rounding to whole device pixels
// at a fractional device pixel ratio already shifts one axis on its own).

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Signature (8) + IHDR chunk length (4) + chunk type (4) + width (4) + height (4).
const PNG_HEADER_BYTES = 24;
// 48 base64 characters decode to 36 bytes, comfortably past the IHDR header.
const PNG_HEADER_BASE64_CHARS = 48;

export const MAX_UI_COVER_BOXES = 256;

export function emptyUiCoverCapture() {
  return { boxes: [], viewportWidth: 0, viewportHeight: 0, scrollX: 0, scrollY: 0 };
}

// Validates a capture that crossed the chrome.scripting serialization boundary
// and clips every rectangle to the visible viewport, dropping the ones that end
// up empty (elements scrolled fully out of view, collapsed elements, junk).
export function normalizeUiCoverCapture(capture) {
  const viewportWidth = positiveSize(capture?.viewportWidth);
  const viewportHeight = positiveSize(capture?.viewportHeight);
  if (viewportWidth === null || viewportHeight === null) return emptyUiCoverCapture();

  const scrollX = finiteNumber(capture?.scrollX, 0);
  const scrollY = finiteNumber(capture?.scrollY, 0);
  const boxes = [];
  const seen = new Set();
  const candidates = Array.isArray(capture?.boxes)
    ? capture.boxes.slice(0, MAX_UI_COVER_BOXES)
    : [];
  for (const box of candidates) {
    const clipped = clipBox(box, viewportWidth, viewportHeight);
    if (clipped === null) continue;
    const key = clipped.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    boxes.push(clipped);
  }
  return { boxes, viewportWidth, viewportHeight, scrollX, scrollY };
}

// A visible-tab capture and DOM geometry collection are not atomic. Callers
// bracket the screenshot with two collections and only trust the rectangles if
// the page geometry stayed stable across the capture.
export function uiCoverCapturesMatch(before, after) {
  const first = normalizeUiCoverCapture(before);
  const second = normalizeUiCoverCapture(after);
  if (first.viewportWidth <= 0 || first.viewportHeight <= 0) return false;
  if (
    first.viewportWidth !== second.viewportWidth ||
    first.viewportHeight !== second.viewportHeight ||
    first.scrollX !== second.scrollX ||
    first.scrollY !== second.scrollY ||
    first.boxes.length !== second.boxes.length
  ) {
    return false;
  }

  return first.boxes.every((box, index) =>
    box.every((coordinate, coordinateIndex) => coordinate === second.boxes[index][coordinateIndex])
  );
}

// Converts a viewport-space capture into decoded-screenshot pixels, the space
// OCR word boxes are expressed in. Returns [] when either space is unusable,
// which costs UI containment evidence but never produces misplaced rectangles.
export function convertUiCoverBoxesToImageSpace(capture, imageWidth, imageHeight) {
  const width = positiveSize(imageWidth);
  const height = positiveSize(imageHeight);
  if (width === null || height === null) return [];

  const normalized = normalizeUiCoverCapture(capture);
  if (normalized.boxes.length === 0) return [];

  const scaleX = width / normalized.viewportWidth;
  const scaleY = height / normalized.viewportHeight;
  const converted = [];
  for (const [left, top, right, bottom] of normalized.boxes) {
    const x1 = clamp(Math.round(left * scaleX), 0, width);
    const y1 = clamp(Math.round(top * scaleY), 0, height);
    const x2 = clamp(Math.round(right * scaleX), 0, width);
    const y2 = clamp(Math.round(bottom * scaleY), 0, height);
    if (x2 - x1 <= 0 || y2 - y1 <= 0) continue;
    converted.push([x1, y1, x2, y2]);
  }
  return converted;
}

// The IHDR dimensions of a PNG are exactly the dimensions the decoder produces,
// so the header is read instead of decoding a full screenshot bitmap.
export function readPngDimensions(bytes) {
  if (bytes === undefined || bytes === null || bytes.length < PNG_HEADER_BYTES) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }
  if (readAscii(bytes, 12, 4) !== "IHDR") return null;

  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

export function readPngDimensionsFromDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const separator = dataUrl.indexOf(",");
  if (separator < 0) return null;
  if (!dataUrl.slice(0, separator).toLowerCase().includes(";base64")) return null;

  const head = dataUrl.slice(separator + 1, separator + 1 + PNG_HEADER_BASE64_CHARS);
  const aligned = head.slice(0, head.length - (head.length % 4));
  if ((aligned.length / 4) * 3 < PNG_HEADER_BYTES) return null;

  let binary;
  try {
    binary = atob(aligned);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return readPngDimensions(bytes);
}

function clipBox(box, viewportWidth, viewportHeight) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const values = box.map(Number);
  if (!values.every(Number.isFinite)) return null;

  const [x1, y1, x2, y2] = values;
  const left = clamp(Math.min(x1, x2), 0, viewportWidth);
  const top = clamp(Math.min(y1, y2), 0, viewportHeight);
  const right = clamp(Math.max(x1, x2), 0, viewportWidth);
  const bottom = clamp(Math.max(y1, y2), 0, viewportHeight);
  if (right - left <= 0 || bottom - top <= 0) return null;
  return [left, top, right, bottom];
}

function positiveSize(value) {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? size : null;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readUint32(bytes, offset) {
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function readAscii(bytes, offset, length) {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index]);
  }
  return text;
}
