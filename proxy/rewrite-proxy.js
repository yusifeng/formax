#!/usr/bin/env node
/**
 * Standalone rewrite proxy for Anthropic-compatible APIs.
 *
 * Goals:
 * - Keep your main app/business code untouched.
 * - Allow arbitrary request rewrites via a local JSON rules file.
 * - Support copy/paste from captured traffic JSON into template-based rewrites.
 * - Log both original and rewritten requests for diff/debug.
 *
 * Usage:
 *   node proxy/rewrite-proxy.js
 *
 * Env:
 *   PORT=8787
 *   UPSTREAM_BASE=https://anyrouter.top
 *   REWRITE_RULES_FILE=proxy/rewrite-rules.json
 *   LOG_TZ=Asia/Shanghai
 */

import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { URL, fileURLToPath } from 'node:url'

const LISTEN_PORT = Number(process.env.PORT || 8787)
const UPSTREAM_BASE = process.env.UPSTREAM_BASE || 'https://anyrouter.top'
const LOG_TZ = process.env.LOG_TZ || 'Asia/Shanghai'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.dirname(__dirname)
const REWRITE_RULES_FILE =
  process.env.REWRITE_RULES_FILE || path.join('proxy', 'rewrite-rules.json')

const logDirTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: LOG_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})
  .format(new Date())
  .replace(' ', 'T')
  .replace(/[:.]/g, '-')
const LOG_DIR = path.join(__dirname, `traffic-log-${logDirTime}`)
const COMBINED_LOG_FILE = path.join(LOG_DIR, 'clean-traffic.log')

let requestSequence = 0

function formatLocalTimestamp(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: LOG_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false,
  })
  const formatted = formatter.format(now).replace(' ', 'T')
  const safe = formatted.replace(/[:.]/g, '-')
  return { formatted, safe }
}

function redactHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase()
    if (
      key.includes('authorization') ||
      key.includes('api-key') ||
      key.includes('x-api-key')
    ) {
      out[k] = '***REDACTED***'
    } else {
      out[k] = v
    }
  }
  return out
}

function redactBody(body) {
  const clone = structuredClone(body)
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      const key = String(k).toLowerCase()
      const isTokenLike =
        key.includes('token') &&
        key !== 'max_tokens' &&
        key !== 'budget_tokens' &&
        key !== 'input_tokens' &&
        key !== 'output_tokens'
      if (
        key === 'authorization' ||
        key === 'api_key' ||
        key === 'apikey' ||
        key === 'access_token' ||
        key === 'refresh_token' ||
        key === 'id_token' ||
        isTokenLike ||
        key === 'password' ||
        key === 'secret'
      ) {
        obj[k] = '***REDACTED***'
      } else if (typeof v === 'object') {
        walk(v)
      }
    }
  }
  walk(clone)
  return clone
}

async function collectReqBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function safeParseBody(buf, contentType = '') {
  const text = buf.toString('utf8')
  const isJson =
    contentType.includes('application/json') ||
    contentType.includes('+json') ||
    text.trim().startsWith('{') ||
    text.trim().startsWith('[')
  if (!isJson) return { kind: 'raw', value: text }
  try {
    return { kind: 'json', value: JSON.parse(text) }
  } catch (error) {
    return { kind: 'invalid-json', value: text, error: String(error) }
  }
}

function normalizeUpstreamPath(incomingPathname, upstreamBasePathname) {
  const incomingPath =
    typeof incomingPathname === 'string' && incomingPathname.length > 0
      ? incomingPathname
      : '/'
  const withLeadingSlash = incomingPath.startsWith('/')
    ? incomingPath
    : `/${incomingPath}`
  const basePath =
    upstreamBasePathname === '/' ? '' : upstreamBasePathname.replace(/\/$/, '')

  if (!basePath) return withLeadingSlash
  if (withLeadingSlash === basePath) return '/'
  if (withLeadingSlash.startsWith(`${basePath}/`)) {
    return withLeadingSlash.slice(basePath.length)
  }
  return withLeadingSlash
}

function splitPath(pathText) {
  const raw = String(pathText || '').trim()
  if (!raw) return []
  return raw.split('.').filter(Boolean)
}

function getByPath(obj, pathText) {
  if (!pathText) return obj
  const parts = splitPath(pathText)
  let cur = obj
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = cur[p]
  }
  return cur
}

