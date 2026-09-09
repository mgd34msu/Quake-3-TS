/*
 * AAS clustering translated from id Software's botlib/be_aas_cluster.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { AasArea, AasWorld } from "./aas.ts";
import type { AasWorldState } from "./aas-world.ts";
import type { BotLibVars } from "./libvars.ts";
import type { AlternativeRoutingLog } from "./routing.ts";

export interface AasClusteringOptions {
  readonly variables: Pick<BotLibVars, "getValue">;
  readonly print: (severity: 1 | 4, text: string) => undefined;
  readonly log: Pick<AlternativeRoutingLog, "write">;
}

const MAX_PORTALS = 65536;
const MAX_PORTAL_INDEX = 65536;
const MAX_CLUSTERS = 65536;
const MAX_PORTAL_AREAS = 1024;
const CLUSTER_PORTAL = 8;
const ROUTE_PORTAL = 32;
const VIEW_PORTAL = 512;
const AREA_GROUNDED = 1;
const FACE_SOLID = 1;

function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`AAS clustering index ${index} outside initialized allocation of ${values.length}`);
  return value;
}

function sourceInteger(value: number): number {
  const integer = Math.trunc(value);
  if (!Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647) {
    throw new RangeError("AAS_InitClustering: source float-to-int conversion is undefined");
  }
  return integer;
}

function portalAreaPush(values: number[], value: number, allocation: string): void {
  if (values.length === MAX_PORTAL_AREAS) {
    throw new RangeError(`AAS_CheckAreaForPossiblePortals: source ${allocation}[${MAX_PORTAL_AREAS}] write exceeds allocation`);
  }
  values.push(value);
}

/** AAS_ConnectedAreas_r and AAS_ConnectedAreas. */
function connectedAreas(world: AasWorld, areaNumbers: readonly number[]): boolean {
  if (areaNumbers.length < 1) return false;
  if (areaNumbers.length === 1) return true;
  const connected = new Uint8Array(MAX_PORTAL_AREAS);
  const pending = [0];
  while (pending.length !== 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (at(connected, current) !== 0) continue;
    connected[current] = 1;
    const areaNumber = at(areaNumbers, current);
    const area = at(world.areas, areaNumber);
    // Reverse pushes retain the recursive source face order.
    for (let faceIndex = area.faceCount - 1; faceIndex >= 0; faceIndex--) {
      const face = at(world.faces, Math.abs(at(world.faceIndexes, area.firstFace + faceIndex)));
      if ((face.flags & FACE_SOLID) !== 0) continue;
      const otherArea = face.frontArea !== areaNumber ? face.frontArea : face.backArea;
      const otherIndex = areaNumbers.indexOf(otherArea);
      if (otherIndex >= 0 && at(connected, otherIndex) === 0) pending.push(otherIndex);
    }
  }
  for (let index = 0; index < areaNumbers.length; index++) {
    if (at(connected, index) === 0) return false;
  }
  return true;
}

type FloodFrame = { readonly kind: "enter"; readonly areaNumber: number }
  | { readonly kind: "faces"; readonly areaNumber: number; readonly area: AasArea; readonly index: number }
  | { readonly kind: "reachabilities"; readonly areaNumber: number; readonly index: number };

/** Borrows the actual map allocations; initialization publishes every source write. */
export class AasClustering {
  noFaceFlood = true;

  constructor(private readonly world: AasWorldState, private readonly options: AasClusteringOptions) {}

  removeClusterAreas(): void {
    for (let area = 1; area < this.world.areas.length; area++) this.world.areaSettingsRecord(area).cluster = 0;
  }

  clearCluster(cluster: number): void {
    for (let area = 1; area < this.world.areas.length; area++) {
      const settings = this.world.areaSettingsRecord(area);
      if (settings.cluster === cluster) settings.cluster = 0;
    }
  }

  removePortalsClusterReference(cluster: number): void {
    for (let portalNumber = 1; portalNumber < this.world.numPortals; portalNumber++) {
      const portal = this.world.portalRecord(portalNumber);
      if (portal.frontCluster === cluster) portal.frontCluster = 0;
      if (portal.backCluster === cluster) portal.backCluster = 0;
    }
  }

