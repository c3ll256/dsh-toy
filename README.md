# dsh-toy

[![CI](https://github.com/c3ll256/dsh-toy/actions/workflows/ci.yml/badge.svg)](https://github.com/c3ll256/dsh-toy/actions/workflows/ci.yml)

English | [简体中文](README.zh-CN.md)

`dsh-toy` is a DeepSeek Harness plugin for connecting small toys to DSH.

At connection time, the agent first asks for the brand and model, then selects the connection method automatically. If the user genuinely does not know, the agent starts unknown-hardware discovery:

- On macOS, unknown hardware first uses read-only raw **CoreBluetooth** advertisement discovery, without starting Intiface or connecting to devices.
- Regular Bluetooth, serial, and USB models use **Buttplug / Intiface**. The plugin starts local Intiface Engine automatically when needed.
- Known sharing-link models from Ankni (安可尼), MizzZee (谜姬), and Zuiqingfeng (醉清风) use **MonsterParty**. Known dual-output devices expose their channels separately.

Users do not need to understand or select an underlying connection method, or manually start Intiface.

Brand and model names are not an allowlist. The agent passes any user-reported name through unchanged; unfamiliar names still use local hardware discovery. The plugin also supplies a verified local compatibility mapping for `RoomFun` devices reporting model `RF_CANNON_PT3`, exposed as **RoomFun Cannon** with one vibration channel.

The implementation follows protocol observations from [Chemtrails](https://github.com/Kristenkristen/Chemtrails), together with the device model and message formats documented by [Buttplug](https://github.com/buttplugio/buttplug) and the [Buttplug Protocol Specification](https://buttplug.io/docs/spec/). This repository contains an independent TypeScript implementation; see [NOTICE](NOTICE) for attribution.

## Guardrails

- Sharing tokens stay in plugin configuration and never appear in model-visible tool arguments or results.
- Raw BLE discovery is read-only: it scans connectable advertisements without connecting or writing characteristics.
- Output stops automatically after 30 seconds by default.
- Zero-duration holds are disabled unless `allowHold: true` is explicitly configured.
- `maxIntensityPercent` and `maxDurationSeconds` are enforced before backend dispatch.
- A newer command replaces the previous automatic-stop timer for the same device.
- `toy_stop` without a device id performs a global stop.
- Plugin unload, HMR, and `toy_disconnect` stop output and await WebSocket shutdown.

Use only hardware you own or are explicitly authorized to control. Treat sharing tokens as temporary control credentials and keep them out of Git, logs, and conversations.

## Install

Requirements: Node.js 22.19 or newer and pnpm on `PATH`. Raw macOS BLE discovery additionally uses the Swift compiler from Xcode Command Line Tools. Install pnpm once if needed with `npm install --global pnpm@10`, then add the plugin directly from GitHub:

```sh
npx -y @deepseek-ai/dsh plugin --profile web add github:c3ll256/dsh-toy
```

Start DSH with the same profile:

```sh
npx -y @deepseek-ai/dsh web
```

The first command installs and activates the bundle persistently in the `web` profile. Re-running DSH does not reinstall it. To inspect the composed configuration or remove the bundle:

```sh
npx -y @deepseek-ai/dsh --profile web --dump-config
npx -y @deepseek-ai/dsh plugin --profile web remove dsh-toy
```

Replace `web` with another profile name when needed.

## Quick start

You can tell the agent directly:

```text
My toy is a Lovense Lush 3. Connect it and scan for devices.
```

When the brand or model is unknown, say:

```text
I do not know the brand or model. Try Bluetooth discovery directly.
```

On macOS, the agent first calls `toy_scan_raw_ble`. If the scan exposes a plausible advertised name, it uses that hardware-reported name for `toy_connect`; otherwise it falls back to `unknown`, connects Intiface automatically, and scans verified protocols. Before scanning, turn the toy on, keep it nearby, and make sure a phone app or another program is not holding the device connection.

## Automatic selection and connection

Before calling `toy_connect`, the agent must ask for the model and pass it to the tool, together with the brand when known. When the user does not know, macOS first runs `toy_scan_raw_ble` directly through CoreBluetooth. A discovered advertisement name is hardware evidence and may be passed to `toy_connect`; raw BLE ids are never controllable device ids. If raw discovery is unavailable or inconclusive, the agent passes `unknown` and the system tries the Intiface fallback. The tool never asks the user to select an underlying protocol.

For a brand or model that is not already documented, the agent follows the same path: pass the reported text to `toy_connect`, then call `toy_scan`. It must not guess a protocol or write arbitrary BLE characteristics. Discovery returns only devices covered by an upstream Intiface definition or a compatibility mapping that has been verified against hardware. An empty scan means the device remains unsupported or unavailable, not that the agent should probe it destructively.

For local Bluetooth, serial, and USB devices, the system first tries an existing Intiface server. If `127.0.0.1:12345` refuses the connection, the plugin runs:

```sh
intiface-engine --websocket-port 12345 --use-bluetooth-le --use-serial --use-hid
```

The plugin first looks for Intiface Engine on `PATH`. If it is not installed, it downloads a pinned build from the official Buttplug GitHub Release, verifies its SHA-256 digest, caches it in the user cache directory, and starts it. Set `intifaceAutoDownload: false` to disable downloads or `intifaceExecutable` to use another path. On disconnect or unload, the plugin stops only the process it started; it does not stop an Intiface server that was already running.

When the plugin starts Intiface itself, it writes its verified compatibility mappings to a private temporary user-device-config file and removes that file on shutdown. An Intiface server that was already running keeps its own configuration; stop that server first if a built-in compatibility mapping is needed.

Automatic downloads currently support macOS ARM64, Linux x64/ARM64, and Windows x64. On other platforms, use `intifaceExecutable` to point to an installed engine. The first scan on macOS may request Bluetooth permission; allow the terminal or application running DSH to access Bluetooth.

The bundled defaults use:

```yaml
- id: dsh-toy
  config:
    buttplugProtocolVersion: 4
    intifaceExecutable: intiface-engine
    intifaceAutoDownload: true
    rawBleScanDurationMs: 10000
    defaultDurationSeconds: 30
    maxDurationSeconds: 300
    maxIntensityPercent: 100
    allowHold: false
```

Set `buttplugProtocolVersion: 3` for an older Intiface server. The system exposes percentage-compatible scalar features advertised by the connected device.

## MonsterParty

Store the token from a supported sharing link in an environment variable:

```dotenv
MONSTERPARTY_TOKEN=<TOKEN>
```

Then override the plugin row in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-toy
  config:
    monsterPartySessionToken: !!js process.env.MONSTERPARTY_TOKEN
    defaultDurationSeconds: 30
    maxDurationSeconds: 300
    maxIntensityPercent: 100
    allowHold: false
```

Sharing tokens are commonly single-use and expire after disconnection. Generate a new link before reconnecting.

## Model-facing tools

| Tool | Purpose |
|---|---|
| `toy_scan_raw_ble` | On macOS, discover connectable raw BLE advertisements without Intiface or device writes |
| `toy_connect` | Connect from the reported model; use `unknown` when it is not known |
| `toy_scan` | Discover available devices |
| `toy_list` | List device ids and controllable features |
| `toy_control` | Send a bounded scalar command |
| `toy_stop` | Stop one device or all devices |
| `toy_disconnect` | Stop output and close the connection |

Known model: `toy_connect` → `toy_scan` → `toy_list` → `toy_control` → `toy_stop` → `toy_disconnect`.

Unknown model on macOS: `toy_scan_raw_ble` → use an advertised name as evidence → `toy_connect` → `toy_scan`. If raw discovery is unavailable or inconclusive, continue with `toy_connect(model: "unknown")`.

## Troubleshooting

- `spawn intiface-engine ENOENT`: update to a release with automatic download support, ensure `intifaceAutoDownload: true`, and confirm GitHub is reachable.
- The scan is empty: enable system Bluetooth, charge and power on the nearby toy, and disconnect any phone app or other controller using it.
- Intiface starts but scanning fails: check that the operating system granted Bluetooth access to DSH or its terminal.
- Raw BLE discovery cannot build its helper: install Xcode Command Line Tools with `xcode-select --install`, or use the Intiface fallback.
- MonsterParty rejects the connection: the sharing token may be used or expired; generate a fresh link and reconnect.

## Known limitations

- The MonsterParty connection implements the relay behavior and `AKN_DS_SUCKEGG` mapping documented by Chemtrails. Vendor-side protocol changes may require an update.
- The built-in RoomFun mapping is hardware-verified for BLE name `RoomFun`, model identifier `RF_CANNON_PT3`, firmware `4.3`, and one vibration output. Other RoomFun models are not assumed compatible.
- Raw BLE advertisement discovery is macOS-only and requires the Swift compiler from Xcode Command Line Tools. It is read-only discovery, not a generic unknown-device control protocol.
- The Buttplug connection currently exposes scalar features only; position, direction, sensors, raw access, and subscriptions are outside the current scope.
- Tests use local protocol fixtures rather than physical hardware.
- Device ids should be refreshed with `toy_list` after reconnection.

## Development

```sh
pnpm install
pnpm run check
```

## Acknowledgements

Thanks to [Chemtrails](https://github.com/Kristenkristen/Chemtrails) and [Buttplug](https://github.com/buttplugio/buttplug) for their protocol research, documentation, and open-source work.

## License

BSD-3-Clause. See [LICENSE](LICENSE).
