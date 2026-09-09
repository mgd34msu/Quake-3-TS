// Port of id Software's server/sv_bot.c debug polygon drawing, imports and allocation,
// and botlib/be_aas_debug.c AAS_PermanentLine.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { add3, cross3, dot3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import type { BotLibrary } from "../botlib/library.ts";
import type { CvarRegistry, CvarSnapshot } from "../core/cvar.ts";
import type { EntityShared } from "../shared/entity-shared.ts";
import { CommandButtons } from "../shared/player-state.ts";

export type DebugPolygonDraw = (color: number, numPoints: number, points: readonly Vec3[]) => undefined;

export interface BotDebugServer {
  readonly botEnabled: () => boolean;
  readonly clientCommandButtons: () => number;
  readonly clientEntity: () => Pick<EntityShared, "currentOrigin" | "currentAngles">;
}

type DebugCvars = Pick<CvarRegistry, "register" | "get">;
type DebugCvarName = "bot_debug" | "bot_reachability" | "bot_groundonly" | "bot_highlightarea";

export interface BotDebugServices extends BotDebugServer {
  readonly cvars: DebugCvars;
  readonly library: Pick<BotLibrary, "variables"> & {
    test(...args: Parameters<BotLibrary["test"]>): ReturnType<BotLibrary["test"]>;
  };
}

export interface BotDebugPolygon {
  readonly inuse: boolean;
  readonly color: number;
  readonly numPoints: number;
  readonly points: readonly Vec3[];
}

interface PointCell { x: number; y: number; z: number }
interface PolygonCell {
  inuse: boolean;
  color: number;
  numPoints: number;
  readonly points: PointCell[];
}

/** Server-lived storage; SV_BotInitBotLib replaces its allocation. */
export class BotDebugPolygons {
  private polygons: PolygonCell[] | null = null;
  private readonly registeredDrawCvars = new Set<DebugCvarName>();

  get rows(): readonly BotDebugPolygon[] { return this.polygons ?? []; }

  /** BotDrawDebugPolygons; value is unused by the selected source function. */
  draw(drawPoly: DebugPolygonDraw, _value: number, services: BotDebugServices): undefined {
    if (this.polygons === null) return;
    const cvars = services.cvars;
    this.registerDrawCvar(cvars, "bot_debug", "0");
    if (services.botEnabled() && this.drawCvar(cvars, "bot_debug").integerValue !== 0) {
      this.registerDrawCvar(cvars, "bot_reachability", "0");
      this.registerDrawCvar(cvars, "bot_groundonly", "1");
      this.registerDrawCvar(cvars, "bot_highlightarea", "0");
      let flags = 0;
      if ((services.clientCommandButtons() & CommandButtons.ATTACK) !== 0) flags |= 1;
      if (this.drawCvar(cvars, "bot_reachability").integerValue !== 0) flags |= 2;
      if (this.drawCvar(cvars, "bot_groundonly").integerValue !== 0) flags |= 4;
      services.library.variables.set("bot_highlightarea", this.drawCvar(cvars, "bot_highlightarea").value);
      const entity = services.clientEntity();
      services.library.test(flags, null, entity.currentOrigin, entity.currentAngles);
    }
    for (let index = 0; index < this.polygons.length; index++) {
      const polygon = this.polygon(index);
      if (polygon.inuse) drawPoly(polygon.color, polygon.numPoints, polygon.points);
    }
  }

  initialize(capacity: number): void {
    this.polygons = null;
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > Math.floor(0x7fffffff / 1548)) {
      throw new RangeError("Bot debug polygon allocation exceeds signed source storage");
    }
    // Z_Malloc clears the complete allocation, including unused point cells.
    this.polygons = Array.from({ length: capacity }, () => ({
      inuse: false, color: 0, numPoints: 0,
      points: Array.from({ length: 128 }, () => ({ x: 0, y: 0, z: 0 })),
    }));
  }

  create(color: number, numPoints: number, points: readonly Vec3[]): number {
    if (this.polygons === null) return 0;
    for (let id = 1; id < this.polygons.length; id++) {
      const polygon = this.polygon(id);
      if (polygon.inuse) continue;
      this.write(polygon, color, numPoints, points);
      return id;
    }
    return 0;
  }

  show(id: number, color: number, numPoints: number, points: readonly Vec3[]): void {
    if (this.polygons === null) return;
    this.write(this.polygon(id), color, numPoints, points);
  }

  delete(id: number): void {
    if (this.polygons === null) return;
    this.polygon(id).inuse = false;
  }

  lineCreate(): number { return this.create(0, 0, []); }
  lineDelete(line: number): void { this.delete(line); }

  lineShow(line: number, start: Vec3, end: Vec3, color: number): void {
    const first = vec3(start.x, start.y, start.z);
    const last = vec3(end.x, end.y, end.z);
    const direction = normalize3(sub3(last, first));
    const up = vec3(0, 0, 1);
    const dot = dot3(direction, up);
    const cross = normalize3(dot > 0.99 || dot < -0.99 ? vec3(1, 0, 0) : cross3(direction, up));
    this.show(line, color, 4, [
      add3(first, scale3(cross, 2)),
      add3(first, scale3(cross, -2)),
      add3(last, scale3(cross, -2)),
      add3(last, scale3(cross, 2)),
    ]);
  }

  permanentLine(start: Vec3, end: Vec3, color: number): void {
    const line = this.lineCreate();
    this.lineShow(line, start, end, color);
  }

  private registerDrawCvar(cvars: DebugCvars, name: DebugCvarName, initial: string): void {
    if (this.registeredDrawCvars.has(name)) return;
    cvars.register(name, initial, 0);
    this.registeredDrawCvars.add(name);
  }

  private drawCvar(cvars: DebugCvars, name: DebugCvarName): CvarSnapshot {
    const variable = cvars.get(name);
    if (variable === undefined) throw new Error(`Bot draw cvar ${name} no longer has source storage`);
    return variable;
  }

  private polygon(id: number): PolygonCell {
    const polygon = this.polygons?.[id];
    if (!Number.isInteger(id) || id < 0 || polygon === undefined) {
      throw new RangeError(`Bot debug polygon ${id} is outside the source allocation`);
    }
    return polygon;
  }

  private write(polygon: PolygonCell, color: number, numPoints: number, points: readonly Vec3[]): void {
    polygon.inuse = true;
    polygon.color = color;
    polygon.numPoints = numPoints;
    // Source publishes metadata before memcpy. Invalid source memory access is
    // explicit here; it does not roll back preceding writes or clamp counts.
    if (!Number.isInteger(numPoints) || numPoints < 0 || numPoints > 128) {
      throw new RangeError(`Bot debug polygon point count ${numPoints} exceeds source storage`);
    }
    for (let index = 0; index < numPoints; index++) {
      const point = points[index];
      const target = polygon.points[index];
      if (point === undefined || target === undefined) {
        throw new RangeError(`Bot debug polygon point ${index} is outside the source allocation`);
      }
      target.x = Math.fround(point.x);
      target.y = Math.fround(point.y);
      target.z = Math.fround(point.z);
    }
  }
}