  updatePortal(area: number, clusterNumber: number): boolean {
    let portalNumber = 1;
    for (; portalNumber < this.world.numPortals; portalNumber++) {
      if (this.world.portalRecord(portalNumber).area === area) break;
    }
    if (portalNumber === this.world.numPortals) {
      this.options.print(4, `no portal of area ${area}`);
      return true;
    }
    const portal = this.world.portalRecord(portalNumber);
    if (portal.frontCluster === clusterNumber || portal.backCluster === clusterNumber) return true;
    if (portal.frontCluster === 0) portal.frontCluster = clusterNumber;
    else if (portal.backCluster === 0) portal.backCluster = clusterNumber;
    else {
      this.world.areaSettingsRecord(area).contents &= ~CLUSTER_PORTAL;
      this.options.log.write(`portal area ${area} is seperating more than two clusters\r\n`);
      return false;
    }
    if (this.world.portalIndexSize >= MAX_PORTAL_INDEX) {
      this.options.print(4, "AAS_MAX_PORTALINDEXSIZE");
      return true;
    }
    this.world.areaSettingsRecord(area).cluster = -portalNumber;
    const cluster = this.world.clusterRecord(clusterNumber);
    this.world.setPortalIndex(cluster.firstPortal + cluster.portalCount, portalNumber);
    this.world.portalIndexSize++;
    cluster.portalCount++;
    return true;
  }

  /** AAS_FloodClusterAreas_r, with continuations replacing the C call stack. */
  floodClusterAreas(areaNumber: number, clusterNumber: number): boolean {
    const pending: FloodFrame[] = [{ kind: "enter", areaNumber }];
    while (pending.length !== 0) {
      const frame = pending.pop();
      if (frame === undefined) break;
      if (frame.kind === "enter") {
        if (frame.areaNumber <= 0 || frame.areaNumber >= this.world.areas.length) {
          this.options.print(4, "AAS_FloodClusterAreas_r: areanum out of range");
          return false;
        }
        const settings = this.world.areaSettingsRecord(frame.areaNumber);
        if (settings.cluster > 0) {
          if (settings.cluster === clusterNumber) continue;
          this.options.print(4, `cluster ${clusterNumber} touched cluster ${settings.cluster} at area ${frame.areaNumber}\r\n`);
          return false;
        }
        if ((settings.contents & CLUSTER_PORTAL) !== 0) {
          if (!this.updatePortal(frame.areaNumber, clusterNumber)) return false;
          continue;
        }
        settings.cluster = clusterNumber;
        const cluster = this.world.clusterRecord(clusterNumber);
        settings.clusterAreaNumber = cluster.areaCount;
        cluster.areaCount++;
        const area = at(this.world.areas, frame.areaNumber);
        pending.push(this.noFaceFlood
          ? { kind: "reachabilities", areaNumber: frame.areaNumber, index: 0 }
          : { kind: "faces", areaNumber: frame.areaNumber, area, index: 0 });
      } else if (frame.kind === "faces") {
        if (frame.index >= frame.area.faceCount) {
          pending.push({ kind: "reachabilities", areaNumber: frame.areaNumber, index: 0 });
          continue;
        }
        const face = at(this.world.faces, Math.abs(at(this.world.faceIndexes, frame.area.firstFace + frame.index)));
        pending.push({ ...frame, index: frame.index + 1 });
        const otherArea = face.frontArea === frame.areaNumber ? face.backArea : face.frontArea;
        if (otherArea !== 0) pending.push({ kind: "enter", areaNumber: otherArea });
      } else {
        const settings = this.world.areaSettingsRecord(frame.areaNumber);
        if (frame.index >= settings.reachableAreaCount) continue;
        const otherArea = at(this.world.reachability, settings.firstReachableArea + frame.index).area;
        pending.push({ ...frame, index: frame.index + 1 });
        if (otherArea !== 0) pending.push({ kind: "enter", areaNumber: otherArea });
      }
    }
    return true;
  }

  floodClusterAreasUsingReachabilities(clusterNumber: number): boolean {
    for (let area = 1; area < this.world.areas.length; area++) {
      const settings = this.world.areaSettingsRecord(area);
      if (settings.cluster !== 0 || (settings.contents & CLUSTER_PORTAL) !== 0) continue;
      for (let index = 0; index < settings.reachableAreaCount; index++) {
        const target = at(this.world.reachability, settings.firstReachableArea + index).area;
        const other = this.world.areaSettingsRecord(target);
        if ((other.contents & CLUSTER_PORTAL) !== 0) continue;
        if (other.cluster !== 0) {
          if (!this.floodClusterAreas(area, clusterNumber)) return false;
          area = 0;
          break;
        }
      }
    }
    return true;
  }

