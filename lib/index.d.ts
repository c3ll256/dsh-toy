import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/types.d.ts
/** Provider kinds supported by dsh-toy. */
type ToyProvider = 'buttplug' | 'monsterparty';
/** Hardware identity supplied by the user so the plugin can select the transport. */
interface ToyTarget {
  /** Optional brand, useful when a model name is ambiguous. */
  brand?: string;
  /** Exact product model printed in the app, packaging, or device label. */
  model: string;
}
/** Safety-reviewed scalar actuator kinds exposed to the model. */
type ToyFeatureKind = 'vibrate' | 'oscillate' | 'constrict' | 'inflate' | 'suction';
/** One controllable scalar feature reported by a backend. */
interface ToyFeature {
  /** Backend-stable identity while the device remains connected. */
  id: string;
  /** Generic action supported by this feature. */
  kind: ToyFeatureKind;
  /** Human-readable hardware description. */
  description: string;
}
/** One currently available device. */
interface ToyDevice {
  /** Opaque identity accepted by control and stop operations. */
  id: string;
  /** Protocol-provided device name. */
  name: string;
  /** Optional user-assigned display name. */
  displayName?: string;
  /** Controllable scalar features. */
  features: ToyFeature[];
}
/** Successful provider connection information. */
interface ToyConnection {
  /** Active provider. */
  provider: ToyProvider;
  /** Remote server or device name. */
  serverName: string;
  /** Devices already known at connection time. */
  devices: ToyDevice[];
}
/** One safety-bounded scalar command. */
interface ToyLevelCommand {
  /** Target device identity. */
  deviceId: string;
  /** Optional exact feature; omission targets every compatible feature. */
  featureId?: string;
  /** Requested scalar action. */
  kind: ToyFeatureKind;
  /** Integer percentage in the inclusive range 0-100. */
  intensityPercent: number;
}
/** Provider interface consumed by the safety runtime. */
interface ToyBackend {
  /** Provider discriminator. */
  readonly provider: ToyProvider;
  /** Establish a connection and return the initial device snapshot. */
  connect(signal: AbortSignal, target?: ToyTarget): Promise<ToyConnection>;
  /** Discover devices for the configured bounded interval. */
  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]>;
  /** Return a fresh device snapshot without network discovery. */
  list(): ToyDevice[];
  /** Apply one normalized scalar command. */
  setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void>;
  /** Stop one device or every device when the id is omitted. */
  stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void>;
  /** Stop owned output, close transport resources, and reach quiescence. */
  close(): Promise<void>;
}
/** Error for invalid state, unsupported hardware, or protocol failures. */
declare class ToyError extends Error {
  /** @param message - Actionable operator or model-facing failure text. */
  constructor(message: string);
}
//#endregion
//#region src/buttplug.d.ts
/** Configuration owned by the Buttplug provider. */
interface ButtplugConfig {
  /** Intiface WebSocket endpoint. */
  url: string;
  /** Buttplug protocol major version. */
  protocolVersion: 3 | 4;
  /** WebSocket setup bound. */
  connectionTimeoutMs: number;
  /** One request/response bound. */
  requestTimeoutMs: number;
  /** Client name presented to Intiface. */
  clientName: string;
}
/** Parse a DeviceList body from Buttplug v3 or v4 into the public snapshot. */
declare function parseButtplugDeviceList(body: unknown, protocolVersion: 3 | 4): ToyDevice[];
/** Stateful Buttplug JSON client over an Intiface WebSocket server. */
declare class ButtplugBackend implements ToyBackend {
  private readonly config;
  readonly provider: "buttplug";
  private socket;
  private serverName;
  private nextId;
  private readonly pending;
  private readonly devices;
  private pingTimer;
  /** @param config - Validated transport and protocol configuration. */
  constructor(config: ButtplugConfig);
  connect(signal: AbortSignal): Promise<ToyConnection>;
  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]>;
  list(): ToyDevice[];
  setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void>;
  stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  private refreshDevices;
  private request;
  private receive;
  private applyEvent;
  private startPings;
  private stopPings;
  private loseConnection;
  private assertConnected;
}
//#endregion
//#region src/monsterparty.d.ts
/** Configuration owned by the MonsterParty provider. */
interface MonsterPartyConfig {
  /** Single-use token extracted from a remote share link. */
  sessionToken: string;
  /** API endpoint resolving token to WebSocket session details. */
  apiUrl: string;
  /** Origin expected by the MonsterParty WebSocket relay. */
  origin: string;
  /** User-Agent sent during WebSocket negotiation. */
  userAgent: string;
  /** HTTP and WebSocket setup bound. */
  connectionTimeoutMs: number;
  /** Device-ready handshake bound. */
  readyTimeoutMs: number;
  /** Application heartbeat interval. */
  heartbeatIntervalMs: number;
}
/** In-process MonsterParty client with application heartbeats and dual-motor mapping. */
declare class MonsterPartyBackend implements ToyBackend {
  private readonly config;
  readonly provider: "monsterparty";
  private socket;
  private senderFd;
  private pid;
  private keyType;
  private dualMotor;
  private ready;
  private heartbeat;
  private vibration;
  private suction;
  /** @param config - Validated remote-link and heartbeat configuration. */
  constructor(config: MonsterPartyConfig);
  connect(signal: AbortSignal): Promise<ToyConnection>;
  scan(_durationMs: number, signal: AbortSignal): Promise<ToyDevice[]>;
  list(): ToyDevice[];
  setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void>;
  stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  private resolveSession;
  private waitUntilReady;
  private sendLevels;
  private startHeartbeat;
  private stopHeartbeat;
  private markDisconnected;
  private assertReady;
}
//#endregion
//#region src/auto.d.ts
/** Decide the transport from the user-supplied brand and model, without exposing provider selection. */
declare function routeToyTarget(target: ToyTarget): ToyProvider;
/** Process settings for a plugin-owned Intiface Engine. */
interface IntifaceProcessConfig {
  executable: string;
  websocketUrl: string;
  startupTimeoutMs: number;
}
/** Own at most one Intiface Engine process and stop only the process it created. */
declare class IntifaceProcessManager {
  private readonly config;
  private child;
  constructor(config: IntifaceProcessConfig);
  start(signal: AbortSignal): Promise<void>;
  assertRunning(): void;
  close(): Promise<void>;
}
/** Buttplug backend that starts Intiface Engine only when the configured local endpoint refuses a connection. */
declare class ManagedButtplugBackend implements ToyBackend {
  private readonly processConfig;
  readonly provider: "buttplug";
  private readonly backend;
  private readonly process;
  constructor(config: ButtplugConfig, processConfig: IntifaceProcessConfig);
  connect(signal: AbortSignal): Promise<ToyConnection>;
  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]>;
  list(): ToyDevice[];
  setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void>;
  stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
