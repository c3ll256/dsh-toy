/**
 * DG-LAB Coyote V3 provider — unified re-export of protocol and connection layers.
 *
 * Consumers import from `./dglab` (this file); the internal split into
 * `protocol.ts` (pure functions) and `backend.ts` (WebSocket lifecycle) is
 * an implementation detail.
 */

export { DgLabBackend } from './backend.ts'
export type { DgLabConfig } from './protocol.ts'

export {
  MAX_MESSAGE_LENGTH,
  MAX_PULSE_PER_SEND,
  PULSE_HEX_LENGTH,
  DEFAULT_STRENGTH_LIMIT,
  strengthCmd,
  clearCmd,
  pulseCmd,
  mapIntensityToStrength,
  buildQrPayload,
  generateQrImage,
  frame,
  parseFrame,
  parseStrengthFeedback,
} from './protocol.ts'

export type {
  StrengthChannel,
  StrengthMode,
  PulseChannel,
  WsFrameType,
  WsFrame,
  StrengthMapping,
} from './protocol.ts'
