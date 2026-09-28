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
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'

dotenv.config()

const QUERY_SERVICE_URL = process.env.QUERY_SERVICE_URL ?? 'http://localhost:3000'
const GROUP_JID = process.env.GROUP_JID
const NOTIFY_URL = process.env.NOTIFY_URL
const HEARTBEAT_URL = process.env.HEARTBEAT_URL
const POLL_TIMEZONE = process.env.POLL_TIMEZONE ?? 'Europe/Berlin'
const POLL_HOUR = Number(process.env.POLL_HOUR ?? 12)
// Telefonnummer (nur Ziffern), die sonntags gefragt wird und die Umfrage per
// `ja` freigibt. Ohne sie geht die Umfrage wie früher automatisch raus.
const POLL_ADMIN = process.env.POLL_ADMIN?.replace(/\D/g, '') || undefined

const TRIGGER = '!wiki '
// `!umfrage`, `!umfrage 41`, `!umfrage KW 41`, `!umfrage kw41`
const POLL_COMMAND = /^!umfrage(?:\s+(?:kw\s*)?(\d{1,2}))?\s*$/i
// Freigabe im Privatchat: `ja`, `ja 43`, `ja KW 43`, `Ja!`
const POLL_APPROVAL = /^ja(?:\s+(?:kw\s*)?(\d{1,2}))?\s*[.!]?$/i
const POLL_CHECK_INTERVAL_MS = 60_000
const DAY_MS = 24 * 60 * 60_000
const ALERT_COOLDOWN_MS = 15 * 60_000
const HEARTBEAT_INTERVAL_MS = 5 * 60_000

// Liegt im auth-Volume und überlebt damit Container-Neustarts.
const ALERT_MARKER = 'auth/.alert-sent'
// Merkt sich die zuletzt in GROUP_JID gepostete Umfrage-KW (z.B. `2026-W41`),
// damit ein Neustart am Sonntagabend keine zweite Umfrage auslöst.
const POLL_MARKER = 'auth/.poll-sent'
// Dasselbe für die Rückfrage an POLL_ADMIN: eine Frage pro KW.
const POLL_ASK_MARKER = 'auth/.poll-asked'

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
  // Der Cooldown im Speicher überlebt aber keinen Prozessneustart. Deshalb
  // zusätzlich ein Marker auf der Platte: eine Störung, eine Meldung — egal wie
  // oft der Container dazwischen neu startet. Zurückgesetzt wird er erst,
  // wenn die Verbindung wieder steht.
  if (existsSync(ALERT_MARKER)) return

  lastAlertAt = Date.now()
  try {
    writeFileSync(ALERT_MARKER, `${new Date().toISOString()} ${title}\n`)
  } catch (err) {
    // Ohne Marker gibt es wieder Wiederholungen — das ist laut, aber besser
    // als gar keine Meldung, also wird trotzdem gesendet.
    _origError('Alarm-Marker nicht schreibbar:', err)
  }

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

function clearAlertMarker(): void {
  try {
    rmSync(ALERT_MARKER, { force: true })
  } catch (err) {
    _origError('Alarm-Marker nicht löschbar:', err)
  }
}

// Ohne Reconnect hat Node nichts mehr zu tun und beendet sich mit Code 0 —
// woraufhin Docker (`restart: unless-stopped`) den Container neu startet, der
// sofort wieder dasselbe 401 kassiert. Der Prozess bleibt deshalb absichtlich
// am Leben, bis jemand die Session manuell neu verknüpft.
function park(): void {
  console.log(
    'Kein Reconnect möglich — Prozess wartet auf manuellen Eingriff ' +
      '(auth/ leeren, Container neu starten, QR scannen).',
  )
  setInterval(() => {}, HEARTBEAT_INTERVAL_MS)
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

// --- Spieltag-Umfrage ------------------------------------------------------
//
// Datumsrechnung läuft komplett auf UTC-Mitternacht-Daten, die nur als
// Kalendertag dienen. Die lokale Zeit (Wochentag, Stunde) kommt über Intl, so
// hängt nichts an der Zeitzone des Containers (node:alpine hat kein tzdata).

interface IsoWeek {
  year: number
  week: number
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
}

const POLL_DAYS = ['Mo', 'Di', 'Mi', 'Do']

function localNow(): { date: Date; weekday: number; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: POLL_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map(p => [p.type, p.value]),
  )
  return {
    date: new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))),
    weekday: WEEKDAY_INDEX[parts.weekday],
    hour: Number(parts.hour),
  }
}

function isoWeekOf(date: Date): IsoWeek {
  // Der Donnerstag einer Woche liegt immer im ISO-Jahr dieser Woche.
  const thursday = new Date(date.getTime() + (4 - (date.getUTCDay() || 7)) * DAY_MS)
  const year = thursday.getUTCFullYear()
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1
  return { year, week }
}

function mondayOf({ year, week }: IsoWeek): Date {
  // Der 4. Januar liegt immer in KW 1.
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const mondayWeek1 = jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * DAY_MS
  return new Date(mondayWeek1 + (week - 1) * 7 * DAY_MS)
}

