// Ported from id Software's code/game/g_arenas.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CvarRegistry } from "../core/cvar.ts";
import { add3, scale3, sub3, vec3, vectorToAngles } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { qvmAngleVectors } from "../core/qvm-math.ts";
import type { ServerWorld } from "../server/world.ts";
import { EntityEvent, EntityType, GameType, PersistentIndex, Team, Weapon } from "../shared/definitions.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { ENTITYNUM_WORLD, PlayerAnimation } from "../shared/player-state.ts";
import { TrajectoryType } from "../shared/trajectory.ts";
import { setOrigin } from "./entities.ts";
import { gameFormat } from "./format.ts";
import type { MatchRuntime } from "./match.ts";
import type { GameClient, GameEntity } from "./state.ts";
import type { ConfigStringRegistry } from "./utilities.ts";

const CONTENTS_SOLID = 1;
const CONTENTS_PLAYERCLIP = 0x10000;
const CONTENTS_BODY = 0x2000000;
const RANK_TIED_FLAG = 0x4000;
const ANIM_TOGGLEBIT = 128;
const MAX_STRING_CHARS = 1024;
const TIMER_GESTURE = 34 * 66 + 50;
const offsetFirst = vec3(0, 0, 74);
const offsetSecond = vec3(-10, 60, 54);
const offsetThird = vec3(-19, -60, 45);

interface ArenaHost {
  readonly match: MatchRuntime;
  readonly world: ServerWorld;
  readonly cvars: CvarRegistry;
  readonly config: ConfigStringRegistry;
}

/** Each game's source podium pointers borrow entities from its own match pool. */
export class ArenaRuntime {
  private podium1: GameEntity | null = null;
  private podium2: GameEntity | null = null;
  private podium3: GameEntity | null = null;

  constructor(readonly host: ArenaHost) {}

  resetPodiumPlayers(): void {
    this.podium1 = this.podium2 = this.podium3 = null;
  }

  private get level() { return this.host.match.host.state; }
  private get pool() { return this.host.match.host.pool; }
  private sorted(index: number): number {
    const number = this.level.sortedClients[index];
    if (number === undefined) throw new RangeError("Arena rank index has no source storage");
    return number;
  }
  private client(entity: GameEntity): GameClient {
    if (entity.client === null) throw new Error("Arena entity has no source client pointer");
    return entity.client;
  }
  private score(number: number): number {
    return this.pool.clientAt(number).ps.persistant.get(PersistentIndex.PERS_SCORE);
  }
  private cvarInteger(name: "g_podiumDist" | "g_podiumDrop"): number {
    const cvar = this.host.cvars.get(name);
    if (cvar === undefined) throw new Error(`Arena requires registered cvar ${name}`);
    return cvar.integerValue;
  }

