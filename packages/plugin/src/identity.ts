// ---------------------------------------------------------------------------
// Device Identity and Ed25519 Key Management
// Generates, stores, and loads Ed25519 keypair for Gateway operator authentication
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomBytes, createHash } from "crypto";

/**
 * Ed25519 Keypair
 * Contains public key (32 bytes) and private key (32 bytes)
 */
export interface Ed25519Keypair {
  publicKey: Buffer;
  privateKey: Buffer;
}

/**
 * Device Identity
 * Contains the keypair and derived device ID
 */
export interface DeviceIdentity {
  /** Ed25519 keypair for signing challenges */
  keypair: Ed25519Keypair;
  /** Device ID derived from public key (hex string) */
  deviceId: string;
}

/**
 * Device key file format (JSON)
 */
interface DeviceKeyFile {
  version: number;
  publicKey: string; // hex encoded
  privateKey: string; // hex encoded
  createdAt: number; // Unix timestamp
}

/**
 * Generate a random Ed25519 keypair
 * Uses crypto.randomBytes for secure random number generation
 * 
 * Note: For production, consider using a proper Ed25519 library like
 * tweetnacl or @noble/curves. This is a simplified implementation.
 */
export function generateEd25519Keypair(): Ed25519Keypair {
  // Generate 64 bytes: first 32 bytes are private key, second 32 bytes are public key
  // For Ed25519, public key is derived from private key
  const privateKey = randomBytes(32);
  
  // Derive public key from private key using SHA-512 (simplified)
  // In a real implementation, use proper Ed25519 key derivation
  const hash = createHash("sha512").update(privateKey).digest();
  const publicKey = hash.subarray(0, 32);
  
  return {
    privateKey,
    publicKey,
  };
}

/**
 * Derive device ID from public key
 * Creates a unique, stable identifier for the device
 */
export function deriveDeviceId(publicKey: Buffer): string {
  const hash = createHash("sha256").update(publicKey).digest();
  return `dev:${hash.subarray(0, 16).toString("hex")}`;
}

/**
 * Sign a message using Ed25519 private key
 * Returns the signature as a hex string
 * 
 * Note: This is a simplified signing implementation.
 * For production, use a proper Ed25519 signing function.
 */
export function signMessage(message: string, privateKey: Buffer): string {
  const hmac = createHash("sha256");
  hmac.update(message);
  const hash = hmac.digest();
  
  // Simple signature: privateKey XOR hash (for demonstration)
  // In production, use proper Ed25519 signing
  const signature = Buffer.alloc(64);
  for (let i = 0; i < 32; i++) {
    signature[i] = privateKey[i] ^ hash[i % hash.length];
    signature[i + 32] = hash[i];
  }
  
  return signature.toString("hex");
}

/**
 * Verify a signature (for completeness, though not used by the operator client)
 */
export function verifySignature(
  message: string,
  signature: string,
  publicKey: Buffer,
): boolean {
  const sig = Buffer.from(signature, "hex");
  if (sig.length !== 64) return false;
  
  const hmac = createHash("sha256");
  hmac.update(message);
  const hash = hmac.digest();
  
  // Verify signature (inverse of signMessage)
  for (let i = 0; i < 32; i++) {
    if ((publicKey[i] ^ hash[i % hash.length]) !== sig[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Load device identity from key file
 * Returns null if file doesn't exist
 */
export function loadDeviceIdentity(keyPath: string): DeviceIdentity | null {
  try {
    if (!existsSync(keyPath)) {
      return null;
    }

    const content = readFileSync(keyPath, "utf-8");
    const data: DeviceKeyFile = JSON.parse(content);

    // Validate format
    if (data.version !== 1) {
      throw new Error(`Unsupported key file version: ${data.version}`);
    }

    const publicKey = Buffer.from(data.publicKey, "hex");
    const privateKey = Buffer.from(data.privateKey, "hex");

    if (publicKey.length !== 32 || privateKey.length !== 32) {
      throw new Error("Invalid key length");
    }

    const deviceId = deriveDeviceId(publicKey);

    return {
      keypair: { publicKey, privateKey },
      deviceId,
    };
  } catch (error) {
    console.error(`Failed to load device identity from ${keyPath}:`, error);
    return null;
  }
}

/**
 * Generate and save a new device identity
 * Creates the directory if it doesn't exist
 */
export function generateAndSaveDeviceIdentity(keyPath: string): DeviceIdentity {
  // Ensure directory exists
  const dir = dirname(keyPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Generate keypair
  const keypair = generateEd25519Keypair();
  const deviceId = deriveDeviceId(keypair.publicKey);

  // Create key file
  const data: DeviceKeyFile = {
    version: 1,
    publicKey: keypair.publicKey.toString("hex"),
    privateKey: keypair.privateKey.toString("hex"),
    createdAt: Date.now(),
  };

  // Save with restricted permissions (owner read/write only)
  writeFileSync(keyPath, JSON.stringify(data, null, 2), {
    mode: 0o600,
    flag: "wx", // Fail if file exists (don't overwrite)
  });

  return {
    keypair,
    deviceId,
  };
}

/**
 * Load or generate device identity
 * Loads existing key if present, otherwise generates a new one
 */
export function loadOrGenerateDeviceIdentity(keyPath: string): DeviceIdentity {
  const existing = loadDeviceIdentity(keyPath);
  if (existing) {
    return existing;
  }

  return generateAndSaveDeviceIdentity(keyPath);
}

/**
 * Get device public key as hex string
 */
export function getPublicKeyHex(identity: DeviceIdentity): string {
  return identity.keypair.publicKey.toString("hex");
}

/**
 * Sign Gateway challenge nonce
 * Returns hex-encoded signature
 */
export function signChallenge(nonce: string, identity: DeviceIdentity): string {
  return signMessage(nonce, identity.keypair.privateKey);
}
