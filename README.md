# dsh-toy

`dsh-toy` 是一个可安装的 DeepSeek Harness bundle，为模型提供统一的成人玩具连接、发现、限时控制、急停和断开工具。

它支持两类 provider：

- **Buttplug / Intiface**：连接本机 Intiface Central/Engine 的 WebSocket 服务，支持 Buttplug v4，并可切换到 v3 兼容模式。
- **MonsterParty**：使用安可尼、谜姬、醉清风等分享链接中的单次 token，经厂商云端 WebSocket 中继控制设备；双马达 `AKN_DS_SUCKEGG` 会分别暴露振动和吸力 feature。

本实现参考了 [Chemtrails](https://github.com/Kristenkristen/Chemtrails) 的 MonsterParty 协议记录，以及 [Buttplug](https://github.com/buttplugio/buttplug) 和 [Buttplug Protocol Spec](https://buttplug.io/docs/spec/) 的设备抽象与消息格式。代码为独立 TypeScript 实现，归属说明见 [NOTICE](NOTICE)。

## 安全设计

- session token 只能从插件配置读取，不会出现在模型可见的工具参数或结果中。
- `toy_control` 默认 30 秒自动停止；部署可调，但不能超过 `maxDurationSeconds`。
- 默认禁止 `duration_seconds: 0` 的无限保持；只有显式设置 `allowHold: true` 才允许。
- `maxIntensityPercent` 在 provider 收到命令前执行硬限制。
- 每个设备只保留最新一代自动停止计时器，旧命令的计时器不会停止更新后的命令。
- `toy_stop` 省略设备 id 时执行全局急停。
- 插件卸载、HMR 或 `toy_disconnect` 会停止输出、关闭心跳并等待 WebSocket 退出。

只控制你本人拥有或已获得明确授权的设备。MonsterParty 分享 token 相当于临时控制凭据，不要提交到 Git、日志或聊天记录。

## 本地开发

本仓库当前位于 DeepSeek Harness checkout 的同级目录，开发依赖通过 `link:../test-c3ll256/...` 使用该 checkout：

```sh
cd /Users/c3ll256/Repos/dsh-toy
pnpm install
pnpm run check
```

运行要求：Node.js 22.19+、pnpm 10。

## 安装到 Harness profile

从本地 checkout 安装 bundle：

```sh
cd /Users/c3ll256/Repos/dsh-toy
dsh plugin --profile web add .
dsh --profile web --dump-config
dsh --profile web
```

默认 bundle 配置连接 `ws://127.0.0.1:12345`，使用 Buttplug v4。若 profile 名不是 `web`，替换上述命令中的 profile 名即可。

移除：

```sh
dsh plugin --profile web remove dsh-toy
```

## Buttplug / Intiface 配置

先启动 Intiface Central 或 Intiface Engine，并启用 WebSocket server。默认 profile patch 已经是：

```yaml
- id: dsh-toy
  config:
    provider: buttplug
    buttplugUrl: ws://127.0.0.1:12345
    buttplugProtocolVersion: 4
    defaultDurationSeconds: 30
    maxDurationSeconds: 300
    maxIntensityPercent: 100
    allowHold: false
```

旧版 Intiface server 使用：

```yaml
buttplugProtocolVersion: 3
```

v4 provider 读取 `DeviceFeatures` 和每个 output 的整数范围，支持 `Vibrate`、`Oscillate`、`Constrict`、`Inflate` 中可安全映射为百分比的 feature。v3 provider 读取 `ScalarCmd` feature，并发送 0–1 标量。

## MonsterParty 配置

从分享链接路径取得 token，例如 `https://www.monsterparty.cn/remote/<TOKEN>`。建议把 token 放在调用目录的 `.env` 中：

```dotenv
MONSTERPARTY_TOKEN=<TOKEN>
```

然后在 profile 的 `cordis.patch.yml` 中覆盖整份插件配置：

```yaml
- id: dsh-toy
  config:
    provider: monsterparty
    monsterPartySessionToken: !!js process.env.MONSTERPARTY_TOKEN
    monsterPartyApiUrl: https://api.monsterparty.cc/main/v1/remote
    monsterPartyOrigin: https://www.monsterparty.cn
    connectionTimeoutMs: 10000
    readyTimeoutMs: 20000
    heartbeatIntervalMs: 9000
    defaultDurationSeconds: 30
    maxDurationSeconds: 300
    maxIntensityPercent: 100
    allowHold: false
```

分享 token 通常单次使用且断开后失效。重新连接前应生成新链接并更新环境变量。

## 模型工具

| 工具 | 作用 |
|---|---|
| `toy_connect` | 连接配置好的 provider；没有 secret 参数 |
| `toy_scan` | 在配置的 `scanDurationMs` 内扫描；MonsterParty 返回当前远程设备 |
| `toy_list` | 返回设备 id、名称和可控 feature |
| `toy_control` | 按设备、feature 类型、强度和时长发送标量命令 |
| `toy_stop` | 停止一个设备；省略 `device_id` 时全部急停 |
| `toy_disconnect` | 急停并关闭连接，可再次 `toy_connect` |

推荐调用顺序：

1. `toy_connect`
2. Buttplug 首次使用时调用 `toy_scan`
3. `toy_list` 获取最新的 `device_id` 和 `feature_id`
4. `toy_control` 发送有界命令
5. 随时使用 `toy_stop`，结束时调用 `toy_disconnect`

## 配置参考

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `provider` | `buttplug` | `buttplug` 或 `monsterparty` |
| `buttplugUrl` | `ws://127.0.0.1:12345` | Intiface WebSocket URL |
| `buttplugProtocolVersion` | `4` | `3` 或 `4` |
| `monsterPartySessionToken` | 无 | MonsterParty provider 必填 |
| `monsterPartyApiUrl` | 官方 remote API | token 解析 endpoint |
| `monsterPartyOrigin` | `https://www.monsterparty.cn` | relay Origin |
| `connectionTimeoutMs` | `10000` | HTTP/WebSocket 连接超时 |
| `requestTimeoutMs` | `5000` | Buttplug 请求超时 |
| `readyTimeoutMs` | `20000` | MonsterParty 设备上线超时 |
| `heartbeatIntervalMs` | `9000` | MonsterParty `op:8` 心跳间隔 |
| `scanDurationMs` | `5000` | Buttplug 扫描窗口 |
| `defaultDurationSeconds` | `30` | 省略时长时的自动停止时间 |
| `maxDurationSeconds` | `300` | 硬时长上限 |
| `maxIntensityPercent` | `100` | 硬强度上限，0–100 |
| `allowHold` | `false` | 是否允许 0 秒无限保持 |

所有 timeout 与 interval 必须是正安全整数；时长和强度限制在插件加载时校验，错误配置会直接阻止加载。

## 已知限制

- MonsterParty provider 只实现 Chemtrails 已记录的 MonsterParty relay 和 `AKN_DS_SUCKEGG` 双马达映射；厂商协议变化可能使连接失效。
- Buttplug provider 当前只暴露标量 feature，不暴露位置、旋转方向、传感器、原始读写或订阅命令。
- 项目没有物理硬件 CI；测试覆盖本地协议 fixture、握手、消息映射、计时器代际和 teardown。
- Buttplug 设备 index 只在最新 `DeviceList` 存续期间有效；设备重连后应重新调用 `toy_list`。

## 许可证

BSD-3-Clause。详见 [LICENSE](LICENSE)。
