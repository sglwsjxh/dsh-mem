// 向量工具：序列化、相似度换算、标签嵌入文本、关键词分词

export function vectorToJson(vector: Float32Array): string {
  return JSON.stringify(Array.from(vector));
}

export function blobToFloat32Array(value: unknown): Float32Array | null {
  if (value == null) return null;
  try {
    if (value instanceof Float32Array) return value;
    if (value instanceof ArrayBuffer) {
      if (value.byteLength === 0 || value.byteLength % 4 !== 0) return null;
      return new Float32Array(value);
    }
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView;
      if (view.byteLength === 0 || view.byteLength % 4 !== 0) return null;
      return new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as number[];
        return new Float32Array(parsed);
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function distanceToSimilarity(distance: number): number {
  const similarity = 1 - Number(distance);
  if (!Number.isFinite(similarity)) return 0;
  // 余弦距离可能有极小负值，夹到 [0,1]
  return Math.max(0, Math.min(1, similarity));
}

/** 标签向量嵌入的规范文本，写入路径必须保持一致 */
export function formatTagsForEmbedding(tags: string[]): string {
  return `Topics: ${tags.join(", ")}`;
}

/** 自由文本分词，供混合检索的关键词通道使用 */
export function tokenizeQueryText(text: string | undefined | null): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[\s,._/-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
    .slice(0, 16);
}

/** 转义 LIKE 通配符，配合 SQL 里 ESCAPE '\\' */
export function escapeLikePattern(token: string): string {
  return token.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function parseSessionIdFromMetadata(metadata: string | undefined | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return typeof parsed.sessionID === "string" && parsed.sessionID.length > 0 ? parsed.sessionID : null;
  } catch {
    return null;
  }
}
