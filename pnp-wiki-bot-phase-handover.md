# PnP-Lore-Wiki — Bot-Phase: Umsetzungsrichtlinie & Handover

> Selbstständiges Handover-Dokument für die nächste Projektphase. Es enthält einen
> Projektüberblick für frischen Kontext und eine geordnete Umsetzungsrichtlinie.
> Ergänzt das bestehende `pnp-wiki-projekt-uebergabe.md` (Wiki/Deploy-Details) und
> die `CLAUDE.md` des Lore-Repos (Wiki-Schema).

---

## 1. Projektüberblick (Kurzfassung)

Eine Pathfinder-2e-Pen&Paper-Gruppe schreibt nach jedem Spielabend
Zusammenfassungen. Daraus pflegt Claude (nach Karpathys „LLM-Wiki"-Pattern, Regeln
in `CLAUDE.md`) ein strukturiertes, verlinktes **Lore-Wiki** aus Markdown-Dateien.
Ein **Git-Repo ist die einzige Wahrheit**; alles andere sind Ansichten darauf.

Bereits fertig:
- **Lore-Wiki** (`raw/` = Spielberichte, `wiki/` = strukturierte Lore).
- **Webseite** mit Quartz v5 unter `https://wiki.pnp-utils.de` — Suche, Backlinks,
  Graph, Bilder. Deploy per `deploy-wiki.sh` (git pull → Inhalte spiegeln → bauen →
  rsync nach Webroot). Hinter nginx mit Basic-Auth.
- **Query-Service** (`/opt/pnp-wiki/query-service/`) — läuft als Docker-Container,
  beantwortet Lore-Fragen per `POST /api/chat`. ✅

Ziel dieser Phase: **Die Wiki per natürlicher Sprache abfragbar machen** — über
einen WhatsApp-Bot in der Gruppe und (fast geschenkt) ein Chat-Widget auf der
Webseite. Beispiel-Frage: „Wie hieß der Gegner vom letzten Abend und was wissen
wir über ihn?" → Antwort aus dem Wiki plus Links auf die passenden Seiten.

---

## 2. Architektur-Leitidee: ein Gehirn, mehrere Frontends

Der Kern ist **ein Query-Service**, der den Anthropic-API-Key hält, die relevanten
Wiki-Inhalte sammelt, Claude aufruft und Antwort + Quell-Links zurückgibt. Alle
Zugänge sind dünne Aufsätze darauf:

```
                 ┌──────────────────────────────┐
                 │   Query-Service (Node/TS)     │
                 │   - liest /opt/pnp-wiki/repo  │
                 │   - hält ANTHROPIC_API_KEY    │
   Frage ───────▶│   - Retrieval + Claude-Aufruf │──────▶ Antwort + Quell-Links
                 │   - HTTP: POST /api/chat      │
                 └──────────────────────────────┘
                    ▲            ▲            ▲
                    │            │            │
            CLI-Testskript   WhatsApp-     Web-Chat-Widget
            (✅ fertig)      Adapter       (Quartz-Komponente,
                             (Baileys)      ruft /api/chat)
```

**Warum so:** Retrieval-Logik, Prompt und Link-Erzeugung existieren genau einmal.
WhatsApp und Web-Chat unterscheiden sich nur im Transport. Deshalb wird die
Query-Pipeline gleich als **kleiner HTTP-Service** gebaut, nicht als Wegwerf-CLI.

### Kritische Randbedingung
Quartz ist eine **statische** Seite. Der API-Key darf **niemals** in Browser-JS
landen (sonst lesbar → fremde Kosten). Deshalb der Server-Endpunkt `/api/chat`:
Das Widget ruft nur diesen, der Key bleibt serverseitig.

---

## 3. Server-Kontext (Wiederholung des Relevanten)

- DigitalOcean-Droplet (Hostname `ubuntu-s-foundry`, Ubuntu 20.04), darauf laufen
  FoundryVTT, nginx (Reverse-Proxy, SSL, Basic-Auth), die Quartz-Seite und der
  Query-Service als Docker-Container.
- **Geteilter Checkout:** `/opt/pnp-wiki/repo` enthält das Lore-Repo. Der
  Query-Service liest `repo/wiki/*.md` als read-only Docker-Volume. Nach `git pull`
  (im Deploy) sind die Inhalte beim nächsten Request automatisch frisch.