  numberClusterPortals(clusterNumber: number): void {
    const cluster = this.world.clusterRecord(clusterNumber);
    for (let index = 0; index < cluster.portalCount; index++) {
      const portal = this.world.portalRecord(this.world.portalIndexValue(cluster.firstPortal + index));
      portal.clusterAreaNumbers[portal.frontCluster === clusterNumber ? 0 : 1] = cluster.areaCount++;
    }
  }

  numberClusterAreas(clusterNumber: number): void {
    const cluster = this.world.clusterRecord(clusterNumber);
    cluster.areaCount = 0;
    cluster.reachabilityAreaCount = 0;
    for (const withReachabilities of [true, false]) {
      for (let area = 1; area < this.world.areas.length; area++) {
        const settings = this.world.areaSettingsRecord(area);
        if (settings.cluster !== clusterNumber || (this.areaReachability(area) !== 0) !== withReachabilities) continue;
        settings.clusterAreaNumber = cluster.areaCount++;
        if (withReachabilities) cluster.reachabilityAreaCount++;
      }
      for (let index = 0; index < cluster.portalCount; index++) {
        const portal = this.world.portalRecord(this.world.portalIndexValue(cluster.firstPortal + index));
        if ((this.areaReachability(portal.area) !== 0) !== withReachabilities) continue;
        portal.clusterAreaNumbers[portal.frontCluster === clusterNumber ? 0 : 1] = cluster.areaCount++;
        if (withReachabilities) cluster.reachabilityAreaCount++;
      }
    }
  }

  findClusters(): boolean {
    this.removeClusterAreas();
    for (let area = 1; area < this.world.areas.length; area++) {
      const settings = this.world.areaSettingsRecord(area);
      if (settings.cluster !== 0) continue;
      if (this.noFaceFlood && settings.reachableAreaCount === 0) continue;
      if ((settings.contents & CLUSTER_PORTAL) !== 0) continue;
      if (this.world.numClusters >= MAX_CLUSTERS) {
        this.options.print(4, "AAS_MAX_CLUSTERS");
        return false;
      }
      const cluster = this.world.clusterRecord(this.world.numClusters);
      cluster.areaCount = 0;
      cluster.reachabilityAreaCount = 0;
      cluster.firstPortal = this.world.portalIndexSize;
      cluster.portalCount = 0;
      if (!this.floodClusterAreas(area, this.world.numClusters)) return false;
      if (!this.floodClusterAreasUsingReachabilities(this.world.numClusters)) return false;
      this.numberClusterAreas(this.world.numClusters);
      this.world.numClusters++;
    }
    return true;
  }

  createPortals(): void {
    for (let area = 1; area < this.world.areas.length; area++) {
      if ((this.world.areaSettingsRecord(area).contents & CLUSTER_PORTAL) === 0) continue;
      if (this.world.numPortals >= MAX_PORTALS) {
        this.options.print(4, "AAS_MAX_PORTALS");
        return;
      }
      const portal = this.world.portalRecord(this.world.numPortals);
      portal.area = area;
      portal.frontCluster = 0;
      portal.backCluster = 0;
      this.world.numPortals++;
    }
  }

  /** AAS_GetAdjacentAreasWithLessPresenceTypes_r. */
  adjacentAreasWithLessPresenceTypes(areaNumbers: number[], areaNumber: number): number {
    portalAreaPush(areaNumbers, areaNumber, "areanums");
    const area = at(this.world.areas, areaNumber);
    const presence = this.world.areaSettingsRecord(areaNumber).presenceType;
    for (let index = 0; index < area.faceCount; index++) {
      const face = at(this.world.faces, Math.abs(at(this.world.faceIndexes, area.firstFace + index)));
      if ((face.flags & FACE_SOLID) !== 0) continue;
      const otherArea = face.frontArea !== areaNumber ? face.frontArea : face.backArea;
      const otherPresence = this.world.areaSettingsRecord(otherArea).presenceType;
      if ((presence & ~otherPresence) === 0 || (otherPresence & ~presence) !== 0 || areaNumbers.includes(otherArea)) continue;
      if (areaNumbers.length >= MAX_PORTAL_AREAS) {
        this.options.print(4, "MAX_PORTALAREAS");
        return areaNumbers.length;
      }
      this.adjacentAreasWithLessPresenceTypes(areaNumbers, otherArea);
    }
    return areaNumbers.length;
  }

