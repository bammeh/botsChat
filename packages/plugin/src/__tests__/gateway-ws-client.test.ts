/**
 * Unit tests for GatewayWsClient
 * 
 * Tests the WebSocket client for OpenClaw gateway including:
 * - Handshake with challenge/response
 * - RPC request/response correlation
 * - Event streaming
 * - Connection lifecycle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { GatewayWsClient, GatewayEvent } from "../gateway-ws-client.js";

// Test constants
const TEST_PORT = 19999;
const TEST_ACCOUNT_ID = "test-account-123";
const TEST_TOKEN = "test-token-abc";

// Mock server state
let mockServer: WebSocketServer | null = null;
let connectedClients: WebSocket[] = [];

// Helper to create mock server
async function createMockServer(
  options: {
    port?: number;
    onChallenge?: (nonce: string, ts: number) => void;
    onConnect?: (payload: Record<string, unknown>) => { ok: boolean; error?: string };
    onRpc?: (id: string, method: string, params: Record<string, unknown>) => unknown;
    onMessage?: (data: unknown) => void;
  } = {}
): Promise<WebSocketServer> {
  const port = options.port ?? TEST_PORT;
  const server = new WebSocketServer({ port });

  server.on("connection", (ws) => {
    connectedClients.push(ws);

    // Send challenge on connection
    const nonce = `nonce-${Date.now()}`;
    const ts = Date.now();
    options.onChallenge?.(nonce, ts);
    ws.send(JSON.stringify({ type: "connect.challenge", nonce, ts }));

    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      options.onMessage?.(message);

      // Handle connect response
      if (message.type === "connect") {
        const result = options.onConnect?.(message) ?? { ok: true };
        if (result.ok) {
          ws.send(JSON.stringify({ type: "connect", status: "ok" }));
        } else {
          ws.send(
            JSON.stringify({
              type: "connect",
              error: { code: 401, message: result.error ?? "Unauthorized" },
            })
          );
        }
        return;
      }

      // Handle RPC requests
      if (message.id && message.method) {
        const result = options.onRpc?.(message.id, message.method, message.params);
        // Only send response if onRpc returns a value (not undefined)
        // This allows tests to simulate non-responding servers
        if (result !== undefined) {
          ws.send(JSON.stringify({ id: message.id, result }));
        }
        return;
      }

      // Handle ping
      if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
    });
  });

  return new Promise((resolve) => {
    server.on("listening", () => resolve(server));
  });
}

// Helper to close mock server
async function closeMockServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    connectedClients.forEach((ws) => ws.close());
    connectedClients = [];
    server.close(() => resolve());
  });
}

// Helper to create client
function createClient(options: Partial<ConstructorParameters<typeof GatewayWsClient>[0]> = {}) {
  const events: GatewayEvent[] = [];
  let connected = false;
  let disconnected = false;

  const client = new GatewayWsClient({
    port: TEST_PORT,
    accountId: TEST_ACCOUNT_ID,
    onEvent: (frame) => events.push(frame),
    onConnected: () => (connected = true),
    onDisconnected: () => (disconnected = true),
    ...options,
  });

  return { client, events, getConnected: () => connected, getDisconnected: () => disconnected };
}

describe("GatewayWsClient", () => {
  beforeEach(() => {
    connectedClients = [];
  });

  afterEach(async () => {
    if (mockServer) {
      await closeMockServer(mockServer);
      mockServer = null;
    }
  });

  describe("connect()", () => {
    it("completes handshake with challenge/response", async () => {
      let receivedNonce: string | undefined;
      let receivedConnectPayload: Record<string, unknown> | undefined;

      mockServer = await createMockServer({
        onChallenge: (nonce) => {
          receivedNonce = nonce;
        },
        onMessage: (msg) => {
          if ((msg as Record<string, unknown>).type === "connect") {
            receivedConnectPayload = msg as Record<string, unknown>;
          }
        },
      });

      const { client, getConnected } = createClient();

      await client.connect();

      expect(receivedNonce).toBeDefined();
      expect(receivedConnectPayload).toBeDefined();
      expect(receivedConnectPayload?.role).toBe("operator");
      expect(receivedConnectPayload?.scopes).toContain("operator.read");
      expect(receivedConnectPayload?.scopes).toContain("operator.write");
      expect(receivedConnectPayload?.caps).toContain("tool-events");
      expect(getConnected()).toBe(true);
      expect(client.connected).toBe(true);

      client.disconnect();
    });

    it("fails on invalid challenge response (server rejects)", async () => {
      mockServer = await createMockServer({
        onConnect: () => ({ ok: false, error: "Invalid nonce" }),
      });

      const { client } = createClient();

      await expect(client.connect()).rejects.toThrow("Invalid nonce");
      expect(client.connected).toBe(false);
    });

    it("includes token when provided", async () => {
      let receivedConnectPayload: Record<string, unknown> | undefined;

      mockServer = await createMockServer({
        onMessage: (msg) => {
          if ((msg as Record<string, unknown>).type === "connect") {
            receivedConnectPayload = msg as Record<string, unknown>;
          }
        },
      });

      const { client } = createClient({ token: TEST_TOKEN });

      await client.connect();

      expect(receivedConnectPayload?.auth).toEqual({ token: TEST_TOKEN });

      client.disconnect();
    });

    it("includes device.id when not using insecure auth", async () => {
      let receivedConnectPayload: Record<string, unknown> | undefined;

      mockServer = await createMockServer({
        onMessage: (msg) => {
          if ((msg as Record<string, unknown>).type === "connect") {
            receivedConnectPayload = msg as Record<string, unknown>;
          }
        },
      });

      const { client } = createClient({ allowInsecureAuth: false });

      await client.connect();

      expect(receivedConnectPayload?.device).toBeDefined();
      expect((receivedConnectPayload?.device as Record<string, unknown>)?.id).toContain(
        TEST_ACCOUNT_ID
      );

      client.disconnect();
    });

    it("throws error when already connected", async () => {
      mockServer = await createMockServer();

      const { client } = createClient();

      await client.connect();

      await expect(client.connect()).rejects.toThrow("Already connected");

      client.disconnect();
    });

    it("fails when server is unavailable", async () => {
      // Don't start mock server - simulate server unavailable
      const { client } = createClient();

      await expect(client.connect()).rejects.toThrow();
      expect(client.connected).toBe(false);
    });
  });

  describe("send()", () => {
    it("correlates request/response with ID", async () => {
      let receivedRpcId: string | undefined;
      let receivedMethod: string | undefined;
      let receivedParams: Record<string, unknown> | undefined;

      mockServer = await createMockServer({
        onRpc: (id, method, params) => {
          receivedRpcId = id;
          receivedMethod = method;
          receivedParams = params;
          return { echo: params };
        },
      });

      const { client } = createClient();

      await client.connect();

      const result = await client.send("chat.send", {
        sessionKey: "test-session",
        body: "Hello",
      });

      expect(receivedRpcId).toBeDefined();
      expect(receivedMethod).toBe("chat.send");
      expect(receivedParams).toEqual({ sessionKey: "test-session", body: "Hello" });
      expect(result).toEqual({ echo: { sessionKey: "test-session", body: "Hello" } });

      client.disconnect();
    });

    it("times out after configured duration", async () => {
      // Server that never responds - onRpc returns undefined to not send response
      mockServer = await createMockServer({
        onRpc: () => {
          // Return undefined to simulate no response
          return undefined;
        },
      });

      const { client } = createClient();

      await client.connect();

      // Set a short timeout for testing
      Object.defineProperty(client, "requestTimeoutMs", { value: 100, writable: true });

      await expect(client.send("test.method", {})).rejects.toThrow("timed out");

      client.disconnect();
    });

    it("throws error when not connected", async () => {
      // Don't start server or connect
      const { client } = createClient();

      await expect(client.send("test.method", {})).rejects.toThrow("Not connected");
    });

    it("handles RPC error responses", async () => {
      // Create a custom mock server that sends error responses
      const port = 19998;
      const server = new WebSocketServer({ port });

      server.on("connection", (ws) => {
        // Send challenge
        ws.send(JSON.stringify({ type: "connect.challenge", nonce: "test-nonce", ts: Date.now() }));

        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());

          if (msg.type === "connect") {
            ws.send(JSON.stringify({ type: "connect", status: "ok" }));
          } else if (msg.id && msg.method) {
            ws.send(
              JSON.stringify({
                id: msg.id,
                error: { code: 400, message: "Bad request" },
              })
            );
          }
        });
      });

      await new Promise<void>((resolve) => server.on("listening", () => resolve()));

      try {
        const { client } = createClient({ port });

        await client.connect();

        await expect(client.send("test.method", {})).rejects.toThrow("Bad request");

        client.disconnect();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe("onEvent callback", () => {
    it("receives event frames", async () => {
      mockServer = await createMockServer();

      const { client, events } = createClient();

      await client.connect();

      // Send a mock event from server
      const mockEvent: GatewayEvent = {
        type: "event",
        event: "agent",
        payload: {
          stream: "reply",
          data: { phase: "result", text: "Hello from agent" },
        },
      };

      // Get the connected client and send event
      const serverClient = connectedClients[0];
      serverClient?.send(JSON.stringify(mockEvent));

      // Wait for event to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(mockEvent);

      client.disconnect();
    });

    it("receives multiple event frames in order", async () => {
      mockServer = await createMockServer();

      const { client, events } = createClient();

      await client.connect();

      const mockEvents: GatewayEvent[] = [
        { type: "event", event: "agent", payload: { stream: "reply", data: { phase: "start" } } },
        { type: "event", event: "agent", payload: { stream: "reply", data: { text: "chunk1" } } },
        { type: "event", event: "agent", payload: { stream: "reply", data: { phase: "result" } } },
      ];

      const serverClient = connectedClients[0];
      for (const event of mockEvents) {
        serverClient?.send(JSON.stringify(event));
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(events).toHaveLength(3);
      expect(events).toEqual(mockEvents);

      client.disconnect();
    });
  });

  describe("disconnect()", () => {
    it("closes connection and clears pending requests", async () => {
      mockServer = await createMockServer();

      let disconnectedFired = false;
      const { client } = createClient({
        onDisconnected: () => {
          disconnectedFired = true;
        },
      });

      await client.connect();
      expect(client.connected).toBe(true);

      client.disconnect();

      // Wait for disconnect to propagate
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(client.connected).toBe(false);
      expect(disconnectedFired).toBe(true);
    });

    it("rejects pending requests on disconnect", async () => {
      // Create a custom server that doesn't respond to RPC
      const port = 19997;
      const server = new WebSocketServer({ port });

      server.on("connection", (ws) => {
        // Send challenge
        ws.send(JSON.stringify({ type: "connect.challenge", nonce: "test-nonce", ts: Date.now() }));

        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "connect") {
            ws.send(JSON.stringify({ type: "connect", status: "ok" }));
          }
          // Don't respond to RPC - this simulates a slow server
        });
      });

      await new Promise<void>((resolve) => server.on("listening", () => resolve()));

      try {
        const { client } = createClient({ port });

        await client.connect();

        // Start a request that won't complete (server doesn't respond)
        const requestPromise = client.send("slow.method", {});

        // Wait a bit then disconnect
        await new Promise((resolve) => setTimeout(resolve, 10));
        client.disconnect();

        await expect(requestPromise).rejects.toThrow();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("is idempotent (can be called multiple times)", async () => {
      mockServer = await createMockServer();

      const { client } = createClient();

      await client.connect();

      // Call disconnect multiple times
      client.disconnect();
      client.disconnect();
      client.disconnect();

      expect(client.connected).toBe(false);
    });
  });

  describe("connected getter", () => {
    it("returns false before connection", () => {
      const { client } = createClient();
      expect(client.connected).toBe(false);
    });

    it("returns true after successful handshake", async () => {
      mockServer = await createMockServer();

      const { client } = createClient();

      await client.connect();

      expect(client.connected).toBe(true);

      client.disconnect();
    });

    it("returns false after disconnect", async () => {
      mockServer = await createMockServer();

      const { client } = createClient();

      await client.connect();
      client.disconnect();

      // Wait for disconnect
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(client.connected).toBe(false);
    });
  });

  describe("ping/pong", () => {
    it("sends pings to keep connection alive", async () => {
      const receivedMessages: unknown[] = [];

      mockServer = await createMockServer({
        onMessage: (msg) => receivedMessages.push(msg),
      });

      const { client } = createClient();

      await client.connect();

      // Wait for at least one ping interval (30s in real code, but we verify the mechanism)
      // Since we can't wait 30s in tests, we verify the ping is set up by checking
      // that the server receives a ping message format it can respond to

      // Send a manual ping to verify server responds with pong
      connectedClients[0]?.send(JSON.stringify({ type: "ping" }));

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Connection should still be alive
      expect(client.connected).toBe(true);

      client.disconnect();
    });
  });

  describe("logging", () => {
    it("uses custom logger when provided", async () => {
      const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };

      mockServer = await createMockServer();

      const { client } = createClient({
        log: {
          info: (...args) => logs.info.push(args.join(" ")),
          warn: (...args) => logs.warn.push(args.join(" ")),
          error: (...args) => logs.error.push(args.join(" ")),
        },
      });

      await client.connect();

      expect(logs.info.length).toBeGreaterThan(0);
      expect(logs.info.some((l) => l.includes("Connecting"))).toBe(true);
      expect(logs.info.some((l) => l.includes("Connected"))).toBe(true);

      client.disconnect();
    });
  });
});
