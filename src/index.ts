/**
 * DeepSeek Harness tools for safety-bounded Buttplug/Intiface and MonsterParty control.
 * @module dsh-toy
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { AutoToyBackend } from './auto.ts'
import { ButtplugBackend } from './buttplug.ts'
import { DgLabBackend } from './dglab/index.ts'
import { MonsterPartyBackend } from './monsterparty.ts'
import { scanMacOSRawBle } from './macos-ble.ts'
import { ToyRuntime } from './runtime.ts'
import type { ToyBackend, ToyDevice, ToyFeatureKind } from './types.ts'

export { ButtplugBackend, parseButtplugDeviceList } from './buttplug.ts'
export type { ButtplugConfig } from './buttplug.ts'
export { AutoToyBackend, intifaceArguments, IntifaceProcessManager, ManagedButtplugBackend, routeToyTarget } from './auto.ts'
export type { AutoToyBackendConfig, IntifaceProcessConfig } from './auto.ts'
export { createIntifaceUserDeviceConfig } from './intiface-user-config.ts'
export { MACOS_RAW_BLE_SCANNER_SOURCE, parseRawBleScan, scanMacOSRawBle } from './macos-ble.ts'
export type { RawBleAdvertisement } from './macos-ble.ts'
export { extractIntifaceExecutable, installIntifaceEngine, selectIntifaceArtifact } from './intiface-download.ts'
export type { IntifaceArtifact } from './intiface-download.ts'
export { MonsterPartyBackend } from './monsterparty.ts'
export type { MonsterPartyConfig } from './monsterparty.ts'
export {
  DgLabBackend,
  strengthCmd,
  clearCmd,
  pulseCmd,
  mapIntensityToStrength,
  buildQrPayload,
  MAX_MESSAGE_LENGTH,
  MAX_PULSE_PER_SEND,
  DEFAULT_STRENGTH_LIMIT,
} from './dglab/index.ts'
export type { DgLabConfig, StrengthChannel, StrengthMode, PulseChannel } from './dglab/index.ts'
export { ToyRuntime } from './runtime.ts'
export type { RuntimeControlRequest, RuntimeControlResult, ToySafetyConfig } from './runtime.ts'
export { ToyError } from './types.ts'
export type {
  ToyBackend,
  ToyConnection,
  ToyDevice,
  ToyFeature,
  ToyFeatureKind,
  ToyLevelCommand,
  ToyProvider,
  ToyTarget,
} from './types.ts'

/** Cordis plugin name. */
export const name = 'dsh-toy'

/** Harness services required by the model-facing consumer. */
export const inject = ['tools']

/** Complete deployment configuration; defaults are filled by Schemastery. */
export interface Config {
  /** Local Intiface WebSocket endpoint. */
  buttplugUrl?: string
  /** Negotiated Buttplug protocol major version. */
  buttplugProtocolVersion?: 3 | 4
  /** MonsterParty token from the share-link path; never exposed as a tool argument. */
  monsterPartySessionToken?: string
  /** MonsterParty token-resolution endpoint. */
  monsterPartyApiUrl?: string
  /** MonsterParty relay Origin header. */
  monsterPartyOrigin?: string
  /** Client identity presented to both connection backends. */
  clientName?: string
  /** HTTP/WebSocket setup timeout. */
  connectionTimeoutMs?: number
  /** Buttplug request timeout. */
  requestTimeoutMs?: number
  /** Intiface Engine executable discovered through PATH unless overridden. */
  intifaceExecutable?: string
  /** Time allowed for an automatically started Intiface Engine to listen. */
  intifaceStartupTimeoutMs?: number
  /** Download a pinned, verified official Intiface Engine when no executable is installed. */
  intifaceAutoDownload?: boolean
  /** MonsterParty device-ready timeout. */
  readyTimeoutMs?: number
  /** MonsterParty application heartbeat interval. */
  heartbeatIntervalMs?: number
  /** Buttplug discovery window. */
  scanDurationMs?: number
  /** Read-only macOS CoreBluetooth discovery window for unknown hardware. */
  rawBleScanDurationMs?: number
  /** Duration used when toy_control omits one. */
  defaultDurationSeconds?: number
  /** Hard command-duration cap. */
  maxDurationSeconds?: number
  /** Hard command-intensity cap. */
  maxIntensityPercent?: number
  /** Permit indefinite hold commands. */
  allowHold?: boolean
  /** DG-LAB Coyote WebSocket server listen port (0 = random). */
  dgLabListenPort?: number
  /** DG-LAB Coyote public host or IP for QR code (must be reachable from the phone). */
  dgLabPublicHost?: string
  /** DG-LAB Coyote WebSocket scheme for the QR code URL. */
  dgLabWsScheme?: 'ws' | 'wss'
  /** DG-LAB Coyote heartbeat broadcast interval. */
  dgLabHeartbeatIntervalMs?: number
  /** DG-LAB Coyote maximum strength value (0-200). */
  dgLabMaxStrength?: number
  /** DG-LAB Coyote App binding wait timeout. */
  dgLabReadyTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  buttplugUrl: z.string().default('ws://127.0.0.1:12345'),
  buttplugProtocolVersion: z.union([3, 4] as const).default(4),
  monsterPartySessionToken: z.string(),
  monsterPartyApiUrl: z.string().default('https://api.monsterparty.cc/main/v1/remote'),
  monsterPartyOrigin: z.string().default('https://www.monsterparty.cn'),
  clientName: z.string().default('dsh-toy'),
  connectionTimeoutMs: z.number().default(10_000),
  requestTimeoutMs: z.number().default(5_000),
  intifaceExecutable: z.string().default('intiface-engine'),
  intifaceStartupTimeoutMs: z.number().default(10_000),
  intifaceAutoDownload: z.boolean().default(true),
  readyTimeoutMs: z.number().default(20_000),
  heartbeatIntervalMs: z.number().default(9_000),
  scanDurationMs: z.number().default(5_000),
  rawBleScanDurationMs: z.number().default(10_000),
  defaultDurationSeconds: z.number().default(30),
  maxDurationSeconds: z.number().default(300),
  maxIntensityPercent: z.number().default(100),
  allowHold: z.boolean().default(false),
  dgLabListenPort: z.number().default(0),
  dgLabPublicHost: z.string().default('127.0.0.1'),
  dgLabWsScheme: z.union(['ws', 'wss'] as const).default('ws'),
  dgLabHeartbeatIntervalMs: z.number().default(20_000),
  dgLabMaxStrength: z.number().default(200),
  dgLabReadyTimeoutMs: z.number().default(60_000),
})

