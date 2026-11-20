/**
 * 带话（session-relay）—— QQ 会话之间的「交接」。
 *
 * 场景：甲和「负责甲的会话 A」说话，想让 A 带话给乙。乙的回复只会落到「负责乙的会话 B」，
 * A/B 互不相通，于是 B 不知道前因、开始乱发消息。
 *
 * 做法有两层：
 * 1）自动同步（默认，不依赖模型自觉）：A 用 qq_send_text 等工具把消息发给「不是当前聊天对象」
 *    的人时，插件把这条消息的背景塞进对方会话 B 的待处理上下文（`agent.inject`，不唤醒）。
 *    这样 B 在乙回话时就知道前因，不会瞎发。
 * 2）显式交接：A 调用 `qq_relay`，插件把话交给 B，由 B 用自己的口吻发给乙（乙看到「甲说，……」）。
 *    关键词（`转告`、`帮我跟他说` …）出现在甲对 A 说的话里时才授权；B 整轮没发就兜底代发。
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

/** A 往乙那边发过一次消息之后，等乙回话、再把回话带回 A 的时限。 */
const REPLY_WINDOW_MS = 30 * 60 * 1000

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
  /** 已经同步过背景的跨会话发送（按 callId 去重，防重试重复注入）。 */
  const shared = new Set()
  /** 乙的会话 id → 正在等乙回话、好把回话带回甲的那次发送。 */
  const replyExpectations = new Map()

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
        '对方刚才没有明确说要你带话，别自己决定。先用一句话问清楚要带给谁、说什么；'
        + '对方明确说「转告…」「帮我跟他说…」这类话之后，再调用 qq_relay。',
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

    rememberReplyExpectation(replyExpectations, {
      fromSessionId,
      toSessionId: target.sessionId,
      isGroup,
      peerQQ: to,
    })
    // B 也可能要把乙的话带回去：给它一次授权，免得被关键词卡住。
    armed.set(target.sessionId, Date.now())

    note(ctx, 'info', `已把「${fromName}」的话交接给 ${target.sessionId}（目标 ${to}，群=${isGroup}）。`)
    return { ok: true, sessionId: target.sessionId, target: to }
  }

  const definition = {
    name: 'qq_relay',
    description: [
      '把一句话交接给「另一个人」的 QQ 会话，由那边的会话用自己的口吻去说，而不是你直接发。两个方向都适用。',
      '只在当前聊天的人明确让你带话（说「转告」「帮我跟他说」「带个话」之类）时才用；没说就先问清楚要带给谁、说什么。',
      '交接成功后对方会自己发出去。你只要回一句「带到了」，不要再用 qq_send_text 发同一句。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'integer', description: '要带给谁：私聊填 QQ 号，群聊填群号。' },
        text: { type: 'string', description: '要带给对方的那句话，原样放进来，不要改写。' },
        isGroup: { type: 'boolean', description: 'true=带给一个群；false 或不填=私聊某个 QQ。', default: false },
        from: { type: 'string', description: '可选：托你带话的人叫什么（聊天里看到的昵称）；不填就用会话标题。' },
        note: { type: 'string', description: '可选：原话或补充语境，帮对方理解前因。' },
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
    replyExpectations.clear()
  })

  // 真正的兜底：A 把消息发给「不是当前聊天对象」的人时，把背景同步进对方会话。
  // 用 tools/result（发送成功之后）而不是 pre-execute，避免消息没发出去却留下了背景。
  const offResult = ctx.on('tools/result', (exec, result) => {
    void shareCrossTalk(exec, result).catch((error) => {
      note(ctx, 'warn', `同步跨会话背景出错：${error instanceof Error ? error.message : String(error)}`)
    })
  })
  ctx.on('dispose', () => {
    offResult()
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
        void settleReplyExpectation(ctx, replyExpectations, sessionId, text, settings).catch((error) => {
          note(ctx, 'warn', `把回话带回原会话出错：${error instanceof Error ? error.message : String(error)}`)
        })
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

  /**
   * A 把消息发给了「别人」：把这条消息的背景塞进对方会话，让那边的 agent 知道前因。
   * 只做「记背景」，不改发出去的内容、不唤醒对方、不替谁说话。
   */
  async function shareCrossTalk(exec, result) {
    if (result?.isError) return
    if (!SEND_TOOLS.has(safeString(exec?.name))) return
    const sessionId = safeString(exec?.agent?.id)
    if (!isQqSession(sessionId)) return

    const info = sendTargetOf(safeString(exec?.name), exec?.arguments)
    if (!info) return

    const senderBase = stripGeneration(sessionId)
    const targetBase = roomOf(info, settings)
    if (targetBase === senderBase) return

    const key = safeString(exec?.callId) || `${senderBase}->${targetBase}:${info.target}`
    if (shared.has(key)) return
    shared.add(key)
    if (shared.size > 500) shared.clear()

    const signal = new AbortController().signal
    const list = await ctx.sessionController.list({}, signal)
    const target = pickLatest(list?.items, targetBase)
    if (!target) {
      note(ctx, 'warn', `${targetBase} 还没有会话，这条跨会话消息的背景没地方放。`)
      return
    }
    const resolved = await ctx.sessionController.resolveAgent(target.sessionId)
    const targetAgent = resolved?.agent
    if (!targetAgent) {
      note(ctx, 'warn', `打不开 ${target.sessionId}（${safeString(resolved?.error) || '未知原因'}），背景没同步。`)
      return
    }

    const fromLabel = (await fromLabelOf(ctx, sessionId)) || '对方'
    const body = buildShareText({
      fromLabel,
      isGroup: info.isGroup,
      to: info.target,
      text: info.text,
      ownerQQ: qqNumberOf(senderBase),
    })
    targetAgent.inject(relayMessage(body))
    rememberReplyExpectation(replyExpectations, {
      fromSessionId: sessionId,
      toSessionId: target.sessionId,
      isGroup: info.isGroup,
      peerQQ: info.target,
    })
    // 让 B 也能把乙的话带回甲（否则它没有带话授权，只能干看着）。
    armed.set(target.sessionId, Date.now())
    note(ctx, 'info', `跨会话背景已同步：${sessionId} → ${target.sessionId}（${info.target}）`)
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

/** 去掉换血代际后缀：`qq-dm-123-r2` → `qq-dm-123`。 */
function stripGeneration(sessionId) {
  return safeString(sessionId).replace(/-r\d+$/, '')
}

/** 会话 id → 这次发送应当落在哪个「房间」。 */
function roomOf(info, settings) {
  if (info.isGroup) return settings.hubSessionId
  if (settings.vipIds.includes(info.target)) return settings.vipSessionId
  return `qq-dm-${info.target}`
}

/** 从发送工具的已解析参数里取出「发给谁、发了什么」。 */
function sendTargetOf(name, args) {
  const parsed = typeof args === 'string' ? tryJson(args) : args
  if (!parsed || typeof parsed !== 'object') return null
  const target = Number(parsed.target ?? parsed.groupId ?? parsed.userId)
  if (!Number.isInteger(target) || target <= 0) return null
  const file = safeString(parsed.file)
  const raw = safeString(parsed.text).trim()
    || safeString(parsed.name).trim()
    || safeString(parsed.url).trim()
    || (file ? `（发了一个文件：${file.split(/[\\/]/).pop() || file}）` : '')
    || '（发的不是文字，是图片/语音/表情）'
  return {
    tool: name,
    isGroup: parsed.isGroup === true,
    target,
    text: raw.length > 600 ? `${raw.slice(0, 600)}…` : raw,
  }
}

/** 给目标会话 agent 看的背景说明：只告知，不要求它做任何事。 */
function buildShareText({ fromLabel, isGroup, to, text, ownerQQ }) {
  const where = isGroup ? `群 ${to}` : `QQ ${to}`
  const them = isGroup ? '群里' : 'ta'
  const lines = [
    `【带话 · 自动同步 · 来自「${fromLabel}」】`,
    '',
    `「${fromLabel}」那边刚才给 ${where} 发了一句话，原样是：`,
    `> ${text}`,
    '',
    `这句话已经直接发到 ${them} 的窗口了，你不用再发一遍；${them} 之后回你时，知道它是「${fromLabel}」那边托人带过来的就行。`,
  ]
  if (ownerQQ > 0) {
    lines.push(
      '',
      `「${fromLabel}」是 QQ ${ownerQQ}。如果之后要把对方的话带回给他，用 \`qq_relay({ to: ${ownerQQ}, text: "…" })\` 交接给他的会话，不要自己直接发。`,
    )
  }
  return lines.join('\n')
}

/** 记下「等乙回话」：A 往乙那边发过消息，乙的下一条消息要带回 A。 */
function rememberReplyExpectation(expectations, { fromSessionId, toSessionId, isGroup, peerQQ }) {
  if (isGroup) return
  const fromBase = stripGeneration(fromSessionId)
  const toBase = stripGeneration(toSessionId)
  expectations.set(toBase, {
    fromBase,
    ownerQQ: qqNumberOf(fromBase),
    peerQQ,
    expiresAt: Date.now() + REPLY_WINDOW_MS,
    used: false,
  })
}

/** 乙真的回话了：把这条回话带回 A，由 A 决定要不要转告甲。 */
async function settleReplyExpectation(ctx, expectations, sessionId, text, settings) {
  const key = stripGeneration(sessionId)
  const expect = expectations.get(key)
  if (!expect || expect.used) return
  if (Date.now() > expect.expiresAt) {
    expectations.delete(key)
    return
  }
  expect.used = true

  const source = await findSession(ctx, expect.fromBase)
  if (!source) {
    note(ctx, 'warn', `乙回话了，但找不到原会话 ${expect.fromBase}，回话没带回去。`)
    return
  }
  const resolved = await ctx.sessionController.resolveAgent(source.sessionId)
  const sourceAgent = resolved?.agent
  if (!sourceAgent) {
    note(ctx, 'warn', `乙回话了，但打不开原会话 ${source.sessionId}。`)
    return
  }

  const peerLabel = (await sessionLabel(ctx, sessionId)) || `QQ ${expect.peerQQ}`
  const body = buildReplyText({
    peerLabel,
    peerQQ: expect.peerQQ,
    ownerQQ: expect.ownerQQ,
    text,
  })
  sourceAgent.followup(relayMessage(body))
  note(ctx, 'info', `乙的回话已带回 ${source.sessionId}（对方 QQ ${expect.peerQQ}）。`)
}

function buildReplyText({ peerLabel, peerQQ, ownerQQ, text }) {
  const cut = text.length > 600 ? `${text.slice(0, 600)}…` : text
  const howToSend = ownerQQ > 0
    ? `如果这是给甲的答复，请用 qq_send_text 转告甲（isGroup: false, target: ${ownerQQ}，文字就写「${peerLabel}说，${cut}」）。`
    : '如果这是给甲的答复，用你平时回甲的方式转告他。'
  return [
    `【回话 · 来自「${peerLabel}」的会话】`,
    '',
    `${peerLabel} 刚才回了：`,
    `> ${cut}`,
    '',
    `${howToSend}转告完就行，不用再回这边。`,
  ].join('\n')
}

/** `qq-dm-2174007116` → 2174007116；其他房间（vip/hub/群）拿不到就算 0。 */
function qqNumberOf(base) {
  const matched = /^qq-dm-(\d+)$/.exec(safeString(base))
  return matched ? Number(matched[1]) : 0
}

async function fromLabelOf(ctx, sessionId) {
  const title = safeString(await sessionLabel(ctx, sessionId)).trim()
  return title
}

/** 在会话列表里找某个房间最新（含代际）的那条。 */
function pickLatest(items, base) {
  const pattern = new RegExp(`^${escapeRegExp(base)}(-r\\d+)?$`)
  let best = null
  let bestAt = Number.NEGATIVE_INFINITY
  for (const item of items ?? []) {
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
  const list = await ctx.sessionController.list({}, signal ?? new AbortController().signal)
  return pickLatest(list?.items, base)
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
    id: randomUUID(),
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

function tryJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function note(ctx, level, text) {
  try {
    ctx.logger?.[level]?.(`session-relay: ${text}`)
  } catch {
    // 日志不是关键路径。
  }
}
