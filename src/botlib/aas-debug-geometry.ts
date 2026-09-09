// Port of id Software's botlib/be_aas_debug.c face, area and reachability drawing.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { add3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import type { AasFace, AasReachability, AasWorld } from "./aas.ts";
import type { AasDebugLines } from "./aas-debug.ts";
import type { AasSpatial } from "./spatial.ts";
import { TravelType } from "./routing.ts";
import type { BotMemory } from "./memory.ts";

interface AasDebugImports {
  polygonCreate(color: number, count: number, points: readonly Vec3[]): number;
  polygonDelete(handle: number): void;
  print(severity: 1 | 3, message: string): void;
  readonly debugBuild: boolean;
  memory(): BotMemory;
}

function at<T>(rows: readonly T[], index: number): T {
  const row = rows[index];
  if (row === undefined) throw new RangeError(`AAS debug index ${index} exceeds source allocation ${rows.length}`);
  return row;
}

export class AasDebugGeometry {
  private readonly polygons = new Int32Array(8192);
  private reachability: AasReachability = { area: 0, face: 0, edge: 0, start: vec3(0, 0, 0), end: vec3(0, 0, 0), travelType: 0, travelTime: 0, padding: 0 };
  private reachabilityIndex = 0;
  private lastArea = 0;
  private lastTime = 0;

  constructor(readonly lines: AasDebugLines, private readonly imports: AasDebugImports) {}

  clearPolygons(): void {
    for (let index = 0; index < this.polygons.length; index++) {
      const handle = this.polygons[index];
      if (handle === undefined) throw new RangeError("AAS polygon index exceeds source allocation");
      if (handle !== 0) this.imports.polygonDelete(handle);
      this.polygons[index] = 0;
    }
  }

  showPolygon(color: number, count: number, points: readonly Vec3[]): void {
    for (let index = 0; index < this.polygons.length; index++) {
      if (this.polygons[index] !== 0) continue;
      this.polygons[index] = this.imports.polygonCreate(color, count, points);
      break;
    }
  }

  private face(world: AasWorld, number: number): AasFace {
    if (number >= world.faces.length) this.imports.print(3, `facenum ${number} out of range\n`);
    return at(world.faces, number);
  }

  showFace(world: AasWorld, number: number): void {
    const face = this.face(world, number);
    let color = 4;
    for (let index = 0; index < face.edgeCount; index++) {
      const edgeNumber = Math.abs(at(world.edgeIndexes, face.firstEdge + index));
      if (edgeNumber >= world.edges.length) this.imports.print(3, `edgenum ${edgeNumber} out of range\n`);
      const edge = at(world.edges, edgeNumber);
      color = color === 1 ? 2 : color === 2 ? 3 : color === 3 ? 4 : 1;
      this.lines.line(at(world.vertices, edge.vertices[0]), at(world.vertices, edge.vertices[1]), color);
    }
    const plane = at(world.planes, face.plane);
    const edge = at(world.edges, Math.abs(at(world.edgeIndexes, face.firstEdge)));
    const start = at(world.vertices, edge.vertices[0]);
    this.lines.line(start, add3(start, scale3(plane.normal, 20)), 1);
  }

  showFacePolygon(world: AasWorld, number: number, color: number, flip: boolean): void {
    const face = this.face(world, number), points: Vec3[] = [];
    for (let step = 0; step < face.edgeCount; step++) {
      const index = flip ? face.edgeCount - 1 - step : step;
      const edgeNumber = at(world.edgeIndexes, face.firstEdge + index), edge = at(world.edges, Math.abs(edgeNumber));
      const point = at(world.vertices, edge.vertices[edgeNumber < 0 ? 1 : 0]);
      if (points.length === 128) throw new RangeError("AAS_ShowFacePolygon exceeds source points[128]");
      points.push(vec3(point.x, point.y, point.z));
    }
    this.showPolygon(color, points.length, points);
  }

