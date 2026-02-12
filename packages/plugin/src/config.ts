// ---------------------------------------------------------------------------
// Gateway Configuration Reader
// Reads Gateway connection settings from environment variables and openclaw.json
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

/** Gateway connection configuration */
export interface GatewayConfig {
  /** WebSocket URL for the Gateway (default: ws://127.0.0.1:18789) */
  url: string;
  /** Optional authentication token (token-based auth fallback) */
  token?: string;
  /** Path to device Ed25519 key file */
  deviceKeyPath: string;
  /** Protocol version to use */
  minProtocol: number;
  maxProtocol: number;
  /** Whether to allow insecure auth (no challenge signing) */
  allowInsecureAuth: boolean;
}

/** Default configuration values */
const DEFAULTS: Omit<GatewayConfig, "deviceKeyPath"> = {
  url: "ws://127.0.0.1:18789",
  minProtocol: 3,
  maxProtocol: 3,
  allowInsecureAuth: false,
};

/**
 * Get default device key path using XDG Base Directory spec
 * Falls back to ~/.config/botschat/device.key if XDG_CONFIG_HOME not set
 */
function getDefaultDeviceKeyPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configDir = xdgConfigHome
    ? join(xdgConfigHome, "botschat")
    : join(homedir(), ".config", "botschat");
  return join(configDir, "device.key");
}

/**
 * Normalize URL to WebSocket format
 * - Converts ws:// or wss:// schemes
 * - Handles bare host:port (assumes ws://)
 * - Strips trailing slashes
 */
function normalizeGatewayUrl(input: string): string {
  if (!input || typeof input !== "string") {
    return DEFAULTS.url;
  }

  const trimmed = input.trim();
  if (!trimmed) return DEFAULTS.url;

  // Already has ws:// or wss:// scheme
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed.replace(/\/$/, "");
  }

  // Has http:// or https:// - convert to ws://
  if (trimmed.startsWith("http://")) {
    return "ws://" + trimmed.slice(7).replace(/\/$/, "");
  }
  if (trimmed.startsWith("https://")) {
    return "wss://" + trimmed.slice(8).replace(/\/$/, "");
  }

  // Bare host:port - assume ws://
  return `ws://${trimmed.replace(/\/$/, "")}`;
}

/**
 * Normalize hostname for client connections
 * Converts "loopback" to "127.0.0.1" since "loopback" is a valid bind address
 * but not a resolvable hostname for WebSocket clients
 */
function normalizeGatewayHostname(host: string): string {
  if (host === "loopback") {
    return "127.0.0.1";
  }
  return host;
}

/**
 * Read Gateway configuration from environment and openclaw.json
 * Priority: env vars > openclaw.json > defaults
 */
export function readGatewayConfig(): GatewayConfig {
  // Environment variable overrides
  const envUrl = process.env.OPENCLAW_GATEWAY_URL;
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const envKeyPath = process.env.BOTSCHAT_DEVICE_KEY_PATH;

  // Read from openclaw.json if exists
  let configFromFile: Partial<GatewayConfig> = {};
  try {
    const configFile = join(homedir(), ".openclaw", "openclaw.json");
    if (existsSync(configFile)) {
      const content = readFileSync(configFile, "utf-8");
      const cfg = JSON.parse(content) as Record<string, unknown>;
      const gateway = cfg?.gateway as Record<string, unknown> | undefined;

      if (gateway) {
        // Handle both url and legacy host/port format
        const gatewayUrl = gateway.url as string | undefined;
        if (gatewayUrl) {
          configFromFile.url = normalizeGatewayUrl(gatewayUrl);
        } else {
          const host = normalizeGatewayHostname((gateway.bind as string) ?? "127.0.0.1");
          const port = (gateway.port as number) ?? 18789;
          configFromFile.url = `ws://${host}:${port}`;
        }

        if (gateway.auth) {
          const auth = gateway.auth as Record<string, unknown>;
          if (typeof auth.token === "string") {
            configFromFile.token = auth.token;
          }
          if (typeof auth.allowInsecureAuth === "boolean") {
            configFromFile.allowInsecureAuth = auth.allowInsecureAuth;
          }
        }
      }
    }
  } catch {
    // Config file doesn't exist or is invalid - use defaults
  }

  // Resolve device key path (env > default)
  const deviceKeyPath = envKeyPath
    ? resolve(envKeyPath)
    : getDefaultDeviceKeyPath();

  // Final config with priority: env > file > defaults
  return {
    url: envUrl ? normalizeGatewayUrl(envUrl) : (configFromFile.url ?? DEFAULTS.url),
    token: envToken ?? configFromFile.token,
    deviceKeyPath,
    minProtocol: DEFAULTS.minProtocol,
    maxProtocol: DEFAULTS.maxProtocol,
    allowInsecureAuth: configFromFile.allowInsecureAuth ?? DEFAULTS.allowInsecureAuth,
  };
}

/**
 * Get just the Gateway URL (convenience function)
 */
export function getGatewayUrl(): string {
  return readGatewayConfig().url;
}

/**
 * Get device key path (convenience function)
 */
export function getDeviceKeyPath(): string {
  return readGatewayConfig().deviceKeyPath;
}
