import type { BspMap } from "../assets/bsp.ts";
import { CollisionWorld } from "../collision/world.ts";
import { vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { statSchema, Weapon } from "../shared/definitions.ts";
import type { Product } from "../shared/definitions.ts";
import { movePlayer } from "../shared/movement.ts";
import type { MovementResult } from "../shared/movement.ts";
import { createPlayerState, ENTITYNUM_NONE, ENTITYNUM_WORLD, MoveFlags } from "../shared/player-state.ts";
import type { PlayerState, UserCommand } from "../shared/player-state.ts";

function vector(text: string): Vec3 {
  const parts = text.trim().split(/\s+/).map(Number);
  const [x, y, z] = parts;
  if (parts.length !== 3 || x === undefined || y === undefined || z === undefined || !parts.every(Number.isFinite)) {
    throw new Error(`Invalid player spawn vector: ${text}`);
  }
  return vec3(x, y, z);
}

/** Connects source ClientSpawn/Pmove behavior to static BSP collision for port verification. */
export class LocalPlayer {
  readonly state: PlayerState;
  private readonly collision: CollisionWorld;

  constructor(map: BspMap, product: Product, spawnIndex = 0) {
    const starts = map.entityRecords.filter(entity => entity.get("classname") === "info_player_deathmatch");
    const spawn = starts[spawnIndex] ?? map.entityRecords.find(entity => entity.get("classname") === "info_player_start");
    if (spawn === undefined) throw new Error("Map has no usable player spawn");
    const origin = vector(spawn.get("origin") ?? "0 0 0");
    const yaw = Number(spawn.get("angle") ?? "0");
    if (!Number.isFinite(yaw)) throw new Error("Invalid player spawn angle");
    this.collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
    this.state = createPlayerState(product);
    this.state.origin = vec3(origin.x, origin.y, origin.z + 9);
    this.state.viewangles = vec3(0, yaw, 0);
    this.state.viewheight = 26;
    this.state.health = 125;
    this.state.stats.set(statSchema(product).maxHealth, 100);
    this.state.stats.set(statSchema(product).weapons, (1 << Weapon.WP_MACHINEGUN) | (1 << Weapon.WP_GAUNTLET));
    this.state.ammo.set(Weapon.WP_MACHINEGUN, 100);
    this.state.ammo.set(Weapon.WP_GAUNTLET, -1);
    this.state.weapon = Weapon.WP_MACHINEGUN;
    this.state.gravity = 800;
    this.state.speed = 320;
    this.state.pmFlags = MoveFlags.RESPAWNED | MoveFlags.TIME_KNOCKBACK;
    this.state.pmTime = 100;
    // g_client.c ClientSpawn runs ClientThink over the preceding 100 ms.
    this.state.commandTime = -100;
    this.advance({
      serverTime: 0,
      angles: vec3(0, Math.trunc(yaw * 65536 / 360) & 65535, 0),
      buttons: 0,
      weapon: this.state.weapon,
      forwardmove: 0,
      rightmove: 0,
      upmove: 0,
    });
  }

  advance(command: UserCommand): MovementResult {
    return movePlayer(this.state, command, {
      trace: (start, end, bounds, _passEntity, mask) => {
        const hit = this.collision.trace({ start, end, shape: { kind: "box", mins: bounds.min, maxs: bounds.max }, mask });
        return { ...hit, entityNum: hit.fraction < 1 ? ENTITYNUM_WORLD : ENTITYNUM_NONE };
      },
      pointContents: point => this.collision.pointContents(point),
    });
  }

  get camera(): { readonly origin: Vec3; readonly angles: Vec3 } {
    const state = this.state;
    return { origin: vec3(state.origin.x, state.origin.y, state.origin.z + state.viewheight), angles: state.viewangles };
  }
}