  showArea(world: AasWorld, areaNumber: number, groundOnly: boolean): void {
    if (!this.validArea(world, areaNumber)) return;
    const area = at(world.areas, areaNumber), edges: number[] = [];
    for (let index = 0; index < area.faceCount; index++) {
      const face = this.face(world, Math.abs(at(world.faceIndexes, area.firstFace + index)));
      if (groundOnly && (face.flags & 6) === 0) continue;
      for (let index = 0; index < face.edgeCount; index++) {
        const edge = Math.abs(at(world.edgeIndexes, face.firstEdge + index));
        if (edge >= world.edges.length) this.imports.print(3, `edgenum ${edge} out of range\n`);
        if (!edges.includes(edge) && edges.length < 1024) edges.push(edge);
      }
    }
    let color = 0;
    for (const number of edges) {
      if (!this.lines.lineFrom(() => {
        const edge = at(world.edges, number);
        color = color === 1 ? 3 : color === 3 ? 2 : color === 2 ? 4 : 1;
        return { start: at(world.vertices, edge.vertices[0]), end: at(world.vertices, edge.vertices[1]), color };
      })) return;
    }
  }

  private validArea(world: AasWorld, area: number): boolean {
    if (area >= 0 && area < world.areas.length) return true;
    this.imports.print(3, `area ${area} out of range [0, ${world.areas.length}]\n`);
    return false;
  }

  showAreaPolygons(world: AasWorld, areaNumber: number, color: number, groundOnly: boolean): void {
    if (!this.validArea(world, areaNumber)) return;
    const area = at(world.areas, areaNumber);
    for (let index = 0; index < area.faceCount; index++) {
      const number = Math.abs(at(world.faceIndexes, area.firstFace + index)), face = this.face(world, number);
      if (groundOnly && (face.flags & 6) === 0) continue;
      this.showFacePolygon(world, number, color, face.frontArea !== areaNumber);
    }
  }

  printTravelType(type: number): void {
    if (!this.imports.debugBuild) return;
    const names = ["UNKNOWN TRAVEL TYPE", "TRAVEL_INVALID", "TRAVEL_WALK", "TRAVEL_CROUCH", "TRAVEL_BARRIERJUMP", "TRAVEL_JUMP", "TRAVEL_LADDER", "TRAVEL_WALKOFFLEDGE", "TRAVEL_SWIM", "TRAVEL_WATERJUMP", "TRAVEL_TELEPORT", "TRAVEL_ELEVATOR", "TRAVEL_ROCKETJUMP", "TRAVEL_BFGJUMP", "TRAVEL_GRAPPLEHOOK", "UNKNOWN TRAVEL TYPE", "UNKNOWN TRAVEL TYPE", "UNKNOWN TRAVEL TYPE", "TRAVEL_JUMPPAD", "TRAVEL_FUNCBOB"];
    this.imports.print(1, names[type & TravelType.MASK] ?? "UNKNOWN TRAVEL TYPE");
  }

