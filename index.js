/**
 * 带话（session-relay）—— QQ 会话之间的「交接」。
 *
 * 场景：甲和「负责甲的会话 A」说话，想让 A 带话给乙。乙的回复只会落到「负责乙的会话 B」，
 * A/B 互不相通，于是 B 不知道前因、开始乱发消息。
 *
 * 做法：A 不直接给乙发消息，而是调用 `qq_relay` 把话交给 B——插件把一段带前因的消息
 * 投进 B 的待处理上下文，由 B 用自己的口吻发给乙（乙看到的是「甲说，……」）。
 * 关键词（`转告`、`帮我跟他说` …）出现在甲对 A 说的话里时，才认为 A 获得了这次带话的授权，
 * 防止 A 自作主张；投递后若 B 整轮都没发出去，插件兜底代发同一句。
 *
 * 开关：`config.enabled`（默认开）。关掉时不注册任何工具与监听器。
 */

import { randomUUID } from 'node:crypto'

/** 甲对 A 说的话里出现这些词，才允许 A 带话。 */
const DEFAULT_KEYWORDS = ['转告', '帮我跟他说', '帮我跟她说', '帮我告诉他', '帮我告诉她', '带个话', '带句话']

/** 会真正把文字发到 QQ 的工具名；用来判断 B 这一轮有没有自己发出去。 */
const SEND_TOOLS = new Set([
  'qq_send_text',
  'qq_reply_quote',
  'qq_send_image',
  'qq_send_private_file',
  'qq_send_music_card',
  'qq_send_voice',
  'qq_send_link_card',
  'qq_send_sticker',
])

/** 私聊折叠成 `qq-vip` 的那几个号（与 dsh-channel-qq 的 VIP_DM_IDS 一致）。 */
const VIP_DM_IDS = [1571229771, 3599612346]

/** 授权有效期：甲说完关键词后这段时间内 A 都可以带话。 */
const ARM_TTL_MS = 10 * 60 * 1000

/** 交接后等 B 发消息的上限；超时就放弃兜底，免得半夜突然发一句。 */
const RELAY_WAIT_MS = 10 * 60 * 1000

export const inject = ['tools', 'sessionController']

