/**
 * DeepSeek Harness tools for safety-bounded Buttplug/Intiface and MonsterParty control.
 * @module dsh-toy
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { ButtplugBackend } from './buttplug.ts'
import { MonsterPartyBackend } from './monsterparty.ts'
import { ToyRuntime } from './runtime.ts'
import type { ToyBackend, ToyDevice, ToyFeatureKind } from './types.ts'

export { ButtplugBackend, parseButtplugDeviceList } from './buttplug.ts'
export type { ButtplugConfig } from './buttplug.ts'
export { MonsterPartyBackend } from './monsterparty.ts'
export type { MonsterPartyConfig } from './monsterparty.ts'
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
} from './types.ts'

/** Cordis plugin name. */
export const name = 'dsh-toy'

/** Harness services required by the model-facing consumer. */
export const inject = ['tools']

/** Complete deployment configuration; defaults are filled by Schemastery. */
export interface Config {
  /** Active transport provider. */
  provider?: 'buttplug' | 'monsterparty'
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
  /** Client identity presented to both providers. */
  clientName?: string
  /** HTTP/WebSocket setup timeout. */
  connectionTimeoutMs?: number
  /** Buttplug request timeout. */
  requestTimeoutMs?: number
  /** MonsterParty device-ready timeout. */
  readyTimeoutMs?: number
  /** MonsterParty application heartbeat interval. */
  heartbeatIntervalMs?: number
  /** Buttplug discovery window. */
  scanDurationMs?: number
  /** Duration used when toy_control omits one. */
  defaultDurationSeconds?: number
  /** Hard command-duration cap. */
  maxDurationSeconds?: number
  /** Hard command-intensity cap. */
  maxIntensityPercent?: number
  /** Permit indefinite hold commands. */
  allowHold?: boolean
}

export const Config: z<Config> = z.object({
  provider: z.union(['buttplug', 'monsterparty'] as const).default('buttplug'),
  buttplugUrl: z.string().default('ws://127.0.0.1:12345'),
  buttplugProtocolVersion: z.union([3, 4] as const).default(4),
  monsterPartySessionToken: z.string(),
  monsterPartyApiUrl: z.string().default('https://api.monsterparty.cc/main/v1/remote'),
  monsterPartyOrigin: z.string().default('https://www.monsterparty.cn'),
  clientName: z.string().default('dsh-toy'),
  connectionTimeoutMs: z.number().default(10_000),
  requestTimeoutMs: z.number().default(5_000),
  readyTimeoutMs: z.number().default(20_000),
  heartbeatIntervalMs: z.number().default(9_000),
  scanDurationMs: z.number().default(5_000),
  defaultDurationSeconds: z.number().default(30),
  maxDurationSeconds: z.number().default(300),
  maxIntensityPercent: z.number().default(100),
  allowHold: z.boolean().default(false),
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
  for (const key of ['connectionTimeoutMs', 'requestTimeoutMs', 'readyTimeoutMs', 'heartbeatIntervalMs', 'scanDurationMs'] as const) {
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
  if (resolved.provider === 'monsterparty' && (resolved.monsterPartySessionToken?.length ?? 0) === 0) {
    throw new Error('dsh-toy: monsterPartySessionToken is required for the monsterparty provider')
  }
  try {
    const url = new URL(resolved.provider === 'buttplug' ? resolved.buttplugUrl : resolved.monsterPartyApiUrl)
    const allowed = resolved.provider === 'buttplug' ? ['ws:', 'wss:'] : ['http:', 'https:']
    if (!allowed.includes(url.protocol)) throw new Error('unsupported URL protocol')
  } catch {
    throw new Error(`dsh-toy: invalid ${resolved.provider === 'buttplug' ? 'buttplugUrl' : 'monsterPartyApiUrl'}`)
  }
  return resolved
}

function createBackend(config: ResolvedConfig): ToyBackend {
  if (config.provider === 'monsterparty') {
    return new MonsterPartyBackend({
      sessionToken: config.monsterPartySessionToken!,
      apiUrl: config.monsterPartyApiUrl,
      origin: config.monsterPartyOrigin,
      userAgent: USER_AGENT,
      connectionTimeoutMs: config.connectionTimeoutMs,
      readyTimeoutMs: config.readyTimeoutMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
    })
  }
  return new ButtplugBackend({
    url: config.buttplugUrl,
    protocolVersion: config.buttplugProtocolVersion,
    connectionTimeoutMs: config.connectionTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    clientName: config.clientName,
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
    name: 'toy_connect',
    description: 'Connect to the configured toy provider. Secrets come only from plugin config and are never tool arguments.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true, enum: ['buttplug', 'monsterparty'] },
          serverName: { type: 'string', required: true },
          devices: { type: 'array', required: true, items: DEVICE_SCHEMA },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (_args, exec) => runtime.connect(exec.signal),
    presentCall: () => ({ card: 'generic', title: 'Connect toy provider', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'toy_scan',
    description: 'Scan for devices using the deployment-configured bounded discovery window.',
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
    description: 'Stop all output and disconnect the configured provider. A later toy_connect can reconnect.',
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
    presentCall: () => ({ card: 'generic', title: 'Disconnect toy provider', kind: 'other' }),
  }))
}