  checkAreaForPossiblePortals(areaNumber: number): number {
    const settings = this.world.areaSettingsRecord(areaNumber);
    if ((settings.contents & CLUSTER_PORTAL) !== 0 || (settings.flags & AREA_GROUNDED) === 0) return 0;
    const areaNumbers: number[] = [];
    const frontFaceCounts = new Int32Array(MAX_PORTAL_AREAS);
    const backFaceCounts = new Int32Array(MAX_PORTAL_AREAS);
    const frontFaces: number[] = [], backFaces: number[] = [];
    const frontAreas: number[] = [], backAreas: number[] = [];
    let frontPlane = -1, backPlane = -1;
    this.adjacentAreasWithLessPresenceTypes(areaNumbers, areaNumber);
    for (let index = 0; index < areaNumbers.length; index++) {
      const currentArea = at(areaNumbers, index);
      const area = at(this.world.areas, currentArea);
      for (let faceIndex = 0; faceIndex < area.faceCount; faceIndex++) {
        const faceNumber = Math.abs(at(this.world.faceIndexes, area.firstFace + faceIndex));
        const face = at(this.world.faces, faceNumber);
        if ((face.flags & FACE_SOLID) !== 0) continue;
        if (areaNumbers.some((other, otherIndex) => otherIndex !== index && (face.frontArea === other || face.backArea === other))) continue;
        const otherArea = face.frontArea === currentArea ? face.backArea : face.frontArea;
        if ((this.world.areaSettingsRecord(otherArea).contents & CLUSTER_PORTAL) !== 0) return 0;
        const plane = face.plane & ~1;
        if (frontPlane < 0 || plane === frontPlane) {
          frontPlane = plane;
          portalAreaPush(frontFaces, faceNumber, "frontfacenums");
          if (!frontAreas.includes(otherArea)) portalAreaPush(frontAreas, otherArea, "frontareanums");
          frontFaceCounts[index] = at(frontFaceCounts, index) + 1;
        } else if (backPlane < 0 || plane === backPlane) {
          backPlane = plane;
          portalAreaPush(backFaces, faceNumber, "backfacenums");
          if (!backAreas.includes(otherArea)) portalAreaPush(backAreas, otherArea, "backareanums");
          backFaceCounts[index] = at(backFaceCounts, index) + 1;
        } else return 0;
      }
    }
    for (let index = 0; index < areaNumbers.length; index++) {
      if (at(frontFaceCounts, index) === 0 || at(backFaceCounts, index) === 0) return 0;
    }
    if (!connectedAreas(this.world, frontAreas) || !connectedAreas(this.world, backAreas)) return 0;
    for (const frontNumber of frontFaces) {
      const front = at(this.world.faces, frontNumber);
      for (let frontEdge = 0; frontEdge < front.edgeCount; frontEdge++) {
        const edgeNumber = Math.abs(at(this.world.edgeIndexes, front.firstEdge + frontEdge));
        for (const backNumber of backFaces) {
          const back = at(this.world.faces, backNumber);
          for (let backEdge = 0; backEdge < back.edgeCount; backEdge++) {
            if (edgeNumber === Math.abs(at(this.world.edgeIndexes, back.firstEdge + backEdge))) return 0;
          }
        }
      }
    }
    for (const area of areaNumbers) {
      this.world.areaSettingsRecord(area).contents |= CLUSTER_PORTAL;
      this.world.areaSettingsRecord(area).contents |= ROUTE_PORTAL;
      this.options.log.write(`possible portal: ${area}\r\n`);
    }
    return areaNumbers.length;
  }

  findPossiblePortals(): void {
    let count = 0;
    for (let area = 1; area < this.world.areas.length; area++) count = (count + this.checkAreaForPossiblePortals(area)) | 0;
    this.options.print(1, `\r${String(count).padStart(6)} possible portal areas\n`);
  }

  removeAllPortals(): void {
    for (let area = 1; area < this.world.areas.length; area++) this.world.areaSettingsRecord(area).contents &= ~CLUSTER_PORTAL;
  }

