import { Context, Schema, Session, h, isNullable } from 'koishi'

// 可选依赖：puppeteer（用于生成图片歌单）。
// 这里不直接 import 'koishi-plugin-puppeteer'，避免你本地没装 types 时 TS 报错。
declare module 'koishi' {
  interface Context {
    puppeteer?: any
  }
}

export const name = 'music-to-voice'
export const usage = `
## Music to Voice（GD 音乐台 API 适配版）

- 通过 GD 音乐台 API 搜索歌曲，并发送语音/音频/文件等
- 支持选择音乐源（网易云/QQ/酷狗/酷我/咪咕…）
- 支持选择音质 br：128/192/320/740/999（740/999 为无损，体积大更慢）

> 提示：图片歌单需要 puppeteer 服务（可选安装）；不装也能用文本歌单。
`

export const Config = Schema.intersect([
  Schema.object({
    commandName: Schema.string().default('music').description('使用的指令名称'),
    commandAlias: Schema.string().default('mdff').description('使用的指令别名'),
    generationTip: Schema.string().default('生成语音中…').description('生成语音时返回的文字提示内容'),

    recallMessages: Schema.array(String)
      .role('table')
      .default(['generationTip', 'songList'])
      .description('勾选后将 撤回/不发送 对应的提示消息（勾选=撤回/不发送，不勾选=不撤回/发送）'),

    recallDelaySec: Schema.natural().min(0).step(1)
      .default(10)
      .description('撤回延迟（秒）<br>0=立即撤回；建议 8~20 秒，避免提示消息撤回过快'),
  }).description('过滤器设置'),

  Schema.object({
    promptTimeout: Schema.string().default('输入超时，已取消点歌').description('超时提示（输入超时，已取消点歌）'),
    exitPrompt: Schema.string().default('已退出歌曲选择').description('退出提示（已退出歌曲选择）'),
    invalidNumber: Schema.string().default('序号输入错误，已退出歌曲选择').description('序号错误提示（序号输入错误，已退出歌曲选择）'),
    durationExceeded: Schema.string().default('歌曲持续时间超出限制').description('时长超限提示（歌曲持续时间超出限制）'),
    getSongFailed: Schema.string().default('获取歌曲失败，请稍后再试').description('获取失败提示（获取歌曲失败，请稍后再试）'),

    waitForChoiceSec: Schema.natural().min(5).step(1).default(45).description('等待用户选择歌曲序号的最长时间（秒）'),
    pageSize: Schema.natural().min(5).step(1).default(20).description('搜索的歌曲列表的数量'),

    nextPageCmd: Schema.string().default('下一页').description('翻页指令-下一页'),
    prevPageCmd: Schema.string().default('上一页').description('翻页指令-上一页'),
    exitCmds: Schema.array(String).role('table').default(['0', '不听了']).description('退出选择指令（一行一个）'),

    showExitHintInList: Schema.boolean().default(true).description('是否在歌单内容的后面，加上退出选择指令的文字提示'),
    maxDurationMin: Schema.natural().min(1).step(1).default(30).description('歌曲最长持续时间（分钟）<br>注意：部分音乐源搜索结果不返回时长，将跳过此限制'),
  }).description('基础设置'),

  Schema.object({
    listMode: Schema.union([
      Schema.const('text').description('文本歌单'),
      Schema.const('image').description('图片歌单（需要 puppeteer，可选安装）'),
    ]).default('text').description('歌单设置'),

    // 发送载体
    srcToWhat: Schema.union([
      Schema.const('text').description('文本 h.text'),
      Schema.const('audio').description('语音 h.audio（直链）'),
      Schema.const('audiobuffer').description('语音（buffer）h.audio（更稳，但更耗流量/时间）'),
      Schema.const('file').description('文件 h.file'),
      Schema.const('video').description('视频 h.video（不推荐）'),
    ]).default('audio').description('歌曲信息的返回格式'),
  }).description('歌单设置'),

  Schema.object({
    enableRateLimit: Schema.boolean().default(false).description('是否启用频率限制'),
    rateLimitWindowSec: Schema.natural().min(1).step(1).default(60).description('频率限制窗口（秒）'),
    rateLimitMax: Schema.natural().min(1).step(1).default(3).description('窗口内最大次数'),
  }).description('频率限制'),

  Schema.object({
    apiBase: Schema.string().default('https://music-api.gdstudio.xyz/api.php')
      .description('后端API地址<br>默认：GD音乐台 API（可自行替换为其它兼容接口）')
      .role('link'),

    source: Schema.union([
      Schema.const('netease').description('网易云（推荐/默认）'),
      Schema.const('tencent').description('QQ 音乐'),
      Schema.const('kugou').description('酷狗音乐'),
      Schema.const('kuwo').description('酷我音乐'),
      Schema.const('migu').description('咪咕音乐'),
      Schema.const('ximalaya').description('喜马拉雅'),
      Schema.const('apple').description('Apple Music'),
      Schema.const('spotify').description('Spotify'),
      Schema.const('ytmusic').description('YouTube Music'),
      Schema.const('tidal').description('Tidal'),
      Schema.const('qobuz').description('Qobuz'),
      Schema.const('joox').description('JOOX'),
      Schema.const('deezer').description('Deezer'),
    ])
      .default('netease')
      .description('音乐源（部分可能失效，建议使用稳定音乐源）'),

    br: Schema.union([
      Schema.const(128).description('128K（省流）'),
      Schema.const(192).description('192K'),
      Schema.const(320).description('320K（高品质）'),
      Schema.const(740).description('740（无损）'),
      Schema.const(999).description('999（无损/默认）'),
    ])
      .default(999)
      .description('音质<br>740、999 为无损音质，体积更大，生成更慢，可能更容易失败'),

    requestTimeoutSec: Schema.natural().min(3).step(1).default(20).description('请求超时（秒）'),

    // 海外可选：Apifox Web Proxy
    useProxy: Schema.boolean().default(false).description('是否使用 Apifox Web Proxy 代理请求（适用于海外用户）'),
    apifoxProxyUrl: Schema.string().default('').description('Apifox Web Proxy 地址（例如：https://xxx.apifoxmock.com）'),
  }).description('请求设置'),

  Schema.object({
    debug: Schema.boolean().default(false).description('日志调试模式'),
  }).description('开发者选项'),
])

