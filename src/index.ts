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

// ✅ 必需：http
// ✅ 可选：puppeteer / downloads / silk（以及你容器里装好的 ffmpeg 命令）
export const inject = {
  required: ['http'] as const,
  optional: ['puppeteer', 'downloads', 'silk'] as const,
}

const logger = new Logger('music-to-voice')

/** 音源枚举（参数值） */
export type SourceValue =
  | 'netease'
  | 'tencent'
  | 'tidal'
  | 'spotify'
  | 'ytmusic'
  | 'qobuz'
  | 'joox'
  | 'deezer'
  | 'migu'
  | 'kugou'
  | 'kuwo'
  | 'ximalaya'
  | 'apple'

/** 音质 br */
export type BrValue = 128 | 192 | 320 | 740 | 999

export type SendMode = 'record' | 'buffer'

export interface Config {
  // 基础
  commandName: string
  commandAlias: string
  generationTip: string
  promptTimeoutSec: number

  // 歌单
  searchListCount: number
  nextPageCommand: string
  prevPageCommand: string
  exitCommandList: string[]
  menuExitCommandTip: boolean
  useImageMenu: boolean // puppeteer 开关（可选）

  // 撤回
  menuRecallSec: number
  tipRecallSec: number
  recallMessages: string[] // generationTip / songList
  recallOnlyAfterSuccess: boolean
  keepMenuIfSendFailed: boolean

  // 请求
  apiBase: string
  source: SourceValue
  br: BrValue
  userAgent: string
  requestTimeoutMs: number

  // 发送/转码
  sendMode: SendMode
  forceTranscode: boolean
  autoDowngradeBr: boolean
  autoTranscodeWma: boolean
  ffmpegBin: string

  // 限制
  maxSongDurationMin: number