- nginx terminiert TLS für `wiki.pnp-utils.de` und schützt alles per Basic-Auth.
- Swap ist eingerichtet (gegen OOM beim Build).
- Docker: installiert via `apt install docker.io` + standalone `docker-compose`
  unter `/usr/local/bin/docker-compose`.

### Verzeichnisstruktur auf dem Server
```
/opt/pnp-wiki/
  repo/                      # Lore-Repo — Quelle für Wiki UND Query-Service
  quartz/                    # Quartz-Projekt
  query-service/             # ✅ Repo: github.com/DonDozone/pathfinder-chat
  whatsapp-bot/              # 🔜 Repo: github.com/DonDozone/pathfinder-whatsapp
```

---

## 4. Technische Entscheidungen (getroffen)

- **Sprache/Runtime:** TypeScript/Node, `tsx` als Runtime (kein Compile-Schritt).
- **Anthropic-SDK:** `@anthropic-ai/sdk`, `client.messages.create` mit Tool-Use.
- **Modell:** `claude-haiku-4-5` (Standard), per `MODEL`-Env-Var wechselbar auf
  `claude-sonnet-4-6`. Modell-IDs ohne Datums-Suffix verwenden.
- **Retrieval — Tool-Use:** Die Wiki war zu groß für einen einzelnen Kontext-Call
  (~209k Tokens > 200k Limit von Haiku). Gewählte Lösung: Claude bekommt nur eine
  Seitenliste (Slug + Titel) und ein `fetch_page(slug)`-Tool. Es ruft gezielt die
  relevanten Seiten ab. Skaliert unbegrenzt, kein RAG nötig.
- **HTTP-Framework:** Hono (leichtgewichtig, gute TS-Unterstützung).
- **Quell-Links:** Claude nennt am Ende seiner Antwort `QUELLEN: slug1, slug2`.
  Der Service parst diese Zeile und baut `https://wiki.pnp-utils.de/<slug>`-URLs.
- **`pageSlug`-Kontext:** `POST /api/chat` akzeptiert optional `pageSlug` — die
  Seite, die der Nutzer gerade betrachtet. Wird als Kontext-Hint an Claude übergeben
  (für das spätere Web-Widget).
- **Inhalts-Aktualität:** Service liest Markdown-Dateien per Request vom Volume.
  Nach `git pull` im Deploy sofort aktuelle Inhalte — kein Restart nötig.

---

## 5. Sicherheit & Kostenkontrolle

- **API-Key nur serverseitig** (Env-Var `ANTHROPIC_API_KEY`, nie ins Repo, nie in
  Client-JS). `.env` in `.gitignore`.
- **Basic-Auth schützt `/api/` automatisch mit**, da serverweit gesetzt → nur die
  Gruppe kann Anfragen stellen.
- **nginx-Rate-Limit auf `/api/`:** `limit_req_zone` mit `rate=10r/m`, `burst=5`.
- **`max_tokens: 2048`** pro Anfrage; Tool-Use-Loop max. 20 Turns.
- **WhatsApp-Graubereich:** Bots in Gruppen sind offiziell nicht unterstützt; der
  Weg über eine Zweitnummer + Baileys ist ToS-Graubereich mit theoretischem
  Ban-Risiko für die Nummer. Für eine private Gruppe bewusst akzeptiert. Bot nur
  auf expliziten Trigger reagieren lassen (leise bleiben).

---

## 6. Umsetzungsschritte in Reihenfolge

### ✅ Phase 1 — Query-Service-Kern + CLI-Test
Repo: `github.com/DonDozone/pathfinder-chat`

Umgesetzt:
- `src/config.ts` — Env-Vars (API-Key, MODEL, WIKI_PATH, BASE_URL, PORT)
- `src/wiki.ts` — rekursives Laden aller `wiki/**/*.md`, Slug/Titel/URL-Mapping
- `src/prompt.ts` — Deutscher System-Prompt + `buildUserPrompt()`
- `src/answer.ts` — `answer(question, pageSlug?) → { text, sources[] }` mit
  Tool-Use-Loop (max. 20 Turns, Fallback auf letzten produzierten Text)