type ResolvedConfig = Required<Omit<Config, 'monsterPartySessionToken'>> & Pick<Config, 'monsterPartySessionToken'>

const USER_AGENT = 'Mozilla/5.0 (compatible; dsh-toy/0.1; +https://github.com/deepseek-ai/deepseek-harness)'

function positiveInteger(config: ResolvedConfig, key: keyof ResolvedConfig): void {
  const value = config[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`dsh-toy: ${String(key)} must be a positive safe integer`)
  }
}

function nonNegativeNumber(config: ResolvedConfig, key: keyof ResolvedConfig): void {
  const value = config[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`dsh-toy: ${String(key)} must be a finite non-negative number`)
  }
}

/** Resolve configuration and fail plugin load on unsafe or incomplete values. */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved = config as ResolvedConfig
  for (const key of ['connectionTimeoutMs', 'requestTimeoutMs', 'intifaceStartupTimeoutMs', 'readyTimeoutMs', 'heartbeatIntervalMs', 'scanDurationMs', 'rawBleScanDurationMs', 'dgLabHeartbeatIntervalMs', 'dgLabReadyTimeoutMs'] as const) {
    positiveInteger(resolved, key)
  }
  for (const key of ['defaultDurationSeconds', 'maxDurationSeconds', 'maxIntensityPercent'] as const) {
    nonNegativeNumber(resolved, key)
  }
  if (resolved.defaultDurationSeconds > resolved.maxDurationSeconds) {
    throw new Error('dsh-toy: defaultDurationSeconds cannot exceed maxDurationSeconds')
  }
  if (!Number.isSafeInteger(resolved.maxIntensityPercent) || resolved.maxIntensityPercent > 100) {
    throw new Error('dsh-toy: maxIntensityPercent must be a safe integer from 0 to 100')
  }
  if (!Number.isSafeInteger(resolved.dgLabListenPort) || resolved.dgLabListenPort < 0 || resolved.dgLabListenPort > 65_535) {
    throw new Error('dsh-toy: dgLabListenPort must be 0 (random) or a port from 1 to 65535')
  }
  if (!Number.isSafeInteger(resolved.dgLabMaxStrength) || resolved.dgLabMaxStrength < 0 || resolved.dgLabMaxStrength > 200) {
    throw new Error('dsh-toy: dgLabMaxStrength must be a safe integer from 0 to 200')
  }
  if (resolved.dgLabPublicHost.trim().length === 0) throw new Error('dsh-toy: dgLabPublicHost cannot be empty')
  for (const [key, value, protocols] of [
    ['buttplugUrl', resolved.buttplugUrl, ['ws:', 'wss:']],
    ['monsterPartyApiUrl', resolved.monsterPartyApiUrl, ['http:', 'https:']],
  ] as const) {
    try {
      if (!protocols.some(protocol => protocol === new URL(value).protocol)) throw new Error('unsupported URL protocol')
    } catch {
      throw new Error(`dsh-toy: invalid ${key}`)
    }
  }
  if (resolved.intifaceExecutable.trim().length === 0) throw new Error('dsh-toy: intifaceExecutable cannot be empty')
  return resolved
}

