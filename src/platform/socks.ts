// SOCKS5 path translated from win32/win_net.c NET_OpenSocks and packet framing.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { Socket } from "node:net";
import type { Ipv4Address } from "./network.ts";

export interface SocksOptions {
  readonly server: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
}

function credentialBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  if (text.length > 255) throw new Error("SOCKS credential exceeds 255 bytes");
  for (let index = 0; index < text.length; index++) {
    const byte = text.charCodeAt(index);
    if (byte === 0 || byte > 255) throw new Error("SOCKS credentials require non-NUL source bytes");
    bytes[index] = byte;
  }
  return bytes;
}

export function socksDatagram(to: Ipv4Address, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(payload.byteLength + 10);
  bytes[3] = 1;
  bytes.set(to.host, 4);
  new DataView(bytes.buffer).setUint16(8, to.port);
  bytes.set(payload, 10);
  return bytes;
}

export function readSocksDatagram(bytes: Uint8Array): { readonly from: Ipv4Address; readonly payload: Uint8Array } | null {
  if (bytes.byteLength < 10 || bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 0 || bytes[3] !== 1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const port = view.getUint16(8);
  return { from: { kind: "ipv4", host: [view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7)], port }, payload: bytes.slice(10) };
}

/** The UDP association lasts exactly as long as its owned TCP control socket. */
export class SocksAssociation {
  private readonly socket = new Socket();
  private bytes = new Uint8Array(0);
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  private relayAddress: Ipv4Address | null = null;
  private started = false;

  constructor() {
    this.socket.on("data", (chunk: Uint8Array) => {
      if (this.failure !== null) return;
      // Only bounded handshake replies are expected on this control stream.
      if (this.bytes.length + chunk.length > 1024) { this.fail(new Error("SOCKS control response exceeds limit")); return; }
      const bytes = new Uint8Array(this.bytes.length + chunk.length);
      bytes.set(this.bytes); bytes.set(chunk, this.bytes.length); this.bytes = bytes;
      this.wake?.();
    });
    // Do not include native error messages, configured hostnames or credentials.
    this.socket.on("error", () => { this.fail(new Error("SOCKS control connection failed")); });
    this.socket.on("close", () => { this.fail(new Error("SOCKS control connection closed")); });
    this.socket.on("end", () => { this.fail(new Error("SOCKS control connection ended")); });
  }

  get relay(): Ipv4Address | null { return this.failure === null ? this.relayAddress : null; }

  private fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    this.relayAddress = null;
    this.socket.destroy();
    this.wake?.();
  }

  private async read(length: number): Promise<Uint8Array> {
    while (true) {
      if (this.failure !== null) throw this.failure;
      if (this.bytes.length >= length) {
        const result = this.bytes.slice(0, length);
        this.bytes = this.bytes.slice(length);
        return result;
      }
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = null;
    }
  }

  async open(options: SocksOptions, localPort: number): Promise<void> {
    if (this.started) throw new Error("SOCKS association has already started");
    this.started = true;
    const timer = setTimeout(() => { this.fail(new Error("SOCKS negotiation timed out")); }, 5000);
    try {
      if (this.failure !== null) throw this.failure;
      if (options.server.length === 0 || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
        throw new Error("SOCKS server and port are invalid");
      }
      const username = credentialBytes(options.username), password = credentialBytes(options.password);
      const authenticated = username.length !== 0 || password.length !== 0;
      this.socket.connect({ host: options.server, port: options.port, family: 4 });
      // Repair the source's overwritten buf[2]/uninitialized buf[3] greeting.
      // RFC 1928 lists both intended methods explicitly, including no-auth.
      this.socket.write(authenticated ? Uint8Array.of(5, 2, 0, 2) : Uint8Array.of(5, 1, 0));
      const method = await this.read(2);
      if (method[0] !== 5 || (method[1] !== 0 && (method[1] !== 2 || !authenticated))) throw new Error("SOCKS authentication method rejected");
      if (method[1] === 2) {
        // Preserve source empty fields if the proxy selects authentication.
        const request = new Uint8Array(3 + username.length + password.length);
        request[0] = 1; request[1] = username.length; request.set(username, 2);
        request[2 + username.length] = password.length; request.set(password, 3 + username.length);
        this.socket.write(request);
        const reply = await this.read(2);
        if (reply[0] !== 1 || reply[1] !== 0) throw new Error("SOCKS authentication failed");
      }
      const request = Uint8Array.of(5, 3, 0, 1, 0, 0, 0, 0, localPort >>> 8, localPort & 255);
      this.socket.write(request);
      const header = await this.read(4);
      if (header[0] !== 5 || header[1] !== 0 || header[2] !== 0) throw new Error("SOCKS UDP association rejected");
      if (header[3] !== 1) throw new Error("SOCKS relay address is not IPv4");
      const reply = await this.read(6), view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
      const port = view.getUint16(4);
      if (port === 0) throw new Error("SOCKS relay port is zero");
      this.relayAddress = { kind: "ipv4", host: [view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)], port };
    } catch (error) { this.close(); throw error; }
    finally { clearTimeout(timer); }
  }

  close(): void { this.fail(new Error("SOCKS association closed")); }
}
