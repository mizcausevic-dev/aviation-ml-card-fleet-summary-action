'use strict';
// Derived from the sibling MRO card spec's strict raw JSON parser.
// Validate the raw wire text before JSON.parse can discard duplicate members
// or round an unsafe integer. This is intentionally bounded for card records.
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function parseJcsJsonStrict(raw) {
  if (raw instanceof Uint8Array) {
    if (raw.byteLength > MAX_JSON_BYTES) throw new TypeError("JSON card exceeds 1 MiB");
    if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
      throw new SyntaxError("UTF-8 BOM is not accepted");
    }
    raw = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  }
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_JSON_BYTES) {
    throw new TypeError("JSON card must be a UTF-8 string of at most 1 MiB");
  }
  if (raw.charCodeAt(0) === 0xfeff) throw new SyntaxError("UTF-8 BOM is not accepted");
  let index = 0;
  const space = () => { while (/[\x20\x09\x0a\x0d]/.test(raw[index] ?? "!")) index++; };

  function quoted() {
    const start = index++;
    let escaped = false;
    while (index < raw.length) {
      const char = raw[index++];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') {
        const value = JSON.parse(raw.slice(start, index));
        if (LONE_SURROGATE.test(value)) throw new TypeError("Lone surrogate is not I-JSON");
        return value;
      }
      if (char.charCodeAt(0) < 0x20) throw new SyntaxError("Unescaped JSON control character");
    }
    throw new SyntaxError("Unterminated JSON string");
  }

  function value(depth) {
    if (depth > MAX_DEPTH) throw new SyntaxError("JSON nesting exceeds 64 levels");
    space();
    const char = raw[index];
    if (char === '"') { quoted(); return; }
    if (char === "{") {
      index++; space();
      const keys = new Set();
      if (raw[index] === "}") { index++; return; }
      while (true) {
        if (raw[index] !== '"') throw new SyntaxError("Expected JSON object key");
        const key = quoted();
        if (keys.has(key)) throw new SyntaxError("Duplicate JSON object key");
        keys.add(key);
        space();
        if (raw[index++] !== ":") throw new SyntaxError("Expected colon after JSON key");
        value(depth + 1);
        space();
        const next = raw[index++];
        if (next === "}") return;
        if (next !== ",") throw new SyntaxError("Expected comma or object close");
        space();
      }
    }
    if (char === "[") {
      index++; space();
      if (raw[index] === "]") { index++; return; }
      while (true) {
        value(depth + 1);
        space();
        const next = raw[index++];
        if (next === "]") return;
        if (next !== ",") throw new SyntaxError("Expected comma or array close");
      }
    }
    for (const literal of ["true", "false", "null"]) {
      if (raw.startsWith(literal, index)) { index += literal.length; return; }
    }
    NUMBER.lastIndex = index;
    const match = NUMBER.exec(raw);
    if (!match) throw new SyntaxError("Invalid JSON value");
    index = NUMBER.lastIndex;
    const token = match[0];
    const parsed = Number(token);
    const integerLiteral = !/[.eE]/.test(token);
    const nonzeroMantissa = /[1-9]/.test(token.split(/[eE]/)[0]);
    if (!Number.isFinite(parsed)
      || (integerLiteral && !Number.isSafeInteger(parsed))
      || (parsed === 0 && nonzeroMantissa)) {
      throw new TypeError("Non-finite or unsafe I-JSON number");
    }
  }

  value(0);
  space();
  if (index !== raw.length) throw new SyntaxError("Trailing JSON content");
  return JSON.parse(raw);
}

module.exports = { parseJcsJsonStrict };
