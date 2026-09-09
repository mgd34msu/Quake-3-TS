// Ported from id Software's code/game/g_spawn.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { vec3 } from "../core/math.ts";
import { CommonError } from "../core/common-error.ts";
import type { Vec3 } from "../core/math.ts";
import { TextParseError, TOKEN_MAX } from "../core/text.ts";
import type { Token } from "../core/text.ts";
import { GameType } from "../shared/definitions.ts";
import type { Product } from "../shared/definitions.ts";
import { itemList } from "../shared/items.ts";
import type { ItemDefinition } from "../shared/items.ts";
import { ENTITYNUM_WORLD } from "../shared/player-state.ts";
import type { EntityPool } from "./entities.ts";
import type { GameMemory } from "./memory.ts";
import { gameAtof, gameAtoi, scanGameVector } from "./numeric.ts";
import type { GameEntity } from "./state.ts";

export const MAX_SPAWN_VARS = 64;
export const MAX_SPAWN_VARS_CHARS = 4096;
export interface SpawnPair { readonly key: string; readonly value: string }
export interface SpawnValue<T> { readonly present: boolean; readonly value: T }

function lower(value: string): string { return value.replace(/[A-Z]/g, character => character.toLowerCase()); }
// Native x86 COM_Parse promotes signed char to int before comparing with space.
function tokenWhitespace(code: number): boolean { return code <= 32 || code >= 128; }
function checkByteString(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0 || code > 255) throw new RangeError("Spawn strings must contain non-NUL byte characters");
  }
}

/** G_NewString preserves a backslash and consumes an unknown escape's second byte. */
export function newSpawnString(value: string, memory: GameMemory): string {
  const allocation = memory.allocate(value.length + 1);
  let output = 0;
  for (let index = 0; index <= value.length; index++) {
    const character = index === value.length ? 0 : value.charCodeAt(index);
    if (character === 92 && index < value.length) {
      index++;
      allocation.bytes[output++] = value.charAt(index) === "n" ? 10 : 92;
    } else allocation.bytes[output++] = character;
  }
  return allocation.readString();
}

/** Ordered pairs are essential: queries use the first match, fields use the last. */
export class SpawnVariables {
  readonly entries: readonly SpawnPair[];
  readonly characterCount: number;

  constructor(entries: readonly SpawnPair[]) {
    if (entries.length > MAX_SPAWN_VARS) throw new RangeError("G_ParseSpawnVars: MAX_SPAWN_VARS");
    let characters = 0;
    for (const pair of entries) {
      for (const value of [pair.key, pair.value]) {
        checkByteString(value);
        if (value.length >= TOKEN_MAX) throw new RangeError("Spawn token exceeds MAX_TOKEN_CHARS");
        characters += value.length + 1;
        if (characters > MAX_SPAWN_VARS_CHARS) throw new RangeError("G_AddSpawnVarToken: MAX_SPAWN_CHARS");
      }
    }
    this.characterCount = characters;
    this.entries = Object.freeze(entries.map(pair => Object.freeze({ ...pair })));
  }

  string(key: string, defaultValue: string): SpawnValue<string> {
    const normalized = lower(key);
    const found = this.entries.find(pair => lower(pair.key) === normalized);
    return found === undefined ? { present: false, value: defaultValue } : { present: true, value: found.value };
  }

  int(key: string, defaultValue: string): SpawnValue<number> {
    const found = this.string(key, defaultValue);
    return { present: found.present, value: gameAtoi(found.value) };
  }

  float(key: string, defaultValue: string): SpawnValue<number> {
    const found = this.string(key, defaultValue);
    return { present: found.present, value: gameAtof(found.value) };
  }

  vector(key: string, defaultValue: string): SpawnValue<Vec3> {
    const found = this.string(key, defaultValue);
    return { present: found.present, value: scanGameVector(found.value) };
  }
}

/** G_ParseSpawnVars with native-x86 COM_Parse tokens; quoted bytes remain unchanged. */
export class SpawnParser {
  readonly #text: string;
  readonly #name: string;
  #offset = 0;
  #line = 1;
  #column = 1;

