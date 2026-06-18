import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WAMessage,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import dotenv from 'dotenv'

dotenv.config()

const QUERY_SERVICE_URL = process.env.QUERY_SERVICE_URL ?? 'http://localhost:3000'
const GROUP_JID = process.env.GROUP_JID // optional: nur auf diese Gruppe reagieren

const TRIGGER = '!lore '

const logger = pino({ level: 'silent' })

function getMessageText(msg: WAMessage): string | null {
  const m = msg.message
  if (!m) return null
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    null
  )
}

interface QueryResponse {
  text: string
  sources: string[]
}

async function queryWiki(question: string): Promise<string> {
  const res = await fetch(`${QUERY_SERVICE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  })

  if (!res.ok) {
    throw new Error(`Query-Service antwortet mit HTTP ${res.status}`)
  }

  const data = (await res.json()) as QueryResponse
  let reply = data.text

  if (data.sources.length > 0) {
    reply += '\n\n🔗 ' + data.sources.join('\n🔗 ')
  }

  return reply
}

async function startBot(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
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

    for (const msg of messages) {
      if (msg.key.fromMe) continue

      const jid = msg.key.remoteJid ?? ''
      if (!jid.endsWith('@g.us')) continue // nur Gruppen-Chats
      if (GROUP_JID && jid !== GROUP_JID) continue // optionaler Gruppen-Filter

      const text = getMessageText(msg)
      if (!text) continue
      if (!text.toLowerCase().startsWith(TRIGGER)) continue

      const question = text.slice(TRIGGER.length).trim()
      if (!question) continue

      console.log(`❓ [${jid}] ${question}`)

      try {
        const reply = await queryWiki(question)
        await sock.sendMessage(jid, { text: reply }, { quoted: msg })
        console.log('✅ Antwort gesendet')
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