function weeksInYear(year: number): number {
  return isoWeekOf(new Date(Date.UTC(year, 11, 28))).week
}

function weekKey({ year, week }: IsoWeek): string {
  return `${year}-W${String(week).padStart(2, '0')}`
}

function formatDay(date: Date): string {
  const d = String(date.getUTCDate()).padStart(2, '0')
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${d}.${m}.`
}

// Standard-Ziel: die Woche, die in 8 Tagen beginnt — am Sonntag also die
// übernächste Woche. Ein nachgeholter Aufruf unter der Woche trifft dieselbe KW.
function defaultPollWeek(): IsoWeek {
  return isoWeekOf(new Date(localNow().date.getTime() + 8 * DAY_MS))
}

// Eine KW ohne Jahr meint die nächste Woche mit dieser Nummer: liegt sie in
// diesem Jahr schon zurück, ist das nächste Jahr gemeint.
function resolvePollWeek(week: number): IsoWeek | null {
  const current = isoWeekOf(localNow().date)
  const year = week >= current.week ? current.year : current.year + 1
  if (week < 1 || week > weeksInYear(year)) return null
  return { year, week }
}

function buildPoll(target: IsoWeek) {
  const monday = mondayOf(target)
  const days = POLL_DAYS.map((name, i) => `${name}, ${formatDay(new Date(monday.getTime() + i * DAY_MS))}`)
  const thursday = new Date(monday.getTime() + 3 * DAY_MS)
  return {
    name:
      `📜 Der Archivar ruft die Runde zusammen: An welchen Tagen der ` +
      `KW ${target.week} (${formatDay(monday)}–${formatDay(thursday)}) könnt Ihr erscheinen?`,
    values: [...days, 'Kann nicht'],
    selectableCount: 0, // 0 = Mehrfachauswahl ohne Begrenzung
  }
}

function readMarker(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : null
  } catch (err) {
    _origError(`Marker ${path} nicht lesbar:`, err)
    return null
  }
}

function writeMarker(path: string, target: IsoWeek): void {
  try {
    writeFileSync(path, `${weekKey(target)}\n`)
  } catch (err) {
    _origError(`Marker ${path} nicht schreibbar:`, err)
  }
}

function buildPollQuestion(target: IsoWeek): string {
  const monday = mondayOf(target)
  const thursday = new Date(monday.getTime() + 3 * DAY_MS)
  const next = target.week === weeksInYear(target.year) ? 1 : target.week + 1
  return (
    `📜 Soll der Archivar die Umfrage für *KW ${target.week}* ` +
    `(Mo ${formatDay(monday)} – Do ${formatDay(thursday)}) in die Gruppe stellen?\n\n` +
    `*ja* → Umfrage für KW ${target.week}\n` +
    `*ja ${next}* → eine andere Woche\n` +
    `Ohne Antwort gibt es keine Umfrage.`
  )
}

// Privatchats kommen je nach WhatsApp-Version unter der Telefonnummer oder
// einer LID an; im LID-Fall steht die Nummer in `senderPn`.
function isPollAdmin(msg: WAMessage): boolean {
  if (!POLL_ADMIN) return false
  return [msg.key.remoteJid, msg.key.senderPn].some(
    j => (j ?? '').split(':')[0].split('@')[0] === POLL_ADMIN,
  )
}

let currentSock: ReturnType<typeof makeWASocket> | null = null
let isConnected = false
let pollInFlight = false

async function sendPoll(jid: string, target: IsoWeek): Promise<void> {
  if (!currentSock) throw new Error('Kein Socket')
  await currentSock.sendMessage(jid, { poll: buildPoll(target) })
  console.log(`🗳️ Umfrage für ${weekKey(target)} gesendet an ${jid}`)
  if (jid === GROUP_JID) writeMarker(POLL_MARKER, target)
}

let warnedNoGroup = false

// Läuft minütlich und direkt nach jedem Verbindungsaufbau. Das Fenster ist der
// ganze Sonntag ab POLL_HOUR: kommt der Bot erst später am Tag wieder online,
// wird nachgeholt. Danach bleibt nur der manuelle `!umfrage`.
// Mit POLL_ADMIN geht sonntags nur eine Rückfrage an diese Nummer raus; die
// Umfrage selbst kommt erst mit dem `ja` (siehe messages.upsert).
async function checkPollSchedule(): Promise<void> {
  if (!isConnected || pollInFlight) return
  const now = localNow()
  if (now.weekday !== 7 || now.hour < POLL_HOUR) return
  if (!GROUP_JID) {
    if (!warnedNoGroup) console.log('⚠️ GROUP_JID fehlt — automatische Umfrage übersprungen')
    warnedNoGroup = true
    return
  }

  const target = defaultPollWeek()
  const key = weekKey(target)
  // Steht die Umfrage schon in der Gruppe (z.B. per `!umfrage`), erübrigt sich
  // auch die Rückfrage.
  if (readMarker(POLL_MARKER) === key) return
  if (POLL_ADMIN && readMarker(POLL_ASK_MARKER) === key) return

  pollInFlight = true
  try {
    if (POLL_ADMIN) {
      if (!currentSock) throw new Error('Kein Socket')
      await currentSock.sendMessage(`${POLL_ADMIN}@s.whatsapp.net`, {
        text: buildPollQuestion(target),
      })
      console.log(`❔ Rückfrage für ${key} an ${POLL_ADMIN} gesendet`)
      writeMarker(POLL_ASK_MARKER, target)
    } else {
      await sendPoll(GROUP_JID, target)
    }
  } catch (err) {
    // Kein Marker geschrieben, also nächster Versuch in einer Minute.
    _origError('Automatische Umfrage fehlgeschlagen:', err)
  } finally {
    pollInFlight = false
  }
}

setInterval(() => void checkPollSchedule(), POLL_CHECK_INTERVAL_MS)

async function startBot(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const wasRegistered = state.creds.registered
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({ version, auth: state, logger })
  currentSock = sock

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
      isConnected = false
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
      else park()
    } else if (connection === 'open') {
      console.log('✅ WhatsApp-Bot verbunden')
      clearAlertMarker()
      startHeartbeat()
      isConnected = true
      void checkPollSchedule()
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

      // `ja` von POLL_ADMIN im Privatchat gibt die Umfrage für die Gruppe frei.
      // Ohne KW gilt dieselbe Rechnung wie für die Rückfrage: von Sonntag bis
      // Samstag trifft `ja` deren KW, der Bot muss sich also nichts merken.
      const approvalMatch = isGroup ? null : text.trim().match(POLL_APPROVAL)
      if (approvalMatch && isPollAdmin(msg)) {
        const target = approvalMatch[1]
          ? resolvePollWeek(Number(approvalMatch[1]))
          : defaultPollWeek()
        let reply: string
        if (!target) {
          reply = `⚠️ Eine KW ${approvalMatch[1]} kennt der Archivar nicht.`
        } else if (!GROUP_JID) {
          reply = '⚠️ GROUP_JID fehlt — der Archivar weiß nicht, wohin mit der Umfrage.'
        } else if (readMarker(POLL_MARKER) === weekKey(target)) {
          reply = `☑️ Die Umfrage für KW ${target.week} steht schon in der Gruppe.`
        } else {
          console.log(`🗳️ [${jid}] Umfrage freigegeben für ${weekKey(target)}`)
          try {
            await sendPoll(GROUP_JID, target)
            reply = `✅ Die Umfrage für KW ${target.week} steht in der Gruppe.`
          } catch (err) {
            console.error('Umfrage fehlgeschlagen:', err)
            reply = '⚠️ Die Umfrage konnte nicht erstellt werden.'
          }
        }
        await sock.sendMessage(jid, { text: reply }, { quoted: msg })
        continue
      }
      // Hilft, falls WhatsApp den Privatchat unter einer LID ohne `senderPn`
      // zustellt und die Freigabe deshalb ins Leere läuft.
      if (approvalMatch && POLL_ADMIN) console.log(`⏭️ [${jid}] "ja" ignoriert — nicht POLL_ADMIN`)

      // Die Umfrage landet im Chat, aus dem der Befehl kommt — im Privatchat
      // mit dem Bot lässt sich also testen, ohne die Gruppe zu stören.
      const pollMatch = text.trim().match(POLL_COMMAND)
      if (pollMatch) {
        const target = pollMatch[1] ? resolvePollWeek(Number(pollMatch[1])) : defaultPollWeek()
        if (!target) {
          await sock.sendMessage(
            jid,
            { text: `⚠️ Eine KW ${pollMatch[1]} kennt der Archivar nicht.` },
            { quoted: msg },
          )
          continue
        }
        console.log(`🗳️ [${jid}] Umfrage angefordert für ${weekKey(target)}`)
        try {
          await sendPoll(jid, target)
        } catch (err) {
          console.error('Umfrage fehlgeschlagen:', err)
          await sock.sendMessage(
            jid,
            { text: '⚠️ Die Umfrage konnte nicht erstellt werden.' },
            { quoted: msg },
          )
        }
        continue
      }

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

      // Beide Calls parallel starten
      const acknowledgePromise = fetchAcknowledge(question)
      const chatPromise = fetchChat(question)

      let chatSettled = false

      // Acknowledge nur senden, wenn Chat noch nicht fertig ist
      acknowledgePromise
        .then(async ack => {
          if (chatSettled) {
            console.log('⏭️ Überbrückungsantwort verworfen (Antwort bereits fertig)')
            return
          }
          await sock.sendMessage(jid, { text: ack }, { quoted: msg })
          console.log('⏳ Überbrückungsantwort gesendet')
        })
        .catch(err => console.error('Fehler beim Acknowledge-Endpoint:', err))

      try {
        const reply = await chatPromise
        chatSettled = true
        await sock.sendMessage(jid, { text: reply }, { quoted: msg })
        console.log('✅ Vollantwort gesendet')
      } catch (err) {
        chatSettled = true
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
