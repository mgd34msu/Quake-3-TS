// Source cl_parse.c -> CL_InitDownloads/CL_DownloadsComplete -> Com_Error unwinding.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonError } from "../src/core/common-error.ts";
import type { CommonErrorCode } from "../src/core/common-error.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { EngineClientSession, ClientSessionError } from "../src/engine/client-session.ts";
import { CommonFrameDriver } from "../src/engine/common-frame.ts";
import type { CommonClientRuntime } from "../src/engine/common-frame.ts";
import type { CommonSystemEvent } from "../src/engine/common-events.ts";
import { ServerEngine } from "../src/engine/server-engine.ts";
import { LanAddresses } from "../src/platform/lan.ts";
import { Netchannel, xorServerMessage } from "../src/protocol/netchan.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";

type Route = "plaintext" | "datagram";
type Rejection = { readonly kind: "rejected"; readonly error: unknown } | { readonly kind: "resolved" };
async function observe(pending: Promise<unknown>): Promise<Rejection> {
  try { await pending; return { kind: "resolved" }; } catch (error) { return { kind: "rejected", error }; }
}
function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve: () => { if (resolve === undefined) throw new Error("Missing gate resolver"); resolve(); } };
}
class ControlledLifecycle extends ProtocolClientLifecycle {
  afterGamestate: (generation: number) => Promise<void> = async () => undefined;
  guardFailure: CommonError | null = null;
  override assertCurrentOperation(): void {
    super.assertCurrentOperation();
    const error = this.guardFailure;
    if (error !== null) { this.guardFailure = null; throw error; }
  }
  override async gamestateReceived(generation: number): Promise<void> {
    await super.gamestateReceived(generation);
    await this.afterGamestate(generation);
  }
}
function fixture(product: Product, route: Route) {
  const cvars = new CvarRegistry(), lifecycle = new ControlledLifecycle(cvars);
  const challenge = 0x1234567, peer = new Netchannel("server", 27961);
  const session = new EngineClientSession({ product, cvars, lifecycle, mode: { kind: "network", challenge, qport: 27961 } });
  cvars.set("cl_paused", "1", true);
  const pauseBefore = cvars.get("cl_paused");
  const baseline = new EntityState(); baseline.number = 42; baseline.modelindex = 7;
  function payload(sequence: number, gamestate: boolean): Uint8Array {
    return encodeServerMessage(0, gamestate ? [
      { kind: "gamestate", commandSequence: 10, clientNumber: 3, checksumFeed: 123,
        entries: [{ kind: "configstring", index: 0, value: "partial gamestate" },
          { kind: "configstring", index: 1, value: `\\sv_serverid\\456\\sv_cheats\\1\\fs_game\\${product === "missionpack" ? "missionpack" : ""}` },
          { kind: "baseline", number: 42, entity: baseline }] },
      { kind: "command", sequence: 11, text: "echo unreachable tail" },
    ] : [{ kind: "nop" }], { product, messageNumber: sequence, reliableSequence: 0, serverCommandSequence: 0,
      parseEntitiesNumber: 0, baseline: () => null, history: () => null });
  }
  function datagram(sequence: number, gamestate = true): Uint8Array {
    const packets = peer.transmit(xorServerMessage(payload(sequence, gamestate), challenge, sequence, ""));
    expect(packets.length).toBe(1);
    const packet = packets[0]; if (packet === undefined) throw new Error("Missing source channel packet"); return packet;
  }
  async function receive(sequence = 1, gamestate = true): Promise<unknown> {
    if (route === "plaintext") return session.receiveServerMessage(sequence, payload(sequence, gamestate));
    return session.receiveDatagram(datagram(sequence, gamestate));
  }
  function partial(): void {
    expect(session.serverMessageSequence).toBe(1); expect(session.gamestateGeneration).toBe(1);
    expect(session.serverCommandSequence).toBe(10); expect(session.lastExecutedServerCommand).toBe(0);
    expect(session.clientNumber).toBe(3); expect(session.checksumFeed).toBe(123); expect(session.serverId).toBe(456);
    expect(session.getGameState()[0]).toBe("partial gamestate"); expect(session.commands.currentNumber).toBe(0);
    expect(cvars.get("cl_paused")).toEqual(pauseBefore);
    expect(session.pendingEvents.map(event => event.kind)).toEqual(["close-console", "clear-active-state", "gamestate"]);
    expect(session.dropped).toBeNull();
  }
  return { cvars, lifecycle, session, receive, partial, datagram };
}

