import { Context, Schema, Logger, h, Session } from 'koishi'
import { spawn } from 'node:child_process'

export const name = 'music-to-voice'

const logger = new Logger('music-to-voice')

type SourceValue =
  | 'netease' | 'tencent' | 'tidal' | 'spotify' | 'ytmusic' | 'qobuz'
  | 'joox' | 'deezer' | 'migu' | 'kugou' | 'kuwo' | 'ximalaya' | 'apple'

type BrValue = 128 | 192 | 320 | 740 | 999

type SendMode = 'record' | 'buffer'
type TranscodeFormat = 'wav' | 'aac' | 'silk'

interface SearchItem {
  id?: string | number
  songid?: string | number
  name?: string
  title?: string
  artist?: string
  author?: string
  singer?: string
  url?: string
  pic?: string
  duration?: number
  time?: number
}

interface SearchResp {
  code?: number
  msg?: string
  data?: any
  result?: any
}

interface UrlResp {
  code?: number
  msg?: string
  url?: string
  br?: number
  size?: number
  type?: string
}

function toId(x: any): string | undefined {
  if (x === null || x === undefined) return
  const s = String(x).trim()
  return s ? s : undefined
}

function pickName(it: any): string {
  return (it?.name ?? it?.title ?? '未知歌曲').toString()
}

function pickArtist(it: any): string {
  return (it?.artist ?? it?.author ?? it?.singer ?? '').toString()
}

function pickDurationSec(it: any): number | undefined {
  const d = it?.duration ?? it?.time
  if (d === null || d === undefined) return
  const n = Number(d)
  if (!Number.isFinite(n) || n <= 0) return
  // 有些接口 duration 是毫秒
  if (n > 10000) return Math.floor(n / 1000)
  return Math.floor(n)
}

