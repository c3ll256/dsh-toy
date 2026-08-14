# dsh-toy

[![CI](https://github.com/c3ll256/dsh-toy/actions/workflows/ci.yml/badge.svg)](https://github.com/c3ll256/dsh-toy/actions/workflows/ci.yml)

[English](README.md) | 简体中文

`dsh-toy` 是一个 DeepSeek Harness 插件，用于将小玩具接入 DSH。

连接时，agent 会先询问玩具的品牌和型号，再自动选择连接方式。如果用户确实不知道，agent 会进入未知硬件发现：

- 在 macOS 上，未知硬件会先通过只读的原始 **CoreBluetooth** 广播发现，不启动 Intiface，也不连接设备。
- 普通蓝牙、串口或 USB 型号通过 **Buttplug / Intiface** 连接；插件会在需要时自动启动本机 Intiface Engine。
- 安可尼、谜姬、醉清风等已知分享链接型号通过 **MonsterParty** 连接；已知双通道设备会分别暴露各个输出通道。
- **DG-LAB 郊狼**（Coyote 3.0）通过官方 V3 WebSocket 绑定协议连接。插件启动 WebSocket 服务端并生成二维码，用户用 DG-LAB App 扫码绑定后即可控制设备。

用户不需要理解或选择底层连接方式，也不需要手动启动 Intiface。

品牌和型号名称不是白名单。agent 会原样传递用户报告的名称；即使名称陌生，也会进入本地硬件发现。插件还为 BLE 名称为 `RoomFun`、型号标识为 `RF_CANNON_PT3` 的实机验证设备内置了兼容映射，并将其暴露为带一个振动通道的 **RoomFun Cannon**。

本实现参考了 [Chemtrails](https://github.com/Kristenkristen/Chemtrails) 发布的协议记录，以及 [Buttplug](https://github.com/buttplugio/buttplug) 和 [Buttplug Protocol Specification](https://buttplug.io/docs/spec/) 的设备抽象与消息格式。仓库中的 TypeScript 代码为独立实现，归属说明见 [NOTICE](NOTICE)。

## 安全限制

- 分享 token 只保存在插件配置中，不会出现在模型可见的工具参数或结果里。
- 原始 BLE 发现是只读操作：仅扫描可连接广播，不连接设备，也不写入特征。
- 默认在 30 秒后自动停止输出。
- 默认禁止零时长保持；只有显式配置 `allowHold: true` 才会启用。
- 连接后端收到命令前会执行 `maxIntensityPercent` 和 `maxDurationSeconds` 限制。
- 同一设备的新命令会替换旧的自动停止计时器。
- `toy_stop` 省略设备 id 时停止全部设备。
- 插件卸载、HMR 或 `toy_disconnect` 会停止输出并等待 WebSocket 关闭。

只控制你本人拥有或已获得明确授权的设备。分享 token 属于临时控制凭据，不要提交到 Git，也不要暴露在日志或对话中。

## 安装

运行要求：Node.js 22.19 或更高版本，并确保 `pnpm` 在 `PATH` 中。macOS 原始 BLE 发现还需要 Xcode Command Line Tools 提供的 Swift 编译器。如尚未安装 pnpm，先运行一次 `npm install --global pnpm@10`，然后直接从 GitHub 安装插件：

```sh
npx -y @deepseek-ai/dsh plugin --profile web add github:c3ll256/dsh-toy
```

使用同一个 profile 启动 DSH：

```sh
npx -y @deepseek-ai/dsh web
```

第一条命令会把 bundle 持久安装并启用到 `web` profile，之后启动 DSH 时无需重复安装。查看组合配置或移除 bundle：

```sh
npx -y @deepseek-ai/dsh --profile web --dump-config
npx -y @deepseek-ai/dsh plugin --profile web remove dsh-toy
```

需要其他 profile 时，将 `web` 替换为对应名称。

## 快速使用

可以直接告诉 agent：

```text
我的玩具是 Lovense Lush 3，请连接并扫描。
```

不知道品牌或型号时，也可以说：

```text
我不知道品牌和型号，请直接用蓝牙搜索。
```

在 macOS 上，agent 会先调用 `toy_scan_raw_ble`。如果扫描得到合理的广播名称，就把这个硬件报告的名称用于 `toy_connect`；否则回退为 `unknown`，自动连接 Intiface 并扫描已验证协议。扫描前请打开玩具、保持距离较近，并避免让手机 APP 或其他程序同时占用设备。

## 自动识别与连接

调用 `toy_connect` 前，agent 必须先询问用户的型号，并把型号（以及已知时的品牌）传给工具。用户不知道时，macOS 会先通过 CoreBluetooth 直接运行 `toy_scan_raw_ble`。扫描得到的广播名称属于硬件证据，可以传给 `toy_connect`；原始 BLE id 永远不能作为可控设备 id。原始扫描不可用或没有结论时，agent 再传入 `unknown`，系统尝试 Intiface 回退。工具不会让用户选择底层协议。

遇到文档中没有的品牌或型号时，agent 仍走同一路径：把用户报告的文本传给 `toy_connect`，然后调用 `toy_scan`。agent 不得猜测协议，也不得向任意 BLE 特征写入数据。扫描只返回已有 Intiface 上游定义或经过实机验证的兼容映射所覆盖的设备。空结果表示设备仍不受支持或当前不可用，不代表可以进行破坏性探测。

对于本地蓝牙、串口或 USB 设备，系统先尝试连接已有 Intiface 服务；如果 `127.0.0.1:12345` 拒绝连接，插件会自行运行：

```sh
intiface-engine --websocket-port 12345 --use-bluetooth-le --use-serial --use-hid
```

插件会先查找 `PATH` 中的 Intiface Engine。如果没有安装，默认会从 Buttplug 官方 GitHub Release 下载固定版本，校验 SHA-256 后保存到用户缓存目录并启动。可用 `intifaceAutoDownload: false` 禁用下载，或通过 `intifaceExecutable` 指定其他路径。插件只会在断开或卸载时终止由自己启动的进程，不会关闭用户原本已运行的 Intiface。

由插件自行启动 Intiface 时，会把经过验证的兼容映射写入权限受限的临时 user-device-config 文件，并在关闭时删除。已经运行的外部 Intiface 会继续使用自身配置；如需使用插件内置映射，应先停止该外部服务。

当前自动下载支持 macOS ARM64、Linux x64/ARM64 和 Windows x64。其他平台需通过 `intifaceExecutable` 指定已安装的引擎。macOS 首次扫描时可能会请求蓝牙权限，需允许运行 DSH 的终端或应用访问蓝牙。

bundle 默认配置为：

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

旧版 Intiface server 可设置 `buttplugProtocolVersion: 3`。系统会暴露连接设备声明的、可映射为百分比的标量 feature。

## MonsterParty

把受支持分享链接中的 token 保存到环境变量：

```dotenv
MONSTERPARTY_TOKEN=<TOKEN>
```

然后在 profile 的 `cordis.patch.yml` 中覆盖插件配置：

```yaml
- id: dsh-toy
  config:
    monsterPartySessionToken: !!js process.env.MONSTERPARTY_TOKEN
    defaultDurationSeconds: 30
    maxDurationSeconds: 300
    maxIntensityPercent: 100
    allowHold: false
```

分享 token 通常只能使用一次，并在断开后失效。重新连接前应生成新链接。

## DG-LAB 郊狼

DG-LAB 郊狼（Coyote 3.0）通过官方 V3 WebSocket 绑定协议连接，无需逆向蓝牙协议。

### 工作流程

1. agent 使用型号名称（如"我的郊狼"或"my Coyote"）调用 `toy_connect`。
2. 插件启动本地 WebSocket 服务端并生成二维码。
3. agent 将二维码展示给用户（图片文件或 URL）。
4. 用户在手机上打开 **DG-LAB App** 并扫描二维码。
5. App 通过局域网绑定到插件的 WebSocket 服务端。
6. agent 调用 `toy_scan` 确认绑定，然后用 `toy_control` 控制设备。

### 配置

DG-LAB 后端需要手机能访问运行 DSH 的电脑。将 `dgLabPublicHost` 设为电脑的局域网 IP（不要用 `127.0.0.1`）：

```yaml
- id: dsh-toy
  config:
    dgLabPublicHost: 192.168.1.100
    dgLabListenPort: 56789
    dgLabMaxStrength: 200
    defaultDurationSeconds: 30
    maxDurationSeconds: 300
    maxIntensityPercent: 100
    allowHold: false
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `dgLabPublicHost` | `127.0.0.1` | 嵌入二维码的主机名或 IP；必须能从手机访问 |
| `dgLabListenPort` | `0`（随机） | WebSocket 服务端口；`0` 为随机临时端口，也可固定如 `56789` |
| `dgLabWsScheme` | `ws` | WebSocket 协议（局域网用 `ws`，TLS 用 `wss`） |
| `dgLabHeartbeatIntervalMs` | `20000` | 心跳广播间隔 |
| `dgLabMaxStrength` | `200` | 100% 强度对应的最大强度值（0-200） |
| `dgLabReadyTimeoutMs` | `60000` | `toy_scan` 等待 App 绑定的超时时间 |

### 通道

郊狼有两个独立的电刺激通道（A 和 B），分别暴露为两个 `vibrate` feature。设置 `intensity_percent` 会映射到郊狼的 0-200 强度范围。省略 `feature_id` 时同时控制两个通道。

### 协议

本实现遵循 [DG-LAB V3 Socket 控制协议](https://github.com/ZGQ-inc/DG-LAB-OPENSOURCE/blob/main/socket/README.md)。插件同时充当 WebSocket 服务端和控制器；DG-LAB App 扫码后作为 App 端连接。
## 模型工具

| 工具 | 作用 |
|---|---|
| `toy_scan_raw_ble` | 在 macOS 上绕过 Intiface，只读发现可连接的原始 BLE 广播 |
| `toy_connect` | 根据用户提供的型号自动连接；不知道时使用 `unknown` |
| `toy_scan` | 发现可用设备 |
| `toy_list` | 列出设备 id 和可控 feature |
| `toy_control` | 发送有界标量命令 |
| `toy_stop` | 停止一个或全部设备 |
| `toy_disconnect` | 停止输出并关闭连接 |

已知型号：`toy_connect` → `toy_scan` → `toy_list` → `toy_control` → `toy_stop` → `toy_disconnect`。

macOS 未知型号：`toy_scan_raw_ble` → 使用广播名称作为硬件证据 → `toy_connect` → `toy_scan`。原始发现不可用或没有结论时，继续调用 `toy_connect(model: "unknown")`。

## 故障排查

- 出现 `spawn intiface-engine ENOENT`：请更新到包含自动下载的最新版本，确认 `intifaceAutoDownload: true` 且可以访问 GitHub。
- 扫描结果为空：确认系统蓝牙已打开、玩具有电且处于附近，并断开手机 APP 或其他控制程序。
- Intiface 启动但扫描失败：检查系统是否已授予 DSH/终端蓝牙权限。
- 原始 BLE 扫描无法构建辅助程序：运行 `xcode-select --install` 安装 Xcode Command Line Tools，或使用 Intiface 回退。
- MonsterParty 连接被拒绝：分享 token 可能已使用或过期，请生成新链接后重试。
- DG-LAB App 无法连接：确认手机和电脑在同一网络，`dgLabPublicHost` 已设为电脑局域网 IP（不是 `127.0.0.1`），且端口未被防火墙阻止。
- DG-LAB 扫描返回空：App 可能还未扫码，或绑定超时；请增大 `dgLabReadyTimeoutMs` 后重试。

## 已知限制

- MonsterParty 连接只实现 Chemtrails 记录的 relay 行为和 `AKN_DS_SUCKEGG` 映射；厂商协议变化可能需要更新实现。
- 内置 RoomFun 映射仅对 BLE 名称 `RoomFun`、型号标识 `RF_CANNON_PT3`、固件 `4.3` 和一个振动输出完成了实机验证，不会假定其他 RoomFun 型号兼容。
- 原始 BLE 广播发现仅支持 macOS，并依赖 Xcode Command Line Tools 提供的 Swift 编译器；它只负责只读发现，不是未知设备的通用控制协议。
- Buttplug 连接当前只暴露标量 feature；位置、方向、传感器、原始访问和订阅不在当前范围内。
- DG-LAB 郊狼连接实现了 V3 WebSocket 协议的强度控制和清除命令。波形/脉冲命令生成已作为导出工具函数（`pulseCmd`）提供，但不通过模型工具接口暴露，该接口仅支持标量强度控制。
- 测试使用本地协议 fixture，不连接物理硬件。
- 设备重连后应重新调用 `toy_list` 刷新设备 id。

## 开发

```sh
pnpm install
pnpm run check
```

## 致谢

感谢 [Chemtrails](https://github.com/Kristenkristen/Chemtrails) 和 [Buttplug](https://github.com/buttplugio/buttplug) 在协议研究、文档和开源实现方面所做的工作。

## 许可证

BSD-3-Clause。详见 [LICENSE](LICENSE)。
