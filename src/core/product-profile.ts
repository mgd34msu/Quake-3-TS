// PRE_RELEASE_DEMO and PRE_RELEASE_TADEMO from id Software's files.c, sv_ccmds.c and ui_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

export type ProductProfile =
  | { readonly kind: "retail" }
  | { readonly kind: "prerelease-demo"; readonly teamArenaUi: "retail" | "demo" }
  | { readonly kind: "prerelease-ta-demo" };

export const RETAIL_PRODUCT_PROFILE: ProductProfile = { kind: "retail" };

export function isPrereleaseDemo(profile: ProductProfile): boolean {
  return profile.kind === "prerelease-demo";
}

export function isPrereleaseTeamArenaDemo(profile: ProductProfile): boolean {
  return profile.kind === "prerelease-ta-demo"
    || (profile.kind === "prerelease-demo" && profile.teamArenaUi === "demo");
}
