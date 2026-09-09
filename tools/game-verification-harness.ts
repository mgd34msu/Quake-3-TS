// Shared engine boundary for controlled authoritative GameRuntime verifiers.
import type { BspMap } from "../src/assets/bsp.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import type { GameEngineImports, GameRuntimeOwner } from "../src/game/runtime.ts";
import { ServerWorld } from "../src/server/world.ts";
import { GameType, Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import type { UserCommand } from "../src/shared/player-state.ts";

export interface GameVerificationHarnessOptions {
  readonly product: Product;
  readonly map: BspMap;
  readonly gameType: GameType;
  readonly levelTime: number;
  readonly randomSeed: number;
  readonly buildDate: string;
  readonly clientNamePrefix: string;
  readonly botsReason: string;
  readonly additionalCvars?: readonly (readonly [string, string])[];
}

export interface GameVerificationHarness {
  readonly runtime: GameRuntime;
  readonly owner: GameRuntimeOwner;
  readonly cvars: CvarRegistry;
  readonly configstrings: Map<number, string>;
  readonly consoleCommands: string[];
  readonly messages: { readonly client: number; readonly text: string }[];
  readonly prints: string[];
  readonly userinfo: Map<number, string>;
  readonly commands: Map<number, UserCommand>;
  readonly engine: GameEngineImports;
  setCommand(client: number, command: UserCommand): void;
}

function initialCommand(time: number): UserCommand {
  return { serverTime: time, angles: vec3(0, 0, 0), buttons: 0, weapon: Weapon.WP_MACHINEGUN,
    forwardmove: 0, rightmove: 0, upmove: 0 };
}

export function createGameVerificationHarness(options: GameVerificationHarnessOptions): GameVerificationHarness {
  const cvars = new CvarRegistry();
  const settings: readonly (readonly [string, string])[] = [
    ["sv_maxclients", "4"], ["g_gametype", String(options.gameType)], ["g_log", ""], ["bot_enable", "0"],
    ["sv_cheats", "1"], ["g_teamAutoJoin", "1"], ["fraglimit", "20"], ["capturelimit", "8"], ["g_doWarmup", "0"],
    ...(options.additionalCvars ?? []),
  ];
  for (const [name, value] of settings) cvars.set(name, value, true);

  const configstrings = new Map<number, string>();
  const consoleCommands: string[] = [];
  const messages: { readonly client: number; readonly text: string }[] = [];
  const prints: string[] = [];
  const userinfo = new Map<number, string>();
  const commands = new Map<number, UserCommand>();
  const owner: GameRuntimeOwner = { game: null };
  for (let slot = 0; slot < 2; slot++) {
    userinfo.set(slot, `\\name\\${options.clientNamePrefix}${slot}\\ip\\localhost\\handicap\\100\\model\\sarge/default`);
    commands.set(slot, initialCommand(options.levelTime));
  }
  const engine: GameEngineImports = {
    milliseconds: () => 0,
    print: text => { prints.push(text); },
    sendServerCommand: (client, text) => { messages.push({ client, text }); },
    dropClient: (client, reason) => {
      const runtime = owner.game;
      if (!(runtime instanceof GameRuntime)) throw new Error(`Unexpected initialization drop: ${client}: ${reason}`);
      prints.push(`drop:${client}:${reason}`);
      runtime.clientDisconnect(client);
    },
    getUserinfo: client => {
      const value = userinfo.get(client);
      if (value === undefined) throw new Error(`Unknown engine userinfo slot ${client}`);
      return value;
    },
    setUserinfo: (client, value) => { userinfo.set(client, value); },
    getUserCommand: client => {
      const value = commands.get(client);
      if (value === undefined) throw new Error(`Unknown engine command slot ${client}`);
      return value;
    },
    appendConsoleCommand: text => { consoleCommands.push(text); },
    insertConsoleCommand: text => { consoleCommands.push(`insert:${text}`); },
    executeConsoleNow: text => { consoleCommands.push(`now:${text}`); },
    openLog: () => { throw new Error("Verifier deliberately disables game file logging"); },
  };
  const collision = new CollisionWorld(options.map, { kind: "unaccounted" }, { kind: "disabled" });
  const world = new ServerWorld(collision, collision.modelBounds(0), number => owner.game?.data.entity(number), { loading: false, print: text => { engine.print(text); }, developerPrint: text => { const developer = cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) engine.print(text); } });
  const runtime = GameRuntime.create({ product: options.product, map: options.map, collision, world,
    levelTime: options.levelTime, randomSeed: options.randomSeed, restart: false, buildDate: options.buildDate, cvars,
    configstrings: { get: index => configstrings.get(index) ?? "", set: (index, value) => { configstrings.set(index, value); } },
    engine, botFactory: { kind: "unavailable", reason: options.botsReason } }, owner);
  return { runtime, owner, cvars, configstrings, consoleCommands, messages, prints, userinfo, commands, engine,
    setCommand: (client, value) => { commands.set(client, value); } };
}
