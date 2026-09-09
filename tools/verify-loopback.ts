// Static-BSP movement/protocol verification. This does not implement a game session.
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { SnapshotHistory } from "../src/cgame/snapshot-history.ts";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { LocalPlayer } from "../src/engine/local-player.ts";
import { decodeClientMessage, encodeClientMessage } from "../src/protocol/client-message.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { MessageReader } from "../src/protocol/message.ts";
import type { WireUserCommand } from "../src/protocol/message.ts";
import { FRAGMENT_SIZE, Netchannel, xorClientMessage, xorServerMessage } from "../src/protocol/netchan.ts";
import type { ChannelRole } from "../src/protocol/netchan.ts";
import { ClientReliableCommands, ServerReliableCommands } from "../src/protocol/reliable.ts";
import { decodeServerMessage, encodeServerMessage } from "../src/protocol/server-message.ts";
import type { Gamestate, ServerMessageContext, ServerOperation, Snapshot } from "../src/protocol/server-message.ts";
import { statSchema, Weapon, weaponCount } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { EntityState, EntityStateRecord } from "../src/shared/entity-state.ts";
import type { EntityStateFields, SourceEntityState } from "../src/shared/entity-state.ts";
import { CommandButtons, ENTITYNUM_WORLD } from "../src/shared/player-state.ts";
import type { PlayerState, PlayerStateFields, UserCommand } from "../src/shared/player-state.ts";
import { playerStateToEntityState } from "../src/shared/snapshot-state.ts";

export interface MovementLoopbackOptions {
  readonly dataPath: string;
  readonly product: Product;
  readonly mapName: string;
  readonly frames?: number;
}

interface DifferenceSummary {
  readonly field: string;
  samples: number;
  server: string;
  client: string;
}

