// CL_Connect_f's resolved-address tail, CL_CheckForResend and admission branches
// of CL_ConnectionlessPacket/CL_PacketEvent from id Software's cl_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonError } from "../core/common-error.ts";
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { infoSetValueForKey } from "../core/info-string.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import { sourceCommandText } from "../core/text.ts";
import type { UnixIo } from "../platform/unix-io.ts";
import { decodeConnectionless, encodeConnect, encodeConnectionlessText } from "../protocol/connectionless.ts";
import type { ConnectionlessPacket } from "../protocol/connectionless.ts";
import type { LoopbackTransport } from "../protocol/loopback.ts";
import { ReliableOverflowError } from "../protocol/reliable.ts";
import type { ClientAuthorization } from "./client-authorization.ts";
import type { ClientSessionMode } from "./client-session.ts";
import type { ClientConnectionPhase, ClientConnectionState, ClientPacketAddress, ClientStaticState } from "./client-state.ts";

export interface ClientAdmissionOptions {
  readonly clientStatic: ClientStaticState;
  readonly clientConnection: ClientConnectionState;
  readonly cvars: CvarRegistry;
  readonly io: UnixIo;
  readonly loopback: LoopbackTransport;
  readonly authorization: ClientAuthorization;
  assertCurrentOperation(): void;
  print(text: string): void;
}

/** Use the same states and reliable ring when constructing EngineClientSession. */
export interface AdmittedClientConnection {
  readonly mode: Extract<ClientSessionMode, { readonly kind: "network" }>;
  readonly remoteAddress: ClientPacketAddress;
}

export type ClientAdmissionPacket =
  | { readonly kind: "handled" }
  | { readonly kind: "admitted"; readonly connection: AdmittedClientConnection }
  | { readonly kind: "connectionless"; readonly packet: ConnectionlessPacket }
  | { readonly kind: "sequenced"; readonly payload: Uint8Array };

function connected(phase: ClientConnectionPhase): boolean {
  return phase === "connected" || phase === "loading" || phase === "primed" || phase === "active" || phase === "cinematic";
}

function copyAddress(address: ClientPacketAddress): ClientPacketAddress {
  if (address.kind === "loopback") return Object.freeze({ kind: "loopback" });
  const [a, b, c, d] = address.host;
  return Object.freeze({ kind: "ipv4", host: Object.freeze([a, b, c, d] satisfies typeof address.host), port: address.port });
}

function sameBase(first: ClientPacketAddress, second: ClientPacketAddress): boolean {
  if (first.kind === "loopback") return second.kind === "loopback";
  return second.kind === "ipv4" && first.host.every((octet, index) => octet === second.host[index]);
}

function addressText(address: ClientPacketAddress): string {
  return address.kind === "loopback" ? "loopback" : `${address.host.join(".")}:${address.port}`;
}

function clockInt32(value: number, expression: string): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError(`Undefined native client clock arithmetic: ${expression}`);
  }
  return value;
}

/** Borrows transport and lifetimes. This is not the connect command or CG_Init. */
export class ClientAdmission {
  private channel: AdmittedClientConnection | null = null;

  constructor(readonly options: ClientAdmissionOptions) {}

  /** CL_CheckUserinfo runs before the frame's packet send and connection resend. */
  checkUserinfo(): void {
    this.options.assertCurrentOperation();
    const { clientStatic: cls, clientConnection: clc, cvars } = this.options;
    if (cls.phase !== "challenging" && !connected(cls.phase)) return;
    const paused = cvars.get("cl_paused");
    if (paused === undefined) throw new Error("Client userinfo requires registered cl_paused");
    if (paused.integerValue !== 0 || (cvars.modifiedFlags & CvarFlag.UserInfo) === 0) return;
    cvars.clearModifiedFlags(CvarFlag.UserInfo);
    const info = cvars.infoString(CvarFlag.UserInfo);
    this.options.assertCurrentOperation();
    try { clc.reliable.add(`userinfo "${info}"`); }
    catch (error) {
      if (error instanceof ReliableOverflowError) throw new CommonError("drop", error.message);
      throw error;
    }
  }

