import { expect, test } from "bun:test";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
import { createModelEntity } from "../src/render/ref-entity.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";

for (const diskType of [1, 2, 3]) for (const empty of [false, true]) {
  test(`source BSP submission retains NODRAW type ${diskType}, empty indices ${empty}`, async () => {
    const bsp = renderBspFixture([{ shader: "surface", lightmap: -1 }, { shader: "surface", lightmap: -1 }], []);
    const data = new DataView(bsp.buffer);
    data.setInt32(data.getInt32(8 + 3 * 8, true) + 8, 1, true);
    data.setInt32(data.getInt32(8 + 1 * 8, true) + 64, 0x80, true);
    const surfaces = data.getInt32(8 + 13 * 8, true);
    for (let index = 0; index < 2; index++) {
      data.setInt32(surfaces + index * 104 + 8, diskType, true);
      if (empty) data.setInt32(surfaces + index * 104 + 24, 0, true);
    }
    const files = new Map([["maps/test.bsp", bsp], ["scripts/test.shader",
      new TextEncoder().encode("surface { cull none { map $whiteimage rgbGen identity } }")]]);
    const reader = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
      readFileLength: name => files.get(name)?.byteLength ?? -1, readFileOptional: async name => files.get(name),
      has: name => files.has(name), list: () => [...files.keys()],
      read: async name => { const bytes = files.get(name); if (bytes === undefined) throw new Error(`Missing fixture ${name}`); return bytes; },
    });
    const images = new RendererImageCatalog(), target = new RenderTarget(images, [new SoftwareRenderer(64, 48, images)]);
    const settings = createRendererSettings(), builtins = new BuiltinImages(images, identityImageUploadProfile);
    try {
      const resources = await RendererResources.create(reader, { kind: "unaccounted" }, settings, {
        patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile,
        target, images, builtins, drawDebugSurface: () => { throw new Error("Unexpected debug surface"); },
        shaderCinematics: { playShaderCinematic: async () => { throw new Error("Unexpected cinematic"); } },
      });
      const commands = new RenderCommandBuffer(target, { print: () => undefined, clock: { milliseconds: () => 0 },
        identityLight: 1, tess: resources.tess, runtime: settings.runtime });
      try {
        const world = await resources.loadWorld("test");
        const refdef = cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 64, 48);
        commands.addPreparedViews(world.prepareFrame({ refdef })); commands.submit();
        expect(resources.performance.backEnd.c_surfaces).toBe(2);
        const inline = createModelEntity(world.inlineModel(0));
        inline.axis = refdef.viewAxis;
        commands.addPreparedViews(world.prepareFrame({ refdef: { ...refdef, renderFlags: RDF_NOWORLDMODEL }, entities: [inline] })); commands.submit();
        expect(resources.performance.backEnd.c_surfaces).toBe(4);
        const shader = await resources.registerShader("surface");
        commands.addPreparedViews(resources.prepareFrame({ refdef: { ...refdef, renderFlags: RDF_NOWORLDMODEL },
          polys: [{ shader, vertices: [1, 2].map(y => ({ position: { x: 32, y, z: 0 },
            texCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } })) }] })); commands.submit();
        expect(resources.performance.backEnd.c_surfaces).toBe(5);
        expect([resources.tess.numVertexes, resources.tess.numIndexes]).toEqual([2, 0]);
      } finally { commands.close("discard"); }
    } finally { target.close(); }
  });
}