  updateTournamentInfo(): void {
    let player: GameEntity | null = null;
    let playerClientNum = 0;
    for (; playerClientNum < this.pool.maxClients; playerClientNum++) {
      const entity = this.pool.at(playerClientNum);
      if (entity.inuse && (entity.r.svFlags & ServerEntityFlags.BOT) === 0) { player = entity; break; }
    }
    if (player === null) return;

    this.host.match.calculateRanks();
    const match = this.host.match.host;
    const rankedClient = this.pool.clientAt(playerClientNum);
    let message: string;
    if (rankedClient.sess.sessionTeam === Team.TEAM_SPECTATOR) {
      message = gameFormat(match.product === "missionpack"
        ? "postgame %i %i 0 0 0 0 0 0 0 0 0 0 0" : "postgame %i %i 0 0 0 0 0 0",
      [this.level.numNonSpectatorClients, playerClientNum], MAX_STRING_CHARS);
    } else {
      const client = this.client(player), persistant = client.ps.persistant;
      const accuracy = client.accuracyShots !== 0 ? Math.trunc(Math.imul(client.accuracyHits, 100) / client.accuracyShots) | 0 : 0;
      if (match.product === "missionpack") {
        let won = false, score1: number, score2: number;
        if (match.settings().gameType >= GameType.GT_CTF) {
          score1 = match.teamScores.get(Team.TEAM_RED);
          score2 = match.teamScores.get(Team.TEAM_BLUE);
          won = rankedClient.sess.sessionTeam === Team.TEAM_RED ? score1 > score2 : score2 > score1;
        } else if (rankedClient === this.pool.clientAt(this.sorted(0))) {
          won = true;
          score1 = this.score(this.sorted(0)); score2 = this.score(this.sorted(1));
        } else {
          score2 = this.score(this.sorted(0)); score1 = this.score(this.sorted(1));
        }
        const perfect = won && persistant.get(PersistentIndex.PERS_KILLED) === 0 ? 1 : 0;
        message = gameFormat("postgame %i %i %i %i %i %i %i %i %i %i %i %i %i %i",
          [this.level.numNonSpectatorClients, playerClientNum, accuracy,
            persistant.get(PersistentIndex.PERS_IMPRESSIVE_COUNT), persistant.get(PersistentIndex.PERS_EXCELLENT_COUNT),
            persistant.get(PersistentIndex.PERS_DEFEND_COUNT), persistant.get(PersistentIndex.PERS_ASSIST_COUNT),
            persistant.get(PersistentIndex.PERS_GAUNTLET_FRAG_COUNT), persistant.get(PersistentIndex.PERS_SCORE), perfect,
            score1, score2, this.level.time, persistant.get(PersistentIndex.PERS_CAPTURES)], MAX_STRING_CHARS);
      } else {
        const perfect = rankedClient.ps.persistant.get(PersistentIndex.PERS_RANK) === 0 && persistant.get(PersistentIndex.PERS_KILLED) === 0 ? 1 : 0;
        message = gameFormat("postgame %i %i %i %i %i %i %i %i", [this.level.numNonSpectatorClients, playerClientNum, accuracy,
          persistant.get(PersistentIndex.PERS_IMPRESSIVE_COUNT), persistant.get(PersistentIndex.PERS_EXCELLENT_COUNT),
          persistant.get(PersistentIndex.PERS_GAUNTLET_FRAG_COUNT), persistant.get(PersistentIndex.PERS_SCORE), perfect], MAX_STRING_CHARS);
      }
    }

    const messageLength = message.length;
    for (let index = 0; index < this.level.numNonSpectatorClients; index++) {
      const number = this.sorted(index), persistant = this.pool.clientAt(number).ps.persistant;
      const row = gameFormat(" %i %i %i", [number, persistant.get(PersistentIndex.PERS_RANK), persistant.get(PersistentIndex.PERS_SCORE)], 32);
      if (messageLength + row.length + 1 >= MAX_STRING_CHARS) break;
      // Source never increments msglen. A reached strcat overflow has no owned storage here.
      if (message.length + row.length >= MAX_STRING_CHARS) throw new RangeError("Postgame strcat exceeds the source 1024-byte message buffer");
      message += row;
    }
    match.appendConsoleCommand(message);
  }

  private placeModel(body: GameEntity, podium: GameEntity, offset: Vec3): void {
    const angles = vectorToAngles(sub3(this.level.intermissionOrigin, podium.r.currentOrigin));
    body.s.apos = { ...body.s.apos, base: vec3(0, angles.y, 0) };
    const axis = qvmAngleVectors(body.s.apos.base);
    let origin = add3(podium.r.currentOrigin, scale3(axis.forward, offset.x));
    origin = add3(origin, scale3(axis.right, offset.y));
    origin = add3(origin, scale3(axis.up, offset.z));
    setOrigin(body, origin);
  }

  private spawnModelOnVictoryPad(pad: GameEntity, offset: Vec3, entity: GameEntity, place: number): GameEntity {
    const body = this.pool.spawn(), client = this.client(entity);
    body.bindClientName(client);
    body.client = client;
    body.s = entity.s.copy();
    body.s.eType = EntityType.ET_PLAYER;
    body.s.eFlags = body.s.powerups = body.s.loopSound = 0;
    body.s.number = body.slot;
    body.timestamp = this.level.time;
    body.physicsObject = true;
    body.physicsBounce = 0;
    body.s.event = 0;
    body.s.pos = { ...body.s.pos, type: TrajectoryType.TR_STATIONARY };
    body.s.groundEntityNum = ENTITYNUM_WORLD;
    body.s.legsAnim = PlayerAnimation.LEGS_IDLE;
    body.s.torsoAnim = PlayerAnimation.TORSO_STAND;
    if (body.s.weapon === Weapon.WP_NONE) body.s.weapon = Weapon.WP_MACHINEGUN;
    if (body.s.weapon === Weapon.WP_GAUNTLET) body.s.torsoAnim = PlayerAnimation.TORSO_STAND2;
    body.s.event = 0;
    body.r.svFlags = entity.r.svFlags;
    // SVF_CAPSULE is encoded in r.model; source leaves the separate bmodel zero.
    body.r.model = entity.r.model.kind === "capsule" ? { kind: "capsule" } : { kind: "box" };
    body.r.mins = { ...entity.r.mins }; body.r.maxs = { ...entity.r.maxs };
    body.clipmask = CONTENTS_SOLID | CONTENTS_PLAYERCLIP;
    body.r.contents = CONTENTS_BODY;
    body.r.ownerNum = entity.r.ownerNum;
    body.takedamage = false;
    this.placeModel(body, pad, offset);
    // trap_LinkEntity replaces the copied source absmin/absmax with these bounds.
    this.host.world.link(body);
    body.count = place;
    return body;
  }