  /** After disconnect, console closure and successful resolution; key catchers remain the input owner's responsibility. */
  beginResolved(servername: string, address: ClientPacketAddress): void {
    this.options.assertCurrentOperation();
    const { clientStatic: cls, clientConnection: clc, cvars } = this.options;
    if (cls.phase !== "disconnected") throw new Error("Client admission requires a disconnected client");
    const server = sourceCommandText(servername);
    if (address.kind === "ipv4" && (address.host.some(value => !Number.isInteger(value) || value < 0 || value > 255)
      || !Number.isInteger(address.port) || address.port < 0 || address.port > 65535)) {
      throw new RangeError("Client admission requires a resolved IPv4 address");
    }
    cls.servername = server.slice(0, 4095); // Unix MAX_OSPATH.
    clc.serverAddress = copyAddress(address.kind === "ipv4" && address.port === 0 ? { ...address, port: 27960 } : address);
    this.channel = null;
    this.print(`${cls.servername} resolved to ${clc.serverAddress.kind === "loopback" ? "0.0.0.0:27960" : addressText(clc.serverAddress)}\n`);
    cls.phase = clc.serverAddress.kind === "loopback" ? "challenging" : "connecting";
    clc.connectTime = -99999;
    clc.connectPacketCount = 0;
    cvars.set("cl_currentServerAddress", server, true);
    this.options.assertCurrentOperation();
  }

  async checkForResend(): Promise<void> {
    this.options.assertCurrentOperation();
    const { clientStatic: cls, clientConnection: clc, cvars } = this.options;
    if (clc.demoPlaying || (cls.phase !== "connecting" && cls.phase !== "challenging")) return;
    if (clockInt32(cls.realtime - clc.connectTime, "realtime - connectTime") < 3000) return;
    clc.connectTime = cls.realtime;
    clc.connectPacketCount = clockInt32(clc.connectPacketCount + 1, "connectPacketCount + 1");
    switch (cls.phase) {
      case "connecting":
        if (!this.options.io.lan.isLanAddress(this.serverAddress())) {
          await this.options.authorization.request(() => { this.options.assertCurrentOperation(); });
          this.options.assertCurrentOperation();
        }
        this.send(this.serverAddress(), encodeConnectionlessText("getchallenge"));
        break;
      case "challenging": {
        const port = this.qport();
        let info = cvars.infoString(CvarFlag.UserInfo).slice(0, 1023);
        this.options.assertCurrentOperation();
        info = infoSetValueForKey(info, "protocol", "68", text => { this.print(text); });
        info = infoSetValueForKey(info, "qport", String(port), text => { this.print(text); });
        info = infoSetValueForKey(info, "challenge", String(clc.challenge), text => { this.print(text); });
        this.send(this.serverAddress(), encodeConnect(info));
        cvars.clearModifiedFlags(CvarFlag.UserInfo);
        break;
      }
      default: throw new CommonError("fatal", "CL_CheckForResend: bad cls.state");
    }
  }