export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  if (!settings.enabled) {
    note(ctx, 'warn', 'enabled=false，没有注册带话工具。')
    return
  }

  /** 会话 id → 最近一次拿到带话授权的时间。 */
  const armed = new Map()
  /** 目标会话 id → 正在等它发出去的那次交接。 */
  const pending = new Map()

  const isArmed = (sessionId) => {
    const at = armed.get(sessionId)
    if (at === undefined) return false
    if (Date.now() - at > settings.armTtlMs) {
      armed.delete(sessionId)
      return false
    }
    return true
  }

  async function relay(args, exec) {
    const input = args ?? {}
    const to = Number(input.to)
    const text = safeString(input.text).trim()
    const isGroup = input.isGroup === true
    const explicitFrom = safeString(input.from).trim()
    const noteText = safeString(input.note).trim()
    const agent = exec?.agent
    const fromSessionId = safeString(agent?.id)

    if (!isQqSession(fromSessionId)) {
      throw new Error('qq_relay 只在 QQ 会话里用；别的会话不需要带话。')
    }
    if (!Number.isInteger(to) || to <= 0) {
      throw new Error('to 要给对方的 QQ 号（私聊）或群号（群聊）。')
    }
    if (!text) {
      throw new Error('text 不能为空：把甲要带的那句话原样放进来。')
    }
    if (!isArmed(fromSessionId)) {
      throw new Error(
        '甲刚才没有说要你带话，别自己决定。先用一句话问清楚要带给谁、说什么；'
        + '甲明确说「转告…」「帮我跟他说…」这类话之后，再调用 qq_relay。',
      )
    }

    const base = isGroup
      ? settings.hubSessionId
      : (settings.vipIds.includes(to) ? settings.vipSessionId : `qq-dm-${to}`)
    const target = await findSession(ctx, base, exec?.signal)
    if (!target) {
      throw new Error(
        `联系不上 ${isGroup ? `群 ${to}` : `QQ ${to}`} 的会话（可能还没聊过）。`
        + `请直接回复甲：「我联系不上${isGroup ? `群 ${to}` : ` QQ ${to}`}，你自己跟他说吧」。不要自己给对方发消息。`,
      )
    }

    const resolved = await ctx.sessionController.resolveAgent(target.sessionId)
    const targetAgent = resolved?.agent
    if (!targetAgent) {
      throw new Error(
        `联系不上 QQ ${to} 的会话（${safeString(resolved?.error) || '打不开'}）。`
        + '请直接回复甲：「我联系不上他，你自己跟他说吧」。不要自己给对方发消息。',
      )
    }

    const fromName = explicitFrom || (await sessionLabel(ctx, fromSessionId)) || '对方'
    const sendText = `${fromName}说，${text}`
    const body = buildRelayBody({ fromName, to, isGroup, text, noteText, sendText })

    const relayId = randomUUID()
    targetAgent.followup(relayMessage(body))
    armed.delete(fromSessionId)

    const record = {
      relayId,
      sessionId: target.sessionId,
      targetAgent,
      to,
      isGroup,
      sendText,
      startedTurn: null,
      sawSend: false,
      timer: null,
    }
    record.timer = setTimeout(() => {
      if (pending.get(target.sessionId)?.relayId !== relayId) return
      pending.delete(target.sessionId)
      note(ctx, 'warn', `交接给 ${target.sessionId} 后十分钟没等到结果，放弃兜底。`)
    }, RELAY_WAIT_MS)
    record.timer.unref?.()
    pending.set(target.sessionId, record)

    note(ctx, 'info', `已把「${fromName}」的话交接给 ${target.sessionId}（目标 ${to}，群=${isGroup}）。`)
    return { ok: true, sessionId: target.sessionId, target: to }
  }

  const definition = {
    name: 'qq_relay',
    description: [
      '把甲要带的话交接给「对方」自己的 QQ 会话，由那边的会话去发，而不是你直接发。',
      '只有甲明确让你带话（说「转告」「帮我跟他说」「带个话」之类）时才用；甲没说就先问清楚。',
      '交接成功后对方会用自己的口吻发给乙。你只要回甲一句「带到了」，不要再用 qq_send_text 发同一句。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'integer', description: '要带给谁：私聊填 QQ 号，群聊填群号。' },
        text: { type: 'string', description: '甲要带给对方的那句话，原样放进来，不要改写。' },
        isGroup: { type: 'boolean', description: 'true=带给一个群；false 或不填=私聊某个 QQ。', default: false },
        from: { type: 'string', description: '可选：托你带话的人叫什么（聊天里看到的昵称）；不填就用会话标题。' },
        note: { type: 'string', description: '可选：甲的原话或补充语境，帮对方理解前因。' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          target: { type: 'integer' },
        },
        required: ['ok', 'sessionId', 'target'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: `话已经交给 ${value.sessionId}，对方会用自己的口吻发给 ${value.target}。` }]
      },
    },
    execute: relay,
  }

  const disposeTool = ctx.tools.register(definition, {
    when: ({ agent }) => isQqSession(safeString(agent?.id)),
  })
  ctx.on('dispose', () => {
    disposeTool()
  })

  const offEvent = ctx.on('session/event', (session, event) => {
    try {
      handleEvent(session, event)
    } catch (error) {
      note(ctx, 'warn', `处理会话事件出错：${error instanceof Error ? error.message : String(error)}`)
    }
  })
  ctx.on('dispose', () => {
    offEvent()
    for (const record of pending.values()) clearTimeout(record.timer)
    pending.clear()
  })

  function handleEvent(session, event) {
    const sessionId = safeString(session?.id)
    if (!sessionId || !isQqSession(sessionId)) return
    switch (event?.type) {
      case 'user/message': {
        const message = event.message
        if (message?.source?.plugin === 'session-relay') return
        const text = textOfMessage(message)
        if (!text) return
        if (settings.keywords.some((keyword) => text.includes(keyword))) {
          armed.set(sessionId, Date.now())
        }
        return
      }
      case 'tool/call': {
        const record = pending.get(sessionId)
        if (!record || record.sawSend || !SEND_TOOLS.has(safeString(event.name))) return
        let parsed = null
        try {
          parsed = JSON.parse(safeString(event.arguments) || '{}')
        } catch {
          return
        }
        if (Number(parsed?.target) === record.to) record.sawSend = true
        return
      }
      case 'turn/start': {
        const record = pending.get(sessionId)
        if (!record || record.startedTurn !== null) return
        if (Number(event.turn) >= 0) record.startedTurn = Number(event.turn)
        return
      }
      case 'turn/end': {
        const record = pending.get(sessionId)
        if (!record) return
        if (record.startedTurn === null || Number(event.turn) !== record.startedTurn) return
        pending.delete(sessionId)
        clearTimeout(record.timer)
        if (!record.sawSend) void sendFallback(record)
        return
      }
      default:
    }
  }

  async function sendFallback(record) {
    try {
      const result = await ctx.tools.execute({
        calls: [{
          type: 'tool-call',
          id: `relay_${randomUUID()}`,
          name: 'qq_send_text',
          arguments: JSON.stringify({ isGroup: record.isGroup, target: record.to, text: record.sendText }),
        }],
        signal: new AbortController().signal,
        agent: record.targetAgent,
      })
      const outcome = result?.results?.[0]?.result
      if (outcome?.isError) {
        note(ctx, 'warn', `兜底代发失败：${safeString(outcome?.error?.message) || '未知原因'}`)
        return
      }
      note(ctx, 'info', `对方那一轮没发，已经兜底代发给 ${record.to}。`)
    } catch (error) {
      note(ctx, 'warn', `兜底代发失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  note(ctx, 'info', `已启用（关键词：${settings.keywords.join('、')}；授权 ${Math.round(settings.armTtlMs / 60000)} 分钟）。`)
}

function normalizeConfig(config) {
  const raw = config ?? {}
  const keywords = Array.isArray(raw.keywords) && raw.keywords.length > 0
    ? raw.keywords.map((value) => safeString(value)).filter(Boolean)
    : DEFAULT_KEYWORDS
  const vipIds = Array.isArray(raw.vipIds) && raw.vipIds.length > 0
    ? raw.vipIds.map(Number).filter(Number.isInteger)
    : VIP_DM_IDS
  const minutes = Number(raw.armTtlMinutes)
  return {
    enabled: raw.enabled !== false,
    keywords,
    armTtlMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : ARM_TTL_MS,
    vipIds,
    vipSessionId: safeString(raw.vipSessionId) || 'qq-vip',
    hubSessionId: safeString(raw.hubSessionId) || 'qq-hub',
  }
}

function isQqSession(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith('qq-')
}

/** 读会话标题；没有就退回会话 id 里的 QQ 号。 */
async function sessionLabel(ctx, sessionId) {
  try {
    const snapshot = await ctx.sessionQuery?.readTitle?.(sessionId)
    const title = safeString(snapshot?.title).trim()
    if (title) return title
  } catch {
    // 拿不到标题不是错误：下面退回号码。
  }
  const matched = /^qq-dm-(\d+)/.exec(sessionId)
  if (matched) return `QQ ${matched[1]}`
  return ''
}

/** 找目标联系人最近的会话（含 `-rN` 换血代际）。 */
async function findSession(ctx, base, signal) {
  const pattern = new RegExp(`^${escapeRegExp(base)}(-r\\d+)?$`)
  const list = await ctx.sessionController.list({}, signal ?? new AbortController().signal)
  let best = null
  let bestAt = Number.NEGATIVE_INFINITY
  for (const item of list?.items ?? []) {
    const sessionId = safeString(item?.sessionId)
    if (!pattern.test(sessionId)) continue
    const at = Date.parse(safeString(item?.updatedAt)) || 0
    if (at > bestAt) {
      best = item
      bestAt = at
    }
  }
  return best
}

function buildRelayBody({ fromName, to, isGroup, text, noteText, sendText }) {
  const where = isGroup ? `群 ${to}` : `QQ ${to}`
  const lines = [
    `【带话 · 来自「${fromName}」的会话】`,
    '',
    `${fromName} 让我把这句话转告 ${where}：`,
    `> ${text}`,
  ]
  if (noteText) lines.push('', `甲的原话：「${noteText}」`)
  lines.push(
    '',
    '这是转交的话，不是对方发来的。请用 qq_send_text 发给对方'
    + `（isGroup: ${isGroup}, target: ${to}），文字就写「${sendText}」。`,
    '发完不用回复甲。',
  )
  return lines.join('\n')
}

function relayMessage(text) {
  return {
    id: `relay_${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', plugin: 'session-relay' },
  }
}

function textOfMessage(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function safeString(value) {
  return typeof value === 'string' ? value : ''
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function note(ctx, level, text) {
  try {
    ctx.logger?.[level]?.(`session-relay: ${text}`)
  } catch {
    // 日志不是关键路径。
  }
}