- `src/cli.ts` — `npm run ask -- "Frage"`

Antwortqualität mit echten Gruppenfragen validiert. ✅

### ✅ Phase 2 — HTTP-Service + Docker + nginx
Umgesetzt:
- `src/http.ts` — Hono: `POST /api/chat`, `GET /api/health`
- `Dockerfile` + `docker-compose.yml` (Port nur auf `127.0.0.1:3000`, Wiki als
  read-only Volume `/wiki`, `restart: unless-stopped`)
- nginx-Snippet in `wiki.pnp-utils.de.conf` (Rate-Limit + Proxy auf Port 3000)
- Docker installiert auf Server (`docker.io` + standalone `docker-compose`)
- Lokal per `curl` auf dem Server getestet ✅

**Noch offen:** nginx-Proxy aktivieren (Snippet eintragen, `nginx -t && systemctl
reload nginx`), dann von außen per Basic-Auth testen.

nginx-Snippet zur Erinnerung:
```nginx
# Im http{}-Block (einmalig):
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/m;

# Im server{}-Block von wiki.pnp-utils.de:
location /api/ {
    limit_req zone=api burst=5 nodelay;
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

### 🔜 Phase 3 — WhatsApp-Adapter (Baileys)
Neues Repo: `pathfinder-whatsapp` → `/opt/pnp-wiki/whatsapp-bot/`

Projektstruktur:
```
pathfinder-whatsapp/
  src/
    index.ts       # Baileys-Loop, Trigger-Logik, API-Call
  auth/            # Login-State (QR beim Erststart) — im .gitignore!
  package.json
  .env             # Nur QUERY_SERVICE_URL + evtl. GROUP_JID
  .env.example
  Dockerfile
  docker-compose.yml
```

Umsetzung:
1. Prepaid-Nummer als WhatsApp-Account registrieren, in die Gruppe einladen.
2. Baileys (`@whiskeysockets/baileys`): `useMultiFileAuthState('auth/')`,
   QR beim ersten Start in der Konsole anzeigen, danach persistent.
3. Auf Gruppennachrichten lauschen, **nur auf Trigger** reagieren (`!lore …`
   oder Mention) — alles andere ignorieren.
4. Bei Trigger: `POST http://localhost:3000/api/chat { question }`,
   Antwort-Text + URLs als WhatsApp-Nachricht zurück in die Gruppe.
5. `restart: unless-stopped`, Reconnect-Handling in Baileys eingebaut.

Der Bot braucht **keinen Anthropic-API-Key** — er redet nur mit dem Query-Service.

**Akzeptanzkriterium:** `!lore`-Frage in der Gruppe wird beantwortet, Links
funktionieren; ohne Trigger bleibt der Bot still.

### Phase 4 — Web-Chat-Widget (Quartz-Custom-Component)
1. Eigene Quartz-Komponente (schwebender Button + Panel unten rechts), ins Layout
   einklinken (upstream-sichere Custom-Component, Client-Script für Fetch/UI).
2. Schickt Frage + aktuellen `pageSlug` an `/api/chat` (mit Basic-Auth-Header),
   rendert Antwort + klickbare Quell-Links.
3. **Seitenbewusster Kontext:** Auf der NPC-Seite startet der Chat mit dieser Seite
   im Kontext („Was wissen wir über sie?" ohne Namen zu tippen).

**Akzeptanzkriterium:** Chat-Box auf der Seite beantwortet Fragen, nutzt den
Seitenkontext, verlinkt Quellen.

### Phase 5 — Politur (optional, nach Bedarf)
- Streaming der Antwort (gefühlte Latenz).
- `[Znn]`-Tags global zu Links machen (Quartz-Transform).
- Einfaches Logging/Kostenzähler.

---

## 7. Referenzdokumente

- `pnp-wiki-projekt-uebergabe.md` — Wiki-/Deploy-Details, nginx-Conf, Server-Setup.
- `CLAUDE.md` (im Lore-Repo) — Wiki-Schema, „Frage beantworten"-Workflow
  (Vorlage für den System-Prompt des Services).
- Anthropic-API-Docs: https://docs.claude.com/en/api/overview
