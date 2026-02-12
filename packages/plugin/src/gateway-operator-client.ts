// ---------------------------------------------------------------------------
// Gateway Operator Client
// Implements full Gateway protocol for operator role connections
// Handles device identity, challenge signing, and proper handshake
// ---------------------------------------------------------------------------

import WebSocket from "ws";
import type { CloseEvent as WebSocketCloseEvent, MessageEvent as WebSocketMessageEvent } from "ws";
import { DeviceIdentity, loadOrGenerateDeviceIdentity, signMessage, getPublicKeyHex } from "./identity.js";
import { readGatewayConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Protocol Message Types
// ---------------------------------------------------------------------------

/**
 * Gateway challenge message - sent after initial connection
 */
export interface ConnectChallengeMessage {
  type: "connect.challenge";
  nonce: string;
  ts: number;
}

/**
 * Operator connect request - responds to challenge with signature
 */
export interface ConnectRequestMessage {
  type: "req";
  id: string;
  method: "connect";
  params: ConnectParams;
}

/** 
 * Connect parameters for operator role
 */
export interface ConnectParams {
  role: "operator";
  scopes: string[];
  caps: string[];
  commands: string[];
  permissions: Record<string, unknown>;
  client: {
    id: string;
    version: string;
    platform: string;
    mode: string;
  };
  device?: {
    id: string;
    publicKey: string; // hex-encoded public key
    signature: string; // hex-encoded signature of nonce
    signedAt: number; // timestamp
    nonce: string; // challenge nonce
  };
  minProtocol: number;
  maxProtocol: number;
  locale: string;
  userAgent: string;
  auth?: {
    token: string;
  };
}

/**
 * Gateway hello-ok response - successful handshake
 */
export interface HelloOkMessage {
  type: "hello-ok";
  result: {
    protocol: number;
    serverVersion: string;
    deviceId?: string;
  };
}

/**
 * Gateway error response
 */
export interface ErrorMessage {
  type: "error" | "connect.error";
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * RPC event message (forwarded from Gateway)
 */
export interface EventMessage {
  type: "event";
  event: string;
  payload: Record<string, unknown>;
}

/**
 * RPC request from Gateway
 */
export interface RpcRequestMessage {
  type: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/**
 * RPC response message
 */
export interface RpcResponseMessage {
  type: "res" | "req.error";
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * System presence event (operator appears in Gateway UI)
 */
export interface SystemPresenceEvent {
  type: "event";
  event: "system-presence";
  payload: {
    deviceId: string;
    status: "online" | "offline";
    capabilities: string[];
  };
}

/**
 * Exec approval request from Gateway
 */
export interface ExecApprovalRequest {
  type: "req";
  id: string;
  method: "exec.approval";
  params: {
    sessionKey: string;
    command: string[];
    cwd?: string;
    env?: Record<string, string>;
    reason?: string;
  };
}

// Union type for all Gateway messages
type GatewayMessage =
  | ConnectChallengeMessage
  | HelloOkMessage
  | ErrorMessage
  | EventMessage
  | RpcRequestMessage
  | RpcResponseMessage
  | { type: "ping" }
  | { type: "pong" };

// ---------------------------------------------------------------------------
// Client Options
// ---------------------------------------------------------------------------

export interface GatewayOperatorClientOptions {
  /** Account ID for logging and tracking */
  accountId: string;
  /** Callback when Gateway sends an event */
  onEvent?: (event: EventMessage) => void;
  /** Callback when exec approval request is received */
  onExecApproval?: (request: ExecApprovalRequest) => void;
  /** Callback when connection is established */
  onConnected?: () => void;
  /** Callback when connection is lost */
  onDisconnected?: (reason?: string) => void;
  /** Callback for error logging */
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  /** Optional: Array of response IDs or ID patterns to log warnings for (default: logs all) */
  logUnknownResponseIds?: string[];
}

// ---------------------------------------------------------------------------
// Pending RPC Request Tracker
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Main Gateway Operator Client
// ---------------------------------------------------------------------------

/**
 * GatewayOperatorClient - Full Gateway protocol implementation
 *
 * Connects to OpenClaw Gateway as an operator with proper device identity
 * and challenge-response authentication.
 *
 * Features:
 * - Ed25519 device keypair generation/storage
 * - Challenge-response authentication
 * - Protocol version negotiation
 * - Auto-reconnect with exponential backoff
 * - Event streaming (agent events, system-presence, etc.)
 * - RPC request/response handling
 * - Exec approval request handling
 */
export class GatewayOperatorClient {
  private readonly accountId: string;
  private readonly onEvent: (event: EventMessage) => void;
  private readonly onExecApproval: (request: ExecApprovalRequest) => void;
  private readonly onConnected: () => void;
  private readonly onDisconnected: (reason?: string) => void;
  private readonly log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };

  private config: ReturnType<typeof readGatewayConfig>;
  private identity: DeviceIdentity;

  private ws: WebSocket | null = null;
  private _connected = false;
  private _handshakeComplete = false;
  private _serverVersion: string | null = null;
  private _protocolVersion: number | null = null;

  private pendingRequests: Map<string, PendingRequest> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private intentionalClose = false;

  private requestCounter = 0;
  private readonly requestTimeoutMs = 30000;
  private readonly logUnknownResponseIds?: string[];

  constructor(options: GatewayOperatorClientOptions) {
    this.accountId = options.accountId;
    this.onEvent = options.onEvent ?? (() => {});
    this.onExecApproval = options.onExecApproval ?? (() => {});
    this.onConnected = options.onConnected ?? (() => {});
    this.onDisconnected = options.onDisconnected ?? (() => {});
    this.log = options.log ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    this.logUnknownResponseIds = options.logUnknownResponseIds;

    // Load configuration and identity
    this.config = readGatewayConfig();
    this.identity = loadOrGenerateDeviceIdentity(this.config.deviceKeyPath);

    this.log.info(`[GatewayOperatorClient] Device ID: ${this.identity.deviceId}`);
    this.log.info(`[GatewayOperatorClient] Public key: ${getPublicKeyHex(this.identity).substring(0, 16)}...`);
  }

  /**
   * Whether the WebSocket connection is established
   */
  get connected(): boolean {
    return this._connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Whether the handshake is complete and the client is ready for RPC
   */
  get ready(): boolean {
    return this.connected && this._handshakeComplete;
  }

  /**
   * Gateway server version (from hello-ok)
   */
  get serverVersion(): string | null {
    return this._serverVersion;
  }

  /**
   * Negotiated protocol version
   */
  get protocolVersion(): number | null {
    return this._protocolVersion;
  }

  /**
   * Device identity
   */
  get deviceId(): string {
    return this.identity.deviceId;
  }

  /**
   * Connect to Gateway and complete handshake
   */
  async connect(): Promise<void> {
    if (this.ws) {
      this.log.warn("[GatewayOperatorClient] Already connecting or connected");
      return;
    }

    this.intentionalClose = false;
    const url = this.config.url;
    this.log.info(`[GatewayOperatorClient] Connecting to ${url}`);

    return new Promise((resolve, reject) => {
      try {
        // Set Origin header for Gateway to validate (required for WebSocket connections)
        // For local connections, we use the URL as origin
        const origin = this.config.url.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
        
        this.ws = new WebSocket(url, {
          headers: {
            Origin: origin,
          },
        });
        this.ws.onopen = () => this.handleOpen(resolve, reject);
        this.ws.onmessage = (event: WebSocketMessageEvent) => this.handleMessage(event);
        this.ws.onerror = (error: unknown) => {
          let err: Error;
          if (error instanceof Error) {
            err = error;
          } else if (error && typeof error === 'object') {
            // ws library passes an object with error, code, etc.
            const errorObj = error as { error?: unknown; message?: string; code?: number };
            const message = errorObj.message || String(errorObj.error || 'Unknown WebSocket error');
            err = new Error(message);
            if (errorObj.code) {
              (err as Error & { code?: number }).code = errorObj.code;
            }
          } else {
            err = new Error(String(error));
          }
          this.handleWebSocketError(err, reject);
        };
        this.ws.onclose = (event) => this.handleClose(event as WebSocketCloseEvent);
      } catch (error) {
        this.cleanup();
        reject(error);
      }
    });
  }

  /**
   * Disconnect from Gateway
   */
  disconnect(): void {
    this.log.info("[GatewayOperatorClient] Disconnecting");
    this.intentionalClose = true;
    this.cleanup();
  }

  /**
   * Send RPC request and wait for response
   */
  async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.ready) {
      throw new Error("Gateway not connected or handshake not complete");
    }

    const id = this.nextRequestId();
    const request: RpcRequestMessage = {
      type: "req",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${id} timed out`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        this.ws?.send(JSON.stringify(request));
        this.log.info(`[GatewayOperatorClient] Sent RPC: ${method} (${id})`);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Handle WebSocket open event
   */
  private handleOpen(
    resolve: () => void,
    reject: (error: Error) => void,
  ): void {
    this._connected = true;
    this.log.info("[GatewayOperatorClient] WebSocket connected, waiting for challenge");

    // Start ping interval
    this.startPing();

    // Resolve the connect promise (handshake happens async)
    resolve();
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(event: WebSocketMessageEvent): void {
    // Handle both string and ArrayBuffer data
    const data = typeof event.data === 'string'
      ? event.data
      : Buffer.from(event.data as ArrayBuffer).toString();

    let message: GatewayMessage;
    try {
      message = JSON.parse(data);
    } catch {
      this.log.error(`[GatewayOperatorClient] Failed to parse message: ${data}`);
      return;
    }

    // Skip logging noisy message types (ping, pong, tick, etc.)
    const noisyTypes = ["ping", "pong", "tick", "res", "req.error"];
    const noisyEvents = ["health", "tick"]; // Event names to skip logging
    if (!noisyTypes.includes(message.type)) {
      // For event-type messages, show the actual event name (more useful)
      const logMessage = message.type === "event"
        ? `${message.type}:${message.event}`
        : message.type;
      // Skip logging health events (they are noisy periodic heartbeats)
      if (message.type === "event" && noisyEvents.includes(message.event)) {
        // Forward to event handler silently (do not log)
        this.onEvent(message as EventMessage);
        return;
      }
      this.log.info(`[GatewayOperatorClient] Received: ${logMessage}`);
    }

    // Handle events with special routing first
    if (message.type === "event") {
      const eventMsg = message as EventMessage;
      // Route connect.challenge event properly
      if (eventMsg.event === "connect.challenge") {
        const challengePayload = eventMsg.payload as { nonce: string; ts: number };
        this.handleChallenge({ type: "connect.challenge", nonce: challengePayload.nonce, ts: challengePayload.ts });
        return;
      }
      // Route hello-ok event properly
      if (eventMsg.event === "hello-ok") {
        const result = eventMsg.payload.result as { protocol: number; serverVersion: string; deviceId?: string };
        this.handleHelloOk({ type: "hello-ok", result });
        return;
      }
    }

    // Route message by type
    switch (message.type) {
      case "connect.challenge":
        this.handleChallenge(message);
        break;

      case "hello-ok":
        this.handleHelloOk(message);
        break;

      case "error":
      case "connect.error":
        this.handleErrorMessage(message);
        break;

      case "event":
        this.handleEvent(message);
        break;

      case "req":
        this.handleRpcRequest(message);
        break;

      case "res":
      case "req.error":
        this.handleRpcResponse(message);
        break;

      case "ping":
        this.sendPong();
        break;

      case "pong":
        // Ignore pong
        break;

      default:
        this.log.warn(`[GatewayOperatorClient] Unknown message type: ${(message as { type: string }).type}`);
    }
  }

  /**
   * Handle connect challenge from Gateway
   */
  private handleChallenge(challenge: ConnectChallengeMessage): void {
    this.log.info(`[GatewayOperatorClient] Received challenge: nonce=${challenge.nonce}`);

    if (!this.ws) {
      this.log.error("[GatewayOperatorClient] Cannot respond to challenge - no WebSocket");
      return;
    }

    // Build connect request
    // If using token auth, skip device identity authentication
    // If no token, use device-based challenge-response authentication
    let deviceParams;
    if (!this.config.token) {
      // Sign the challenge nonce + timestamp with our device key
      const signature = signMessage(challenge.nonce + challenge.ts, this.identity.keypair.privateKey);
      deviceParams = {
        id: this.identity.deviceId,
        publicKey: getPublicKeyHex(this.identity),
        signature: signature,
        signedAt: Date.now(),
        nonce: challenge.nonce,
      };
    }

    // Build connect request
    const connectRequest: ConnectRequestMessage = {
      type: "req",
      id: this.nextRequestId(),
      method: "connect",
      params: {
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
        caps: ["tool-events"],
        commands: [],
        permissions: {},
        client: {
          id: `webchat-ui`,
          version: "0.1.6",
          platform: "node",
          mode: "webchat",
        },
        ...(deviceParams && { device: deviceParams }),
        minProtocol: this.config.minProtocol,
        maxProtocol: this.config.maxProtocol,
        locale: "en-US",
        userAgent: "botschat/0.1.6",
        auth: this.config.token ? { token: this.config.token } : undefined,
      },
    };

    this.log.info("[GatewayOperatorClient] Sending connect response" + (this.config.token ? " with token" : " with device signature"));
    this.ws.send(JSON.stringify(connectRequest));
  }

  /**
   * Handle hello-ok response (handshake complete)
   */
  private handleHelloOk(message: HelloOkMessage): void {
    this.log.info(`[GatewayOperatorClient] Handshake complete: protocol=${message.result.protocol} version=${message.result.serverVersion}`);

    this._handshakeComplete = true;
    this._protocolVersion = message.result.protocol;
    this._serverVersion = message.result.serverVersion;

    this.backoffMs = 1000; // Reset backoff on successful connection
    this.onConnected();

    // Send system-presence event to announce ourselves
    this.sendSystemPresence();
  }

  /**
   * Handle error message from Gateway
   */
  private handleErrorMessage(message: ErrorMessage): void {
    const errorCode = message.error.code;
    const errorMessage = message.error.message ?? "";

    this.log.error(`[GatewayOperatorClient] Gateway error: ${errorCode} ${errorMessage}`);

    if (errorCode === 401) {
      // Auth failed - disconnect
      this.log.error("[GatewayOperatorClient] Authentication failed, disconnecting");
      this.disconnect();
    }
  }

  /**
   * Handle WebSocket error event from ws library
   */
  private handleWebSocketError(error: Error, reject?: (error: Error) => void): void {
    this.log.error(`[GatewayOperatorClient] WebSocket error: ${error.message}`);
    if (reject) {
      reject(error);
    }
  }

  /**
   * Handle event from Gateway
   */
  private handleEvent(event: EventMessage): void {
    // Skip logging health events to reduce spam
    if (event.event === "health") {
      // Forward to event handler silently
      this.onEvent(event);
      return;
    }

    this.log.info(`[GatewayOperatorClient] Event: ${event.event}`);

    // Forward to event handler
    this.onEvent(event);

    // Handle specific event types
    if (event.event === "system-presence") {
      this.log.info(`[GatewayOperatorClient] System presence: ${JSON.stringify(event.payload)}`);
    }
  }

  /**
   * Handle RPC request from Gateway (e.g., exec.approval)
   */
  private handleRpcRequest(request: RpcRequestMessage): void {
    this.log.info(`[GatewayOperatorClient] RPC request: ${request.method}`);

    if (request.method === "exec.approval") {
      const approvalRequest = request as unknown as ExecApprovalRequest;
      this.onExecApproval(approvalRequest);
    } else {
      this.log.warn(`[GatewayOperatorClient] Unknown RPC method: ${request.method}`);
    }
  }

  /**
   * Handle RPC response
   */
  private handleRpcResponse(response: RpcResponseMessage): void {
    // Skip responses that don't match our request ID pattern
    // Our IDs are always "req_<counter>_<timestamp>", so any UUID or other ID is from another client
    // Gateway broadcasts responses to all clients, even if they weren't the requester
    if (!response.id.startsWith('req_')) {
      // Only log warnings for IDs explicitly configured (empty array = log all)
      if (this.logUnknownResponseIds && this.logUnknownResponseIds.length > 0) {
        const shouldLog = this.logUnknownResponseIds.some(pattern => {
          if (pattern.includes('*')) {
            // Support wildcard patterns like "logs.*"
            const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
            return regex.test(response.id);
          }
          return response.id === pattern;
        });
        if (shouldLog) {
          this.log.warn(`[GatewayOperatorClient] No pending request for ${response.id}`);
        }
      } else if (!this.logUnknownResponseIds) {
        // Default behavior: log all unknown responses
        this.log.warn(`[GatewayOperatorClient] No pending request for ${response.id}`);
      }
      return;
    }

    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      this.log.warn(`[GatewayOperatorClient] No pending request for ${response.id}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if (response.error) {
      const error = new Error(response.error.message || "RPC error");
      (error as Error & { code: number }).code = response.error.code;
      pending.reject(error);
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handle WebSocket close event
   */
  private handleClose(event: WebSocketCloseEvent): void {
    const wasConnected = this._connected;
    const wasHandshakeComplete = this._handshakeComplete;

    this._connected = false;
    this._handshakeComplete = false;

    this.log.info(`[GatewayOperatorClient] WebSocket closed: code=${event.code} reason=${event.reason}`);

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();

    this.cleanup();

    if (wasConnected && !this.intentionalClose) {
      // Schedule reconnect with exponential backoff
      this.scheduleReconnect();
    }

    if (wasConnected) {
      this.onDisconnected(event.reason);
    }
  }

  /**
   * Send pong in response to ping
   */
  private sendPong(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "pong" }));
    }
  }

  /**
   * Send system-presence event to announce operator status
   */
  private sendSystemPresence(): void {
    if (!this.ready) return;

    const presence: EventMessage = {
      type: "event",
      event: "system-presence",
      payload: {
        deviceId: this.identity.deviceId,
        status: "online",
        capabilities: ["operator.read", "operator.write", "operator.admin"],
      },
    };

    this.ws?.send(JSON.stringify(presence));
    this.log.info("[GatewayOperatorClient] Sent system-presence");
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 30000); // Ping every 30 seconds
  }

  /**
   * Stop ping interval
   */
  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    const delay = this.backoffMs;
    this.log.info(`[GatewayOperatorClient] Reconnecting in ${delay}ms...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (error) {
        this.log.error(`[GatewayOperatorClient] Reconnect failed: ${error}`);
        // Increase backoff
        this.backoffMs = Math.min(this.backoffMs * 2, 30000);
        // Try again
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.stopPing();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

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

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();
  }

  /**
   * Generate next request ID
   */
  private nextRequestId(): string {
    return `req_${this.requestCounter++}_${Date.now()}`;
  }
}

export default GatewayOperatorClient;