type SongData = {
  id: number
  name: string
  artists: string
  albumName: string
  duration: number // ms，部分源可能拿不到：0
}

type PendingState = {
  userId: string
  channelId: string
  keyword: string
  page: number
  list: SongData[]
  songListMessageId?: string
  tipMessageId?: string
  createdAt: number
}

export function apply(ctx: Context, config: any) {
  const logger = ctx.logger(name)
  const rateLimitMap = new Map<string, number>()
  const pendingMap = new Map<string, PendingState>()

  function recallLater(session: Session, messageId?: string) {
    if (!messageId) return
    const ch = session.channelId
    if (!ch) return
    const delay = Number(config.recallDelaySec || 0)
    if (delay <= 0) {
      session.bot.deleteMessage(ch, messageId).catch(() => {})
      return
    }
    setTimeout(() => {
      session.bot.deleteMessage(ch, messageId).catch(() => {})
    }, delay * 1000)
  }

  function hitRateLimit(key: string) {
    if (!config.enableRateLimit) return false
    const now = Date.now()
    const last = rateLimitMap.get(key) || 0
    if (now - last > config.rateLimitWindowSec * 1000) {
      rateLimitMap.set(key, now)
      return false
    }
    return true
  }

  async function requestWithProxy(url: string) {
    if (!config.apifoxProxyUrl) throw new Error('Apifox proxy url is empty')
    const proxyUrl = config.apifoxProxyUrl.replace(/\/$/, '')
    const headers = { 'user-agent': 'koishi-music-to-voice' }
    const timeout = (config.requestTimeoutSec || 20) * 1000
    // 这里按常见 Apifox 代理方式拼接：proxy + 原始 URL
    const finalUrl = `${proxyUrl}/${encodeURIComponent(url)}`
    return await ctx.http.get(finalUrl, { timeout, headers })
  }

  async function searchGD(keyword: string, page: number, limit: number): Promise<SongData[]> {
    const headers = { 'user-agent': 'koishi-music-to-voice' }
    const timeout = (config.requestTimeoutSec || 20) * 1000
    const url = `${config.apiBase}?types=search&source=${config.source}&name=${encodeURIComponent(keyword)}&count=${limit}&pages=${page}`

    try {
      const raw = config.useProxy ? await requestWithProxy(url) : await ctx.http.get(url, { timeout, headers })
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!Array.isArray(parsed) || parsed.length === 0) return []

      return parsed.map((song: any) => {
        const artists =
          Array.isArray(song.artist) ? song.artist.join('/') :
          Array.isArray(song.artists) ? song.artists.join('/') :
          (song.artist || song.artists || '')
        return {
          id: Number(song.id),
          name: String(song.name ?? ''),
          artists: String(artists ?? ''),
          albumName: String(song.album ?? ''),
          duration: 0,
        } as SongData
      }).filter((x: SongData) => x.id && x.name)
    } catch (e) {
      logger.warn(`search failed: ${String(e)}`)
      return []
    }
  }

  async function resolveDirectUrl(songId: number): Promise<string> {
    const headers = { 'user-agent': 'koishi-music-to-voice' }
    const timeout = (config.requestTimeoutSec || 20) * 1000
    const urlApi = `${config.apiBase}?types=url&source=${config.source}&id=${songId}&br=${config.br}`

    const raw = config.useProxy ? await requestWithProxy(urlApi) : await ctx.http.get(urlApi, { timeout, headers })
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw

    const direct =
      parsed?.url ||
      parsed?.data?.url ||
      parsed?.data?.[0]?.url ||
      parsed?.[0]?.url

    if (!direct || typeof direct !== 'string') throw new Error('empty url')
    return direct
  }

  function formatDuration(ms: number) {
    if (!ms || ms <= 0) return '--:--'
    const sec = Math.floor(ms / 1000)
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

  async function renderSongListText(keyword: string, page: number, list: SongData[]) {
    const lines: string[] = []
    lines.push(`🎵 搜索：${keyword}（第 ${page} 页）`)
    lines.push('')
    list.forEach((s, i) => {
      const dur = formatDuration(s.duration)
      lines.push(`${i + 1}. ${s.name} - ${s.artists}  [${dur}]`)
    })
    lines.push('')
    lines.push(`指令：${config.prevPageCmd} / ${config.nextPageCmd}`)
    if (config.showExitHintInList && Array.isArray(config.exitCmds) && config.exitCmds.length) {
      lines.push(`退出：${config.exitCmds.join(' / ')}`)
    }
    lines.push('回复序号即可点歌。')
    return lines.join('\n')
  }

  async function renderSongListImage(keyword: string, page: number, list: SongData[]) {
    // 没装 puppeteer 或没启用就退回文本
    if (!ctx.puppeteer) return null
    try {
      const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;padding:24px;}
    .title{font-size:20px;font-weight:700;margin-bottom:10px;}
    .sub{color:#666;margin-bottom:16px;}
    .item{margin:6px 0;padding:8px 10px;border-radius:10px;border:1px solid #eee;}
    .idx{font-weight:700;margin-right:8px;}
    .meta{color:#666;font-size:12px;margin-top:4px;}
  </style>
</head>
<body>
  <div class="title">🎵 搜索：${keyword}</div>
  <div class="sub">第 ${page} 页 · 回复序号点歌 · ${config.prevPageCmd}/${config.nextPageCmd}</div>
  ${list.map((s, i) => `
    <div class="item">
      <span class="idx">${i + 1}.</span> ${escapeHtml(s.name)} - ${escapeHtml(s.artists)}
      <div class="meta">专辑：${escapeHtml(s.albumName)} · 时长：${formatDuration(s.duration)}</div>
    </div>
  `).join('')}
</body>
</html>`
      const pageObj = await ctx.puppeteer.page()
      await pageObj.setContent(html, { waitUntil: 'networkidle0' })
      const buf = await pageObj.screenshot({ fullPage: true })
      await pageObj.close()
      return buf
    } catch (e) {
      logger.warn(`render image list failed: ${String(e)}`)
      return null
    }
  }

  function escapeHtml(s: string) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c] as string))
  }

  async function sendSongList(session: Session, keyword: string, page: number, list: SongData[]) {
    if (config.listMode === 'image') {
      const buf = await renderSongListImage(keyword, page, list)
      if (buf) return await session.send(h.image(buf, 'image/png'))
    }
    const text = await renderSongListText(keyword, page, list)
    return await session.send(text)
  }

  ctx.i18n.define('zh-CN', {
    commands: {
      [config.commandName]: {
        description: '搜索歌曲并发送语音（GD 音乐台 API）',
      },
    },
  })

  ctx.command(`${config.commandName} <keyword:text>`, '搜索歌曲并发送语音')
    .alias(config.commandAlias)
    .action(async ({ session, options }, keyword) => {
      if (!session) return
      if (!session.userId || !session.channelId) return '无法获取会话信息（userId/channelId），请检查适配器权限。'
      if (!keyword) return

      const rateKey = `${session.channelId}:${session.userId}`
      if (hitRateLimit(rateKey)) return '操作过于频繁，请稍后再试。'

      // 清理旧状态
      pendingMap.delete(rateKey)

      const page = 1
      const list = await searchGD(keyword, page, Number(config.pageSize || 20))
      if (!list.length) {
        return '搜索失败（API 不可用或超时），请稍后再试。'
      }

      const msgId = await sendSongList(session, keyword, page, list)

      const state: PendingState = {
        userId: session.userId ?? '',
        channelId: session.channelId ?? '',
        keyword,
        page,
        list,
        songListMessageId: Array.isArray(msgId) ? msgId[0] : (isNullable(msgId) ? undefined : String(msgId)),
        createdAt: Date.now(),
      }
      pendingMap.set(rateKey, state)

      // 等待用户选择
      const input = await session.prompt(Number(config.waitForChoiceSec || 45) * 1000)
      if (!input) {
        if (config.recallMessages.includes('promptTimeout') === false) {
          await session.send(config.promptTimeout)
        }
        if (config.recallMessages.includes('songList') && state.songListMessageId) recallLater(session, state.songListMessageId)
        pendingMap.delete(rateKey)
        return
      }

      // 翻页
      if (input === config.nextPageCmd || input === config.prevPageCmd) {
        const nextPage = input === config.nextPageCmd ? state.page + 1 : Math.max(1, state.page - 1)
        const newList = await searchGD(state.keyword, nextPage, Number(config.pageSize || 20))
        if (!newList.length) return '搜索失败（API 不可用或超时），请稍后再试。'
        const newMsgId = await sendSongList(session, state.keyword, nextPage, newList)
        // 撤回旧歌单（延迟）
        if (config.recallMessages.includes('songList') && state.songListMessageId) recallLater(session, state.songListMessageId)

        state.page = nextPage
        state.list = newList
        state.songListMessageId = Array.isArray(newMsgId) ? newMsgId[0] : (isNullable(newMsgId) ? undefined : String(newMsgId))
        pendingMap.set(rateKey, state)
        return
      }

      // 退出
      if (Array.isArray(config.exitCmds) && config.exitCmds.includes(input)) {
        if (config.recallMessages.includes('exitPrompt') === false) {
          await session.send(config.exitPrompt)
        }
        if (config.recallMessages.includes('songList') && state.songListMessageId) recallLater(session, state.songListMessageId)
        pendingMap.delete(rateKey)
        return
      }

      const idx = Number(input)
      if (!Number.isFinite(idx) || idx < 1 || idx > state.list.length) {
        if (config.recallMessages.includes('invalidNumber') === false) {
          await session.send(config.invalidNumber)
        }
        if (config.recallMessages.includes('songList') && state.songListMessageId) recallLater(session, state.songListMessageId)
        pendingMap.delete(rateKey)
        return
      }

      const selected = state.list[idx - 1]

      // 生成提示
      const tipId = await session.send(config.generationTip)
      const tipMessageId = Array.isArray(tipId) ? tipId[0] : (isNullable(tipId) ? undefined : String(tipId))

      // 获取直链（关键：先解析 URL，再发）
      let directUrl = ''
      try {
        directUrl = await resolveDirectUrl(selected.id)
      } catch (e) {
        logger.warn(`resolve direct url failed: ${String(e)}`)
        if (config.recallMessages.includes('getSongFailed') === false) {
          await session.send(config.getSongFailed)
        }
        // tip 可撤回，歌单不要强制撤回，方便你再选一次
        if (config.recallMessages.includes('generationTip') && tipMessageId) recallLater(session, tipMessageId)
        pendingMap.delete(rateKey)
        return
      }

      // 时长限制：如果拿不到 duration（=0），跳过限制
      const interval = selected.duration > 0 ? selected.duration / 1000 : 0
      if (interval > 0 && interval > Number(config.maxDurationMin || 30) * 60) {
        if (config.recallMessages.includes('durationExceeded') === false) {
          await session.send(config.durationExceeded)
        }
        if (config.recallMessages.includes('generationTip') && tipMessageId) recallLater(session, tipMessageId)
        // 歌单是否撤回看你配置
        if (config.recallMessages.includes('songList') && state.songListMessageId) recallLater(session, state.songListMessageId)
        pendingMap.delete(rateKey)
        return
      }

      // 发送
      try {
        const title = `${selected.name} - ${selected.artists}`
        if (config.srcToWhat === 'text') {
          await session.send(directUrl)
        } else if (config.srcToWhat === 'audiobuffer') {
          const file = await ctx.http.file(directUrl)
          await session.send(h.audio(file.data, file.type))
        } else if (config.srcToWhat === 'file') {
          await session.send(h.file(directUrl, { title }))
        } else if (config.srcToWhat === 'video') {
          await session.send(h.video(directUrl, { title }))
        } else {
          // 默认 audio（直链）
          await session.send(h.audio(directUrl))
        }

        // 成功后按配置撤回提示/歌单（延迟）
        if (config.recallMessages.includes('generationTip') && tipMessageId) recallLater(session, tipMessageId)
        if (config.recallMessages.includes('songList') && state.songListMessageId) recallLater(session, state.songListMessageId)
      } catch (e) {
        logger.warn(`send failed: ${String(e)}`)
        if (config.recallMessages.includes('getSongFailed') === false) {
          await session.send(config.getSongFailed)
        }
        // 失败：只撤回 tip，不强制撤回歌单，方便你重试
        if (config.recallMessages.includes('generationTip') && tipMessageId) recallLater(session, tipMessageId)
      } finally {
        pendingMap.delete(rateKey)
      }
    })
}
