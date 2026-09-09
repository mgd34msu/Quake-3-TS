// GL_State and GLS_* from id Software's renderer/tr_backend.c and tr_local.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonError } from "../core/common-error.ts";
import type { BlendFactor, RenderState } from "./types.ts";

export enum SourceStateBit {
  SRCBLEND_ZERO = 0x00000001,
  SRCBLEND_ONE = 0x00000002,
  SRCBLEND_DST_COLOR = 0x00000003,
  SRCBLEND_ONE_MINUS_DST_COLOR = 0x00000004,
  SRCBLEND_SRC_ALPHA = 0x00000005,
  SRCBLEND_ONE_MINUS_SRC_ALPHA = 0x00000006,
  SRCBLEND_DST_ALPHA = 0x00000007,
  SRCBLEND_ONE_MINUS_DST_ALPHA = 0x00000008,
  SRCBLEND_ALPHA_SATURATE = 0x00000009,
  SRCBLEND_BITS = 0x0000000f,
  DSTBLEND_ZERO = 0x00000010,
  DSTBLEND_ONE = 0x00000020,
  DSTBLEND_SRC_COLOR = 0x00000030,
  DSTBLEND_ONE_MINUS_SRC_COLOR = 0x00000040,
  DSTBLEND_SRC_ALPHA = 0x00000050,
  DSTBLEND_ONE_MINUS_SRC_ALPHA = 0x00000060,
  DSTBLEND_DST_ALPHA = 0x00000070,
  DSTBLEND_ONE_MINUS_DST_ALPHA = 0x00000080,
  DSTBLEND_BITS = 0x000000f0,
  DEPTHMASK_TRUE = 0x00000100,
  POLYMODE_LINE = 0x00001000,
  DEPTHTEST_DISABLE = 0x00010000,
  DEPTHFUNC_EQUAL = 0x00020000,
  ATEST_GT_0 = 0x10000000,
  ATEST_LT_80 = 0x20000000,
  ATEST_GE_80 = 0x40000000,
  ATEST_BITS = 0x70000000,
  DEFAULT = DEPTHMASK_TRUE,
}

export type SourceBlendSourceFactor = Exclude<BlendFactor, "src-color" | "one-minus-src-color">;
export type SourceBlendDestinationFactor = Exclude<BlendFactor,
  "dst-color" | "one-minus-dst-color" | "src-alpha-saturate">;

export interface SourceStateInput {
  readonly depthTest: "less-equal" | "equal";
  readonly depthWrite: boolean;
  readonly blend: { readonly source: SourceBlendSourceFactor; readonly destination: SourceBlendDestinationFactor } | null;
  readonly alphaTest: RenderState["alphaTest"];
}

export type SourceStateChange =
  | { readonly kind: "depth-function"; readonly value: SourceStateInput["depthTest"] }
  | { readonly kind: "blend"; readonly enabled: false }
  | { readonly kind: "blend"; readonly enabled: true;
      readonly source: SourceBlendSourceFactor; readonly destination: SourceBlendDestinationFactor }
  | { readonly kind: "depth-write"; readonly value: boolean }
  | { readonly kind: "polygon-mode"; readonly value: "fill" | "line" }
  | { readonly kind: "depth-test"; readonly enabled: boolean }
  | { readonly kind: "alpha-test"; readonly value: RenderState["alphaTest"] };

const SOURCE_BLEND_BITS: Readonly<Record<SourceBlendSourceFactor, SourceStateBit>> = {
  zero: SourceStateBit.SRCBLEND_ZERO,
  one: SourceStateBit.SRCBLEND_ONE,
  "dst-color": SourceStateBit.SRCBLEND_DST_COLOR,
  "one-minus-dst-color": SourceStateBit.SRCBLEND_ONE_MINUS_DST_COLOR,
  "src-alpha": SourceStateBit.SRCBLEND_SRC_ALPHA,
  "one-minus-src-alpha": SourceStateBit.SRCBLEND_ONE_MINUS_SRC_ALPHA,
  "dst-alpha": SourceStateBit.SRCBLEND_DST_ALPHA,
  "one-minus-dst-alpha": SourceStateBit.SRCBLEND_ONE_MINUS_DST_ALPHA,
  "src-alpha-saturate": SourceStateBit.SRCBLEND_ALPHA_SATURATE,
};
const DESTINATION_BLEND_BITS: Readonly<Record<SourceBlendDestinationFactor, SourceStateBit>> = {
  zero: SourceStateBit.DSTBLEND_ZERO,
  one: SourceStateBit.DSTBLEND_ONE,
  "src-color": SourceStateBit.DSTBLEND_SRC_COLOR,
  "one-minus-src-color": SourceStateBit.DSTBLEND_ONE_MINUS_SRC_COLOR,
  "src-alpha": SourceStateBit.DSTBLEND_SRC_ALPHA,
  "one-minus-src-alpha": SourceStateBit.DSTBLEND_ONE_MINUS_SRC_ALPHA,
  "dst-alpha": SourceStateBit.DSTBLEND_DST_ALPHA,
  "one-minus-dst-alpha": SourceStateBit.DSTBLEND_ONE_MINUS_DST_ALPHA,
};
const ALPHA_TEST_BITS: Readonly<Record<RenderState["alphaTest"], number>> = {
  none: 0,
  gt0: SourceStateBit.ATEST_GT_0,
  lt128: SourceStateBit.ATEST_LT_80,
  ge128: SourceStateBit.ATEST_GE_80,
};