  constructor(text: string, name = "<spawn entities>") {
    const nul = text.indexOf("\0");
    this.#text = nul < 0 ? text : text.slice(0, nul);
    checkByteString(this.#text);
    this.#name = name;
  }

  #error(message: string, token?: Token): TextParseError {
    return new TextParseError(this.#name, token?.line ?? this.#line, token?.column ?? this.#column, message);
  }

  #advance(): void {
    if (this.#text.charAt(this.#offset) === "\n") { this.#line++; this.#column = 1; }
    else this.#column++;
    this.#offset++;
  }

  #token(): Token | undefined {
    while (true) {
      while (this.#offset < this.#text.length && tokenWhitespace(this.#text.charCodeAt(this.#offset))) this.#advance();
      if (this.#text.startsWith("//", this.#offset)) {
        while (this.#offset < this.#text.length && this.#text.charAt(this.#offset) !== "\n") this.#advance();
      } else if (this.#text.startsWith("/*", this.#offset)) {
        this.#advance(); this.#advance();
        while (this.#offset < this.#text.length && !this.#text.startsWith("*/", this.#offset)) this.#advance();
        if (this.#offset < this.#text.length) { this.#advance(); this.#advance(); }
      } else break;
    }
    if (this.#offset === this.#text.length) return undefined;
    const line = this.#line, column = this.#column, quoted = this.#text.charAt(this.#offset) === '"';
    let value = "";
    if (quoted) this.#advance();
    while (this.#offset < this.#text.length) {
      const character = this.#text.charAt(this.#offset);
      if (quoted ? character === '"' : tokenWhitespace(this.#text.charCodeAt(this.#offset))) break;
      value += character;
      this.#advance();
      if (value.length >= TOKEN_MAX) throw this.#error("Spawn token exceeds MAX_TOKEN_CHARS", { value, line, column, quoted });
    }
    if (quoted && this.#offset < this.#text.length) this.#advance();
    return { value, line, column, quoted };
  }

  next(): SpawnVariables | null {
    const opening = this.#token();
    if (opening === undefined) return null;
    if (!opening.value.startsWith("{")) throw this.#error(`G_ParseSpawnVars: found ${opening.value} when expecting {`, opening);
    const entries: SpawnPair[] = [];
    let characters = 0;
    while (true) {
      const key = this.#token();
      if (key === undefined) throw this.#error("G_ParseSpawnVars: EOF without closing brace");
      if (key.value.startsWith("}")) return new SpawnVariables(entries);
      const value = this.#token();
      if (value === undefined) throw this.#error("G_ParseSpawnVars: EOF without closing brace");
      if (value.value.startsWith("}")) throw this.#error("G_ParseSpawnVars: closing brace without data", value);
      if (entries.length === MAX_SPAWN_VARS) throw this.#error("G_ParseSpawnVars: MAX_SPAWN_VARS", key);
      characters += key.value.length + value.value.length + 2;
      if (characters > MAX_SPAWN_VARS_CHARS) throw this.#error("G_AddSpawnVarToken: MAX_SPAWN_CHARS", value);
      entries.push({ key: key.value, value: value.value });
    }
  }
}

/** G_ParseField; false means no source field matched, while light is recognized and ignored. */
export function parseSpawnField(key: string, value: string, entity: GameEntity, memory: GameMemory): boolean {
  const field = lower(key);
  switch (field) {
    case "classname": case "model": case "model2": case "target": case "targetname": case "message": case "team":
      entity[field] = newSpawnString(value, memory); break;
    case "targetshadername": entity.targetShaderName = newSpawnString(value, memory); break;
    case "targetshadernewname": entity.targetShaderNewName = newSpawnString(value, memory); break;
    case "spawnflags": case "count": case "health": entity[field] = gameAtoi(value); break;
    case "dmg": entity.damage = gameAtoi(value); break;
    case "speed": case "wait": case "random": entity[field] = gameAtof(value); break;
    case "origin": case "angles": entity.s[field] = scanGameVector(value); break;
    case "angle": entity.s.angles = vec3(0, gameAtof(value), 0); break;
    case "light": break;
    default: return false;
  }
  return true;
}

export type SpawnHandler = (entity: GameEntity, variables: SpawnVariables) => void;
export interface SpawnContext {
  readonly pool: EntityPool;
  readonly memory: GameMemory;
  readonly product: Product;
  readonly gameType: number;
  readonly handlers: ReadonlyMap<string, SpawnHandler>;
  readonly spawnItem: (entity: GameEntity, item: ItemDefinition, variables: SpawnVariables) => void;
  readonly warn: (message: string) => void;
}
export type SpawnFilter = "notsingle" | "notteam" | "notfree" | "notta" | "notq3a" | "gametype";
export type SpawnOutcome =
  | { readonly kind: "dispatched"; readonly route: "item" | "handler"; readonly entity: GameEntity; readonly slot: number; readonly classname: string }
  | { readonly kind: "filtered"; readonly slot: number; readonly reason: SpawnFilter }
  | { readonly kind: "unknown"; readonly slot: number; readonly classname: string | null };

function excluded(variables: SpawnVariables, context: SpawnContext): SpawnFilter | null {
  if (context.gameType === GameType.GT_SINGLE_PLAYER && variables.int("notsingle", "0").value !== 0) return "notsingle";
  const teamKey = context.gameType >= GameType.GT_TEAM ? "notteam" : "notfree";
  if (variables.int(teamKey, "0").value !== 0) return teamKey;
  const productKey = context.product === "missionpack" ? "notta" : "notq3a";
  if (variables.int(productKey, "0").value !== 0) return productKey;
  const gametype = variables.string("gametype", "");
  if (gametype.present && context.gameType >= GameType.GT_FFA && context.gameType < GameType.GT_MAX_GAME_TYPE) {
    const name = ["ffa", "tournament", "single", "team", "ctf", "oneflag", "obelisk", "harvester"][context.gameType];
    if (name === undefined) throw new RangeError("No source gametype name");
    if (!gametype.value.includes(name)) return "gametype";
  }
  return null;
}

/** G_SpawnGEntityFromSpawnVars/G_CallSpawn. Actual class implementations come from the host. */
export function spawnEntity(variables: SpawnVariables, context: SpawnContext): SpawnOutcome {
  const entity = context.pool.spawn(), slot = entity.slot;
  try {
    for (const pair of variables.entries) parseSpawnField(pair.key, pair.value, entity, context.memory);
  } catch (error) {
    if (error instanceof CommonError) throw error;
    context.pool.free(entity);
    throw error;
  }
  const reason = excluded(variables, context);
  if (reason !== null) { context.pool.free(entity); return { kind: "filtered", slot, reason }; }
  entity.s.pos = { ...entity.s.pos, base: { ...entity.s.origin } };
  entity.r.currentOrigin = { ...entity.s.origin };
  const classname = entity.classname;
  if (classname === null) context.warn("G_CallSpawn: NULL classname\n");
  else {
    const item = itemList(context.product).find(item => item.className === classname);
    if (item !== undefined) {
      context.spawnItem(entity, item, variables);
      return { kind: "dispatched", route: "item", entity, slot, classname };
    }
    const handler = context.handlers.get(classname);
    if (handler !== undefined) {
      handler(entity, variables);
      return { kind: "dispatched", route: "handler", entity, slot, classname };
    }
    context.warn(`${classname} doesn't have a spawn function\n`);
  }
  context.pool.free(entity);
  return { kind: "unknown", slot, classname };
}

export type WorldspawnConfigstring = 2 | 3 | 4 | 5 | 20 | 21;
export type WorldspawnCvar = "g_gravity" | "g_enableDust" | "g_enableBreath" | "g_restarted";
export interface WorldspawnContext {
  readonly pool: EntityPool;
  readonly startTime: number;
  readonly motd: string;
  readonly restarted: number;
  readonly doWarmup: number;
  warmupTime: number;
  readonly setConfigstring: (index: WorldspawnConfigstring, value: string) => void;
  readonly setCvar: (name: WorldspawnCvar, value: string) => void;
  readonly log: (message: string) => void;
}

/** SP_worldspawn writes the reserved record without allocating or linking a BSP entity. */
export function spawnWorld(variables: SpawnVariables, context: WorldspawnContext): void {
  if (lower(variables.string("classname", "").value) !== "worldspawn") {
    throw new Error("SP_worldspawn: The first entity isn't 'worldspawn'");
  }
  context.setConfigstring(20, "baseq3-1");
  context.setConfigstring(21, String(context.startTime | 0));
  context.setConfigstring(2, variables.string("music", "").value);
  context.setConfigstring(3, variables.string("message", "").value);
  context.setConfigstring(4, context.motd);
  context.setCvar("g_gravity", variables.string("gravity", "800").value);
  context.setCvar("g_enableDust", variables.string("enableDust", "0").value);
  context.setCvar("g_enableBreath", variables.string("enableBreath", "0").value);
  const world = context.pool.at(ENTITYNUM_WORLD);
  world.s.number = ENTITYNUM_WORLD;
  world.classname = "worldspawn";
  context.setConfigstring(5, "");
  if (context.restarted !== 0) {
    context.setCvar("g_restarted", "0");
    context.warmupTime = 0;
  } else if (context.doWarmup !== 0) {
    context.warmupTime = -1;
    context.setConfigstring(5, "-1");
    context.log("Warmup:\n");
  }
}

export interface SpawnMapContext extends SpawnContext { readonly world: WorldspawnContext }
export interface SpawnReport {
  readonly worldVariables: SpawnVariables;
  readonly outcomes: readonly SpawnOutcome[];
}

/** Parses and dispatches supplied handlers; this does not imply gameplay coverage for a map. */
export function spawnEntities(text: string, context: SpawnMapContext, source = "<spawn entities>"): SpawnReport {
  if (context.pool !== context.world.pool) throw new Error("Worldspawn and entity dispatch must share an entity pool");
  const parser = new SpawnParser(text, source), worldVariables = parser.next();
  if (worldVariables === null) throw new Error("SpawnEntities: no entities");
  spawnWorld(worldVariables, context.world);
  const outcomes: SpawnOutcome[] = [];
  while (true) {
    const variables = parser.next();
    if (variables === null) break;
    outcomes.push(spawnEntity(variables, context));
  }
  return { worldVariables, outcomes };
}
