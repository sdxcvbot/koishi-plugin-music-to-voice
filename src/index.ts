import { Context, Schema, h, Logger, Session } from 'koishi'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

export const name = 'music-to-voice'
const logger = new Logger(name)

export interface Config {
  commandName: string
  commandAlias: string
  apiBase: string
  source: 'netease' | 'tencent' | 'kugou' | 'kuwo' | 'migu'
  searchListCount: number
  waitForTimeout: number

  nextPageCommand: string
  prevPageCommand: string
  exitCommandList: string[]
  menuExitCommandTip: boolean

  // 撤回策略
  menuRecallSec: number
  tipRecallSec: number
  recallOnlyAfterSuccess: boolean
  keepMenuIfSendFailed: boolean

  // 发送
  sendAs: 'record' | 'audio' | 'file'
  forceTranscode: boolean
  maxSongDuration: number // 分钟，0=不限制
  userAgent: string
  generationTip: string
}

/**
 * 可选注入：不装也能跑，只是能力不同
 * - downloads：下载到文件
 * - silk：编码 silk（QQ 语音更稳）
 * - ffmpeg：转 PCM（silk 前置）
 * - puppeteer：未来可做图片歌单（你现在先不启用也没事）
 */
export const inject = {
  optional: ['downloads', 'ffmpeg', 'silk', 'puppeteer'],
}

/**
 * ✅ 这段会显示在“插件设置页”，不会在后台日志刷屏
 */
export const usage = `
### 点歌语音（支持翻页 + 可选 silk/ffmpeg）

开启插件前，请确保以下服务已经启用（可选安装）：

- **puppeteer 服务（可选安装）**

此外可能还需要这些服务才能发送语音：

- **ffmpeg 服务（可选安装）**（此服务可能额外依赖 **downloads** 服务）
- **silk 服务（可选安装）**

> 本插件使用音乐聚合接口（GD音乐台 API）：https://music-api.gdstudio.xyz/api.php
`

export const Config: Schema<Config> = Schema.object({
  commandName: Schema.string().description('指令名称').default('听歌'),
  commandAlias: Schema.string().description('指令别名').default('music'),

  apiBase: Schema.string()
    .description('音乐 API 地址（GD音乐台 API）')
    .default('https://music-api.gdstudio.xyz/api.php'),

  // ✅ 后台显示品牌名（你要求的）
  source: Schema.union([
    Schema.const('netease').description('网易云'),
    Schema.const('tencent').description('QQ音乐'),
    Schema.const('kugou').description('酷狗'),
    Schema.const('kuwo').description('酷我'),
    Schema.const('migu').description('咪咕'),
  ]).description('音源（下拉选择）').default('kuwo'),

  searchListCount: Schema.natural().min(1).max(30).step(1).description('搜索列表数量').default(20),
  waitForTimeout: Schema.natural().min(5).max(300).step(1).description('等待输入序号超时（秒）').default(45),

  nextPageCommand: Schema.string().description('下一页指令').default('下一页'),
  prevPageCommand: Schema.string().description('上一页指令').default('上一页'),
  exitCommandList: Schema.array(Schema.string()).role('table').description('退出指令列表（一行一个）').default(['0', '不听了', '退出']),
  menuExitCommandTip: Schema.boolean().description('是否在歌单末尾提示退出指令').default(false),

  // ✅ 解决“太快撤回”的关键：默认 60 秒撤回歌单；并且默认“发送成功才撤回”
  menuRecallSec: Schema.natural().min(0).max(3600).step(1).description('歌单撤回秒数（0=不撤回）').default(60),
  tipRecallSec: Schema.natural().min(0).max(3600).step(1).description('“生成中”提示撤回秒数（0=不撤回）').default(10),
  recallOnlyAfterSuccess: Schema.boolean().description('仅在发送成功后才撤回（推荐开启）').default(true),
  keepMenuIfSendFailed: Schema.boolean().description('发送失败时保留歌单（推荐开启）').default(true),

  sendAs: Schema.union([
    Schema.const('record').description('语音 record（推荐）'),
    Schema.const('audio').description('音频 audio'),
    Schema.const('file').description('文件 file'),
  ]).description('发送类型').default('record'),

  // ✅ 装了 downloads+ffmpeg+silk 后会更稳（QQ 语音经常只认 silk）
  forceTranscode: Schema.boolean().description('强制转码（需要 downloads + ffmpeg + silk；更稳但依赖更多）').default(true),
  maxSongDuration: Schema.natural().min(0).max(180).step(1).description('歌曲最长时长（分钟，0=不限制）').default(30),

  userAgent: Schema.string().description('请求 UA（部分环境可避免风控/403）').default('koishi-music-to-voice/1.0'),
  generationTip: Schema.string().description('选择序号后发送的提示文案').default('音乐生成中…'),
})

