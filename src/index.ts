import { Context, Schema, h, Logger, Session } from 'koishi'
import { spawn } from 'node:child_process'

declare module 'koishi' {
  interface Context {
    puppeteer?: any
    downloads?: any
    silk?: {
      encode(input: Buffer, options?: any): Promise<Buffer> | Buffer
    }
  }
}

export const name = 'music-to-voice'
export const using = ['http'] as const
const logger = new Logger('music-to-voice')

export interface Config {
  commandName: string
  commandAlias: string
  generationTip: string

  promptTimeoutSec: number
  searchListCount: number
  nextPageCommand: string
  prevPageCommand: string
  exitCommandList: string[]
  menuExitCommandTip: boolean

  menuRecallSec: number
  tipRecallSec: number
  recallMessages: string[]                // generationTip / songList
  recallOnlyAfterSuccess: boolean
  keepMenuIfSendFailed: boolean

  apiBase: string
  source: string                          // 用 string，Schema 用 union 做选择
  br: number

  userAgent: string
  requestTimeoutMs: number

  sendMode: string                        // record / buffer
  forceTranscode: boolean
  maxSongDurationMin: number
  ffmpegBin: string

  debug: boolean
}

type SongItem = {
  id: string
  name: string
  artist?: string[] | string
  album?: string
  source?: string
  url_id?: string
}

type PendingState = {
  userId: string
  channelId: string
  page: number
  keyword: string
  songs: SongItem[]
  createdAt: number
  menuMessageIds: string[]
}

const pending = new Map<string, PendingState>()

// ---------- Schema helpers (兼容版本) ----------
const SourceSchema = Schema.union([
  Schema.const('netease').description('网易云（推荐）'),
  Schema.const('tencent').description('QQ'),
  Schema.const('kugou').description('酷狗'),
  Schema.const('kuwo').description('酷我'),
  Schema.const('migu').description('咪咕'),
  Schema.const('ximalaya').description('喜马拉雅'),
  Schema.const('apple').description('Apple Music'),
  Schema.const('spotify').description('Spotify'),
  Schema.const('ytmusic').description('YouTube Music'),
  Schema.const('deezer').description('Deezer'),
  Schema.const('tidal').description('Tidal'),
  Schema.const('qobuz').description('Qobuz'),
  Schema.const('joox').description('JOOX'),
]).default('netease')

const BrSchema = Schema.union([
  Schema.const(128).description('128k（更稳）'),
  Schema.const(192).description('192k（更稳）'),
  Schema.const(320).description('320k（可能返回 wma）'),
  Schema.const(740).description('740（无损，可能返回 wma）'),
  Schema.const(999).description('999（无损，可能返回 wma）'),
]).default(999)

const SendModeSchema = Schema.union([
  Schema.const('record').description('语音（直链）'),
  Schema.const('buffer').description('语音（buffer，更稳）'),
]).default('record')

const RecallMessagesSchema =
  // 有的版本支持 checkbox；不支持也没关系，UI 可能退化成数组输入
  (Schema.array(String).default(['generationTip', 'songList']) as any)
    .role?.('checkbox') ?? Schema.array(String).default(['generationTip', 'songList'])

