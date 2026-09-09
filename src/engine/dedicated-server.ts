// Dedicated composition root for the common.c driver and null_client.c profile.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { VfsSearchOptions } from "../assets/vfs.ts";
import { DedicatedEventSource } from "../platform/dedicated-input.ts";
import { UnixSystemClock } from "../platform/system-clock.ts";
import type { SystemClock } from "../platform/system-clock.ts";
import { UnixIo } from "../platform/unix-io.ts";
import type { UnixIoOptions } from "../platform/unix-io.ts";
import { CommonFrameDriver } from "./common-frame.ts";
import type { CommonExit, CommonFrameOutcome, CommonRunLimit } from "./common-frame.ts";
import { ServerEngine } from "./server-engine.ts";
import type { ServerBotCapability } from "./server-engine.ts";

export interface DedicatedHostOptions {
  readonly roots: VfsSearchOptions;
  readonly startupText: string;
  readonly buildDate: string;
  readonly print: (text: string) => undefined;
  readonly bots: ServerBotCapability;
  readonly input?: UnixIoOptions;
  readonly systemClock?: SystemClock;
}

export type DedicatedRunLimit = CommonRunLimit;
export type DedicatedExit = CommonExit;

export class DedicatedServerHost {
  private constructor(readonly driver: CommonFrameDriver, readonly server: ServerEngine) {}

  static async open(options: DedicatedHostOptions): Promise<DedicatedServerHost> {
    let unix: UnixIo | null = null;
    let server: ServerEngine | null = null;
    const clock = options.systemClock ?? new UnixSystemClock();
    let driver: CommonFrameDriver;
    driver = await CommonFrameDriver.open({
      roots: options.roots,
      startupText: options.startupText,
      buildDate: options.buildDate,
      build: { kind: "dedicated" },
      platformPrint: text => {
        if (unix === null) options.print(text);
        else unix.withConsoleOutput(() => options.print(text));
      },
      client: { kind: "absent" },
      systemClock: clock,
      createPlatform: (print, eventMemory) => {
        const created = new UnixIo(print, clock, options.input, eventMemory);
        const eventSource = new DedicatedEventSource(created);
        unix = created;
        return {
          getEvent: () => eventSource.getEvent(),
          yieldToIo: () => created.yieldToIo(),
          showConsole: () => undefined,
          initialize: async cvars => {
            await created.initializeNetwork(cvars); created.initializeConsole(cvars); created.initializeSignals(null);
          },
          close: () => { created.close(); },
        };
      },
      createServer: services => {
        const createdUnix = unix;
        if (createdUnix === null) throw new Error("Dedicated platform must exist before server construction");
        createdUnix.bindConsoleCompletion(field => {
          field.complete(services.common.commands, services.common.cvars, text => { services.common.output.print(text); });
        });
        const created = ServerEngine.create({ common: services.common, buildDate: options.buildDate, clock: services.events,
          random: services.random, bots: options.bots, clientLifecycle: { kind: "absent" },
          network: { loopback: services.loopback, get udp() { return createdUnix.udp; }, get lan() { return createdUnix.lan; },
            resolveAddress: (hostname, port) => createdUnix.resolveAddress(hostname, port),
            sleep: milliseconds => createdUnix.sleepUntilInput(milliseconds) } });
        server = created;
        services.deferCleanup(() => created.disposeResources());
        return created;
      },
      resolveCommand: (_lookup, fallbacks) => fallbacks.server,
    });
    if (server === null) { await driver.close(); throw new Error("Common driver completed without dedicated server ownership"); }
    return new DedicatedServerHost(driver, server);
  }

  get common() { return this.driver.common; }
  get events() { return this.driver.events; }

  frame(): Promise<CommonFrameOutcome> { return this.driver.frame(); }
  run(limit: DedicatedRunLimit): Promise<DedicatedExit> { return this.driver.run(limit); }
  close(): Promise<void> { return this.driver.close(); }
}
