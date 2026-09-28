// dsh-overlay-opacity — host half.
//
// 职责只有一件：把「浮层不透明度」这一份偏好持久化到宿主文件，并通过
// webServer 暴露给浏览器半边。之所以不在浏览器侧用 localStorage：
// DSH Desktop 每次启动换随机端口 → origin 变化 → localStorage 恒空，
// 设置会每次重启丢失（wallpaper-engine / dream-skin 都踩过这条）。
//
// 不依赖任何 @deepseek-ai/* 包：装配差异（包被重命名/合并）不该让这个
// 只读写一个 JSON 的插件加载失败。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis 插件名（loader 诊断）。 */
export const name = 'dsh-overlay-opacity'

/**
 * 硬依赖 webServer：让 Loader 等 HTTP 服务挂载后再 apply 本行。
 *
 * 不声明 inject 而直接在 apply 里读 ctx.webServer 会失败——cordis 对未声明的
 * 服务属性访问直接抛错（"cannot get property webServer without inject"），本行
 * 会被标记 failed，路由一条都注册不上；即便侥幸不抛，各行并发挂载时服务也可
 * 能还不存在，路由同样被静默跳过。本插件是 web-only（package.json 的
 * dsh.client.platform 为 "web"），硬注入是正确取舍；headless/TUI profile 本来
 * 也不装它。
 */
export const inject = ['webServer']

/** 路由前缀。 */
const BASE = '/overlay-opacity'

/**
 * 出厂默认值。
 *
 * menu：菜单 / 下拉 / 命令浮层。DSH 主题在 darwin 上给的是 #f8f9faf0（≈94%），
 *       非 darwin 走 --dsw-menu-surface-fill（浅色 58% / 深色 45%）。
 * overlay：弹窗 / 浮层底，主题给的是实色 token，默认不动它（1.0 表示保持
 *       解析到的原色，仅当用户主动调低才生效）。
 */
const DEFAULTS = Object.freeze({ enabled: true, menu: 0.97, overlay: 1 })

/** 请求体上限：这份配置只有三个标量，8 KiB 远超实际需要。 */
const MAX_BODY_BYTES = 8 * 1024

/** 数据目录。DSH_OVERLAY_OPACITY_DATA_DIR 供测试隔离真实配置。 */
function dataDir() {
  const override =
    typeof process.env.DSH_OVERLAY_OPACITY_DATA_DIR === 'string'
      ? process.env.DSH_OVERLAY_OPACITY_DATA_DIR.trim()
      : ''
  return override !== '' ? override : join(homedir(), '.dsh-overlay-opacity')
}

/** 配置文件绝对路径。 */
function configPath() {
  return join(dataDir(), 'config.json')
}

/** 把任意输入夹到 [0,1]；不可解析时用 fallback。 */
function clampAlpha(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

/**
 * 规范化一份设置对象；不是普通对象时返回 null（让调用方回 400，而不是
 * 悄悄写入一份半成品配置）。
 */
export function sanitizeSettings(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULTS.enabled,
    menu: clampAlpha(input.menu, DEFAULTS.menu),
    overlay: clampAlpha(input.overlay, DEFAULTS.overlay),
  }
}

/** 读配置：任何异常（缺文件 / 坏 JSON / 字段非法）都回默认值。 */
export function readSettings() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8'))
    return sanitizeSettings(parsed) ?? { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

/** 写配置：先写同目录临时文件再 rename，避免半截 JSON 覆盖好配置。 */
export function writeSettings(next) {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `config.json.tmp${process.pid}`)
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, configPath())
}

/**
 * Host apply：注册两个路由。
 *
 * @param ctx - host context。
 * @returns 卸载函数（cordis 在插件卸载 / HMR 时调用）。
 */
export function apply(ctx) {
  const webServer = ctx && ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    // 没有 HTTP 服务器（headless / TUI profile）：静默降级，绝不让装配失败。
    return () => {}
  }

  // 写操作串行化：并发 POST 不再互相覆盖（同 wallpaper-engine 的
  // enqueueConfigWrite 语义）。
  let queue = Promise.resolve()

  const sendJson = (res, status, payload) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  const disposers = []

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: `${BASE}/settings`,
      handler: (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          sendJson(res, 200, readSettings())
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }

        let size = 0
        let settled = false
        const chunks = []
        req.on('data', (chunk) => {
          if (settled) return
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            settled = true
            sendJson(res, 413, { error: 'body too large' })
            req.resume() // 排空剩余请求体，避免连接悬挂
            return
          }
          chunks.push(chunk)
        })
        req.on('error', () => {
          if (settled) return
          settled = true
          sendJson(res, 400, { error: 'request error' })
        })
        req.on('end', () => {
          if (settled) return
          settled = true
          let parsed
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            sendJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const next = sanitizeSettings(parsed)
          if (next === null) {
            sendJson(res, 400, { error: 'settings must be a JSON object' })
            return
          }
          queue = queue.then(
            () => {
              try {
                writeSettings(next)
                sendJson(res, 200, next)
              } catch (err) {
                sendJson(res, 500, { error: String(err && err.message ? err.message : err) })
              }
            },
            () => {
              try {
                writeSettings(next)
                sendJson(res, 200, next)
              } catch (err) {
                sendJson(res, 500, { error: String(err && err.message ? err.message : err) })
              }
            },
          )
        })
      },
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载路径上的异常不该冒泡 */
      }
    }
  }
}
