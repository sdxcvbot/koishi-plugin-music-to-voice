import { Context, Schema, Logger, h } from 'koishi'
import axios from 'axios'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export const name = 'music-voice-pro'
const logger = new Logger(name)

type MusicSource = 'netease' | 'tencent' | 'kugou' | 'kuwo' | 'migu' | 'baidu'

export interface Config {
  // 命令
  commandName: string
  commandAlias: string

  // API
  apiBase: string
  source: MusicSource
  searchListCount: number

  // 交互
  waitForTimeout: number
  nextPageCommand: string
  prevPageCommand: string
  exitCommandList: string[]
  menuExitCommandTip: boolean

  // 图片歌单（预留）
  imageMode: boolean

  // 发送类型
  sendAs: 'record' | 'audio'

  // 转码与缓存
  forceTranscode: boolean
  tempDir: string
  cacheMinutes: number

  // 提示与撤回
  generationTip: string
  recallSearchMenuMessage: boolean
  recallTipMessage: boolean
  recallUserSelectMessage: boolean
  recallVoiceMessage: boolean

  // 调试
  loggerinfo: boolean
}

export const Config: Schema<Config> = Schema.object({
  commandName: Schema.string().default('听歌').description('指令名称'),
  commandAlias: Schema.string().default('music').description('指令别名'),

  apiBase: Schema.string().default('https://music-api.gdstudio.xyz/api.php').description('音乐 API 地址（GD音乐台 API）'),
  source: Schema.union([
    Schema.const('netease').description('网易云'),
    Schema.const('tencent').description('QQ音乐'),
    Schema.const('kugou').description('酷狗'),
    Schema.const('kuwo').description('酷我'),
    Schema.const('migu').description('咪咕'),
    Schema.const('baidu').description('百度'),
  ]).default('netease').description('音源（下拉选择）'),
  searchListCount: Schema.number().min(5).max(50).default(20).description('搜索列表数量'),

  waitForTimeout: Schema.number().min(10).max(180).default(45).description('等待输入序号超时（秒）'),
  nextPageCommand: Schema.string().default('下一页').description('下一页指令'),
  prevPageCommand: Schema.string().default('上一页').description('上一页指令'),
  exitCommandList: Schema.array(String).default(['0', '不听了', '退出']).description('退出指令列表'),
  menuExitCommandTip: Schema.boolean().default(false).description('是否在歌单末尾提示退出指令'),

  imageMode: Schema.boolean().default(false).description('图片歌单模式（可选：需要 puppeteer 插件，当前仅保留开关）'),

  sendAs: Schema.union([
    Schema.const('record').description('语音 record'),
    Schema.const('audio').description('音频 audio'),
  ]).default('record').description('发送类型'),

  forceTranscode: Schema.boolean().default(true).description('是否强制转码为 silk（需要 ffmpeg + silk 插件）'),
  tempDir: Schema.string().default(path.join(os.tmpdir(), 'koishi-music-voice')).description('临时目录'),
  cacheMinutes: Schema.number().min(0).max(1440).default(120).description('缓存时长（分钟，0=不缓存）'),

  generationTip: Schema.string().default('生成语音中...').description('用户选歌后提示'),

  recallSearchMenuMessage: Schema.boolean().default(true).description('撤回：歌单消息'),
  recallTipMessage: Schema.boolean().default(true).description('撤回：生成提示消息'),
  recallUserSelectMessage: Schema.boolean().default(true).description('撤回：用户输入的序号消息'),
  recallVoiceMessage: Schema.boolean().default(false).description('撤回：语音消息'),

  loggerinfo: Schema.boolean().default(false).description('日志调试模式'),
}).description('点歌语音（支持翻页 + 可选 silk/ffmpeg）')

type SearchItem = {
  id: string
  name: string
  artist?: string
  album?: string
}

type PendingState = {
  userId: string
  channelId: string
  guildId?: string

  keyword: string
  page: number
  list: SearchItem[]
  expiresAt: number

  menuMessageId?: string
  tipMessageId?: string
  voiceMessageId?: string
}

function safeText(x: unknown): string {
  return typeof x === 'string' ? x : x == null ? '' : String(x)
}