function fmtDuration(sec?: number): string | undefined {
  if (!sec || sec <= 0) return
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function safeJsonParse(x: any): any {
  if (typeof x === 'object') return x
  try { return JSON.parse(String(x)) } catch { return null }
}

function isLikelyWma(url?: string): boolean {
  if (!url) return false
  return /\.wma(\?|$)/i.test(url) || url.toLowerCase().includes('.wma')
}

async function sleep(ms: number) {
  await new Promise<void>(r => setTimeout(r, ms))
}

async function httpGetJson(ctx: Context, url: string, cfg: Config) {
  // 统一：带 UA、超时、重试
  const headers: Record<string, string> = {
    'user-agent': cfg.userAgent || 'koishi-music-to-voice/1.0',
    'accept': 'application/json,text/plain,*/*',
  }

  const retry = Math.max(0, cfg.requestRetry)
  let lastErr: any

  for (let i = 0; i <= retry; i++) {
    try {
      const res = await ctx.http.get(url, {
        timeout: cfg.requestTimeoutMs,
        headers,
        responseType: 'json',
      })
      // 某些 http 客户端返回的是完整响应对象（含 data），有些直接返回解析后的 body。
      // 统一返回响应主体优先（如果存在 data 字段就返回 data）。
      // 这样上层处理时可以更一致地处理各种库/适配器的差异。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (res as any)?.data ?? res
    } catch (e: any) {
      lastErr = e
      if (i < retry) await sleep(250 + i * 250)
    }
  }

  throw lastErr
}

async function httpGetBuffer(ctx: Context, url: string, cfg: Config): Promise<Buffer> {
  const headers: Record<string, string> = {
    'user-agent': cfg.userAgent || 'koishi-music-to-voice/1.0',
    'accept': '*/*',
  }

  const retry = Math.max(0, cfg.requestRetry)
  let lastErr: any

  for (let i = 0; i <= retry; i++) {
    try {
  logger.info(`downloading url: ${url} (attempt ${i + 1}/${retry + 1})`)
      const res = await ctx.http.get<any>(url, {
        timeout: cfg.requestTimeoutMs,
        headers,
        responseType: 'arraybuffer',
      })
      // 兼容适配器：有的直接返回 ArrayBuffer，有的返回 { data, headers }
      const arr = (res?.data ?? res) as ArrayBuffer
      const buf = Buffer.from(arr)

      // 尝试读取 headers
      const contentType = (res?.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || ''
      const contentLengthHeader = (res?.headers && (res.headers['content-length'] || res.headers['Content-Length'])) || ''
  logger.info(`downloaded ${buf.length} bytes from ${url} content-type=${contentType} content-length=${contentLengthHeader}`)
      return buf
    } catch (e: any) {
      lastErr = e
      logger.warn(`download attempt ${i + 1} failed for ${url}: ${e?.message || e}`)
      if (i < retry) await sleep(250 + i * 250)
    }
  }

  throw lastErr
}

async function ffmpegToWavBuffer(input: Buffer, cfg: Config): Promise<Buffer> {
  // 转成 NapCat 最稳的：24000Hz / mono / s16 wav
  // 用 pipe 避免写文件
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-ac', '1',
    '-ar', '24000',
    '-f', 'wav',
    'pipe:1',
  ]

  const bin = cfg.ffmpegBin || 'ffmpeg'

  return await new Promise<Buffer>((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []

    const killTimer = setTimeout(() => {
      try { p.kill() } catch {}
      reject(new Error('ffmpeg timeout'))
    }, Math.max(3000, cfg.ffmpegTimeoutMs))

    p.stdout.on('data', (d: Buffer) => chunks.push(d))
    p.stderr.on('data', (d: Buffer) => errChunks.push(d))

    p.on('error', (e) => {
      clearTimeout(killTimer)
      reject(e)
    })

    p.on('close', (code) => {
      clearTimeout(killTimer)
      if (code === 0) {
        const out = Buffer.concat(chunks)
        if (!out.length) return reject(new Error('ffmpeg output empty'))
        resolve(out)
      } else {
        const stderr = Buffer.concat(errChunks).toString('utf8')
        const msg = stderr || `ffmpeg exit ${code}`
        logger.warn(`ffmpegToWavBuffer failed: ${msg}`)
        const err = new Error(msg)
        // attach stderr for callers
        ;(err as any).stderr = stderr
        reject(err)
      }
    })

    p.stdin.end(input)
  })
}

async function ffmpegTranscode(input: Buffer, cfg: Config, format: TranscodeFormat, br?: number): Promise<{ buffer: Buffer, mime: string }> {
  const bin = cfg.ffmpegBin || 'ffmpeg'

  if (format === 'aac') {
    // 生成 ADTS AAC，NapCat/QQ 在 128k/192k AAC 下通常兼容
    const bitrate = (br && br <= 192 && br >= 64) ? `${br}k` : '128k'
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',
      '-c:a', 'aac',
      '-b:a', bitrate,
      '-f', 'adts',
      'pipe:1',
    ]

    return await new Promise<{ buffer: Buffer, mime: string }>((resolve, reject) => {
      const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []
      const killTimer = setTimeout(() => { try { p.kill() } catch {} ; reject(new Error('ffmpeg timeout')) }, Math.max(3000, cfg.ffmpegTimeoutMs))
      p.stdout.on('data', (d: Buffer) => chunks.push(d))
      p.stderr.on('data', (d: Buffer) => errChunks.push(d))
      p.on('error', (e) => { clearTimeout(killTimer); reject(e) })
      p.on('close', (code) => {
        clearTimeout(killTimer)
        if (code === 0) {
          const out = Buffer.concat(chunks)
          if (!out.length) return reject(new Error('ffmpeg output empty'))
          resolve({ buffer: out, mime: 'audio/aac' })
        } else {
            const stderr = Buffer.concat(errChunks).toString('utf8')
            const msg = stderr || `ffmpeg exit ${code}`
            logger.warn(`ffmpegTranscode(aac) failed: ${msg}`)
            const err = new Error(msg)
            ;(err as any).stderr = stderr
            reject(err)
        }
      })
      p.stdin.end(input)
    })
  }

  if (format === 'wav') {
    // delegate to existing wav pipeline
    const buf = await ffmpegToWavBuffer(input, cfg)
    return { buffer: buf, mime: 'audio/wav' }
  }

  // silk: 如果没有独立的 silk 编码器，回退到 wav（并在日志中提示）
  logger.warn('transcodeFormat silk selected but silk encoding is not implemented; falling back to wav')
  const buf = await ffmpegToWavBuffer(input, cfg)
  return { buffer: buf, mime: 'audio/wav' }
}

async function checkFfmpegAvailable(bin: string, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    try {
      const p = spawn(bin, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const errChunks: Buffer[] = []
      const killTimer = setTimeout(() => {
        try { p.kill() } catch {}
        resolve(false)
      }, Math.max(1000, timeoutMs))

      p.stderr.on('data', (d: Buffer) => errChunks.push(d))
      p.on('error', () => {
        clearTimeout(killTimer)
        resolve(false)
      })
      p.on('close', (code) => {
        clearTimeout(killTimer)
        // ffmpeg -version typically exits with 0; consider any exit as success
        resolve(code === 0)
      })
    } catch {
      resolve(false)
    }
  })
}

