// Port of id Software's botlib/be_aas_debug.c retained debug-line operations.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { Vec3 } from "../core/math.ts";
import { add3, cross3, dot3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import type { AasMovementDebug } from "./aas-movement.ts";

interface DebugLineImports {
  lineCreate(): number;
  lineShow(line: number, start: Vec3, end: Vec3, color: number): void;
  lineDelete(line: number): void;
}

export class AasDebugLines {
  private readonly lines = Array.from({ length: 1024 }, () => ({ handle: 0, visible: false }));
  private allocatedCount = 0;
  readonly movement: Extract<AasMovementDebug, { readonly kind: "enabled" }>;

  constructor(private readonly imports: DebugLineImports, print: (text: string) => void) {
    this.movement = {
      kind: "enabled",
      line: (start, end, color) => { this.line(start, end, color === "red" ? 1 : 3); },
      print,
      clearLines: () => { this.clear(); },
    };
  }

  get numDebugLines(): number { return this.allocatedCount; }

  permanentLine(start: Vec3, end: Vec3, color: number): void {
    this.imports.lineShow(this.imports.lineCreate(), start, end, color);
  }

  drawCross(origin: Vec3, size: number, color: number, permanent = false): void {
    for (const axis of ["x", "y", "z"] satisfies readonly (keyof Vec3)[]) {
      const start = { ...origin, [axis]: Math.fround(origin[axis] + size) };
      const end = { ...origin, [axis]: Math.fround(origin[axis] - size) };
      this.line(start, end, color);
      if (permanent) this.permanentLine(start, end, color);
    }
  }

  drawPermanentCross(origin: Vec3, size: number, color: number): void {
    this.drawCross(origin, size, color, true);
  }

  drawArrow(start: Vec3, end: Vec3, lineColor: number, arrowColor: number): void {
    const direction = normalize3(sub3(end, start)), up = vec3(0, 0, 1);
    const dot = dot3(direction, up);
    const cross = dot > 0.99 || dot < -0.99 ? vec3(1, 0, 0) : cross3(direction, up);
    const base = add3(end, scale3(direction, -6));
    const first = add3(base, scale3(cross, 6)), second = add3(base, scale3(cross, -6));
    this.line(start, end, lineColor);
    this.line(first, end, arrowColor);
    this.line(second, end, arrowColor);
  }

  private reserveLines(count: number): readonly number[] {
    const result: number[] = [];
    for (const line of this.lines) {
      if (result.length === count) break;
      if (line.handle === 0) {
        line.handle = this.imports.lineCreate();
        line.visible = true;
        this.allocatedCount = (this.allocatedCount + 1) | 0;
        result.push(line.handle);
      } else if (!line.visible) {
        line.visible = true;
        result.push(line.handle);
      }
    }
    return result;
  }

  private showReserved(handles: readonly number[], index: number, start: Vec3, end: Vec3, color: number): void {
    const handle = handles[index];
    if (handle === undefined) throw new RangeError("AAS debug drawing reached an uninitialized source line handle");
    this.imports.lineShow(handle, start, end, color);
  }

  drawPlaneCross(point: Vec3, normal: Vec3, distance: number, type: number, color: number): void {
    const axes: readonly (keyof Vec3)[] = ["x", "y", "z"];
    const n0 = axes[type % 3], n1 = axes[(type + 1) % 3], n2 = axes[(type + 2) % 3];
    if (n0 === undefined || n1 === undefined || n2 === undefined) throw new RangeError("AAS plane type exceeds source axes");
    const pointOnPlane = (first: number, second: number): Vec3 => {
      const result = { ...point, [n1]: Math.fround(point[n1] + first), [n2]: Math.fround(point[n2] + second) };
      result[n0] = Math.fround(Math.fround(distance - Math.fround(Math.fround(result[n1] * normal[n1])
        + Math.fround(result[n2] * normal[n2]))) / normal[n0]);
      return result;
    };
    const start1 = pointOnPlane(-6, -6), end1 = pointOnPlane(6, 6);
    const start2 = pointOnPlane(6, -6), end2 = pointOnPlane(-6, 6);
    const handles = this.reserveLines(2);
    this.showReserved(handles, 0, start1, end1, color);
    this.showReserved(handles, 1, start2, end2, color);
  }

  showBoundingBox(origin: Vec3, mins: Vec3, maxs: Vec3): void {
    const upper = [vec3(origin.x + maxs.x, origin.y + maxs.y, origin.z + maxs.z),
      vec3(origin.x + mins.x, origin.y + maxs.y, origin.z + maxs.z),
      vec3(origin.x + mins.x, origin.y + mins.y, origin.z + maxs.z),
      vec3(origin.x + maxs.x, origin.y + mins.y, origin.z + maxs.z)];
    const lower = upper.map(point => vec3(point.x, point.y, origin.z + mins.z));
    for (let index = 0; index < 4; index++) {
      const top = upper[index], nextTop = upper[(index + 1) & 3];
      const bottom = lower[index], nextBottom = lower[(index + 1) & 3];
      if (top === undefined || nextTop === undefined || bottom === undefined || nextBottom === undefined) throw new RangeError("AAS bounding box corner exceeds source storage");
      const handles = this.reserveLines(3);
      this.showReserved(handles, 0, top, nextTop, 1);
      this.showReserved(handles, 1, bottom, nextBottom, 1);
      this.showReserved(handles, 2, top, bottom, 1);
    }
  }

  line(start: Vec3, end: Vec3, color: number): void {
    this.lineFrom(() => ({ start, end, color }));
  }

  lineFrom(resolve: () => { readonly start: Vec3; readonly end: Vec3; readonly color: number }): boolean {
    for (const line of this.lines) {
      if (line.handle === 0) {
        line.handle = this.imports.lineCreate();
        line.visible = false;
        this.allocatedCount = (this.allocatedCount + 1) | 0;
      }
      if (!line.visible) {
        const { start, end, color } = resolve();
        this.imports.lineShow(line.handle, start, end, color);
        line.visible = true;
        return true;
      }
    }
    return false;
  }

  clear(): void {
    for (const line of this.lines) {
      if (line.handle !== 0) {
        this.imports.lineDelete(line.handle);
        line.handle = 0;
        line.visible = false;
      }
    }
  }
}
