/*
 * bot_consolemessage_t and bot_match_t from id Software's game/be_ai_chat.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { ChatMatchBuffer, ChatMatchVariable, ConsoleChatMessage } from "../botlib/chat.ts";

export const QVM_CONSOLE_MESSAGE_BYTES = 276;
export const QVM_BOT_MATCH_BYTES = 328;

/** BotNextConsoleMessage copies the whole record, then clears both links. */
export function writeQvmConsoleMessage(view: DataView, message: ConsoleChatMessage): void {
  if (view.byteLength < QVM_CONSOLE_MESSAGE_BYTES) throw new RangeError("QVM console message requires 276 bytes");
  view.setInt32(0, message.handle, true);
  view.setFloat32(4, message.time, true);
  view.setInt32(8, message.type, true);
  for (let index = 0; index < 256; index++) {
    view.setUint8(12 + index, index < message.message.length ? message.message.charCodeAt(index) : 0);
  }
  view.setInt32(268, 0, true);
  view.setInt32(272, 0, true);
}

function field(bytes: Uint8Array | null, offset: number, length: number): DataView {
  if (bytes === null) throw new RangeError("QVM bot match requires a nonnull pointer");
  if (offset + length > bytes.length) throw new RangeError("QVM bot match field exceeds allocation");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, length);
}

function variable(bytes: Uint8Array | null, index: number): ChatMatchVariable {
  const offset = 264 + index * 8;
  return {
    get offset(): number { return field(bytes, offset, 1).getInt8(0); },
    set offset(value: number) { field(bytes, offset, 1).setInt8(0, value); },
    get length(): number { return field(bytes, offset + 4, 4).getInt32(0, true); },
    set length(value: number) { field(bytes, offset + 4, 4).setInt32(0, value, true); },
  };
}

/** Field access remains live so failed templates retain their partial writes. */
export function qvmBotMatchBuffer(bytes: Uint8Array | null): ChatMatchBuffer {
  return {
    string: bytes,
    get type(): number { return field(bytes, 256, 4).getInt32(0, true); },
    set type(value: number) { field(bytes, 256, 4).setInt32(0, value, true); },
    get subtype(): number { return field(bytes, 260, 4).getInt32(0, true); },
    set subtype(value: number) { field(bytes, 260, 4).setInt32(0, value, true); },
    variables: [variable(bytes, 0), variable(bytes, 1), variable(bytes, 2), variable(bytes, 3),
      variable(bytes, 4), variable(bytes, 5), variable(bytes, 6), variable(bytes, 7)],
  };
}
