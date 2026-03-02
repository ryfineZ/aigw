# iflow-relay

`iflow-relay` 是一个极简 iFlow 专用反代。

设计原则：
- 只做 iFlow 反代，不做多 provider、不做协议大而全转换
- 不依赖 CLIProxyAPI 仓库（无 `replace`，无 CPA 包引用）
- 保留 iFlow 稳定性关键逻辑（406 回退、449 映射、流式兜底）

## 支持的接口

- `GET /health`
- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/chat/completions`

兼容别名：
- `GET /models`
- `GET /models/{id}`
- `POST /messages`
- `POST /messages/count_tokens`
- `POST /chat/completions`

## 核心行为

- iFlow 请求头对齐：
  - `Content-Type: application/json`
  - `Authorization: Bearer ...`
  - `user-agent: iFlow-Cli`
  - `session-id`
  - `conversation-id`
  - `x-iflow-signature` + `x-iflow-timestamp`（可开关）
- 显式删除 `Accept`
- 406 回退：首发带签名，命中 `406` 后自动无签名重试一次
- 业务状态映射：`status=449` -> `429`
- 流式稳定性：
  - 上游非 SSE 时自动合成 SSE chunk
  - 流式期间可发送心跳注释 `: heartbeat`
  - 识别 `network_error` 且无有效内容时返回错误
- Anthropic 协议兼容：
  - `messages -> chat.completions` 请求转换（文本/图片/工具调用）
  - `chat.completions -> messages` 响应转换（非流式 + SSE 事件流）
  - `count_tokens` 近似估算实现（用于 Claude Code 兼容）

## 依赖

仅依赖：
- `github.com/google/uuid`
- `github.com/tidwall/gjson`
- `github.com/tidwall/sjson`

## 快速开始

```bash
cd /Users/zhangyufan/Workspace/Projects/iflow-relay
cp .env.example .env
set -a; source .env; set +a

go run ./cmd/iflow-relay
```

默认监听：`http://127.0.0.1:8327`

健康检查：

```bash
curl -s http://127.0.0.1:8327/health
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8327` | 服务端口 |
| `IFLOW_BASE_URL` | `https://apis.iflow.cn/v1` | iFlow 基础地址 |
| `IFLOW_API_KEY` | - | 单 key |
| `IFLOW_API_KEYS` | - | 多 key（逗号分隔，优先于 `IFLOW_API_KEY`） |
| `DEFAULT_MODEL` | - | 请求未指定 model 时使用 |
| `IFLOW_MODELS` | - | 对外暴露的模型列表（逗号分隔），默认取 `DEFAULT_MODEL` 或 `glm-5` |
| `IFLOW_ENABLE_SIGNATURE` | `true` | 是否带签名头 |
| `IFLOW_RETRY_406_UNSIGNED` | `true` | 406 后是否无签名重试 |
| `PROXY_REQUEST_TIMEOUT_MS` | `180000` | 非流式请求超时 |
| `PROXY_STREAM_HEARTBEAT_MS` | `15000` | 流式心跳间隔 |
| `STREAM_EMIT_HEARTBEAT_COMMENTS` | `true` | 是否发送心跳注释 |
| `PROXY_MAX_BODY_BYTES` | `26214400` | 请求体上限 |
| `LOG_REQUEST_HEADERS` | `false` | 记录上游请求头 |
| `LOG_RESPONSE_HEADERS` | `false` | 记录上游响应头 |

## 验证

```bash
go test ./...
```

测试覆盖：
- 请求头注入
- 449 -> 429 映射
- 406 无签名重试
