# dsh-toy

English | [简体中文](README.zh-CN.md)

`dsh-toy` is an installable DeepSeek Harness bundle for connecting selected personal haptics and interactive hardware to model-driven workflows.

It supports two providers:

- **Buttplug / Intiface** connects to a local Intiface Central or Intiface Engine WebSocket server. Protocol v4 is the default, with an optional v3 compatibility mode.
- **MonsterParty** uses a short-lived sharing token from supported brands such as Ankni (安可尼), MizzZee (谜姬), and Zuiqingfeng (醉清风). Known dual-output devices expose their channels separately.

The implementation follows protocol observations from [Chemtrails](https://github.com/Kristenkristen/Chemtrails), together with the device model and message formats documented by [Buttplug](https://github.com/buttplugio/buttplug) and the [Buttplug Protocol Specification](https://buttplug.io/docs/spec/). This repository contains an independent TypeScript implementation; see [NOTICE](NOTICE) for attribution.

## Guardrails

- Sharing tokens stay in plugin configuration and never appear in model-visible tool arguments or results.
- Output stops automatically after 30 seconds by default.
- Zero-duration holds are disabled unless `allowHold: true` is explicitly configured.
- `maxIntensityPercent` and `maxDurationSeconds` are enforced before provider dispatch.
- A newer command replaces the previous automatic-stop timer for the same device.
- `toy_stop` without a device id performs a global stop.
- Plugin unload, HMR, and `toy_disconnect` stop output and await WebSocket shutdown.

Use only hardware you own or are explicitly authorized to control. Treat sharing tokens as temporary control credentials and keep them out of Git, logs, and conversations.

## Development

```sh
pnpm install
pnpm run check
```

Requirements: Node.js 22.19 or newer and pnpm 10.

## Install into a Harness profile

From a checkout of this repository:

```sh
dsh plugin --profile web add .
dsh --profile web --dump-config
dsh --profile web
```

Replace `web` with another profile name when needed. Remove the bundle with:

```sh
dsh plugin --profile web remove dsh-toy
```

## Buttplug / Intiface

Start Intiface Central or Intiface Engine and enable its WebSocket server. The bundled defaults use:

```yaml
- id: dsh-toy
  config:
    provider: buttplug
    buttplugProtocolVersion: 4
    defaultDurationSeconds: 30
    maxDurationSeconds: 300
    maxIntensityPercent: 100
    allowHold: false
```

Set `buttplugProtocolVersion: 3` for an older Intiface server. The provider exposes percentage-compatible scalar features advertised by the connected device.

## MonsterParty

Store the token from a supported sharing link in an environment variable:

```dotenv
MONSTERPARTY_TOKEN=<TOKEN>
```

Then override the plugin row in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-toy
  config:
    provider: monsterparty
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
| `toy_connect` | Connect the configured provider |
| `toy_scan` | Discover available devices |
| `toy_list` | List device ids and controllable features |
| `toy_control` | Send a bounded scalar command |
| `toy_stop` | Stop one device or all devices |
| `toy_disconnect` | Stop output and close the connection |

Typical sequence: `toy_connect` → `toy_scan` → `toy_list` → `toy_control` → `toy_stop` → `toy_disconnect`.

## Known limitations

- The MonsterParty provider implements the relay behavior and `AKN_DS_SUCKEGG` mapping documented by Chemtrails. Vendor-side protocol changes may require an update.
- The Buttplug provider currently exposes scalar features only; position, direction, sensors, raw access, and subscriptions are outside the current scope.
- Tests use local protocol fixtures rather than physical hardware.
- Device ids should be refreshed with `toy_list` after reconnection.

## License

BSD-3-Clause. See [LICENSE](LICENSE).
