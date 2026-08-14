/** Provider kinds supported by dsh-toy. */
export type ToyProvider = 'buttplug' | 'monsterparty'

/** Hardware identity supplied by the user so the plugin can select the transport. */
export interface ToyTarget {
  /** Optional brand, useful when a model name is ambiguous. */
  brand?: string
  /** Exact product model printed in the app, packaging, or device label. */
  model: string
}

/** Safety-reviewed scalar actuator kinds exposed to the model. */
export type ToyFeatureKind = 'vibrate' | 'oscillate' | 'constrict' | 'inflate' | 'suction'

/** One controllable scalar feature reported by a backend. */
export interface ToyFeature {
  /** Backend-stable identity while the device remains connected. */
  id: string
  /** Generic action supported by this feature. */
  kind: ToyFeatureKind
  /** Human-readable hardware description. */
  description: string
}

/** One currently available device. */
export interface ToyDevice {
  /** Opaque identity accepted by control and stop operations. */
  id: string
  /** Protocol-provided device name. */
  name: string
  /** Optional user-assigned display name. */
  displayName?: string
  /** Controllable scalar features. */
  features: ToyFeature[]
}

/** Successful provider connection information. */
export interface ToyConnection {
  /** Active provider. */
  provider: ToyProvider
  /** Remote server or device name. */
  serverName: string
  /** Devices already known at connection time. */
  devices: ToyDevice[]
}

/** One safety-bounded scalar command. */
export interface ToyLevelCommand {
  /** Target device identity. */
  deviceId: string
  /** Optional exact feature; omission targets every compatible feature. */
  featureId?: string
  /** Requested scalar action. */
  kind: ToyFeatureKind
  /** Integer percentage in the inclusive range 0-100. */
  intensityPercent: number
}

/** Provider interface consumed by the safety runtime. */
export interface ToyBackend {
  /** Provider discriminator. */
  readonly provider: ToyProvider
  /** Establish a connection and return the initial device snapshot. */
  connect(signal: AbortSignal, target?: ToyTarget): Promise<ToyConnection>
  /** Discover devices for the configured bounded interval. */
  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]>
  /** Return a fresh device snapshot without network discovery. */
  list(): ToyDevice[]
  /** Apply one normalized scalar command. */
  setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void>
  /** Stop one device or every device when the id is omitted. */
  stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void>
  /** Stop owned output, close transport resources, and reach quiescence. */
  close(): Promise<void>
}

/** Error for invalid state, unsupported hardware, or protocol failures. */
export class ToyError extends Error {
  /** @param message - Actionable operator or model-facing failure text. */
  constructor(message: string) {
    super(message)
    this.name = 'ToyError'
  }
}

/** Return a detached device snapshot safe for callers to retain. */
export function cloneDevices(devices: Iterable<ToyDevice>): ToyDevice[] {
  return [...devices].map(device => ({
    id: device.id,
    name: device.name,
    ...(device.displayName === undefined ? {} : { displayName: device.displayName }),
    features: device.features.map(feature => ({
      id: feature.id,
      kind: feature.kind,
      description: feature.description,
    })),
  }))
}
