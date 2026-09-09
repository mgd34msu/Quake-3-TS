// Owned client state from id Software's code/cgame/cg_local.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { vec3 } from "../core/math.ts";
import type { Axis, Vec3 } from "../core/math.ts";
import type { PcmSound } from "../assets/wav.ts";
import { createModelEntity, DEFAULT_MODEL } from "../render/ref-entity.ts";
import type { SceneModel, SceneShader } from "../render/ref-entity.ts";
import { createRefdef } from "../render/refdef.ts";
import { GameType } from "../shared/definitions.ts";
import type { Product } from "../shared/definitions.ts";
import { EntityState } from "../shared/entity-state.ts";
import { PlayerStateRecord, PlayerStateSlots } from "../shared/player-state.ts";
import type { SourcePlayerState } from "../shared/player-state.ts";
import { createLerpFrame } from "./animation.ts";
import { createPlayerPoseState } from "./player-pose.ts";
import { ClientInfo } from "./client-info.ts";
import type { RetailSnapshot } from "./retail-snapshot.ts";

export interface ClientScore {
  client: number; score: number; ping: number; time: number; scoreFlags: number; accuracy: number;
  impressiveCount: number; excellentCount: number; guantletCount: number; defendCount: number;
  assistCount: number; perfect: number; captures: number; team: number;
}
function createClientScore(): ClientScore {
  return { client: 0, score: 0, ping: 0, time: 0, scoreFlags: 0, accuracy: 0, impressiveCount: 0,
    excellentCount: 0, guantletCount: 0, defendCount: 0, assistCount: 0, perfect: 0, captures: 0, team: 0 };
}
export interface ClientReward {
  sound: PcmSound | null;
  shader: SceneShader | null;
  count: number;
}

/** cgs_t survives presentation frames; composition owns it beside cg_t. */
export class ClientGameStaticState {
  serverCommandSequence = 0;
  cursorX = 0;
  cursorY = 0;
  eventHandling = 0;
  activeCursor: SceneShader | null = null;
  readonly teamChatMsgs: [string, string, string, string, string, string, string, string] = ["", "", "", "", "", "", "", ""];
  readonly teamChatMsgTimes: [number, number, number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0, 0, 0];
  teamChatPos = 0;
  teamLastChatPos = 0;
  currentVoiceClient = 0;
  acceptOrderTime = 0;
  acceptTask = 0;
  acceptLeader = 0;
  acceptVoice = "";
  currentOrder = 0;
  orderPending = false;
  orderTime = 0;
  readonly clientInfo: readonly ClientInfo[] = Array.from({ length: 64 }, () => new ClientInfo());
  readonly gameModels: SceneModel[] = Array.from({ length: 256 }, () => DEFAULT_MODEL);
  readonly gameSounds: (PcmSound | null)[] = Array.from({ length: 256 }, () => null);
  gameType = GameType.GT_FFA;
  dmFlags = 0;
  teamFlags = 0;
  fraglimit = 0;
  capturelimit = 0;
  timelimit = 0;
  maxclients = 0;
  mapname = "";
  localServer = 0;
  redTeam = "";
  blueTeam = "";
  voteTime = 0;
  voteYes = 0;
  voteNo = 0;
  voteModified = false;
  voteString = "";
  readonly teamVoteTime: [number, number] = [0, 0];
  readonly teamVoteYes: [number, number] = [0, 0];
  readonly teamVoteNo: [number, number] = [0, 0];
  readonly teamVoteModified: [boolean, boolean] = [false, false];
  readonly teamVoteString: [string, string] = ["", ""];
  levelStartTime = 0;
  scores1 = 0;
  scores2 = 0;
  redflag = 0;
  blueflag = 0;
  flagStatus = 0;
  constructor(readonly product: Product) {}
}

export function createClientPlayerEntity() {
  return {
    ...createPlayerPoseState(),
    flag: { ...createLerpFrame(), yawAngle: 0, yawing: false, pitchAngle: 0, pitching: false }, lightningFiring: 0,
    railgunImpact: vec3(0, 0, 0), railgunFlash: false,
    barrelAngle: 0, barrelTime: 0, barrelSpinning: false,
  };
}
export type ClientPlayerEntity = ReturnType<typeof createClientPlayerEntity>;

export interface SkullTrail {
  readonly positions: [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3];
  numPositions: number;
}
function createSkullTrail(): SkullTrail {
  return { positions: [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0),
    vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0)], numPositions: 0 };
}

export class ClientEntity {
  currentState = new EntityState();
  nextState = new EntityState();
  interpolate = false;
  currentValid = false;
  muzzleFlashTime = 0;
  previousEvent = 0;
  teleportFlag = 0;
  trailTime = 0;
  dustTrailTime = 0;
  miscTime = 0;
  snapshotTime = 0;
  player = createClientPlayerEntity();
  errorTime = 0;
  errorOrigin = vec3(0, 0, 0);
  errorAngles = vec3(0, 0, 0);
  extrapolated = false;
  rawOrigin = vec3(0, 0, 0);
  rawAngles = vec3(0, 0, 0);
  beamEnd = vec3(0, 0, 0);
  lerpOrigin = vec3(0, 0, 0);
  lerpAngles = vec3(0, 0, 0);
}

