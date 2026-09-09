// refEntity_t storage from id Software code/cgame/tr_types.h and renderer/tr_scene.c.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import type { Axis, Vec2, Vec3, Vec4 } from "../core/math.ts";
import type { SceneModel, SceneShader, SceneSkin, SourceRefEntity, SourceRefEntityRecord } from "./ref-entity.ts";
import { copySourceRefEntity, DEFAULT_MODEL } from "./ref-entity.ts";

export interface SourceEntityHandles {
  model(model: SceneModel): number;
  skin(skin: SceneSkin | null): number;
  shader(shader: SceneShader | null): number;
}

const diagnosticHandles: SourceEntityHandles = {
  model(model) {
    if (model !== DEFAULT_MODEL) throw new Error("Source entity model requires its renderer handle owner");
    return 0;
  },
  skin(skin) {
    if (skin !== null) throw new Error("Source entity skin requires its renderer handle owner");
    return 0;
  },
  shader(shader) {
    if (shader !== null) throw new Error("Source entity shader requires its renderer handle owner");
    return 0;
  },
};

interface TypedHandle<Value> { readonly word: number; readonly value: Value }

function entityType(kind: SourceRefEntityRecord["kind"]): number {
  switch (kind) {
    case "model": return 0;
    case "poly": return 1;
    case "sprite": return 2;
    case "beam": return 3;
    case "rail-core": return 4;
    case "rail-rings": return 5;
    case "lightning": return 6;
    case "portal-surface": return 7;
  }
}

function entityKind(type: number): SourceRefEntityRecord["kind"] {
  switch (type) {
    case 0: return "model";
    case 1: return "poly";
    case 2: return "sprite";
    case 3: return "beam";
    case 4: return "rail-core";
    case 5: return "rail-rings";
    case 6: return "lightning";
    case 7: return "portal-surface";
    default: throw new RangeError(`RE_AddRefEntityToScene: bad reType ${type}`);
  }
}

function vector(data: () => DataView, offset: number): Vec3 {
  return {
    get x() { return data().getFloat32(offset, true); },
    get y() { return data().getFloat32(offset + 4, true); },
    get z() { return data().getFloat32(offset + 8, true); },
  };
}

function writeVector(data: DataView, offset: number, value: Vec3): void {
  data.setFloat32(offset, value.x, true);
  data.setFloat32(offset + 4, value.y, true);
  data.setFloat32(offset + 8, value.z, true);
}

function writeAxis(data: DataView, value: Axis): void {
  writeVector(data, 28, value[0]);
  writeVector(data, 40, value[1]);
  writeVector(data, 52, value[2]);
}

function writeColor(data: DataView, value: Vec4): void {
  data.setUint8(116, value.x); data.setUint8(117, value.y);
  data.setUint8(118, value.z); data.setUint8(119, value.w);
}

function writeTexCoord(data: DataView, value: Vec2): void {
  data.setFloat32(120, value.x, true); data.setFloat32(124, value.y, true);
}

/** One live .e record. The supplied borrow validates its actual allocation on every access. */
export class SourceRefEntityMemory {
  readonly entity: SourceRefEntityRecord;
  #model: TypedHandle<SceneModel> | null = null;
  #skin: TypedHandle<SceneSkin | null> | null = null;
  #shader: TypedHandle<SceneShader | null> | null = null;