/** Null blend encodes disabled blending; explicit one/zero still enables GL_BLEND. */
export function sourceStateBits(input: SourceStateInput, polygonMode: "fill" | "line" = "fill",
  depthTestEnabled = true): number {
  let bits: number;
  switch (input.depthTest) {
    case "less-equal": bits = 0; break;
    case "equal": bits = SourceStateBit.DEPTHFUNC_EQUAL; break;
    default: {
      const invalid: never = input.depthTest;
      throw new RangeError(`GL_State cannot encode depth function '${invalid}'`);
    }
  }
  if (input.blend !== null) bits |= SOURCE_BLEND_BITS[input.blend.source] | DESTINATION_BLEND_BITS[input.blend.destination];
  if (input.depthWrite) bits |= SourceStateBit.DEPTHMASK_TRUE;
  if (polygonMode === "line") bits |= SourceStateBit.POLYMODE_LINE;
  if (!depthTestEnabled) bits |= SourceStateBit.DEPTHTEST_DISABLE;
  return bits | ALPHA_TEST_BITS[input.alphaTest];
}

function sourceBlendFactor(bits: number): SourceBlendSourceFactor {
  switch (bits) {
    case SourceStateBit.SRCBLEND_ZERO: return "zero";
    case SourceStateBit.SRCBLEND_ONE: return "one";
    case SourceStateBit.SRCBLEND_DST_COLOR: return "dst-color";
    case SourceStateBit.SRCBLEND_ONE_MINUS_DST_COLOR: return "one-minus-dst-color";
    case SourceStateBit.SRCBLEND_SRC_ALPHA: return "src-alpha";
    case SourceStateBit.SRCBLEND_ONE_MINUS_SRC_ALPHA: return "one-minus-src-alpha";
    case SourceStateBit.SRCBLEND_DST_ALPHA: return "dst-alpha";
    case SourceStateBit.SRCBLEND_ONE_MINUS_DST_ALPHA: return "one-minus-dst-alpha";
    case SourceStateBit.SRCBLEND_ALPHA_SATURATE: return "src-alpha-saturate";
    default: throw new CommonError("drop", "GL_State: invalid src blend state bits\n");
  }
}

function destinationBlendFactor(bits: number): SourceBlendDestinationFactor {
  switch (bits) {
    case SourceStateBit.DSTBLEND_ZERO: return "zero";
    case SourceStateBit.DSTBLEND_ONE: return "one";
    case SourceStateBit.DSTBLEND_SRC_COLOR: return "src-color";
    case SourceStateBit.DSTBLEND_ONE_MINUS_SRC_COLOR: return "one-minus-src-color";
    case SourceStateBit.DSTBLEND_SRC_ALPHA: return "src-alpha";
    case SourceStateBit.DSTBLEND_ONE_MINUS_SRC_ALPHA: return "one-minus-src-alpha";
    case SourceStateBit.DSTBLEND_DST_ALPHA: return "dst-alpha";
    case SourceStateBit.DSTBLEND_ONE_MINUS_DST_ALPHA: return "one-minus-dst-alpha";
    default: throw new CommonError("drop", "GL_State: invalid dst blend state bits\n");
  }
}

/** Apply each yielded operation before advancing, then commit next only after completion. */
export function* sourceStateChanges(previous: number | null, next: number): Generator<SourceStateChange, void, void> {
  const diff = previous === null ? -1 : previous ^ next;
  if (diff === 0) return;

  if (diff & SourceStateBit.DEPTHFUNC_EQUAL) {
    yield { kind: "depth-function", value: next & SourceStateBit.DEPTHFUNC_EQUAL ? "equal" : "less-equal" };
  }

  if (diff & (SourceStateBit.SRCBLEND_BITS | SourceStateBit.DSTBLEND_BITS)) {
    if (next & (SourceStateBit.SRCBLEND_BITS | SourceStateBit.DSTBLEND_BITS)) {
      const source = sourceBlendFactor(next & SourceStateBit.SRCBLEND_BITS);
      const destination = destinationBlendFactor(next & SourceStateBit.DSTBLEND_BITS);
      yield { kind: "blend", enabled: true, source, destination };
    } else {
      yield { kind: "blend", enabled: false };
    }
  }

  if (diff & SourceStateBit.DEPTHMASK_TRUE) {
    yield { kind: "depth-write", value: (next & SourceStateBit.DEPTHMASK_TRUE) !== 0 };
  }
  if (diff & SourceStateBit.POLYMODE_LINE) {
    yield { kind: "polygon-mode", value: next & SourceStateBit.POLYMODE_LINE ? "line" : "fill" };
  }
  if (diff & SourceStateBit.DEPTHTEST_DISABLE) {
    yield { kind: "depth-test", enabled: (next & SourceStateBit.DEPTHTEST_DISABLE) === 0 };
  }
  if (diff & SourceStateBit.ATEST_BITS) {
    switch (next & SourceStateBit.ATEST_BITS) {
      case 0: yield { kind: "alpha-test", value: "none" }; break;
      case SourceStateBit.ATEST_GT_0: yield { kind: "alpha-test", value: "gt0" }; break;
      case SourceStateBit.ATEST_LT_80: yield { kind: "alpha-test", value: "lt128" }; break;
      case SourceStateBit.ATEST_GE_80: yield { kind: "alpha-test", value: "ge128" }; break;
      // The source default is assert(0), a no-op in its NDEBUG release profile.
      default: break;
    }
  }
}
