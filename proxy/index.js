#!/usr/bin/env node
/**
 * Anthropic reverse proxy logger (works with ANTHROPIC_BASE_URL)
 * - Logs request method/url/headers + JSON body (redacts tokens)
 * - Forwards to upstream and streams response back to client
 *
 * Node >= 18 recommended
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";

const LISTEN_PORT = Number(process.env.PORT || 8787);
const UPSTREAM_BASE =
  // process.env.UPSTREAM_BASE || "https://anyrouter.top";
  // process.env.UPSTREAM_BASE || "https://ark.cn-beijing.volces.com/api/coding";
  process.env.UPSTREAM_BASE || "https://open.bigmodel.cn/api/anthropic";
  // process.env.UPSTREAM_BASE || "https://api.deepseek.com/v1";
const LOG_TZ = process.env.LOG_TZ || "Asia/Shanghai"; // default to Asia/Shanghai; override via env
const RAW_PREVIEW_LIMIT = Number(process.env.RAW_PREVIEW_LIMIT || 1_000_000);
const SIMPLE_TEXT_MAX = Number(process.env.SIMPLE_TEXT_MAX || 2_000);
const SIMPLE_TEXT_PREFIX = Number(process.env.SIMPLE_TEXT_PREFIX || 300);
const SIMPLE_TEXT_SUFFIX = Number(process.env.SIMPLE_TEXT_SUFFIX || 200);
const SIMPLE_TOOL_DESCRIPTION_MAX = Number(process.env.SIMPLE_TOOL_DESCRIPTION_MAX || 240);
const SIMPLE_SCHEMA_ENUM_MAX = Number(process.env.SIMPLE_SCHEMA_ENUM_MAX || 8);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logDirTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: LOG_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})
  .format(new Date())
  .replace(" ", "T")
  .replace(/[:.]/g, "-");
const LOG_DIR = path.join(__dirname, `traffic-log-${logDirTime}`);
const COMBINED_LOG_FILE = path.join(LOG_DIR, "clean-traffic.log");

// Request sequence counter
let requestSequence = 0;

function normalizeUpstreamPath(incomingPathname, upstreamBasePathname) {
  const incomingPath =
    typeof incomingPathname === "string" && incomingPathname.length > 0
      ? incomingPathname
      : "/";
  const withLeadingSlash = incomingPath.startsWith("/") ? incomingPath : `/${incomingPath}`;
  const basePath = upstreamBasePathname === "/" ? "" : upstreamBasePathname.replace(/\/$/, "");

  if (!basePath) return withLeadingSlash;
  if (withLeadingSlash === basePath) return "/";
  if (withLeadingSlash.startsWith(`${basePath}/`)) return withLeadingSlash.slice(basePath.length);

  return withLeadingSlash;
}

// Redact secrets in headers
function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!v) continue;
    const key = k.toLowerCase();
    if (key.includes("authorization") || key.includes("api-key") || key.includes("x-api-key")) {
      out[k] = "***REDACTED***";
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Try parse JSON; if not JSON, keep as string/buffer info
function safeParseBody(buf, contentType = "") {
  const text = buf.toString("utf8");
  const limitIsFinite = Number.isFinite(RAW_PREVIEW_LIMIT) && RAW_PREVIEW_LIMIT > 0;
  const limitedText = limitIsFinite ? text.slice(0, RAW_PREVIEW_LIMIT) : text;
  const truncated = limitIsFinite && text.length > RAW_PREVIEW_LIMIT;
  // More precise JSON detection
  const isJson =
    contentType.includes("application/json") ||
    contentType.includes("+json") ||
    text.trim().startsWith("{") ||
    text.trim().startsWith("[");
  if (!isJson) {
    return {
      _raw: limitedText,
      _note: "non-json or unknown",
      ...(truncated ? { _truncated: true, _originalLength: text.length } : {}),
    };
  }
  try {
    return JSON.parse(text);
  } catch {
    return {
      _raw: limitedText,
      _note: "json-parse-failed",
      ...(truncated ? { _truncated: true, _originalLength: text.length } : {}),
    };
  }
}

// Redact tokens inside body
function redactBody(body) {
  const clone = structuredClone(body);
  const walk = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const key = String(k).toLowerCase();
      const isTokenLike =
        key.includes("token") &&
        key !== "max_tokens" &&
        key !== "budget_tokens" &&
        key !== "input_tokens" &&
        key !== "output_tokens";
      // Avoid redacting numeric configs like max_tokens; focus on secrets.
      if (
        key === "authorization" ||
        key === "api_key" ||
        key === "apikey" ||
        key === "access_token" ||
        key === "refresh_token" ||
        key === "id_token" ||
        isTokenLike ||
        key === "password" ||
        key === "secret"
      ) {
        obj[k] = "***REDACTED***";
      } else if (typeof v === "object") {
        walk(v);
      }
    }
  };
  walk(clone);
  return clone;
}

function collectReqBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function formatLocalTimestamp(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: LOG_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  });
  // Example: "2025-12-31 23:59:59.123" -> "2025-12-31T23:59:59.123"
  const formatted = formatter.format(now).replace(" ", "T");
  const safe = formatted.replace(/[:.]/g, "-");
  return { formatted, safe };
}

function mapOpenAiStopReason(reason) {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "stop") return "end_turn";
  if (reason === "length") return "max_tokens";
  if (reason === null || reason === undefined || reason === "") return undefined;
  return String(reason);
}

function parseMaybeJson(text) {
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function openAiContentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("");
}

function openAiReasoningToText(reasoning) {
  if (!reasoning) return "";
  if (typeof reasoning === "string") return reasoning;
  if (Array.isArray(reasoning)) {
    const parts = [];
    for (const item of reasoning) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.text === "string") parts.push(item.text);
      else if (typeof item.reasoning_content === "string") parts.push(item.reasoning_content);
      else if (typeof item.reasoning === "string") parts.push(item.reasoning);
    }
    return parts.join("");
  }
  if (typeof reasoning === "object") {
    if (typeof reasoning.text === "string") return reasoning.text;
    if (typeof reasoning.reasoning_content === "string") return reasoning.reasoning_content;
    if (typeof reasoning.reasoning === "string") return reasoning.reasoning;
  }
  return "";
}

function mergeOpenAiToolCallDeltas(byKey, deltas, options = {}) {
  if (!Array.isArray(deltas)) return;
  const appendArgs = options.appendArgs !== false;

  for (let pos = 0; pos < deltas.length; pos += 1) {
    const entry = deltas[pos];
    if (!entry || typeof entry !== "object") continue;
    const idxRaw = Number(entry.index);
    const hasIndex = Number.isFinite(idxRaw);
    const id = typeof entry.id === "string" ? entry.id : "";
    const hasId = Boolean(id);
    const keyById = hasId ? `id:${id}` : null;
    const keyByIndex = hasIndex ? `idx:${idxRaw}` : null;
    const keyByPos = `pos:${pos}`;

    let state =
      (keyById ? byKey.get(keyById) : undefined) || (keyByIndex ? byKey.get(keyByIndex) : undefined);
    if (!state) {
      const posState = byKey.get(keyByPos);
      const sameToolById = !hasId || !posState?.id || posState.id === id;
      if (posState && sameToolById) state = posState;
    }
    if (!state) {
      state = {
        sortOrder: hasIndex ? idxRaw : 100_000 + pos,
        id: "",
        name: "",
        argumentsText: "",
      };
    } else if (hasIndex) {
      state.sortOrder = idxRaw;
    }

    if (hasId) state.id = id;
    const name = entry?.function?.name;
    if (typeof name === "string" && name) state.name = name;
    const argumentsDelta = entry?.function?.arguments;
    if (typeof argumentsDelta === "string" && argumentsDelta) {
      state.argumentsText = appendArgs ? state.argumentsText + argumentsDelta : argumentsDelta;
    }

    if (keyById) byKey.set(keyById, state);
    if (keyByIndex) byKey.set(keyByIndex, state);
    byKey.set(keyByPos, state);
  }
}

function materializeOpenAiToolCalls(byKey) {
  const uniqueStates = Array.from(new Set(byKey.values()));
  return uniqueStates
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((state, i) => ({
      id: String(state.id || `tool_${i + 1}`),
      name: String(state.name || ""),
      input: parseMaybeJson(state.argumentsText),
    }));
}

function parseAnthropicSseSummary(events) {
  const textParts = [];
  const assistantTextParts = [];
  const toolUses = [];
  const toolCalls = [];
  const usage = {};
  let stopReason;
  let messageId;
  let model;
  let currentToolCall = null;
  let currentToolInputJson = "";

  for (const evt of events) {
    if (!evt || typeof evt !== "object") continue;
    if (evt.type === "message_start" && evt.message) {
      messageId = evt.message.id || messageId;
      model = evt.message.model || model;
      if (evt.message.usage) {
        if (typeof evt.message.usage.input_tokens === "number") usage.input_tokens = evt.message.usage.input_tokens;
        if (typeof evt.message.usage.output_tokens === "number")
          usage.output_tokens = evt.message.usage.output_tokens;
      }
    }
    if (evt.type === "message_delta") {
      if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
      if (evt.usage) {
        if (typeof evt.usage.input_tokens === "number") usage.input_tokens = evt.usage.input_tokens;
        if (typeof evt.usage.output_tokens === "number") usage.output_tokens = evt.usage.output_tokens;
      } else if (evt.delta?.usage) {
        if (typeof evt.delta.usage.input_tokens === "number") usage.input_tokens = evt.delta.usage.input_tokens;
        if (typeof evt.delta.usage.output_tokens === "number") usage.output_tokens = evt.delta.usage.output_tokens;
      }
    }

    if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && typeof evt.delta.text === "string") {
      textParts.push(evt.delta.text);
      assistantTextParts.push(evt.delta.text);
    }

    if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
      const toolName = evt.content_block.name || "unknown";
      const toolId = evt.content_block.id || "";
      toolUses.push(toolName);
      textParts.push(`\n[tool_use:${toolName}]`);
      currentToolCall = { id: toolId, name: toolName, input: null };
      currentToolInputJson = "";
    }

    if (evt.type === "content_block_delta" && evt.delta?.type === "input_json_delta" && evt.delta.partial_json) {
      currentToolInputJson += evt.delta.partial_json;
    }

    if (evt.type === "content_block_stop" && currentToolCall) {
      currentToolCall.input = currentToolInputJson ? parseMaybeJson(currentToolInputJson) : {};
      toolCalls.push(currentToolCall);
      currentToolCall = null;
      currentToolInputJson = "";
    }
  }

  if (currentToolCall) {
    currentToolCall.input = currentToolInputJson ? parseMaybeJson(currentToolInputJson) : {};
    toolCalls.push(currentToolCall);
  }

  const text = textParts.join("");
  const assistantText = assistantTextParts.join("");
  return {
    protocol: "anthropic",
    toolUses,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    text: text || undefined,
    assistantText: assistantText || undefined,
    ...(stopReason ? { stopReason } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(messageId ? { messageId } : {}),
    ...(model ? { model } : {}),
  };
}

function parseOpenAiSseSummary(events) {
  const assistantTextParts = [];
  const reasoningParts = [];
  const usage = {};
  const toolCallsByKey = new Map();
  let stopReason;
  let messageId;
  let model;

  for (const evt of events) {
    if (!evt || typeof evt !== "object") continue;
    if (typeof evt.id === "string" && evt.id) messageId = evt.id;
    if (typeof evt.model === "string" && evt.model) model = evt.model;

    if (evt.usage && typeof evt.usage === "object") {
      if (typeof evt.usage.prompt_tokens === "number") usage.input_tokens = evt.usage.prompt_tokens;
      if (typeof evt.usage.completion_tokens === "number") usage.output_tokens = evt.usage.completion_tokens;
      if (typeof evt.usage.input_tokens === "number") usage.input_tokens = evt.usage.input_tokens;
      if (typeof evt.usage.output_tokens === "number") usage.output_tokens = evt.usage.output_tokens;
    }

    const choices = Array.isArray(evt.choices) ? evt.choices : [];
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        stopReason = mapOpenAiStopReason(choice.finish_reason);
      }

      const delta = choice.delta || {};
      const contentText = openAiContentToText(delta.content);
      if (contentText) assistantTextParts.push(contentText);
      const reasoningText = openAiReasoningToText(delta.reasoning_content ?? delta.reasoning);
      if (reasoningText) reasoningParts.push(reasoningText);
      mergeOpenAiToolCallDeltas(toolCallsByKey, delta.tool_calls, { appendArgs: true });

      const snapshot = choice.message;
      if (snapshot && typeof snapshot === "object") {
        mergeOpenAiToolCallDeltas(toolCallsByKey, snapshot.tool_calls, { appendArgs: false });
      }
    }
  }

  const toolCalls = materializeOpenAiToolCalls(toolCallsByKey);
  const toolUses = toolCalls.map((t) => t.name).filter(Boolean);
  const assistantText = assistantTextParts.join("");
  const reasoningContent = reasoningParts.join("");

  return {
    protocol: "openai",
    toolUses,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    text: assistantText || undefined,
    assistantText: assistantText || undefined,
    reasoningContent: reasoningContent || undefined,
    ...(stopReason ? { stopReason } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(messageId ? { messageId } : {}),
    ...(model ? { model } : {}),
  };
}

function parseSseSummary(raw) {
  if (!raw || typeof raw !== "string") return null;
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // ignore parse errors for individual lines
    }
  }
  if (events.length === 0) return null;

  const isAnthropic = events.some((evt) => {
    const type = evt?.type;
    return (
      type === "message_start" ||
      type === "message_delta" ||
      type === "content_block_start" ||
      type === "content_block_delta" ||
      type === "content_block_stop"
    );
  });
  if (isAnthropic) return parseAnthropicSseSummary(events);

  const isOpenAi = events.some((evt) => Array.isArray(evt?.choices) || evt?.object === "chat.completion.chunk");
  if (isOpenAi) return parseOpenAiSseSummary(events);

  return null;
}

// Truncate long text fields (system messages, user messages, etc.)
function truncateLongText(text, maxLength = 500, prefixLength = 100, suffixLength = 100) {
  if (!text || typeof text !== "string") return text;
  if (text.length <= maxLength) return text;
  
  const prefix = text.slice(0, prefixLength);
  const suffix = text.slice(-suffixLength);
  return `${prefix}.... ${suffix}`;
}

// Recursively truncate long text in an object
function truncateTextInObject(obj, maxLength = 500, prefixLength = 100, suffixLength = 100) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => truncateTextInObject(item, maxLength, prefixLength, suffixLength));
  }
  
  const cloned = { ...obj };
  for (const [key, value] of Object.entries(cloned)) {
    if (typeof value === "string") {
      // Only truncate text fields that might be long prompts
      if (key === "text" || key === "thinking" || key === "content" || key.includes("prompt") || key.includes("system")) {
        cloned[key] = truncateLongText(value, maxLength, prefixLength, suffixLength);
      }
    } else if (typeof value === "object" && value !== null) {
      cloned[key] = truncateTextInObject(value, maxLength, prefixLength, suffixLength);
    }
  }
  return cloned;
}

function inferSchemaType(schema) {
  if (!schema || typeof schema !== "object") return "unknown";
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.enum)) return "enum";
  if (Array.isArray(schema.anyOf)) return "anyOf";
  if (Array.isArray(schema.oneOf)) return "oneOf";
  if (Array.isArray(schema.allOf)) return "allOf";
  if (schema.properties && typeof schema.properties === "object") return "object";
  return "unknown";
}

function summarizeSchemaProperty(schema) {
  if (!schema || typeof schema !== "object") return undefined;
  const type = inferSchemaType(schema);
  const out = { type };
  if (schema.description) {
    out.description = truncateLongText(String(schema.description), 160, 140, 0);
  }
  if (Array.isArray(schema.enum)) {
    out.enumCount = schema.enum.length;
    out.enum = schema.enum.slice(0, SIMPLE_SCHEMA_ENUM_MAX);
  }
  if (type === "array" && schema.items) {
    out.itemsType = inferSchemaType(schema.items);
  }
  if (type === "object" && schema.properties && typeof schema.properties === "object") {
    out.propertyKeys = Object.keys(schema.properties).slice(0, 20);
    if (Object.keys(schema.properties).length > 20) out.propertyKeysTruncated = true;
  }
  return out;
}

function summarizeInputSchema(schema) {
  if (!schema || typeof schema !== "object") return undefined;
  const out = { type: inferSchemaType(schema) };
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (schema.properties && typeof schema.properties === "object") {
    const props = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      props[k] = summarizeSchemaProperty(v);
    }
    out.properties = props;
  }
  return out;
}

function getToolDefName(toolDef) {
  if (!toolDef || typeof toolDef !== "object") return "";
  if (typeof toolDef.name === "string" && toolDef.name) return toolDef.name;
  if (typeof toolDef?.function?.name === "string" && toolDef.function.name) return toolDef.function.name;
  return "";
}

function getToolDefDescription(toolDef) {
  if (!toolDef || typeof toolDef !== "object") return "";
  if (typeof toolDef.description === "string" && toolDef.description) return toolDef.description;
  if (typeof toolDef?.function?.description === "string" && toolDef.function.description) {
    return toolDef.function.description;
  }
  return "";
}

function getToolDefInputSchema(toolDef) {
  if (!toolDef || typeof toolDef !== "object") return undefined;
  if (toolDef.input_schema && typeof toolDef.input_schema === "object") return toolDef.input_schema;
  if (toolDef?.function?.parameters && typeof toolDef.function.parameters === "object") {
    return toolDef.function.parameters;
  }
  return undefined;
}

function summarizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => {
      const name = getToolDefName(t) || null;
      if (!name) return null;
      const description = getToolDefDescription(t);
      const inputSchema = getToolDefInputSchema(t);
      return {
        name,
        ...(description
          ? { description: truncateLongText(String(description), SIMPLE_TOOL_DESCRIPTION_MAX, SIMPLE_TOOL_DESCRIPTION_MAX, 0) }
          : {}),
        ...(inputSchema ? { input_schema: summarizeInputSchema(inputSchema) } : {}),
      };
    })
    .filter(Boolean);
}

function summarizeToolCallInput(input) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const keys = Object.keys(input);
    return {
      type: "object",
      keys: keys.slice(0, 20),
      ...(keys.length > 20 ? { keysTruncated: true } : {}),
    };
  }
  if (typeof input === "string") {
    return {
      type: "string",
      preview: truncateLongText(input, 240, 200, 0),
    };
  }
  return {
    type: typeof input,
  };
}

function parseToolCallArguments(rawArgs) {
  if (typeof rawArgs !== "string") return {};
  return parseMaybeJson(rawArgs);
}

function summarizeRequestToolActivity(requestBody) {
  const summary = {
    toolCalls: [],
    toolResults: [],
  };
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const role = typeof msg.role === "string" ? msg.role : "";

    if (role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const inputFromArgs = parseToolCallArguments(tc?.function?.arguments);
        const input = tc.input && typeof tc.input === "object" ? tc.input : inputFromArgs;
        summary.toolCalls.push({
          messageIndex: i,
          id: tc?.id ? String(tc.id) : "",
          name: tc?.function?.name ? String(tc.function.name) : "",
          input: summarizeToolCallInput(input),
        });
      }
    }

    if (role === "tool") {
      const content = typeof msg.content === "string" ? msg.content : "";
      summary.toolResults.push({
        messageIndex: i,
        tool_call_id: msg.tool_call_id ? String(msg.tool_call_id) : "",
        isError: /^error:/i.test(content),
        contentPreview: truncateLongText(content, 240, 200, 0),
      });
    }

    if (role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type !== "tool_use") continue;
        summary.toolCalls.push({
          messageIndex: i,
          id: block.id ? String(block.id) : "",
          name: block.name ? String(block.name) : "",
          input: summarizeToolCallInput(block.input || {}),
        });
      }
    }

    if (role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type !== "tool_result") continue;
        const content = typeof block.content === "string" ? block.content : "";
        summary.toolResults.push({
          messageIndex: i,
          tool_call_id: block.tool_use_id ? String(block.tool_use_id) : "",
          isError: Boolean(block.is_error),
          contentPreview: truncateLongText(content, 240, 200, 0),
        });
      }
    }
  }
  return summary;
}

// Build simplified version of the entry
function buildSimpleEntry(entry) {
  const simple = structuredClone(entry);
  
  // Extract tool names and count
  const tools = entry.request?.body?.tools || [];
  const toolNames = tools.map((t) => getToolDefName(t)).filter(Boolean);
  const toolCount = toolNames.length;
  const toolsLite = summarizeTools(tools);
  const requestToolActivity = summarizeRequestToolActivity(entry.request?.body);
  
  // Replace tools with just names array
  if (simple.request?.body?.tools) {
    simple.request.body.tools = toolNames;
    simple.request.body.toolCount = toolCount;
    simple.request.body.toolsLite = toolsLite;
    if (simple.request.body.metadata) delete simple.request.body.metadata;
  }
  if (simple.request?.body) {
    simple.request.body.requestToolCallCount = requestToolActivity.toolCalls.length;
    simple.request.body.requestToolCalls = requestToolActivity.toolCalls;
    simple.request.body.requestToolResultCount = requestToolActivity.toolResults.length;
    simple.request.body.requestToolResults = requestToolActivity.toolResults;
  }
  
  // Remove response.body (contains raw SSE data)
  // Note: sseSummary is separate from body, so toolCalls will be preserved
  if (simple.response?.body) {
    delete simple.response.body;
  }
  
  // toolCalls and toolUses are preserved via sseSummary.
  // toolCalls structure: [{ id, name, input: {...} }]
  // This contains the complete tool arguments which is critical information
  
  // Truncate long text fields in request.body
  if (simple.request?.body) {
    simple.request.body = truncateTextInObject(simple.request.body, SIMPLE_TEXT_MAX, SIMPLE_TEXT_PREFIX, SIMPLE_TEXT_SUFFIX);
  }

  // Truncate long text fields in sseSummary (tool inputs can be large)
  if (simple.response?.sseSummary) {
    simple.response.sseSummary = truncateTextInObject(simple.response.sseSummary, SIMPLE_TEXT_MAX, SIMPLE_TEXT_PREFIX, SIMPLE_TEXT_SUFFIX);
  }
  
  return simple;
}

async function writeTrafficLog(entry) {
  try {
    const tsSafe = entry.timestampLocalSafe || entry.timestampSafe || new Date().toISOString().replace(/[:.]/g, "-");
    const pathPart = (entry.path || "root").replace(/[^\w.-]+/g, "_").slice(0, 60) || "root";
    // Format sequence number with leading zeros (e.g., 0001, 0002, ...)
    const seqStr = String(entry.sequence || 0).padStart(4, "0");
    const filename = `${seqStr}_${tsSafe}_${entry.method || "REQ"}_${pathPart}.json`;
    const filePath = path.join(LOG_DIR, filename);
    
    // Write full entry
    await fs.writeFile(filePath, JSON.stringify(entry, null, 2), "utf8");
    
    // Write simplified entry
    const simpleEntry = buildSimpleEntry(entry);
    const simpleFilename = filename.replace(/\.json$/, ".simple.json");
    const simpleFilePath = path.join(LOG_DIR, simpleFilename);
    await fs.writeFile(simpleFilePath, JSON.stringify(simpleEntry, null, 2), "utf8");
    
    return filename; // Return filename for summary
  } catch (err) {
    console.error("Failed to write traffic log:", err);
    return null;
  }
}

// Extract summary information from full entry
function buildSummary(entry, rawFilename) {
  const req = entry.request?.body || {};
  const resp = entry.response?.body || {};
  const sseSummary = entry.response?.sseSummary;
  const requestToolActivity = summarizeRequestToolActivity(req);
  
  // Extract key request info
  const model = req.model;
  const maxTokens = req.max_tokens;
  const temperature = req.temperature;
  const stream = req.stream;
  
  // Extract tool info
  const toolNames = (req.tools || []).map((t) => getToolDefName(t)).filter(Boolean);
  const toolCount = toolNames.length;
  
  // Extract SSE tool uses
  const responseToolUses = sseSummary?.toolUses || [];
  const responseToolCalls = Array.isArray(sseSummary?.toolCalls) ? sseSummary.toolCalls : [];
  const responseToolCallIds = responseToolCalls.map((t) => String(t?.id || "")).filter(Boolean);
  
  // Extract stop reason and usage
  const stopReason = resp.stop_reason || sseSummary?.stopReason;
  const usage = resp.usage || sseSummary?.usage || {};
  
  return {
    seq: entry.sequence,
    time: entry.timestamp,
    timeLocal: entry.timestampLocal,
    path: entry.path,
    status: entry.response?.status,
    latencyMs: entry.latencyMs,
    
    // Request summary
    model,
    stream,
    maxTokens,
    temperature,
    toolCount,
    toolNames: toolNames.slice(0, 5), // Top 5 tools
    requestToolCallCount: requestToolActivity.toolCalls.length,
    requestToolCallNames: requestToolActivity.toolCalls.map((t) => t.name).filter(Boolean).slice(0, 5),
    requestToolCallIds: requestToolActivity.toolCalls.map((t) => t.id).filter(Boolean).slice(0, 8),
    requestToolResultCount: requestToolActivity.toolResults.length,
    requestToolResultIds: requestToolActivity.toolResults.map((t) => t.tool_call_id).filter(Boolean).slice(0, 8),
    
    // Response summary
    stopReason,
    responseToolUses,
    responseToolCallCount: responseToolCalls.length,
    responseToolCallIds: responseToolCallIds.slice(0, 8),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    
    // Reference to full log
    rawFile: rawFilename,
  };
}

async function appendCombinedLog(entry) {
  try {
    await fs.appendFile(COMBINED_LOG_FILE, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.error("Failed to append combined traffic log:", err);
  }
}

const server = http.createServer(async (req, res) => {
  // capture for error logging
  let bodyBuf = Buffer.alloc(0);
  let redactedParsed;
  let incomingUrl;
  let upstreamUrl;
  
  // Increment and get current sequence number
  const currentSequence = ++requestSequence;

  try {
    incomingUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

    const upstreamBase = new URL(UPSTREAM_BASE.endsWith("/") ? UPSTREAM_BASE : `${UPSTREAM_BASE}/`);
    const normalizedPath = normalizeUpstreamPath(incomingUrl.pathname, upstreamBase.pathname);
    const upstreamPath = normalizedPath.replace(/^\//, "");
    upstreamUrl = new URL(upstreamPath || "", upstreamBase);
    upstreamUrl.search = incomingUrl.search;

    // Read request body (needed for logging + forwarding)
    bodyBuf = await collectReqBody(req);

    // ---- LOG REQUEST ----
    const ct = String(req.headers["content-type"] || "");
    const parsed = safeParseBody(bodyBuf, ct);
    redactedParsed = redactBody(parsed);
    const redactedRequestHeaders = redactHeaders(req.headers);

    const nowDate = new Date();
    const startTime = Date.now(); // Track start time for latency
    const now = nowDate.toISOString();
    const nowSafe = now.replace(/[:.]/g, "-");
    const { formatted: timestampLocal, safe: timestampLocalSafe } = formatLocalTimestamp(nowDate);
    console.log("\n================= Claude/Anthropic Request =================");
    console.log(`[#${currentSequence}] [${now} | ${timestampLocal}] ${req.method} ${incomingUrl.pathname}${incomingUrl.search}`);
    console.log("-> Upstream:", upstreamUrl.toString());
    console.log("Headers:", redactedRequestHeaders);
    if (bodyBuf.length) {
      // Pretty print JSON if possible
      if (typeof redactedParsed === "object") {
        console.log("Body(JSON):", JSON.stringify(redactedParsed, null, 2));
      } else {
        console.log("Body:", redactedParsed);
      }
    } else {
      console.log("Body: <empty>");
    }
    console.log("===========================================================\n");

    // Prepare upstream headers
    // Remove hop-by-hop headers and disable compression to avoid needing to gunzip for logging.
    const hopByHop = new Set([
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailers",
      "transfer-encoding",
      "upgrade",
    ]);

    const upstreamHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (hopByHop.has(k.toLowerCase())) continue;
      if (k.toLowerCase() === "host") continue;
      if (k.toLowerCase() === "accept-encoding") continue; // simplify
      upstreamHeaders[k] = v;
    }

    // Forward request using native fetch
    const upstreamResp = await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: bodyBuf.length ? bodyBuf : undefined,
      redirect: "manual",
    });

    // ---- STREAM RESPONSE BACK ----
    res.statusCode = upstreamResp.status;
    upstreamResp.headers.forEach((value, key) => {
      // Strip hop-by-hop headers in response too
      if (hopByHop.has(key.toLowerCase())) return;
      res.setHeader(key, value);
    });

    // Stream body
    let responseBodyBuf = Buffer.alloc(0);
    if (!upstreamResp.body) {
      res.end();
    } else {
      const reader = upstreamResp.body.getReader();
      const respChunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const buf = Buffer.from(value);
          respChunks.push(buf);
          res.write(buf);
        }
      }
      res.end();
      responseBodyBuf = Buffer.concat(respChunks);
    }

    const latencyMs = Date.now() - startTime; // Calculate latency
    
    const respCt = upstreamResp.headers.get("content-type") || "";
    const responseParsed = safeParseBody(responseBodyBuf, respCt);
    const redactedResponseParsed = redactBody(responseParsed);
    const sseSummary =
      respCt.includes("text/event-stream") && typeof responseParsed === "object" && responseParsed?._raw
        ? parseSseSummary(responseParsed._raw)
        : undefined;

    const fullEntry = {
      sequence: currentSequence,
      timestamp: now,
      timestampLocal,
      timestampLocalSafe,
      latencyMs,
      path: incomingUrl.pathname,
      request: {
        headers: redactedRequestHeaders,
        body: redactedParsed,
      },
      response: {
        status: upstreamResp.status,
        body: redactedResponseParsed,
        ...(sseSummary ? { sseSummary } : {}),
      },
    };

    const rawFilename = await writeTrafficLog(fullEntry);
    const summary = buildSummary(fullEntry, rawFilename);
    await appendCombinedLog(summary);
  } catch (e) {
    console.error("Proxy error:", e);
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const { formatted: timestampLocal, safe: timestampLocalSafe } = formatLocalTimestamp(nowDate);

    const errorEntry = {
      sequence: currentSequence,
      timestamp: now,
      timestampLocal,
      timestampLocalSafe,
      path: incomingUrl?.pathname,
      request: {
        headers: redactHeaders(req.headers),
        body: redactedParsed,
      },
      response: {
        status: "proxy_error",
        error: String(e?.message || e),
      },
    };
    const rawFilename = await writeTrafficLog(errorEntry);
    const errorSummary = {
      seq: currentSequence,
      time: now,
      timeLocal: timestampLocal,
      path: incomingUrl?.pathname,
      status: "proxy_error",
      error: String(e?.message || e),
      rawFile: rawFilename,
    };
    await appendCombinedLog(errorSummary);

    res.statusCode = 502;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "proxy_error", message: String(e?.message || e) }));
  }
});

server.listen(LISTEN_PORT, "127.0.0.1", async () => {
  await fs.mkdir(LOG_DIR, { recursive: true });
  console.log(`Anthropic tap proxy listening on http://127.0.0.1:${LISTEN_PORT}`);
  console.log(`Forwarding to upstream: ${UPSTREAM_BASE}`);
  console.log(`Traffic log dir: ${LOG_DIR}`);
  console.log(`Set FORMAX_BASE_URL=http://127.0.0.1:${LISTEN_PORT}/v1`);
});