function sourceLabel(v: SourceValue) {
  const map: Record<SourceValue, string> = {
    netease: '网易云',
    tencent: 'QQ音乐',
    kuwo: '酷我',
    kugou: '酷狗',
    migu: '咪咕',
    ximalaya: '喜马拉雅',
    apple: 'Apple Music',
    spotify: 'Spotify',
    ytmusic: 'YouTube Music',
    tidal: 'Tidal',
    qobuz: 'Qobuz',
    joox: 'JOOX',
    deezer: 'Deezer',
  }
  return map[v] || v
}

function brLabel(v: BrValue) {
  const map: Record<BrValue, string> = {
    128: '128k（较稳）',
    192: '192k（较稳）',
    320: '320k（可能返回 wma）',
    740: '740（无损，可能返回 wma）',
    999: '999（无损，可能返回 wma）',
  }
  return map[v] || String(v)
}

export interface Config {
  // 基础
  command: string
  alias: string[]
  apiBase: string

  // 文案
  generationTip: string
  promptTimeoutSec: number
  promptTimeout: string
  exitPrompt: string
  invalidNumber: string
  durationExceeded: string
  getSongFailed: string

  // 搜索/歌单
  searchCount: number
  menuAsImage: boolean
  nextPageCmd: string
  prevPageCmd: string
  exitCmds: string[]
  showExitHint: boolean
  // 是否允许群内其他人选择点歌（默认 false，仅原请求人可选择）
  allowGroupSelect: boolean
  maxSongDurationMin: number

  // 请求
  source: SourceValue
  br: BrValue
  requestTimeoutMs: number
  requestRetry: number
  userAgent: string

  // 发送
  sendMode: SendMode
  forceTranscode: boolean
  // 转码格式：
  // - wav: 输出 24000Hz mono s16 wav（兼容 NapCat 的某些实现，但体积较大）
  // - aac: 输出 ADTS AAC（体积小，NapCat/QQ 在 128k/192k AAC 下通常可直接播放）
  // - silk: silk 格式（需要 silk 编码器支持，当前若选择会回退为 wav）
  transcodeFormat: TranscodeFormat
  ffmpegBin: string
  ffmpegTimeoutMs: number

  // 启动时检测 ffmpeg（可禁用）
  checkFfmpegOnStart: boolean

  // 撤回
  recallMessages: ('generationTip' | 'songList')[]
  tipRecallSec: number
  menuRecallSec: number
  recallOnlyAfterSuccess: boolean
  keepMenuIfSendFailed: boolean

  // 调试
  debug: boolean
}

const SourceSchema = Schema.union([
  Schema.const('netease').description('网易云（netease）'),
  Schema.const('tencent').description('QQ音乐（tencent）'),
  Schema.const('kugou').description('酷狗（kugou）'),
  Schema.const('kuwo').description('酷我（kuwo）'),
  Schema.const('migu').description('咪咕（migu）'),
  Schema.const('ximalaya').description('喜马拉雅（ximalaya）'),
  Schema.const('apple').description('Apple Music（apple）'),
  Schema.const('spotify').description('Spotify（spotify）'),
  Schema.const('ytmusic').description('YouTube Music（ytmusic）'),
  Schema.const('tidal').description('Tidal（tidal）'),
  Schema.const('qobuz').description('Qobuz（qobuz）'),
  Schema.const('joox').description('JOOX（joox）'),
  Schema.const('deezer').description('Deezer（deezer）'),
]) as unknown as Schema<SourceValue>

const BrSchema = Schema.union([
  Schema.const(128).description(brLabel(128)),
  Schema.const(192).description(brLabel(192)),
  Schema.const(320).description(brLabel(320)),
  Schema.const(740).description(brLabel(740)),
  Schema.const(999).description(brLabel(999)),
]) as unknown as Schema<BrValue>

const SendModeSchema = Schema.union([
  Schema.const('record').description('语音 record（直链，快，但高码率 wma 可能失败）'),
  Schema.const('buffer').description('语音 buffer（更稳，但更耗流量/时间）'),
]) as unknown as Schema<SendMode>