function createBackend(config: ResolvedConfig): ToyBackend {
  return new AutoToyBackend({
    buttplug: {
      url: config.buttplugUrl,
      protocolVersion: config.buttplugProtocolVersion,
      connectionTimeoutMs: config.connectionTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      clientName: config.clientName,
    },
    intiface: {
      executable: config.intifaceExecutable,
      websocketUrl: config.buttplugUrl,
      startupTimeoutMs: config.intifaceStartupTimeoutMs,
      autoDownload: config.intifaceAutoDownload,
      useBuiltinUserDeviceConfig: true,
    },
    ...((config.monsterPartySessionToken?.length ?? 0) === 0 ? {} : { monsterParty: {
      sessionToken: config.monsterPartySessionToken!,
      apiUrl: config.monsterPartyApiUrl,
      origin: config.monsterPartyOrigin,
      userAgent: USER_AGENT,
      connectionTimeoutMs: config.connectionTimeoutMs,
      readyTimeoutMs: config.readyTimeoutMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
    } }),
    dgLab: {
      listenPort: config.dgLabListenPort,
      publicHost: config.dgLabPublicHost,
      wsScheme: config.dgLabWsScheme,
      heartbeatIntervalMs: config.dgLabHeartbeatIntervalMs,
      maxStrength: config.dgLabMaxStrength,
      readyTimeoutMs: config.dgLabReadyTimeoutMs,
    },
  })
}

const FEATURE_KINDS = ['vibrate', 'oscillate', 'constrict', 'inflate', 'suction'] as const satisfies readonly ToyFeatureKind[]

const DEVICE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    id: { type: 'string' as const, required: true },
    name: { type: 'string' as const, required: true },
    displayName: { type: 'string' as const },
    features: {
      type: 'array' as const,
      required: true,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          id: { type: 'string' as const, required: true },
          kind: { type: 'string' as const, required: true, enum: FEATURE_KINDS },
          description: { type: 'string' as const, required: true },
        },
      },
    },
  },
} as const

const RAW_BLE_DEVICE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    id: { type: 'string' as const, required: true },
    name: { type: 'string' as const },
    rssi: { type: 'number' as const, required: true },
    connectable: { type: 'boolean' as const, required: true },
    manufacturerData: { type: 'string' as const },
    services: { type: 'array' as const, items: { type: 'string' as const } },
  },
} as const

function devicesValue(devices: ToyDevice[]): ToyDevice[] {
  return devices
}

