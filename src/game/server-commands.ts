// Ported from id Software's code/game/g_svcmds.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CvarRegistry, CvarSnapshot } from "../core/cvar.ts";
import { EntityType } from "../shared/definitions.ts";
import { concatCommandArgs } from "./commands.ts";
import type { EntityPool } from "./entities.ts";
import { gameFormat } from "./format.ts";
import { gameAtoi } from "./numeric.ts";
import { ConnectionState } from "./state.ts";
import type { GameClient, GameEntity } from "./state.ts";

const MAX_IP_FILTERS = 1024;
const MAX_BAN_STRING = 256;
const FREE_FILTER = 0xffffffff;
interface IpFilter { mask: number; compare: number }

export type ServerCommandCapability =
  | { readonly kind: "available"; readonly run: (argv: readonly string[]) => void }
  | { readonly kind: "unavailable"; readonly reason: string };
export type ServerCommandCvar = "g_banIPs" | "g_filterBan" | "g_gametype" | "dedicated";

export interface GameServerCommandHost {
  readonly readVmCvar: (name: ServerCommandCvar) => CvarSnapshot;
  readonly print: (text: string) => void;
  readonly sendServerCommand: (clientNumber: number, command: string) => void;
  readonly executeConsoleNow: (text: string) => void;
  readonly setTeam: (entity: GameEntity, team: string) => void;
  readonly bots: ServerCommandCapability;
  readonly memory: ServerCommandCapability;
  readonly podium: ServerCommandCapability;
}

function byteString(text: string): string {
  const nul = text.indexOf("\0");
  const value = nul < 0 ? text : text.slice(0, nul);
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 255) throw new RangeError("Game console strings require source bytes");
  return value;
}
function lower(text: string): string { return text.replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32)); }
function digit(character: string): boolean { return character >= "0" && character <= "9"; }
/** trap_Argv supplies an empty string for a missing argument and truncates its buffer. */
function argument(argv: readonly string[], index: number): string {
  const value = argv[index];
  return value === undefined ? "" : byteString(value).slice(0, 1023);
}

function stringToFilter(text: string, print: GameServerCommandHost["print"]): IpFilter | null {
  let offset = 0; let mask = 0; let compare = 0;
  for (let i = 0; i < 4; i++) {
    const first = text.charAt(offset);
    if (!digit(first)) {
      if (first === "*") {
        offset++;
        if (offset === text.length) break;
        offset++;
        continue;
      }
      print(`Bad filter address: ${text.slice(offset)}\n`);
      return null;
    }
    const start = offset;
    while (digit(text.charAt(offset))) offset++;
    if (offset - start >= 128) throw new RangeError("IP filter component exceeds the source127-digit scratch buffer");
    compare |= (gameAtoi(text.slice(start, offset)) & 255) << (i * 8);
    mask |= 255 << (i * 8);
    if (offset === text.length) break;
    offset++;
  }
  return { mask: mask >>> 0, compare: compare >>> 0 };
}

export class GameServerCommandState {
  readonly filters: IpFilter[] = [];
}

/** Source static filters belong to the loaded game module, not each INIT. */
export class GameServerCommandRuntime {
  private banVmString: { modificationCount: number; value: string } | null = null;

  constructor(readonly pool: EntityPool, readonly cvars: CvarRegistry, readonly host: GameServerCommandHost,
    private readonly state = new GameServerCommandState()) {}

  private get filters(): IpFilter[] { return this.state.filters; }

  private cvar(name: ServerCommandCvar): CvarSnapshot { return this.host.readVmCvar(name); }

  private updateIPBans(): void {
    let list = "";
    for (const filter of this.filters) {
      if (filter.compare === FREE_FILTER) continue;
      let address = "";
      for (let byte = 0; byte < 4; byte++) {
        address += ((filter.mask >>> (byte * 8)) & 255) === 255 ? String((filter.compare >>> (byte * 8)) & 255) : "*";
        address += byte < 3 ? "." : " ";
      }
      if (list.length + address.length >= MAX_BAN_STRING) {
        this.host.print("g_banIPs overflowed at MAX_CVAR_VALUE_STRING\n");
        break;
      }
      list += address;
    }
    this.cvars.set("g_banIPs", list, true);
  }