const RecallKeySchema = Schema.union([
  Schema.const('generationTip').description('“生成中”提示消息'),
  Schema.const('songList').description('歌单消息'),
])

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    command: Schema.string().default('music').description('使用的指令名称'),
    alias: Schema.array(String).default(['听歌']).description('使用的指令别名（可多个）'),

    apiBase: Schema.string().default('https://music-api.gdstudio.xyz/api.php')
      .description('GD 音乐台 API 地址（如：https://music-api.gdstudio.xyz/api.php）'),
  }).description('基础设置'),

  Schema.object({
    generationTip: Schema.string().default('生成语音中…').description('生成语音时返回的提示文字'),
    promptTimeoutSec: Schema.number().default(45).description('等待用户输入序号的最长时间（秒）'),
    promptTimeout: Schema.string().default('输入超时，已取消点歌。').description('超时提示'),
    exitPrompt: Schema.string().default('已退出歌曲选择。').description('退出提示'),
    invalidNumber: Schema.string().default('序号输入错误，已退出歌曲选择。').description('序号错误提示'),
    durationExceeded: Schema.string().default('歌曲时长超出限制，已取消发送。').description('时长超限提示'),
    getSongFailed: Schema.string().default('获取歌曲失败，请稍后再试。').description('获取失败提示'),
  }).description('文案设置'),

  Schema.object({
    searchCount: Schema.number().min(1).max(50).default(20).description('搜索的歌曲列表数量'),
    menuAsImage: Schema.boolean().default(false)
      .description('开启后返回图片歌单（需要 puppeteer 服务；未安装则自动回退文本）'),
    nextPageCmd: Schema.string().default('下一页').description('翻页指令-下一页'),
    prevPageCmd: Schema.string().default('上一页').description('翻页指令-上一页'),
    exitCmds: Schema.array(String).default(['0', '不听了']).description('退出选择指令（一行一个）'),
    showExitHint: Schema.boolean().default(true).description('是否在歌单末尾展示退出提示'),
  allowGroupSelect: Schema.boolean().default(false).description('是否允许群内其他人选择点歌（false 则仅原请求人可选择）'),
    maxSongDurationMin: Schema.number().min(0).default(30).description('歌曲最长时长（分钟，0=不限制）'),
  }).description('歌单设置'),

  Schema.object({
    source: SourceSchema.default('netease')
      .description('音乐源（部分可能失效，建议使用稳定音乐源）'),
    br: BrSchema.default(999)
      .description('音质 br（740/999 无损；高码率可能返回 wma，建议开启强制转码或改用 192/128）'),
    userAgent: Schema.string().default('koishi-music-to-voice/1.0').description('请求 UA（部分站点会风控/403）'),
    requestTimeoutMs: Schema.number().min(1000).default(15000).description('请求超时（毫秒）'),
    requestRetry: Schema.number().min(0).max(5).default(1).description('请求失败重试次数'),
  }).description('请求设置'),

  Schema.object({
    sendMode: SendModeSchema.default('record').description('发送类型'),
    forceTranscode: Schema.boolean().default(false)
      .description('强制转码（下载→ffmpeg→wav→buffer；开启后建议选择 buffer 发送）'),
    transcodeFormat: Schema.union(['wav', 'aac', 'silk'] as const).default('aac')
      .description('转码目标格式（aac 推荐用于 QQ/NapCat）'),
    ffmpegBin: Schema.string().default('ffmpeg').description('ffmpeg 可执行文件（容器一般为 ffmpeg 或 /usr/bin/ffmpeg）'),
      ffmpegTimeoutMs: Schema.number().min(1000).default(20000).description('ffmpeg 转码超时（毫秒）'),
      checkFfmpegOnStart: Schema.boolean().default(true).description('启动时检测 ffmpeg 是否可用（可禁用）'),
  }).description('进阶设置'),

  Schema.object({
    recallMessages: Schema.array(RecallKeySchema).role('checkbox')
      .default(['generationTip', 'songList'])
      .description('勾选后撤回对应消息（未勾选=不撤回）'),
    tipRecallSec: Schema.number().min(0).default(10).description('“生成中”提示撤回秒数（0=不撤回）'),
    menuRecallSec: Schema.number().min(0).default(60).description('歌单撤回秒数（0=不撤回）'),
    recallOnlyAfterSuccess: Schema.boolean().default(true).description('仅在发送成功后才撤回（推荐开启）'),
    keepMenuIfSendFailed: Schema.boolean().default(true).description('发送失败时保留歌单（推荐开启）'),
  }).description('撤回设置'),

  Schema.object({
    debug: Schema.boolean().default(false).description('日志调试模式'),
  }).description('开发者选项'),
])

type PendingKey = string

interface PendingState {
  userId: string
  channelId: string
  page: number
  keyword: string
  items: SearchItem[]
  createdAt: number
  menuMessageIds: string[]
}

function pendingKey(session: Session, cfg?: Config) {
  // 如果允许群内其他人选择，则以平台+频道为 key（channel 级），否则默认每个用户一个 pending
  if (cfg?.allowGroupSelect) return `${session.platform}:${session.channelId}`
  return `${session.platform}:${session.userId}:${session.channelId}`
}

function isExitInput(input: string, cfg: Config) {
  const t = input.trim()
  if (!t) return false
  return cfg.exitCmds.map(x => x.trim()).filter(Boolean).includes(t)
}

