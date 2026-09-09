// Source CIN_UploadCinematic/CIN_DrawCinematic execution boundaries, cl_cin.c.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import type { RendererImage, RgbaSnapshot } from "./image-resource.ts";

export interface CinematicUpload {
  readonly image: RendererImage;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly uploadWidth: number;
  readonly uploadHeight: number;
  readonly content: RgbaSnapshot;
  readonly dirty: boolean;
}

export interface ShaderCinematicCall {
  readonly upload: CinematicUpload;
  afterShaderUpload(): undefined;
}

export interface ShaderCinematicSource {
  readonly image: RendererImage;
  prepareAtExecution(): ShaderCinematicCall | null;
}

export interface ShaderCinematicRegistry {
  playShaderCinematic(path: string): Promise<ShaderCinematicSource | null>;
}

/** Selected pointer/dimensions precede the barrier; direct bytes are read after it. */
export interface PreparedUiRawCall {
  readonly image: RendererImage;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly uploadWidth: number;
  readonly uploadHeight: number;
  readonly dirty: boolean;
  captureAfterBarrier(): UiRawCinematicCall;
}

export interface UiRawCinematicCall {
  readonly upload: CinematicUpload;
  afterUiDraw(): undefined;
}
