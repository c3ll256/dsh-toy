/**
 * DG-LAB Coyote V3 protocol layer — pure functions and constants.
 *
 * This module contains no networking code; it can be unit-tested in isolation.
 * All protocol details (command formats, frame structure, QR payload, strength
 * mapping) live here so the connection layer stays clean.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toFile as qrToFile } from 'qrcode'
import { ToyError } from '../types.ts'

// ─── Protocol constants ──────────────────────────────────────────────────────

/** Maximum characters of a single WebSocket JSON frame (official V3 spec). */
export const MAX_MESSAGE_LENGTH = 1950

/** Maximum waveform entries per pulse command (conservative below the official 100). */
export const MAX_PULSE_PER_SEND = 70

/** Expected length of each pulse hex string (8 bytes = 16 hex chars per V3 spec). */
export const PULSE_HEX_LENGTH = 16

/** QR code URL prefix required by the DG-LAB app. */
export const QR_URL_BASE = 'https://www.dungeon-lab.com/app-download.php'

/** QR code tag identifying the DGLAB-SOCKET protocol. */
export const QR_TAG = 'DGLAB-SOCKET'

/** Device-reported default strength limit. */
export const DEFAULT_STRENGTH_LIMIT = 200

// ─── Channel and mode types ──────────────────────────────────────────────────

/** Channel identifier for strength and clear commands (1 = A, 2 = B). */
export type StrengthChannel = '1' | '2'

/** Strength change mode (0 = decrement, 1 = increment, 2 = set absolute). */
export type StrengthMode = '0' | '1' | '2'

/** Channel identifier for pulse commands (A or B). */
export type PulseChannel = 'A' | 'B'

// ─── Command generation ──────────────────────────────────────────────────────

/**
 * Build a strength command string.
 * Format: `strength-{channel}+{mode}+{value}` (value 0-200).
 */
export function strengthCmd(channel: StrengthChannel, mode: StrengthMode, value: number): string {
  const clamped = Math.max(0, Math.min(DEFAULT_STRENGTH_LIMIT, Math.round(value)))
  return `strength-${channel}+${mode}+${clamped}`
}

/**
 * Build a clear-queue command string.
 * Format: `clear-{channel}` (channel 1 = A, 2 = B).
 */
export function clearCmd(channel: StrengthChannel): string {
  return `clear-${channel}`
}

/**
 * Build a pulse (waveform) command string, capping the array length and total
 * JSON frame size to stay within the 1950-character protocol limit.
 *
 * Format: `pulse-{channel}:{hexArrayJson}`.
 * Each hex string must be exactly 16 hex chars (8 bytes: 4 frequency + 4 intensity).
 *
 * @param messageBudget - Maximum length of the command string (message field).
 *   Callers should pass `MAX_MESSAGE_LENGTH - frameEnvelopeLength` so the
 *   *entire* JSON frame — not just the message field — fits within the limit.
 *   Defaults to `MAX_MESSAGE_LENGTH` for backward compatibility.
 * @throws {ToyError} if any hex string is not 16 characters long.
 */
export function pulseCmd(channel: PulseChannel, hexArray: string[], messageBudget = MAX_MESSAGE_LENGTH): string {
  for (const hex of hexArray) {
    if (hex.length !== PULSE_HEX_LENGTH) {
      throw new ToyError(`DG-LAB pulse hex must be ${PULSE_HEX_LENGTH} chars (8 bytes), got ${hex.length}: ${hex}`)
    }
  }
  const capped = hexArray.slice(0, MAX_PULSE_PER_SEND)
  const cmd = `pulse-${channel}:${JSON.stringify(capped)}`
  if (cmd.length <= messageBudget) return cmd
  // Binary search for the largest sub-array that fits within the budget.
  let lo = 1
  let hi = capped.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2)
    const candidate = `pulse-${channel}:${JSON.stringify(capped.slice(0, mid))}`
    if (candidate.length <= messageBudget) lo = mid
    else hi = mid - 1
  }
  return `pulse-${channel}:${JSON.stringify(capped.slice(0, lo))}`
}

// ─── Strength mapping ────────────────────────────────────────────────────────

/** Result of mapping intensity percentage to per-channel device strength. */
export interface StrengthMapping {
  /** Target strength for channel A (0-limitA). */
  a: number
  /** Target strength for channel B (0-limitB). */
  b: number
}

/**
 * Map an intensity percentage (0-100) to device strength values (0-200),
 * clamped to both the configured maximum and the device-reported per-channel limits.
 *
 * @param intensityPercent - Caller-supplied percentage (0-100, clamped internally).
 * @param maxStrength - Configured maximum strength (typically 200).
 * @param limitA - Device-reported maximum for channel A.
 * @param limitB - Device-reported maximum for channel B.
 * @returns Clamped strength values for both channels.
 */
