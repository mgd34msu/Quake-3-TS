// R_CreateBuiltinImages and image-cache metadata from id Software's
// code/renderer/tr_image.c. GPL-2.0-or-later.
import { createFogTexture } from "./fog.ts";
import type { RendererImage, RendererImageCatalog } from "./image-resource.ts";
import { imageUploadSteps } from "./image-upload.ts";
import type { ImageUploadProfile } from "./image-upload.ts";

export interface BuiltinImage {
  readonly image: RendererImage;
  readonly mipmap: boolean;
  readonly allowPicmip: boolean;
  readonly wrap: "repeat" | "clamp";
}

/** Source built-in creations share the actual renderer upload profile. */
export class BuiltinImages {
  readonly defaultImage: RendererImage;
  readonly fogImage: RendererImage;
  private readonly entries = new Map<string, BuiltinImage>();
  private readonly metadata = new WeakMap<RendererImage, BuiltinImage>();
  private readonly scratch: readonly RendererImage[];

  constructor(readonly images: RendererImageCatalog, private readonly imageProfile: () => ImageUploadProfile) {
    const pixels = new Uint8Array(16 * 16 * 4).fill(32);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (x === 0 || y === 0 || x === 15 || y === 15) pixels.fill(255, (y * 16 + x) * 4, (y * 16 + x) * 4 + 4);
    }
    this.defaultImage = this.create("*default", 16, 16, pixels, true, false, "repeat");
    const white = new Uint8Array(16 * 16 * 4).fill(255);
    this.create("*white", 8, 8, white.subarray(0, 8 * 8 * 4), false, false, "repeat");
    const identityLightByte = imageProfile().colorMappings.identityLightByte;
    const identity = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < identity.length; i += 4) identity.set([identityLightByte, identityLightByte, identityLightByte, 255], i);
    this.create("*identityLight", 8, 8, identity.subarray(0, 8 * 8 * 4), false, false, "repeat");
    this.scratch = Object.freeze(Array.from({ length: 32 }, () =>
      this.create("*scratch", 16, 16, identity, false, true, "clamp")));
    const dlight = new Uint8Array(16 * 16 * 4);
    for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) {
      const distance = (7.5 - x) * (7.5 - x) + (7.5 - y) * (7.5 - y);
      let brightness = Math.trunc(Math.fround(4000 / distance));
      if (brightness > 255) brightness = 255;
      else if (brightness < 75) brightness = 0;
      dlight.set([brightness, brightness, brightness, 255], (y * 16 + x) * 4);
    }
    images.setDlightImage(this.create("*dlight", 16, 16, dlight, false, false, "clamp"));
    const memory = images.hunk;
    const fogAllocation = memory.kind === "source-hunk" ? memory.accounting.allocateTemp("R_CreateFogImage", "*fog", 256 * 32 * 4) : null;
    const fog = fogAllocation === null ? createFogTexture() : createFogTexture(fogAllocation.bytes);
    this.fogImage = this.create("*fog", fog.width, fog.height, fog.pixels, false, false, "clamp");
    if (fogAllocation !== null && memory.kind === "source-hunk") memory.accounting.freeTemp("R_CreateFogImage", "*fog", fogAllocation);
    // R_CreateImage has already raw-unbound the current texture object here.
    images.setCurrentBorderColor({ x: 1, y: 1, z: 1, w: 1 });
  }

  find(name: string): BuiltinImage | undefined { return this.entries.get(name); }
  forImage(image: RendererImage): BuiltinImage | undefined { return this.metadata.get(image); }

  scratchImage(index: number): RendererImage {
    const image = this.scratch[index];
    if (!Number.isInteger(index) || image === undefined) throw new RangeError("Renderer scratch image index must be in 0..31");
    return image;
  }

  private create(name: string, width: number, height: number, pixels: Uint8Array,
    mipmap: boolean, allowPicmip: boolean, wrap: BuiltinImage["wrap"]): RendererImage {
    const image = this.images.createUploaded({ name, sourceWidth: width, sourceHeight: height, mipmap, allowPicmip,
      sampling: { wrap, filter: mipmap ? this.images.textureFilter : "linear" }, registrationUnit: 0 },
    () => imageUploadSteps({ width, height, pixels }, { name, mipmap, allowPicmip }, this.imageProfile(), this.images.hunk));
    const entry: BuiltinImage = Object.freeze({ image, mipmap, allowPicmip, wrap });
    this.entries.set(name, entry);
    this.metadata.set(image, entry);
    return image;
  }
}
