// External stock-peer verification, not a client game/session implementation.
import { readFile, readlink } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import { SnapshotHistory } from "../src/cgame/snapshot-history.ts";
import { infoParse, tokenizeCommand } from "../src/core/text.ts";
import { UdpTransport } from "../src/platform/network.ts";
import type { Ipv4Address } from "../src/platform/network.ts";
import { encodeClientMessage } from "../src/protocol/client-message.ts";
import type { ClientMovement } from "../src/protocol/client-message.ts";
import { decodeConnectionless, encodeConnect, encodeConnectionlessText } from "../src/protocol/connectionless.ts";
import type { ConnectionlessPacket } from "../src/protocol/connectionless.ts";
import { MessageReader } from "../src/protocol/message.ts";
import type { WireUserCommand } from "../src/protocol/message.ts";
import { Netchannel, xorClientMessage, xorServerMessage } from "../src/protocol/netchan.ts";
import { ClientReliableCommands } from "../src/protocol/reliable.ts";
import { decodeServerMessage } from "../src/protocol/server-message.ts";
import type { Gamestate, Snapshot } from "../src/protocol/server-message.ts";
import type { Product } from "../src/shared/definitions.ts";
import { statSchema } from "../src/shared/definitions.ts";
import { EntityStateRecord } from "../src/shared/entity-state.ts";
import type { SourceEntityState } from "../src/shared/entity-state.ts";

export interface PeerProvenance {
  readonly executable: string;
  readonly executableSha256: string;
  readonly sourceCommit: string;
  readonly buildDescription: string;
  readonly processId: number;
  readonly arguments: readonly string[];
}

export interface PeerVerificationOptions {
  readonly address: Ipv4Address;
  readonly product: Product;
  readonly provenance: PeerProvenance;
  readonly timeoutMilliseconds?: number;
  readonly snapshots?: number;
}

interface PacketCapture { readonly direction: "send" | "receive"; readonly stage: string; readonly milliseconds: number; readonly hex: string; readonly sha256: string }
interface SnapshotCapture {
  readonly messageNumber: number; readonly deltaNumber: number; readonly serverTime: number; readonly commandTime: number;
  readonly clientNum: number; readonly pmType: number; readonly health: number; readonly weapon: number; readonly eventSequence: number;
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number };
  readonly entityCount: number;
}

function requirePeer(condition: boolean, message: string): void { if (!condition) throw new Error(`Peer verification failed: ${message}`); }
function required(info: ReadonlyMap<string, string>, key: string): string {
  const value = info.get(key);
  if (value === undefined) throw new Error(`Missing native server info ${key}`);
  return value;
}
function integer(text: string, label: string): number {
  if (!/^-?\d+$/.test(text)) throw new Error(`Invalid ${label}: ${text}`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < -2147483648 || number > 2147483647) throw new Error(`Invalid int32 ${label}`);
  return number;
}
function summary(snapshot: Snapshot): SnapshotCapture {
  const state = snapshot.playerState;
  return { messageNumber: snapshot.messageNumber, deltaNumber: snapshot.deltaNumber, serverTime: snapshot.serverTime, commandTime: state.commandTime,
    clientNum: state.clientNum, pmType: state.pmType, health: state.stats.get(statSchema(state.product).health), weapon: state.weapon, eventSequence: state.eventSequence,
    origin: { ...state.origin }, velocity: { ...state.velocity }, entityCount: snapshot.entities.length };
}

