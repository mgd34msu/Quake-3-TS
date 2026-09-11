// Graphical composition for id Software's common.c and client/cl_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { VfsSearchOptions } from "../assets/vfs.ts";
import { DedicatedEventSource } from "../platform/dedicated-input.ts";
import { GraphicalEventSource } from "../platform/graphical-input.ts";
import type { SdlGameInput } from "../platform/sdl-game-input.ts";
import { UnixSystemClock } from "../platform/system-clock.ts";
import type { SystemClock } from "../platform/system-clock.ts";
import { UnixIo } from "../platform/unix-io.ts";
import type { UnixIoOptions } from "../platform/unix-io.ts";
import { EngineClient } from "./client.ts";
import type { EngineClientOptions } from "./client.ts";
import type { CommonEventSource } from "./common-events.ts";
import { CommonFrameDriver } from "./common-frame.ts";
import type { CommonExit, CommonFrameOutcome, CommonRunLimit } from "./common-frame.ts";
import { ServerEngine } from "./server-engine.ts";
import type { ServerBotCapability } from "./server-engine.ts";

export interface ClientHostOptions {
  readonly roots: VfsSearchOptions;
  readonly startupText: string;
  readonly buildDate: string;
  readonly print: (text: string) => undefined;
  readonly bots: ServerBotCapability;
  readonly video: Pick<EngineClientOptions, "renderer" | "width" | "height" | "hidden">;
  readonly sound: EngineClientOptions["sound"];
  readonly input?: UnixIoOptions;
  readonly systemClock?: SystemClock;
}

/** Client and listen server share common clocks, commands, files and transports. */
export class ClientHost {
  private constructor(readonly driver: CommonFrameDriver, readonly client: EngineClient, readonly server: ServerEngine) {}

  static async open(options: ClientHostOptions): Promise<ClientHost> {
    const clock = options.systemClock ?? new UnixSystemClock();
    let unix: UnixIo | null = null, server: ServerEngine | null = null;
    let driver: CommonFrameDriver, client: EngineClient;
    client = new EngineClient({ ...options.video, sound: options.sound, buildDate: options.buildDate, systemClock: clock });
    driver = await CommonFrameDriver.open({
      roots: options.roots, startupText: options.startupText, buildDate: options.buildDate,
      build: { kind: "client", client }, client: { kind: "available", runtime: client },
      platformPrint: text => {
        if (unix === null) options.print(text);
        else unix.withConsoleOutput(() => options.print(text));
      },
      systemClock: clock,
      createPlatform: (print, eventMemory) => {
        const created = new UnixIo(print, clock, options.input, eventMemory);
        unix = created;
        const beforeWindow = new DedicatedEventSource(created);
        let sourceInput: SdlGameInput | null = null;
        let source: CommonEventSource = beforeWindow;
        return {
          getEvent: () => {
            const input = client.input;
            if (input === null) {
              const systemInput = client.systemInput;
              if (systemInput === null) return beforeWindow.getEvent();
              const queued = created.takeQueuedEvent();
              if (queued !== null) return queued;
              created.pollConsoleEvent();
              systemInput.joystickFrame((key, down, time) => { created.queueEvent({ kind: "key", key, down, time }); },
                (dx, dy, time) => { created.queueEvent({ kind: "mouse", dx, dy, time }); });
              client.pollMidiInput(created);
              created.pollPacketEvent();
              return created.takeQueuedEvent() ?? created.noneEvent();
            }
            if (sourceInput !== input) { sourceInput = input; source = new GraphicalEventSource(created, input, () => client.pollMidiInput(created)); }
            return source.getEvent();
          },
          yieldToIo: () => created.yieldToIo(),
          showConsole: () => undefined,
          initialize: async cvars => { await created.initializeNetwork(cvars); created.initializeConsole(cvars); },
          close: () => { created.close(); },
        };
      },
      createServer: services => {
        const createdUnix = unix;
        if (createdUnix === null) throw new Error("Client platform must exist before server construction");
        services.common.commands.registerAsync("net_restart", async () => {
          services.assertCurrentOperation();
          await createdUnix.restartNetwork(services.common.cvars);
          services.assertCurrentOperation();
        });
        createdUnix.bindConsoleCompletion(field => {
          field.complete(services.common.commands, services.common.cvars, text => { services.common.output.print(text); });
        });
        const created = ServerEngine.create({ common: services.common, buildDate: options.buildDate, clock: services.events,
          random: services.random, bots: options.bots,
          clientLifecycle: { kind: "available", mapLoading: () => client.mapLoading(),
            shutdownAllForServerMap: () => client.shutdownAllForServerMap(),
            disconnectAfterServerShutdown: () => client.disconnectAfterServerShutdown() },
          network: { loopback: services.loopback, get udp() { return createdUnix.udp; }, get lan() { return createdUnix.lan; },
            resolveAddress: (hostname, port) => createdUnix.resolveAddress(hostname, port),
            sleep: milliseconds => createdUnix.sleepUntilInput(milliseconds) } });
        server = created;
        services.deferCleanup(() => created.disposeResources());
        client.bind({ common: services.common, events: services.events, io: createdUnix, loopback: services.loopback, server: created,
          runRendererCallback: services.runRendererCallback,
          assertCurrentOperation: services.assertCurrentOperation, pumpForDownloadsComplete: services.pumpForDownloadsComplete });
        return created;
      },
      resolveCommand: (lookup, fallbacks) => client.resolveCommand(lookup, fallbacks),
    });
    if (server === null) { await driver.close(); throw new Error("Common driver completed without client server ownership"); }
    return new ClientHost(driver, client, server);
  }

  get common() { return this.driver.common; }
  frame(): Promise<CommonFrameOutcome> { return this.driver.frame(); }
  run(limit: CommonRunLimit): Promise<CommonExit> { return this.driver.run(limit); }
  close(): Promise<void> { return this.driver.close(); }
}