  /** Unhandled connectionless commands go to their actual owners; sequenced bytes go to the admitted session. */
  packetEvent(from: ClientPacketAddress, bytes: Uint8Array): ClientAdmissionPacket {
    this.options.assertCurrentOperation();
    const { clientStatic: cls, clientConnection: clc } = this.options;
    clc.lastPacketTime = cls.realtime;
    if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 255 && bytes[2] === 255 && bytes[3] === 255) {
      const packet = decodeConnectionless(bytes, "client");
      this.debugPrint(`CL packet ${addressText(from)}: ${packet.command}\n`);
      switch (packet.command.toLowerCase()) {
        case "challengeresponse":
          if (cls.phase !== "connecting") this.print("Unwanted challenge response received.  Ignored.\n");
          else {
            clc.challenge = nativeAtoi(packet.arguments[0] ?? ""); // Cmd_Argv outside argc is the empty string.
            cls.phase = "challenging";
            clc.connectPacketCount = 0;
            clc.connectTime = -99999;
            clc.serverAddress = copyAddress(from); // Source allows a proxy to hand off to a different address.
            this.debugPrint(`challengeResponse: ${clc.challenge}\n`);
          }
          return { kind: "handled" };
        case "connectresponse": {
          if (connected(cls.phase)) this.print("Dup connect received.  Ignored.\n");
          else if (cls.phase !== "challenging") this.print("connectResponse packet while not connecting.  Ignored.\n");
          else if (!sameBase(from, this.serverAddress())) {
            this.print("connectResponse from a different address.  Ignored.\n");
            this.print(`${addressText(from)} should have been ${addressText(this.serverAddress())}\n`);
          } else {
            // Netchan_Setup inputs are captured now, including the responder's possibly changed port.
            this.channel = Object.freeze({ mode: Object.freeze({ kind: "network", challenge: clc.challenge, qport: this.qport() & 65535 }),
              remoteAddress: copyAddress(from) });
            cls.phase = "connected";
            clc.lastPacketSentTime = -9999;
            return { kind: "admitted", connection: this.channel };
          }
          return { kind: "handled" };
        }
        case "print": {
          let text = "";
          for (const byte of packet.payload) {
            if (byte === 0 || text.length === 1023) break;
            text += String.fromCharCode(byte === 37 || byte > 127 ? 46 : byte);
          }
          clc.serverMessage = text;
          this.print(text);
          return { kind: "handled" };
        }
        default: return { kind: "connectionless", packet };
      }
    }
    if (!connected(cls.phase)) return { kind: "handled" };
    if (bytes.length < 4) { this.print(`${addressText(from)}: Runt packet\n`); return { kind: "handled" }; }
    const channel = this.channel;
    // Demo playback has no admitted channel, matching the source's NA_BAD remote address.
    if (channel === null) {
      this.debugPrint(`${addressText(from)}:sequenced packet without connection\n`);
      return { kind: "handled" };
    }
    const remote = channel.remoteAddress;
    if (!sameBase(from, remote) || (from.kind === "ipv4" && remote.kind === "ipv4" && from.port !== remote.port)) {
      this.debugPrint(`${addressText(from)}:sequenced packet without connection\n`);
      return { kind: "handled" };
    }
    return { kind: "sequenced", payload: new Uint8Array(bytes) };
  }

  private serverAddress(): ClientPacketAddress {
    const address = this.options.clientConnection.serverAddress;
    if (address === null) throw new Error("Client admission has no resolved server address");
    return address;
  }

  private qport(): number {
    const cvar = this.options.cvars.get("net_qport");
    // Cvar_VariableValue returns zero for an absent name, and converts through float.
    const value = Math.fround(cvar === undefined ? 0 : cvar.numericValue);
    if (!Number.isFinite(value) || value < -2147483648 || value >= 2147483648) {
      throw new RangeError("Undefined native net_qport float-to-int conversion");
    }
    return Math.trunc(value);
  }

  private send(to: ClientPacketAddress, bytes: Uint8Array): void {
    if (to.kind === "loopback") this.options.loopback.send("client", bytes);
    else {
      const udp = this.options.io.udp;
      if (udp !== null && !udp.send(to, bytes)) this.debugPrint("Sys_SendPacket: UDP socket could not queue packet\n");
    }
    this.options.assertCurrentOperation();
  }

  private print(text: string): void { this.options.print(text); this.options.assertCurrentOperation(); }
  private debugPrint(text: string): void {
    const developer = this.options.cvars.get("developer");
    if (developer !== undefined && developer.integerValue !== 0) this.print(text);
  }
}
