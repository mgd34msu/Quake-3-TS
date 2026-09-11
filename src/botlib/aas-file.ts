// Ported from id Software's code/botlib/be_aas_file.c and aasfile.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import type { WritableBinaryFile } from "../assets/writable-files.ts";
import { BinaryWriter } from "../core/binary.ts";
import type { Vec3 } from "../core/math.ts";
import type { AasWorld } from "./aas.ts";

export type AasWritableFile = Pick<WritableBinaryFile, "writeBytes" | "seek" | "close">;

export interface AasFileWriteHost {
  openWrite(filename: string): AasWritableFile | null;
  print(type: 1 | 3, message: string): undefined;
}

const HEADER_SIZE = 124;

/** AAS_FileInfo, including the source's fixed current format version label. */
export function printAasFileInfo(world: AasWorld, print: (severity: 1, text: string) => undefined): void {
  const counts: readonly [string, number][] = [
    ["version", 5], ["numvertexes", world.vertices.length], ["numplanes", world.planes.length],
    ["numedges", world.edges.length], ["edgeindexsize", world.edgeIndexes.length],
    ["numfaces", world.faces.length], ["faceindexsize", world.faceIndexes.length],
    ["numareas", world.areas.length], ["numareasettings", world.areaSettings.length],
    ["reachabilitysize", world.reachability.length], ["numnodes", world.nodes.length],
    ["numportals", world.portals.length], ["portalindexsize", world.portalIndex.length],
    ["numclusters", world.clusters.length],
    ["num grounded areas", world.areaSettings.filter(settings => (settings.flags & 1) !== 0).length],
  ];
  for (const [label, count] of counts) print(1, `${label} = ${count}\n`);
  const sizes: readonly [string, number][] = [
    ["planes", world.planes.length * 20], ["areas", world.areas.length * 48],
    ["areasettings", world.areaSettings.length * 28], ["nodes", world.nodes.length * 12],
    ["reachability", world.reachability.length * 44], ["portals", world.portals.length * 20],
    ["clusters", world.clusters.length * 16],
  ];
  let optimized = 0;
  for (const [label, size] of sizes) { print(1, `${label} size ${size} bytes\n`); optimized = (optimized + size) | 0; }
  print(1, `optimzed size ${optimized >> 10} KB\n`);
}

function vector(writer: BinaryWriter, value: Vec3): void {
  writer.f32(value.x);
  writer.f32(value.y);
  writer.f32(value.z);
}

/** AAS_WriteAASFile, for the Linux little-endian source profile. */
export function writeAasFile(world: AasWorld, filename: string, host: AasFileWriteHost): boolean {
  host.print(1, `writing ${filename}\n`);
  // Linux !idppc LittleLong/LittleFloat are identity macros. AAS_SwapAASData
  // therefore leaves the world unchanged in this selected source profile.
  const initial = new BinaryWriter(HEADER_SIZE);
  initial.i32(0x53414145);
  initial.i32(5);
  initial.i32(world.bspChecksum);
  initial.bytes(new Uint8Array(112));
  const header = initial.finish();
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const file = host.openWrite(filename);
  if (file === null) {
    host.print(3, `error opening ${filename}\n`);
    return false;
  }
  file.writeBytes(header);
  let offset = HEADER_SIZE;
  let lumpNumber = 0;

  // AAS_WriteAASLump advances its requested offset even when FS_Write fails.
  const writeAasLump = <T>(records: readonly T[], stride: number, encode: (writer: BinaryWriter, record: T) => void): void => {
    const writer = new BinaryWriter(records.length * stride);
    for (const record of records) encode(writer, record);
    const bytes = writer.finish();
    headerView.setInt32(12 + lumpNumber * 8, offset, true);
    headerView.setInt32(16 + lumpNumber * 8, bytes.length, true);
    if (bytes.length > 0) file.writeBytes(bytes);
    offset = (offset + bytes.length) | 0;
    lumpNumber++;
  };

  writeAasLump(world.bboxes, 32, (writer, box) => {
    writer.i32(box.presenceType); writer.i32(box.flags);
    vector(writer, box.bounds.min); vector(writer, box.bounds.max);
  });
  writeAasLump(world.vertices, 12, vector);
  writeAasLump(world.planes, 20, (writer, plane) => {
    vector(writer, plane.normal); writer.f32(plane.distance); writer.i32(plane.type);
  });
  writeAasLump(world.edges, 8, (writer, edge) => {
    writer.i32(edge.vertices[0]); writer.i32(edge.vertices[1]);
  });
  writeAasLump(world.edgeIndexes, 4, (writer, value) => writer.i32(value));
  writeAasLump(world.faces, 24, (writer, face) => {
    writer.i32(face.plane); writer.i32(face.flags); writer.i32(face.edgeCount);
    writer.i32(face.firstEdge); writer.i32(face.frontArea); writer.i32(face.backArea);
  });
  writeAasLump(world.faceIndexes, 4, (writer, value) => writer.i32(value));
  writeAasLump(world.areas, 48, (writer, area) => {
    writer.i32(area.areaNumber); writer.i32(area.faceCount); writer.i32(area.firstFace);
    vector(writer, area.bounds.min); vector(writer, area.bounds.max); vector(writer, area.center);
  });
  writeAasLump(world.areaSettings, 28, (writer, settings) => {
    writer.i32(settings.contents); writer.i32(settings.flags); writer.i32(settings.presenceType);
    writer.i32(settings.cluster); writer.i32(settings.clusterAreaNumber);
    writer.i32(settings.reachableAreaCount); writer.i32(settings.firstReachableArea);
  });
  writeAasLump(world.reachability, 44, (writer, reachability) => {
    writer.i32(reachability.area); writer.i32(reachability.face); writer.i32(reachability.edge);
    vector(writer, reachability.start); vector(writer, reachability.end);
    writer.i32(reachability.travelType); writer.u16(reachability.travelTime);
    writer.u16(reachability.padding);
  });
  writeAasLump(world.nodes, 12, (writer, node) => {
    writer.i32(node.plane); writer.i32(node.children[0]); writer.i32(node.children[1]);
  });
  writeAasLump(world.portals, 20, (writer, portal) => {
    writer.i32(portal.area); writer.i32(portal.frontCluster); writer.i32(portal.backCluster);
    writer.i32(portal.clusterAreaNumbers[0]); writer.i32(portal.clusterAreaNumbers[1]);
  });
  writeAasLump(world.portalIndex, 4, (writer, value) => writer.i32(value));
  writeAasLump(world.clusters, 16, (writer, cluster) => {
    writer.i32(cluster.areaCount); writer.i32(cluster.reachabilityAreaCount);
    writer.i32(cluster.portalCount); writer.i32(cluster.firstPortal);
  });
  file.seek(0, "set");
  // AAS_DData restarts the XOR index at header byte 8.
  for (let index = 8; index < HEADER_SIZE; index++) {
    headerView.setUint8(index, headerView.getUint8(index) ^ ((index - 8) * 119));
  }
  file.writeBytes(header);
  file.close();
  return true;
}
