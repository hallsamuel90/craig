import { RuntimeAcknowledgementUncertainError } from "../../domain/runtime/errors.js";
import { createConnection, type Socket } from "node:net";

export const MAX_RUNTIME_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_RUNTIME_PENDING_REQUESTS = 128;
export interface RuntimeFrame { id?: number | undefined; ok?: boolean; error?: string; type?: string; [key: string]: unknown }

/** Each transport is bounded; destroying it never releases logical ownership. */
export function writeRuntimeFrame(socket: Socket, frame: RuntimeFrame): boolean {
  const data = `${JSON.stringify(frame)}\n`;
  if (socket.destroyed || Buffer.byteLength(data) > MAX_RUNTIME_FRAME_BYTES || socket.writableLength + Buffer.byteLength(data) > MAX_RUNTIME_FRAME_BYTES) {
    socket.destroy(); return false;
  }
  return socket.write(data);
}
// eslint-disable-next-line no-unused-vars
export function readRuntimeFrames(socket: Socket, receive: (frame: RuntimeFrame) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += String(chunk);
    if (Buffer.byteLength(buffer) > MAX_RUNTIME_FRAME_BYTES) { socket.destroy(); return; }
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const frame: unknown = JSON.parse(line);
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Invalid frame");
        receive(frame as RuntimeFrame);
      } catch { socket.destroy(); return; }
    }
  });
}

/* eslint-disable no-unused-vars */
export class RuntimeTransport {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (frame: RuntimeFrame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(readonly socket: Socket, private readonly event?: (frame: RuntimeFrame) => void) {
    readRuntimeFrames(socket, (frame) => {
      if (typeof frame.id !== "number") { this.event?.(frame); return; }
      const pending = this.pending.get(frame.id); if (!pending) return;
      this.pending.delete(frame.id); clearTimeout(pending.timer);
      if (frame.ok === false) {
        const message = typeof frame.error === "string" ? frame.error : "Runtime request rejected.";
        pending.reject(frame.uncertain === true ? new RuntimeAcknowledgementUncertainError(message) : new Error(message));
      }
      else pending.resolve(frame);
    });
    const close = () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RuntimeAcknowledgementUncertainError("Runtime disconnected; mutation acknowledgement is uncertain. Do not replay writes.")); }
      this.pending.clear();
    };
    socket.on("error", close); socket.on("close", close);
  }
  static async connect(endpoint: string, event?: (frame: RuntimeFrame) => void): Promise<RuntimeTransport> {
    const socket = createConnection(endpoint);
    const transport = new RuntimeTransport(socket, event);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Runtime connection timed out; owner preserved.")); }, 1000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    return transport;
  }
  request(input: RuntimeFrame, timeoutMs = 5000): Promise<RuntimeFrame> {
    if (this.socket.destroyed) return Promise.reject(new RuntimeAcknowledgementUncertainError("Runtime transport is closed."));
    if (this.pending.size >= MAX_RUNTIME_PENDING_REQUESTS) return Promise.reject(new Error("Too many pending runtime requests."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.socket.destroy(); reject(new RuntimeAcknowledgementUncertainError("Runtime acknowledgement timed out; do not replay mutations.")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      writeRuntimeFrame(this.socket, { ...input, id });
    });
  }
  close(): void { this.socket.destroy(); }
}
