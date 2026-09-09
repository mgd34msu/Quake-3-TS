import { expect, test } from "bun:test";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";

test("oversized polygon flushes the prior sorted surface before its source drop", async () => {
  const script = new TextEncoder().encode("surface { cull none { map $whiteimage rgbGen identity } }");
  const reader = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    readFileLength: name => name === "scripts/test.shader" ? script.length : -1,
    readFileOptional: async name => name === "scripts/test.shader" ? script : undefined,
    has: name => name === "scripts/test.shader", list: () => ["scripts/test.shader"],
    read: async name => { if (name !== "scripts/test.shader") throw new Error(`Missing fixture ${name}`); return script; },
  });
  const images = new RendererImageCatalog(), recording = new BatchRecordingBackend(new SoftwareRenderer(64, 48, images));
  const target = new RenderTarget(images, [recording]), settings = createRendererSettings();
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  try {
    const resources = await RendererResources.create(reader, { kind: "unaccounted" }, settings, {
      patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile,
      target, images, builtins, drawDebugSurface: () => { throw new Error("Unexpected debug surface"); },
      shaderCinematics: { playShaderCinematic: async () => { throw new Error("Unexpected cinematic"); } },
    });
    const commands = new RenderCommandBuffer(target, { print: () => undefined, clock: { milliseconds: () => 0 },
      identityLight: 1, tess: resources.tess, runtime: settings.runtime });
    try {
      const shader = await resources.registerShader("surface");
      const vertex = (index: number) => ({ position: { x: 32, y: index % 3 - 1, z: (index % 3) >> 1 },
        texCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } });
      const refdef = { ...cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 64, 48), renderFlags: RDF_NOWORLDMODEL };
      // Source shortsort swaps these two equal sort words: the triangle executes first.
      commands.addPreparedViews(resources.prepareFrame({ refdef, polys: [
        { shader, vertices: Array.from({ length: 1000 }, (_, index) => vertex(index)) },
        { shader, vertices: [vertex(0), vertex(1), vertex(2)] },
      ] }));
      expect(() => commands.submit()).toThrow("RB_CheckOverflow: verts > MAX (1000 > 1000)");
      expect(recording.trace().flatMap(view => view.batches)).toHaveLength(1);
      expect(resources.performance.backEnd.c_shaders).toBe(1);
      expect([resources.tess.numVertexes, resources.tess.numIndexes]).toEqual([3, 0]);
    } finally { commands.close("discard"); }
  } finally { target.close(); }
});
