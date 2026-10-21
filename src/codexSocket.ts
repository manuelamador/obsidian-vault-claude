// A connection to Codex's shared app-server (its daemon) through its control socket, which speaks
// WebSocket at `ws://localhost/rpc`, each JSON-RPC message one text message (see openai/codex,
// app-server-transport: unix_socket). Just enough of WebSocket for that: the upgrade, text frames
// both ways (ours masked, as a client's must be), fragments, ping and close; no extensions asked for,
// so none are used.
import { connect, type Socket } from 'net';
import { createHash, randomBytes } from 'crypto';

export interface CodexSocketHandlers {
  /** The upgrade done: messages may be sent. */
  onOpen(): void;
  /** One JSON-RPC message, as text. */
  onMessage(text: string): void;
  /** Closed, once: `error` when it failed (not upgraded, cut off), none when closed on purpose. */
  onClose(error?: Error): void;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class CodexSocket {
  private readonly socket: Socket;
  private upgraded = false;
  private closed = false;
  private stoppedOnPurpose = false;
  /** The socket destroyed if the other side has not closed it soon after close: cleared once closed. */
  private destroyTimer: ReturnType<typeof setTimeout> | null = null;
  private buffer = Buffer.alloc(0);
  /** Chunks arrived since `buffer` was last joined, their bytes, and how many the frame under way needs in all (0: unknown). */
  private chunks: Buffer[] = [];
  private chunked = 0;
  private needed = 0;
  /** A message arriving in fragments, its parts so far. */
  private fragments: Buffer[] = [];
  private readonly key = randomBytes(16).toString('base64');

  constructor(path: string, private readonly handlers: CodexSocketHandlers) {
    this.socket = connect({ path });
    this.socket.on('connect', () => {
      this.socket.write(['GET /rpc HTTP/1.1', 'Host: localhost', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${this.key}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
    });
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    this.socket.on('error', (error) => this.finish(error));
    this.socket.on('close', () => this.finish(this.stoppedOnPurpose ? undefined : new Error('Codex closed the connection')));
  }

  get open(): boolean {
    return this.upgraded && !this.closed;
  }

  /** Sends one message as a text frame. */
  send(text: string): void {
    if (!this.open) return;
    this.socket.write(frame(0x1, Buffer.from(text, 'utf8')));
  }

  /** Closes it on purpose: a close frame, then the socket. */
  close(): void {
    if (this.closed) return;
    this.stoppedOnPurpose = true;
    if (this.upgraded) this.socket.write(frame(0x8, Buffer.alloc(0)));
    this.socket.end();
    // Not waiting on the other side for long.
    this.destroyTimer = setTimeout(() => this.socket.destroy(), 1000);
  }

  private finish(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.destroyTimer) clearTimeout(this.destroyTimer);
    this.destroyTimer = null;
    this.socket.destroy();
    this.handlers.onClose(error);
  }

  private onData(chunk: Buffer): void {
    // A large message comes in many chunks: joined once it has all come, not chunk by chunk.
    this.chunks.push(chunk);
    this.chunked += chunk.length;
    if (this.upgraded && this.needed > 0 && this.buffer.length + this.chunked < this.needed) return;
    this.buffer = Buffer.concat([this.buffer, ...this.chunks]);
    this.chunks = [];
    this.chunked = 0;
    if (!this.upgraded) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.buffer.subarray(0, end).toString('latin1');
      this.buffer = this.buffer.subarray(end + 4);
      const accept = /^sec-websocket-accept:\s*(\S+)/im.exec(head)?.[1];
      const expected = createHash('sha1').update(this.key + GUID).digest('base64');
      if (!/^HTTP\/1\.1 101/.test(head) || accept !== expected) return this.finish(new Error(`Codex refused the connection: ${head.split('\r\n')[0]}`));
      this.upgraded = true;
      this.handlers.onOpen();
    }
    this.readFrames();
  }

  /** Reads the whole frames buffered: text messages (whole or in fragments), pings answered, a close followed. */
  private readFrames(): void {
    for (;;) {
      const parsed = unframe(this.buffer);
      if (!parsed) {
        this.needed = frameLength(this.buffer);
        return;
      }
      this.needed = 0;
      this.buffer = this.buffer.subarray(parsed.length);
      const { fin, opcode, payload } = parsed;
      if (opcode === 0x8) {
        this.socket.end();
        return this.finish(this.stoppedOnPurpose ? undefined : new Error('Codex closed the connection'));
      }
      if (opcode === 0x9) {
        this.socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (!fin) continue;
        const text = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = [];
        this.handlers.onMessage(text);
      }
    }
  }
}

/** A client's frame: final, masked, with `opcode` and `payload`. */
export function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const head = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (length < 126) head[1] = 0x80 | length;
  else if (length < 65536) {
    head[1] = 0x80 | 126;
    head.writeUInt16BE(length, 2);
  } else {
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, masked]);
}

/** How many bytes the frame starting `buffer` takes in all, once its header has come; 0 before. */
export function frameLength(buffer: Buffer): number {
  if (buffer.length < 2) return 0;
  const masked = (buffer[1] & 0x80) !== 0 ? 4 : 0;
  const length = buffer[1] & 0x7f;
  if (length < 126) return 2 + masked + length;
  if (length === 126) return buffer.length < 4 ? 0 : 4 + masked + buffer.readUInt16BE(2);
  return buffer.length < 10 ? 0 : 10 + masked + Number(buffer.readBigUInt64BE(2));
}

/** The first whole frame in `buffer`, unmasked; null until it has all arrived. */
export function unframe(buffer: Buffer): { fin: boolean; opcode: number; payload: Buffer; length: number } | null {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskAt = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) for (let i = 0; i < length; i++) payload[i] ^= buffer[maskAt + (i % 4)];
  return { fin, opcode, payload, length: offset + length };
}
