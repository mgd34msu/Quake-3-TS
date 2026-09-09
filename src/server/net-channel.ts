// Port of id Software's server/sv_net_chan.c and sv_main.c SV_PacketEvent.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { Ipv4Address } from "../platform/network.ts";
import { runCalls } from "../core/call-steps.ts";
import type { CallSteps } from "../core/call-steps.ts";
import { ClientMessageReader } from "../protocol/client-message.ts";
import { encodeConnectionlessText } from "../protocol/connectionless.ts";
import type { LoopbackAddress } from "../protocol/loopback.ts";
import { MAX_MESSAGE_LENGTH, MessageWriter, SourceMessageState } from "../protocol/message.ts";
import { xorClientMessage, xorServerMessage } from "../protocol/netchan.ts";
import type { ChannelDelivery, ChannelDiagnostics } from "../protocol/netchan.ts";
import { ServerOpcode } from "../protocol/server-message.ts";
import { ServerClientPhase } from "./state.ts";
import type { ServerAddress, ServerClient, ServerStaticState } from "./state.ts";

export type ServerPacketAddress = Ipv4Address | LoopbackAddress;
export type ServerChannelMessage =
  | { readonly kind: "writer"; readonly message: MessageWriter }
  | { readonly kind: "complete"; readonly payload: Uint8Array };

export interface ServerNetChannelHost {
  sendPacket(to: ServerPacketAddress, payload: Uint8Array): undefined;
  tracePacket(message: string): undefined;
  debugPrint(text: string): undefined;
  connectionless(from: ServerPacketAddress, payload: Uint8Array): Promise<void>;
  executeClientMessage(client: ServerClient, reader: ClientMessageReader): CallSteps;
  print(text: string): void;
}

function sameBaseAddress(from: ServerPacketAddress, address: ServerAddress): boolean {
  if (from.kind === "loopback") return address.kind === "loopback";
  return address.kind === "ipv4" && from.host.every((octet, index) => octet === address.host[index]);
}
function ownedAddress(address: ServerPacketAddress): ServerPacketAddress {
  if (address.kind === "loopback") return { kind: "loopback" };
  return { kind: "ipv4", host: [...address.host], port: address.port };
}

/** Pacing and admission remain in the server frame/client-command owners. */
export class ServerNetChannelRuntime {
  constructor(readonly state: ServerStaticState, readonly host: ServerNetChannelHost,
    private readonly diagnostics: Omit<ChannelDiagnostics, "remoteAddress"> | null = null,
    readonly sourceState = new SourceMessageState(text => { host.print(text); })) {}

  private connection(client: ServerClient) {
    if (this.state.clients[client.slot] !== client) throw new Error("Client does not belong to this server");
    const connection = client.connection;
    if (connection.kind !== "initialized") throw new Error("Server client channel is uninitialized");
    if (connection.netchan.role !== "server" && connection.address.kind !== "bot") throw new Error("Server client needs a server netchannel");
    return connection;
  }

  private send(client: ServerClient, packet: Uint8Array): undefined {
    const connection = this.connection(client), address = connection.address;
    // NET_SendPacket discards NA_BOT delivery while its caller advances the retained channel.
    if (address.kind === "bot") return;
    this.host.sendPacket(ownedAddress(address), packet);
  }

  private delivery(client: ServerClient): ChannelDelivery {
    return { sourceState: this.sourceState, send: packet => this.send(client, packet), trace: message => this.host.tracePacket(message) };
  }

  private begin(client: ServerClient, plaintext: Uint8Array): void {
    const channel = this.connection(client).netchan;
    const encoded = xorServerMessage(plaintext, client.challenge, channel.outgoingSequence, client.lastClientCommandString);
    channel.beginTransmit(encoded, this.delivery(client));
  }