type SearchItem = {
  id: string
  name: string
  artist?: string[] | string
  album?: string
  url_id?: string
  pic_id?: string
  source: string
  duration?: number // 秒（有些源会返回）
}

type PendingState = {
  userId: string
  channelId: string
  keyword: string
  page: number
  items: SearchItem[]
  menuMessageIds: string[]
  tipMessageIds: string[]
  timer?: NodeJS.Timeout
}

const pending = new Map<string, PendingState>()

function ms(sec: number) {
  return Math.max(1, sec) * 1000
}

function keyOf(session: Session) {
  return `${session.platform}:${session.userId || 'unknown'}:${session.channelId || session.guildId || 'unknown'}`
}

function normalizeArtist(a: any): string {
  if (!a) return ''
  if (Array.isArray(a)) return a.join(' / ')
  return String(a)
}

function formatMenu(state: PendingState, config: Config) {
  const lines: string[] = []
  lines.push(`点歌列表（第 ${state.page} 页）`)
  lines.push(`关键词：${state.keyword}`)
  lines.push('')
  state.items.forEach((it, idx) => {
    const n = idx + 1
    const artist = normalizeArtist(it.artist)
    lines.push(`${n}. ${it.name}${artist ? ` - ${artist}` : ''}`)
  })
  lines.push('')
  lines.push(`请在 ${config.waitForTimeout} 秒内输入歌曲序号`)
  lines.push(`翻页：${config.prevPageCommand} / ${config.nextPageCommand}`)
  if (config.menuExitCommandTip) lines.push(`退出：${config.exitCommandList.join(' / ')}`)
  return lines.join('\n')
}

async function safeSend(session: Session, content: any) {
  const ids = await session.send(content)
  if (Array.isArray(ids)) return ids.filter(Boolean)
  return ids ? [ids] : []
}

function recall(session: Session, ids: string[], sec: number) {
  if (!ids?.length || sec <= 0) return
  const channelId = session.channelId
  if (!channelId) return
  setTimeout(() => {
    ids.forEach((id) => session.bot.deleteMessage(channelId, id).catch(() => {}))
  }, sec * 1000)
}

async function apiSearch(ctx: Context, config: Config, keyword: string, page: number) {
  const params = new URLSearchParams({
    types: 'search',
    source: config.source,
    name: keyword,
    count: String(config.searchListCount),
    pages: String(page),
  })
  const url = `${config.apiBase}?${params.toString()}`
  const data = await ctx.http.get(url, {
    headers: { 'user-agent': config.userAgent },
    responseType: 'json',
    timeout: 15000,
  })
  if (!Array.isArray(data)) throw new Error('search response is not array')
  return data as SearchItem[]
}

async function apiGetSongUrl(ctx: Context, config: Config, item: SearchItem) {
  const id = item.url_id || item.id
  const params = new URLSearchParams({
    types: 'url',
    id: String(id),
    source: item.source || config.source,
  })
  const url = `${config.apiBase}?${params.toString()}`
  const data = await ctx.http.get(url, {
    headers: { 'user-agent': config.userAgent },
    responseType: 'json',
    timeout: 15000,
  })
  const u = (Array.isArray(data) ? data[0]?.url : data?.url) as string | undefined
  if (!u) throw new Error('url not found from api')
  return u
}

