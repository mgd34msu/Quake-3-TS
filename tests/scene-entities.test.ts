import { describe, expect, test } from "bun:test";
import type { EntityLightingState } from "../src/render/lighting.ts";
import { createModelEntity, createSpriteEntity } from "../src/render/ref-entity.ts";
import { SourceSceneEntities } from "../src/render/scene-entities.ts";
import { readQvmRefEntity } from "../src/vm/render-record.ts";

function model(frame: number) {
  const entity = createModelEntity();
  entity.frame = frame;
  entity.axis = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];
  return entity;
}

function lightingState(identityLight = 1): EntityLightingState {
  return { grid: null, noWorldModel: true, identityLight, identityLightByte: 255,
    ambientScale: 1, directedScale: 1, sunDirection: { x: 0, y: 0, z: 1 }, dynamicLights: [] };
}

describe("source single-buffer renderer entity cells", () => {
  test("two completed scenes consume distinct cells in one frame with local order", () => {
    const owner = new SourceSceneEntities();
    owner.addRefEntity(model(11));
    owner.addRefEntity(model(12));
    const first = owner.sceneRange();
    expect(first.length).toBe(2);
    expect(first.entity(0).entity).toMatchObject({ frame: 11 });
    expect(first.entity(1).entity).toMatchObject({ frame: 12 });
    owner.completeScene(first);
    owner.addRefEntity(model(21));
    const second = owner.sceneRange();
    expect(second.length).toBe(1);
    expect(second.entity(0).entity).toMatchObject({ frame: 21 });
    expect(second.entity(0)).not.toBe(first.entity(0));
    expect(first.entity(0).entity).toMatchObject({ frame: 11 });
  });

  test("capture does not advance the next scene on an unfinished frontend", () => {
    const owner = new SourceSceneEntities();
    owner.addRefEntity(model(1));
    const captured = owner.sceneRange();
    owner.addRefEntity(model(2));
    const unfinished = owner.sceneRange();
    expect(captured.length).toBe(1);
    expect(unfinished.length).toBe(2);
    expect(unfinished.entity(0)).toBe(captured.entity(0));
    owner.completeScene(captured);
    expect(owner.sceneRange().length).toBe(0);
  });

  test("clear before render advances the start without reclaiming abandoned cells", () => {
    const owner = new SourceSceneEntities();
    owner.addRefEntity(model(1));
    const abandoned = owner.sceneRange();
    owner.clearScene();
    expect(owner.sceneRange().length).toBe(0);
    owner.addRefEntity(model(2));
    const next = owner.sceneRange();
    expect(next.length).toBe(1);
    expect(next.entity(0)).not.toBe(abandoned.entity(0));
    expect(abandoned.entity(0).entity).toMatchObject({ frame: 1 });
  });

  test("next frame reuses actual cells and preserves lighting and derived fields", () => {
    const owner = new SourceSceneEntities();
    owner.addRefEntity(model(1));
    const first = owner.sceneRange(), cell = first.entity(0);
    expect(cell.lightingCalculated).toBe(false);
    expect(cell.lighting).toEqual({ ambientLight: { x: 0, y: 0, z: 0 }, directedLight: { x: 0, y: 0, z: 0 },
      lightDir: { x: 0, y: 0, z: 0 }, ambientLightInt: 0 });
    const lit = cell.setupLighting(lightingState());
    expect(lit.ambientLight).toEqual({ x: 182, y: 182, z: 182 });
    expect(lit.directedLight).toEqual({ x: 150, y: 150, z: 150 });
    expect(lit.lightDir).toEqual({ x: 0, y: 0, z: 1 });
    expect(lit.ambientLightInt).toBe(0xffb6b6b6);
    cell.axisLength = 3;
    cell.needDlights = true;
    owner.rolloverFrame();
    expect(cell.lightingCalculated).toBe(true);
    expect(owner.sceneRange().length).toBe(0);
    owner.addRefEntity(model(2));
    const reused = owner.sceneRange().entity(0);
    expect(reused).toBe(cell);
    expect(reused.entity).toMatchObject({ frame: 2 });
    expect(reused.lightingCalculated).toBe(false);
    expect(reused.lighting).toBe(lit);
    expect(reused.axisLength).toBe(3);
    expect(reused.needDlights).toBe(true);
    expect(() => first.entity(0)).toThrow("completed frame");
    expect(() => first.copyRefEntities()).toThrow("completed frame");
  });

  test("portal children borrow the same cell and its once-per-submission lighting", () => {
    const owner = new SourceSceneEntities();
    owner.addRefEntity(model(1));
    const parent = owner.sceneRange(), portal = parent;
    const lit = portal.entity(0).setupLighting(lightingState());
    expect(parent.entity(0)).toBe(portal.entity(0));
    expect(parent.entity(0).lightingCalculated).toBe(true);
    expect(parent.entity(0).setupLighting(lightingState(0.5))).toBe(lit);
    owner.completeScene(parent);
    expect(portal.entity(0).lighting).toBe(lit);
  });

  test("submission and public snapshots own values while cells retain identity", () => {
    const owner = new SourceSceneEntities(), submitted = model(1);
    owner.addRefEntity(submitted);
    const range = owner.sceneRange(), cell = range.entity(0);
    const snapshot = range.copyRefEntities();
    submitted.frame = 99;
    submitted.origin = { x: 9, y: 8, z: 7 };
    expect(cell.entity).toMatchObject({ frame: 1, origin: { x: 0, y: 0, z: 0 } });
    expect(cell.entity).not.toBe(submitted);
    if (cell.entity.kind !== "model") throw new Error("Expected model cell");
    expect(cell.entity.model).toBe(submitted.model);
    cell.entity.frame = 2;
    expect(range.entity(0).entity).toMatchObject({ frame: 2 });
    expect(snapshot[0]).toMatchObject({ frame: 1 });
    owner.rolloverFrame();
    owner.addRefEntity(model(3));
    expect(cell.entity).toMatchObject({ frame: 3 });
    expect(snapshot[0]).toMatchObject({ frame: 1 });
  });

  test("source admission ignores overflow even after clear and resumes next frame", () => {
    const owner = new SourceSceneEntities();
    for (let index = 0; index < 1022; index++) expect(owner.addRefEntity(model(index))).toBe(true);
    expect(owner.addRefEntity(model(1022))).toBe(false);
    const range = owner.sceneRange();
    expect(range.length).toBe(1022);
    expect(range.entity(1021).entity).toMatchObject({ frame: 1021 });
    owner.clearScene();
    expect(owner.addRefEntity(model(1023))).toBe(false);
    expect(owner.sceneRange().length).toBe(0);
    owner.rolloverFrame();
    expect(owner.addRefEntity(model(0))).toBe(true);
  });

  test("full source allocation never reads the incoming VM record", () => {
    const owner = new SourceSceneEntities();
    for (let index = 0; index < 1022; index++) owner.addRefEntity(model(index));
    let reads = 0;
    const read = () => { reads++; return readQvmRefEntity(new DataView(new ArrayBuffer(139))); };
    expect(owner.addRefEntityRecord(read)).toBe(false);
    owner.clearScene();
    expect(owner.addRefEntityRecord(read)).toBe(false);
    expect(reads).toBe(0);
    owner.rolloverFrame();
    expect(() => owner.addRefEntityRecord(read)).toThrow("record requires 140 bytes");
    expect(reads).toBe(1);
    expect(owner.sceneRange().length).toBe(0);
    expect(owner.addRefEntity(model(9))).toBe(true);
    expect(owner.sceneRange().entity(0).entity).toMatchObject({ frame: 9 });
  });

  test("source records own all variant fields while retaining numeric handles", () => {
    const owner = new SourceSceneEntities();
    for (let type = 0; type < 8; type++) {
      const view = new DataView(new ArrayBuffer(140));
      view.setInt32(0, type, true); view.setInt32(8, -2147483648, true);
      view.setInt32(108, 16777217, true); view.setInt32(112, -7, true);
      view.setInt32(80, 17, true); view.setInt32(96, 9, true); view.setFloat32(100, 0.25, true);
      const submitted = readQvmRefEntity(view), origin = { x: 1, y: 2, z: 3 }, oldOrigin = { x: 4, y: 5, z: 6 };
      const axis = { x: 7, y: 8, z: 9 }, lighting = { x: 10, y: 11, z: 12 };
      const color = { x: 13, y: 14, z: 15, w: 16 }, texCoord = { x: 0.5, y: 0.75 };
      submitted.origin = origin; submitted.oldOrigin = oldOrigin; submitted.axis = [axis, axis, axis];
      submitted.lightingOrigin = lighting; submitted.shaderRGBA = color; submitted.shaderTexCoord = texCoord;
      expect(owner.addRefEntityRecord(() => submitted)).toBe(true);
      const cell = owner.sceneRange().entity(type), copied = cell.copyRefEntity();
      origin.x = 101; oldOrigin.x = 102; axis.x = 103; lighting.x = 104; color.x = 105; texCoord.x = 106;
      submitted.model = 0; submitted.customSkin = 0; submitted.customShader = 0; submitted.frame = 0;
      expect(cell.entity).toMatchObject({ model: -2147483648, customSkin: 16777217, customShader: -7,
        origin: { x: 1, y: 2, z: 3 }, oldOrigin: { x: 4, y: 5, z: 6 }, lightingOrigin: { x: 10, y: 11, z: 12 },
        axis: [{ x: 7, y: 8, z: 9 }, { x: 7, y: 8, z: 9 }, { x: 7, y: 8, z: 9 }],
        shaderRGBA: { x: 13, y: 14, z: 15, w: 16 }, shaderTexCoord: { x: 0.5, y: 0.75 },
        frame: 17, oldFrame: 9, backLerp: 0.25 });
      expect(copied).toEqual(cell.entity);
      expect(copied.origin).not.toBe(cell.entity.origin);
      expect(owner.sceneRange().copyRefEntities()[type]).toEqual(copied);
    }
    expect(owner.sceneRange().entity(1).entity.kind).toBe("poly");
  });

  test("failed value copy leaves the selected cell and count unchanged", () => {
    const owner = new SourceSceneEntities();
    const unreadable = { ...model(7), get origin(): never { throw new Error("Source copy failed"); } };
    expect(() => owner.addRefEntityRecord(() => unreadable)).toThrow("Source copy failed");
    expect(owner.sceneRange().length).toBe(0);
    owner.addRefEntity(model(8));
    expect(owner.sceneRange().entity(0).entity).toMatchObject({ frame: 8 });
  });

  test("range ownership and checked local indexes reject invalid borrows", () => {
    const owner = new SourceSceneEntities(), other = new SourceSceneEntities();
    owner.addRefEntity(model(1));
    const range = owner.sceneRange();
    expect(() => other.validateRange(range)).toThrow("another entity owner");
    expect(() => other.completeScene(range)).toThrow("another entity owner");
    for (const index of [-1, 1, 0.5, NaN, Infinity]) expect(() => range.entity(index)).toThrow(RangeError);
    owner.rolloverFrame();
    expect(() => owner.completeScene(range)).toThrow("completed frame");
    owner.addRefEntity(createSpriteEntity());
    expect(() => owner.sceneRange().entity(0).setupLighting(lightingState())).toThrow("model entity");
  });
});