function normalizeSearchList(data: any): SearchItem[] {
  const arr: any[] =
    Array.isArray(data) ? data
      : Array.isArray(data?.result) ? data.result
        : Array.isArray(data?.data) ? data.data
          : Array.isArray(data?.songs) ? data.songs
            : []

  return arr.map((it: any) => {
    const id = safeText(it?.id ?? it?.songid ?? it?.rid ?? it?.hash ?? it?.mid)
    const name = safeText(it?.name ?? it?.songname ?? it?.title)
    const artist =
      safeText(it?.artist) ||
      safeText(it?.singer) ||
      safeText(it?.author) ||
      (Array.isArray(it?.artists) ? it.artists.map((a: any) => safeText(a?.name)).filter(Boolean).join('/') : '')

    const album = safeText(it?.album ?? it?.albummid ?? it?.albumname)
    return { id, name, artist, album }
  }).filter((x: SearchItem) => x.id && x.name)
}

function normalizeUrl(data: any): string {
  return (
    safeText(data?.url) ||
    safeText(data?.data?.url) ||
    safeText(data?.result?.url) ||
    safeText(data?.data) ||
    ''
  )
}

function md5(s: string) {
  return crypto.createHash('md5').update(s).digest('hex')
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true })
}

async function tryRecall(session: any, messageId?: string) {
  if (!messageId) return
  try {
    await session.bot.deleteMessage(session.channelId, messageId)
  } catch {
    // ignore
  }
}

function hRecord(src: string) {
  return h('record', { src })
}

function hAudio(src: string) {
  return h('audio', { src })
}

function buildMenuText(config: Config, keyword: string, list: SearchItem[], page: number) {
  const lines: string[] = []
  lines.push(`NetEase Music:`)
  lines.push(`关键词：${keyword}`)
  lines.push(`音源：${config.source}  第 ${page} 页`)
  lines.push('')
  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    const meta = [it.artist, it.album].filter(Boolean).join(' - ')
    lines.push(`${i + 1}. ${it.name}${meta ? ` -- ${meta}` : ''}`)
  }
  lines.push('')
  lines.push(`请在 ${config.waitForTimeout} 秒内输入序号（1-${list.length}）`)
  lines.push(`翻页：${config.prevPageCommand} / ${config.nextPageCommand}`)
  if (config.menuExitCommandTip) {
    lines.push(`退出：${config.exitCommandList.join(' / ')}`)
  }
  lines.push('')
  lines.push('数据来源：GD音乐台 API')
  return lines.join('\n')
}

async function apiSearch(config: Config, keyword: string, page = 1): Promise<SearchItem[]> {
  const params = {
    types: 'search',
    source: config.source,
    name: keyword,
    count: config.searchListCount,
    pages: page,
  }
  const { data } = await axios.get(config.apiBase, { params, timeout: 15000 })
  return normalizeSearchList(data)
}

async function apiGetSongUrl(config: Config, id: string): Promise<string> {
  const params = { types: 'url', source: config.source, id }
  const { data } = await axios.get(config.apiBase, { params, timeout: 15000 })
  return normalizeUrl(data)
}

async function downloadToFile(url: string, filePath: string) {
  const res = await axios.get(url, { responseType: 'stream', timeout: 30000 })
  await new Promise<void>((resolve, reject) => {
    const ws = fs.createWriteStream(filePath)
    res.data.pipe(ws)
    ws.on('finish', () => resolve())
    ws.on('error', reject)
  })
}

async function sendVoiceByUrl(session: any, config: Config, audioUrl: string) {
  const seg = config.sendAs === 'record' ? hRecord(audioUrl) : hAudio(audioUrl)
  const ids = await session.send(seg)
  return Array.isArray(ids) ? ids[0] : ids
}

async function sendVoiceByFile(session: any, config: Config, absPath: string) {
  const url = `file://${absPath.replace(/\\/g, '/')}`
  const seg = config.sendAs === 'record' ? hRecord(url) : hAudio(url)
  const ids = await session.send(seg)
  return Array.isArray(ids) ? ids[0] : ids
}

/**
 * 可选：使用 Koishi 市场的 ffmpeg/silk 服务
 * 返回 silk 文件绝对路径；返回 null 表示无法转码（可降级直链）
 */
