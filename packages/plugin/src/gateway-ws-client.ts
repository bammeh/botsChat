/**
 * GatewayWsClient - WebSocket client for OpenClaw gateway
 * 
 * Connects to the OpenClaw gateway WebSocket to stream tool events
 * (start, update, result) without requiring verbose=full.
 */

export interface GatewayEventData {
  phase?: "start" | "update" | "result";
  name?: string;
  result?: unknown;
  text?: string;
  [key: string]: unknown;
}

export interface GatewayEventPayload {
  stream?: "reply" | "tool";
  data?: GatewayEventData;
  sessionKey?: string;
  runId?: string;
}

export interface GatewayEvent {
  type: "event";
  event: string;
  payload: GatewayEventPayload;
}

export interface GatewayWsClientOptions {
  port?: number;
  host?: string;
  token?: string;
  allowInsecureAuth?: boolean;
  accountId: string;
  onEvent: (frame: GatewayEvent) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ConnectChallenge {
  type: "connect.challenge";
  nonce: string;
  ts: number;
}

interface ConnectChallengeMessage {
  type: "connect.challenge";
  nonce: string;
  ts: number;
}

interface ConnectResponseMessage extends RpcResponse {
  type: "connect";
  status?: string;
}

interface RpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface RpcResponse {
  id?: string;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface RpcRequestMessage {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface RpcResponseMessage {
  id: string;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface EventMessage {
  type: "event";
  event: string;
  payload: GatewayEventPayload;
}

interface PongMessage {
  type: "pong";
}

type WsMessage =
  | EventMessage
  | RpcResponseMessage
  | ConnectChallengeMessage
  | ConnectResponseMessage
  | PongMessage
  | { type: string; [key: string]: unknown };

// Type guards for WsMessage discrimination
function isEventMessage(msg: WsMessage): msg is EventMessage {
  return typeof msg === "object" && msg !== null && "type" in msg && (msg as EventMessage).type === "event";
}

function isConnectChallenge(msg: WsMessage): msg is ConnectChallengeMessage {
  return typeof msg === "object" && msg !== null && "type" in msg && (msg as ConnectChallengeMessage).type === "connect.challenge";
}

function isConnectResponse(msg: WsMessage): msg is ConnectResponseMessage {
  return typeof msg === "object" && msg !== null && "type" in msg && (msg as ConnectResponseMessage).type === "connect";
}

function isRpcResponse(msg: WsMessage): msg is RpcResponseMessage {
  return typeof msg === "object" && msg !== null && "id" in msg && typeof (msg as RpcResponseMessage).id === "string" && (msg as RpcResponseMessage).id.length > 0;
}

function isPongMessage(msg: WsMessage): msg is PongMessage {
  return typeof msg === "object" && msg !== null && "type" in msg && (msg as PongMessage).type === "pong";
}

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Logger interface for GatewayWsClient
 */
interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Default logger (no-op)
 */
const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * GatewayWsClient - WebSocket client for OpenClaw gateway
 */
export class GatewayWsClient {
  private readonly port: number;
  private readonly host: string;
  private readonly token?: string;
  private readonly allowInsecureAuth: boolean;
  private readonly accountId: string;
  private readonly onEvent: (frame: GatewayEvent) => void;
  private readonly onConnected: () => void;
  private readonly onDisconnected: () => void;
  private readonly log: Logger;

  private ws: WebSocket | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestTimeoutMs = 30000;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private _connected = false;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  constructor(options: GatewayWsClientOptions) {
    this.port = options.port ?? 18789;
    this.host = options.host ?? "127.0.0.1";
    this.token = options.token;
    this.allowInsecureAuth = options.allowInsecureAuth ?? false;
    this.accountId = options.accountId;
    this.onEvent = options.onEvent;
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.log = options.log ?? noopLogger;
  }

  /**
   * Whether the WebSocket connection is established and authenticated
   */
  get connected(): boolean {
    return this._connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to the gateway WebSocket and complete the handshake
   */
  async connect(): Promise<void> {
    if (this.ws) {
      throw new Error("Already connected or connecting");
    }

    const url = `ws://${this.host}:${this.port}`;
    this.log.info("[GatewayWsClient] Connecting to", url);

    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      try {
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.onopen = () => this.handleOpen();
        ws.onmessage = (event) => this.handleMessage(event.data as string);
        ws.onerror = (error) => this.handleError(error);
        ws.onclose = (event) => this.handleClose(event);
      } catch (error) {
        this.cleanup();
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the gateway
   */
  disconnect(): void {
    this.log.info("[GatewayWsClient] Disconnecting");
    const wasConnected = this._connected;
    this.cleanup();
    if (wasConnected) {
      this.onDisconnected();
    }
  }

  /**
   * Send an RPC request and wait for response
   */
  async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      throw new Error("Not connected");
    }

    if (!this.ws) {
      throw new Error("WebSocket not connected");
    }

    const id = generateRequestId();
    const request: RpcRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${id} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const message = JSON.stringify(request);
      this.log.info("[GatewayWsClient] Sending RPC:", method, id);
      this.ws!.send(message);
    });
  }

  /**
   * Handle WebSocket open event
   */
  private handleOpen(): void {
    this.log.info("[GatewayWsClient] WebSocket opened, waiting for challenge");
    // Start ping interval to keep connection alive
    this.startPing();
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(data: string): void {
    let message: WsMessage;
    try {
      message = JSON.parse(data);
    } catch {
      this.log.error("[GatewayWsClient] Failed to parse message:", data);
      return;
    }

    // ADD THIS DEBUG LOG - trace all received messages
    this.log.info("[GatewayWsClient] Raw message received:", JSON.stringify(message));

    // Check if it's a challenge via direct check
    if ((message as Record<string, unknown>).type === "connect.challenge") {
      this.log.info("[GatewayWsClient] Challenge detected via direct check");
    }

    // Check type guard
    if (isConnectChallenge(message)) {
      this.log.info("[GatewayWsClient] Challenge detected via type guard");
    }

    this.log.info("[GatewayWsClient] Received message type:", "type" in message ? message.type : "rpc-response");

    // Handle connect challenge
    if (isConnectChallenge(message)) {
      this.handleChallenge(message);
      return;
    }

    // Handle connect response
    if (isConnectResponse(message)) {
      this.handleConnectResponse(message);
      return;
    }

    // Handle event frames
    if (isEventMessage(message)) {
      this.onEvent(message);
      return;
    }

    // Handle RPC responses
    if (isRpcResponse(message)) {
      this.handleRpcResponse(message);
      return;
    }

    // Handle pong
    if (isPongMessage(message)) {
      return;
    }

    this.log.warn("[GatewayWsClient] Unhandled message:", message);
  }

  /**
   * Handle connect challenge from gateway
   */
  private handleChallenge(challenge: ConnectChallenge): void {
    this.log.info("[GatewayWsClient] Received challenge, sending connect response");
    this.log.info("[GatewayWsClient] Handling challenge:", JSON.stringify(challenge));

    if (!this.ws) {
      this.log.error("[GatewayWsClient] Cannot respond to challenge - WebSocket not connected");
      this.failConnect(new Error("WebSocket not connected"));
      return;
    }

    // Check token value for debugging
    this.log.info("[GatewayWsClient] Token available:", this.token ? "yes (length: " + this.token.length + ")" : "no");
    this.log.info("[GatewayWsClient] allowInsecureAuth:", this.allowInsecureAuth);

    const connectPayload: {
      type: "req";
      id: string;
      method: "connect";
      params: {
        role: string;
        scopes: string[];
        client: { id: string; version: string; platform: string; mode: string };
        minProtocol: number;
        maxProtocol: number;
        auth?: { token: string };
        device: { id: string };
      };
    } = {
      type: "req",
      id: generateRequestId(),
      method: "connect",
      params: {
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        client: {
          id: `botschat-gateway-${this.accountId}`,
          version: "1.0.0",
          platform: "node",
          mode: "channel"
        },
        minProtocol: 3,
        maxProtocol: 3,
        device: { id: `botschat-gateway-${this.accountId}` }
      }
    };

    // Add auth to params if token provided
    if (this.token) {
      connectPayload.params.auth = { token: this.token };
    }

    this.log.info("[GatewayWsClient] Sending connect payload:", JSON.stringify(connectPayload));
    this.ws.send(JSON.stringify(connectPayload));
  }
  /**
   * Handle connect response from gateway
   */
  private handleConnectResponse(
    response: ConnectResponseMessage
  ): void {
    if (response.error) {
      const error = new Error(
        response.error.message || "Connect failed"
      );
      this.log.error("[GatewayWsClient] Connect failed:", response.error);
      this.failConnect(error);
      return;
    }

    if (response.status === "ok" || !response.error) {
      this.log.info("[GatewayWsClient] Connected successfully");
      this._connected = true;
      this.connectResolve?.();
      this.clearConnectCallbacks();
      this.onConnected();
      return;
    }

    this.failConnect(new Error("Unexpected connect response"));
  }

  /**
   * Handle RPC response
   */
  private handleRpcResponse(response: RpcResponse): void {
    if (!response.id) {
      this.log.warn("[GatewayWsClient] RPC response missing id");
      return;
    }
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      this.log.warn("[GatewayWsClient] No pending request for id:", response.id);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if (response.error) {
      const error = new Error(response.error.message || "RPC error");
      (error as Error & { code?: number; data?: unknown }).code = response.error.code;
      (error as Error & { code?: number; data?: unknown }).data = response.error.data;
      pending.reject(error);
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handle WebSocket error
   */
  private handleError(error: unknown): void {
    this.log.error("[GatewayWsClient] WebSocket error:", error);
    this.failConnect(new Error("WebSocket error"));
  }

  /**
   * Handle WebSocket close
   */
  private handleClose(event: CloseEvent): void {
    this.log.info(
      "[GatewayWsClient] WebSocket closed:",
      event.code,
      event.reason
    );
    
    const wasConnected = this._connected;
    this._connected = false;
    
    // Reject any pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();

    // Fail pending connect if any
    this.failConnect(new Error("Connection closed"));

    if (wasConnected) {
      this.onDisconnected();
    }

    this.cleanup();
  }

  /**
   * Fail the pending connect promise
   */
  private failConnect(error: Error): void {
    if (this.connectReject) {
      this.connectReject(error);
      this.clearConnectCallbacks();
    }
  }

  /**
   * Clear connect callbacks
   */
  private clearConnectCallbacks(): void {
    this.connectResolve = null;
    this.connectReject = null;
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop ping interval
   */
  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.stopPing();
    
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      
      this.ws = null;
    }

    // Reject any pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();

    this._connected = false;
    this.clearConnectCallbacks();
  }
}

export default GatewayWsClient;