  /** A writer is unfinished; complete payloads already include encodeServerMessage's svc_EOF. */
  transmit(client: ServerClient, input: ServerChannelMessage): void {
    const channel = this.connection(client).netchan;
    let plaintext: Uint8Array;
    if (input.kind === "writer") {
      if (input.message.mode !== "bitstream") throw new Error("Server messages require the compressed bitstream writer");
      input.message.writeByte(ServerOpcode.Eof);
      // SV_Netchan_Transmit does not recheck overflow after attempting the EOF write.
      plaintext = input.message.toBytes();
    } else {
      if (input.payload.length > MAX_MESSAGE_LENGTH) throw new RangeError("Server message exceeds MAX_MSGLEN");
      plaintext = new Uint8Array(input.payload);
    }
    if (channel.hasUnsentFragments) {
      this.host.debugPrint("#462 SV_Netchan_Transmit: unsent fragments, stacked\n");
      client.queuedMessages.push(plaintext);
      if (!channel.transmitNextFragment(this.delivery(client))) throw new Error("Missing pending server fragment");
      // This source path does not pop the queue, even when it just sent the last fragment.
    } else this.begin(client, plaintext);
  }

  /** Source SV_SendClientMessages calls this only while unsentFragments is set. */
  transmitNextFragment(client: ServerClient): void {
    const channel = this.connection(client).netchan;
    if (!channel.hasUnsentFragments) throw new Error("No pending server fragments");
    if (!channel.transmitNextFragment(this.delivery(client))) throw new Error("Missing pending server fragment");
    if (!channel.hasUnsentFragments) {
      const queued = client.queuedMessages[0];
      if (queued !== undefined) {
        this.host.debugPrint("#462 Netchan_TransmitNextFragment: popping a queued message for transmit\n");
        this.begin(client, queued);
        client.queuedMessages.shift();
        if (client.queuedMessages.length === 0) this.host.debugPrint("#462 Netchan_TransmitNextFragment: emptied queue\n");
        else this.host.debugPrint("#462 Netchan_TransmitNextFragment: remaining queued message\n");
      }
    }
  }

  async packetEvent(from: ServerPacketAddress, packet: Uint8Array): Promise<void> {
    if (packet.length >= 4 && packet[0] === 255 && packet[1] === 255 && packet[2] === 255 && packet[3] === 255) {
      await this.host.connectionless(ownedAddress(from), new Uint8Array(packet));
      return;
    }
    // MSG_ReadShort's truncated result is -1, then SV_PacketEvent masks it to 65535.
    const qport = packet.length >= 6 ? new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint16(4, true) : 65535;
    for (const client of this.state.clients) {
      const connection = client.connection;
      if (connection.phase === ServerClientPhase.Free || connection.kind !== "initialized") continue;
      if (!sameBaseAddress(from, connection.address) || connection.netchan.qport !== qport) continue;
      if (from.kind === "ipv4" && connection.address.kind === "ipv4" && connection.address.port !== from.port) {
        this.host.print("SV_PacketEvent: fixing up a translated port\n");
        connection.address = { ...connection.address, port: from.port };
      }
      const channel = this.connection(client).netchan;
      const diagnostics = this.diagnostics;
      const received = channel.receive(packet, diagnostics === null ? null : {
        get showPackets() { return diagnostics.showPackets; },
        get showDrop() { return diagnostics.showDrop; },
        get remoteAddress() {
          const address = connection.address;
          return address.kind === "ipv4" ? `${address.host.join(".")}:${address.port}` : address.kind;
        },
        print: text => diagnostics.print(text),
      });
      if (received.kind === "accepted") {
        const plaintext = xorClientMessage(received.payload, client.challenge, acknowledge => client.reliable.lookupMasked(acknowledge));
        if (client.phase !== ServerClientPhase.Zombie) {
          client.lastPacketTime = this.state.time;
          await runCalls(this.host.executeClientMessage(client, new ClientMessageReader(plaintext)));
        }
      }
      return;
    }
    this.host.sendPacket(ownedAddress(from), encodeConnectionlessText("disconnect"));
  }
}
