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
const NOTIFY_URL = process.env.NOTIFY_URL
const HEARTBEAT_URL = process.env.HEARTBEAT_URL

const TRIGGER = '!wiki '
const ALERT_COOLDOWN_MS = 15 * 60_000
const HEARTBEAT_INTERVAL_MS = 5 * 60_000

// Disconnect-Codes, bei denen die Session tot ist und ein neuer QR-Scan ansteht.
const FATAL_DISCONNECTS: Record<number, string> = {
  [DisconnectReason.loggedOut]: 'Abgemeldet',
  [DisconnectReason.forbidden]: 'Zugriff verweigert',
  [DisconnectReason.badSession]: 'Session defekt',
  [DisconnectReason.connectionReplaced]: 'Session uebernommen',
}

const FIX_HINT =
  'Auf dem Droplet: cd /opt/pnp-wiki/whatsapp-bot && docker-compose logs -f — ' +
  'QR-Code neu scannen.'

const logger = pino({ level: 'silent' })

// Baileys loggt libsignal-Entschlüsselungsfehler direkt via console.error —
// diese sind harmlos (alte Sessions anderer Geräte) und verstecken echte Fehler.
const _origError = console.error
console.error = (...args: unknown[]) => {
  const msg = String(args[0] ?? '')
  if (msg.includes('Bad MAC') || msg.includes('Failed to decrypt')) return
  _origError(...args)
}

let lastAlertAt = 0

// Push-Benachrichtigung im ntfy.sh-Format. Bewusst nicht über WhatsApp selbst —
// im Alarmfall ist genau dieser Kanal ja kaputt.
// ntfy erwartet ASCII in den Headern, daher Titel ohne Umlaute und Emoji.
async function alert(title: string, body: string): Promise<void> {
  console.log(`🚨 ${title} — ${body}`)
  if (!NOTIFY_URL) return
  // Baileys wiederholt QR- und Disconnect-Events im Sekundentakt; ohne Cooldown
  // würde daraus eine Benachrichtigungslawine.
  if (Date.now() - lastAlertAt < ALERT_COOLDOWN_MS) return
  lastAlertAt = Date.now()

  try {
    await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: { Title: title, Priority: 'high', Tags: 'warning' },
      body,
    })
  } catch (err) {
    _origError('Benachrichtigung fehlgeschlagen:', err)
  }
}

let heartbeatTimer: NodeJS.Timeout | null = null

// Dead-man's switch: gepingt wird nur, solange die Verbindung wirklich steht.
// Bleibt der Ping aus (Container tot, Prozess hängt, Auth weg), schlägt der
// externe Dienst von sich aus Alarm — unabhängig davon, ob dieser Prozess lebt.
function startHeartbeat(): void {
  stopHeartbeat()
  if (!HEARTBEAT_URL) return

  const ping = () => {
    fetch(HEARTBEAT_URL).catch(err => _origError('Heartbeat fehlgeschlagen:', err))
  }
  ping()
  heartbeatTimer = setInterval(ping, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat(): void {
  if (!heartbeatTimer) return
  clearInterval(heartbeatTimer)
  heartbeatTimer = null
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

interface QueryResponse {
  text: string
  sources: unknown[]
}

async function queryWiki(question: string): Promise<string> {
  const res = await fetch(`${QUERY_SERVICE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  })

  if (!res.ok) throw new Error(`Query-Service antwortet mit HTTP ${res.status}`)

  const data = (await res.json()) as QueryResponse
  const text = mdToWhatsApp(data.text)
  const sourcesBlock = formatSources(data.sources)

  return sourcesBlock ? `${text}\n\n${sourcesBlock}` : text
}

async function startBot(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const wasRegistered = state.creds.registered
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({ version, auth: state, logger })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrcode.generate(qr, { small: true })
      console.log('QR-Code erschienen — bitte mit der Prepaid-Nummer scannen')
      // Ein QR-Code trotz bereits registrierter Credentials heißt immer: die
      // Session ist ungültig. Das ist der breiteste Detektor, weil jede Form
      // von kaputter Auth hier landet — egal aus welchem Grund.
      if (wasRegistered) {
        alert(
          'WhatsApp-Bot: Neuer QR-Code',
          `Die Session ist ungueltig, der Bot verlangt eine neue Verknuepfung. ${FIX_HINT}`,
        )
      }
    }
    if (connection === 'close') {
      stopHeartbeat()
      const code = (lastDisconnect?.error as Boom)?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      console.log(`Verbindung getrennt (Code ${code}) — Neustart: ${shouldReconnect}`)

      const reason = FATAL_DISCONNECTS[code as number]
      if (reason) {
        alert(
          `WhatsApp-Bot: ${reason}`,
          `Verbindung getrennt (Code ${code}). Die Session muss vermutlich neu ` +
            `verknuepft werden. ${FIX_HINT}`,
        )
      }

      if (shouldReconnect) startBot()
    } else if (connection === 'open') {
      console.log('✅ WhatsApp-Bot verbunden')
      startHeartbeat()
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