function buildSearchUrl(cfg: Config, keyword: string, page: number) {
  const u = new URL(cfg.apiBase)
  u.searchParams.set('types', 'search')
  u.searchParams.set('source', cfg.source)
  u.searchParams.set('name', keyword)
  u.searchParams.set('count', String(cfg.searchCount))
  u.searchParams.set('pages', String(page))
  return u.toString()
}

function buildUrlUrl(cfg: Config, id: string, br: number) {
  const u = new URL(cfg.apiBase)
  u.searchParams.set('types', 'url')
  u.searchParams.set('id', id)
  u.searchParams.set('source', cfg.source)
  u.searchParams.set('br', String(br))
  return u.toString()
}

function normalizeSearchItems(resp: any): SearchItem[] {
  // 兼容各种返回结构：resp.data / resp.result / resp
  const r = resp?.data ?? resp?.result ?? resp
  const arr =
    r?.data ?? r?.result ?? r?.songs ?? r?.list ?? r

  if (!arr) return []
  if (Array.isArray(arr)) return arr
  if (Array.isArray(arr?.list)) return arr.list
  if (Array.isArray(arr?.songs)) return arr.songs
  return []
}

function renderMenuText(cfg: Config, keyword: string, page: number, items: SearchItem[]) {
  const lines: string[] = []
  const header = `🎵 搜索：${keyword}（第 ${page} 页）`
  lines.push(header, '')

  items.slice(0, cfg.searchCount).forEach((it, i) => {
    const idx = i + 1
    const title = pickName(it)
    const artist = pickArtist(it)
    const dur = fmtDuration(pickDurationSec(it))
    // ✅ 不再出现 [--:--]：拿不到就不显示
    const suffix = dur ? `  [${dur}]` : ''
    lines.push(`${idx}. ${title}${artist ? ` - ${artist}` : ''}${suffix}`)
  })

  lines.push('', `指令：${cfg.prevPageCmd} / ${cfg.nextPageCmd}`)
  if (cfg.showExitHint) lines.push(`退出：${cfg.exitCmds.join(' / ')}`)
  lines.push('回复序号即可点歌。')

  return lines.join('\n')
}

async function safeRecall(session: Session, messageIds: string[]) {
  for (const id of messageIds) {
    try { await session.bot.deleteMessage(session.channelId!, id) } catch {}
  }
}