function requireGate(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Loopback verification failed: ${message}`);
}

function lookupCommand(history: ReadonlyMap<number, string>, sequence: number): string {
  const command = history.get(sequence);
  if (command === undefined) throw new Error(`Missing received server command ${sequence}`);
  return command;
}

function inputWeapon(number: number, product: Product): Weapon {
  const weapons = [Weapon.WP_NONE, Weapon.WP_GAUNTLET, Weapon.WP_MACHINEGUN, Weapon.WP_SHOTGUN, Weapon.WP_GRENADE_LAUNCHER, Weapon.WP_ROCKET_LAUNCHER, Weapon.WP_LIGHTNING, Weapon.WP_RAILGUN, Weapon.WP_PLASMAGUN, Weapon.WP_BFG, Weapon.WP_GRAPPLING_HOOK, Weapon.WP_NAILGUN, Weapon.WP_PROX_LAUNCHER, Weapon.WP_CHAINGUN];
  const weapon = weapons.find(value => value === number && value < weaponCount(product));
  if (weapon === undefined) throw new RangeError(`Invalid ${product} command weapon ${number}`);
  return weapon;
}

function inputCommand(command: WireUserCommand, product: Product): UserCommand {
  return { ...command, weapon: inputWeapon(command.weapon, product), angles: vec3(command.angles[0], command.angles[1], command.angles[2]) };
}

function putVector(record: Record<string, number>, name: string, value: Vec3): void {
  record[`${name}.x`] = value.x; record[`${name}.y`] = value.y; record[`${name}.z`] = value.z;
}

/** All transmitted playerState_t scalars and slots, read directly from published state. */
function playerWireValues(state: Readonly<PlayerStateFields>): Record<string, number> {
  const values: Record<string, number> = {
    commandTime: state.commandTime, pmType: state.pmType, bobCycle: state.bobCycle, pmFlags: state.pmFlags,
    pmTime: state.pmTime, weaponTime: state.weaponTime, gravity: state.gravity, speed: state.speed,
    groundEntityNum: state.groundEntityNum, legsTimer: state.legsTimer, legsAnim: state.legsAnim,
    torsoTimer: state.torsoTimer, torsoAnim: state.torsoAnim, movementDir: state.movementDir,
    eFlags: state.eFlags, eventSequence: state.eventSequence, externalEvent: state.externalEvent,
    externalEventParm: state.externalEventParm, clientNum: state.clientNum, weapon: state.weapon,
    weaponState: state.weaponState, viewheight: state.viewheight, damageEvent: state.damageEvent,
    damageYaw: state.damageYaw, damagePitch: state.damagePitch, damageCount: state.damageCount,
    generic1: state.generic1, loopSound: state.loopSound, jumppadEnt: state.jumppadEnt,
  };
  putVector(values, "origin", state.origin); putVector(values, "velocity", state.velocity);
  putVector(values, "deltaAngles", state.deltaAngles); putVector(values, "grapplePoint", state.grapplePoint);
  putVector(values, "viewangles", state.viewangles);
  for (let i = 0; i < 2; i++) { values[`events[${i}]`] = state.events.get(i); values[`eventParms[${i}]`] = state.eventParms.get(i); }
  for (let i = 0; i < 16; i++) {
    values[`stats[${i}]`] = state.stats.get(i); values[`persistant[${i}]`] = state.persistant.get(i);
    values[`ammo[${i}]`] = state.ammo.get(i); values[`powerups[${i}]`] = state.powerups.get(i);
  }
  return values;
}

function nonWireValues(state: Readonly<PlayerStateFields>): Record<string, number> {
  return { externalEventTime: state.externalEventTime, ping: state.ping, pmoveFramecount: state.pmoveFramecount,
    jumppadFrame: state.jumppadFrame, entityEventSequence: state.entityEventSequence };
}

function entityValues(state: Readonly<EntityStateFields>): Record<string, number> {
  const values: Record<string, number> = { number: state.number, eType: state.eType, eFlags: state.eFlags,
    time: state.time, time2: state.time2, otherEntityNum: state.otherEntityNum, otherEntityNum2: state.otherEntityNum2,
    groundEntityNum: state.groundEntityNum, constantLight: state.constantLight, loopSound: state.loopSound,
    modelindex: state.modelindex, modelindex2: state.modelindex2, clientNum: state.clientNum, frame: state.frame,
    solid: state.solid, event: state.event, eventParm: state.eventParm, powerups: state.powerups, weapon: state.weapon,
    legsAnim: state.legsAnim, torsoAnim: state.torsoAnim, generic1: state.generic1,
    "pos.type": state.pos.type, "pos.time": state.pos.time, "pos.duration": state.pos.duration,
    "apos.type": state.apos.type, "apos.time": state.apos.time, "apos.duration": state.apos.duration };
  putVector(values, "origin", state.origin); putVector(values, "origin2", state.origin2);
  putVector(values, "angles", state.angles); putVector(values, "angles2", state.angles2);
  putVector(values, "pos.base", state.pos.base); putVector(values, "pos.delta", state.pos.delta);
  putVector(values, "apos.base", state.apos.base); putVector(values, "apos.delta", state.apos.delta);
  return values;
}

function numberText(value: number): string { return Object.is(value, -0) ? "-0" : String(value); }

function recordDifference(summaries: Map<string, DifferenceSummary>, field: string, server: number, client: number): void {
  const existing = summaries.get(field);
  if (existing === undefined) summaries.set(field, { field, samples: 1, server: numberText(server), client: numberText(client) });
  else { existing.samples++; existing.server = numberText(server); existing.client = numberText(client); }
}

function compareValues(expected: Record<string, number>, actual: Record<string, number>, scope: string, zeroDifferences: Map<string, DifferenceSummary>): void {
  requireGate(Object.keys(expected).length === Object.keys(actual).length, `${scope} field count`);
  for (const [field, value] of Object.entries(expected)) {
    const received = actual[field];
    if (received === undefined) throw new Error(`Missing ${scope}.${field}`);
    if (Object.is(value, received)) continue;
    if (value === 0 && received === 0) { recordDifference(zeroDifferences, `${scope}.${field}`, value, received); continue; }
    throw new Error(`${scope}.${field}: server ${value}, client ${received}`);
  }
}

/** Runs real codecs, channels and source loopback queues around static-world Pmove. */
export async function runMovementLoopback(options: MovementLoopbackOptions) {
  const frames = options.frames ?? 200;
  if (!Number.isInteger(frames) || frames < 125 || frames > 10000) throw new RangeError("Loopback replay needs 125 through 10000 frames");
  if (!/^[a-zA-Z0-9_-]+$/.test(options.mapName)) throw new RangeError("Use a bare BSP map name");
  const vfs = await VirtualFileSystem.openInspection({ dataPath: options.dataPath, homePath: options.dataPath, cdPath: null, product: options.product });
  try {
    const mapBytes = await vfs.read(`maps/${options.mapName}.bsp`);
    const map = parseBsp(mapBytes, `maps/${options.mapName}.bsp`);
    const player = new LocalPlayer(map, options.product);
    const directPlayer = new LocalPlayer(map, options.product);
    player.state.clientNum = 1; directPlayer.state.clientNum = 1;
    const entity = new EntityState();
    playerStateToEntityState(player.state, entity, true);
    const initialBaselineValues = entityValues(entity);
    const initialOrigin = { ...player.state.origin };
    const initialYaw = Math.trunc(player.state.viewangles.y * 65536 / 360) & 65535;
    const serverBaselines = new Map<number, EntityState>([[entity.number, entity.copy()]]);
    const clientBaselines = new Map<number, SourceEntityState>();
    const clientHistory = new SnapshotHistory(); const serverHistory = new SnapshotHistory();
    const clientReliable = new ClientReliableCommands(); const serverReliable = new ServerReliableCommands();
    const receivedServerCommands = new Map<number, string>([[0, ""]]);
    const loopback = new LoopbackTransport();
    const qport = 27183; const challenge = 0x23456789; const checksumFeed = 0x12345678; const serverId = 123456;
    const clientChannel = new Netchannel("client", qport); const serverChannel = new Netchannel("server", qport);
    let clientMessageAcknowledge = 0; let clientServerCommandSequence = 0; let clientParseEntitiesNumber = 0;
    let serverLastClientCommand = 0; let serverLastClientCommandText = ""; let serverDeltaMessage = -1;
    let serverParseEntitiesNumber = 0;
    let clientCommandsExecuted = 0; let serverCommandsReceived = 0; let snapshotsCompared = 0;
    let recoveredClientCommand = false; let recoveredServerCommand = false; let recoveredServerDelta = false;
    let fullRecovery = false; let settled = false; let jumped = false; let ownershipChecks = 0;
    let fullSnapshots = 0; let deltaSnapshots = 0; let replayDuplicates = 0;
    const stats = { clientPackets: 0, serverPackets: 0, clientBytes: 0, serverBytes: 0, clientDrops: 0, serverDrops: 0, fragments: 0, deliveredMessages: 0 };
    const zeroDifferences = new Map<string, DifferenceSummary>(); const localDifferences = new Map<string, DifferenceSummary>();
    const executedTimes = new Set<number>(); const directByTime = new Map<number, PlayerState>([[0, directPlayer.state.copy()]]);
    const inputHistory: WireUserCommand[] = [];
    const replayHash = new Bun.CryptoHasher("sha256");
    const settleFrame = Math.max(50, Math.floor(frames * 0.25)); const jumpFrame = settleFrame + 1;
    const walkFrame = Math.floor(frames * 0.6); const turnFrame = Math.floor(frames * 0.75);
    const clientDropFrame = Math.floor(frames * 0.35); const serverDropFrame = Math.floor(frames * 0.55);
    const fullRecoveryFrame = frames - 10;
    let lostServerSequence = 0; let lastAckBeforeServerLoss = 0;
    let expectedLostClientReliable = 0; let expectedLostServerReliable = 0;

    function context(side: ChannelRole, messageNumber: number): ServerMessageContext {
      return { product: options.product, messageNumber, reliableSequence: side === "client" ? clientReliable.sequence : serverLastClientCommand,
        serverCommandSequence: side === "client" ? clientServerCommandSequence : serverReliable.sequence,
        parseEntitiesNumber: side === "client" ? clientParseEntitiesNumber : serverParseEntitiesNumber,
        baseline: number => (side === "client" ? clientBaselines : serverBaselines).get(number) ?? null,
        history: number => (side === "client" ? clientHistory : serverHistory).readSlot(number) };
    }

    function send(from: ChannelRole, payload: Uint8Array, drop: boolean): void {
      const datagrams = (from === "client" ? clientChannel : serverChannel).transmit(payload);
      for (const datagram of datagrams) {
        if (from === "client") { stats.clientPackets++; stats.clientBytes += datagram.length; }
        else { stats.serverPackets++; stats.serverBytes += datagram.length; }
        if ((new DataView(datagram.buffer, datagram.byteOffset, datagram.byteLength).getUint32(0, true) & 0x80000000) !== 0) stats.fragments++;
        if (drop) { if (from === "client") stats.clientDrops++; else stats.serverDrops++; }
        else { loopback.send(from, datagram); datagram.fill(0); }
      }
    }

    function drainServer(): void {
      for (let packet = loopback.poll("server"); packet !== null; packet = loopback.poll("server")) {
        const framed = serverChannel.receive(packet.payload);
        if (framed.kind === "rejected") throw new Error(`Server channel rejected ${framed.reason}`);
        if (framed.kind === "fragment") continue;
        stats.deliveredMessages++;
        requireGate(framed.qport === qport, "qport routing");
        const plain = xorClientMessage(framed.payload, challenge, sequence => serverReliable.lookup(sequence));
        const decoded = decodeClientMessage(plain, { checksumFeed, serverCommand: sequence => serverReliable.lookup(sequence),
          reliableSequence: serverReliable.sequence, lastClientCommand: serverLastClientCommand, lastUserCommandTime: player.state.commandTime });
        if (decoded.kind !== "accepted") throw new Error(`Server rejected client message: ${decoded.reason}`);
        requireGate(decoded.header.serverId === serverId, "serverId admission");
        requireGate(serverReliable.acknowledgeThrough(decoded.header.reliableAcknowledge).kind === "acknowledged", "server reliable acknowledgement");
        for (const command of decoded.commands) {
          serverLastClientCommandText = command.text; clientCommandsExecuted++;
          if (command.sequence === expectedLostClientReliable) recoveredClientCommand = true;
        }
        serverLastClientCommand = decoded.lastClientCommand;
        const movement = decoded.movement;
        if (movement === null) continue;
        serverDeltaMessage = movement.deltaMessage;
        replayDuplicates += movement.commands.length - movement.executableCommands.length;
        for (const command of movement.executableCommands) {
          requireGate(!executedTimes.has(command.serverTime), "backup command executes only once");
          executedTimes.add(command.serverTime);
          player.advance(inputCommand(command, options.product));
          if (command.serverTime === jumpFrame * 8 && player.state.velocity.z > 200) jumped = true;
          const direct = directByTime.get(command.serverTime);
          if (direct === undefined) throw new Error(`Missing direct replay command ${command.serverTime}`);
          compareValues(playerWireValues(direct), playerWireValues(player.state), "directReplay", zeroDifferences);
        }
      }
    }

    function compareSnapshot(snapshot: Snapshot): void {
      const slot = serverHistory.readSlot(snapshot.messageNumber);
      if (slot === null || slot.status !== "valid" || slot.snapshot.messageNumber !== snapshot.messageNumber) throw new Error("Missing server publication");
      const expected = slot.snapshot;
      requireGate(expected.serverTime === snapshot.serverTime && expected.deltaNumber === snapshot.deltaNumber
        && expected.flags === snapshot.flags && expected.serverCommandNumber === snapshot.serverCommandNumber, "snapshot header");
      compareValues(playerWireValues(expected.playerState), playerWireValues(snapshot.playerState), "playerState", zeroDifferences);
      requireGate(expected.playerState.product === snapshot.playerState.product, "snapshot product");
      requireGate(expected.playerState.stats.get(statSchema(expected.playerState.product).health)
        === snapshot.playerState.stats.get(statSchema(snapshot.playerState.product).health), "snapshot health");
      requireGate(isDeepStrictEqual(expected.areaMask, snapshot.areaMask), "snapshot area mask");
      requireGate(expected.entities.length === snapshot.entities.length, "snapshot entity count");
      for (const [i, state] of expected.entities.entries()) {
        const received = snapshot.entities[i];
        if (received === undefined) throw new Error("Missing received entity");
        compareValues(entityValues(state), entityValues(received), `entity[${state.number}]`, zeroDifferences);
      }
      const localExpected = nonWireValues(expected.playerState); const localActual = nonWireValues(snapshot.playerState);
      for (const [field, value] of Object.entries(localExpected)) {
        const received = localActual[field];
        if (received === undefined) throw new Error("Missing source-local player field");
        if (!Object.is(value, received)) recordDifference(localDifferences, field, value, received);
      }
      replayHash.update(JSON.stringify(playerWireValues(snapshot.playerState)));
      snapshotsCompared++;
    }

    function drainClient(): void {
      for (let packet = loopback.poll("client"); packet !== null; packet = loopback.poll("client")) {
        const framed = clientChannel.receive(packet.payload);
        if (framed.kind === "rejected") throw new Error(`Client channel rejected ${framed.reason}`);
        if (framed.kind === "fragment") continue;
        stats.deliveredMessages++;
        const ack = new MessageReader(framed.payload).readLong();
        const plain = xorServerMessage(framed.payload, challenge, framed.sequence, clientReliable.lookup(ack));
        const decoded = decodeServerMessage(plain, context("client", framed.sequence));
        requireGate(decoded.terminal === "eof", "server message terminal");
        requireGate(clientReliable.acknowledgeThrough(decoded.reliableAcknowledge).kind === "acknowledged", "client reliable acknowledgement");
        clientMessageAcknowledge = framed.sequence;
        clientServerCommandSequence = decoded.serverCommandSequence;
        clientParseEntitiesNumber = decoded.parseEntitiesNumber;
        for (const operation of decoded.operations) {
          if (operation.kind === "command") {
            receivedServerCommands.set(operation.sequence, operation.text); serverCommandsReceived++;
            if (operation.sequence === expectedLostServerReliable) recoveredServerCommand = true;
          } else if (operation.kind === "gamestate") {
            clientBaselines.clear(); clientHistory.clear();
            requireGate(operation.clientNumber === 1 && operation.checksumFeed === checksumFeed, "gamestate identity");
            requireGate(isDeepStrictEqual(operation.entries.filter(entry => entry.kind === "configstring"),
              gamestate.entries.filter(entry => entry.kind === "configstring")), "gamestate map metadata and fragmented fixture");
            for (const entry of operation.entries) if (entry.kind === "baseline") {
              const baseline = new EntityStateRecord<number>(0);
              baseline.copyFrom(entry.entity);
              clientBaselines.set(entry.number, baseline);
              const original = serverBaselines.get(entry.number);
              const received = clientBaselines.get(entry.number);
              if (original === undefined || received === undefined) throw new Error("Missing baseline ownership fixture");
              compareValues(entityValues(original), entityValues(received), "gamestateBaseline", zeroDifferences);
              requireGate(received !== original && received.pos.base !== original.pos.base, "baseline ownership");
              entry.entity.pos = { ...entry.entity.pos, base: vec3(99999, 99999, 99999) };
              requireGate(!isDeepStrictEqual(received.pos.base, entry.entity.pos.base), "baseline copies survive consumer mutation");
              ownershipChecks++;
            }
          } else if (operation.kind === "snapshot") {
            requireGate(operation.validity.kind === "valid", "delivered snapshot has a valid delta reference");
            compareSnapshot(operation.snapshot);
            requireGate(clientHistory.publish(operation), "client snapshot publication");
            const stored = clientHistory.latest;
            if (stored === null) throw new Error("Missing published client snapshot");
            operation.snapshot.playerState.stats.set(statSchema(operation.snapshot.playerState.product).health, -999);
            operation.snapshot.playerState.origin = vec3(99999, 99999, 99999);
            operation.snapshot.areaMask.fill(255);
            const decodedEntity = operation.snapshot.entities[0];
            if (decodedEntity === undefined) throw new Error("Missing decoded ownership entity");
            decodedEntity.pos = { ...decodedEntity.pos, base: vec3(99999, 99999, 99999) };
            const consumer = clientHistory.latest;
            if (consumer === null) throw new Error("Missing consumer snapshot");
            requireGate(isDeepStrictEqual(consumer, stored), "history survives decoder mutation");
            consumer.playerState.stats.set(statSchema(consumer.playerState.product).health, -111);
            consumer.playerState.origin = vec3(-99999, -99999, -99999);
            const consumerEntity = consumer.entities[0];
            if (consumerEntity === undefined) throw new Error("Missing consumer ownership entity");
            consumerEntity.pos = { ...consumerEntity.pos, base: vec3(-99999, -99999, -99999) };
            consumer.areaMask.fill(128);
            const again = clientHistory.latest;
            if (again === null) throw new Error("Missing isolated consumer snapshot");
            requireGate(isDeepStrictEqual(again, stored), "history survives consumer mutation");
            ownershipChecks += 2;
          }
        }
      }
    }

    const ready = serverReliable.add('print "loopback ready"');
    requireGate(ready.kind === "queued", "initial reliable command");
    const fixtureAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const largeConfigstring = Array.from({ length: 5000 }, (_, i) => fixtureAlphabet.charAt(i % fixtureAlphabet.length)).join("");
    const gamestate: Gamestate = { kind: "gamestate", commandSequence: serverReliable.sequence, clientNumber: 1, checksumFeed,
      entries: [{ kind: "configstring", index: 0, value: `\\mapname\\${options.mapName}\\g_gametype\\0\\sv_hostname\\TypeScript loopback verification` },
        { kind: "configstring", index: 1, value: `\\sv_serverid\\${serverId}\\sv_pure\\0\\fs_game\\${options.product === "missionpack" ? "missionpack" : ""}` },
        { kind: "configstring", index: 900, value: largeConfigstring },
        { kind: "baseline", number: entity.number, entity: entity.copy() }] };
    const initialOperations: ServerOperation[] = [...serverReliable.pending().map(command => ({ kind: "command", ...command } satisfies ServerOperation)), gamestate];
    const gamestatePayload = encodeServerMessage(0, initialOperations, context("server", 1));
    requireGate(gamestatePayload.length >= FRAGMENT_SIZE, "gamestate really fragments");
    send("server", xorServerMessage(gamestatePayload, challenge, 1, ""), false);
    drainClient();
    requireGate(clientMessageAcknowledge === 1 && stats.fragments > 1, "fragmented gamestate completes at sequence1");
    clientReliable.add('userinfo "\\name\\loopback-probe"'); clientReliable.add("say loopback-probe");

    for (let frame = 1; frame <= frames; frame++) {
      const previousPublication = serverHistory.latest;
      const turning = frame >= turnFrame ? Math.trunc((frame - turnFrame) * 16384 / (frames - turnFrame)) : 0;
      const command: WireUserCommand = { serverTime: frame * 8, angles: [0, (initialYaw + turning) & 65535, 0],
        forwardmove: frame >= walkFrame ? 64 : 0, rightmove: 0, upmove: frame === jumpFrame ? 127 : 0,
        buttons: frame >= walkFrame ? CommandButtons.WALKING : 0, weapon: Weapon.WP_MACHINEGUN };
      inputHistory.push(command);
      directPlayer.advance(inputCommand(command, options.product));
      directByTime.set(command.serverTime, directPlayer.state.copy());
      if (frame === clientDropFrame) expectedLostClientReliable = clientReliable.add("say client-loss-check").sequence;
      if (frame === serverDropFrame) {
        const added = serverReliable.add('print "server-loss-check"');
        if (added.kind !== "queued") throw new Error("Unexpected reliable overflow");
        expectedLostServerReliable = added.command.sequence;
      }
      const latest = clientHistory.latest;
      const noDelta = latest === null || latest.messageNumber !== clientMessageAcknowledge || frame === fullRecoveryFrame;
      const payload = encodeClientMessage({ header: { serverId, messageAcknowledge: clientMessageAcknowledge, reliableAcknowledge: clientServerCommandSequence },
        commands: clientReliable.pending(), movement: { kind: noDelta ? "move-no-delta" : "move", commands: inputHistory.slice(-3) } },
      { checksumFeed, serverCommand: sequence => lookupCommand(receivedServerCommands, sequence) });
      send("client", xorClientMessage(payload, challenge, sequence => lookupCommand(receivedServerCommands, sequence)), frame === clientDropFrame);
      drainServer();
      if (frame === settleFrame) settled = player.state.groundEntityNum === ENTITYNUM_WORLD && player.state.velocity.z === 0;
      playerStateToEntityState(player.state, entity, true);
      if (previousPublication !== null) {
        const previousSlot = serverHistory.readSlot(previousPublication.messageNumber);
        requireGate(previousSlot !== null && isDeepStrictEqual(previousSlot.snapshot, previousPublication), "published frame survives future simulation");
        ownershipChecks++;
      }
      const sequence = serverChannel.outgoingSequence;
      let deltaNumber = -1;
      if (serverDeltaMessage > 0) {
        const old = serverHistory.readSlot(serverDeltaMessage);
        if (old !== null && old.status === "valid" && old.snapshot.messageNumber === serverDeltaMessage && sequence - serverDeltaMessage < 29) deltaNumber = serverDeltaMessage;
      }
      if (frame === serverDropFrame) { lostServerSequence = sequence; lastAckBeforeServerLoss = serverDeltaMessage; }
      if (frame === serverDropFrame + 1) recoveredServerDelta = deltaNumber === lastAckBeforeServerLoss && deltaNumber !== lostServerSequence;
      if (frame === fullRecoveryFrame) fullRecovery = deltaNumber === -1 && deltaSnapshots > 0;
      if (deltaNumber === -1) fullSnapshots++; else deltaSnapshots++;
      const snapshot: Snapshot = { messageNumber: sequence, serverTime: frame * 8, deltaNumber, flags: 0,
        serverCommandNumber: serverReliable.sequence, parseEntitiesNumber: serverParseEntitiesNumber,
        areaMask: new Uint8Array(32), playerState: player.state.copy(), entities: [entity.copy()] };
      const operation: Extract<ServerOperation, { kind: "snapshot" }> = { kind: "snapshot", validity: { kind: "valid" }, snapshot };
      const operations: ServerOperation[] = [...serverReliable.pending().map(command => ({ kind: "command", ...command } satisfies ServerOperation)), operation];
      const serverPayload = encodeServerMessage(serverLastClientCommand, operations, context("server", sequence));
      requireGate(serverHistory.publish(operation), "server snapshot publication");
      serverParseEntitiesNumber += snapshot.entities.length;
      // Future simulation owns separate objects from the published server frame.
      const retained = serverHistory.latest;
      if (retained === null) throw new Error("Missing retained server publication");
      snapshot.playerState.stats.set(statSchema(snapshot.playerState.product).health, -222);
      const outgoingEntity = snapshot.entities[0];
      if (outgoingEntity === undefined) throw new Error("Missing outgoing ownership entity");
      outgoingEntity.pos = { ...outgoingEntity.pos, base: vec3(99999, 99999, 99999) };
      const retainedAgain = serverHistory.latest;
      if (retainedAgain === null) throw new Error("Missing retained server copy");
      requireGate(isDeepStrictEqual(retainedAgain, retained) && player.state.health === 125 && entity.pos.base.x !== 99999, "server publication owns player and entity state");
      ownershipChecks++;
      send("server", xorServerMessage(serverPayload, challenge, sequence, serverLastClientCommandText), frame === serverDropFrame);
      drainClient();
    }
    const finalAck = encodeClientMessage({ header: { serverId, messageAcknowledge: clientMessageAcknowledge, reliableAcknowledge: clientServerCommandSequence }, commands: clientReliable.pending(), movement: null },
      { checksumFeed, serverCommand: sequence => lookupCommand(receivedServerCommands, sequence) });
    send("client", xorClientMessage(finalAck, challenge, sequence => lookupCommand(receivedServerCommands, sequence)), false);
    drainServer();
    const final = clientHistory.latest;
    if (final === null) throw new Error("Missing final client snapshot");
    compareValues(playerWireValues(player.state), playerWireValues(final.playerState), "finalPlayerState", zeroDifferences);
    compareValues(playerWireValues(directPlayer.state), playerWireValues(player.state), "finalDirectReplay", zeroDifferences);
    for (const baselines of [clientBaselines, serverBaselines]) {
      const retained = baselines.get(entity.number);
      if (retained === undefined) throw new Error("Missing retained gamestate baseline");
      compareValues(initialBaselineValues, entityValues(retained), "retainedBaseline", zeroDifferences);
      ownershipChecks++;
    }
    const gates: Record<string, boolean> = {
      fragmentedGamestate: gamestatePayload.length >= FRAGMENT_SIZE && stats.fragments > 1,
      clientPacketLost: stats.clientDrops > 0, serverPacketLost: stats.serverDrops > 0,
      clientInputRecovered: executedTimes.has(clientDropFrame * 8) && executedTimes.size === frames,
      clientReliableRecovered: recoveredClientCommand, serverReliableRecovered: recoveredServerCommand,
      serverDeltaRecovered: recoveredServerDelta, fullSnapshotRecovery: fullRecovery,
      allDeliveredSnapshotsCompared: snapshotsCompared === frames - 1,
      settled, jumped, walked: Math.hypot(player.state.origin.x - initialOrigin.x, player.state.origin.y - initialOrigin.y) > 1,
      turned: player.state.viewangles.y !== initialYaw * 360 / 65536,
      reliableAcknowledgedBothWays: clientReliable.outstanding === 0 && serverReliable.outstanding === 0,
      duplicateBackupsIgnored: replayDuplicates > 0, independentCopies: ownershipChecks > frames * 2,
    };
    for (const [name, passed] of Object.entries(gates)) requireGate(passed, name);
    return {
      scope: "static-bsp-movement-protocol-probe", product: options.product, mapName: options.mapName,
      mapSha256: new Bun.CryptoHasher("sha256").update(mapBytes).digest("hex"), frames, stepMilliseconds: 8,
      packets: stats, snapshotsCompared, fullSnapshots, deltaSnapshots, executedUserCommands: executedTimes.size,
      ignoredBackupCommands: replayDuplicates, clientCommandsExecuted, serverCommandsReceived, ownershipChecks,
      dropFrames: { client: clientDropFrame, server: serverDropFrame }, fullRecoveryFrame, gamestateBytes: gamestatePayload.length,
      gates, replaySha256: replayHash.digest("hex"),
      sourceZeroNormalizations: [...zeroDifferences.values()], sourceLocalFieldDifferences: [...localDifferences.values()],
      finalState: { commandTime: final.playerState.commandTime, origin: { ...final.playerState.origin }, velocity: { ...final.playerState.velocity },
        viewangles: { ...final.playerState.viewangles }, pmTime: final.playerState.pmTime, weaponTime: final.playerState.weaponTime,
        groundEntityNum: final.playerState.groundEntityNum, eventSequence: final.playerState.eventSequence,
        health: final.playerState.stats.get(statSchema(final.playerState.product).health) },
    };
  } finally {
    vfs.close();
  }
}

async function main(): Promise<void> {
  let dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  let product: Product = "baseq3"; let mapName: string | null = null; let frames = 200; let output = ".artifacts/loopback.json";
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]; const value = args[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === "--data") dataPath = value;
    else if (flag === "--product") { if (value !== "baseq3" && value !== "missionpack") throw new Error("Product must be baseq3 or missionpack"); product = value; }
    else if (flag === "--map") mapName = value;
    else if (flag === "--frames") frames = Number(value);
    else if (flag === "--output") output = value;
    else throw new Error(`Unknown argument ${flag}`);
  }
  const report = await runMovementLoopback({ dataPath, product, mapName: mapName ?? (product === "baseq3" ? "q3dm1" : "mpteam1"), frames });
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\nReport: ${path}\n`);
}

if (import.meta.main) await main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