  private celebrateStop(player: GameEntity): void {
    const animation = player.s.weapon === Weapon.WP_GAUNTLET ? PlayerAnimation.TORSO_STAND2 : PlayerAnimation.TORSO_STAND;
    player.s.torsoAnim = ((player.s.torsoAnim & ANIM_TOGGLEBIT) ^ ANIM_TOGGLEBIT) | animation;
  }
  private celebrateStart(player: GameEntity): void {
    player.s.torsoAnim = ((player.s.torsoAnim & ANIM_TOGGLEBIT) ^ ANIM_TOGGLEBIT) | PlayerAnimation.TORSO_GESTURE;
    player.nextthink = (this.level.time + TIMER_GESTURE) | 0;
    player.think = entity => this.celebrateStop(entity);
    this.pool.addEvent(player, EntityEvent.EV_TAUNT, 0);
  }
  private podiumOrigin(): Vec3 {
    const forward = qvmAngleVectors(this.level.intermissionAngle).forward;
    const view = this.level.intermissionOrigin;
    // VectorMA expands the live engine cvar trap separately for each component.
    let origin = vec3(
      view.x + Math.fround(forward.x * Math.fround(this.cvarInteger("g_podiumDist"))),
      view.y + Math.fround(forward.y * Math.fround(this.cvarInteger("g_podiumDist"))),
      view.z + Math.fround(forward.z * Math.fround(this.cvarInteger("g_podiumDist"))),
    );
    const drop = this.cvarInteger("g_podiumDrop");
    origin = vec3(origin.x, origin.y, origin.z - Math.fround(drop));
    return origin;
  }
  private podiumPlacementThink(podium: GameEntity): void {
    podium.nextthink = (this.level.time + 100) | 0;
    setOrigin(podium, this.podiumOrigin());
    if (this.podium1 !== null) this.placeModel(this.podium1, podium, offsetFirst);
    if (this.podium2 !== null) this.placeModel(this.podium2, podium, offsetSecond);
    if (this.podium3 !== null) this.placeModel(this.podium3, podium, offsetThird);
  }
  private spawnPodium(): GameEntity {
    const podium = this.pool.spawn();
    podium.classname = "podium";
    podium.s.eType = EntityType.ET_GENERAL;
    podium.s.number = podium.slot;
    podium.clipmask = podium.r.contents = CONTENTS_SOLID;
    podium.s.modelindex = this.host.config.modelIndex("models/mapobjects/podium/podium4.md3");
    setOrigin(podium, this.podiumOrigin());
    const yaw = vectorToAngles(sub3(this.level.intermissionOrigin, podium.r.currentOrigin)).y;
    podium.s.apos = { ...podium.s.apos, base: vec3(podium.s.apos.base.x, yaw, podium.s.apos.base.z) };
    this.host.world.link(podium);
    podium.think = entity => this.podiumPlacementThink(entity);
    podium.nextthink = (this.level.time + 100) | 0;
    return podium;
  }

  spawnModelsOnVictoryPads(): void {
    this.resetPodiumPlayers();
    const podium = this.spawnPodium();
    let number = this.sorted(0);
    let player = this.spawnModelOnVictoryPad(podium, offsetFirst, this.pool.at(number),
      this.pool.clientAt(number).ps.persistant.get(PersistentIndex.PERS_RANK) & ~RANK_TIED_FLAG);
    player.nextthink = (this.level.time + 2000) | 0;
    player.think = entity => this.celebrateStart(entity);
    this.podium1 = player;
    number = this.sorted(1);
    player = this.spawnModelOnVictoryPad(podium, offsetSecond, this.pool.at(number),
      this.pool.clientAt(number).ps.persistant.get(PersistentIndex.PERS_RANK) & ~RANK_TIED_FLAG);
    this.podium2 = player;
    if (this.level.numNonSpectatorClients > 2) {
      number = this.sorted(2);
      player = this.spawnModelOnVictoryPad(podium, offsetThird, this.pool.at(number),
        this.pool.clientAt(number).ps.persistant.get(PersistentIndex.PERS_RANK) & ~RANK_TIED_FLAG);
      this.podium3 = player;
    }
  }

  abortPodium(): void {
    if (this.host.match.host.settings().gameType !== GameType.GT_SINGLE_PLAYER) return;
    if (this.podium1 !== null) {
      this.podium1.nextthink = this.level.time;
      this.podium1.think = entity => this.celebrateStop(entity);
    }
  }
}