// ---------- Config Schema ----------
export const Config: Schema<Config> = (Schema.intersect([
  Schema.object({}).description('开启插件前，请确保以下服务已经启用！'),
  Schema.object({
    _tip_required: Schema.const('required').description('所需服务：puppeteer（可选安装，用于图片歌单）'),
    _tip_optional: Schema.const('optional').description('可选依赖：downloads / ffmpeg / silk（用于 buffer 转码发送）'),
    _tip_transcode: Schema.const('transcode').description('开启【强制转码】后建议选择 buffer 发送：下载→ffmpeg→silk→buffer'),
  }),

  Schema.object({
    commandName: Schema.string().default('music').description('使用的指令名称'),
    commandAlias: Schema.string().default('听歌').description('使用的指令别名'),
    generationTip: Schema.string().default('生成语音中…').description('生成语音时返回的文字提示内容'),
    promptTimeoutSec: Schema.number().default(45).min(5).max(300).description('等待用户选择歌曲序号的最长时间（秒）'),
  }).description('基础设置'),

  Schema.object({
    searchListCount: Schema.number().default(20).min(5).max(50).description('搜索的歌曲列表数量'),
    nextPageCommand: Schema.string().default('下一页').description('翻页指令-下一页'),
    prevPageCommand: Schema.string().default('上一页').description('翻页指令-上一页'),
    exitCommandList: Schema.array(String).default(['0', '不听了']).description('退出选择指令（一行一个）'),
    menuExitCommandTip: Schema.boolean().default(true).description('是否在歌单末尾显示退出提示'),
  }).description('歌单设置'),

  Schema.object({
    menuRecallSec: Schema.number().default(60).min(0).max(600).description('歌单撤回秒数（0=不撤回）'),
    tipRecallSec: Schema.number().default(10).min(0).max(120).description('“生成中”提示撤回秒数（0=不撤回）'),

    recallMessages: (RecallMessagesSchema as any).description('勾选后撤回对应消息（generationTip/songList）'),

    recallOnlyAfterSuccess: Schema.boolean().default(true).description('仅在发送成功后才撤回（推荐开启）'),
    keepMenuIfSendFailed: Schema.boolean().default(true).description('发送失败时保留歌单（推荐开启）'),
  }).description('撤回策略'),

  Schema.object({
    apiBase: Schema.string().default('https://music-api.gdstudio.xyz/api.php').description('后端 API 地址'),
    source: (SourceSchema as any).description('音乐源（部分可能失效，建议使用稳定音乐源）'),
    br: (BrSchema as any).description('音质 br（740/999 无损；高码率可能返回 wma，建议强制转码）'),
    userAgent: Schema.string().default('koishi-music-to-voice/1.0').description('请求 UA'),
    requestTimeoutMs: Schema.number().default(15000).min(3000).max(60000).description('请求超时（毫秒）'),
  }).description('请求设置'),

  Schema.object({
    sendMode: (SendModeSchema as any).description('发送类型'),
    forceTranscode: Schema.boolean().default(false).description('强制转码（开启后请选择 buffer 发送）'),
    maxSongDurationMin: Schema.number().default(30).min(0).max(180).description('歌曲最长持续时间（分钟，0=不限制）'),
    ffmpegBin: Schema.string().default('ffmpeg').description('ffmpeg 可执行文件（容器一般为 ffmpeg）'),
  }).description('进阶设置'),

  Schema.object({
    debug: Schema.boolean().default(false).description('日志调试模式'),
  }).description('开发者选项'),
]) as any)

// ---------- utils ----------
function keyOf(session: Session) {
  const uid = session.userId ?? 'unknown-user'
  const cid = session.channelId ?? 'unknown-channel'
  return `${session.platform}:${uid}:${cid}`
}

function normalizeArtists(artist: SongItem['artist']): string {
  if (!artist) return ''
  if (Array.isArray(artist)) return artist.join('/')
  return String(artist)
}

function isExitInput(input: string, exits: string[]) {
  const s = input.trim()
  return exits.some(x => x.trim() === s)
}

async function safeSend(session: Session, content: string) {
  const ret = await session.send(content)
  if (Array.isArray(ret)) return ret.map(String)
  if (ret == null) return []
  return [String(ret)]
}

async function safeRecall(session: Session, messageIds: string[]) {
  const bot: any = session.bot as any
  if (!messageIds?.length) return
  if (typeof bot?.deleteMessage !== 'function') return
  for (const mid of messageIds) {
    try {
      await bot.deleteMessage(session.channelId, mid)
    } catch {}
  }
}

function buildSearchUrl(cfg: Config, keyword: string, page: number) {
  const u = new URL(cfg.apiBase)
  u.searchParams.set('types', 'search')
  u.searchParams.set('source', cfg.source)
  u.searchParams.set('name', keyword)
  u.searchParams.set('count', String(cfg.searchListCount))
  u.searchParams.set('pages', String(page))
  return u.toString()
}

