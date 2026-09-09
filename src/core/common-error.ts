// Port of id Software's common.c Com_Error control flow.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

export type CommonErrorCode = "server-disconnect" | "drop" | "disconnect" | "need-cd" | "fatal";

export class CommonError extends Error {
  constructor(readonly code: CommonErrorCode, message: string) {
    super(message);
    this.name = "CommonError";
  }
}
