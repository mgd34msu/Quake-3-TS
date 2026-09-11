// Endpoint defines from id Software's code/Construct and qcommon/qcommon.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

export interface NetworkDefaults {
  readonly masterServer: string;
  readonly authorizeServer: string;
  readonly authorizePort: number;
}

export function parseNetworkDefaults(input: {
  readonly masterServer?: string | undefined;
  readonly authorizeServer?: string | undefined;
  readonly authorizePort?: string | undefined;
}): NetworkDefaults {
  const hostname = (value: string, name: string): string => {
    for (const character of value) {
      if (character.charCodeAt(0) === 0 || character.charCodeAt(0) > 255) throw new Error(`${name} requires non-NUL Latin-1 source bytes`);
    }
    return value.toLowerCase();
  };
  const port = input.authorizePort ?? "27952";
  // Keep the actual UnixIo destination-port boundary; reject source macro truncation.
  if (!/^\d+$/u.test(port) || !Number.isSafeInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new RangeError("auth-port requires an integer from 1 through 65535");
  }
  return {
    masterServer: hostname(input.masterServer ?? "master.quake3arena.com", "master-server"),
    authorizeServer: hostname(input.authorizeServer ?? "authorize.quake3arena.com", "auth-server"),
    authorizePort: Number(port),
  };
}

export const MASTER_SERVER_PORT = 27950;
export const NETWORK_DEFAULTS = parseNetworkDefaults({
  masterServer: process.env["Q3_MASTER_SERVER"],
  authorizeServer: process.env["Q3_AUTH_SERVER"],
  authorizePort: process.env["Q3_AUTH_PORT"],
});
