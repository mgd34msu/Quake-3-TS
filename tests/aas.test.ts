import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BinaryError, BinaryWriter } from "../src/core/binary.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { ZoneArena } from "../src/core/zone.ts";
import { parseAas } from "../src/botlib/aas.ts";
import type { AasLump } from "../src/botlib/aas-storage.ts";
import { AasWorldState } from "../src/botlib/aas-world.ts";
import { aasOptimize } from "../src/botlib/aas-optimize.ts";
import { BotMemory } from "../src/botlib/memory.ts";
import type { BotMemoryAllocation } from "../src/botlib/memory.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";

const HEADER_SIZE = 124;
const CHECKSUM = -123456789;

interface Fixture {
  readonly bytes: Uint8Array;
  readonly offsets: readonly number[];
}

function record(size: number, write: (writer: BinaryWriter) => void): Uint8Array {
  const writer = new BinaryWriter(size);
  write(writer);
  const bytes = writer.finish();
  expect(bytes.length).toBe(size);
  return bytes;
}

function vector(writer: BinaryWriter, x: number, y: number, z: number): void {
  writer.f32(x);
  writer.f32(y);
  writer.f32(z);
}

function writeArea(writer: BinaryWriter, areaNumber: number, firstFace: number, minX: number, maxX: number): void {
  writer.i32(areaNumber);
  writer.i32(areaNumber === 0 ? 0 : 1);
  writer.i32(firstFace);
  vector(writer, minX, -10, -20);
  vector(writer, maxX, 10, 20);
  vector(writer, (minX + maxX) / 2, 0, 0);
}

function writeSettings(writer: BinaryWriter, cluster: number, clusterArea: number, firstReachability: number, count: number): void {
  writer.i32(0);
  writer.i32(1);
  writer.i32(2);
  writer.i32(cluster);
  writer.i32(clusterArea);
  writer.i32(count);
  writer.i32(firstReachability);
}

function aasFixture(version: 4 | 5 = 5, portalIndexes: readonly number[] = []): Fixture {
  const lumps: Uint8Array[] = [];
  lumps.push(record(32, writer => {
    writer.i32(2); writer.i32(3);
    vector(writer, -15, -15, -24); vector(writer, 15, 15, 32);
  }));
  lumps.push(record(24, writer => {
    vector(writer, 0, -10, 0); vector(writer, 0, 10, 0);
  }));
  lumps.push(record(20, writer => {
    vector(writer, 1, 0, 0); writer.f32(0); writer.i32(0);
  }));
  lumps.push(record(16, writer => {
    writer.i32(0); writer.i32(0); writer.i32(0); writer.i32(1);
  }));
  lumps.push(record(4, writer => writer.i32(1)));
  lumps.push(record(48, writer => {
    for (let index = 0; index < 6; index++) writer.i32(0);
    writer.i32(0); writer.i32(4); writer.i32(1); writer.i32(0); writer.i32(1); writer.i32(2);
  }));
  lumps.push(record(8, writer => { writer.i32(1); writer.i32(-1); }));
  lumps.push(record(144, writer => {
    writeArea(writer, 0, 0, 0, 0);
    writeArea(writer, 1, 0, 0, 10);
    writeArea(writer, 2, 1, -10, 0);
  }));
  lumps.push(record(84, writer => {
    writeSettings(writer, 0, 0, 1, 0);
    writeSettings(writer, 1, 0, 1, 1);
    writeSettings(writer, 1, 1, 2, 0);
  }));
  lumps.push(record(88, writer => {
    for (let index = 0; index < 10; index++) writer.i32(0);
    writer.u16(0); writer.u16(0);
    writer.i32(2); writer.i32(1); writer.i32(-1);
    vector(writer, 1, 2, 3); vector(writer, -1, -2, -3);
    writer.i32(2); writer.u16(65530); writer.u16(0);
  }));
  lumps.push(record(24, writer => {
    writer.i32(0); writer.i32(0); writer.i32(0);
    writer.i32(0); writer.i32(-1); writer.i32(-2);
  }));
  lumps.push(record(20, writer => {
    for (let index = 0; index < 5; index++) writer.i32(0);
  }));
  lumps.push(record(portalIndexes.length * 4, writer => {
    for (const index of portalIndexes) writer.i32(index);
  }));
  lumps.push(record(32, writer => {
    for (let index = 0; index < 4; index++) writer.i32(0);
    writer.i32(2); writer.i32(1); writer.i32(0); writer.i32(0);
  }));

  const offsets: number[] = [];
  let nextOffset = HEADER_SIZE;
  for (const lump of lumps) {
    offsets.push(nextOffset);
    nextOffset += lump.length;
  }
  const output = new BinaryWriter(nextOffset);
  output.u32(0x53414145);
  output.i32(version);
  output.i32(CHECKSUM);
  for (let index = 0; index < lumps.length; index++) {
    const offset = offsets[index];
    const lump = lumps[index];
    if (offset === undefined || lump === undefined) throw new RangeError("incomplete AAS fixture");
    output.i32(offset);
    output.i32(lump.length);
  }
  for (const lump of lumps) output.bytes(lump);
  const bytes = output.finish();
  if (version === 5) {
    for (let offset = 8; offset < HEADER_SIZE; offset++) {
      const byte = bytes[offset];
      if (byte === undefined) throw new RangeError("incomplete AAS fixture header");
      bytes[offset] = byte ^ (((offset - 8) * 119) & 0xff);
    }
  }
  return Object.freeze({ bytes, offsets: Object.freeze(offsets) } satisfies Fixture);
}