  private addIP(text: string): void {
    let index = this.filters.findIndex(filter => filter.compare === FREE_FILTER);
    if (index < 0) index = this.filters.length;
    if (index === MAX_IP_FILTERS) { this.host.print("IP filter list is full\n"); return; }
    // Undefined native scratch overflow rejects before changing the selected slot.
    const parsed = stringToFilter(text, this.host.print);
    if (index === this.filters.length) this.filters.push({ mask: 0, compare: FREE_FILTER });
    const selected = this.filters[index];
    if (selected === undefined) throw new Error("Missing selected IP filter slot");
    if (parsed === null) selected.compare = FREE_FILTER;
    else { selected.mask = parsed.mask; selected.compare = parsed.compare; }
    this.updateIPBans();
  }

  /** G_ProcessIPBans intentionally ignores a final token lacking a trailing space. */
  processIPBans(): void {
    const snapshot = this.cvar("g_banIPs");
    if (this.banVmString === null || this.banVmString.modificationCount !== snapshot.modificationCount) {
      this.banVmString = { modificationCount: snapshot.modificationCount, value: byteString(snapshot.value) };
    }
    const input = this.banVmString.value;
    if (input.length >= MAX_BAN_STRING) throw new RangeError("g_banIPs exceeds the source256-byte vmCvar buffer");
    // The source writes NULs into its vmCvar string, not its unused local copy.
    const firstSpace = input.indexOf(" ");
    if (firstSpace >= 0) this.banVmString.value = input.slice(0, firstSpace);
    let start = 0;
    while (start < input.length) {
      const space = input.indexOf(" ", start);
      if (space < 0) break;
      if (space > start) this.addIP(input.slice(start, space));
      start = space;
      while (input.charAt(start) === " ") start++;
    }
  }

  /** True rejects admission. This is the raw g_svcmds parser, not strict IPv4. */
  filterPacket(from: string): boolean {
    const text = byteString(from);
    if (text.length > 1023) throw new RangeError("IP address exceeds the source userinfo bound");
    let offset = 0; let initialized = 0; let incoming = 0;
    while (offset < text.length && initialized < 4) {
      let byte = 0;
      while (digit(text.charAt(offset))) { byte = (byte * 10 + text.charCodeAt(offset) - 48) & 255; offset++; }
      incoming |= byte << (initialized * 8);
      initialized++;
      if (offset === text.length || text.charAt(offset) === ":") break;
      offset++;
    }
    const denyMatches = this.cvar("g_filterBan").integerValue !== 0;
    const initializedMask = initialized === 4 ? 0xffffffff : (2 ** (initialized * 8) - 1) >>> 0;
    for (const filter of this.filters) {
      if (((incoming & filter.mask & initializedMask) >>> 0) !== ((filter.compare & initializedMask) >>> 0)) continue;
      // Bots have no IP epair. Missing octets matter only to a matching filter
      // that actually consumes them, never to the empty filter list.
      if ((filter.mask & ~initializedMask) !== 0) throw new RangeError("IP filter reads uninitialized source octets");
      if (((incoming & filter.mask) >>> 0) === filter.compare) return denyMatches;
    }
    return !denyMatches;
  }

  private removeIP(argv: readonly string[]): void {
    if (argv.length < 2) { this.host.print("Usage:  sv removeip <ip-mask>\n"); return; }
    const text = argument(argv, 1);
    const parsed = stringToFilter(text, this.host.print);
    if (parsed === null) return;
    for (const filter of this.filters) {
      if (filter.mask !== parsed.mask || filter.compare !== parsed.compare) continue;
      filter.compare = FREE_FILTER;
      this.host.print("Removed.\n");
      this.updateIPBans();
      return;
    }
    this.host.print(`Didn't find ${text}.\n`);
  }

