# Proxy Tools

这个目录放的是两个本地代理脚本：

- `proxy/index.js`
  用来把 Anthropic-compatible 请求转发到上游，同时按请求落地抓包日志。
- `proxy/rewrite-proxy.js`
  在转发前按本地 JSON 规则重写请求，适合做 A/B 实验、对齐第三方请求、或快速验证不同 header/body 组合。

为了避免把本地抓包和敏感数据带进仓库，分享分支只包含脚本、示例规则和说明，不包含运行后生成的日志目录。

## Requirements

- Node.js 18+
- `jq` 可选，但推荐装上方便查日志

## Quick Start

启动普通抓包代理：

```bash
node proxy/index.js
```

在另一个终端把你的客户端指向本地代理：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

如果你的客户端用的是别的环境变量名，就把 base URL 指到同一个地址即可。

## Environment Variables

两个脚本都支持下面这些环境变量：

```bash
PORT=8787
UPSTREAM_BASE=https://open.bigmodel.cn/api/anthropic
LOG_TZ=Asia/Shanghai
```

`proxy/index.js` 额外支持：

```bash
RAW_PREVIEW_LIMIT=1000000
SIMPLE_TEXT_MAX=2000
SIMPLE_TEXT_PREFIX=300
SIMPLE_TEXT_SUFFIX=200
SIMPLE_TOOL_DESCRIPTION_MAX=240
SIMPLE_SCHEMA_ENUM_MAX=8
```

## Captured Logs

每次启动代理都会在 `proxy/traffic-log-<timestamp>/` 下生成一批文件，例如：

```text
proxy/traffic-log-2026-03-22T21-10-30/
```

常见文件有：

- `clean-traffic.log`
  一行一个 JSON 摘要，方便快速 grep / jq。
- `0001_...REQ__v1_messages.json`
  完整请求与响应日志，内容会做基本脱敏。
- `0001_...REQ__v1_messages.simple.json`
  更轻量的简化版请求快照，适合快速对比。

常见查看方式：

```bash
tail -10 proxy/traffic-log-*/clean-traffic.log
```

```bash
jq -r '[.seq, .timeLocal, .status, .latencyMs, .model, .stopReason] | @tsv' \
  proxy/traffic-log-*/clean-traffic.log
```

## Rewrite Proxy

如果你想在不改业务代码的前提下，直接修改请求头、system、tools、metadata 或 body 字段，用这个：

```bash
node proxy/rewrite-proxy.js
```

默认读取：

```bash
proxy/rewrite-rules.json
```

先从示例文件复制一份：

```bash
cp proxy/rewrite-rules.example.json proxy/rewrite-rules.json
```

如果你不想放在默认路径，也可以自定义：

```bash
REWRITE_RULES_FILE=/absolute/path/to/rewrite-rules.json node proxy/rewrite-proxy.js
```

## Rule Shape

示例规则里这些字段最重要：

- `enabled`
  是否启用整套重写规则。
- `match.methods`
  只对哪些 HTTP 方法生效。
- `match.pathRegex`
  只对哪些路径生效。
- `templateFile`
  可选。指向某个抓包 JSON，从里面复制 system/tools 等字段。
- `rewrite.headers.set`
  新增或覆盖请求头。
- `rewrite.headers.remove`
  删除请求头。
- `rewrite.body.set`
  直接覆盖 body 某些字段。
- `rewrite.body.removePaths`
  删除 body 某些路径。
- `rewrite.body.copyFromTemplate`
  从 `templateFile` 里拷字段到当前请求。
- `rewrite.preserveOriginalPaths`
  在模板覆盖后，保留原请求的指定字段，常见是 `messages`。

一个常见流程是：

1. 先跑 `proxy/index.js` 抓一次真实请求。
2. 从抓包目录里挑一个成功请求 JSON。
3. 把那个文件路径填到 `templateFile`。
4. 用 `proxy/rewrite-proxy.js` 做 header/body 调整。
5. 对比 `requestOriginal` 和 `requestRewritten`。

## Notes

- 这两个脚本面向本地调试，不建议直接暴露在公网。
- 日志里虽然做了基本脱敏，但仍然建议把抓包目录视为敏感数据。
- 仓库默认忽略 `proxy/traffic-log-*` 和本地规则文件 `proxy/rewrite-rules.json`，避免误提交。

## Troubleshooting

端口被占用时先看：

```bash
lsof -i :8787
```

如果上游地址不对，直接指定：

```bash
UPSTREAM_BASE=https://your-upstream.example.com node proxy/index.js
```

如果 rewrite 规则没有生效，优先检查：

- `enabled` 是否为 `true`
- `match.pathRegex` 是否匹配当前请求
- `REWRITE_RULES_FILE` 是否指向了正确文件
- `templateFile` 是否真实存在

### 与 ripgrep 结合

```bash
# 查找所有错误响应
rg '"status":(4|5)\d\d' proxy/traffic-logs/clean-traffic.log

# 查找特定模型
rg '"model":"claude-opus-4' proxy/traffic-logs/clean-traffic.log
```

### 导出 CSV

```bash
jq -r '[.seq, .time, .status, .latencyMs, .model, .stopReason, .inputTokens, .outputTokens] | @csv' \
  proxy/traffic-logs/clean-traffic.log > export.csv
```

### 实时监控

```bash
# 实时查看新的请求
tail -f proxy/traffic-logs/clean-traffic.log | jq .
```