/** Register the connection, discovery, control, stop, and disconnect tools. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const runtime = new ToyRuntime(createBackend(resolved), {
    defaultDurationSeconds: resolved.defaultDurationSeconds,
    maxDurationSeconds: resolved.maxDurationSeconds,
    maxIntensityPercent: resolved.maxIntensityPercent,
    allowHold: resolved.allowHold,
  }, error => { ctx.logger.warn(`dsh-toy automatic stop failed: ${String(error)}`) })

  ctx.effect(() => () => runtime.close(), 'dsh-toy transport teardown')

  ctx.tools.register(defineTool({
    name: 'toy_scan_raw_ble',
    description: 'On macOS, use this first when the user genuinely does not know the toy brand or model. It bypasses Intiface and performs read-only CoreBluetooth discovery of connectable raw BLE advertisements. It does not connect, control, or write characteristics. Use an unambiguous observed advertised name as hardware evidence for a later toy_connect call; if several candidates are plausible, ask the user to power-cycle the toy and rescan instead of guessing. Raw ids are never accepted by toy_control. On other platforms or when the Swift toolchain is unavailable, fall back to toy_connect with model "unknown".',
    parameters: {},
    output: {
      schema: { type: 'array', items: RAW_BLE_DEVICE_SCHEMA },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (_args, exec) => scanMacOSRawBle(resolved.rawBleScanDurationMs, exec.signal),
    presentCall: () => ({ card: 'generic', title: 'Scan raw Bluetooth LE advertisements', kind: 'search' }),
  }))

  ctx.tools.register(defineTool({
    name: 'toy_connect',
    description: 'Before the first connection, ask once for the toy brand and model. Pass the user-reported values even when they are not on a known list. When the user genuinely does not know, use toy_scan_raw_ble first on macOS; use an observed advertised name as hardware evidence, or pass "unknown" only when raw discovery is unavailable or inconclusive. Never guess a protocol, probe arbitrary BLE characteristics, or ask the user to choose a backend, install Intiface, or start Intiface. The tool selects the connection, includes verified compatibility mappings for supported unlisted devices, downloads a verified official Intiface Engine when missing, and starts it automatically. Secrets come only from plugin config.',
    parameters: {
      model: { type: 'string', required: true, description: 'Product model reported by the user, or "unknown" when they explicitly do not know it. Do not guess.' },
      brand: { type: 'string', description: 'Brand reported by the user, when known.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serverName: { type: 'string', required: true },
          devices: { type: 'array', required: true, items: DEVICE_SCHEMA },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      const connection = await runtime.connect({
        model: args.model,
        ...(args.brand === undefined ? {} : { brand: args.brand }),
      }, exec.signal)
      return { serverName: connection.serverName, devices: connection.devices }
    },
    presentCall: args => ({ card: 'generic', title: `Connect ${args.model}`, kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'toy_scan',
    description: 'After toy_connect has selected and connected the user-confirmed or unknown model, scan for devices using the bounded discovery window. Only verified protocols are returned; an empty result does not authorize guessing commands or writing arbitrary BLE data.',
    parameters: {},
    output: {
      schema: { type: 'array', items: DEVICE_SCHEMA },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (_args, exec) => devicesValue(await runtime.scan(resolved.scanDurationMs, exec.signal)),
    presentCall: () => ({ card: 'generic', title: 'Scan for toys', kind: 'search' }),
  }))

  ctx.tools.register(defineTool({
    name: 'toy_list',
    description: 'List currently known devices and their safe scalar features without starting a scan.',
    parameters: {},
    output: {
      schema: { type: 'array', items: DEVICE_SCHEMA },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (_args, exec) => devicesValue(await runtime.list(exec.signal)),
    presentCall: () => ({ card: 'generic', title: 'List toys', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'toy_control',
    description: `Set a scalar toy feature from 0-${resolved.maxIntensityPercent}%. Commands auto-stop by default; duration 0 is ${resolved.allowHold ? 'enabled' : 'disabled'}.`,
    parameters: {
      device_id: { type: 'string', required: true, description: 'Opaque id returned by toy_list or toy_scan.' },
      feature_id: { type: 'string', description: 'Optional exact feature id. Omit to target all matching features.' },
      kind: { type: 'string', required: true, enum: FEATURE_KINDS, description: 'Scalar action supported by the target feature.' },
      intensity_percent: { type: 'number', required: true, description: `Integer percentage from 0 to ${resolved.maxIntensityPercent}.` },
      duration_seconds: { type: 'number', description: `Seconds before automatic stop. Omit for ${resolved.defaultDurationSeconds}; maximum ${resolved.maxDurationSeconds}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deviceId: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: FEATURE_KINDS },
          intensityPercent: { type: 'number', required: true },
          autoStopSeconds: {
            oneOf: [{ type: 'number' }, { type: 'null' }],
            required: true,
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => runtime.control({
      deviceId: args.device_id,
      ...(args.feature_id === undefined ? {} : { featureId: args.feature_id }),
      kind: args.kind,
      intensityPercent: args.intensity_percent,
      ...(args.duration_seconds === undefined ? {} : { durationSeconds: args.duration_seconds }),
    }, exec.signal),
    presentCall: args => ({
      card: 'generic',
      title: `Set toy ${args.kind} to ${args.intensity_percent}%`,
      kind: 'other',
      rawInput: { deviceId: args.device_id, durationSeconds: args.duration_seconds },
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'toy_stop',
    description: 'Immediately stop one device, or every connected device when device_id is omitted.',
    parameters: {
      device_id: { type: 'string', description: 'Opaque device id. Omit for the global emergency stop.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stopped: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      await runtime.stop(args.device_id, exec.signal)
      return { stopped: args.device_id ?? 'all' }
    },
    presentCall: args => ({ card: 'generic', title: args.device_id === undefined ? 'Stop all toys' : 'Stop toy', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'toy_disconnect',
    description: 'Stop all output, disconnect the toy, and stop any Intiface Engine process started by this plugin. A later toy_connect can reconnect.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { disconnected: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (_args, exec) => {
      await runtime.disconnect(exec.signal)
      return { disconnected: true }
    },
    presentCall: () => ({ card: 'generic', title: 'Disconnect toy', kind: 'other' }),
  }))
}
