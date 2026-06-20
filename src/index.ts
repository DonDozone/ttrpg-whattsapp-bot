import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WAMessage,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import dotenv from 'dotenv'

dotenv.config()

const QUERY_SERVICE_URL = process.env.QUERY_SERVICE_URL ?? 'http://localhost:3000'
const GROUP_JID = process.env.GROUP_JID

const TRIGGER = '!wiki '

const logger = pino({ level: 'silent' })

// Baileys loggt libsignal-Entschlüsselungsfehler direkt via console.error —
// diese sind harmlos (alte Sessions anderer Geräte) und verstecken echte Fehler.
const _origError = console.error
console.error = (...args: unknown[]) => {
  const msg = String(args[0] ?? '')
  if (msg.includes('Bad MAC') || msg.includes('Failed to decrypt')) return
  _origError(...args)
}

function getMessageText(msg: WAMessage): string | null {
  const m = msg.message
  if (!m) return null
  return m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? null
}

function mdToWhatsApp(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '*$1*')      // **fett** → *fett*
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')    // # Überschrift → *Überschrift*
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
}

function formatSources(sources: unknown[]): string {
  if (!sources.length) return ''
  return sources
    .map(s => {
      if (typeof s === 'string') return `🔗 ${s}`
      if (s !== null && typeof s === 'object') {
        const o = s as Record<string, unknown>
        return `🔗 ${String(o.url ?? o.href ?? o.link ?? JSON.stringify(s))}`
      }
      return `🔗 ${String(s)}`
    })
    .join('\n')
}

interface AcknowledgeResponse {
  text: string
}

interface ChatResponse {
  text: string
  sources: unknown[]
}

async function fetchAcknowledge(question: string): Promise<string> {
  const res = await fetch(`${QUERY_SERVICE_URL}/api/acknowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  })
  if (!res.ok) throw new Error(`Acknowledge-Endpoint antwortet mit HTTP ${res.status}`)
  const data = (await res.json()) as AcknowledgeResponse
  return data.text
}

async function fetchChat(question: string): Promise<string> {
  const res = await fetch(`${QUERY_SERVICE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  })
  if (!res.ok) throw new Error(`Query-Service antwortet mit HTTP ${res.status}`)
  const data = (await res.json()) as ChatResponse
  const text = mdToWhatsApp(data.text)
  const sourcesBlock = formatSources(data.sources)
  return sourcesBlock ? `${text}\n\n${sourcesBlock}` : text
}

async function startBot(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({ version, auth: state, logger })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrcode.generate(qr, { small: true })
      console.log('QR-Code erschienen — bitte mit der Prepaid-Nummer scannen')
    }
    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom)?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      console.log(`Verbindung getrennt (Code ${code}) — Neustart: ${shouldReconnect}`)
      if (shouldReconnect) startBot()
    } else if (connection === 'open') {
      console.log('✅ WhatsApp-Bot verbunden')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    const botPhone = (sock.user?.id ?? '').split(':')[0].split('@')[0]
    // Neuere WhatsApp-Versionen verwenden LIDs statt Telefonnummern in Mentions
    const botLid = (sock.authState.creds.me?.lid ?? '').split(':')[0].split('@')[0]

    for (const msg of messages) {
      if (msg.key.fromMe) continue

      const jid = msg.key.remoteJid ?? ''
      const isGroup = jid.endsWith('@g.us')
      if (isGroup && GROUP_JID && jid !== GROUP_JID) continue

      const text = getMessageText(msg)
      if (!text) continue

      const mentionedJids =
        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? []
      const isMentioned =
        botPhone !== '' &&
        mentionedJids.some(j => {
          const num = j.split('@')[0]
          return num === botPhone || (botLid !== '' && num === botLid)
        })

      let question: string | null = null

      if (text.toLowerCase().startsWith(TRIGGER)) {
        question = text.slice(TRIGGER.length).trim()
      } else if (isMentioned) {
        question = text.replace(/@\d+/g, '').trim()
      }

      if (!question) continue

      console.log(`❓ [${jid}] ${question}`)

      // Beide Calls parallel starten — Acknowledge kommt zuerst, Chat danach
      const acknowledgePromise = fetchAcknowledge(question)
      const chatPromise = fetchChat(question)

      try {
        const ack = await acknowledgePromise
        await sock.sendMessage(jid, { text: ack }, { quoted: msg })
        console.log('⏳ Überbrückungsantwort gesendet')
      } catch (err) {
        console.error('Fehler beim Acknowledge-Endpoint:', err)
      }

      try {
        const reply = await chatPromise
        await sock.sendMessage(jid, { text: reply }, { quoted: msg })
        console.log('✅ Vollantwort gesendet')
      } catch (err) {
        console.error('Fehler beim Query-Service:', err)
        await sock.sendMessage(
          jid,
          { text: '⚠️ Fehler beim Abrufen der Lore. Bitte versuch es erneut.' },
          { quoted: msg },
        )
      }
    }
  })
}

startBot()
