// Source game/g_utils.c configstring indices, target dispatch, team commands
// and editor direction conversion. GPL-2.0-or-later, id Software 1999-2005.
import { add3, cross3, dot3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import { qvmAngleVectors } from "../core/qvm-math.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import type { Vec3 } from "../core/math.ts";
import type { BotDebugPolygons } from "../server/bot-debug.ts";
import type { Team } from "../shared/definitions.ts";
import type { EntityPool } from "./entities.ts";
import { ConnectionState } from "./state.ts";
import type { GameEntity } from "./state.ts";
import { gameFormat } from "./format.ts";
import { GameMemoryAllocation } from "./memory.ts";

class TemporaryVector {
  #x = 0;
  #y = 0;
  #z = 0;
  get x(): number { return this.#x; }
  set x(value: number) { this.#x = Math.fround(value); }
  get y(): number { return this.#y; }
  set y(value: number) { this.#y = Math.fround(value); }
  get z(): number { return this.#z; }
  set z(value: number) { this.#z = Math.fround(value); }
}

/** g_utils.c tv/vtos have separate static rings for each loaded game. */
export class GameUtilityScratch {
  readonly #vectors = Array.from({ length: 8 }, () => new TemporaryVector());
  readonly #stringBytes = new Uint8Array(8 * 32);
  readonly #strings = Array.from({ length: 8 }, (_, index) =>
    new GameMemoryAllocation(this.#stringBytes.subarray(index * 32, (index + 1) * 32)));
  #vectorIndex = 0;
  #stringIndex = 0;

  constructor(readonly print: (message: string) => void) {}

  tv(x: number, y: number, z: number): TemporaryVector {
    const vector = this.#vectors[this.#vectorIndex];
    if (vector === undefined) throw new Error("Game temporary vector ring index invariant");
    this.#vectorIndex = (this.#vectorIndex + 1) & 7;
    vector.x = x; vector.y = y; vector.z = z;
    return vector;
  }

  vtos(vector: Vec3): GameMemoryAllocation {
    const string = this.#strings[this.#stringIndex];
    if (string === undefined) throw new Error("Game vector string ring index invariant");
    this.#stringIndex = (this.#stringIndex + 1) & 7;
    const value = gameFormat("(%i %i %i)",
      [qvmFloatToInt(vector.x), qvmFloatToInt(vector.y), qvmFloatToInt(vector.z)]);
    if (value.length >= 32) this.print(gameFormat("Com_sprintf: overflow of %i in %i\n", [value.length, 32]));
    string.writeString(value.slice(0, 31));
    return string;
  }
}

/** DebugLine submits its four source points to the server's polygon allocation. */
export function debugLine(start: Vec3, end: Vec3, color: number, polygons: Pick<BotDebugPolygons, "create">): number {
  const direction = normalize3(sub3(end, start));
  const up = vec3(0, 0, 1);
  const dot = dot3(direction, up);
  const cross = normalize3(dot > Math.fround(0.99) || dot < Math.fround(-0.99)
    ? vec3(1, 0, 0) : cross3(direction, up));
  return polygons.create(color, 4, [add3(start, scale3(cross, 2)), add3(start, scale3(cross, -2)),
    add3(end, scale3(cross, -2)), add3(end, scale3(cross, 2))]);
}

export interface ConfigStringStore {
  get(index: number): string;
  set(index: number, value: string): void;
}

function byteString(value: string): string {
  const terminator = value.indexOf("\0");
  const text = terminator < 0 ? value : value.slice(0, terminator);
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 255) throw new RangeError("Game configstrings require byte characters");
  }
  return text;
}

/** Source index zero is reserved; the first empty entry ends the search. */
export class ConfigStringRegistry {
  constructor(readonly store: ConfigStringStore) {}

  find(name: string | null, start: number, maximum: number, create: boolean): number {
    if (name === null) return 0;
    const text = byteString(name);
    if (text.length === 0) return 0;
    if (!Number.isInteger(start) || !Number.isInteger(maximum) || start < 0 || maximum < 1 || start + maximum > 1024) {
      throw new RangeError("Configstring range must fit MAX_CONFIGSTRINGS");
    }
    let index = 1;
    for (; index < maximum; index++) {
      const value = byteString(this.store.get(start + index)).slice(0, 1023);
      if (value.length === 0) break;
      if (value === text) return index;
    }
    if (!create) return 0;
    if (index === maximum) throw new Error("G_FindConfigstringIndex: overflow");
    this.store.set(start + index, text);
    return index;
  }

  modelIndex(name: string | null): number { return this.find(name, 32, 256, true); }
  soundIndex(name: string | null): number { return this.find(name, 288, 256, true); }
}

export type EntityStringField = {
  [Key in keyof GameEntity]: GameEntity[Key] extends string | null ? Key : never
}[keyof GameEntity];

function asciiFold(value: string): string {
  const terminator = value.indexOf("\0");
  return (terminator < 0 ? value : value.slice(0, terminator)).replace(/[A-Z]/g, character => character.toLowerCase());
}

/** Replaces source byte offsets with the actual string-valued GameEntity keys. */
export function findEntity(pool: EntityPool, after: GameEntity | null, field: EntityStringField, match: string | null): GameEntity | null {
  if (match === null) return null;
  const folded = asciiFold(match);
  for (let index = after === null ? 0 : after.slot + 1; index < pool.numEntities; index++) {
    const entity = pool.at(index), value = entity[field];
    if (entity.inuse && value !== null && asciiFold(value) === folded) return entity;
  }
  return null;
}

export interface TargetSelectionContext {
  readonly pool: EntityPool;
  randomInt(): number;
  warn(message: string): void;
}

export function pickTarget(context: TargetSelectionContext, targetName: string | null): GameEntity | null {
  if (targetName === null) {
    context.warn("G_PickTarget called with NULL targetname\n");
    return null;
  }
  const choices: GameEntity[] = [];
  let found: GameEntity | null = null;
  while (choices.length < 32) {
    found = findEntity(context.pool, found, "targetname", targetName);
    if (found === null) break;
    choices.push(found);
  }
  if (choices.length === 0) {
    context.warn(`G_PickTarget: target ${targetName} not found\n`);
    return null;
  }
  const random = context.randomInt();
  if (!Number.isInteger(random) || random < 0) throw new RangeError("Game rand must return a nonnegative integer");
  const choice = choices[random % choices.length];
  if (choice === undefined) throw new Error("Target selection index invariant");
  return choice;
}

export interface TargetUseContext {
  readonly pool: EntityPool;
  readonly time: number;
  /** Performs AddRemap and publishes BuildShaderStateConfig at CS_SHADERSTATE. */
  remapShader(oldName: string, newName: string, timeSeconds: number): void;
  warn(message: string): void;
}

export function useTargets(context: TargetUseContext, entity: GameEntity | null, activator: GameEntity | null): void {
  if (entity === null) return;
  if (entity.targetShaderName !== null && entity.targetShaderNewName !== null) {
    const timeSeconds = Math.fround(Math.fround(context.time) * Math.fround(0.001));
    context.remapShader(entity.targetShaderName, entity.targetShaderNewName, timeSeconds);
  }
  if (entity.target === null) return;
  let target: GameEntity | null = null;
  while ((target = findEntity(context.pool, target, "targetname", entity.target)) !== null) {
    if (target === entity) context.warn("WARNING: Entity used itself.\n");
    else target.use?.(target, entity, activator);
    if (!entity.inuse) {
      context.warn("entity was removed while using targets\n");
      return;
    }
  }
}

export function teamCommand(pool: EntityPool, team: Team, command: string, send: (clientNum: number, command: string) => void): void {
  for (let index = 0; index < pool.maxClients; index++) {
    const client = pool.clientAt(index);
    if (client.pers.connected === ConnectionState.CONNECTED && client.sess.sessionTeam === team) send(index, command);
  }
}

/** Returns both source out-parameters without mutating a shared readonly vector. */
export function moveDirection(angles: Vec3): { readonly direction: Vec3; readonly angles: Vec3 } {
  const vertical = angles.x === 0 && angles.z === 0;
  const direction = vertical && angles.y === -1 ? vec3(0, 0, 1)
    : vertical && angles.y === -2 ? vec3(0, 0, -1) : qvmAngleVectors(angles).forward;
  return { direction, angles: vec3(0, 0, 0) };
}
