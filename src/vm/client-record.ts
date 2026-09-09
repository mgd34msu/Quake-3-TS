// Port of id Software code/cgame/tr_types.h, cg_public.h, ui/ui_public.h,
// game/q_shared.h, client/cl_ui.c:GetClientState and client/cl_cgame.c getters.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { BinaryError } from "../core/binary.ts";
import type { ClientConnectionPhase, ClientConnectionState, ClientStaticState } from "../engine/client-state.ts";
import type { ClientActiveState } from "../engine/client-active.ts";
import type { SourceGameStateRecord } from "../engine/game-state.ts";
import type { Snapshot } from "../protocol/server-message.ts";
import type { RendererConfigurationSnapshot } from "../render/configuration.ts";
import { QVM_ENTITY_STATE_BYTES, writeQvmEntityState } from "./entity-record.ts";
import { QVM_PLAYER_STATE_BYTES, writeQvmPlayerState } from "./player-record.ts";

export const QVM_GL_CONFIG_BYTES = 11332;
export const QVM_UI_CLIENT_STATE_BYTES = 3084;
export const QVM_SNAPSHOT_BYTES = 53772;
export const QVM_GAME_STATE_BYTES = 20100;

function requireBytes(view: DataView, size: number, record: string): void {
  if (view.byteLength < size) throw new BinaryError(record, 0,
    `record requires ${size} bytes, received ${view.byteLength}`);
}

function byteStringLength(value: string, capacity: number): number {
  const limit = Math.min(value.length, capacity - 1);
  for (let index = 0; index < limit; index++) {
    const byte = value.charCodeAt(index);
    if (byte === 0) return index;
    if (byte > 255) throw new RangeError("QVM client record strings require source byte characters");
  }
  return limit;
}

// Q_strncpyz uses strncpy(dest, src, capacity - 1), then writes the last NUL.
function writeString(view: DataView, offset: number, capacity: number, value: string, length: number): void {
  for (let index = 0; index < capacity; index++) {
    view.setUint8(offset + index, index < length ? value.charCodeAt(index) : 0);
  }
}

/** CPU uses the ordinary GLDRV_ICD compatibility branch without claiming a native GL driver.
 * Its maximum is RgbaSnapshot's signed-int32 dimension ceiling; allocations can still fail.
 */
export function writeQvmGlConfig(view: DataView, value: RendererConfigurationSnapshot): void {
  requireBytes(view, QVM_GL_CONFIG_BYTES, "QVM glconfig_t");
  const rendererLength = byteStringLength(value.rendererString, 1024);
  const vendorLength = byteStringLength(value.vendorString, 1024);
  const versionLength = byteStringLength(value.versionString, 1024);
  const extensionsLength = byteStringLength(value.extensionsString, 8192);
  writeString(view, 0, 1024, value.rendererString, rendererLength);
  writeString(view, 1024, 1024, value.vendorString, vendorLength);
  writeString(view, 2048, 1024, value.versionString, versionLength);
  writeString(view, 3072, 8192, value.extensionsString, extensionsLength);
  view.setInt32(11264, value.backend === "cpu" ? 0x7fffffff : value.maxTextureSize, true);
  view.setInt32(11268, value.maxActiveTextures, true);
  view.setInt32(11272, value.colorBits, true);
  view.setInt32(11276, value.depthBits, true);
  view.setInt32(11280, value.stencilBits, true);
  view.setInt32(11284, 0, true); // GLDRV_ICD
  view.setInt32(11288, 0, true); // GLHW_GENERIC
  view.setInt32(11292, Number(value.deviceSupportsGamma), true);
  view.setInt32(11296, value.textureCompression === "s3tc" ? 1 : 0, true); // TC_S3TC / TC_NONE
  view.setInt32(11300, Number(value.textureEnvAddAvailable), true);
  view.setInt32(11304, value.vidWidth, true);
  view.setInt32(11308, value.vidHeight, true);
  view.setFloat32(11312, value.windowAspect, true);
  view.setInt32(11316, value.displayFrequency, true);
  view.setInt32(11320, Number(value.isFullscreen), true);
  view.setInt32(11324, Number(value.stereoEnabled), true);
  view.setInt32(11328, Number(value.smpActive), true);
}

