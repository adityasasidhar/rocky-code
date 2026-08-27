/**
 * Head+tail truncation with an explicit elision marker.
 *
 * The model needs to know *that* content was removed and *how much*, otherwise
 * it will confidently reason about output it never saw.
 */
export function truncateMiddle(
  text: string,
  maxBytes: number,
  note = "",
): { text: string; truncated: boolean; elidedBytes: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return { text, truncated: false, elidedBytes: 0 };
  }

  // Reserve room for the marker itself so the result never exceeds maxBytes.
  const marker = (n: number) =>
    `\n\n… [${n.toLocaleString()} bytes elided${note ? `; ${note}` : ""}] …\n\n`;
  const reserve = Buffer.byteLength(marker(bytes.length), "utf8");
  const budget = Math.max(0, maxBytes - reserve);
  const headBytes = Math.ceil(budget * 0.6);
  const tailBytes = budget - headBytes;

  const head = sliceUtf8(bytes, 0, headBytes);
  const tail = sliceUtf8(bytes, bytes.length - tailBytes, bytes.length);
  const elided = bytes.length - Buffer.byteLength(head) - Buffer.byteLength(tail);

  return {
    text: `${head}${marker(elided)}${tail}`,
    truncated: true,
    elidedBytes: elided,
  };
}

/** Slice a byte range and drop any partial UTF-8 sequence at either edge. */
function sliceUtf8(buf: Buffer, start: number, end: number): string {
  if (end <= start) return "";
  let s = start;
  let e = end;
  // A continuation byte is 0b10xxxxxx. Walk forward off the head boundary.
  while (s < e && s > 0 && (buf[s]! & 0xc0) === 0x80) s++;
  // And backward off the tail boundary.
  while (e > s && e < buf.length && (buf[e]! & 0xc0) === 0x80) e--;
  return buf.subarray(s, e).toString("utf8");
}

/** Cap a tool result and tell the model where the full copy lives. */
export function capToolResult(
  text: string,
  maxBytes: number,
  fullPath?: string,
): string {
  const note = fullPath ? `full output at ${fullPath}` : "";
  return truncateMiddle(text, maxBytes, note).text;
}