function tmpFile(ext: string) {
  const id = crypto.randomBytes(8).toString('hex')
  return path.join(os.tmpdir(), `koishi-music-${id}.${ext}`)
}

async function downloadToFile(ctx: Context, config: Config, url: string, filePath: string) {
  const anyCtx = ctx as any
  if (anyCtx.downloads?.download) {
    await anyCtx.downloads.download(url, filePath, {
      headers: { 'user-agent': config.userAgent },
    })
    return
  }
  const buf = await ctx.http.get<ArrayBuffer>(url, {
    headers: { 'user-agent': config.userAgent },
    responseType: 'arraybuffer',
    timeout: 30000,
  })
  fs.writeFileSync(filePath, Buffer.from(buf))
}

function runFfmpegToPcm(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-i', input, '-ac', '1', '-ar', '48000', '-f', 's16le', output], { stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit code ${code}`))))
  })
}

async function encodeSilk(ctx: Context, pcmPath: string): Promise<Buffer> {
  const anyCtx = ctx as any
  if (anyCtx.silk?.encode) {
    const pcm = fs.readFileSync(pcmPath)
    const out = await anyCtx.silk.encode(pcm, 48000)
    return Buffer.isBuffer(out) ? out : Buffer.from(out)
  }
  throw new Error('silk service encode not available')
}

/**
 * ✅ 为什么“人家的插件可选安装也能成功”？
 * 关键在于：它通常会在“能转 silk 就转”，否则回退为“直接发音频/文件/直链 record”。
 * 这样没装依赖也能出结果，只是 QQ 语音成功率可能低一些。
 */
async function sendSong(session: Session, ctx: Context, config: Config, url: string) {
  // record + 强制转码：downloads -> ffmpeg -> silk（QQ 最稳）
  if (config.sendAs === 'record' && config.forceTranscode) {
    const anyCtx = ctx as any
    if (anyCtx.downloads && anyCtx.silk) {
      try {
        const inFile = tmpFile('mp3')
        const pcmFile = tmpFile('pcm')
        await downloadToFile(ctx, config, url, inFile)
        await runFfmpegToPcm(inFile, pcmFile)
        const silkBuf = await encodeSilk(ctx, pcmFile)
        try { fs.unlinkSync(inFile) } catch {}
        try { fs.unlinkSync(pcmFile) } catch {}
        return await safeSend(session, h('record', { src: silkBuf }))
      } catch (e) {
        logger.warn('transcode/send record failed, fallback: %s', (e as Error).message)
      }
    }
  }

  // 回退策略：不装依赖也能发（但 QQ “语音 record(url)” 可能不稳定）
  if (config.sendAs === 'record') return await safeSend(session, h('record', { src: url }))
  if (config.sendAs === 'audio') return await safeSend(session, h.audio(url))
  return await safeSend(session, h.file(url))
}

