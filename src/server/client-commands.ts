// Port of id Software's server/sv_client.c client message/command/movement execution.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { vec3 } from "../core/math.ts";
import type { CallSteps } from "../core/call-steps.ts";
import type { ServerGame } from "./game.ts";
import { ClientMessageReader, InvalidClientCommandCountError, InvalidClientOpcodeError } from "../protocol/client-message.ts";
import type { ClientMessagePart, UnfilteredClientMovement } from "../protocol/client-message.ts";
import type { WireUserCommand } from "../protocol/message.ts";
import type { ReliableCommand } from "../protocol/reliable.ts";
import type { UserCommand } from "../shared/player-state.ts";
import { ServerClientPhase } from "./state.ts";
import type { ServerClient, ServerStaticState, ServerWorldState } from "./state.ts";

export interface ServerClientCommandHost {
  readonly debugBuild: boolean;
  readonly pure: boolean;
  readonly clientRunning: boolean;
  readonly floodProtect: boolean;
  print(text: string): void;
  debugPrint(text: string): void;
  tokenize(text: string): readonly string[];
  dropClient(client: ServerClient, reason: string): CallSteps;
  sendClientGameState(client: ServerClient): void;
  /** SV_UserinfoChanged: source name/rate/snaps/handicap/IP normalization, before GAME_CLIENT_USERINFO_CHANGED. */
  userinfoChanged(client: ServerClient): void;
  verifyPaks(client: ServerClient, argv: readonly string[]): CallSteps;
  beginDownload(client: ServerClient, argv: readonly string[]): void;
  nextDownload(client: ServerClient, argv: readonly string[]): CallSteps;
  stopDownload(client: ServerClient): void;
  doneDownload(client: ServerClient): void;
}

function copyCommand(command: UserCommand): UserCommand {
  return { ...command, angles: { ...command.angles } };
}

function gameCommand(command: WireUserCommand): UserCommand {
  return { ...command, angles: vec3(command.angles[0], command.angles[1], command.angles[2]) };
}

/** State belongs to the canonical server records; all configuration reads remain live. */
export class ServerClientCommandRuntime {
  constructor(readonly world: ServerWorldState, readonly staticState: ServerStaticState,
    readonly host: ServerClientCommandHost) {
    if (world.product !== staticState.product) throw new Error("Server client-command product mismatch");
  }

  private own(client: ServerClient): void {
    if (this.staticState.clients[client.slot] !== client) throw new Error("Client does not belong to this server");
  }

  private game(): ServerGame {
    const game = this.world.game;
    if (game === null) throw new Error("Server client execution requires a current game runtime");
    if (game.product !== this.world.product) throw new Error("Server client game product mismatch");
    return game;
  }

  /** Also used by map_restart, which supplies the connection's previous command. */
  *clientEnterWorld(client: ServerClient, command: UserCommand): CallSteps {
    this.own(client);
    if (client.connection.kind !== "initialized") throw new Error("Cannot enter world with an uninitialized connection");
    this.host.debugPrint(`Going from CS_PRIMED to CS_ACTIVE for ${client.name}\n`);
    client.connection.phase = ServerClientPhase.Active;
    const game = this.game();
    const entity = game.data.entity(client.slot);
    entity.s.number = client.slot;
    client.gameEntity = entity;
    client.deltaMessage = -1;
    client.nextSnapshotTime = this.staticState.time;
    client.lastUsercmd = copyCommand(command);
    yield* game.calls.clientBegin(client.slot);
  }

  /** Also a source bot entry point; the command is saved even after a client was kicked. */
  *clientThink(client: ServerClient, command: UserCommand): CallSteps {
    this.own(client);
    client.lastUsercmd = copyCommand(command);
    if (client.phase !== ServerClientPhase.Active) return;
    yield* this.game().calls.clientThink(client.slot, copyCommand(client.lastUsercmd));
  }

  /** SV_ExecuteClientCommand is also called by bot code, outside a network packet. */
  *executeClientCommand(client: ServerClient, text: string, clientOK: boolean): CallSteps {
    this.own(client);
    const nul = text.indexOf("\0");
    const command = nul < 0 ? text : text.slice(0, nul);
    const argv = this.host.tokenize(command);
    switch (argv[0]) {
      case "userinfo":
        // Cmd_Argv returns an empty C string for missing arguments.
        client.userinfo = (argv[1] === undefined ? "" : argv[1]).slice(0, 1023);
        this.host.userinfoChanged(client);
        yield* this.game().calls.clientUserinfoChanged(client.slot);
        return;
      case "disconnect": yield* this.host.dropClient(client, "disconnected"); return;
      case "cp": yield* this.host.verifyPaks(client, argv); return;
      case "vdr": client.pureAuthentic = false; client.gotCP = false; return;
      case "download": this.host.beginDownload(client, argv); return;
      case "nextdl": yield* this.host.nextDownload(client, argv); return;
      case "stopdl": this.host.stopDownload(client); return;
      case "donedl": this.host.doneDownload(client); return;
      default:
        if (clientOK) {
          if (this.world.state === "game") yield* this.game().calls.clientCommand(client.slot, argv);
        } else this.host.debugPrint(`client text ignored for ${client.name}: ${argv[0] === undefined ? "" : argv[0]}\n`);
    }
  }

