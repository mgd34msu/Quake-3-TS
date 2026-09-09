// NET_OutOfBandPrint/Data, CL_CheckForResend and client/server connectionless reads.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { BinaryError } from "../core/binary.ts";
import { tokenizeCommand } from "../core/text.ts";
import { compressAdaptive, decompressAdaptive } from "./huffman.ts";
import { MAX_MESSAGE_LENGTH } from "./message.ts";

const MAX_PACKET_LENGTH = MAX_MESSAGE_LENGTH - 1;
const CONNECT_OFFSET = 12;
const MAX_LINE_LENGTH = 1023;
const MAX_CONNECT_INFO_LENGTH = 1013;
const connectWord = [99, 111, 110, 110, 101, 99, 116];

export interface ConnectionlessPacket {
  readonly command: string;
  readonly arguments: readonly string[];
  /** MSG_ReadStringLine: percent becomes dot; high bytes remain Latin-1. */
  readonly line: string;
  /** Owned bytes after the consumed line delimiter, without text sanitization. */
  readonly payload: Uint8Array;
  readonly compression: "none" | "adaptive";
  readonly lineEnding: "newline" | "nul" | "end" | "limit";
  /** Source readcount in decompressed bytes, including its EOF read past the end. */
  readonly readCount: number;
}

function cString(text: string): string {
  const nul = text.indexOf("\0");
  return nul < 0 ? text : text.slice(0, nul);
}

function latin1(text: string, maximum: number): Uint8Array {
  if (text.length > maximum) throw new RangeError(`Connectionless text exceeds ${maximum} source bytes`);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const byte = text.charCodeAt(i);
    if (byte > 255) throw new RangeError("Connectionless text must be Latin-1 source bytes");
    bytes[i] = byte;
  }
  return bytes;
}

/** NET_OutOfBandPrint sends strlen bytes, not its terminating NUL. */
export function encodeConnectionlessText(text: string): Uint8Array {
  const body = latin1(cString(text), MAX_PACKET_LENGTH - 4);
  const packet = new Uint8Array(body.length + 4);
  packet.fill(255, 0, 4);
  packet.set(body, 4);
  return packet;
}

/** Userinfo already contains protocol, qport and challenge supplied by the caller. */
export function encodeConnect(userinfo: string): Uint8Array {
  const info = cString(userinfo);
  if (info.includes('"') || info.includes("\n")) throw new RangeError("Connect userinfo cannot contain a quote or newline");
  latin1(info, MAX_CONNECT_INFO_LENGTH);
  const packet = encodeConnectionlessText(`connect "${info}"`);
  const compressed = compressAdaptive(packet.subarray(CONNECT_OFFSET));
  const encoded = new Uint8Array(CONNECT_OFFSET + compressed.length);
  encoded.set(packet.subarray(0, CONNECT_OFFSET));
  encoded.set(compressed, CONNECT_OFFSET);
  return encoded;
}

/** Native x86 Cmd_TokenizeString's signed char comparisons differ from Unicode. */
function commandWhitespace(line: string): string {
  let mode: "regular" | "quoted" | "comment" = "regular";
  let normalized = "";
  for (let i = 0; i < line.length; i++) {
    const character = line.charAt(i);
    if (mode === "comment") {
      normalized += character;
      if (line.startsWith("*/", i)) { normalized += "/"; i++; mode = "regular"; }
    } else if (mode === "quoted") {
      normalized += character;
      if (character === '"') mode = "regular";
    } else {
      if (line.startsWith("//", i)) return normalized + line.slice(i);
      if (line.startsWith("/*", i)) { normalized += "/*"; i++; mode = "comment"; }
      else {
        normalized += character.charCodeAt(0) > 127 ? " " : character;
        if (character === '"') mode = "quoted";
      }
    }
  }
  return normalized;
}

/** Receiver matters: a client must not decompress the plain connectResponse. */
export function decodeConnectionless(packet: Uint8Array, receiver: "client" | "server", source = "<connectionless>"): ConnectionlessPacket {
  if (packet.length < 4) throw new BinaryError(source, 0, "Truncated connectionless marker");
  if (packet.length > MAX_PACKET_LENGTH) throw new BinaryError(source, 0, "Connectionless datagram exceeds source receive limit");
  for (let i = 0; i < 4; i++) if (packet[i] !== 255) throw new BinaryError(source, i, "Invalid connectionless marker");
  let data = new Uint8Array(packet);
  let compression: ConnectionlessPacket["compression"] = "none";
  if (receiver === "server" && connectWord.every((byte, index) => packet[index + 4] === byte) && packet.length > CONNECT_OFFSET) {
    try {
      const expanded = decompressAdaptive(packet.subarray(CONNECT_OFFSET), MAX_MESSAGE_LENGTH - CONNECT_OFFSET);
      data = new Uint8Array(CONNECT_OFFSET + expanded.length);
      data.set(packet.subarray(0, CONNECT_OFFSET));
      data.set(expanded, CONNECT_OFFSET);
      compression = "adaptive";
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new BinaryError(source, CONNECT_OFFSET, `Malformed compressed connectionless payload: ${error.message}`);
    }
  }
  let line = "";
  let offset = 4;
  let lineEnding: ConnectionlessPacket["lineEnding"] = "limit";
  while (line.length < MAX_LINE_LENGTH) {
    const byte = data[offset++];
    if (byte === undefined) { lineEnding = "end"; break; }
    if (byte === 0) { lineEnding = "nul"; break; }
    if (byte === 10) { lineEnding = "newline"; break; }
    line += String.fromCharCode(byte === 37 ? 46 : byte);
  }
  const tokens = tokenizeCommand(commandWhitespace(line));
  return { command: tokens[0] ?? "", arguments: tokens.slice(1), line, payload: data.slice(offset), compression, lineEnding, readCount: offset };
}