  // 调试
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

// ---------------- Schema（不使用 .options，避免你报的 TS 错误） ----------------

const SourceSchema: Schema<SourceValue> = Schema.union([
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

const BrSchema: Schema<BrValue> = Schema.union([
  Schema.const(128).description('128k（更稳，常返回 aac）'),
  Schema.const(192).description('192k（更稳，常返回 aac）'),
  Schema.const(320).description('320k（可能返回 wma，建议转码/降级）'),
  Schema.const(740).description('740（无损，常返回 wma，建议转码）'),
  Schema.const(999).description('999（无损，常返回 wma，建议转码）'),
]).default(999)

const SendModeSchema: Schema<SendMode> = Schema.union([
  Schema.const('record').description('语音（直链）'),
  Schema.const('buffer').description('语音（buffer，更稳）'),
]).default('record')

// 尝试让 UI 变 checkbox；不支持也不会 TS 报错
const RecallMessagesSchema: Schema<string[]> = (() => {
  const base: any = Schema.array(String).default(['generationTip', 'songList'])
  return base?.role ? base.role('checkbox') : base
})()

export const Config: Schema<Config> = Schema.intersect([
  // ✅ 只在设置页提示，不打后台日志
  Schema.object({
    _tip1: Schema.const('tip').description('开启插件前，请确保以下服务已经启用（可选安装）：puppeteer / downloads / silk；并确保容器内存在 ffmpeg。'),
    _tip2: Schema.const('tip2').description('建议：若你使用 Napcat QQ，320k 以上经常返回 wma，直链容易失败；建议开启【强制转码】并使用 buffer 发送。'),
  }),

  Schema.object({
    commandName: Schema.string().default('music').description('使用的指令名称'),
    commandAlias: Schema.string().default('听歌').description('使用的指令别名'),
    generationTip: Schema.string().default('生成语音中…').description('生成语音时返回的文字提示'),
    promptTimeoutSec: Schema.number().default(45).min(5).max(300).description('等待用户选择歌曲序号的最长时间（秒）'),
  }).description('基础设置'),

  Schema.object({
    searchListCount: Schema.number().default(20).min(5).max(50).description('搜索返回条数'),
    nextPageCommand: Schema.string().default('下一页').description('翻页指令-下一页'),
    prevPageCommand: Schema.string().default('上一页').description('翻页指令-上一页'),
    exitCommandList: Schema.array(String).default(['0', '不听了']).description('退出选择指令（一行一个）'),
    menuExitCommandTip: Schema.boolean().default(true).description('是否在歌单末尾显示退出提示'),
    useImageMenu: Schema.boolean().default(false).description('开启后返回图片歌单（需要 puppeteer 服务）'),
  }).description('歌单设置'),

  Schema.object({
    menuRecallSec: Schema.number().default(60).min(0).max(600).description('歌单撤回秒数（0=不撤回）'),
    tipRecallSec: Schema.number().default(10).min(0).max(120).description('“生成中”提示撤回秒数（0=不撤回）'),
    recallMessages: (RecallMessagesSchema as any).description('勾选后撤回对应消息（generationTip/songList）'),
    recallOnlyAfterSuccess: Schema.boolean().default(true).description('仅在发送成功后才撤回（推荐开启）'),
    keepMenuIfSendFailed: Schema.boolean().default(true).description('发送失败时保留歌单（推荐开启）'),
  }).description('撤回策略'),

  Schema.object({
    apiBase: Schema.string().default('https://music-api.gdstudio.xyz/api.php').description('后端 API 地址（GD 音乐台）'),
    source: (SourceSchema as any).description('source：音乐源（部分可能失效，建议使用稳定音乐源）'),
    br: (BrSchema as any).description('br：音质（740/999 为无损；高码率常返回 wma，建议转码）'),
    userAgent: Schema.string().default('koishi-music-to-voice/1.0').description('请求 UA'),
    requestTimeoutMs: Schema.number().default(15000).min(3000).max(60000).description('请求超时（毫秒）'),
  }).description('请求设置'),

  Schema.object({
    sendMode: (SendModeSchema as any).description('发送类型'),
    forceTranscode: Schema.boolean().default(false).description('强制转码（开启后建议选择 buffer 发送：下载→ffmpeg→silk→buffer）'),
    autoDowngradeBr: Schema.boolean().default(true).description('获取直链失败时自动降级码率重试（192→128）'),
    autoTranscodeWma: Schema.boolean().default(true).description('检测到返回 wma 且直链发送时，自动改用转码/或降级'),
    ffmpegBin: Schema.string().default('ffmpeg').description('ffmpeg 可执行文件名（容器一般为 ffmpeg）'),
    maxSongDurationMin: Schema.number().default(30).min(0).max(180).description('歌曲最长持续时间（分钟，0=不限制）'),
  }).description('进阶设置'),

  Schema.object({
    debug: Schema.boolean().default(false).description('日志调试模式'),
  }).description('开发者选项'),
]) as any

// ---------------- utils ----------------

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

async function safeSend(session: Session, content: any) {
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

function buildSongUrl(cfg: Config, song: SongItem, br: number) {
  const u = new URL(cfg.apiBase)
  u.searchParams.set('types', 'url')
  u.searchParams.set('id', song.url_id || song.id)
  u.searchParams.set('source', cfg.source)
  u.searchParams.set('br', String(br))
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

function isWmaUrl(url: string) {
  const u = url.toLowerCase()
  return u.includes('.wma') || u.includes('format=wma')
}

/**
 * ffmpeg：输入任意音频 buffer → 输出 wav(PCM, 24000Hz, mono)
 * （QQ 语音 silk 转码常用 24k mono）
 */
async function ffmpegToWav(cfg: Config, input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ac', '1',
      '-ar', '24000',
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

function renderMenuText(cfg: Config, keyword: string, page: number, songs: SongItem[]) {
  const lines: string[] = []
  lines.push(`🎵 搜索：${keyword}（第 ${page} 页）`)
  lines.push('')
  for (let i = 0; i < songs.length; i++) {
    const s = songs[i]
    const artist = normalizeArtists(s.artist)
    const title = artist ? `${s.name} - ${artist}` : s.name
    // ✅ 不再输出 [--:--]
    lines.push(`${i + 1}. ${title}`)
  }
  lines.push('')
  lines.push(`指令：${cfg.prevPageCommand} / ${cfg.nextPageCommand}`)
  if (cfg.menuExitCommandTip && cfg.exitCommandList?.length) {
    lines.push(`退出：${cfg.exitCommandList.join(' / ')}`)
  }
  lines.push('回复序号即可点歌。')
  return lines.join('\n')
}

async function renderMenuImage(ctx: Context, cfg: Config, keyword: string, page: number, songs: SongItem[]) {
  if (!ctx.puppeteer) return null

  const lines = songs.map((s, i) => {
    const artist = normalizeArtists(s.artist)
    const title = artist ? `${s.name} - ${artist}` : s.name
    return `${i + 1}. ${title}`
  })

  const html = `
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body { font-family: Arial, "Microsoft YaHei"; padding: 24px; }
        .title { font-size: 20px; font-weight: 700; margin-bottom: 12px; }
        .item { font-size: 14px; line-height: 22px; }
        .footer { margin-top: 12px; font-size: 12px; color: #666; }
      </style>
    </head>
    <body>
      <div class="title">🎵 搜索：${keyword}（第 ${page} 页）</div>
      ${lines.map(x => `<div class="item">${x}</div>`).join('')}
      <div class="footer">指令：${cfg.prevPageCommand} / ${cfg.nextPageCommand}　退出：${cfg.exitCommandList.join(' / ')}</div>
    </body>
  </html>
  `

  try {
    const pageObj = await ctx.puppeteer.page()
    await pageObj.setContent(html)
    const buf: Buffer = await pageObj.screenshot({ type: 'png', fullPage: true })
    await pageObj.close()
    return buf
  } catch {
    return null
  }
}

function uniqBrList(cfg: Config) {
  const list: number[] = [cfg.br]
  if (cfg.autoDowngradeBr) {
    if (!list.includes(192)) list.push(192)
    if (!list.includes(128)) list.push(128)
  }
  return list
}

async function getPlayableUrlWithFallback(ctx: Context, cfg: Config, song: SongItem): Promise<{ url: string; usedBr: number }> {
  const brList = uniqBrList(cfg)

  let lastErr: any = null

  for (const br of brList) {
    try {
      const urlData = await httpGetJson(ctx, cfg, buildSongUrl(cfg, song, br))
      const directUrl: string | undefined = urlData?.url
      if (!directUrl) throw new Error('no url from api')

      // 如果你选“直链”，但返回 wma：优先尝试降码率找 aac
      if (cfg.sendMode === 'record' && cfg.autoTranscodeWma && isWmaUrl(directUrl)) {
        // 继续循环试更低码率
        lastErr = new Error(`wma at br=${br}`)
        continue
      }

      return { url: directUrl, usedBr: br }
    } catch (e) {
      lastErr = e
      continue
    }
  }

  throw lastErr ?? new Error('failed to get url')
}

// ---------------- apply ----------------

export function apply(ctx: Context, cfg: Config) {
  const debug = (msg: string, ...args: any[]) => {
    if (cfg.debug) logger.info(msg, ...args)
  }

  // 避免 “duplicate command names: music” 的坑：让用户可改 commandName
  const cmd = ctx.command(cfg.commandName, '音乐聚合点歌并发送语音').alias(cfg.commandAlias)

  cmd.action(async (argv, ...args) => {
    const session = argv.session as Session
    const keyword = args.join(' ').trim()
    if (!keyword) return `请输入关键词，例如：${cfg.commandAlias} 不甘`

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

    let menuMessageIds: string[] = []

    if (cfg.useImageMenu) {
      const img = await renderMenuImage(ctx, cfg, keyword, page, songs)
      if (img) {
        menuMessageIds = await safeSend(session, h.image(img, 'image/png'))
      } else {
        const menuText = renderMenuText(cfg, keyword, page, songs)
        menuMessageIds = await safeSend(session, menuText)
      }
    } else {
      const menuText = renderMenuText(cfg, keyword, page, songs)
      menuMessageIds = await safeSend(session, menuText)
    }

    pending.set(k, {
      userId: session.userId ?? 'unknown-user',
      channelId: session.channelId ?? 'unknown-channel',
      page,
      keyword,
      songs,
      createdAt: Date.now(),
      menuMessageIds,
    })

    // ✅ 默认：仅发送成功后才撤回，所以这里只在关闭 recallOnlyAfterSuccess 时才会定时撤回
    if (cfg.menuRecallSec > 0 && cfg.recallMessages.includes('songList') && !cfg.recallOnlyAfterSuccess) {
      ctx.setTimeout(async () => {
        const st = pending.get(k)
        if (!st || st.keyword !== keyword || st.page !== page) return
        await safeRecall(session, st.menuMessageIds)
      }, cfg.menuRecallSec * 1000)
    }

    return
  })

  ctx.middleware(async (session, next) => {
    const k = keyOf(session)
    const st = pending.get(k)
    if (!st) return next()

    // 超时
    if (Date.now() - st.createdAt > cfg.promptTimeoutSec * 1000) {
      pending.delete(k)
      return next()
    }

    const input = String(session.content || '').trim()
    if (!input) return next()

    // 翻页
    if (input === cfg.nextPageCommand || input === cfg.prevPageCommand) {
      const newPage = input === cfg.nextPageCommand ? st.page + 1 : Math.max(1, st.page - 1)
      try {
        const data = await httpGetJson(ctx, cfg, buildSearchUrl(cfg, st.keyword, newPage))
        const songs: SongItem[] = Array.isArray(data) ? data : (data?.data ?? [])
        if (!songs?.length) return '没有更多结果了。'

        let menuMessageIds: string[] = []
        if (cfg.useImageMenu) {
          const img = await renderMenuImage(ctx, cfg, st.keyword, newPage, songs)
          if (img) menuMessageIds = await safeSend(session, h.image(img, 'image/png'))
          else menuMessageIds = await safeSend(session, renderMenuText(cfg, st.keyword, newPage, songs))
        } else {
          menuMessageIds = await safeSend(session, renderMenuText(cfg, st.keyword, newPage, songs))
        }

        pending.set(k, { ...st, page: newPage, songs, createdAt: Date.now(), menuMessageIds })
      } catch (e: any) {
        debug('page failed: %s', e?.message || e)
        return '翻页失败（API 不可用或超时），请稍后再试。'
      }
      return
    }

    // 退出
    if (isExitInput(input, cfg.exitCommandList)) {
      pending.delete(k)
      if (cfg.menuRecallSec > 0 && cfg.recallMessages.includes('songList') && !cfg.recallOnlyAfterSuccess) {
        await safeRecall(session, st.menuMessageIds)
      }
      return '已退出歌曲选择。'
    }

    // 选歌
    const idx = Number(input)
    if (!Number.isInteger(idx) || idx < 1 || idx > st.songs.length) return next()

    const song = st.songs[idx - 1]

    // 先发提示
    const tipIds = await safeSend(session, cfg.generationTip)

    let sentOk = false

    try {
      // 1) 先获取可播放 url（含降级）
      const { url, usedBr } = await getPlayableUrlWithFallback(ctx, cfg, song)

      // 2) 判断是否用 buffer / 是否需要转码
      const needTranscode =
        cfg.forceTranscode ||
        cfg.sendMode === 'buffer' ||
        (cfg.autoTranscodeWma && isWmaUrl(url))

      if (!needTranscode) {
        // 直链
        await session.send(h.audio(url))
        sentOk = true
      } else {
        // buffer：下载→ffmpeg→silk→buffer
        if (!ctx.silk?.encode) {
          throw new Error('silk service not available (need koishi-plugin-silk)')
        }

        const raw = await httpGetBuffer(ctx, cfg, url)
        const wav = await ffmpegToWav(cfg, raw)
        const silkBuf = await Promise.resolve(ctx.silk.encode(wav))

        // QQ/Napcat 最稳：直接发 silk buffer
        await session.send(h.audio(silkBuf as any, 'audio/silk'))
        sentOk = true
      }

      debug('sent ok: br=%s url=%s', usedBr, url)
    } catch (e: any) {
      debug('send failed: %s', e?.message || e)
      sentOk = false
      await session.send(
        '获取/发送失败：\n' +
          '1) 320k 以上常返回 wma，建议将 br 改为 192/128；\n' +
          '2) 或开启【强制转码】并选择 buffer 发送（downloads+ffmpeg+silk）。'
      )
    } finally {
      // ✅ 撤回：默认仅成功后撤回
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

    // 成功就清理；失败保留歌单继续选（并刷新 timeout）
    if (sentOk) pending.delete(k)
    else pending.set(k, { ...st, createdAt: Date.now() })

    return
  })
}