export function mapIntensityToStrength(
  intensityPercent: number,
  maxStrength: number,
  limitA: number,
  limitB: number,
): StrengthMapping {
  const target = Math.max(0, Math.min(
    maxStrength,
    Math.round(intensityPercent * maxStrength / 100),
  ))
  const safeLimitA = Math.max(0, limitA)
  const safeLimitB = Math.max(0, limitB)
  return {
    a: Math.min(target, safeLimitA),
    b: Math.min(target, safeLimitB),
  }
}

// ─── WebSocket frame helpers ─────────────────────────────────────────────────

/** Frame types defined by the official V3 socket protocol. */
export type WsFrameType = 'heartbeat' | 'bind' | 'msg' | 'break' | 'error'

/** Valid frame type strings for runtime validation. */
const WS_FRAME_TYPES = new Set<string>(['heartbeat', 'bind', 'msg', 'break', 'error'])

/** Standard V3 protocol message envelope. */
export interface WsFrame {
  type: WsFrameType
  clientId: string
  targetId: string
  message: string
}

/** Serialize a V3 protocol frame to a JSON string. */
export function frame(type: WsFrameType, clientId: string, targetId: string, message: string): string {
  return JSON.stringify({ type, clientId, targetId, message })
}

/** Parse a raw string into a V3 protocol frame, or return undefined if malformed. */
export function parseFrame(raw: string): WsFrame | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const obj = value as Record<string, unknown>
    const type = obj['type']
    const clientId = obj['clientId']
    const targetId = obj['targetId']
    const message = obj['message']
    if (typeof type !== 'string' || typeof clientId !== 'string'
      || typeof targetId !== 'string' || typeof message !== 'string') return undefined
    // Runtime-validate the frame type to avoid unsafe casts.
    if (!WS_FRAME_TYPES.has(type)) return undefined
    return { type: type as WsFrameType, clientId, targetId, message }
  } catch {
    return undefined
  }
}

/** Parse an App strength-feedback message: `strength-{A}+{B}+{Alimit}+{Blimit}`.
 * All values are clamped to 0–200 to prevent a malicious App from injecting
 * oversized limits that would bypass strength clamping downstream. */
export function parseStrengthFeedback(message: string): { a: number; b: number; limitA: number; limitB: number } | undefined {
  const match = message.match(/^strength-(\d+)\+(\d+)\+(\d+)\+(\d+)$/)
  if (match === null) return undefined
  const a = Number(match[1])
  const b = Number(match[2])
  const limitA = Number(match[3])
  const limitB = Number(match[4])
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(limitA) || !Number.isFinite(limitB)) return undefined
  return {
    a: Math.max(0, Math.min(DEFAULT_STRENGTH_LIMIT, a)),
    b: Math.max(0, Math.min(DEFAULT_STRENGTH_LIMIT, b)),
    limitA: Math.max(0, Math.min(DEFAULT_STRENGTH_LIMIT, limitA)),
    limitB: Math.max(0, Math.min(DEFAULT_STRENGTH_LIMIT, limitB)),
  }
}

// ─── Configuration ───────────────────────────────────────────────────────────

/** Configuration owned by the DG-LAB Coyote provider. */
export interface DgLabConfig {
  /** TCP port for the WebSocket server (0 = random ephemeral). */
  listenPort: number
  /** Hostname or IP embedded in the QR code (must be reachable from the phone). */
  publicHost: string
  /** WebSocket protocol scheme for the QR code URL. */
  wsScheme: 'ws' | 'wss'
  /** Heartbeat broadcast interval in milliseconds. */
  heartbeatIntervalMs: number
  /** Maximum strength value (0-200) mapped from 100% intensity. */
  maxStrength: number
  /** Timeout for waiting the App to bind during scan, in milliseconds. */
  readyTimeoutMs: number
}

// ─── QR code helpers ─────────────────────────────────────────────────────────

/**
 * Build the QR code payload string expected by the DG-LAB app.
 * Format: `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#{wsUrl}/{controlId}`
 */
export function buildQrPayload(wsUrl: string, controlId: string): string {
  const cleanUrl = wsUrl.replace(/\/$/, '')
  return [QR_URL_BASE, QR_TAG, `${cleanUrl}/${controlId}`].join('#')
}

/** Generate a QR code PNG file and return the absolute path. */
export async function generateQrImage(payload: string, controlId: string): Promise<string> {
  const safeId = controlId.replaceAll(/[^a-zA-Z0-9-]/g, '') || 'unknown'
  const filePath = join(tmpdir(), `dglab-qr-${safeId}.png`)
  await qrToFile(filePath, payload, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 400,
  })
  return filePath
}
