/** FLAC's comment parser allocates an array from a count inside a token. Check it first. */
function checkFlacBlocks(bytes: Uint8Array): void {
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "fLaC") return;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 4;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error("Truncated FLAC block");
    const type = data.getUint8(offset);
    const size = data.getUint32(offset) & 0xffffff;
    offset += 4;
    const end = offset + size;
    if (end > bytes.length) throw new Error("Truncated FLAC block");
    if ((type & 0x7f) === 4) {
      if (size < 8) throw new Error("Invalid FLAC comments");
      const countAt = offset + 4 + data.getUint32(offset, true);
      if (countAt + 4 > end) throw new Error("Invalid FLAC comments");
      const count = data.getUint32(countAt, true);
      let cursor = countAt + 4;
      // Every comment consumes at least its four-byte length, before any array is made.
      if (count > Math.floor((end - cursor) / 4)) throw new Error("Invalid FLAC comment count");
      for (let index = 0; index < count; index++) {
        if (cursor + 4 > end) throw new Error("Invalid FLAC comments");
        cursor += 4 + data.getUint32(cursor, true);
        if (cursor > end) throw new Error("Invalid FLAC comments");
      }
    }
    if (type & 0x80) return;
    offset = end;
  }
  throw new Error("Truncated FLAC block");
}
/** Read metadata from a bounded buffer, with token bounds checked BEFORE allocation. */
export async function soundDuration(bytes: Uint8Array, file: string): Promise<number> {
  checkFlacBlocks(bytes);
  const { fromBuffer } = await import("strtok3");
  const { parseFromTokenizer } = await import("music-metadata");
  const tokenizer = fromBuffer(bytes, { fileInfo: { path: file } });
  const bound = (length: number, position: number) => {
    if (
      !Number.isSafeInteger(length) ||
      !Number.isSafeInteger(position) ||
      length < 0 ||
      position < 0 ||
      length > bytes.length - position
    )
      throw new Error("Invalid audio token bounds");
  };
  const read = tokenizer.readToken.bind(tokenizer);
  const peek = tokenizer.peekToken.bind(tokenizer);
  tokenizer.readToken = (token, position = tokenizer.position) => {
    bound(token.len, position);
    return read(token, position);
  };
  tokenizer.peekToken = (token, position = tokenizer.position) => {
    bound(token.len, position);
    return peek(token, position);
  };
  const metadata = await parseFromTokenizer(tokenizer, { duration: true, skipCovers: true });
  return metadata.format.duration ?? NaN;
}