async function buildSilkIfPossible(ctx: Context, config: Config, audioUrl: string, cacheKey: string): Promise<string | null> {
  const hasFfmpeg = !!(ctx as any).ffmpeg
  const hasSilk = !!(ctx as any).silk
  if (!hasFfmpeg || !hasSilk) return null

  ensureDir(config.tempDir)

  const silkPath = path.join(config.tempDir, `${cacheKey}.silk`)
  if (config.cacheMinutes > 0 && fs.existsSync(silkPath)) {
    return silkPath
  }

  const rawPath = path.join(config.tempDir, `${cacheKey}.src`)
  await downloadToFile(audioUrl, rawPath)

  const wavPath = path.join(config.tempDir, `${cacheKey}.wav`)
  const ffmpeg: any = (ctx as any).ffmpeg

  try {
    if (typeof ffmpeg.convert === 'function') {
      await ffmpeg.convert(rawPath, wavPath, {
        format: 'wav',
        audioChannels: 1,
        audioFrequency: 24000,
      })
    } else if (typeof ffmpeg.exec === 'function') {
      await ffmpeg.exec(['-y', '-i', rawPath, '-ac', '1', '-ar', '24000', wavPath])
    } else {
      throw new Error('ffmpeg service API not recognized')
    }
  } catch (e: any) {
    throw new Error(`ffmpeg 转码失败：${e?.message || String(e)}`)
  }

  const silk: any = (ctx as any).silk
  try {
    if (typeof silk.encode === 'function') {
      await silk.encode(wavPath, silkPath, { rate: 24000 })
    } else if (typeof silk.encodeWav === 'function') {
      await silk.encodeWav(wavPath, silkPath, { rate: 24000 })
    } else {
      throw new Error('silk service API not recognized')
    }
  } catch (e: any) {
    throw new Error(`silk 编码失败：${e?.message || String(e)}`)
  } finally {
    try { fs.unlinkSync(rawPath) } catch {}
    try { fs.unlinkSync(wavPath) } catch {}
  }

  return silkPath
}

function logDepsHint(ctx: Context) {
  const hasPuppeteer = !!(ctx as any).puppeteer
  const hasFfmpeg = !!(ctx as any).ffmpeg
  const hasSilk = !!(ctx as any).silk
  const hasDownloads = !!(ctx as any).downloads

  logger.info('开启插件前，请确保以下服务已经启用（可选安装）：')
  logger.info(`- puppeteer服务（可选安装）：${hasPuppeteer ? '已检测到' : '未检测到'}`)
  logger.info('此外可能还需要这些服务才能发送语音：')
  logger.info(`- ffmpeg服务（可选安装）（此服务可能额外依赖downloads服务）：${hasFfmpeg ? '已检测到' : '未检测到'}`)
  logger.info(`- silk服务（可选安装）：${hasSilk ? '已检测到' : '未检测到'}`)
  logger.info(`- downloads服务（可选安装）：${hasDownloads ? '已检测到' : '未检测到'}`)
  logger.info('Music API 出处：GD音乐台 API（https://music-api.gdstudio.xyz/api.php）')
}