describe("client parser preserves source common control", () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    for (const route of ["plaintext", "datagram"] satisfies readonly Route[]) {
      for (const code of ["server-disconnect", "drop", "disconnect", "need-cd", "fatal"] satisfies readonly CommonErrorCode[]) {
        for (const timing of ["immediate", "deferred", "post-await-guard"] satisfies readonly string[]) {
          test(`${product}/${route}/${code}/${timing}: exact identity and source partial state`, async () => {
            const f = fixture(product, route), original = new CommonError(code, `selected ${code}`);
            const entered = deferred(), gate = deferred();
            f.lifecycle.afterGamestate = async () => {
              f.partial(); entered.resolve();
              if (timing !== "immediate") await gate.promise;
              if (timing === "post-await-guard") f.lifecycle.guardFailure = original;
              else throw original;
            };
            const pending = observe(f.receive()); await entered.promise;
            f.partial(); gate.resolve();
            const result = await pending;
            expect(result.kind).toBe("rejected");
            if (result.kind !== "rejected") throw new Error("Common control returned normally");
            expect(result.error).toBe(original); f.partial();
            await f.receive(2, false); expect(f.session.serverMessageSequence).toBe(2); expect(f.session.dropped).toBeNull();
          });
        }
      }
      for (const control of ["ordinary-error", "client-error", "null", "undefined"] satisfies readonly string[]) {
        test(`${product}/${route}: preserves existing ${control} policy`, async () => {
          const f = fixture(product, route);
          const original = control === "ordinary-error" ? new Error("ordinary callback")
            : control === "client-error" ? new ClientSessionError("unsupported", "client callback")
              : control === "null" ? null : undefined;
          f.lifecycle.afterGamestate = async () => { throw original; };
          const result = await observe(f.receive());
          expect(result.kind).toBe("rejected");
          if (result.kind !== "rejected") throw new Error("Expected callback rejection");
          if (control === "ordinary-error") {
            expect(result.error).toBeInstanceOf(ClientSessionError);
            if (!(result.error instanceof ClientSessionError)) throw new Error("Missing existing parser drop");
            expect(result.error.kind).toBe("drop"); expect(result.error.message).toBe("ordinary callback");
            expect(f.session.dropped).toBe(result.error);
            expect(f.session.pendingEvents.filter(event => event.kind === "disconnect")).toEqual([
              { kind: "disconnect", errorKind: "drop", reason: "ordinary callback" },
            ]);
          } else { expect(result.error).toBe(original); f.partial(); }
        });
      }
    }
    test(`${product}: common driver dispatches gamestate control without parser drop conversion`, async () => {
      const f = fixture(product, "datagram"), selected = new CommonError("disconnect", "gamestate source control");
      f.lifecycle.afterGamestate = async () => { throw selected; };
      const home = mkdtempSync(join(tmpdir(), "q3-session-control-")), dataPath = join(home, "data");
      mkdirSync(join(dataPath, "baseq3"), { recursive: true }); writeFileSync(join(dataPath, "baseq3", "default.cfg"), "\n");
      writeFileSync(join(dataPath, "baseq3", "productid.txt"), SOURCE_PRODUCT_ID);
      const trace: string[] = [], events: CommonSystemEvent[] = []; let time = 1000, closed = false;
      const client: CommonClientRuntime = {
        initializeInput: () => { trace.push("input-init"); }, restartInput: () => { trace.push("input-restart"); },
        frameTimings: { frontEndMsec: 0, backEndMsec: 0 },
        needCd: { kind: "absent" }, initialize: async () => {}, shutdown: async () => { trace.push("shutdown"); },
        disposeResources: async () => { trace.push("dispose"); }, frame: async () => {},
        packetEvent: async (_from, bytes) => { await f.session.receiveDatagram(bytes); },
        keyEvent: async () => {}, characterEvent: async () => {}, mouseEvent: async () => {}, joystickEvent: async () => {},
        disconnect: async show => { trace.push(`disconnect:${show}`); }, flushMemory: async () => { trace.push("flush"); },
        queueDefaultStartup: () => {}, startHunkUsers: async () => {},
      };
      let driver: CommonFrameDriver | undefined;
      try {
        driver = await CommonFrameDriver.open({ roots: { product, dataPath, homePath: join(home, "home"), cdPath: null },
          startupText: "+set dedicated 1", buildDate: "session-control", build: { kind: "client", client: {
            initializeKeyCommands: () => {}, writeBindings: () => {}, consolePrint: () => {}, usesUniqueKey: () => 0,
          } }, platformPrint: () => {}, client: { kind: "available", runtime: client },
          systemClock: { milliseconds: () => time }, createPlatform: () => ({
            getEvent: () => events.shift() ?? { kind: "none", time: ++time }, yieldToIo: async () => {}, showConsole: () => {},
            initialize: async () => {}, close: () => { closed = true; },
          }), createServer: services => ServerEngine.create({ common: services.common, buildDate: "session-control",
            clock: services.events, random: services.random, network: { loopback: services.loopback, udp: null,
              lan: new LanAddresses([]), resolveAddress: async () => null, sleep: async () => {} },
            bots: { kind: "unavailable", reason: "No bot composition in parser-control fixture" },
            clientLifecycle: { kind: "absent" } }),
          resolveCommand: (_lookup, fallbacks) => fallbacks.server,
        });
        events.push({ kind: "packet", time, from: { kind: "ipv4", host: [127, 0, 0, 1], port: 27960 }, payload: f.datagram(1) });
        expect(await driver.frame()).toEqual({ kind: "aborted", frameNumber: 0, code: "disconnect", message: selected.message });
        expect(trace).toEqual(["input-init", "disconnect:true", "flush"]); expect(closed).toBe(false); f.partial();
        expect((await driver.frame()).kind).toBe("frame");
      } finally { try { await driver?.close(); } finally { rmSync(home, { recursive: true }); } }
    });
  }
});