function buildSongUrl(cfg: Config, song: SongItem) {
  const u = new URL(cfg.apiBase)
  u.searchParams.set('types', 'url')
  u.searchParams.set('id', song.url_id || song.id)
  u.searchParams.set('source', cfg.source)
  u.searchParams.set('br', String(cfg.br))
  return u.toString()
}

async function httpGetJson(ctx: Context, cfg: Config, url: string) {
  const res = await ctx.http.get(url, {
    timeout: cfg.requestTimeoutMs,
    headers: { 'user-agent': cfg.userAgent },
  })
  if (typeof res === 'string') return JSON.parse(res)
  return res
}

async function httpGetBuffer(ctx: Context, cfg: Config, url: string): Promise<Buffer> {
  const ab = await ctx.http.get<ArrayBuffer>(url, {
    timeout: cfg.requestTimeoutMs,
    responseType: 'arraybuffer',
    headers: { 'user-agent': cfg.userAgent },
  })
  return Buffer.from(ab)
}

async function ffmpegToWav(cfg: Config, input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ac', '1',
      '-ar', '48000',
      '-f', 'wav',
      'pipe:1',
    ]
    const p = spawn(cfg.ffmpegBin || 'ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    const err: Buffer[] = []
    p.stdout.on('data', (d: Buffer) => chunks.push(d))
    p.stderr.on('data', (d: Buffer) => err.push(d))
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(chunks))
      reject(new Error(`ffmpeg failed: ${Buffer.concat(err).toString('utf8')}`))
    })
    p.stdin.end(input)
  })
}

function renderMenu(cfg: Config, keyword: string, page: number, songs: SongItem[]) {
  const lines: string[] = []
  lines.push(`🎵 搜索：${keyword}（第 ${page} 页）`)
  lines.push('')
  for (let i = 0; i < songs.length; i++) {
    const s = songs[i]
    const artist = normalizeArtists(s.artist)
    const title = artist ? `${s.name} - ${artist}` : s.name
    lines.push(`${i + 1}. ${title}`)  // ✅ 不再输出 [--:--]
  }
  lines.push('')
  lines.push(`指令：${cfg.prevPageCommand} / ${cfg.nextPageCommand}`)
  if (cfg.menuExitCommandTip && cfg.exitCommandList?.length) {
    lines.push(`退出：${cfg.exitCommandList.join(' / ')}`)
  }
  lines.push('回复序号即可点歌。')
  return lines.join('\n')
}