export function apply(ctx: Context, config: Config) {
  if (config.loggerinfo) logger.level = Logger.DEBUG
  logDepsHint(ctx)

  const pending = new Map<string, PendingState>() // channelId -> state

  function getKey(session: any) {
    return String(session?.channelId || '')
  }

  function isExit(input: string) {
    const t = input.trim()
    return config.exitCommandList.map(s => s.trim()).includes(t)
  }

  function isExpired(state: PendingState) {
    return Date.now() > state.expiresAt
  }

  async function refreshMenu(session: any, state: PendingState) {
    const list = await apiSearch(config, state.keyword, state.page)
    state.list = list
    state.expiresAt = Date.now() + config.waitForTimeout * 1000

    if (config.recallSearchMenuMessage) {
      await tryRecall(session, state.menuMessageId)
      state.menuMessageId = undefined
    }

    if (!config.recallSearchMenuMessage) {
      const text = buildMenuText(config, state.keyword, list, state.page)
      const ids = await session.send(text)
      state.menuMessageId = Array.isArray(ids) ? ids[0] : ids
    } else {
      await session.send(`已翻到第 ${state.page} 页，请直接发送序号（1-${list.length}）`)
    }
  }

  async function handlePick(session: any, state: PendingState, pickIndex: number) {
    const item = state.list[pickIndex]
    if (!item) {
      await session.send(`序号无效，请输入 1-${state.list.length}，或输入 ${config.exitCommandList.join('/')} 退出。`)
      return
    }

    // 提示：生成中...
    let tipId: string | undefined
    if (!config.recallTipMessage && config.generationTip?.trim()) {
      const ids = await session.send(config.generationTip)
      tipId = Array.isArray(ids) ? ids[0] : ids
    }

    // 取直链
    let songUrl = ''
    try {
      songUrl = await apiGetSongUrl(config, item.id)
      if (!songUrl) throw new Error('empty url')
    } catch {
      await session.send('获取歌曲直链失败，请稍后再试，或更换音源。')
      return
    }

    const cacheKey = md5(`${config.source}:${item.id}`)
    let voiceId: string | undefined

    try {
      const silkPath = await buildSilkIfPossible(ctx, config, songUrl, cacheKey)
      if (silkPath) {
        voiceId = await sendVoiceByFile(session, config, silkPath)
      } else {
        if (config.forceTranscode) {
          await session.send(
            `当前配置为【强制 silk 转码】但未检测到 ffmpeg/silk 服务。\n` +
            `请在 Koishi 插件市场安装并启用：ffmpeg、silk（可能还需要 downloads）。`
          )
          return
        }
        voiceId = await sendVoiceByUrl(session, config, songUrl)
      }
    } catch (e: any) {
      await session.send(`生成语音失败：${e?.message || String(e)}\n请检查 ffmpeg/silk 插件是否启用，或关闭“强制转码”。`)
      return
    } finally {
      state.tipMessageId = tipId
      state.voiceMessageId = voiceId
    }

    if (config.recallSearchMenuMessage) await tryRecall(session, state.menuMessageId)
    if (config.recallTipMessage) await tryRecall(session, state.tipMessageId)
    if (config.recallVoiceMessage) await tryRecall(session, state.voiceMessageId)

    pending.delete(getKey(session))
  }

  // 主命令：听歌 关键词
  ctx.command(`${config.commandName} <keyword:text>`, '点歌并发送语音（GD音乐台 API）')
    .alias(config.commandAlias)
    .action(async ({ session }, keyword) => {
      if (!session) return
      keyword = (keyword || '').trim()
      if (!keyword) return `用法：${config.commandName} 歌曲名`

      // ✅ DTS 关键修复：强制确认 userId/channelId 存在
      const userId = session.userId
      const channelId = session.channelId
      if (!userId || !channelId) {
        await session.send('当前适配器未提供 userId/channelId，无法进入选歌模式。')
        return
      }

      let list: SearchItem[] = []
      try {
        list = await apiSearch(config, keyword, 1)
      } catch {
        return '搜索失败（API 不可用或超时），请稍后再试。'
      }
      if (!list.length) return '没有搜到结果，换个关键词试试。'

      const state: PendingState = {
        userId,
        channelId,
        guildId: session.guildId,
        keyword,
        page: 1,
        list,
        expiresAt: Date.now() + config.waitForTimeout * 1000,
      }

      if (!config.recallSearchMenuMessage) {
        const text = buildMenuText(config, keyword, list, 1)
        const ids = await session.send(text)
        state.menuMessageId = Array.isArray(ids) ? ids[0] : ids
      } else {
        await session.send(`已进入选歌模式，请直接发送序号（1-${list.length}），或发送“${config.nextPageCommand}/${config.prevPageCommand}”翻页。`)
      }

      pending.set(channelId, state)
    })

  // 中间件：处理序号 / 翻页 / 退出
  ctx.middleware(async (session, next) => {
    const key = getKey(session)
    if (!key) return next()

    const state = pending.get(key)
    if (!state) return next()

    // 只允许发起者操作
    if (session.userId !== state.userId) return next()

    // 超时
    if (isExpired(state)) {
      pending.delete(key)
      return next()
    }

    const content = (session.content || '').trim()
    if (!content) return next()

    // 退出
    if (isExit(content)) {
      if (config.recallSearchMenuMessage) await tryRecall(session, state.menuMessageId)
      pending.delete(key)
      if (!config.recallUserSelectMessage) await session.send('已退出选歌。')
      return
    }

    // 下一页
    if (content === config.nextPageCommand) {
      if (config.recallUserSelectMessage) await tryRecall(session, session.messageId)
      state.page += 1
      try {
        await refreshMenu(session, state)
      } catch {
        state.page -= 1
        await session.send('翻页失败，请稍后再试。')
      }
      return
    }

    // 上一页
    if (content === config.prevPageCommand) {
      if (config.recallUserSelectMessage) await tryRecall(session, session.messageId)
      if (state.page <= 1) {
        await session.send('已经是第一页。')
        return
      }
      state.page -= 1
      try {
        await refreshMenu(session, state)
      } catch {
        state.page += 1
        await session.send('翻页失败，请稍后再试。')
      }
      return
    }

    // 序号
    const n = Number(content)
    if (!Number.isInteger(n) || n < 1 || n > state.list.length) return next()

    if (config.recallUserSelectMessage) await tryRecall(session, session.messageId)
    await handlePick(session, state, n - 1)
  })
}