function offset(fixture: Fixture, lump: number): number {
  const value = fixture.offsets[lump];
  if (value === undefined) throw new RangeError(`missing fixture lump ${lump}`);
  return value;
}

class RecordedBotMemory extends BotMemory {
  readonly requests: { readonly size: number; readonly kind: "heap" | "hunk";
    readonly clear: boolean; readonly allocation: BotMemoryAllocation }[] = [];
  readonly freed: BotMemoryAllocation[] = [];

  override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
    const allocation = super.allocate(size, kind, clear);
    this.requests.push({ size, kind, clear, allocation });
    return allocation;
  }

  override free(allocation: BotMemoryAllocation): void {
    super.free(allocation);
    this.freed.push(allocation);
  }

  freeOrder(): readonly number[] {
    return this.freed.map(allocation => this.requests.findIndex(request => request.allocation === allocation));
  }

  bytes(index: number): Uint8Array {
    const request = this.requests[index];
    if (request === undefined) throw new RangeError(`missing loaded AAS allocation ${index}`);
    return request.allocation.bytes;
  }

  view(index: number): DataView {
    const bytes = this.bytes(index);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}

describe("AAS asset parsing and sampling", () => {
  test("decodes the v5 header and every lump without mutating its input", () => {
    const fixture = aasFixture();
    const original = fixture.bytes.slice();
    const world = parseAas(fixture.bytes, "fixture.aas");

    expect(fixture.bytes).toEqual(original);
    expect(world.source).toBe("fixture.aas");
    expect(world.version).toBe(5);
    expect(world.bspChecksum).toBe(CHECKSUM);
    expect(world.bboxes[0]).toEqual({
      presenceType: 2, flags: 3,
      bounds: { min: { x: -15, y: -15, z: -24 }, max: { x: 15, y: 15, z: 32 } },
    });
    expect(world.vertices).toEqual([{ x: 0, y: -10, z: 0 }, { x: 0, y: 10, z: 0 }]);
    expect(world.planes[0]).toEqual({ normal: { x: 1, y: 0, z: 0 }, distance: 0, type: 0 });
    expect(world.edges[1]?.vertices[0]).toBe(0);
    expect(world.edges[1]?.vertices[1]).toBe(1);
    expect(Array.from(world.edgeIndexes)).toEqual([1]);
    expect(world.faces[1]).toEqual({ plane: 0, flags: 4, edgeCount: 1, firstEdge: 0, frontArea: 1, backArea: 2 });
    expect(Array.from(world.faceIndexes)).toEqual([1, -1]);
    expect(world.areaSettings[1]?.reachableAreaCount).toBe(1);
    expect(world.reachability[1]).toEqual({
      area: 2, face: 1, edge: -1,
      start: { x: 1, y: 2, z: 3 }, end: { x: -1, y: -2, z: -3 },
      travelType: 2, travelTime: 65530, padding: 0,
    });
    expect(world.nodes[1]?.children[0]).toBe(-1);
    expect(world.nodes[1]?.children[1]).toBe(-2);
    expect(world.portals).toHaveLength(1);
    expect(world.portalIndex).toEqual([]);
    expect(world.clusters[1]).toEqual({ areaCount: 2, reachabilityAreaCount: 1, portalCount: 0, firstPortal: 0 });
    expect(Object.isFrozen(world)).toBe(true);
    expect(Object.isFrozen(world.reachability[1])).toBe(true);
  });

  test("uses source point-side semantics and exposes bounded area data", () => {
    const world = parseAas(aasFixture().bytes);
    expect(world.pointArea({ x: 1, y: 0, z: 0 })).toBe(1);
    expect(world.pointArea({ x: 0, y: 0, z: 0 })).toBe(2);
    expect(world.areaBounds(1)).toEqual({ min: { x: 0, y: -10, z: -20 }, max: { x: 10, y: 10, z: 20 } });
    const firstAreaReachabilities = world.areaReachabilities(1);
    expect(firstAreaReachabilities).toHaveLength(1);
    expect(firstAreaReachabilities[0]).toBe(world.reachability[1]);
    expect(world.areaReachabilities(2)).toEqual([]);
    expect(Object.isFrozen(firstAreaReachabilities)).toBe(true);
    expect(() => world.areaBounds(0)).toThrow(RangeError);
    expect(() => world.areaReachabilities(3)).toThrow(RangeError);
    expect(() => world.pointArea({ x: Number.NaN, y: 0, z: 0 })).toThrow(RangeError);

    const solidFixture = aasFixture();
    const solidBytes = solidFixture.bytes.slice();
    new DataView(solidBytes.buffer, solidBytes.byteOffset, solidBytes.byteLength)
      .setInt32(offset(solidFixture, 10) + 20, 0, true);
    expect(Object.is(parseAas(solidBytes).pointArea({ x: -1, y: 0, z: 0 }), 0)).toBe(true);
  });

  test("accepts the source-supported unobfuscated v4 retail layout", () => {
    const world = parseAas(aasFixture(4).bytes);
    expect(world.version).toBe(4);
    expect(world.bspChecksum).toBe(CHECKSUM);
    expect(world.pointArea({ x: -1, y: 0, z: 0 })).toBe(2);
  });

  test("empty AAS lumps ignore their offsets and retain cleared dummy allocations", () => {
    for (const emptyOffset of [-0x80000000, -1, 0x7fffffff]) {
      for (const useReader of [false, true]) {
        const fixture = aasFixture(4), view = new DataView(fixture.bytes.buffer);
        view.setInt32(12, emptyOffset, true);
        view.setInt32(16, 0, true);
        view.setInt32(12 + 12 * 8, emptyOffset, true);
        const memory = new RecordedBotMemory(), loaded: AasLump[] = [];
        const world = parseAas(fixture.bytes, "empty-offset.aas", memory, useReader ? {
          length: fixture.bytes.length,
          load: (lump, stride, owner) => {
            loaded.push(lump);
            if (lump.length === 0) return owner.allocate(stride + 1, "hunk", true);
            const allocation = owner.allocate(lump.length + 1, "hunk", true);
            allocation.bytes.set(fixture.bytes.subarray(lump.offset, lump.offset + lump.length));
            return allocation;
          },
        } : undefined);
        expect(world.bboxes).toEqual([]);
        expect(world.portalIndex).toEqual([]);
        expect(memory.bytes(0)).toEqual(new Uint8Array(33));
        expect(memory.bytes(12)).toEqual(new Uint8Array(5));
        expect(world.pointArea({ x: 1, y: 0, z: 0 })).toBe(1);
        if (useReader) {
          expect(loaded[0]).toEqual({ offset: emptyOffset, length: 0 });
          expect(loaded[12]).toEqual({ offset: emptyOffset, length: 0 });
        }
      }
    }
  });

  test("overlapping AAS lumps load independent records from their declared ranges", () => {
    for (const displacement of [0, 4]) {
      const fixture = aasFixture(4), view = new DataView(fixture.bytes.buffer);
      view.setInt32(12 + 4 * 8, offset(fixture, 6) + displacement, true);
      const memory = new RecordedBotMemory();
      const world = parseAas(fixture.bytes, "overlapping.aas", memory);
      expect(Array.from(world.edgeIndexes)).toEqual([displacement === 0 ? 1 : -1]);
      expect(Array.from(world.faceIndexes)).toEqual([1, -1]);
      memory.view(4).setInt32(0, 0, true);
      expect(world.edgeIndexes[0]).toBe(0);
      expect(Array.from(world.faceIndexes)).toEqual([1, -1]);
    }
    for (const version of [4, 5]) {
      const fixture = aasFixture(4), view = new DataView(fixture.bytes.buffer);
      view.setInt32(4, version, true);
      view.setInt32(12 + 8, 0, true);
      view.setInt32(16 + 8, 12, true);
      view.setInt32(offset(fixture, 3) + 12, 0, true);
      if (version === 5) {
        for (let index = 8; index < HEADER_SIZE; index++) {
          view.setUint8(index, view.getUint8(index) ^ (((index - 8) * 119) & 0xff));
        }
      }
      const memory = new RecordedBotMemory(), rawHeader = fixture.bytes.slice(0, 12);
      const world = parseAas(fixture.bytes, "header-alias.aas", memory);
      expect(world.vertices).toEqual([{
        x: view.getFloat32(0, true), y: view.getFloat32(4, true), z: view.getFloat32(8, true),
      }]);
      expect(memory.bytes(1).slice(0, 12)).toEqual(rawHeader);
      expect(world.bspChecksum).toBe(CHECKSUM);
      expect(world.pointArea({ x: 1, y: 0, z: 0 })).toBe(1);
    }
  });

  test("nonempty AAS lumps still reject invalid bounds and record sizes", () => {
    const fixture = aasFixture(4);
    for (const [start, length] of [
      [-1, 4], [fixture.bytes.length + 1, 4],
      [fixture.bytes.length - 3, 4], [offset(fixture, 4), -4],
    ]) {
      if (start === undefined || length === undefined) throw new Error("incomplete AAS range fixture");
      const bytes = fixture.bytes.slice(), view = new DataView(bytes.buffer);
      view.setInt32(12 + 4 * 8, start, true);
      view.setInt32(16 + 4 * 8, length, true);
      expect(() => parseAas(bytes)).toThrow("invalid AAS lump 4 range");
    }
    const unaligned = fixture.bytes.slice();
    new DataView(unaligned.buffer).setInt32(16 + 4 * 8, 3, true);
    expect(() => parseAas(unaligned)).toThrow("not a multiple of record size 4");
    expect(() => parseAas(fixture.bytes.subarray(0, fixture.bytes.length - 1))).toThrow("invalid AAS lump 13 range");
  });

  test("rejects truncated, non-finite and malformed graph data", () => {
    const fixture = aasFixture();
    expect(() => parseAas(fixture.bytes.subarray(0, 100), "short.aas")).toThrow(BinaryError);

    const version = fixture.bytes.slice();
    new DataView(version.buffer, version.byteOffset, version.byteLength).setInt32(4, 6, true);
    expect(() => parseAas(version)).toThrow("version 4 or 5");

    const nonFinite = fixture.bytes.slice();
    new DataView(nonFinite.buffer, nonFinite.byteOffset, nonFinite.byteLength).setUint32(offset(fixture, 1), 0x7fc00000, true);
    expect(() => parseAas(nonFinite)).toThrow("non-finite float");

    const inactiveFloats = fixture.bytes.slice();
    const inactiveView = new DataView(inactiveFloats.buffer, inactiveFloats.byteOffset, inactiveFloats.byteLength);
    inactiveView.setUint32(offset(fixture, 7) + 12, 0x7fc00000, true);
    inactiveView.setUint32(offset(fixture, 9) + 12, 0x7fc00000, true);
    const inactiveWorld = parseAas(inactiveFloats);
    expect(Number.isNaN(inactiveWorld.areas[0]?.bounds.min.x)).toBe(true);
    expect(Number.isNaN(inactiveWorld.reachability[0]?.start.x)).toBe(true);

    const signedIndex = fixture.bytes.slice();
    new DataView(signedIndex.buffer, signedIndex.byteOffset, signedIndex.byteLength).setInt32(offset(fixture, 4), -0x80000000, true);
    expect(() => parseAas(signedIndex)).toThrow("cannot negate INT32_MIN");

    const reachabilityRange = fixture.bytes.slice();
    new DataView(reachabilityRange.buffer, reachabilityRange.byteOffset, reachabilityRange.byteLength)
      .setInt32(offset(fixture, 8) + 28 + 24, 2, true);
    expect(() => parseAas(reachabilityRange)).toThrow("area reachabilities range");

    const child = fixture.bytes.slice();
    new DataView(child.buffer, child.byteOffset, child.byteLength).setInt32(offset(fixture, 10) + 16, 99, true);
    expect(() => parseAas(child)).toThrow("node child index");

    const cycle = fixture.bytes.slice();
    new DataView(cycle.buffer, cycle.byteOffset, cycle.byteLength).setInt32(offset(fixture, 10) + 16, 1, true);
    expect(() => parseAas(cycle)).toThrow("cycle in AAS nodes");
  });

  test("loads source lump allocations in order with their prefix, spare byte and empty-record fallback", () => {
    const fixture = aasFixture(4), arena = new HunkArena(4096, () => undefined);
    const accounting = new SourceHunkAccounting(arena), memory = new RecordedBotMemory({ kind: "source-hunk", accounting });
    parseAas(fixture.bytes, "hunk.aas", memory);
    const lengths = [32, 24, 20, 16, 4, 48, 8, 144, 84, 88, 24, 20, 0, 32];
    const sizes = lengths.map(length => (length === 0 ? 4 : length) + 1);
    expect(memory.requests.map(request => [request.size, request.kind, request.clear]))
      .toEqual(sizes.map(size => [size, "hunk", true]));
    expect(accounting.report().trace.map(trace => trace.bytes)).toEqual(sizes.map(size => size + 4));
    expect(4096 - arena.memoryRemaining()).toBe(sizes.reduce((total, size) => total + Math.ceil((size + 4) / 32) * 32, 0));
    for (const [index, length] of lengths.entries()) {
      const bytes = memory.bytes(index), start = offset(fixture, index);
      expect(bytes.slice(0, length)).toEqual(fixture.bytes.slice(start, start + length));
      expect(bytes.slice(length).every(byte => byte === 0)).toBe(true);
      expect(new DataView(bytes.buffer, bytes.byteOffset - 4, 4).getUint32(0, true)).toBe(0x87654321);
    }

    const empty = fixture.bytes.slice(0, HEADER_SIZE), header = new DataView(empty.buffer);
    for (let index = 0; index < 14; index++) {
      header.setInt32(12 + index * 8, 0, true); header.setInt32(16 + index * 8, 0, true);
    }
    const emptyMemory = new RecordedBotMemory();
    expect(() => parseAas(empty, "empty.aas", emptyMemory)).toThrow("AAS has no planes");
    expect(emptyMemory.requests.map(request => request.size)).toEqual([33, 13, 21, 9, 5, 25, 5, 49, 29, 45, 13, 21, 5, 17]);

    const tightArena = new HunkArena(64, () => undefined);
    const tightMemory = new RecordedBotMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(tightArena) });
    expect(() => parseAas(fixture.bytes, "full-hunk.aas", tightMemory)).toThrow("Hunk_Alloc failed on 32");
    expect(tightMemory.requests.map(request => request.size)).toEqual([33]);
    expect(tightArena.memoryRemaining()).toBe(0);
  });

  test("every retained lump reads its live hunk payload and expires after common clear", () => {
    const fixture = aasFixture(5, [0]), arena = new HunkArena(4096, () => undefined);
    const memory = new RecordedBotMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(arena) });
    const parsed = parseAas(fixture.bytes, "live.aas", memory), world = new AasWorldState(parsed);
    const probes: readonly { readonly lump: number; readonly offset: number; readonly value: number;
      readonly kind: "int" | "float"; readonly read: () => number | undefined }[] = [
      { lump: 0, offset: 4, value: 19, kind: "int", read: () => world.bboxes[0]?.flags },
      { lump: 1, offset: 0, value: 1.25, kind: "float", read: () => world.vertices[0]?.x },
      { lump: 2, offset: 12, value: -2.5, kind: "float", read: () => world.planes[0]?.distance },
      { lump: 3, offset: 12, value: 7, kind: "int", read: () => world.edges[1]?.vertices[1] },
      { lump: 4, offset: 0, value: -9, kind: "int", read: () => world.edgeIndexes[0] },
      { lump: 5, offset: 28, value: 33, kind: "int", read: () => world.faces[1]?.flags },
      { lump: 6, offset: 0, value: -17, kind: "int", read: () => world.faceIndexes[0] },
      { lump: 7, offset: 84, value: 3.5, kind: "float", read: () => world.areas[1]?.center.x },
      { lump: 8, offset: 32, value: 24, kind: "int", read: () => world.areaSettings[1]?.flags },
      { lump: 9, offset: 56, value: 4.5, kind: "float", read: () => world.reachability[1]?.start.x },
      { lump: 10, offset: 16, value: -2, kind: "int", read: () => world.nodes[1]?.children[0] },
      { lump: 11, offset: 12, value: 22, kind: "int", read: () => world.portals[0]?.clusterAreaNumbers[0] },
      { lump: 12, offset: 0, value: 31, kind: "int", read: () => world.portalIndex[0] },
      { lump: 13, offset: 16, value: 27, kind: "int", read: () => world.clusters[1]?.areaCount },
    ];
    fixture.bytes.fill(0);
    for (const probe of probes) {
      const view = memory.view(probe.lump);
      if (probe.kind === "int") view.setInt32(probe.offset, probe.value, true);
      else view.setFloat32(probe.offset, probe.value, true);
      expect(probe.read()).toBe(probe.value);
    }
    expect(world.areaSettingsRecord(1) === parsed.areaSettings[1]).toBe(true);
    expect(world.reachabilityRecord(1) === parsed.reachability[1]).toBe(true);
    expect(world.portalRecord(0) === parsed.portals[0]).toBe(true);
    expect(world.clusterRecord(1) === parsed.clusters[1]).toBe(true);
    arena.clear(null);
    for (const probe of probes) expect(probe.read).toThrow("no longer valid");
    expect(() => { world.areaSettingsRecord(1).flags = 0; }).toThrow("no longer valid");
  });

  test("mutable loaded records and active indexes write through until generation replaces their allocation", () => {
    const memory = new RecordedBotMemory(), parsed = parseAas(aasFixture(5, [0]).bytes, "mutable.aas", memory);
    const world = new AasWorldState(parsed), settings = world.areaSettingsRecord(1);
    Object.assign(settings, { contents: 11, flags: 12, presenceType: 13, cluster: 14,
      clusterAreaNumber: 15, reachableAreaCount: 0, firstReachableArea: 2 });
    expect(Object.keys(settings)).toEqual(["contents", "flags", "presenceType", "cluster",
      "clusterAreaNumber", "reachableAreaCount", "firstReachableArea"]);
    expect({ ...settings }).toEqual({ contents: 11, flags: 12, presenceType: 13, cluster: 14,
      clusterAreaNumber: 15, reachableAreaCount: 0, firstReachableArea: 2 });
    expect(Object.isFrozen(settings)).toBe(true);
    expect(Array.from({ length: 7 }, (_, index) => memory.view(8).getInt32(28 + index * 4, true)))
      .toEqual([11, 12, 13, 14, 15, 0, 2]);
    expect(parsed.areaReachabilities(1)).toEqual([]);
    const reach = world.reachabilityRecord(1), start = reach.start;
    Object.assign(reach, { area: 1, face: -3, edge: 4, start: { x: 0.1, y: 0.2, z: 0.3 },
      end: { x: -0.1, y: -0.2, z: -0.3 }, travelType: 0x1000002, travelTime: 65537, padding: 65538 });
    expect(reach.start).toBe(start);
    expect([memory.view(9).getInt32(44, true), memory.view(9).getInt32(48, true), memory.view(9).getInt32(52, true)])
      .toEqual([1, -3, 4]);
    expect(Array.from({ length: 6 }, (_, index) => memory.view(9).getFloat32(56 + index * 4, true)))
      .toEqual([0.1, 0.2, 0.3, -0.1, -0.2, -0.3].map(Math.fround));
    expect(memory.view(9).getInt32(80, true)).toBe(0x1000002);
    expect(memory.view(9).getUint16(84, true)).toBe(1);
    expect(memory.view(9).getUint16(86, true)).toBe(2);
    Object.assign(world.portalRecord(0), { area: 1, frontCluster: 2, backCluster: 3, clusterAreaNumbers: [4, 5] });
    world.portalRecord(0).clusterAreaNumbers[1] = 6;
    expect(Array.from({ length: 5 }, (_, index) => memory.view(11).getInt32(index * 4, true))).toEqual([1, 2, 3, 4, 6]);
    Object.assign(world.clusterRecord(1), { areaCount: 7, reachabilityAreaCount: 8, portalCount: 9, firstPortal: 10 });
    expect(Array.from({ length: 4 }, (_, index) => memory.view(13).getInt32(16 + index * 4, true))).toEqual([7, 8, 9, 10]);
    const activeIndexes = world.portalIndex;
    world.setPortalIndex(0, 17);
    expect(memory.view(12).getInt32(0, true)).toBe(17);
    memory.view(12).setInt32(0, 19, true);
    expect(activeIndexes[0]).toBe(19);
    world.portalIndexSize = 0; world.portalIndexSize = 1;
    expect(world.portalIndex[0]).toBe(19);

    world.allocateReachability(4); world.allocatePortals(4); world.allocatePortalIndexes(4); world.allocateClusters(4);
    world.reachabilityRecord(1).face = 101; world.portalRecord(0).area = 102;
    world.setPortalIndex(0, 103); world.clusterRecord(1).areaCount = 104;
    expect(memory.requests).toHaveLength(18);
    expect(parsed.reachability[1]?.face).toBe(-3); expect(parsed.portals[0]?.area).toBe(1);
    expect(parsed.portalIndex[0]).toBe(19); expect(parsed.clusters[1]?.areaCount).toBe(7);
    expect(world.reachability[1]?.face).toBe(101); expect(world.portals[0]?.area).toBe(102);
    expect(world.portalIndex[0]).toBe(103); expect(world.clusters[1]?.areaCount).toBe(104);
    expect(world.areaSettingsRecord(1)).toBe(settings);
  });

  test("generated AAS payloads consume source zone storage and free replaced capacities in source order", () => {
    const zone = new ZoneArena(65536), memory = new RecordedBotMemory({ kind: "unaccounted" }, zone);
    const parsed = parseAas(aasFixture(5, [0]).bytes, "generated-heap.aas", memory), world = new AasWorldState(parsed);
    const available = zone.memoryRemaining();
    expect(world.memory).toBe(memory);
    expect(memory.requests).toHaveLength(14);
    world.allocateReachability(4); world.allocatePortals(4); world.allocatePortalIndexes(4); world.allocateClusters(4);
    expect(memory.requests.slice(14).map(request => [request.size, request.kind, request.clear]))
      .toEqual([[176, "heap", true], [80, "heap", true], [16, "heap", true], [64, "heap", true]]);
    expect(memory.freeOrder()).toEqual([9, 11, 12, 13]);
    expect(available - zone.memoryRemaining()).toBe(448);
    const reach = world.reachabilityRecord(1), portal = world.portalRecord(0);
    const indexes = world.portalIndex, cluster = world.clusterRecord(1);
    reach.face = 0x100000001; reach.start.x = 0.1; reach.travelTime = 65537;
    portal.clusterAreaNumbers[1] = 0x80000000;
    world.setPortalIndex(0, 0x100000003); cluster.areaCount = 7;
    expect([memory.view(14).getInt32(48, true), memory.view(14).getFloat32(56, true), memory.view(14).getUint16(84, true)])
      .toEqual([1, Math.fround(0.1), 1]);
    expect(memory.view(15).getInt32(16, true)).toBe(-2147483648);
    expect(memory.view(16).getInt32(0, true)).toBe(3);
    expect(memory.view(17).getInt32(16, true)).toBe(7);
    memory.view(14).setFloat32(56, 0.25, true); memory.view(16).setInt32(0, 13, true);
    expect(reach.start.x).toBe(0.25); expect(indexes[0]).toBe(13);
    expect(world.reachabilityRecord(3).area).toBe(0);
    expect(memory.bytes(14).subarray(88).every(byte => byte === 0)).toBe(true);
    world.allocateReachability(2); world.allocatePortals(2); world.allocatePortalIndexes(2); world.allocateClusters(2);
    expect(memory.freeOrder()).toEqual([9, 11, 12, 13, 14, 15, 16, 17]);
    for (const read of [() => reach.face, () => portal.area, () => indexes[0], () => cluster.areaCount]) {
      expect(read).toThrow("freed");
    }
    expect(available - zone.memoryRemaining()).toBe(280);
    world.dumpData();
    expect(memory.freeOrder().slice(8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 18, 10, 19, 20, 21]);
    expect(zone.memoryRemaining()).toBe(available);
    expect(world.vertices).toHaveLength(0); expect(world.reachability).toHaveLength(0);
    expect(world.portals).toHaveLength(0); expect(world.portalIndex).toHaveLength(0); expect(world.clusters).toHaveLength(0);
    expect(parsed.reachability[1]?.face).toBe(1);
    world.dumpData();
    expect(memory.freed).toHaveLength(22);
    zone.checkHeap();
  });

  test("optimization transfers live heap payloads and frees its maps after the source store sequence", () => {
    const fixture = aasFixture(5, [0]);
    new DataView(fixture.bytes.buffer).setInt32(offset(fixture, 5) + 28, 6, true);
    const zone = new ZoneArena(65536), memory = new RecordedBotMemory({ kind: "unaccounted" }, zone);
    const parsed = parseAas(fixture.bytes, "optimized-heap.aas", memory), world = new AasWorldState(parsed);
    const available = zone.memoryRemaining();
    aasOptimize(world, () => undefined);
    expect(memory.requests.slice(14).map(request => [request.size, request.kind, request.clear]))
      .toEqual([24, 16, 4, 48, 8, 144, 8, 8, 8].map(size => [size, "heap", true]));
    expect(memory.freeOrder()).toEqual([1, 3, 4, 5, 6, 7, 20, 21, 22]);
    for (const index of [20, 21, 22]) expect(() => memory.bytes(index)).toThrow("freed");
    expect(available - zone.memoryRemaining()).toBe(412);
    expect(memory.view(14).getFloat32(16, true)).toBe(10);
    expect(memory.view(15).getInt32(12, true)).toBe(1);
    expect(memory.view(16).getInt32(0, true)).toBe(1);
    expect(memory.view(17).getInt32(28, true)).toBe(6);
    expect(memory.view(18).getInt32(4, true)).toBe(-1);
    expect(memory.view(19).getInt32(52, true)).toBe(1);
    const vertices = world.vertices, edgeIndexes = world.edgeIndexes, faceIndexes = world.faceIndexes;
    memory.view(14).setFloat32(0, 1.25, true); memory.view(16).setInt32(0, -1, true);
    memory.view(18).setInt32(0, -1, true);
    expect(vertices[0]?.x).toBe(1.25); expect(edgeIndexes[0]).toBe(-1); expect(faceIndexes[0]).toBe(-1);
    world.replaceVertices(vertices.slice());
    expect(vertices[0]?.x).toBe(1.25);
    aasOptimize(world, () => undefined);
    expect(memory.freeOrder().slice(9)).toEqual([14, 15, 16, 17, 18, 19, 29, 30, 31]);
    expect(() => vertices[0]?.x).toThrow("freed");
    expect(() => edgeIndexes[0]).toThrow("freed");
    world.dumpData();
    expect(zone.memoryRemaining()).toBe(available);
    expect(parsed.vertices[0]?.x).toBe(0);
    zone.checkHeap();
  });
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailAvailable = existsSync(join(retailRoot, "baseq3", "pak0.pk3"))
  && existsSync(join(retailRoot, "missionpack", "pak0.pk3"));

test.skipIf(!retailAvailable)("parses every AAS exposed by the installed baseq3 and Team Arena VFS", async () => {
  let parsed = 0;
  for (const product of ["baseq3", "missionpack"] satisfies readonly ("baseq3" | "missionpack")[]) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product });
    const paths = vfs.list("maps/").filter(path => path.endsWith(".aas"));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const world = parseAas(await vfs.read(path), path);
      expect(world.areas.length).toBe(world.areaSettings.length);
      parsed++;
    }
  }
  expect(parsed).toBeGreaterThan(0);
}, 30_000);