export class ClientGameState {
  private readonly entities = Array.from({ length: 1024 }, () => new ClientEntity());
  readonly predictedPlayerEntity = new ClientEntity();
  readonly skullTrails: readonly SkullTrail[] = Array.from({ length: 64 }, createSkullTrail);
  readonly solidEntities: ClientEntity[] = [];
  readonly triggerEntities: ClientEntity[] = [];
  numScores = 0;
  selectedScore = 0;
  scoresRequestTime = 0;
  showScores = false;
  scoreFadeTime = 0;
  scoreBoardShowing = false;
  deferredPlayerLoading = 0;
  centerPrint = "";
  centerPrintTime = 0;
  centerPrintCharWidth = 0;
  centerPrintY = 0;
  centerPrintLines = 0;
  headStartYaw = 0;
  headEndYaw = 0;
  headStartPitch = 0;
  headEndPitch = 0;
  headStartTime = 0;
  headEndTime = 0;
  voiceTime = 0;
  crosshairClientNum = 0;
  crosshairClientTime = 0;
  readonly scores: readonly ClientScore[] = Array.from({ length: 64 }, createClientScore);
  readonly teamScores: [number, number] = [0, 0];
  numSortedTeamPlayers = 0;
  readonly sortedTeamPlayers: [number, number, number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0, 0, 0];
  warmupCount = 0;
  levelShot = false;
  infoScreenText = "";
  voiceChatTime = 0;
  voiceChatBufferIn = 0;
  voiceChatBufferOut = 0;
  soundBufferIn = 0;
  soundBufferOut = 0;
  soundTime = 0;
  readonly soundBuffer: (PcmSound | null)[] = Array.from({ length: 20 }, () => null);
  spectatorList = "";
  spectatorLen = 0;
  spectatorWidth = 0;
  spectatorTime = 0;
  spectatorOffset = 0;
  spectatorPaintX = 0;
  spectatorPaintX2 = 0;
  spectatorPaintLen = 0;
  latestSnapshotNum = 0;
  latestSnapshotTime = 0;
  snap: RetailSnapshot | null = null;
  nextSnap: RetailSnapshot | null = null;
  time = 0;
  oldTime = 0;
  frameTime = 0;
  physicsTime = 0;
  frameInterpolation = 0;
  thisFrameTeleport = false;
  nextFrameTeleport = false;
  clientFrame = 0;
  autoAngles = vec3(0, 0, 0);
  autoAnglesFast = vec3(0, 0, 0);
  autoAxis: Axis = [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0)];
  autoAxisFast: Axis = [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0)];
  mapRestart = false;
  hyperspace = false;
  predictedPlayerState: SourcePlayerState;
  validPPS = false;
  predictedErrorTime = 0;
  predictedError = vec3(0, 0, 0);
  eventSequence = 0;
  killerName = "";
  itemPickup = 0;
  itemPickupTime = 0;
  itemPickupBlendTime = 0;
  weaponSelect = 0;
  weaponSelectTime = 0;
  landChange = 0;
  landTime = 0;
  stepChange = 0;
  stepTime = 0;
  powerupActive = 0;
  powerupTime = 0;
  refdef = createRefdef();
  refdefViewAngles = vec3(0, 0, 0);
  bobCycle = 0;
  xyspeed = 0;
  bobFracSin = 0;
  renderingThirdPerson = false;
  testGun = false;
  kickAngles = vec3(0, 0, 0);
  kickOrigin = vec3(0, 0, 0);
  damageTime = 0;
  damageKickEndTime = 0;
  attackerTime = 0;
  lowAmmoWarning = 0;
  rewardStack = 0;
  rewardTime = 0;
  readonly rewards: readonly ClientReward[] = Array.from({ length: 10 }, () => ({ sound: null, shader: null, count: 0 }));
  intermissionStarted = false;
  warmup = 0;
  timelimitWarnings = 0;
  fraglimitWarnings = 0;
  damagePitch = 0;
  damageRoll = 0;
  damageX = 0;
  damageY = 0;
  damageValue = 0;
  duckChange = 0;
  duckTime = 0;
  zoomed = false;
  zoomTime = 0;
  zoomSensitivity = 0;
  nextOrbitTime = 0;
  testModelName = "";
  testModelEntity = createModelEntity();
  readonly predictableEvents = new PlayerStateSlots(16);

  constructor(readonly product: Product, readonly clientNum: number, public processedSnapshotNum: number) {
    if (!Number.isInteger(clientNum) || clientNum < 0 || clientNum >= 64) throw new RangeError("Invalid cgame client number");
    if (!Number.isInteger(processedSnapshotNum) || processedSnapshotNum < -0x80000000 || processedSnapshotNum > 0x7fffffff) {
      throw new RangeError("Invalid initial snapshot number");
    }
    this.predictedPlayerState = new PlayerStateRecord<number, number, number>(product, 0, 0, 0);
  }

  entityAt(number: number): ClientEntity {
    const entity = this.entities[number];
    if (entity === undefined) throw new RangeError(`Invalid cgame entity number ${number}`);
    return entity;
  }
}