/** The caller starts the independent native process; this tool only talks to it. */
export async function runPeerVerification(options: PeerVerificationOptions) {
  const timeout = options.timeoutMilliseconds ?? 15000;
  const wanted = options.snapshots ?? 12;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) throw new RangeError("Peer timeout must be 1000..60000 milliseconds");
  if (!Number.isInteger(wanted) || wanted < 3 || wanted > 100) throw new RangeError("Peer snapshot count must be 3..100");
  if (!Number.isInteger(options.address.port) || options.address.port < 1 || options.address.port > 65535) throw new RangeError("Peer port must be 1..65535");
  if (!Number.isInteger(options.provenance.processId) || options.provenance.processId < 1
    || !/^[a-f0-9]{64}$/.test(options.provenance.executableSha256) || !/^[a-f0-9]{40}$/.test(options.provenance.sourceCommit)
    || options.provenance.buildDescription.length === 0) throw new Error("Invalid native reference provenance");
  requirePeer(options.address.host.join(".") === "127.0.0.1", "only literal127.0.0.1 is permitted");
  const interfaces = Object.keys(networkInterfaces());
  requirePeer(hostname() === "localhost" && interfaces.length === 1 && interfaces[0] === "lo", "run inside the loopback-only bwrap namespace");
  const namespace = await readlink("/proc/self/ns/net");
  const peerNamespace = await readlink(`/proc/${options.provenance.processId}/ns/net`);
  requirePeer(namespace === peerNamespace, "reference and client must share the isolated namespace");
  requirePeer(await readlink(`/proc/${options.provenance.processId}/exe`) === options.provenance.executable, "reference process executable identity");
  const nativeArguments = (await readFile(`/proc/${options.provenance.processId}/cmdline`, "utf8")).split("\0").slice(1, -1);
  requirePeer(JSON.stringify(nativeArguments) === JSON.stringify(options.provenance.arguments), "reference process options match provenance");
  const executableSha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(options.provenance.executable).arrayBuffer()).digest("hex");
  requirePeer(executableSha256 === options.provenance.executableSha256, "reference executable hash");
  const started = performance.now();
  const deadline = started + timeout;
  const captures: PacketCapture[] = [];
  const udpErrors: string[] = [];
  const commands: { sequence: number; text: string }[] = [];
  const snapshots: SnapshotCapture[] = [];
  const configs = new Map<number, string>();
  const baselines = new Map<number, SourceEntityState>();
  const history = new SnapshotHistory();
  const reliable = new ClientReliableCommands();
  const serverCommands = new Map<number, string>([[0, ""]]);
  const qport = 27184;
  const channel = new Netchannel("client", qport);
  let stage = "status";
  let challenge = 0; let messageAcknowledge = 0; let serverCommandSequence = 0; let parseEntitiesNumber = 0;
  let serverId = 0; let checksumFeed = 0; let clientNumber = -1;
  let gamestate: Gamestate | null = null;
  let fragments = 0; let dropped = 0; let sentBytes = 0; let receivedBytes = 0; let inactiveSnapshots = 0;
  let version = ""; let mapName = ""; let pureMode = -1;
  let statusInfo: ReadonlyMap<string, string> = new Map<string, string>();
  let outcome: { kind: "passed" } | { kind: "failed"; reason: string } = { kind: "failed", reason: "Not started" };
  const transport = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });

  function capture(direction: PacketCapture["direction"], bytes: Uint8Array): void {
    requirePeer(captures.length < 4096, "packet capture bound");
    captures.push({ direction, stage, milliseconds: performance.now() - started, hex: Buffer.from(bytes).toString("hex"),
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
  }
  function send(bytes: Uint8Array): void {
    requirePeer(transport.send(options.address, bytes), "UDP send accepted");
    sentBytes += bytes.length; capture("send", bytes);
  }
  async function receive(wait: number): Promise<Uint8Array | null> {
    const until = Math.min(deadline, performance.now() + wait);
    while (performance.now() < until) {
      const event = transport.poll();
      if (event === null) { await Bun.sleep(2); continue; }
      if (event.kind === "error") {
        udpErrors.push(event.error.message);
        requirePeer(stage === "status" && event.error.message.includes("ECONNREFUSED"), event.error.message);
        continue;
      }
      requirePeer(event.from.host.join(".") === "127.0.0.1" && event.from.port === options.address.port, "packet from configured native peer");
      receivedBytes += event.payload.length; capture("receive", event.payload);
      return event.payload;
    }
    return null;
  }
  async function query(request: Uint8Array, expected: string): Promise<ConnectionlessPacket> {
    while (performance.now() < deadline) {
      send(request);
      const packet = await receive(200);
      if (packet === null) continue;
      const decoded = decodeConnectionless(packet, "client");
      if (decoded.command === expected) return decoded;
      throw new Error(`Native ${decoded.command}: ${decoded.line} ${Buffer.from(decoded.payload).toString("latin1")}`);
    }
    throw new Error(`Timeout awaiting ${expected}`);
  }
  function serverCommand(sequence: number): string {
    const command = serverCommands.get(sequence);
    if (command === undefined) throw new Error(`Missing received native command ${sequence}`);
    return command;
  }
  function clientPacket(movement: ClientMovement | null): void {
    const plain = encodeClientMessage({ header: { serverId, messageAcknowledge, reliableAcknowledge: serverCommandSequence }, commands: reliable.pending(), movement }, { checksumFeed, serverCommand });
    for (const packet of channel.transmit(xorClientMessage(plain, challenge, serverCommand))) send(packet);
  }
  function accept(packet: Uint8Array): void {
    if (packet[0] === 255 && packet[1] === 255 && packet[2] === 255 && packet[3] === 255) {
      const response = decodeConnectionless(packet, "client");
      throw new Error(`Native connectionless ${response.command}: ${Buffer.from(response.payload).toString("latin1")}`);
    }
    const framed = channel.receive(packet);
    if (framed.kind === "rejected") throw new Error(`Native netchannel ${framed.reason}`);
    if ((new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0, true) & 0x80000000) !== 0) fragments++;
    if (framed.kind === "fragment") return;
    dropped += framed.dropped;
    const acknowledge = new MessageReader(framed.payload).readLong();
    const plain = xorServerMessage(framed.payload, challenge, framed.sequence, reliable.lookup(acknowledge));
    const decoded = decodeServerMessage(plain, { product: options.product, messageNumber: framed.sequence, reliableSequence: reliable.sequence,
      serverCommandSequence, parseEntitiesNumber, baseline: number => baselines.get(number) ?? null, history: number => history.readSlot(number) }, `native-sequence-${framed.sequence}`);
    requirePeer(decoded.terminal === "eof", "complete native server envelope");
    requirePeer(reliable.acknowledgeThrough(decoded.reliableAcknowledge).kind === "acknowledged", "native reliable acknowledgement");
    messageAcknowledge = framed.sequence;
    serverCommandSequence = decoded.serverCommandSequence;
    parseEntitiesNumber = decoded.parseEntitiesNumber;
    for (const operation of decoded.operations) {
      if (operation.kind === "gamestate") {
        requirePeer(gamestate === null, "no unexpected native gamestate restart");
        gamestate = operation; configs.clear(); baselines.clear(); history.clear();
        clientNumber = operation.clientNumber; checksumFeed = operation.checksumFeed;
        for (const entry of operation.entries) {
          if (entry.kind === "configstring") configs.set(entry.index, entry.value);
          else {
            const baseline = new EntityStateRecord<number>(0);
            baseline.copyFrom(entry.entity);
            baselines.set(entry.number, baseline);
          }
        }
        const systemText = configs.get(1); const serverText = configs.get(0);
        if (systemText === undefined || serverText === undefined) throw new Error("Native gamestate lacks system/server info");
        const system = infoParse(systemText, 8192); const server = infoParse(serverText, 8192);
        serverId = integer(required(system, "sv_serverid"), "sv_serverid");
        pureMode = integer(required(system, "sv_pure"), "sv_pure");
        requirePeer(pureMode === 0, "this probe does not implement pure authentication");
        requirePeer(required(server, "mapname") === mapName, "status/gamestate map agreement");
        requirePeer(baselines.size > 0 && configs.size > 10, "native configstrings and entity baselines");
      } else if (operation.kind === "command") {
        commands.push(operation); serverCommands.set(operation.sequence, operation.text);
        const tokens = tokenizeCommand(operation.text);
        if (tokens[0] === "disconnect") throw new Error(`Native disconnect: ${operation.text}`);
        if (tokens[0] === "cs") {
          const index = tokens[1]; const value = tokens[2];
          if (index === undefined || value === undefined) throw new Error("Malformed native cs command");
          configs.set(integer(index, "configstring index"), value);
        }
        if (tokens[0] === "bcs0" || tokens[0] === "bcs1" || tokens[0] === "bcs2") throw new Error("Large configstring command needs session assembly outside this probe");
      } else if (operation.kind === "snapshot") {
        requirePeer(operation.validity.kind === "valid", "native snapshot reference valid");
        if ((operation.snapshot.flags & 2) !== 0) { inactiveSnapshots++; continue; }
        requirePeer(operation.snapshot.playerState.clientNum === clientNumber, "snapshot assigned client number");
        requirePeer(history.publish(operation), "native snapshot publishes");
        snapshots.push(summary(operation.snapshot));
      } else if (operation.kind === "download") throw new Error("Download negotiation is outside this probe");
    }
  }

  try {
    const status = await query(encodeConnectionlessText("getstatus typescript-peer"), "statusResponse");
    const firstLine = Buffer.from(status.payload).toString("latin1").split("\n")[0];
    if (firstLine === undefined) throw new Error("Missing native status info");
    statusInfo = infoParse(firstLine, 8192);
    requirePeer(required(statusInfo, "protocol") === "68", "native protocol68 advertisement");
    requirePeer(required(statusInfo, "challenge") === "typescript-peer", "native status challenge echo");
    version = required(statusInfo, "version"); mapName = required(statusInfo, "mapname");
    requirePeer(version.startsWith("Q3 1.32b "), "native1.32b version advertisement");
    stage = "challenge";
    const challenged = await query(encodeConnectionlessText("getchallenge"), "challengeResponse");
    const challengeText = challenged.arguments[0];
    if (challengeText === undefined) throw new Error("Missing native challenge integer");
    challenge = integer(challengeText, "challenge");
    stage = "connect";
    const info = `\\name\\TypeScript-Probe\\rate\\25000\\snaps\\20\\model\\sarge\\handicap\\100\\protocol\\68\\qport\\${qport}\\challenge\\${challenge}`;
    await query(encodeConnect(info), "connectResponse");
    stage = "gamestate";
    while (gamestate === null && performance.now() < deadline) {
      clientPacket(null);
      const packet = await receive(100);
      if (packet !== null) accept(packet);
    }
    requirePeer(gamestate !== null, "native full gamestate received before timeout");
    stage = "movement";
    const inputs: WireUserCommand[] = [];
    let commandTime = 0; let nextSend = 0; let chatQueued = false;
    while (snapshots.length < wanted && performance.now() < deadline) {
      if (performance.now() >= nextSend) {
        const latest = history.latest;
        if (latest !== null && !chatQueued) { reliable.add("say typescript-peer-ack"); chatQueued = true; }
        commandTime = latest === null ? commandTime + 8 : Math.max(commandTime + 8, latest.serverTime + 8);
        const command: WireUserCommand = { serverTime: commandTime, angles: [0, 0, 0], weapon: 2, buttons: 16,
          forwardmove: snapshots.length >= 2 ? 64 : 0, rightmove: 0, upmove: 0 };
        inputs.push(command);
        clientPacket({ kind: latest === null ? "move-no-delta" : "move", commands: inputs.slice(-3) });
        nextSend = performance.now() + 50;
      }
      const packet = await receive(5);
      if (packet !== null) accept(packet);
    }
    requirePeer(snapshots.length >= wanted, "requested native snapshots received before timeout");
    const first = snapshots[0]; const last = snapshots[snapshots.length - 1];
    if (first === undefined || last === undefined) throw new Error("Missing snapshot evidence");
    requirePeer(first.health === 125 && first.weapon === 2 && first.pmType === 0, "native ClientSpawn source health125/machinegun/normal state");
    requirePeer(last.commandTime > first.commandTime, "native game executes keyed usercmd times");
    requirePeer(Math.hypot(last.origin.x - first.origin.x, last.origin.y - first.origin.y) > 1, "native movement changes player position");
    requirePeer(snapshots.some(snapshot => snapshot.deltaNumber > 0), "native acknowledged delta snapshots");
    requirePeer(reliable.outstanding === 0, "native acknowledged client reliable command");
    requirePeer(commands.some(command => command.text.includes("typescript-peer-ack")), "native game echoes executed reliable chat");
    requirePeer(fragments > 1, "native fragmented gamestate reassembled");
    clientPacket(null);
    outcome = { kind: "passed" };
  } catch (error) {
    outcome = { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  } finally { transport.close(); }
  return { scope: "isolated-stock-peer-protocol-probe", outcome, failedStage: outcome.kind === "failed" ? stage : null,
    provenance: options.provenance, namespace: { own: namespace, peer: peerNamespace, interfaces }, address: options.address, product: options.product,
    version, mapName, pureMode, pureHandshakeProven: false, challenge, checksumFeed, serverId, clientNumber,
    statusInfo: Object.fromEntries(statusInfo), configstrings: [...configs].map(([index, value]) => ({ index, value })),
    baselines: [...baselines].map(([number, entity]) => ({ number, eType: entity.eType, modelindex: entity.modelindex, origin: entity.pos.base })),
    packets: { sent: captures.filter(packet => packet.direction === "send").length, received: captures.filter(packet => packet.direction === "receive").length,
      sentBytes, receivedBytes, fragments, dropped }, inactiveSnapshots, udpErrors, snapshots, commands, captures };
}

function string(value: unknown, label: string): string { if (typeof value !== "string") throw new Error(`Expected ${label} string`); return value; }
function provenance(value: unknown): PeerProvenance {
  if (typeof value !== "object" || value === null || !("executable" in value) || !("executableSha256" in value) || !("sourceCommit" in value)
    || !("buildDescription" in value) || !("processId" in value) || !("arguments" in value)) throw new Error("Invalid reference provenance");
  const args: unknown = value.arguments;
  if (typeof value.processId !== "number" || !Number.isInteger(value.processId) || value.processId <= 0 || !Array.isArray(args)) throw new Error("Invalid reference process provenance");
  return { executable: string(value.executable, "executable"), executableSha256: string(value.executableSha256, "hash"), sourceCommit: string(value.sourceCommit, "commit"),
    buildDescription: string(value.buildDescription, "build"), processId: value.processId, arguments: args.map((argument: unknown) => string(argument, "reference argument")) };
}

async function main(): Promise<void> {
  let port = 27961; let product: Product = "baseq3"; let timeoutMilliseconds = 15000; let snapshots = 12;
  let provenancePath: string | null = null; let output: string | null = null;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    if (key === "--port") port = Number(value);
    else if (key === "--host") { if (value !== "127.0.0.1") throw new Error("Only isolated literal127.0.0.1 is allowed"); }
    else if (key === "--product") { if (value !== "baseq3" && value !== "missionpack") throw new Error("Invalid product"); product = value; }
    else if (key === "--timeout") timeoutMilliseconds = Number(value);
    else if (key === "--snapshots") snapshots = Number(value);
    else if (key === "--provenance") provenancePath = value;
    else if (key === "--output") output = value;
    else throw new Error(`Unknown argument ${key}`);
  }
  if (provenancePath === null || output === null) throw new Error("--provenance and --output are required");
  const data: unknown = await Bun.file(provenancePath).json();
  const report = await runPeerVerification({ address: { kind: "ipv4", host: [127, 0, 0, 1], port }, product, timeoutMilliseconds, snapshots, provenance: provenance(data) });
  await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outcome: report.outcome, packets: report.packets, version: report.version, snapshots: report.snapshots.length, output }, null, 2)}\n`);
  if (report.outcome.kind === "failed") process.exitCode = 1;
}

if (import.meta.main) await main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
