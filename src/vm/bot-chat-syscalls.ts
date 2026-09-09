/*
 * Bot chat traps from id Software's server/sv_game.c and game/g_public.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { stringContains, unifyWhiteSpacesInPlace } from "../botlib/chat.ts";
import type { BotChatLibrary, ChatTextSource, ChatVariableSources } from "../botlib/chat.ts";
import { runCalls } from "../core/call-steps.ts";
import { QVM_CONSOLE_MESSAGE_BYTES, qvmBotMatchBuffer, writeQvmConsoleMessage } from "./bot-chat-record.ts";
import type { QvmMemory } from "./memory.ts";

function sourceText(bytes: Uint8Array | null, count?: number, offset = 0): string {
  if (count === 0) return "";
  if (bytes === null) throw new RangeError("QVM bot chat string requires a nonnull pointer");
  let result = "";
  for (let index = 0; count === undefined || index < count; index++) {
    const byte = bytes[offset + index];
    if (byte === undefined) throw new RangeError("QVM bot chat string exceeds allocation");
    if (byte === 0) break;
    result += String.fromCharCode(byte);
  }
  return result;
}

function textSource(memory: QvmMemory, word: number): ChatTextSource {
  return count => sourceText(memory.pointer(word), count);
}

function variables(words: DataView, offset: number, memory: QvmMemory): ChatVariableSources {
  const variable = (index: number): ChatTextSource | null => {
    const word = words.getInt32(offset + index * 4, true);
    return word === 0 ? null : textSource(memory, word);
  };
  return [variable(0), variable(1), variable(2), variable(3), variable(4), variable(5), variable(6), variable(7)];
}

/** Borrows the actual chat owner; arguments are words, strings remain live. */
export function qvmBotChatSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, chat: BotChatLibrary,
): number | Promise<number> | null {
  if (role !== "game") return null;
  switch (words.getInt32(0, true)) {
    case 507: return chat.allocate();
    case 508: chat.free(words.getInt32(4, true)); return 0;
    case 509: {
      const handle = words.getInt32(4, true), type = words.getInt32(8, true), messageWord = words.getInt32(12, true);
      chat.queueConsoleMessage(handle, type, textSource(memory, messageWord));
      return 0;
    }
    case 510: {
      const handle = words.getInt32(4, true), message = words.getInt32(8, true);
      chat.removeConsoleMessage(handle, message);
      return 0;
    }
    case 511: {
      const handle = words.getInt32(4, true), outputWord = words.getInt32(8, true);
      const message = chat.nextConsoleMessage(handle);
      if (message === null) return 0;
      writeQvmConsoleMessage(memory.view(outputWord, QVM_CONSOLE_MESSAGE_BYTES), message);
      return message.handle;
    }
    case 512: return chat.numConsoleMessages(words.getInt32(4, true));
    case 513: {
      const handle = words.getInt32(4, true), typeWord = words.getInt32(8, true), context = words.getInt32(12, true);
      const values = variables(words, 16, memory);
      chat.initialChat(handle, typeWord === 0 ? null : textSource(memory, typeWord), context, values);
      return 0;
    }
    case 514: {
      const handle = words.getInt32(4, true), messageWord = words.getInt32(8, true);
      const messageContext = words.getInt32(12, true), variableContext = words.getInt32(16, true);
      const values = variables(words, 20, memory);
      return Number(chat.replyChat(handle, textSource(memory, messageWord), messageContext, variableContext, values));
    }
    case 515: return chat.chatLength(words.getInt32(4, true));
    case 516: {
      const handle = words.getInt32(4, true), client = words.getInt32(8, true), destination = words.getInt32(12, true);
      const result = runCalls(chat.enterChatCalls(handle, client, destination));
      return result instanceof Promise ? result.then(() => 0) : 0;
    }
    case 517: {
      const inputWord = words.getInt32(4, true), needleWord = words.getInt32(8, true), sensitive = words.getInt32(12, true);
      return stringContains(inputWord === 0 ? null : textSource(memory, inputWord),
        needleWord === 0 ? null : textSource(memory, needleWord), sensitive !== 0);
    }
    case 518: {
      const inputWord = words.getInt32(4, true), outputWord = words.getInt32(8, true), context = words.getInt32(12, true);
      return Number(chat.findMatchInto(textSource(memory, inputWord), context, qvmBotMatchBuffer(memory.pointer(outputWord))));
    }
    case 519: {
      const matchWord = words.getInt32(4, true), index = words.getInt32(8, true);
      const outputWord = words.getInt32(12, true), capacity = words.getInt32(16, true);
      const match = qvmBotMatchBuffer(memory.pointer(matchWord));
      chat.writeMatchVariable(variableIndex => {
        const value = match.variables[variableIndex];
        if (value === undefined) throw new RangeError("QVM match variable outside 0..7");
        return value;
      }, index, capacity, (offset, size) => {
        if (!Number.isInteger(size) || size < 1) throw new RangeError("QVM match output size must be positive");
        memory.writeBoundedString(outputWord, sourceText(match.string, size - 1, offset), size);
      }, () => { memory.view(outputWord, 1).setUint8(0, 0); });
      return 0;
    }
    case 520: {
      const inputWord = words.getInt32(4, true);
      unifyWhiteSpacesInPlace(memory.pointer(inputWord));
      return 0;
    }
    case 521: {
      const inputWord = words.getInt32(4, true), context = words.getInt32(8, true);
      chat.replaceSynonymsInPlace(() => memory.pointer(inputWord), context);
      return 0;
    }
    case 522: {
      const handle = words.getInt32(4, true), fileWord = words.getInt32(8, true), nameWord = words.getInt32(12, true);
      return chat.loadChatFile(handle, textSource(memory, fileWord), textSource(memory, nameWord)) ? 0 : 8;
    }
    case 523: {
      const handle = words.getInt32(4, true), gender = words.getInt32(8, true);
      chat.setGender(handle, gender);
      return 0;
    }
    case 524: {
      const handle = words.getInt32(4, true), nameWord = words.getInt32(8, true), client = words.getInt32(12, true);
      chat.setName(handle, textSource(memory, nameWord), client);
      return 0;
    }
    case 569: {
      const handle = words.getInt32(4, true), typeWord = words.getInt32(8, true);
      return chat.numInitialChats(handle, typeWord === 0 ? null : textSource(memory, typeWord));
    }
    case 570: {
      const handle = words.getInt32(4, true), outputWord = words.getInt32(8, true), capacity = words.getInt32(12, true);
      chat.writeChatMessage(handle, text => { memory.writeBoundedString(outputWord, text, capacity); });
      return 0;
    }
    default: return null;
  }
}