/** Configuration for automatic selection between local hardware and MonsterParty remote links. */
interface AutoToyBackendConfig {
  buttplug: ButtplugConfig;
  intiface: IntifaceProcessConfig;
  monsterParty?: MonsterPartyConfig;
}
/** Select a backend from the exact model supplied at connection time. */
declare class AutoToyBackend implements ToyBackend {
  private readonly config;
  private active;
  private targetKey;
  constructor(config: AutoToyBackendConfig);
  get provider(): ToyProvider;
  connect(signal: AbortSignal, target?: ToyTarget): Promise<ToyConnection>;
  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]>;
  list(): ToyDevice[];
  setLevel(command: ToyLevelCommand, signal: AbortSignal): Promise<void>;
  stop(deviceId: string | undefined, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  private requireActive;
}
//#endregion
//#region src/runtime.d.ts
/** Deployment safety policy applied to every model-issued command. */
interface ToySafetyConfig {
  /** Duration used when a control call omits one. */
  defaultDurationSeconds: number;
  /** Hard upper duration bound. */
  maxDurationSeconds: number;
  /** Hard upper percentage bound. */
  maxIntensityPercent: number;
  /** Permit duration 0 to hold until a later stop. */
  allowHold: boolean;
}
/** Input accepted by the runtime control operation. */
interface RuntimeControlRequest {
  /** Target device identity. */
  deviceId: string;
  /** Optional exact feature identity. */
  featureId?: string;
  /** Scalar action. */
  kind: ToyFeatureKind;
  /** Requested percentage. */
  intensityPercent: number;
  /** Explicit duration, or the deployment default when omitted. */
  durationSeconds?: number;
}
/** Successful bounded control result. */
interface RuntimeControlResult {
  /** Target device identity. */
  deviceId: string;
  /** Scalar action applied. */
  kind: ToyFeatureKind;
  /** Applied percentage. */
  intensityPercent: number;
  /** Scheduled automatic stop, or null for a deployment-authorized hold. */
  autoStopSeconds: number | null;
}
/** Serializes transport operations and prevents stale auto-stop timers from stopping newer commands. */
declare class ToyRuntime {
  private readonly backend;
  private readonly safety;
  private readonly reportFailure;
  private tail;
  private readonly stopTimers;
  private disposing;
  /**
   * @param backend - Concrete transport provider.
   * @param safety - Validated duration and intensity policy.
   * @param reportFailure - Sink for asynchronous auto-stop failures.
   */
  constructor(backend: ToyBackend, safety: ToySafetyConfig, reportFailure: (error: unknown) => void);
  /** Establish the provider connection. */
  connect(target: ToyTarget, signal: AbortSignal): Promise<ToyConnection>;
  /** Run provider discovery for a bounded interval. */
  scan(durationMs: number, signal: AbortSignal): Promise<ToyDevice[]>;
  /** Read the latest in-memory device snapshot. */
  list(signal: AbortSignal): Promise<ToyDevice[]>;
  /** Apply policy, send a scalar command, and schedule its exact-generation auto-stop. */
  control(request: RuntimeControlRequest, signal: AbortSignal): Promise<RuntimeControlResult>;
  /** Stop one device or all devices and cancel only the corresponding timers. */
  stop(deviceId: string | undefined, signal: AbortSignal): Promise<void>;
  /** Disconnect without disposing the runtime, allowing a later reconnect. */
  disconnect(signal: AbortSignal): Promise<void>;
  /** Reject new operations, stop timers, and await provider shutdown. */
  close(): Promise<void>;
  private validateControl;
  private scheduleStop;
  private clearTimer;
  private clearTimers;
  private exclusive;
}
//#endregion
//#region src/index.d.ts
/** Cordis plugin name. */
declare const name = "dsh-toy";
/** Harness services required by the model-facing consumer. */
declare const inject: string[];
/** Complete deployment configuration; defaults are filled by Schemastery. */
interface Config {
  /** Local Intiface WebSocket endpoint. */
  buttplugUrl?: string;
  /** Negotiated Buttplug protocol major version. */
  buttplugProtocolVersion?: 3 | 4;
  /** MonsterParty token from the share-link path; never exposed as a tool argument. */
  monsterPartySessionToken?: string;
  /** MonsterParty token-resolution endpoint. */
  monsterPartyApiUrl?: string;
  /** MonsterParty relay Origin header. */
  monsterPartyOrigin?: string;
  /** Client identity presented to both connection backends. */
  clientName?: string;
  /** HTTP/WebSocket setup timeout. */
  connectionTimeoutMs?: number;
  /** Buttplug request timeout. */
  requestTimeoutMs?: number;
  /** Intiface Engine executable discovered through PATH unless overridden. */
  intifaceExecutable?: string;
  /** Time allowed for an automatically started Intiface Engine to listen. */
  intifaceStartupTimeoutMs?: number;
  /** MonsterParty device-ready timeout. */
  readyTimeoutMs?: number;
  /** MonsterParty application heartbeat interval. */
  heartbeatIntervalMs?: number;
  /** Buttplug discovery window. */
  scanDurationMs?: number;
  /** Duration used when toy_control omits one. */
  defaultDurationSeconds?: number;
  /** Hard command-duration cap. */
  maxDurationSeconds?: number;
  /** Hard command-intensity cap. */
  maxIntensityPercent?: number;
  /** Permit indefinite hold commands. */
  allowHold?: boolean;
}
declare const Config: z<Config>;
type ResolvedConfig = Required<Omit<Config, 'monsterPartySessionToken'>> & Pick<Config, 'monsterPartySessionToken'>;
/** Resolve configuration and fail plugin load on unsafe or incomplete values. */
declare function resolveConfig(config: Config): ResolvedConfig;
/** Register the connection, discovery, control, stop, and disconnect tools. */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { AutoToyBackend, type AutoToyBackendConfig, ButtplugBackend, type ButtplugConfig, Config, type IntifaceProcessConfig, IntifaceProcessManager, ManagedButtplugBackend, MonsterPartyBackend, type MonsterPartyConfig, type RuntimeControlRequest, type RuntimeControlResult, type ToyBackend, type ToyConnection, type ToyDevice, ToyError, type ToyFeature, type ToyFeatureKind, type ToyLevelCommand, type ToyProvider, ToyRuntime, type ToySafetyConfig, type ToyTarget, apply, inject, name, parseButtplugDeviceList, resolveConfig, routeToyTarget };