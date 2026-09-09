import { parsePlayerAnimationConfig } from "../src/assets/animation.ts";
import { clearLerpFrame, createLerpFrame, runLerpFrame } from "../src/cgame/animation.ts";
import { add3, angleVectors, anglesToAxis, scale3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { transformMd3Tag } from "../src/render/model-geometry.ts";
import type { SceneModel, RefModelEntity } from "../src/render/ref-entity.ts";
import { createModelEntity } from "../src/render/ref-entity.ts";
import type { WorldCamera, WorldScene } from "../src/render/world.ts";
import type { AssetReader } from "../src/assets/reader.ts";
import type { Product } from "../src/shared/definitions.ts";
import { PlayerAnimation } from "../src/shared/player-state.ts";

/** Controlled render fixture, not a simulated player or item. */
export async function loadModelFixture(scene: WorldScene, assets: AssetReader, camera: WorldCamera, product: Product): Promise<(time: number) => readonly RefModelEntity[]> {
  const lower = await scene.resources.registerModel("models/players/sarge/lower.md3");
  const upper = await scene.resources.registerModel("models/players/sarge/upper.md3");
  const head = await scene.resources.registerModel("models/players/sarge/head.md3");
  const weapon = await scene.resources.registerModel(product === "missionpack" ? "models/weapons/nailgun/nailgun.md3" : "models/weapons2/machinegun/machinegun.md3");
  const armor = await scene.resources.registerModel("models/powerups/armor/armor_red.md3");
  const lowerSkin = await scene.resources.registerSkin("models/players/sarge/lower_default.skin");
  const upperSkin = await scene.resources.registerSkin("models/players/sarge/upper_default.skin");
  const headSkin = await scene.resources.registerSkin("models/players/sarge/head_default.skin");
  const animationPath = "models/players/sarge/animation.cfg";
  let animationText = "";
  for (const byte of await assets.read(animationPath)) animationText += String.fromCharCode(byte);
  const animations = parsePlayerAnimationConfig(animationText, animationPath);
  const legs = createLerpFrame(), torso = createLerpFrame();
  clearLerpFrame(animations, legs, PlayerAnimation.LEGS_WALK, 0);
  clearLerpFrame(animations, torso, PlayerAnimation.TORSO_STAND, 0);
  const axes = angleVectors(camera.angles);
  const ahead = add3(camera.origin, scale3(axes.forward, 90));
  const playerOrigin = { ...ahead, z: ahead.z - 26 };
  const playerAxis = anglesToAxis({ x: 0, y: camera.angles.y + 180, z: 0 });
  const armorOrigin = add3(ahead, scale3(axes.right, 40));
  if (lower.kind !== "md3" || upper.kind !== "md3") throw new Error("retail MD3 registration failed");
  const lowerMd3 = lower.md3[0], upperMd3 = upper.md3[0];
  if (lowerMd3 === null || upperMd3 === null) throw new Error("retail MD3 base slot missing");
  function entity(model: SceneModel, origin: Vec3): RefModelEntity {
    return { ...createModelEntity(model), model, origin, axis: playerAxis, nonNormalizedAxes: false, frame: 0, oldFrame: 0, backLerp: 0,
      skinNum: 0, customSkin: null, customShader: null, shaderRGBA: { x: 255, y: 255, z: 255, w: 255 },
      shaderTexCoord: { x: 0, y: 0 }, shaderTime: 0, lightingOrigin: playerOrigin, renderFlags: 0 };
  }
  let previousTime = 0;
  return time => {
    if (!Number.isFinite(time) || time < previousTime || time * 1000 > 0x7fffffff) throw new RangeError("model fixture requires monotonic nonnegative seconds within the game clock");
    previousTime = time;
    const timeMs = Math.round(time * 1000);
    runLerpFrame(animations, legs, { timeMs, newAnimation: PlayerAnimation.LEGS_WALK, speedScale: 1, noPlayerAnimations: false });
    runLerpFrame(animations, torso, { timeMs, newAnimation: PlayerAnimation.TORSO_STAND, speedScale: 1, noPlayerAnimations: false });
    const lowerEntity: RefModelEntity = { ...entity(lower, playerOrigin), frame: legs.frame, oldFrame: legs.oldFrame, backLerp: legs.backLerp, customSkin: lowerSkin };
    const torsoTag = transformMd3Tag(lowerMd3, "tag_torso", legs.oldFrame, legs.frame, 1 - legs.backLerp, lowerEntity);
    if (torsoTag === null) throw new Error("Sarge fixture lacks tag_torso");
    const upperEntity: RefModelEntity = { ...entity(upper, torsoTag.origin), axis: torsoTag.axes,
      frame: torso.frame, oldFrame: torso.oldFrame, backLerp: torso.backLerp, customSkin: upperSkin };
    const headTag = transformMd3Tag(upperMd3, "tag_head", torso.oldFrame, torso.frame, 1 - torso.backLerp, upperEntity);
    const weaponTag = transformMd3Tag(upperMd3, "tag_weapon", torso.oldFrame, torso.frame, 1 - torso.backLerp, upperEntity);
    if (headTag === null || weaponTag === null) throw new Error("Sarge fixture lacks head/weapon attachment tags");
    return [lowerEntity, upperEntity,
      { ...entity(head, headTag.origin), axis: headTag.axes, customSkin: headSkin },
      { ...entity(weapon, weaponTag.origin), axis: weaponTag.axes },
      { ...entity(armor, armorOrigin), axis: anglesToAxis({ x: 0, y: time * 60, z: 0 }) }];
  };
}
