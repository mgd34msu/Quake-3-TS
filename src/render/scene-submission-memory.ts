// Source srfPoly_t/polyVert_t/dlight_t storage from id Software renderer/tr_local.h.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import { dot3, sub3 } from "../core/math.ts";
import type { Axis, Vec2, Vec3, Vec4 } from "../core/math.ts";
import type { SourceBackendMemory } from "./backend-memory.ts";
import type { DynamicLight } from "./lighting.ts";
import type { RefPolyVertex, SceneShader } from "./ref-entity.ts";
import type { SourceScenePoly } from "./scene-submission.ts";

function vector(read: () => DataView, offset: number): Vec3 {
  return {
    get x(): number { return read().getFloat32(offset, true); },
    get y(): number { return read().getFloat32(offset + 4, true); },
    get z(): number { return read().getFloat32(offset + 8, true); },
  };
}

function writeVector(data: DataView, offset: number, value: Vec3): void {
  data.setFloat32(offset, value.x, true);
  data.setFloat32(offset + 4, value.y, true);
  data.setFloat32(offset + 8, value.z, true);
}

/** Views borrow the renderer allocation; no numeric field survives outside its bytes. */
export class SourceSceneSubmissionMemory {
  readonly #vertices = new Map<number, RefPolyVertex>();

  constructor(readonly backend: SourceBackendMemory) {}

  /** Source fog bounds read verts[0] even when the polygon's count is zero. */
  firstVertex(index: number): RefPolyVertex {
    return this.vertex(this.backend.polyData(index).getUint32(16, true));
  }

  poly(index: number, readShader: (handle: number) => SceneShader | number = handle => handle): SourceScenePoly {
    const memory = this, selected = this.backend.polyData(index);
    const read = (): DataView => { this.backend.assertLive(); return selected; };
    let cachedPointer = -1, cachedCount = -1;
    let cachedVertices: readonly RefPolyVertex[] = [];
    return {
      get shader(): SceneShader | number { return readShader(read().getInt32(4, true)); },
      get fog(): number { return read().getInt32(8, true) - 1; },
      get vertices(): readonly RefPolyVertex[] {
        const data = read(), count = data.getInt32(12, true), pointer = data.getUint32(16, true);
        if (count < 0) throw new RangeError("Source polygon has a negative vertex count");
        if (count === cachedCount && pointer === cachedPointer) return cachedVertices;
        if (count === 0) cachedVertices = [];
        else {
          const first = memory.backend.resolvePolyVertexPointer(pointer);
          if (count > memory.backend.limits.maxPolyVertices - first)
            throw new RangeError("Source polygon vertices exceed the backend allocation");
          cachedVertices = Array.from({ length: count }, (_, vertexIndex) => memory.vertex(pointer + vertexIndex * 24));
        }
        cachedPointer = pointer; cachedCount = count;
        return cachedVertices;
      },
    };
  }

  private vertex(pointer: number): RefPolyVertex {
    const cached = this.#vertices.get(pointer);
    if (cached !== undefined) return cached;
    const read = (): DataView => this.backend.polyVertexDataAtPointer(pointer);
    const position = vector(read, 0);
    const texCoord: Vec2 = {
      get x(): number { return read().getFloat32(12, true); },
      get y(): number { return read().getFloat32(16, true); },
    };
    const color: Vec4 = {
      get x(): number { return read().getUint8(20); },
      get y(): number { return read().getUint8(21); },
      get z(): number { return read().getUint8(22); },
      get w(): number { return read().getUint8(23); },
    };
    const vertex: RefPolyVertex = {
      get position(): Vec3 { read(); return position; },
      get texCoord(): Vec2 { read(); return texCoord; },
      get color(): Vec4 { read(); return color; },
    };
    this.#vertices.set(pointer, vertex);
    return vertex;
  }

  /** RE_AddPolyToScene writes the header and copies vertices before advancing counters. */
  writePoly(index: number, shader: number, firstVertex: number, vertices: readonly RefPolyVertex[]): void {
    const data = this.backend.polyData(index);
    data.setInt32(0, 5, true);
    data.setInt32(4, shader, true);
    data.setInt32(12, vertices.length, true);
    data.setUint32(16, this.backend.polyVertexPointer(firstVertex), true);
    for (const [vertexIndex, vertex] of vertices.entries()) {
      const output = this.backend.polyVertexData(firstVertex + vertexIndex);
      writeVector(output, 0, vertex.position);
      output.setFloat32(12, vertex.texCoord.x, true);
      output.setFloat32(16, vertex.texCoord.y, true);
      output.setUint8(20, vertex.color.x);
      output.setUint8(21, vertex.color.y);
      output.setUint8(22, vertex.color.z);
      output.setUint8(23, vertex.color.w);
    }
  }

  writePolyFog(index: number, fog: number): void {
    this.backend.polyData(index).setInt32(8, fog + 1, true);
  }

  /** RagePro changes verts[0], including retained storage for a zero-count polygon. */
  writeFirstVertexWhite(index: number): void {
    const data = this.backend.polyVertexDataAtPointer(this.backend.polyData(index).getUint32(16, true));
    data.setUint8(20, 255);
    data.setUint8(21, 255);
    data.setUint8(22, 255);
    data.setUint8(23, 255);
  }

  light(index: number, transformed = false): DynamicLight {
    const read = (): DataView => this.backend.dlightData(index);
    read();
    const origin = vector(read, transformed ? 28 : 0), color = vector(read, 12);
    return {
      get origin(): Vec3 { read(); return origin; },
      get color(): Vec3 { read(); return color; },
      get radius(): number { return read().getFloat32(24, true); },
      get additive(): boolean { return read().getInt32(40, true) !== 0; },
    };
  }

  /** RE_AddDynamicLightToScene leaves the prior transformed origin untouched. */
  writeLight(index: number, light: DynamicLight): void {
    const data = this.backend.dlightData(index);
    writeVector(data, 0, light.origin);
    data.setFloat32(24, light.radius, true);
    writeVector(data, 12, light.color);
    data.setInt32(40, light.additive === true ? 1 : 0, true);
  }

  /** R_TransformDlights mutates the shared dlight_t before frontend or backend use. */
  transformLight(index: number, origin: Vec3, axis: Axis): void {
    const data = this.backend.dlightData(index), relative = sub3(vector(() => this.backend.dlightData(index), 0), origin);
    data.setFloat32(28, dot3(relative, axis[0]), true);
    data.setFloat32(32, dot3(relative, axis[1]), true);
    data.setFloat32(36, dot3(relative, axis[2]), true);
  }
}
