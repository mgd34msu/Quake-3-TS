import { createProtocolClientSession, transmitProtocolClient } from "./client-protocol-fixture.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { CvarRegistry } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import type { ClientSessionPacket } from "../src/engine/client-session.ts";
import { UdpTransport } from "../src/platform/network.ts";
import { decodeConnectionless, encodeConnect, encodeConnectionlessText } from "../src/protocol/connectionless.ts";
import { Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";

export interface DedicatedVerificationOptions {
  readonly command: readonly [string, ...string[]];
  readonly dataPath: string;
  readonly product: Product;
  readonly stop: "quit" | "signal";
}
export interface DedicatedVerification {
  readonly product: Product;
  readonly homePath: string;
  readonly port: number;
  readonly initialServerId: number;
  readonly fastRestartServerId: number;
  readonly fullRestartServerId: number;
  readonly gamestates: number;
  readonly snapshots: number;
  readonly lastServerMessageSequence: number;
  readonly finalPackets: number;
  readonly finalDatagrams: readonly DedicatedShutdownDatagram[];
  readonly stoppedBy: "quit" | "signal";
  readonly exitCode: number;
}

export interface DedicatedShutdownDatagram {
  readonly messageSequence: number;
  readonly snapshotMessageNumber: number;
  readonly disconnectSequence: number;
}

/** Counts only operations returned by the canonical client after channel and snapshot acceptance. */
export class DedicatedPacketObserver {
  private snapshotCount = 0;
  private shutdown: { lastDisconnect: number; readonly datagrams: DedicatedShutdownDatagram[] } | null = null;

  constructor(readonly client: EngineClientSession) {}
  get snapshots(): number { return this.snapshotCount; }
  get finalPackets(): number { return this.shutdown?.datagrams.length ?? 0; }
  get finalDatagrams(): readonly DedicatedShutdownDatagram[] {
    return this.shutdown === null ? [] : this.shutdown.datagrams.map(packet => ({ ...packet }));
  }
  beginShutdown(): void {
    if (this.shutdown !== null) throw new Error("Dedicated shutdown observation already began");
    this.shutdown = { lastDisconnect: this.client.serverCommandSequence, datagrams: [] };
  }
  async receive(bytes: Uint8Array): Promise<ClientSessionPacket> {
    const result = (await this.client.receiveDatagram(bytes));
    if (result.kind !== "accepted") return result;
    let snapshotMessageNumber: number | null = null, disconnectSequence: number | null = null;
    for (const operation of result.message.operations) {
      if (operation.kind === "snapshot" && operation.validity.kind === "valid") {
        this.snapshotCount++; snapshotMessageNumber = operation.snapshot.messageNumber;
      }
      if (this.shutdown !== null && operation.kind === "command" && operation.text === "disconnect"
        && operation.sequence > this.shutdown.lastDisconnect) {
        this.shutdown.lastDisconnect = operation.sequence; disconnectSequence = operation.sequence;
      }
    }
    if (this.shutdown !== null && snapshotMessageNumber !== null && disconnectSequence !== null) {
      this.shutdown.datagrams.push({ messageSequence: result.sequence, snapshotMessageNumber, disconnectSequence });
    }
    return result;
  }
}

function requireCondition(condition: boolean, message: string): void { if (!condition) throw new Error(message); }
async function collect(reader: ReadableStreamDefaultReader<Uint8Array>, append: (text: string) => undefined): Promise<void> {
  while (true) { const chunk = await reader.read(); if (chunk.done) return; append(Buffer.from(chunk.value).toString("latin1")); }
}

interface VerificationPhase { readonly label: string; readonly expiresAt: number }

/** Drives the shipping server command as a real external UDP client; no server method is called. */
export async function verifyDedicatedServer(options: DedicatedVerificationOptions): Promise<DedicatedVerification> {
  const homePath = mkdtempSync(join(tmpdir(), "q3-dedicated-verifier-"));
  const reserved = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 }), target = reserved.address; reserved.close();
  const map = options.product === "baseq3" ? "q3dm1" : "mpteam1", nextMap = options.product === "baseq3" ? "q3dm2" : "mpteam2";
  const child = Bun.spawn([...options.command, "server", "--data", options.dataPath, "--home", homePath, "--product", options.product, "--",
    "+set", "dedicated", "1", "+set", "net_ip", "127.0.0.1", "+set", "net_port", String(target.port),
    "+set", "bot_enable", "0", "+set", "sv_pure", "0", "+set", "sv_maxclients", "2", "+set", "logfile", "2",
    "+map", map, "+echo", "__DEDICATED_READY__"], { stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, QUAKE_SDL2_LIBRARY: join(homePath, "not-an-sdl-library.so") } });
  let stdout = "", stderr = "", stdoutFinished = false, stderrFinished = false;
  const stdoutReader = child.stdout.getReader(), stderrReader = child.stderr.getReader();
  const stdoutDone = collect(stdoutReader, text => { stdout += text; }).then(() => ({ kind: "success" } satisfies { kind: "success" }),
    (error: unknown) => ({ kind: "failure", error } satisfies { kind: "failure"; error: unknown })).finally(() => { stdoutFinished = true; });
  const stderrDone = collect(stderrReader, text => { stderr += text; }).then(() => ({ kind: "success" } satisfies { kind: "success" }),
    (error: unknown) => ({ kind: "failure", error } satisfies { kind: "failure"; error: unknown })).finally(() => { stderrFinished = true; });
  let peer: UdpTransport | null = null;
  let failure: { readonly error: unknown } | null = null;
  function phase(label: string, milliseconds = 15000): VerificationPhase { return { label, expiresAt: performance.now() + milliseconds }; }
  function check(current: VerificationPhase, allowExit = false): void {
    if (performance.now() >= current.expiresAt) throw new Error(`Timed out waiting for ${current.label}: ${stderr}\n${stdout}`);
    if (!allowExit && child.exitCode !== null) throw new Error(`Dedicated process exited before ${current.label}: ${stderr}\n${stdout}`);
  }
  async function until(predicate: () => boolean, current: VerificationPhase, allowExit = false): Promise<void> {
    while (true) {
      check(current, allowExit);
      if (predicate()) return;
      await Bun.sleep(1);
    }
  }
  function poll(socket: UdpTransport): Uint8Array | null {
    const packet = socket.poll();
    if (packet === null) return null;
    if (packet.kind === "error") throw packet.error;
    requireCondition(packet.from.host.every((octet, index) => octet === target.host[index]) && packet.from.port === target.port,
      "Dedicated verifier received an unexpected external sender");
    return packet.payload;
  }
  async function receive(socket: UdpTransport, current: VerificationPhase): Promise<Uint8Array> {
    await until(() => socket.statistics.pending > 0, current);
    check(current);
    const packet = poll(socket);
    if (packet === null) throw new Error("Dedicated verifier lost its owned UDP packet");
    return packet;
  }
  function transmit(socket: UdpTransport, client: EngineClientSession, current: VerificationPhase): void {
    check(current);
    for (const packet of transmitProtocolClient(client, Math.trunc(performance.now()) | 0, 0, true)) {
      check(current); requireCondition(socket.send(target, packet), "Could not queue client UDP packet");
    }
  }
  function commands(client: EngineClientSession, current: VerificationPhase): void {
    check(current);
    while (client.lastExecutedServerCommand < client.serverCommandSequence) {
      check(current); client.getServerCommand(client.lastExecutedServerCommand + 1);
    }
  }
  async function acquireSnapshot(socket: UdpTransport, observer: DedicatedPacketObserver, after: number, current: VerificationPhase): Promise<void> {
    check(current);
    while (observer.client.snapshots.current().number <= after) {
      (await observer.receive(await receive(socket, current))); check(current);
    }
    commands(observer.client, current);
  }
  async function prime(socket: UdpTransport, observer: DedicatedPacketObserver, current: VerificationPhase): Promise<void> {
    const client = observer.client;
    // This verifies protocol priming, not a claimed cgame/media initialization.
    await acquireSnapshot(socket, observer, 0, current);
    client.prime(client.gamestateGeneration); client.setUserCmdValue(Weapon.WP_MACHINEGUN, 1);
    client.createUserCommand({ serverTime: client.snapshots.current().serverTime, viewAngles: vec3(0, 0, 0), buttons: 0,
      forwardmove: 0, rightmove: 0, upmove: 0 });
    transmit(socket, client, current);
    await acquireSnapshot(socket, observer, client.snapshots.current().number, current);
  }
  function consoleCommand(text: string): void { child.stdin.write(`${text}\n`); }
  try {
    await until(() => stdout.includes("__DEDICATED_READY__ \n"), phase("source startup ready command"));
    requireCondition(stdout.includes(`Opening IP socket: 127.0.0.1:${target.port}\n`), "Dedicated verifier did not bind its selected localhost port");
    peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    const admission = phase("challenge/connect admission");
    peer.send(target, encodeConnectionlessText("getchallenge"));
    const challengeResponse = decodeConnectionless(await receive(peer, admission), "client"), challengeText = challengeResponse.arguments[0];
    if (challengeResponse.command !== "challengeResponse" || challengeText === undefined || !/^-?\d+$/.test(challengeText)) throw new Error("Invalid actual challenge response");
    const challenge = Number(challengeText), qport = peer.address.port;
    peer.send(target, encodeConnect(`\\protocol\\68\\qport\\${qport}\\challenge\\${challenge}\\name\\ExecutablePeer\\rate\\25000\\snaps\\20`));
    requireCondition(decodeConnectionless(await receive(peer, admission), "client").command === "connectResponse", "Missing actual connectResponse");
    const client = createProtocolClientSession({ product: options.product, cvars: new CvarRegistry(), mode: { kind: "network", challenge, qport } });
    const observer = new DedicatedPacketObserver(client);
    const initialGamestate = phase("initial gamestate");
    transmit(peer, client, initialGamestate);
    while (client.gamestateGeneration === 0) { (await observer.receive(await receive(peer, initialGamestate))); check(initialGamestate); }
    await prime(peer, observer, phase("initial client priming"));
    const initialServerId = client.serverId, initial = client.snapshots.read(client.snapshots.current().number);
    if (initial === null) throw new Error("Missing initial actual player snapshot");
    const movement = phase("horizontal movement progress");
    for (let index = 0; index < 4; index++) {
      check(movement);
      const before = client.snapshots.current();
      client.createUserCommand({ serverTime: before.serverTime + 50, viewAngles: vec3(0, 0, 0), buttons: 0,
        forwardmove: 127, rightmove: 0, upmove: 0 });
      transmit(peer, client, movement); await acquireSnapshot(peer, observer, before.number, movement);
    }
    const moved = client.snapshots.read(client.snapshots.current().number);
    requireCondition(moved !== null && (moved.playerState.origin.x !== initial.playerState.origin.x
      || moved.playerState.origin.y !== initial.playerState.origin.y), "Actual usercmd did not move the protocol player horizontally");
    const generation = client.gamestateGeneration;
    const fastRestart = phase("fast restart server ID");
    consoleCommand("map_restart 0");
    while (client.serverId === initialServerId) await acquireSnapshot(peer, observer, client.snapshots.current().number, fastRestart);
    check(fastRestart);
    const fastRestartServerId = client.serverId;
    requireCondition(client.gamestateGeneration === generation, "Fast restart unexpectedly replaced the gamestate");
    const fullMap = phase("full map gamestate and priming");
    consoleCommand(`map ${nextMap}`);
    while (client.gamestateGeneration === generation) {
      transmit(peer, client, fullMap); (await observer.receive(await receive(peer, fullMap))); check(fullMap);
      if (client.gamestateGeneration === generation) commands(client, fullMap);
    }
    const fullRestartServerId = client.serverId;
    requireCondition(fullRestartServerId !== fastRestartServerId, "Full spawn did not replace source serverId");
    await prime(peer, observer, fullMap);
    const archive = phase("archive persistence and pre-shutdown drain");
    consoleCommand("seta verifier_saved old; set verifier_saved persisted; echo __ARCHIVE_CHANGED__");
    await until(() => stdout.includes("__ARCHIVE_CHANGED__ \n"), archive);
    await acquireSnapshot(peer, observer, client.snapshots.current().number, archive);
    requireCondition(readFileSync(join(homePath, options.product, "q3config.cfg"), "latin1").includes('seta verifier_saved "persisted"'), "Common frame did not persist actual archived configuration");
    // Drain existing snapshots first, then count the source shutdown command passes.
    while (peer.statistics.pending > 0) { (await observer.receive(await receive(peer, archive))); commands(client, archive); }
    check(archive);
    observer.beginShutdown();
    const exiting = phase("graceful process exit and output completion");
    if (options.stop === "signal") child.kill("SIGTERM");
    else consoleCommand("quit; echo __MUST_NOT_RUN__");
    child.stdin.end();
    await until(() => child.exitCode !== null && stdoutFinished && stderrFinished, exiting, true);
    const exitCode = await child.exited;
    const outputs = await Promise.all([stdoutDone, stderrDone]);
    for (const output of outputs) if (output.kind === "failure") throw output.error;
    requireCondition(exitCode === 0, `Dedicated process failed: ${stderr}`);
    const shutdown = phase("both final server packet passes", 2000);
    while (true) {
      check(shutdown, true);
      if (observer.finalPackets >= 2) break;
      const packet = poll(peer);
      if (packet === null) await Bun.sleep(1);
      else (await observer.receive(packet));
    }
    requireCondition(!stdout.includes("__MUST_NOT_RUN__"), "Quit did not stop its current command drain");
    const log = readFileSync(join(homePath, options.product, "qconsole.log"), "latin1");
    requireCondition((log.match(/logfile opened on /g)?.length ?? 0) === 1, "Common log ownership did not survive map replacement");
    requireCondition(readFileSync(join(homePath, options.product, "games.log"), "latin1").includes("ShutdownGame:"), "Actual game log did not close its session");
    const rebound = await UdpTransport.bind(target); rebound.close();
    return { product: options.product, homePath, port: target.port, initialServerId, fastRestartServerId, fullRestartServerId,
      gamestates: client.gamestateGeneration, snapshots: observer.snapshots, lastServerMessageSequence: client.serverMessageSequence,
      finalPackets: observer.finalPackets, finalDatagrams: observer.finalDatagrams, stoppedBy: options.stop, exitCode };
  } catch (error) { failure = { error }; throw error; }
  finally {
    const cleanupErrors: unknown[] = [];
    try { peer?.close(); } catch (error) { cleanupErrors.push(error); }
    try {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(2000).then(() => false)]);
        if (!exited) { child.kill("SIGKILL"); await child.exited; }
      }
    } catch (error) { cleanupErrors.push(error); }
    if (failure !== null) {
      if (!stdoutFinished) try { await stdoutReader.cancel(); } catch (error) { cleanupErrors.push(error); }
      if (!stderrFinished) try { await stderrReader.cancel(); } catch (error) { cleanupErrors.push(error); }
    }
    await Promise.all([stdoutDone, stderrDone]);
    try { stdoutReader.releaseLock(); } catch (error) { cleanupErrors.push(error); }
    try { stderrReader.releaseLock(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length !== 0) {
      if (failure === null) throw new AggregateError(cleanupErrors, "Dedicated verifier cleanup failed");
      const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
      throw new AggregateError([failure.error, ...cleanupErrors], `${message}; dedicated verifier cleanup also failed`, { cause: failure.error });
    }
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), options: { data: { type: "string" }, product: { type: "string", default: "baseq3" },
      executable: { type: "string" }, entry: { type: "string" }, signal: { type: "boolean", default: false } } });
    if (values.data === undefined) throw new Error("Pass --data with the read-only retail data directory");
    if (values.product !== "baseq3" && values.product !== "missionpack") throw new Error("Product must be baseq3 or missionpack");
    if (values.executable !== undefined && values.entry !== undefined) throw new Error("Select either --entry TypeScript or --executable, not both");
    const command: readonly [string, ...string[]] = values.executable === undefined
      ? [process.execPath, resolve(values.entry ?? join(import.meta.dir, "../src/main.ts"))] : [resolve(values.executable)];
    const result = await verifyDedicatedServer({ command, dataPath: resolve(values.data), product: values.product, stop: values.signal ? "signal" : "quit" });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
