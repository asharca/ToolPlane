// OMP 18.14 RPC v2: physical frames are bounded before JSON parsing; logical
// frames must be contiguous, ordered, exact-length, strict UTF-8 JSON objects.
export class OmpFrameDecoder {
  maxFrameBytes = 1024 * 1024;
  maxReassembledFrameBytes = 64 * 1024 * 1024;
  pending;
  decode(line) {
    if (Buffer.byteLength(line) + 1 > this.maxFrameBytes)
      throw new Error("OMP_RPC_FRAME_LIMIT");
    let frame = JSON.parse(line);
    if (!frame || typeof frame !== "object" || Array.isArray(frame))
      throw new Error("OMP_RPC_FRAME_INVALID");
    if (frame.type !== "rpc_chunk") {
      if (this.pending) throw new Error("OMP_RPC_CHUNK_INTERRUPTED");
      return frame;
    }
    if (
      typeof frame.chunkId !== "string" ||
      !frame.chunkId ||
      frame.chunkId.length > 256 ||
      !Number.isSafeInteger(frame.index) ||
      !Number.isSafeInteger(frame.count) ||
      !Number.isSafeInteger(frame.byteLength) ||
      frame.count < 1 ||
      frame.count > 65536 ||
      frame.byteLength < 1 ||
      frame.byteLength > this.maxReassembledFrameBytes ||
      typeof frame.data !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        frame.data,
      )
    )
      throw new Error("OMP_RPC_CHUNK_INVALID");
    if (!this.pending) {
      if (frame.index !== 0) throw new Error("OMP_RPC_CHUNK_ORDER");
      this.pending = {
        id: frame.chunkId,
        count: frame.count,
        bytes: frame.byteLength,
        index: 0,
        size: 0,
        chunks: [],
      };
    }
    const pending = this.pending;
    if (
      frame.chunkId !== pending.id ||
      frame.index !== pending.index ||
      frame.count !== pending.count ||
      frame.byteLength !== pending.bytes
    )
      throw new Error("OMP_RPC_CHUNK_ORDER");
    const bytes = Buffer.from(frame.data, "base64");
    if (!bytes.length || bytes.toString("base64") !== frame.data)
      throw new Error("OMP_RPC_CHUNK_INVALID");
    pending.size += bytes.length;
    if (pending.size > pending.bytes) throw new Error("OMP_RPC_CHUNK_LENGTH");
    pending.chunks.push(bytes);
    if (++pending.index !== pending.count) return undefined;
    if (pending.size !== pending.bytes) throw new Error("OMP_RPC_CHUNK_LENGTH");
    frame = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(pending.chunks, pending.size),
      ),
    );
    this.pending = undefined;
    if (
      !frame ||
      typeof frame !== "object" ||
      Array.isArray(frame) ||
      frame.type === "rpc_chunk"
    )
      throw new Error("OMP_RPC_FRAME_INVALID");
    return frame;
  }
  ready(frame) {
    if (
      !frame.supportedProtocolVersions?.includes(2) ||
      !Number.isSafeInteger(frame.maxFrameBytes) ||
      frame.maxFrameBytes < 1024 ||
      !Number.isSafeInteger(frame.maxReassembledFrameBytes) ||
      frame.maxReassembledFrameBytes < frame.maxFrameBytes
    )
      throw new Error("OMP_RPC_VERSION_UNSUPPORTED");
    this.maxFrameBytes = Math.min(frame.maxFrameBytes, this.maxFrameBytes);
    this.maxReassembledFrameBytes = Math.min(
      frame.maxReassembledFrameBytes,
      this.maxReassembledFrameBytes,
    );
  }
  end() {
    if (this.pending) throw new Error("OMP_RPC_CHUNK_INTERRUPTED");
  }
}