  clientForString(value: string): GameClient | null {
    const text = byteString(value);
    if (digit(text.charAt(0))) {
      const slot = gameAtoi(text);
      if (slot < 0 || slot >= this.pool.maxClients) { this.host.print(gameFormat("Bad client slot: %i\n", [slot])); return null; }
      const client = this.pool.clientAt(slot);
      if (client.pers.connected === ConnectionState.DISCONNECTED) { this.host.print(gameFormat("Client %i is not connected\n", [slot])); return null; }
      return client;
    }
    for (let i = 0; i < this.pool.maxClients; i++) {
      const client = this.pool.clientAt(i);
      if (client.pers.connected !== ConnectionState.DISCONNECTED && lower(client.pers.netname) === lower(text)) return client;
    }
    this.host.print(`User ${text} is not on the server\n`);
    return null;
  }

  private entityList(): void {
    const labels = new Map<number, string>([
      [EntityType.ET_GENERAL, "ET_GENERAL"], [EntityType.ET_PLAYER, "ET_PLAYER"], [EntityType.ET_ITEM, "ET_ITEM"],
      [EntityType.ET_MISSILE, "ET_MISSILE"], [EntityType.ET_MOVER, "ET_MOVER"], [EntityType.ET_BEAM, "ET_BEAM"],
      [EntityType.ET_PORTAL, "ET_PORTAL"], [EntityType.ET_SPEAKER, "ET_SPEAKER"], [EntityType.ET_PUSH_TRIGGER, "ET_PUSH_TRIGGER"],
      [EntityType.ET_TELEPORT_TRIGGER, "ET_TELEPORT_TRIGGER"], [EntityType.ET_INVISIBLE, "ET_INVISIBLE"], [EntityType.ET_GRAPPLE, "ET_GRAPPLE"],
    ]);
    for (let i = 1; i < this.pool.numEntities; i++) {
      const entity = this.pool.at(i);
      if (!entity.inuse) continue;
      this.host.print(gameFormat("%3i:", [i]));
      const label = labels.get(entity.s.eType);
      this.host.print(label === undefined ? gameFormat("%3i                 ", [entity.s.eType]) : label.padEnd(20));
      if (entity.classname !== null) this.host.print(entity.classname);
      this.host.print("\n");
    }
  }

  private capability(service: ServerCommandCapability, argv: readonly string[]): void {
    if (service.kind === "unavailable") throw new Error(`${argument(argv, 0)} unavailable: ${service.reason}`);
    service.run(argv);
  }

  consoleCommand(argv: readonly string[]): boolean {
    switch (lower(argument(argv, 0))) {
      case "entitylist": this.entityList(); return true;
      case "forceteam": {
        const client = this.clientForString(argument(argv, 1));
        if (client !== null) {
          const slot = this.pool.clients.indexOf(client);
          if (slot < 0) throw new Error("Console client belongs to another entity pool");
          this.host.setTeam(this.pool.at(slot), argument(argv, 2));
        }
        return true;
      }
      case "game_memory": this.capability(this.host.memory, argv); return true;
      case "addbot": case "botlist": this.capability(this.host.bots, argv); return true;
      case "abort_podium": if (this.cvar("g_gametype").integerValue === 2) this.capability(this.host.podium, argv); return true;
      case "addip":
        if (argv.length < 2) this.host.print("Usage:  addip <ip-mask>\n");
        else this.addIP(argument(argv, 1));
        return true;
      case "removeip": this.removeIP(argv); return true;
      case "listip": this.host.executeConsoleNow("g_banIPs\n"); return true;
    }
    if (this.cvar("dedicated").integerValue === 0) return false;
    const start = lower(argument(argv, 0)) === "say" ? 1 : 0;
    this.host.sendServerCommand(-1, gameFormat('print "server: %s"', [concatCommandArgs(argv, start)]));
    return true;
  }
}
