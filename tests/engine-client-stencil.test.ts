import { expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CvarFlag } from "../src/core/cvar.ts";
import { ClientHost } from "../src/engine/client-host.ts";
import { RendererConfiguration } from "../src/render/configuration.ts";
import type { RendererConfigurationSnapshot } from "../src/render/configuration.ts";

const dataPath = process.env["Q3_DATA"];

async function open(renderer: "cpu" | "gl", stencil: string | null, stdin: PassThrough): Promise<ClientHost> {
  if (dataPath === undefined) throw new Error("Q3_DATA is required for the client stencil probe");
  return ClientHost.open({
    roots: { dataPath, homePath: await mkdtemp(join(tmpdir(), "quake3-client-stencil-")), cdPath: null, product: "baseq3" },
    startupText: "+set net_ip 127.0.0.1 +set net_port 0 +set cl_motd 0 +set s_initsound 0 +set bot_enable 0 +set cg_shadows 2"
      + (stencil === null ? "" : ` +set r_stencilbits ${stencil}`) + " +echo stencil-client-probe",
    buildDate: "stencil-client-probe", print: () => undefined,
    bots: { kind: "unavailable", reason: "Renderer lifecycle probe does not use bots" },
    video: { renderer, width: 320, height: 240, hidden: true }, sound: { sampleRate: 48000 },
    input: { stdin, signals: "none" },
  });
}

for (const renderer of ["cpu", "gl"] satisfies readonly ("cpu" | "gl")[]) {
  test.skipIf(dataPath === undefined || (renderer === "gl" && process.env["QUAKE_GL_TEST"] !== "1"))(
    `actual ${renderer} client applies latched stencil precision at vid_restart and reports the backend`, async () => {
      const configurations: RendererConfigurationSnapshot[] = [], backendBits: number[] = [];
      const createConfiguration = RendererConfiguration.beginInitialization;
      const configurationSpy = spyOn(RendererConfiguration, "beginInitialization").mockImplementation(options => {
        const configuration = createConfiguration(options);
        configurations.push(configuration.copy());
        backendBits.push(options.renderer.backend.stencilBits);
        return configuration;
      });
      const stdin = new PassThrough();
      let host: ClientHost | null = null;
      try {
        host = await open(renderer, null, stdin);
        const current = host;
        async function frame(): Promise<void> {
          const result = await current.frame();
          if (result.kind !== "frame") throw new Error(`Client frame failed: ${JSON.stringify(result)}`);
        }
        await frame();
        expect(configurations).toHaveLength(1);
        expect(current.common.cvars.get("r_stencilbits")?.value).toBe("0");
        expect(current.common.cvars.get("r_stencilbits")?.flags).toBe(CvarFlag.Archive | CvarFlag.Latch);
        current.common.commands.registerAsync("stencil_flush", () => current.client.flushMemory());
        for (const value of ["8.9", "0"]) {
          let before = configurations.length;
          const prior = current.common.cvars.get("r_stencilbits")?.value;
          current.common.commands.append(`set r_stencilbits ${value}\n`);
          await frame();
          expect(current.common.cvars.get("r_stencilbits")?.value).toBe(prior);
          expect(current.common.cvars.get("r_stencilbits")?.latchedValue).toBe(value);
          expect(configurations).toHaveLength(before);
          if (value === "8.9") {
            current.common.commands.append("stencil_flush\n");
            await frame();
            expect(configurations).toHaveLength(++before);
            expect(backendBits.at(-1)).toBe(backendBits[0]);
            expect(current.common.cvars.get("r_stencilbits")?.value).toBe(value);
            expect(current.common.cvars.get("r_stencilbits")?.latchedValue).toBeUndefined();
          }
          current.common.commands.append("vid_restart\n");
          await frame();
          expect(configurations).toHaveLength(before + 1);
          expect(current.common.cvars.get("r_stencilbits")?.value).toBe(value);
          expect(current.common.cvars.get("r_stencilbits")?.latchedValue).toBeUndefined();
        }
        expect(backendBits).toEqual(configurations.map(configuration => configuration.stencilBits));
        if (renderer === "cpu") expect(backendBits).toEqual([0, 0, 8, 0]);
        else {
          expect(backendBits).toHaveLength(4);
          const requestedEight = backendBits[2];
          if (requestedEight === undefined) throw new Error("Missing restarted GL resource precision");
          expect(requestedEight).toBeGreaterThanOrEqual(8);
        }
      } finally {
        try { await host?.close(); }
        finally { configurationSpy.mockRestore(); stdin.destroy(); }
      }
    }, 60000);
}

test.skipIf(dataPath === undefined)("client rejects an unsupported stencil precision before opening a renderer", async () => {
  const stdin = new PassThrough();
  try { await expect(open("cpu", "-1", stdin)).rejects.toThrow(/stencil/i); }
  finally { stdin.destroy(); }
}, 60000);