// ---------- apply ----------
export function apply(ctx: Context, cfg: Config) {
  const debug = (msg: string, ...args: any[]) => {
    if (cfg.debug) logger.info(msg, ...args)
  }

  const cmd = ctx.command(cfg.commandName, '音乐聚合点歌并发送语音').alias(cfg.commandAlias)

  cmd.action(async (argv, ...args) => {
    const session = argv.session as Session
    const keyword = args.join(' ').trim()
    if (!keyword) return '请输入关键词，例如：听歌 不甘'

    const k = keyOf(session)
    const page = 1

    let data: any
    try {
      data = await httpGetJson(ctx, cfg, buildSearchUrl(cfg, keyword, page))
    } catch (e: any) {
      debug('search failed: %s', e?.message || e)
      return '搜索失败（API 不可用或超时），请稍后再试。'
    }

    const songs: SongItem[] = Array.isArray(data) ? data : (data?.data ?? [])
    if (!songs?.length) return '未搜索到结果，请换个关键词。'

    const menu = renderMenu(cfg, keyword, page, songs)
    const menuMessageIds = await safeSend(session, menu)

    pending.set(k, {
      userId: session.userId ?? 'unknown-user',
      channelId: session.channelId ?? 'unknown-channel',
      page,
      keyword,
      songs,
      createdAt: Date.now(),
      menuMessageIds,
    })

    // 仅在 onlyAfterSuccess=false 时，允许自动撤回歌单
    if (cfg.menuRecallSec > 0 && cfg.recallMessages.includes('songList')) {
      ctx.setTimeout(async () => {
        const st = pending.get(k)
        if (!st || st.keyword !== keyword || st.page !== page) return
        if (cfg.recallOnlyAfterSuccess) return
        await safeRecall(session, st.menuMessageIds)
      }, cfg.menuRecallSec * 1000)
    }
    return
  })

  ctx.middleware(async (session, next) => {
    const k = keyOf(session)
    const st = pending.get(k)
    if (!st) return next()

    if (Date.now() - st.createdAt > cfg.promptTimeoutSec * 1000) {
      pending.delete(k)
      return next()
    }

    const input = String(session.content || '').trim()
    if (!input) return next()

    if (input === cfg.nextPageCommand || input === cfg.prevPageCommand) {
      const newPage = input === cfg.nextPageCommand ? st.page + 1 : Math.max(1, st.page - 1)
      try {
        const data = await httpGetJson(ctx, cfg, buildSearchUrl(cfg, st.keyword, newPage))
        const songs: SongItem[] = Array.isArray(data) ? data : (data?.data ?? [])
        if (!songs?.length) return '没有更多结果了。'

        const menu = renderMenu(cfg, st.keyword, newPage, songs)
        const menuMessageIds = await safeSend(session, menu)
        pending.set(k, { ...st, page: newPage, songs, createdAt: Date.now(), menuMessageIds })
      } catch (e: any) {
        debug('page failed: %s', e?.message || e)
        return '翻页失败（API 不可用或超时），请稍后再试。'
      }
      return
    }

    if (isExitInput(input, cfg.exitCommandList)) {
      pending.delete(k)
      if (cfg.menuRecallSec > 0 && cfg.recallMessages.includes('songList') && !cfg.recallOnlyAfterSuccess) {
        await safeRecall(session, st.menuMessageIds)
      }
      return '已退出歌曲选择。'
    }

    const idx = Number(input)
    if (!Number.isInteger(idx) || idx < 1 || idx > st.songs.length) return next()

    const song = st.songs[idx - 1]
    const tipIds = await safeSend(session, cfg.generationTip)

    let sentOk = false
    try {
      const urlData = await httpGetJson(ctx, cfg, buildSongUrl(cfg, song))
      const directUrl: string | undefined = urlData?.url
      if (!directUrl) throw new Error('no url from api')

      const useBuffer = (cfg.sendMode === 'buffer') || cfg.forceTranscode

      if (!useBuffer) {
        await session.send(h.audio(directUrl))
        sentOk = true
      } else {
        const raw = await httpGetBuffer(ctx, cfg, directUrl)
        const wav = await ffmpegToWav(cfg, raw)

        if (!ctx.silk?.encode) throw new Error('silk service not available')
        const silkBuf = await Promise.resolve(ctx.silk.encode(wav))
        await session.send(h.audio(silkBuf, 'audio/silk'))
        sentOk = true
      }
    } catch (e: any) {
      debug('send failed: %s', e?.message || e)
      sentOk = false
      await session.send('获取/发送失败：高码率可能返回 wma，建议降低音质，或开启强制转码并使用 buffer。')
    } finally {
      if (!cfg.recallOnlyAfterSuccess || sentOk) {
        if (cfg.recallMessages.includes('generationTip') && cfg.tipRecallSec > 0) {
          ctx.setTimeout(() => safeRecall(session, tipIds), cfg.tipRecallSec * 1000)
        }
        if (cfg.recallMessages.includes('songList') && cfg.menuRecallSec > 0) {
          if (!(cfg.keepMenuIfSendFailed && !sentOk)) {
            ctx.setTimeout(() => safeRecall(session, st.menuMessageIds), cfg.menuRecallSec * 1000)
          }
        }
      }
    }

    if (sentOk) pending.delete(k)
    else pending.set(k, { ...st, createdAt: Date.now() })

    return
  })
}