  showReachability(spatial: AasSpatial, reach: AasReachability): void {
    this.showAreaPolygons(spatial.world, reach.area, 5, true);
    this.lines.drawArrow(reach.start, reach.end, 3, 4);
    const type = reach.travelType & TravelType.MASK, movement = spatial.movement;
    const jumpVelocity = movement.settings.jumpVelocity;
    if (type === TravelType.JUMP || type === TravelType.WALKOFFLEDGE) {
      const speed = movement.horizontalVelocityForJump(jumpVelocity, reach.start, reach.end).velocity;
      const delta = sub3(reach.end, reach.start), direction = normalize3(vec3(delta.x, delta.y, 0));
      movement.predictClientMovement({ entityNum: -1, origin: reach.start, presence: 2, onGround: true,
        velocity: scale3(direction, speed), commandMove: vec3(0, 0, jumpVelocity), commandFrames: 3,
        maxFrames: 30, frameTime: Math.fround(0.1), stopEvents: 1 | 4 | 8 | 16 | 32, stopArea: 0, visualize: true });
      if (type === TravelType.JUMP) this.lines.drawCross(movement.jumpReachRunStart(reach), 4, 3);
    } else if (type === TravelType.ROCKETJUMP || type === TravelType.JUMPPAD) {
      const zVelocity = type === TravelType.ROCKETJUMP ? movement.rocketJumpZVelocity(reach.start) : reach.face;
      const speed = type === TravelType.ROCKETJUMP ? movement.horizontalVelocityForJump(zVelocity, reach.start, reach.end).velocity : reach.edge;
      const delta = sub3(reach.end, reach.start), direction = normalize3(vec3(delta.x, delta.y, 0));
      const horizontal = scale3(direction, speed);
      movement.predictClientMovement({ entityNum: -1, origin: reach.start, presence: 2, onGround: true,
        velocity: type === TravelType.ROCKETJUMP ? vec3(0, 0, zVelocity) : vec3(horizontal.x, horizontal.y, zVelocity),
        commandMove: type === TravelType.ROCKETJUMP ? horizontal : vec3(0, 0, 0), commandFrames: 30,
        maxFrames: 30, frameTime: Math.fround(0.1), stopEvents: 4 | 8 | 16 | 32 | 128 | 1024, stopArea: reach.area, visualize: true });
    }
  }

  showReachableAreas(spatial: AasSpatial, area: number, time: number): void {
    if (area !== this.lastArea) { this.reachabilityIndex = 0; this.lastArea = area; }
    const settings = at(spatial.world.areaSettings, area);
    if (settings.reachableAreaCount === 0) return;
    if (this.reachabilityIndex >= settings.reachableAreaCount) this.reachabilityIndex = 0;
    if (Math.fround(time - this.lastTime) > 1.5) {
      const reach = at(spatial.world.reachability, settings.firstReachableArea + this.reachabilityIndex);
      this.reachability = { ...reach, start: vec3(reach.start.x, reach.start.y, reach.start.z), end: vec3(reach.end.x, reach.end.y, reach.end.z) };
      this.reachabilityIndex++;
      this.lastTime = Math.fround(time);
      this.printTravelType(reach.travelType & TravelType.MASK);
      this.imports.print(1, "\n");
    }
    this.showReachability(spatial, this.reachability);
  }

  floodAreas(world: AasWorld, origin: Vec3): void {
    const allocation = this.imports.memory().allocate(world.areas.length * 4, "heap", true);
    const bytes = allocation.bytes;
    const done = new Int32Array(bytes.buffer, bytes.byteOffset, world.areas.length);
    const area = world.pointArea(origin), cluster = at(world.areaSettings, area).cluster;
    this.floodAreasRecursive(world, area, cluster, done);
  }

  floodAreasRecursive(world: AasWorld, areaNumber: number, cluster: number, done: Int32Array): void {
    this.showAreaPolygons(world, areaNumber, 1, true);
    const area = at(world.areas, areaNumber), settings = at(world.areaSettings, areaNumber);
    const visit = (next: number): void => {
      if (next === 0) return;
      const visited = done[next];
      if (visited === undefined) throw new RangeError("AAS_FloodAreas done index exceeds allocation");
      if (visited !== 0) return;
      done[next] = 1;
      const settings = at(world.areaSettings, next);
      if ((settings.contents & 512) !== 0 || settings.cluster !== cluster) return;
      this.floodAreasRecursive(world, next, cluster, done);
    };
    for (let index = 0; index < area.faceCount; index++) {
      const face = at(world.faces, Math.abs(at(world.faceIndexes, area.firstFace + index)));
      visit(face.frontArea === areaNumber ? face.backArea : face.frontArea);
    }
    for (let index = 0; index < settings.reachableAreaCount; index++) visit(at(world.reachability, settings.firstReachableArea + index).area);
  }
}
