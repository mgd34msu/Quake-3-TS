import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { SourceFileHandles } from "../src/assets/file-handles.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { parseAas } from "../src/botlib/aas.ts";
import type { AasWorld } from "../src/botlib/aas.ts";
import { writeAasFile } from "../src/botlib/aas-file.ts";
import type { AasFileWriteHost, AasWritableFile } from "../src/botlib/aas-file.ts";
import { vec3 } from "../src/core/math.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function fixture(): AasWorld {
  const bounds = { min: vec3(-15.5, -16, -24), max: vec3(15.5, 16, 32) };
  return {
    source: "writer-fixture", version: 4, bspChecksum: -123456789,
    bboxes: [{ presenceType: 2, flags: 3, bounds }],
    vertices: [vec3(1.25, -2.5, -0)],
    planes: [{ normal: vec3(0, 0, 1), distance: -4.5, type: 2 }],
    edges: [{ vertices: [0, 0] }], edgeIndexes: [0],
    faces: [{ plane: 0, flags: 4, edgeCount: 1, firstEdge: 0, frontArea: 0, backArea: 0 }],
    faceIndexes: [0],
    areas: [{ areaNumber: 0, faceCount: 1, firstFace: 0, bounds, center: vec3(2, 3, 4) }],
    areaSettings: [{ contents: 5, flags: 6, presenceType: 2, cluster: 0, clusterAreaNumber: 0, reachableAreaCount: 1, firstReachableArea: 0 }],
    reachability: [{ area: 0, face: -123, edge: 0x12345678, start: vec3(1, 2, 3), end: vec3(4, 5, 6), travelType: 0x1000013, travelTime: 65530, padding: 0xabcd }],
    nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [0, 0] }],
    portals: [{ area: 0, frontCluster: 0, backCluster: 0, clusterAreaNumbers: [2, 3] }],
    portalIndex: [0], clusters: [{ areaCount: 1, reachabilityAreaCount: 1, portalCount: 1, firstPortal: 0 }],
    pointArea: () => 0, areaReachabilities: () => [], areaBounds: () => bounds,
  };
}

class TraceFile implements AasWritableFile {
  readonly writes: Uint8Array[] = [];
  readonly operations: string[] = [];
  cursor = 0;
  bytes = new Uint8Array(0);
  writeResult: number | null = null;
  seekResult = 0;
  throwAtWrite = -1;

  writeBytes(bytes: Uint8Array): number {
    this.operations.push(`write:${bytes.length}`);
    if (this.writes.length === this.throwAtWrite) throw new Error("host write exception");
    this.writes.push(bytes.slice());
    if (this.writeResult !== null) return this.writeResult;
    const grown = new Uint8Array(Math.max(this.bytes.length, this.cursor + bytes.length));
    grown.set(this.bytes); grown.set(bytes, this.cursor);
    this.bytes = grown;
    this.cursor += bytes.length;
    return bytes.length;
  }
  seek(offset: number, origin: "set"): number {
    this.operations.push(`seek:${offset}:${origin}`);
    if (this.seekResult === 0) this.cursor = offset;
    return this.seekResult;
  }
  close(): void { this.operations.push("close"); }
}

function host(file: AasWritableFile | null, events: string[]): AasFileWriteHost {
  return {
    openWrite(filename) { events.push(`open:${filename}`); return file; },
    print(type, message) { events.push(`${type}:${message}`); },
  };
}

function decodedHeader(bytes: Uint8Array): DataView {
  const decoded = bytes.slice(0, 124);
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  for (let index = 8; index < 124; index++) view.setUint8(index, view.getUint8(index) ^ ((index - 8) * 119));
  return view;
}

function expectWorldData(actual: AasWorld, expected: AasWorld): void {
  expect(actual.bspChecksum).toBe(expected.bspChecksum);
  for (const key of ["bboxes", "vertices", "planes", "faces", "areas", "areaSettings", "reachability", "clusters"] satisfies readonly (keyof AasWorld)[]) {
    expect(actual[key]).toEqual(expected[key]);
  }
  for (const key of ["edgeIndexes", "faceIndexes", "portalIndex"] satisfies readonly (keyof AasWorld)[]) {
    expect(Array.from(actual[key])).toEqual(Array.from(expected[key]));
  }
  expect(actual.edges.map(edge => Array.from(edge.vertices)))
    .toEqual(expected.edges.map(edge => Array.from(edge.vertices)));
  expect(actual.nodes.map(node => [node.plane, ...node.children]))
    .toEqual(expected.nodes.map(node => [node.plane, ...node.children]));
  expect(actual.portals.map(portal => [portal.area, portal.frontCluster, portal.backCluster, ...portal.clusterAreaNumbers]))
    .toEqual(expected.portals.map(portal => [portal.area, portal.frontCluster, portal.backCluster, ...portal.clusterAreaNumbers]));
}

