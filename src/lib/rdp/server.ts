import "server-only";
import { createRdpClient, type RdpClient } from "./client";
import { readRdpConfig } from "./config";
import { RdpError } from "./errors";
import { createFixtureTransport } from "./fixture";
import { createLiveTransport } from "./live";

let client: RdpClient | undefined;

/**
 * The process-wide RDP adapter. Server Components and Route Handlers call this; it must never reach a client
 * bundle (`server-only` fails the build if it does). Configuration errors surface as CONFIGURATION_ERROR.
 */
export function getRdpClient(): RdpClient {
  if (client) return client;
  const config = readRdpConfig();
  client =
    config.mode === "live"
      ? createRdpClient({ mode: "live", transport: createLiveTransport(config) })
      : createRdpClient({ mode: "fixture", transport: createFixtureTransport() });
  return client;
}

/** Resolves the adapter's data mode without throwing; `unconfigured` when the environment is invalid. */
export function getRdpMode(): "fixture" | "live" | "unconfigured" {
  try {
    return getRdpClient().mode;
  } catch (error) {
    if (error instanceof RdpError) return "unconfigured";
    throw error;
  }
}

export { RdpError };