function setByPath(obj, pathText, value) {
  const parts = splitPath(pathText)
  if (parts.length === 0) return value

  let cur = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]
    if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {}
    cur = cur[key]
  }
  cur[parts[parts.length - 1]] = value
  return obj
}

function deleteByPath(obj, pathText) {
  const parts = splitPath(pathText)
  if (parts.length === 0) return
  let cur = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]
    if (!cur || typeof cur !== 'object') return
    cur = cur[key]
  }
  if (cur && typeof cur === 'object') {
    delete cur[parts[parts.length - 1]]
  }
}

async function loadJsonFile(filePath) {
  const text = await fs.readFile(filePath, 'utf8')
  return JSON.parse(text)
}

function uniquePaths(paths) {
  const out = []
  const seen = new Set()
  for (const p of paths) {
    if (!p) continue
    const key = path.normalize(p)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

function candidatePaths(inputPath) {
  const raw = String(inputPath || '').trim()
  if (!raw) return []
  if (path.isAbsolute(raw)) return [raw]

  const base = path.basename(raw)
  return uniquePaths([
    path.resolve(process.cwd(), raw),
    path.resolve(REPO_ROOT, raw),
    path.resolve(__dirname, raw),
    path.resolve(process.cwd(), base),
    path.resolve(REPO_ROOT, base),
    path.resolve(__dirname, base),
  ])
}

async function loadJsonWithFallback(inputPath) {
  const tried = candidatePaths(inputPath)
  let lastError = null
  for (const filePath of tried) {
    try {
      const parsed = await loadJsonFile(filePath)
      return { ok: true, parsed, filePath, tried }
    } catch (error) {
      lastError = error
    }
  }
  return {
    ok: false,
    error: String(lastError || new Error(`Unable to load file: ${inputPath}`)),
    tried,
  }
}

async function loadRules() {
  const loaded = await loadJsonWithFallback(REWRITE_RULES_FILE)
  if (!loaded.ok) return { ok: false, error: loaded.error, tried: loaded.tried }
  return { ok: true, rules: loaded.parsed, filePath: loaded.filePath, tried: loaded.tried }
}

function methodMatched(method, rules) {
  const methods = Array.isArray(rules?.match?.methods) ? rules.match.methods : []
  if (methods.length === 0) return true
  const current = String(method || '').toUpperCase()
  return methods.map((m) => String(m).toUpperCase()).includes(current)
}

function pathMatched(pathname, rules) {
  const regexText = String(rules?.match?.pathRegex || '').trim()
  if (!regexText) return true
  try {
    return new RegExp(regexText).test(pathname)
  } catch {
    return false
  }
}

async function maybeLoadTemplate(rules) {
  const fileText = String(rules?.templateFile || '').trim()
  if (!fileText) return { ok: true, template: null }
  const loaded = await loadJsonWithFallback(fileText)
  if (!loaded.ok) {
    return { ok: false, error: loaded.error, templatePath: null, tried: loaded.tried }
  }
  return {
    ok: true,
    template: loaded.parsed,
    templatePath: loaded.filePath,
    tried: loaded.tried,
  }
}

function applyHeaderRewrite(headers, rules) {
  const next = { ...headers }
  const setMap = rules?.rewrite?.headers?.set || {}
  const removeList = Array.isArray(rules?.rewrite?.headers?.remove)
    ? rules.rewrite.headers.remove
    : []

  for (const [k, v] of Object.entries(setMap)) {
    next[String(k).toLowerCase()] = String(v)
  }
  for (const key of removeList) {
    delete next[String(key).toLowerCase()]
  }
  return next
}

function applyBodyRewrite(args) {
  const { body, rules, template } = args
  let next = structuredClone(body)
  const applied = []

  const copyOps = Array.isArray(rules?.rewrite?.body?.copyFromTemplate)
    ? rules.rewrite.body.copyFromTemplate
    : []
  for (const op of copyOps) {
    const from = String(op?.from || '').trim()
    const to = String(op?.to || '').trim()
    if (!from || !to) continue
    const value = getByPath(template, from)
    if (value === undefined) continue
    next = setByPath(next, to, structuredClone(value))
    applied.push(`copy:${from}->${to}`)
  }

  const setMap = rules?.rewrite?.body?.set || {}
  for (const [pathText, value] of Object.entries(setMap)) {
    next = setByPath(next, pathText, structuredClone(value))
    applied.push(`set:${pathText}`)
  }

  const removePaths = Array.isArray(rules?.rewrite?.body?.removePaths)
    ? rules.rewrite.body.removePaths
    : []
  for (const pathText of removePaths) {
    deleteByPath(next, pathText)
    applied.push(`delete:${pathText}`)
  }

  const preservePaths = Array.isArray(rules?.rewrite?.preserveOriginalPaths)
    ? rules.rewrite.preserveOriginalPaths
    : []
  for (const pathText of preservePaths) {
    const originalValue = getByPath(body, pathText)
    if (originalValue === undefined) continue
    next = setByPath(next, pathText, structuredClone(originalValue))
    applied.push(`preserve:${pathText}`)
  }

  return { body: next, applied }
}

async function applyRewrite(args) {
  const { method, pathname, originalHeaders, originalBody } = args
  const rulesLoaded = await loadRules()
  if (!rulesLoaded.ok) {
    return {
      rewrittenHeaders: { ...originalHeaders },
      rewrittenBody: originalBody,
      rewriteInfo: {
        enabled: false,
        reason: `rules-load-failed: ${rulesLoaded.error}`,
        triedPaths: rulesLoaded.tried,
      },
    }
  }

  const rules = rulesLoaded.rules || {}
  if (!rules.enabled) {
    return {
      rewrittenHeaders: { ...originalHeaders },
      rewrittenBody: originalBody,
      rewriteInfo: { enabled: false, reason: 'rules-disabled' },
    }
  }

  if (!methodMatched(method, rules) || !pathMatched(pathname, rules)) {
    return {
      rewrittenHeaders: { ...originalHeaders },
      rewrittenBody: originalBody,
      rewriteInfo: { enabled: false, reason: 'rules-not-matched' },
    }
  }

  const templateLoaded = await maybeLoadTemplate(rules)
  if (!templateLoaded.ok) {
    return {
      rewrittenHeaders: { ...originalHeaders },
      rewrittenBody: originalBody,
      rewriteInfo: {
        enabled: false,
        reason: `template-load-failed: ${templateLoaded.error}`,
        triedPaths: templateLoaded.tried,
      },
    }
  }

  const rewrittenHeaders = applyHeaderRewrite(originalHeaders, rules)

  let rewrittenBody = originalBody
  let appliedBodyOps = []
  if (originalBody && typeof originalBody === 'object' && !Array.isArray(originalBody)) {
    const bodyOut = applyBodyRewrite({
      body: originalBody,
      rules,
      template: templateLoaded.template,
    })
    rewrittenBody = bodyOut.body
    appliedBodyOps = bodyOut.applied
  }

  return {
    rewrittenHeaders,
    rewrittenBody,
    rewriteInfo: {
      enabled: true,
      reason: 'rules-applied',
      rulesPath: rulesLoaded.filePath,
      templatePath: templateLoaded.templatePath,
      bodyOps: appliedBodyOps,
      headerSetCount: Object.keys(rules?.rewrite?.headers?.set || {}).length,
      headerRemoveCount: Array.isArray(rules?.rewrite?.headers?.remove)
        ? rules.rewrite.headers.remove.length
        : 0,
    },
  }
}

async function writeTrafficLog(entry) {
  const tsSafe = entry.timestampLocalSafe
  const pathPart =
    (entry.path || 'root').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'root'
  const seqStr = String(entry.sequence || 0).padStart(4, '0')
  const filename = `${seqStr}_${tsSafe}_REQ_${pathPart}.json`
  await fs.writeFile(path.join(LOG_DIR, filename), JSON.stringify(entry, null, 2), 'utf8')
  return filename
}

async function appendCombinedLog(summary) {
  await fs.appendFile(COMBINED_LOG_FILE, `${JSON.stringify(summary)}\n`, 'utf8')
}

const server = http.createServer(async (req, res) => {
  const currentSequence = ++requestSequence
  const start = Date.now()
  let incomingUrl = null

  try {
    incomingUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    const upstreamBase = new URL(UPSTREAM_BASE.endsWith('/') ? UPSTREAM_BASE : `${UPSTREAM_BASE}/`)
    const normalizedPath = normalizeUpstreamPath(incomingUrl.pathname, upstreamBase.pathname)
    const upstreamPath = normalizedPath.replace(/^\//, '')
    const upstreamUrl = new URL(upstreamPath || '', upstreamBase)
    upstreamUrl.search = incomingUrl.search

    const originalBodyBuf = await collectReqBody(req)
    const parse = safeParseBody(
      originalBodyBuf,
      String(req.headers['content-type'] || ''),
    )

    const originalHeaders = { ...req.headers }
    const originalBody = parse.kind === 'json' ? parse.value : null

    const rewrite = await applyRewrite({
      method: req.method,
      pathname: incomingUrl.pathname,
      originalHeaders,
      originalBody,
    })

    const hopByHop = new Set([
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailers',
      'transfer-encoding',
      'upgrade',
      'host',
    ])

    const upstreamHeaders = {}
    const rewrittenHeaders = rewrite.rewrittenHeaders || {}
    for (const [k, v] of Object.entries(rewrittenHeaders)) {
      if (v === undefined || v === null) continue
      const lower = String(k).toLowerCase()
      if (hopByHop.has(lower)) continue
      upstreamHeaders[lower] = v
    }

    let rewrittenBodyBuf = originalBodyBuf
    if (originalBody && typeof rewrite.rewrittenBody === 'object') {
      const asText = JSON.stringify(rewrite.rewrittenBody)
      rewrittenBodyBuf = Buffer.from(asText, 'utf8')
      upstreamHeaders['content-type'] = 'application/json'
      upstreamHeaders['content-length'] = String(rewrittenBodyBuf.length)
    }

    const upstreamResp = await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: rewrittenBodyBuf.length ? rewrittenBodyBuf : undefined,
      redirect: 'manual',
    })

    res.statusCode = upstreamResp.status
    upstreamResp.headers.forEach((value, key) => {
      if (hopByHop.has(key.toLowerCase())) return
      res.setHeader(key, value)
    })

    let responseBuf = Buffer.alloc(0)
    if (!upstreamResp.body) {
      res.end()
    } else {
      const reader = upstreamResp.body.getReader()
      const chunks = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          const buf = Buffer.from(value)
          chunks.push(buf)
          res.write(buf)
        }
      }
      res.end()
      responseBuf = Buffer.concat(chunks)
    }

    const nowDate = new Date()
    const now = nowDate.toISOString()
    const { formatted: timestampLocal, safe: timestampLocalSafe } =
      formatLocalTimestamp(nowDate)
    const responseParsed = safeParseBody(
      responseBuf,
      String(upstreamResp.headers.get('content-type') || ''),
    )

    const fullEntry = {
      sequence: currentSequence,
      timestamp: now,
      timestampLocal,
      timestampLocalSafe,
      latencyMs: Date.now() - start,
      path: incomingUrl.pathname,
      rewrite: rewrite.rewriteInfo,
      requestOriginal: {
        headers: redactHeaders(originalHeaders),
        body: originalBody ? redactBody(originalBody) : parse.value,
      },
      requestRewritten: {
        headers: redactHeaders(rewrittenHeaders),
        body:
          rewrite.rewrittenBody && typeof rewrite.rewrittenBody === 'object'
            ? redactBody(rewrite.rewrittenBody)
            : parse.value,
      },
      response: {
        status: upstreamResp.status,
        body:
          responseParsed.kind === 'json'
            ? redactBody(responseParsed.value)
            : responseParsed.value,
      },
    }

    const rawFile = await writeTrafficLog(fullEntry)
    await appendCombinedLog({
      seq: currentSequence,
      time: now,
      timeLocal: timestampLocal,
      path: incomingUrl.pathname,
      status: upstreamResp.status,
      latencyMs: Date.now() - start,
      rewrite: rewrite.rewriteInfo,
      rawFile,
    })
  } catch (error) {
    const message = String(error?.message || error)
    res.statusCode = 502
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: 'proxy_error', message }))
    console.error('[rewrite-proxy] error:', message)
  }
})

server.listen(LISTEN_PORT, '127.0.0.1', async () => {
  await fs.mkdir(LOG_DIR, { recursive: true })
  console.log(`[rewrite-proxy] listening: http://127.0.0.1:${LISTEN_PORT}`)
  console.log(`[rewrite-proxy] upstream: ${UPSTREAM_BASE}`)
  console.log(`[rewrite-proxy] rules(config): ${REWRITE_RULES_FILE}`)
  console.log(
    `[rewrite-proxy] rules(candidates): ${candidatePaths(REWRITE_RULES_FILE).join(' | ')}`,
  )
  console.log(`[rewrite-proxy] log dir: ${LOG_DIR}`)
})
