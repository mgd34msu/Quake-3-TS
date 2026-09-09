// Hand-counted 32-bit layouts from id Software cg_public.h, tr_types.h and ui_public.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { describe, expect, test } from "bun:test";
import { BinaryError } from "../src/core/binary.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { ClientActiveState } from "../src/engine/client-active.ts";
import { ClientConnectionState, ClientStaticState } from "../src/engine/client-state.ts";
import type { ClientConnectionPhase } from "../src/engine/client-state.ts";
import { SnapshotHistory } from "../src/cgame/snapshot-history.ts";
import { HistorySnapshotSource } from "../src/cgame/snapshots.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { Snapshot } from "../src/protocol/server-message.ts";
import type { RendererConfigurationSnapshot } from "../src/render/configuration.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { QVM_GAME_STATE_BYTES, QVM_GL_CONFIG_BYTES, QVM_SNAPSHOT_BYTES, QVM_UI_CLIENT_STATE_BYTES,
  writeQvmGameState, writeQvmGlConfig, writeQvmSnapshot, writeQvmUiClientState } from "../src/vm/client-record.ts";
import { createProtocolClientSession } from "../tools/client-protocol-fixture.ts";

function destination(length: number) {
  const bytes = new Uint8Array(length + 14).fill(0xa5);
  return { bytes, view: new DataView(bytes.buffer, 7, length) };
}

function configuration(): RendererConfigurationSnapshot {
  return { backend: "gl", driverType: "icd", maxTextureSize: 16384, depthStorage: "driver",
    rendererString: "driver\xff", vendorString: "vendor", versionString: "1.2", extensionsString: "EXT\xe9",
    maxActiveTextures: 2, colorBits: 24, depthBits: 32, stencilBits: 8, hardwareType: "generic",
    deviceSupportsGamma: true, gamma: { kind: "api-accepted", displayIndex: 0, displayName: "fixture" },
    textureCompression: "none", compiledVertexArrays: false, textureEnvAddAvailable: true, vidWidth: 1920, vidHeight: 1080,
    windowAspect: 16 / 9, displayFrequency: 144, isFullscreen: true, stereoEnabled: false, smpActive: false };
}

function snapshot(entities: readonly EntityState[] = []): Snapshot {
  return { messageNumber: 7, serverTime: 12345, deltaNumber: -1, flags: 5, serverCommandNumber: 37,
    parseEntitiesNumber: 0, areaMask: new Uint8Array(32), playerState: new PlayerState("missionpack"), entities };
}