export function apply(ctx: Context, config: Config) {
  // 主命令：听歌 <keyword>
  ctx.command(`${config.commandName} <keyword:text>`, '点歌并发送语音/音频')
    .alias(config.commandAlias)
    .action(async ({ session }, keyword) => {
      if (!session) return
      keyword = (keyword || '').trim()
      if (!keyword) return `用法：${config.commandName} 歌曲名`

      const k = keyOf(session)
      const old = pending.get(k)
      if (old?.timer) clearTimeout(old.timer)
      pending.delete(k)

      let items: SearchItem[]
      try {
        items = await apiSearch(ctx, config, keyword, 1)
      } catch (e) {
        logger.warn('search failed: %s', (e as Error).message)
        return '搜索失败（API 不可用或超时），请稍后再试。'
      }
      if (!items.length) return '没有搜索到结果。'

      const state: PendingState = {
        userId: session.userId || '',
        channelId: session.channelId || '',
        keyword,
        page: 1,
        items,
        menuMessageIds: [],
        tipMessageIds: [],
      }
      pending.set(k, state)

      const menuText = formatMenu(state, config)
      state.menuMessageIds = await safeSend(session, menuText)

      // ✅ 你说的“太快撤回”就是这里：我们默认给 60 秒，并且发送成功才撤回
      if (config.menuRecallSec > 0 && !config.recallOnlyAfterSuccess) {
        recall(session, state.menuMessageIds, config.menuRecallSec)
      }

      state.timer = setTimeout(async () => {
        const cur = pending.get(k)
        if (!cur) return
        pending.delete(k)
        await session.send('输入超时，已取消点歌。')
      }, ms(config.waitForTimeout))

      return
    })

  // 捕获“序号 / 翻页 / 退出”
  ctx.middleware(async (session, next) => {
    const k = keyOf(session)
    const state = pending.get(k)
    if (!state) return next()

    // 只允许同一用户、同一频道继续操作
    if ((session.userId || '') !== state.userId || (session.channelId || '') !== state.channelId) return next()

    const content = (session.content || '').trim()
    if (!content) return next()

    // 退出
    if (config.exitCommandList.map(s => s.trim()).filter(Boolean).includes(content)) {
      pending.delete(k)
      if (state.timer) clearTimeout(state.timer)
      await session.send('已退出歌曲选择。')
      return
    }

    // 翻页
    if (content === config.nextPageCommand || content === config.prevPageCommand) {
      const target = content === config.nextPageCommand ? state.page + 1 : Math.max(1, state.page - 1)
      if (target === state.page) {
        await session.send('已经是第一页。')
        return
      }
      try {
        const items = await apiSearch(ctx, config, state.keyword, target)
        if (!items.length) {
          await session.send('没有更多结果了。')
          return
        }
        state.page = target
        state.items = items
        const menuText = formatMenu(state, config)
        const newIds = await safeSend(session, menuText)
        state.menuMessageIds.push(...newIds)
        if (config.menuRecallSec > 0 && !config.recallOnlyAfterSuccess) recall(session, newIds, config.menuRecallSec)
      } catch (e) {
        logger.warn('page search failed: %s', (e as Error).message)
        await session.send('翻页失败（API 不可用或超时）。')
      }
      return
    }

    // 选择序号
    const n = Number(content)
    if (!Number.isInteger(n) || n < 1 || n > state.items.length) return next()

    if (state.timer) clearTimeout(state.timer)

    const tipIds = await safeSend(session, config.generationTip)
    state.tipMessageIds.push(...tipIds)
    if (config.tipRecallSec > 0 && !config.recallOnlyAfterSuccess) recall(session, tipIds, config.tipRecallSec)

    try {
      const item = state.items[n - 1]
      const songUrl = await apiGetSongUrl(ctx, config, item)

      // 最长时长控制（只有 API 返回 duration 才会生效）
      if (config.maxSongDuration > 0 && item.duration && item.duration / 60 > config.maxSongDuration) {
        await session.send(`该歌曲时长超出限制（>${config.maxSongDuration} 分钟），已取消发送。`)
        return
      }

      await sendSong(session, ctx, config, songUrl)

      // ✅ 发送成功后才撤回（默认开启），解决你截图那种“瞬间撤回导致看不到/发不出来”
      if (config.recallOnlyAfterSuccess) {
        if (config.tipRecallSec > 0) recall(session, tipIds, 1)
        if (config.menuRecallSec > 0) recall(session, state.menuMessageIds, 1)
      }

      pending.delete(k)
      return
    } catch (e) {
      logger.warn('send failed: %s', (e as Error).stack || (e as Error).message)
      await session.send('获取/发送失败，请稍后再试。')

      if (!config.keepMenuIfSendFailed) {
        pending.delete(k)
      } else {
        state.timer = setTimeout(() => pending.delete(k), ms(config.waitForTimeout))
      }
      return
    }
  })
}