describe("source AAS file writer", () => {
  test("writes the raw empty-lump header, all 14 ordered structs, then the encoded v5 header", () => {
    const world = fixture(), file = new TraceFile(), events: string[] = [];
    expect(writeAasFile(world, "maps/test.aas", host(file, events))).toBe(true);
    expect(events).toEqual(["1:writing maps/test.aas\n", "open:maps/test.aas"]);
    const initial = file.writes[0];
    if (initial === undefined) throw new Error("Missing initial header");
    const initialView = new DataView(initial.buffer, initial.byteOffset, initial.byteLength);
    expect(initialView.getUint32(0, true)).toBe(0x53414145);
    expect(initialView.getInt32(4, true)).toBe(5);
    expect(initialView.getInt32(8, true)).toBe(-123456789);
    expect(initial.slice(12)).toEqual(new Uint8Array(112));
    const lengths = [32, 12, 20, 8, 4, 24, 4, 48, 28, 44, 24, 20, 4, 16];
    const header = decodedHeader(file.bytes);
    let offset = 124;
    for (const [index, length] of lengths.entries()) {
      expect(header.getInt32(12 + index * 8, true)).toBe(offset);
      expect(header.getInt32(16 + index * 8, true)).toBe(length);
      offset += length;
    }
    expect(file.bytes.length).toBe(offset);
    expect(file.operations).toEqual(["write:124", ...lengths.map(length => `write:${length}`), "seek:0:set", "write:124", "close"]);
    const reach = new DataView(file.bytes.buffer, header.getInt32(84, true), 44);
    expect(reach.getInt32(4, true)).toBe(-123);
    expect(reach.getInt32(8, true)).toBe(0x12345678);
    expect(reach.getFloat32(24, true)).toBe(4);
    expect(reach.getInt32(36, true)).toBe(0x1000013);
    expect(reach.getUint16(40, true)).toBe(65530);
    expect(reach.getUint16(42, true)).toBe(0xabcd);
    const parsed = parseAas(file.bytes);
    expect(parsed.version).toBe(5);
    expectWorldData(parsed, world);
    expect(world.version).toBe(4);
    expectWorldData(world, fixture());
  });

  test("zero-length lumps retain the requested offset without a write", () => {
    const file = new TraceFile();
    const world: AasWorld = { ...fixture(), vertices: [], edges: [], edgeIndexes: [], faces: [], faceIndexes: [], bboxes: [], portals: [], portalIndex: [], clusters: [], reachability: [] };
    expect(writeAasFile(world, "empty.aas", host(file, []))).toBe(true);
    expect(file.operations).toEqual(["write:124", "write:20", "write:48", "write:28", "write:24", "seek:0:set", "write:124", "close"]);
    const header = decodedHeader(file.bytes);
    expect(header.getInt32(12, true)).toBe(124);
    expect(header.getInt32(16, true)).toBe(0);
    expect(header.getInt32(28, true)).toBe(124);
    expect(header.getInt32(36, true)).toBe(144);
    expect(header.getInt32(40, true)).toBe(0);
  });

  test("open failure reports after writing diagnostic and returns false without IO", () => {
    const events: string[] = [];
    expect(writeAasFile(fixture(), "denied.aas", host(null, events))).toBe(false);
    expect(events).toEqual(["1:writing denied.aas\n", "open:denied.aas", "3:error opening denied.aas\n"]);
  });

  test("failed writes and seek still produce source success, requested offsets, and close", () => {
    const file = new TraceFile(); file.writeResult = 0; file.seekResult = -1;
    expect(writeAasFile(fixture(), "failed.aas", host(file, []))).toBe(true);
    expect(file.writes).toHaveLength(16);
    const final = file.writes.at(-1);
    if (final === undefined) throw new Error("Missing final header");
    expect(decodedHeader(final).getInt32(116, true)).toBe(396);
    expect(file.operations.slice(-3)).toEqual(["seek:0:set", "write:124", "close"]);
    expect(file.bytes.length).toBe(0);
  });

  test("host exceptions preserve the interrupted source operation sequence", () => {
    const file = new TraceFile(); file.throwAtWrite = 2;
    expect(() => writeAasFile(fixture(), "interrupted.aas", host(file, []))).toThrow("host write exception");
    expect(file.operations).toEqual(["write:124", "write:32", "write:12"]);
  });
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailAvailable = existsSync(join(retailRoot, "baseq3", "pak0.pk3"))
  && existsSync(join(retailRoot, "missionpack", "pak0.pk3"));

test.skipIf(!retailAvailable)("rewrites retail AAS through common writable handles in a private home root", async () => {
  const root = await mkdtemp(join(tmpdir(), "quake3-aas-write-"));
  roots.push(root);
  for (const product of ["baseq3", "missionpack"] satisfies readonly ("baseq3" | "missionpack")[]) {
    const handles = new SourceFileHandles();
    const files = new WritableFileSystem({ homePath: root, product, handles, print: () => undefined });
    const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product });
    try {
      const path = product === "baseq3" ? "maps/q3dm1.aas" : "maps/mpteam1.aas";
      const source = await vfs.read(path);
      const world = parseAas(source, path);
      expect(writeAasFile(world, path, { openWrite: filename => files.openBinaryWrite(filename), print: () => undefined })).toBe(true);
      const bytes = new Uint8Array(await readFile(join(root, product, path)));
      const parsed = parseAas(bytes, "rewritten.aas");
      expectWorldData(parsed, world);
      expect(parsed.version).toBe(5);
      const original = world.version === 5 ? decodedHeader(source) : new DataView(source.buffer, source.byteOffset, 124);
      const output = decodedHeader(bytes);
      for (let lump = 0; lump < 14; lump++) {
        const sourceOffset = original.getInt32(12 + lump * 8, true);
        const outputOffset = output.getInt32(12 + lump * 8, true);
        const length = original.getInt32(16 + lump * 8, true);
        expect(output.getInt32(16 + lump * 8, true)).toBe(length);
        let differences = 0;
        for (let index = 0; index < length; index++) {
          if (source[sourceOffset + index] !== bytes[outputOffset + index]) differences++;
        }
        expect({ product, lump, differences }).toEqual({ product, lump, differences: 0 });
      }
      expect(world.pointArea(vec3(0, 0, 0))).toBe(parsed.pointArea(vec3(0, 0, 0)));
      expect(handles.selectFree().slot).toBe(1);
    } finally {
      vfs.close(); files.closeAll(); handles.close();
    }
  }
}, 30_000);