export function apply(ctx: Context, cfg: Config) {
  const pending = new Map<PendingKey, PendingState>()

  // 启动时检测 ffmpeg（可配置禁用）
  if (cfg.checkFfmpegOnStart) {
    ;(async () => {
      try {
        const bin = cfg.ffmpegBin || 'ffmpeg'
        const ok = await checkFfmpegAvailable(bin, cfg.ffmpegTimeoutMs)
        if (ok) {
          logger.info(`ffmpeg available: ${bin}`)
        } else {
          logger.warn(`ffmpeg not available: ${bin}. 转码相关功能可能无法使用。若本机已安装 ffmpeg，请确认路径或在配置中设置 ffmpegBin；要关闭此检查请设置 checkFfmpegOnStart=false`)
          if (cfg.forceTranscode || cfg.transcodeFormat === 'aac') {
            logger.warn('当前配置要求转码（forceTranscode 或 transcodeFormat=aac），但 ffmpeg 不可用，发送可能失败。')
          }
        }
      } catch (e: any) {
        logger.warn(`ffmpeg check failed: ${e?.message || e}`)
      }
    })()
  }

  // 处理选择的通用函数（抽取以便中间件与命令共用）
  async function handleSelection(session: Session, st: PendingState, n: number, k: PendingKey) {
    if (!session) return
    if (!Number.isInteger(n) || n < 1 || n > st.items.length) {
      pending.delete(k)
      await session.send(cfg.invalidNumber)
      return
    }

    const chosen = st.items[n - 1]
    const songId = toId(chosen?.id ?? chosen?.songid)
    if (!songId) {
      pending.delete(k)
      await session.send(cfg.getSongFailed)
      return
    }

    // 生成中提示
    const tipIds: string[] = []
    try {
      const id = await session.send(cfg.generationTip)
      if (typeof id === 'string') tipIds.push(id)
    } catch {}

    // 先拿直链：支持降码率
    const brFallback: number[] = cfg.br === 999
      ? [999, 740, 320, 192, 128]
      : cfg.br === 740
        ? [740, 320, 192, 128]
        : cfg.br === 320
          ? [320, 192, 128]
          : cfg.br === 192
            ? [192, 128]
            : [128]

    let finalUrl: string | undefined
    let finalBr: number | undefined
    let lastErr: any

    for (const br of brFallback) {
      try {
        const api = buildUrlUrl(cfg, songId, br)
        const resp = await httpGetJson(ctx, api, cfg)
        const parsed = safeJsonParse(resp)
        const r: UrlResp = parsed ?? (resp as any)?.data ?? resp
        if (r?.url) {
          finalUrl = r.url
          finalBr = br
          logger.info(`got url for id=${songId} br=${br} -> ${finalUrl}`)
          break
        } else {
          logger.info(`no url returned for id=${songId} br=${br}`)
        }
      } catch (e: any) {
        lastErr = e
      }
    }

    if (!finalUrl) {
      pending.delete(k)
      logger.warn(`no url from api, lastErr=${lastErr?.message || lastErr}`)
      await session.send(cfg.getSongFailed)
      if (cfg.recallMessages.includes('generationTip') && cfg.tipRecallSec > 0) {
        ctx.setTimeout(() => safeRecall(session, tipIds), cfg.tipRecallSec * 1000)
      }
      return
    }

    const durSec = pickDurationSec(chosen)
    if (cfg.maxSongDurationMin > 0 && durSec && durSec > cfg.maxSongDurationMin * 60) {
      pending.delete(k)
      await session.send(cfg.durationExceeded)
      if (cfg.recallMessages.includes('generationTip') && cfg.tipRecallSec > 0) {
        ctx.setTimeout(() => safeRecall(session, tipIds), cfg.tipRecallSec * 1000)
      }
      return
    }

    const needTranscode =
      cfg.forceTranscode ||
      cfg.sendMode === 'buffer' ||
      isLikelyWma(finalUrl) ||
      (finalBr !== undefined && finalBr >= 320)

    let sentOk = false

    try {
      if (!needTranscode && cfg.sendMode === 'record') {
        logger.info(`sending direct audio url to session: ${finalUrl}`)
        await session.send(h.audio(finalUrl))
        sentOk = true
      } else {
        logger.info(`starting download for transcode: ${finalUrl}`)
        const raw = await httpGetBuffer(ctx, finalUrl, cfg)
        logger.info(`download complete, ${raw.length} bytes, starting transcode format=${cfg.transcodeFormat}`)
        try {
          const { buffer: outBuf, mime } = await ffmpegTranscode(raw, cfg, cfg.transcodeFormat, finalBr)
          logger.info(`transcode succeeded, mime=${mime}, bytes=${outBuf.length}`)
          await session.send(h.audio(outBuf, mime))
          sentOk = true
        } catch (e: any) {
          logger.warn(`transcode failed: ${e?.message || e}; falling back to wav`)
          if ((e as any)?.stderr) logger.warn(`ffmpeg stderr: ${(e as any).stderr}`)
          const wav = await ffmpegToWavBuffer(raw, cfg)
          await session.send(h.audio(wav, 'audio/wav'))
          sentOk = true
        }
      }
    } catch (e: any) {
      const msg = e?.message || String(e)
      logger.warn(`send failed: ${msg}`)
      if ((e as any)?.stderr) logger.warn(`ffmpeg stderr: ${(e as any).stderr}`)
      await session.send(
        `获取/发送失败：\n` +
        `1) 320k 以上常返回 wma，建议将 br 改为 192/128；\n` +
        `2) 或开启【强制转码】并选择 buffer 发送（downloads+ffmpeg+silk/NapCat 转码更稳）。`
      )
    }

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

    pending.delete(k)
  }

  // 中间件：拦截 pending 状态下的纯文本回复（例如群成员直接回复序号）
  ctx.middleware(async (session, next) => {
    try {
      const text = String(session.content ?? '').trim()
      if (!text) return next()
      // 避免拦截新的点歌命令（例如“听歌 xxx”）
      const first = text.split(/\s+/)[0]
      if (first === cfg.command || (cfg.alias || []).includes(first)) return next()

      const k = pendingKey(session, cfg)
      const st = pending.get(k)
      if (!st) return next()

      // 若为控制指令
      if (isExitInput(text, cfg)) {
        pending.delete(k)
        await session.send(cfg.exitPrompt)
        return
      }
      if (text === cfg.nextPageCmd) {
        st.page += 1
        try {
          const url = buildSearchUrl(cfg, st.keyword, st.page)
          const resp = await httpGetJson(ctx, url, cfg)
          const items = normalizeSearchItems(resp)
          st.items = items
          st.menuMessageIds = []
          const txt = renderMenuText(cfg, st.keyword, st.page, items)
          const id = await session.send(txt)
          if (typeof id === 'string') st.menuMessageIds.push(id)
          pending.set(k, st)
        } catch (e: any) {
          logger.warn(`search failed: ${e?.message || e}`)
          await session.send(cfg.getSongFailed)
        }
        return
      }
      if (text === cfg.prevPageCmd) {
        st.page = Math.max(1, st.page - 1)
        try {
          const url = buildSearchUrl(cfg, st.keyword, st.page)
          const resp = await httpGetJson(ctx, url, cfg)
          const items = normalizeSearchItems(resp)
          st.items = items
          st.menuMessageIds = []
          const txt = renderMenuText(cfg, st.keyword, st.page, items)
          const id = await session.send(txt)
          if (typeof id === 'string') st.menuMessageIds.push(id)
          pending.set(k, st)
        } catch (e: any) {
          logger.warn(`search failed: ${e?.message || e}`)
          await session.send(cfg.getSongFailed)
        }
        return
      }

      // 数字选择
      const n = Number(text)
      if (Number.isInteger(n)) {
        await handleSelection(session, st, n, k)
        return
      }
    } catch (e: any) {
      logger.warn(`pending middleware error: ${e?.message || e}`)
    }
    return next()
  })

  const cmd = ctx.command(`${cfg.command} <keyword:text>`, '点歌并发送语音')
  for (const a of (cfg.alias || [])) cmd.alias(a)

  cmd.action(async ({ session }, keyword) => {
    if (!session) return

  const k = pendingKey(session, cfg)

    // 处理“序号/上一页/下一页/退出”
    const st = pending.get(k)
    const input = String(keyword ?? '').trim()

    // 如果当前处在选择态，优先解释输入为控制指令
    if (st && input) {
      if (isExitInput(input, cfg)) {
        pending.delete(k)
        await session.send(cfg.exitPrompt)
        return
      }
      if (input === cfg.nextPageCmd) {
        st.page += 1
        try {
          const url = buildSearchUrl(cfg, st.keyword, st.page)
          const resp = await httpGetJson(ctx, url, cfg)
          const items = normalizeSearchItems(resp)
          st.items = items
          st.menuMessageIds = []
          const text = renderMenuText(cfg, st.keyword, st.page, items)
          const id = await session.send(text)
          if (typeof id === 'string') st.menuMessageIds.push(id)
          pending.set(k, st)
        } catch (e: any) {
          logger.warn(`search failed: ${e?.message || e}`)
          await session.send(cfg.getSongFailed)
        }
        return
      }
      if (input === cfg.prevPageCmd) {
        st.page = Math.max(1, st.page - 1)
        try {
          const url = buildSearchUrl(cfg, st.keyword, st.page)
          const resp = await httpGetJson(ctx, url, cfg)
          const items = normalizeSearchItems(resp)
          st.items = items
          st.menuMessageIds = []
          const text = renderMenuText(cfg, st.keyword, st.page, items)
          const id = await session.send(text)
          if (typeof id === 'string') st.menuMessageIds.push(id)
          pending.set(k, st)
        } catch (e: any) {
          logger.warn(`search failed: ${e?.message || e}`)
          await session.send(cfg.getSongFailed)
        }
        return
      }

      // 输入序号
      const n = Number(input)
      if (!Number.isInteger(n) || n < 1 || n > st.items.length) {
        pending.delete(k)
        await session.send(cfg.invalidNumber)
        return
      }

      const chosen = st.items[n - 1]
      const songId = toId(chosen?.id ?? chosen?.songid)
      if (!songId) {
        pending.delete(k)
        await session.send(cfg.getSongFailed)
        return
      }

      // 生成中提示
      const tipIds: string[] = []
      try {
        const id = await session.send(cfg.generationTip)
        if (typeof id === 'string') tipIds.push(id)
      } catch {}

      // 先拿直链：支持降码率
      const brFallback: number[] = cfg.br === 999
        ? [999, 740, 320, 192, 128]
        : cfg.br === 740
          ? [740, 320, 192, 128]
          : cfg.br === 320
            ? [320, 192, 128]
            : cfg.br === 192
              ? [192, 128]
              : [128]

      let finalUrl: string | undefined
      let finalBr: number | undefined
      let lastErr: any

      for (const br of brFallback) {
        try {
          const api = buildUrlUrl(cfg, songId, br)
          const resp = await httpGetJson(ctx, api, cfg)
          // 兼容：有的适配器返回直接对象/字符串，有的把实际 payload 放在 data 字段
          const parsed = safeJsonParse(resp)
          // 优先使用 parsed，如果没有则尝试 resp.data，再回退到 resp
          const r: UrlResp = parsed ?? (resp as any)?.data ?? resp
          if (r?.url) {
            finalUrl = r.url
            finalBr = br
            logger.info(`got url for id=${songId} br=${br} -> ${finalUrl}`)
            break
          } else {
            logger.info(`no url returned for id=${songId} br=${br}`)
          }
        } catch (e: any) {
          lastErr = e
        }
      }

      if (!finalUrl) {
        pending.delete(k)
  logger.warn(`no url from api, lastErr=${lastErr?.message || lastErr}`)
        await session.send(cfg.getSongFailed)
        // 撤回提示（可选）
        if (cfg.recallMessages.includes('generationTip') && cfg.tipRecallSec > 0) {
          ctx.setTimeout(() => safeRecall(session, tipIds), cfg.tipRecallSec * 1000)
        }
        return
      }

      // 时长限制（如果搜索项里能拿到 duration）
      const durSec = pickDurationSec(chosen)
      if (cfg.maxSongDurationMin > 0 && durSec && durSec > cfg.maxSongDurationMin * 60) {
        pending.delete(k)
        await session.send(cfg.durationExceeded)
        if (cfg.recallMessages.includes('generationTip') && cfg.tipRecallSec > 0) {
          ctx.setTimeout(() => safeRecall(session, tipIds), cfg.tipRecallSec * 1000)
        }
        return
      }

      const needTranscode =
        cfg.forceTranscode ||
        cfg.sendMode === 'buffer' ||
        isLikelyWma(finalUrl) ||
        (finalBr !== undefined && finalBr >= 320) // 高码率更建议走 buffer

      let sentOk = false

      try {
        if (!needTranscode && cfg.sendMode === 'record') {
          // 直链：快，但 wma/风控时可能失败
          logger.info(`sending direct audio url to session: ${finalUrl}`)
          await session.send(h.audio(finalUrl))
          sentOk = true
        } else {
          // ✅ 稳定模式：下载 → ffmpeg 转码（根据配置）→ buffer 发送
          logger.info(`starting download for transcode: ${finalUrl}`)
          const raw = await httpGetBuffer(ctx, finalUrl, cfg)
          logger.info(`download complete, ${raw.length} bytes, starting transcode format=${cfg.transcodeFormat}`)
          try {
            const { buffer: outBuf, mime } = await ffmpegTranscode(raw, cfg, cfg.transcodeFormat, finalBr)
            logger.info(`transcode succeeded, mime=${mime}, bytes=${outBuf.length}`)
            await session.send(h.audio(outBuf, mime))
            sentOk = true
          } catch (e: any) {
            // 如果转码失败，尝试回退到 wav 以提高成功率
            logger.warn(`transcode failed: ${e?.message || e}; falling back to wav`)
            if ((e as any)?.stderr) logger.warn(`ffmpeg stderr: ${(e as any).stderr}`)
            const wav = await ffmpegToWavBuffer(raw, cfg)
            await session.send(h.audio(wav, 'audio/wav'))
            sentOk = true
          }
        }
      } catch (e: any) {
        const msg = e?.message || String(e)
        logger.warn(`send failed: ${msg}`)
        if ((e as any)?.stderr) logger.warn(`ffmpeg stderr: ${(e as any).stderr}`)
        // ✅ 给用户更明确提示：高码率 wma 说明
        await session.send(
          `获取/发送失败：\n` +
          `1) 320k 以上常返回 wma，建议将 br 改为 192/128；\n` +
          `2) 或开启【强制转码】并选择 buffer 发送（downloads+ffmpeg+silk/NapCat 转码更稳）。`
        )
      }

      // 撤回逻辑（按你要的：仅成功后撤回）
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

      pending.delete(k)
      return
    }

    // 新搜索
    const kw = input
    if (!kw) return '请输入关键词。'

    const page = 1
    try {
      const url = buildSearchUrl(cfg, kw, page)
      const resp = await httpGetJson(ctx, url, cfg)
      const items = normalizeSearchItems(resp)

      if (!items.length) {
        return '没有搜索到结果。'
      }

      const text = renderMenuText(cfg, kw, page, items)
      const mid = await session.send(text)
      const menuIds: string[] = []
      if (typeof mid === 'string') menuIds.push(mid)

      pending.set(k, {
        userId: session.userId!,
        channelId: session.channelId!,
        page,
        keyword: kw,
        items,
        createdAt: Date.now(),
        menuMessageIds: menuIds,
      })

      // 超时自动退出
      ctx.setTimeout(() => {
        const cur = pending.get(k)
        if (!cur) return
        if (Date.now() - cur.createdAt >= cfg.promptTimeoutSec * 1000) {
          pending.delete(k)
          session.send(cfg.promptTimeout).catch(() => {})
        }
      }, cfg.promptTimeoutSec * 1000)

    } catch (e: any) {
      logger.warn(`search failed: ${e?.message || e}`)
      return cfg.getSongFailed
    }
  })
}
