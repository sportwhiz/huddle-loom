import type { Release } from "./release";
declare const __HUDDLE_RELEASE__: Release;
export const currentRelease: Release =
  typeof __HUDDLE_RELEASE__ === "undefined"
    ? {
        version: "0.1.0",
        commit: "development",
        schema: "development",
        dataFormat: 1,
        protocol: 1,
        security: false,
        notes: "Development build",
      }
    : __HUDDLE_RELEASE__;
