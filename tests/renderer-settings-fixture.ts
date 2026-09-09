import { CvarRegistry } from "../src/core/cvar.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { createImageColorMappings } from "../src/render/image-upload.ts";
import type { ImageUploadProfile } from "../src/render/image-upload.ts";

/** Identity upload profile for existing analytic pixels and image-byte fixtures. */
export function identityImageUploadProfile(): ImageUploadProfile {
  return { picmip: 0, roundImagesDown: true, simpleMipMaps: true, colorMipLevels: false,
    textureBits: 32, textureCompression: "none", maxTextureSize: null,
    colorMappings: createImageColorMappings({ gamma: 1, intensity: 1, requestedOverbrightBits: 0,
      deviceSupportsGamma: false, isFullscreen: false, colorBits: 32 }) };
}

/** Deterministic CPU fixture with explicit modern two-unit capabilities and the source Linux defaults. */
export function createRendererSettings(): SourceRendererSettings {
  return new SourceRendererSettings(new RegisteredRendererCvars(new CvarRegistry(), "linux"), { textureUnits: 2, textureEnvAdd: true });
}