function connectionState(phase: ClientConnectionPhase): number {
  switch (phase) {
    case "uninitialized": return 0;
    case "disconnected": return 1;
    // CA_AUTHORIZING is unused in this source and has no engine phase.
    case "connecting": return 3;
    case "challenging": return 4;
    case "connected": return 5;
    case "loading": return 6;
    case "primed": return 7;
    case "active": return 8;
    case "cinematic": return 9;
  }
}

/** Reads the actual client lifetimes, including cl.snap.ps after CL_ClearState. */
export function writeQvmUiClientState(view: DataView, clientStatic: ClientStaticState,
  connection: ClientConnectionState, active: Pick<ClientActiveState, "readSnapshotClientNumber">): void {
  requireBytes(view, QVM_UI_CLIENT_STATE_BYTES, "QVM uiClientState_t");
  const serverLength = byteStringLength(clientStatic.servername, 1024);
  const updateLength = byteStringLength(clientStatic.updateInfoString, 1024);
  const messageLength = byteStringLength(connection.serverMessage, 1024);
  const clientNumber = active.readSnapshotClientNumber();
  view.setInt32(0, connectionState(clientStatic.phase), true);
  view.setInt32(4, connection.connectPacketCount, true);
  view.setInt32(8, clientNumber, true);
  writeString(view, 12, 1024, clientStatic.servername, serverLength);
  writeString(view, 1036, 1024, clientStatic.updateInfoString, updateLength);
  writeString(view, 2060, 1024, connection.serverMessage, messageLength);
}

/** Copies the actual session allocation, including duplicate-string storage and unused bytes. */
export function writeQvmGameState(view: DataView, value: SourceGameStateRecord): void {
  requireBytes(view, QVM_GAME_STATE_BYTES, "QVM gameState_t");
  if (value.stringOffsets.length !== 1024 || value.stringData.length !== 16000) {
    throw new RangeError("QVM gameState_t requires the complete source allocation");
  }
  for (const [index, offset] of value.stringOffsets.entries()) view.setInt32(index * 4, offset, true);
  new Uint8Array(view.buffer, view.byteOffset + 4096, 16000).set(value.stringData);
  view.setInt32(20096, value.dataCount, true);
}

/** Caller applies the cgame role/history gate using SnapshotSource.read and session.snapshotPing.
 * CL_GetSnapshot preserves numServerCommands and all inactive entity slots, including on reuse.
 */
export function writeQvmSnapshot(view: DataView, value: Snapshot, ping: number): void {
  requireBytes(view, QVM_SNAPSHOT_BYTES, "QVM snapshot_t");
  if (value.areaMask.byteLength !== 32 || value.entities.length > 256) {
    throw new RangeError("QVM snapshot_t requires the bounded SnapshotSource.read result");
  }
  view.setInt32(0, value.flags, true);
  view.setInt32(4, ping, true);
  view.setInt32(8, value.serverTime, true);
  new Uint8Array(view.buffer, view.byteOffset + 12, 32).set(value.areaMask);
  writeQvmPlayerState(new DataView(view.buffer, view.byteOffset + 44, QVM_PLAYER_STATE_BYTES), value.playerState);
  view.setInt32(512, value.entities.length, true);
  for (const [index, entity] of value.entities.entries()) {
    writeQvmEntityState(new DataView(view.buffer, view.byteOffset + 516 + index * QVM_ENTITY_STATE_BYTES,
      QVM_ENTITY_STATE_BYTES), entity);
  }
  view.setInt32(53768, value.serverCommandNumber, true);
}