  testPortals(): boolean {
    for (let portalNumber = 1; portalNumber < this.world.numPortals; portalNumber++) {
      const portal = this.world.portalRecord(portalNumber);
      if (portal.frontCluster === 0) {
        this.world.areaSettingsRecord(portal.area).contents &= ~CLUSTER_PORTAL;
        this.options.log.write(`portal area ${portal.area} has no front cluster\r\n`);
        return false;
      }
      if (portal.backCluster === 0) {
        this.world.areaSettingsRecord(portal.area).contents &= ~CLUSTER_PORTAL;
        this.options.log.write(`portal area ${portal.area} has no back cluster\r\n`);
        return false;
      }
    }
    return true;
  }

  countForcedClusterPortals(): void {
    let count = 0;
    for (let area = 1; area < this.world.areas.length; area++) {
      if ((this.world.areaSettingsRecord(area).contents & CLUSTER_PORTAL) === 0) continue;
      this.options.log.write(`area ${area} is a forced portal area\r\n`);
      count++;
    }
    this.options.print(1, `${String(count).padStart(6)} forced portal areas\n`);
  }

  createViewPortals(): void {
    for (let area = 1; area < this.world.areas.length; area++) {
      const settings = this.world.areaSettingsRecord(area);
      if ((settings.contents & CLUSTER_PORTAL) !== 0) settings.contents |= VIEW_PORTAL;
    }
  }

  setViewPortalsAsClusterPortals(): void {
    for (let area = 1; area < this.world.areas.length; area++) {
      const settings = this.world.areaSettingsRecord(area);
      if ((settings.contents & VIEW_PORTAL) !== 0) settings.contents |= CLUSTER_PORTAL;
    }
  }

  /** AAS_InitClustering, called only after the runtime has loaded this world. */
  initialize(): void {
    if (this.world.numClusters >= 1
      && sourceInteger(this.options.variables.getValue("forceclustering")) === 0
      && sourceInteger(this.options.variables.getValue("forcereachability")) === 0) return;
    this.setViewPortalsAsClusterPortals();
    this.countForcedClusterPortals();
    this.removeClusterAreas();
    this.findPossiblePortals();
    this.createViewPortals();
    this.world.allocatePortals(MAX_PORTALS);
    this.world.allocatePortalIndexes(MAX_PORTAL_INDEX);
    this.world.allocateClusters(MAX_CLUSTERS);
    let removedPortalAreas = 0;
    this.options.print(1, `\r${String(removedPortalAreas).padStart(6)} removed portal areas`);
    for (;;) {
      this.options.print(1, `\r${String(removedPortalAreas).padStart(6)}`);
      this.world.numPortals = 1;
      this.world.portalIndexSize = 0;
      this.world.numClusters = 1;
      this.createPortals();
      removedPortalAreas = (removedPortalAreas + 1) | 0;
      if (!this.findClusters()) continue;
      if (!this.testPortals()) continue;
      break;
    }
    this.options.print(1, "\n");
    this.world.saveFile = true;
    for (let portal = 1; portal < this.world.numPortals; portal++) {
      this.options.log.write(`portal ${portal}: area ${this.world.portalRecord(portal).area}\r\n`);
    }
    this.options.print(1, `${String(this.world.numPortals).padStart(6)} portals created\n`);
    this.options.print(1, `${String(this.world.numClusters).padStart(6)} clusters created\n`);
    for (let cluster = 1; cluster < this.world.numClusters; cluster++) {
      this.options.print(1, `cluster ${cluster} has ${this.world.clusterRecord(cluster).reachabilityAreaCount} reachability areas\n`);
    }
    let reachabilityAreas = 0, total = 0;
    for (let cluster = 0; cluster < this.world.numClusters; cluster++) {
      const count = this.world.clusterRecord(cluster).reachabilityAreaCount;
      reachabilityAreas = (reachabilityAreas + count) | 0;
      total = (total + Math.imul(count, count)) | 0;
    }
    total = (total + Math.imul(reachabilityAreas, this.world.numPortals)) | 0;
    this.options.print(1, `${String(reachabilityAreas).padStart(6)} total reachability areas\n`);
    this.options.print(1, `${String(Math.imul(total, 3)).padStart(6)} AAS memory/CPU usage (the lower the better)\n`);
  }

  private areaReachability(area: number): number {
    if (area < 0 || area >= this.world.areas.length) {
      this.options.print(4, `AAS_AreaReachability: areanum ${area} out of range`);
      return 0;
    }
    return this.world.areaSettingsRecord(area).reachableAreaCount;
  }
}