  private *clientCommand(client: ServerClient, command: ReliableCommand): CallSteps<boolean> {
    if (client.lastClientCommand >= command.sequence) return true;
    this.host.debugPrint(`clientCommand: ${client.name} : ${command.sequence} : ${command.text}\n`);
    if (command.sequence > ((client.lastClientCommand + 1) | 0)) {
      this.host.print(`Client ${client.name} lost ${(command.sequence - client.lastClientCommand + 1) | 0} clientCommands\n`);
      yield* this.host.dropClient(client, "Lost reliable commands");
      return false;
    }
    let clientOK = true;
    if (!this.host.clientRunning && client.phase >= ServerClientPhase.Active && this.host.floodProtect
      && this.staticState.time < client.nextReliableTime) clientOK = false;
    client.nextReliableTime = (this.staticState.time + 1000) | 0;
    yield* this.executeClientCommand(client, command.text, clientOK);
    client.lastClientCommand = command.sequence;
    client.lastClientCommandString = command.text.slice(0, 1023);
    return true;
  }

  private *userMove(client: ServerClient, reader: ClientMessageReader): CallSteps {
    let movement: UnfilteredClientMovement;
    try {
      movement = reader.readMovement({ checksumFeed: this.world.checksumFeed,
        serverCommand: () => client.reliable.lookupMasked(client.reliable.acknowledge) });
    } catch (error) {
      if (!(error instanceof InvalidClientCommandCountError)) throw error;
      this.host.print(error.count < 1 ? "cmdCount < 1\n" : "cmdCount > MAX_PACKET_USERCMDS\n");
      return;
    }
    const frame = client.frames[client.messageAcknowledge & 31];
    if (frame === undefined) throw new Error("Missing canonical client frame");
    frame.messageAcked = this.staticState.time;
    if (this.host.pure && !client.pureAuthentic && !client.gotCP) {
      if (client.phase === ServerClientPhase.Active) {
        this.host.debugPrint(`${client.name}: didn't get cp command, resending gamestate\n`);
        this.host.sendClientGameState(client);
      }
      return;
    }
    if (client.phase === ServerClientPhase.Primed) yield* this.clientEnterWorld(client, gameCommand(movement.commands[0]));
    if (this.host.pure && !client.pureAuthentic) {
      yield* this.host.dropClient(client, "Cannot validate pure client!");
      return;
    }
    if (client.phase !== ServerClientPhase.Active) { client.deltaMessage = -1; return; }
    const latest = movement.commands[movement.commands.length - 1];
    if (latest === undefined) throw new Error("Missing last decoded client command");
    for (const command of movement.commands) {
      if (command.serverTime > latest.serverTime || command.serverTime <= client.lastUsercmd.serverTime) continue;
      yield* this.clientThink(client, gameCommand(command));
    }
  }

  /** Caller has completed channel reassembly/XOR and the source zombie/time bookkeeping. */
  *executeClientMessage(client: ServerClient, reader: ClientMessageReader): CallSteps {
    this.own(client);
    if (client.connection.kind !== "initialized") throw new Error("Cannot execute packet without an initialized connection");
    client.messageAcknowledge = reader.prefix.messageAcknowledge;
    if (client.messageAcknowledge < 0) {
      if (this.host.debugBuild) yield* this.host.dropClient(client, "DEBUG: illegible client message");
      return;
    }
    const header = reader.readHeader();
    client.reliable.assignAcknowledgement(header.reliableAcknowledge);
    if (client.reliable.acknowledge < client.reliable.sequence - 64) {
      if (this.host.debugBuild) yield* this.host.dropClient(client, "DEBUG: illegible client message");
      client.reliable.assignAcknowledgement(client.reliable.sequence);
      return;
    }
    if (header.serverId !== this.world.serverId && client.download.name.length === 0 && !client.lastClientCommandString.includes("nextdl")) {
      if (header.serverId >= this.world.restartedServerId && header.serverId < this.world.serverId) {
        this.host.debugPrint(`${client.name} : ignoring pre map_restart / outdated client message\n`);
        return;
      }
      if (client.messageAcknowledge > client.gamestateMessageNum) {
        this.host.debugPrint(`${client.name} : dropped gamestate, resending\n`);
        this.host.sendClientGameState(client);
      }
      return;
    }
    while (true) {
      let part: ClientMessagePart;
      try { part = reader.next(); } catch (error) {
        if (!(error instanceof InvalidClientOpcodeError)) throw error;
        this.host.print(`WARNING: bad command byte for client ${client.slot}\n`);
        return;
      }
      if (part.kind === "eof") return;
      if (part.kind === "command") {
        if (!(yield* this.clientCommand(client, part.command)) || client.phase === ServerClientPhase.Zombie) return;
      } else {
        client.deltaMessage = part.deltaMessage;
        yield* this.userMove(client, reader);
        return;
      }
    }
  }
}