test("actual canonical open failure leaves no handle and follows source diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "quake3-aas-denied-"));
  roots.push(root);
  await mkdir(join(root, "baseq3", "maps", "directory.aas"), { recursive: true });
  const handles = new SourceFileHandles();
  const files = new WritableFileSystem({ homePath: root, product: "baseq3", handles, print: () => undefined });
  const events: string[] = [];
  try {
    expect(writeAasFile(fixture(), "maps/directory.aas", {
      openWrite: filename => files.openBinaryWrite(filename),
      print(type, message) { events.push(`${type}:${message}`); },
    })).toBe(false);
    expect(events).toEqual(["1:writing maps/directory.aas\n", "3:error opening maps/directory.aas\n"]);
    expect(handles.selectFree().slot).toBe(1);
  } finally {
    files.closeAll(); handles.close();
  }
});

test("canonical FS_Write zero-byte failure still closes and returns the source writer success", async () => {
  class FailedWrites extends WritableFileSystem {
    protected override writeChunk(): number { return 0; }
  }
  const root = await mkdtemp(join(tmpdir(), "quake3-aas-write-failed-"));
  roots.push(root);
  const handles = new SourceFileHandles(), messages: string[] = [];
  const files = new FailedWrites({ homePath: root, product: "baseq3", handles, print: text => { messages.push(text); } });
  try {
    expect(writeAasFile(fixture(), "maps/failed.aas", {
      openWrite: filename => files.openBinaryWrite(filename), print: () => undefined,
    })).toBe(true);
    expect(messages).toEqual(Array.from({ length: 16 }, () => "FS_Write: 0 bytes written\n"));
    expect((await readFile(join(root, "baseq3", "maps", "failed.aas"))).length).toBe(0);
    expect(handles.selectFree().slot).toBe(1);
  } finally {
    files.closeAll(); handles.close();
  }
});