describe("QVM client records", () => {
  test("source C record sizes", () => {
    expect([QVM_GL_CONFIG_BYTES, QVM_UI_CLIENT_STATE_BYTES, QVM_SNAPSHOT_BYTES, QVM_GAME_STATE_BYTES])
      .toEqual([11332, 3084, 53772, 20100]);
  });

  test("glconfig scalar offsets, byte strings and binary32 aspect with exterior preservation", () => {
    const { view, bytes } = destination(11336);
    writeQvmGlConfig(view, configuration());
    expect(Array.from(new Uint8Array(view.buffer, view.byteOffset, 9))).toEqual([100, 114, 105, 118, 101, 114, 255, 0, 0]);
    expect(view.getUint8(3075)).toBe(233);
    const integers: readonly (readonly [number, number])[] = [
      [11264, 16384], [11268, 2], [11272, 24], [11276, 32], [11280, 8], [11284, 0], [11288, 0],
      [11292, 1], [11296, 0], [11300, 1], [11304, 1920], [11308, 1080], [11316, 144],
      [11320, 1], [11324, 0], [11328, 0],
    ];
    for (const [offset, expected] of integers) expect(view.getInt32(offset, true)).toBe(expected);
    expect(view.getFloat32(11312, true)).toBe(Math.fround(16 / 9));
    expect(bytes.subarray(0, 7).every(byte => byte === 0xa5)).toBe(true);
    expect(bytes.subarray(7 + 11332).every(byte => byte === 0xa5)).toBe(true);
  });

  test("glconfig byte truncation and unsupported inputs reject before mutation", () => {
    const { view, bytes } = destination(11332);
    expect(() => writeQvmGlConfig(view, { ...configuration(), extensionsString: "\u0100" })).toThrow("source byte characters");
    expect(bytes.every(byte => byte === 0xa5)).toBe(true);
    writeQvmGlConfig(view, { ...configuration(), rendererString: "x".repeat(1024), vendorString: "v\0\u0100",
      extensionsString: "\xff".repeat(8192) });
    expect(view.getUint8(1022)).toBe(120); expect(view.getUint8(1023)).toBe(0);
    expect(view.getUint8(1024)).toBe(118); expect(view.getUint8(1025)).toBe(0); expect(view.getUint8(2047)).toBe(0);
    expect(view.getUint8(11262)).toBe(255); expect(view.getUint8(11263)).toBe(0);
  });

  test("glconfig publishes the retained source compression enum", () => {
    const { view } = destination(11332);
    writeQvmGlConfig(view, { ...configuration(), textureCompression: "s3tc" });
    expect(view.getInt32(11296, true)).toBe(1);
    writeQvmGlConfig(view, configuration());
    expect(view.getInt32(11296, true)).toBe(0);
  });

  test("CPU configuration profile uses the explicit legacy ABI dimension ceiling", () => {
    const { view } = destination(11332);
    const cpu: RendererConfigurationSnapshot = { ...configuration(), backend: "cpu", driverType: "cpu",
      rendererString: "Quake III TypeScript CPU rasterizer", vendorString: "Quake III TypeScript port",
      versionString: "CPU implementation", extensionsString: "", maxTextureSize: null, depthStorage: "binary64",
      depthBits: 64, stencilBits: 0, deviceSupportsGamma: false, gamma: { kind: "unsupported", reason: "fixture" },
      textureEnvAddAvailable: false };
    writeQvmGlConfig(view, cpu);
    expect(view.getInt32(11264, true)).toBe(0x7fffffff);
    expect(view.getInt32(11284, true)).toBe(0);
    expect(view.getInt32(11276, true)).toBe(64);
    expect(view.getInt32(11280, true)).toBe(0);
    expect(view.getInt32(11292, true)).toBe(0);
    expect(view.getInt32(11300, true)).toBe(0);
    expect(view.getUint8(3072)).toBe(0);
    expect(cpu.maxTextureSize).toBeNull(); expect(cpu.driverType).toBe("cpu");
  });

  test("UI maps actual phase owners without assigning the unused authorizing enum", () => {
    const clientStatic = new ClientStaticState(), connection = new ClientConnectionState();
    const clientActive = new ClientActiveState(text => { throw new Error(`Unexpected client diagnostic: ${text}`); });
    const { view, bytes } = destination(3088);
    const phases: readonly (readonly [ClientConnectionPhase, number])[] = [
      ["uninitialized", 0], ["disconnected", 1], ["connecting", 3], ["challenging", 4], ["connected", 5],
      ["loading", 6], ["primed", 7], ["active", 8], ["cinematic", 9],
    ];
    clientStatic.servername = "\xffhost\0ignored";
    clientStatic.updateInfoString = "u".repeat(1024);
    connection.serverMessage = "message";
    connection.connectPacketCount = -2147483648;
    for (const [phase, expected] of phases) {
      clientStatic.phase = phase;
      writeQvmUiClientState(view, clientStatic, connection, clientActive);
      expect(view.getInt32(0, true)).toBe(expected);
    }
    expect(view.getInt32(4, true)).toBe(-2147483648); expect(view.getInt32(8, true)).toBe(0);
    expect(view.getUint8(12)).toBe(255); expect(view.getUint8(17)).toBe(0);
    expect(view.getUint8(1035)).toBe(0); expect(view.getUint8(2058)).toBe(117); expect(view.getUint8(2059)).toBe(0);
    expect(view.getUint8(2060)).toBe(109); expect(view.getUint8(3083)).toBe(0);
    expect(bytes.subarray(7 + 3084).every(byte => byte === 0xa5)).toBe(true);
  });

  test("real received session snapshot supplies UI identity and snapshot ping", async () => {
    const session = createProtocolClientSession({ product: "missionpack", cvars: new CvarRegistry(),
      mode: { kind: "network", challenge: 0, qport: 27960 } });
    const value = snapshot();
    value.playerState.clientNum = 41;
    value.playerState.origin = { x: 1.25, y: -2.5, z: 3.75 };
    session.lifecycle.clientStatic.realtime = 87;
    await session.receiveServerMessage(7, encodeServerMessage(0, [{ kind: "command", sequence: 37, text: "print retained" },
      { kind: "snapshot", validity: { kind: "valid" }, snapshot: value }],
      { product: "missionpack", messageNumber: 7, reliableSequence: 0, serverCommandSequence: 37,
        parseEntitiesNumber: 0, baseline: () => null, history: () => null }));
    const received = session.snapshots.read(7), ping = session.snapshotPing(7);
    if (received === null || ping === null) throw new Error("Session did not retain source snapshot");
    const ui = destination(3084), snap = destination(53772);
    writeQvmUiClientState(ui.view, session.lifecycle.clientStatic, session.lifecycle.clientConnection, session.lifecycle.clientActive);
    writeQvmSnapshot(snap.view, received, ping);
    expect(ui.view.getInt32(8, true)).toBe(41);
    expect(snap.view.getInt32(4, true)).toBe(87);
    expect(snap.view.getInt32(184, true)).toBe(41);
    expect(snap.view.getFloat32(64, true)).toBe(1.25);
    expect(snap.view.getInt32(53768, true)).toBe(37);
  });

  test("actual history truncates to 256 entities; writer retains numServerCommands and inactive slots", () => {
    const entities = Array.from({ length: 257 }, (_, index) => {
      const entity = new EntityState(); entity.number = index; entity.generic1 = index + 900; return entity;
    });
    const value = snapshot(entities), history = new SnapshotHistory(), diagnostics: string[] = [];
    value.playerState.ping = -452; value.playerState.entityEventSequence = 0x12345678;
    history.publish({ kind: "snapshot", validity: { kind: "valid" }, snapshot: value });
    const source = new HistorySnapshotSource(history, () => 257, text => { diagnostics.push(text); });
    const bounded = source.read(7);
    if (bounded === null) throw new Error("History rejected current snapshot");
    const { view, bytes } = destination(53776);
    writeQvmSnapshot(view, bounded, 99);
    expect(diagnostics).toEqual(["CL_GetSnapshot: truncated 257 entities to 256\n"]);
    expect(view.getInt32(512, true)).toBe(256);
    expect(view.getInt32(496, true)).toBe(-452); expect(view.getInt32(508, true)).toBe(0x12345678);
    expect(view.getInt32(53556, true)).toBe(255); expect(view.getInt32(53760, true)).toBe(1155);
    expect(view.getUint32(53764, true)).toBe(0xa5a5a5a5);
    writeQvmSnapshot(view, snapshot(entities.slice(0, 1)), 100);
    expect(view.getInt32(512, true)).toBe(1); expect(view.getInt32(724, true)).toBe(1);
    expect(view.getInt32(53556, true)).toBe(255);
    expect(bytes.subarray(7 + 53772).every(byte => byte === 0xa5)).toBe(true);
  });

  test("actual session gamestate allocation preserves insertion order, duplicates and empty entries", async () => {
    const session = createProtocolClientSession({ product: "baseq3", cvars: new CvarRegistry(),
      mode: { kind: "network", challenge: 0, qport: 27960 } });
    const { view, bytes } = destination(20104);
    writeQvmGameState(view, session.getSourceGameState());
    expect(view.getInt32(20096, true)).toBe(0);
    await session.receiveServerMessage(1, encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0,
      clientNumber: 0, checksumFeed: 0, entries: [
        { kind: "configstring", index: 700, value: "first" },
        { kind: "configstring", index: 3, value: "second" },
        { kind: "configstring", index: 9, value: "" },
        { kind: "configstring", index: 700, value: "last" },
      ] }], { product: "baseq3", messageNumber: 1, reliableSequence: 0, serverCommandSequence: 0,
      parseEntitiesNumber: 0, baseline: () => null, history: () => null }));
    const record = session.getSourceGameState();
    writeQvmGameState(view, record);
    expect(view.getInt32(700 * 4, true)).toBe(15);
    expect(view.getInt32(3 * 4, true)).toBe(7);
    expect(view.getInt32(9 * 4, true)).toBe(14);
    expect(view.getInt32(20096, true)).toBe(20);
    expect(Array.from(new Uint8Array(view.buffer, view.byteOffset + 4096, 20)))
      .toEqual([0, 102, 105, 114, 115, 116, 0, 115, 101, 99, 111, 110, 100, 0, 0, 108, 97, 115, 116, 0]);
    expect(view.getUint8(20095)).toBe(0);
    record.stringOffsets[700] = 99; record.stringData[1] = 0xff; record.stringData[15999] = 0xee;
    expect(session.getSourceGameState().stringOffsets[700]).toBe(15);
    writeQvmGameState(view, record);
    expect(view.getUint8(4097)).toBe(255);
    expect(view.getUint8(20095)).toBe(238);
    expect(bytes.subarray(7 + 20100).every(byte => byte === 0xa5)).toBe(true);
    session.clearGameStateForMapLoading();
    writeQvmGameState(view, session.getSourceGameState());
    expect(new Uint8Array(view.buffer, view.byteOffset, 20100).every(byte => byte === 0)).toBe(true);
  });

  test("all incomplete records and invalid snapshot bounds reject before mutation", () => {
    const clientStatic = new ClientStaticState(), connection = new ClientConnectionState();
    const clientActive = new ClientActiveState(text => { throw new Error(`Unexpected client diagnostic: ${text}`); });
    const writers: readonly (readonly [number, (view: DataView) => void])[] = [
      [11332, view => writeQvmGlConfig(view, configuration())],
      [3084, view => writeQvmUiClientState(view, clientStatic, connection, clientActive)],
      [53772, view => writeQvmSnapshot(view, snapshot(), 0)],
      [20100, view => writeQvmGameState(view, { stringOffsets: new Int32Array(1024), stringData: new Uint8Array(16000), dataCount: 0 })],
    ];
    for (const [size, write] of writers) {
      for (const length of [0, 1, size - 1]) {
        const { view, bytes } = destination(length);
        expect(() => write(view)).toThrow(BinaryError);
        expect(bytes.every(byte => byte === 0xa5)).toBe(true);
      }
    }
    const { view, bytes } = destination(53772);
    expect(() => writeQvmSnapshot(view, { ...snapshot(), areaMask: new Uint8Array(31) }, 0)).toThrow("bounded");
    expect(() => writeQvmSnapshot(view, snapshot(Array.from({ length: 257 }, () => new EntityState())), 0)).toThrow("bounded");
    expect(bytes.every(byte => byte === 0xa5)).toBe(true);
    expect(() => writeQvmGameState(view, { stringOffsets: new Int32Array(1023), stringData: new Uint8Array(16000), dataCount: 0 }))
      .toThrow("complete source allocation");
    expect(() => writeQvmGameState(view, { stringOffsets: new Int32Array(1024), stringData: new Uint8Array(15999), dataCount: 0 }))
      .toThrow("complete source allocation");
    expect(bytes.every(byte => byte === 0xa5)).toBe(true);
    clientStatic.updateInfoString = "\u0100";
    expect(() => writeQvmUiClientState(view, clientStatic, connection, clientActive)).toThrow("source byte characters");
    expect(bytes.every(byte => byte === 0xa5)).toBe(true);
  });
});
