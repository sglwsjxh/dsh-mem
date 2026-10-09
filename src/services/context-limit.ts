// 上下文体积工具：UTF-8 字节截断
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

export function truncateToMaxBytes(text: string, maxBytes: number, marker = "\n[... truncated ...]\n"): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(text) <= maxBytes) return text;
  const markerBytes = utf8ByteLength(marker);
  const budget = maxBytes - markerBytes;
  if (budget <= 0) return marker.slice(0, Math.max(0, maxBytes));
  const buf = Buffer.from(text, "utf-8");
  // 从尾部回退到 UTF-8 字符边界
  let end = budget;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf-8") + marker;
}