  constructor(private readonly borrow: () => DataView, private readonly handles: SourceEntityHandles = diagnosticHandles) {
    this.data();
    const memory = this, data = () => memory.data();
    const origin = vector(data, 68), oldOrigin = vector(data, 84), lightingOrigin = vector(data, 12);
    const axis: Axis = [vector(data, 28), vector(data, 40), vector(data, 52)];
    const color: Vec4 = {
      get x() { return data().getUint8(116); }, get y() { return data().getUint8(117); },
      get z() { return data().getUint8(118); }, get w() { return data().getUint8(119); },
    };
    const texCoord: Vec2 = {
      get x() { return data().getFloat32(120, true); }, get y() { return data().getFloat32(124, true); },
    };
    // Enumerable fields preserve value-copy publication through copySourceRefEntity.
    this.entity = {
      get kind() { return entityKind(data().getInt32(0, true)); },
      set kind(value) { data().setInt32(0, entityType(value), true); },
      get renderFlags() { return data().getInt32(4, true); },
      set renderFlags(value) { data().setInt32(4, value, true); },
      get model() {
        const word = data().getInt32(8, true), typed = memory.#model;
        return typed !== null && typed.word === word ? typed.value : word;
      },
      set model(value) {
        const word = typeof value === "number" ? value : memory.handles.model(value);
        data().setInt32(8, word, true);
        memory.#model = typeof value === "number" ? null : { word: word | 0, value };
      },
      get lightingOrigin() { memory.data(); return lightingOrigin; },
      set lightingOrigin(value) { writeVector(data(), 12, value); },
      get shadowPlane() { return data().getFloat32(24, true); },
      set shadowPlane(value) { data().setFloat32(24, value, true); },
      get axis() { memory.data(); return axis; },
      set axis(value) { writeAxis(data(), value); },
      get nonNormalizedAxes() { return data().getInt32(64, true) !== 0; },
      set nonNormalizedAxes(value) { data().setInt32(64, value ? 1 : 0, true); },
      get origin() { memory.data(); return origin; },
      set origin(value) { writeVector(data(), 68, value); },
      get frame() { return data().getInt32(80, true); },
      set frame(value) { data().setInt32(80, value, true); },
      get oldOrigin() { memory.data(); return oldOrigin; },
      set oldOrigin(value) { writeVector(data(), 84, value); },
      get oldFrame() { return data().getInt32(96, true); },
      set oldFrame(value) { data().setInt32(96, value, true); },
      get backLerp() { return data().getFloat32(100, true); },
      set backLerp(value) { data().setFloat32(100, value, true); },
      get skinNum() { return data().getInt32(104, true); },
      set skinNum(value) { data().setInt32(104, value, true); },
      get customSkin() {
        const word = data().getInt32(108, true), typed = memory.#skin;
        return typed !== null && typed.word === word ? typed.value : word;
      },
      set customSkin(value) {
        const word = typeof value === "number" ? value : memory.handles.skin(value);
        data().setInt32(108, word, true);
        memory.#skin = typeof value === "number" ? null : { word: word | 0, value };
      },
      get customShader() {
        const word = data().getInt32(112, true), typed = memory.#shader;
        return typed !== null && typed.word === word ? typed.value : word;
      },
      set customShader(value) {
        const word = typeof value === "number" ? value : memory.handles.shader(value);
        data().setInt32(112, word, true);
        memory.#shader = typeof value === "number" ? null : { word: word | 0, value };
      },
      get shaderRGBA() { memory.data(); return color; },
      set shaderRGBA(value) { writeColor(data(), value); },
      get shaderTexCoord() { memory.data(); return texCoord; },
      set shaderTexCoord(value) { writeTexCoord(data(), value); },
      get shaderTime() { return data().getFloat32(128, true); },
      set shaderTime(value) { data().setFloat32(128, value, true); },
      get radius() { return data().getFloat32(132, true); },
      set radius(value) { data().setFloat32(132, value, true); },
      get rotation() { return data().getFloat32(136, true); },
      set rotation(value) { data().setFloat32(136, value, true); },
    };
  }

  private data(): DataView {
    const view = this.borrow();
    if (view.byteLength < 140) throw new RangeError("Source refEntity_t borrow requires 140 bytes");
    return view;
  }

  /** Source producers clear refEntity_t before populating it; admission copies its entire prefix. */
  copyFrom(input: SourceRefEntity): void {
    const entity = copySourceRefEntity(input);
    this.data();
    const bytes = new Uint8Array(140);
    const data = new DataView(bytes.buffer);
    let model: TypedHandle<SceneModel> | null = null;
    let skin: TypedHandle<SceneSkin | null> | null = null;
    let shader: TypedHandle<SceneShader | null> | null = null;
    data.setInt32(0, entityType(entity.kind), true);
    data.setInt32(4, entity.renderFlags, true);
    writeVector(data, 68, entity.origin);
    if ("model" in entity) {
      const word = typeof entity.model === "number" ? entity.model : this.handles.model(entity.model);
      data.setInt32(8, word, true);
      model = typeof entity.model === "number" ? null : { word: word | 0, value: entity.model };
    }
    if ("lightingOrigin" in entity) writeVector(data, 12, entity.lightingOrigin);
    if ("shadowPlane" in entity) data.setFloat32(24, entity.shadowPlane, true);
    if ("axis" in entity) writeAxis(data, entity.axis);
    if ("nonNormalizedAxes" in entity) data.setInt32(64, entity.nonNormalizedAxes ? 1 : 0, true);
    if ("frame" in entity) data.setInt32(80, entity.frame, true);
    if ("oldOrigin" in entity) writeVector(data, 84, entity.oldOrigin);
    if ("oldFrame" in entity) data.setInt32(96, entity.oldFrame, true);
    if ("backLerp" in entity) data.setFloat32(100, entity.backLerp, true);
    if ("skinNum" in entity) data.setInt32(104, entity.skinNum, true);
    if ("customSkin" in entity) {
      const word = typeof entity.customSkin === "number" ? entity.customSkin : this.handles.skin(entity.customSkin);
      data.setInt32(108, word, true);
      skin = typeof entity.customSkin === "number" ? null : { word: word | 0, value: entity.customSkin };
    }
    if ("customShader" in entity) {
      const word = typeof entity.customShader === "number" ? entity.customShader : this.handles.shader(entity.customShader);
      data.setInt32(112, word, true);
      shader = typeof entity.customShader === "number" ? null : { word: word | 0, value: entity.customShader };
    }
    if ("shaderRGBA" in entity) writeColor(data, entity.shaderRGBA);
    if ("shaderTexCoord" in entity) writeTexCoord(data, entity.shaderTexCoord);
    if ("shaderTime" in entity) data.setFloat32(128, entity.shaderTime, true);
    if ("radius" in entity) data.setFloat32(132, entity.radius, true);
    if ("rotation" in entity) data.setFloat32(136, entity.rotation, true);
    const destination = this.data();
    new Uint8Array(destination.buffer, destination.byteOffset, 140).set(bytes);
    this.#model = model; this.#skin = skin; this.#shader = shader;
  }
}
