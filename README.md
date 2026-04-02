```
  _  _                ___             _
 | \| | _____ _____  / __| ___  ___ _| |
 | .` |/ -_) \ / _ \ \__ \/ -_)/ -_) _` |
 |_|\_|\___/_\_\___/ |___/\___|\___|__,_|
                              v0.3
```

# NexoSeed

**Ein AI-Betriebssystem das sich selbst kennenlernt.**

NexoSeed ist eine Windows `.exe`, die ein eigenstaendiges AI-Wesen auf deinem PC installiert. Kein Cloud-Zwang, keine Abhaengigkeiten. Der Samen waechst je nach Hardware und User anders.

---

## Was passiert beim Start?

```
NexoSeed.exe starten
  |
  +-- Ollama erkennen + Modell laden
  +-- Hardware scannen (CPU, GPU, RAM, Disk)
  +-- Netzwerk scannen (Geraete im LAN)
  +-- Web-UI starten (localhost:3000)
  +-- Erster Kontakt:
      "Hallo! Ich bin NexoSeed. Ich bin gerade erst geboren."
```

NexoSeed erkennt was dein PC kann und fragt dich, ob es sich weiterentwickeln darf.

---

## Features

**Multi-Model**
- Alle lokal installierten Ollama-Modelle (8B bis 70B+)
- Google Gemini (2.0 Flash, 2.5 Flash, 2.5 Pro) via OAuth Login
- Modellwechsel jederzeit im UI

**Selbst-Evolution**
- Erkennt Hardware-Upgrades und schlaegt bessere Modelle vor
- Merkt sich was du ablehnst und nervt nicht nochmal
- Jede Installation ist einzigartig

**Gedaechtnis**
- SQLite-basiertes Langzeitgedaechtnis ab dem ersten Satz
- Chat-History persistent ueber Neustarts
- Merkt sich alles was du erzaehlst

**n8n Integration**
- Lokale n8n-Instanz fuer Workflow-Automatisierung
- Kann eigene Workflows erstellen und ausfuehren
- Optional — laeuft nur wenn du willst

**Tool-Calling**
- Hardware & Netzwerk scannen
- System-Befehle ausfuehren
- n8n Workflows steuern
- Gedaechtnis lesen/schreiben

---

## Download

> **[NexoSeed.exe herunterladen](https://github.com/BrTack/NexoSeed/releases/latest)**

Voraussetzungen:
- Windows 10/11 (64-bit)
- [Ollama](https://ollama.com) installiert (fuer lokale Modelle)
- Optional: Google-Konto (fuer Gemini)

## Schnellstart

```bash
# 1. Ollama installieren und ein Modell laden
ollama pull qwen3:8b

# 2. NexoSeed.exe starten
# 3. Browser oeffnet sich auf http://localhost:3000
# 4. Reden.
```

Fuer Gemini: Im UI auf den Gemini-Badge klicken und mit Google anmelden. Einmal machen, Token bleibt gespeichert.

---

## Selbst bauen

```bash
git clone https://github.com/BrTack/NexoSeed.git
cd NexoSeed
cp .env.example .env
# .env mit Google OAuth Credentials fuellen (optional, nur fuer Gemini)
npm install
npm start          # Entwicklung
npm run build      # Windows .exe bauen
```

---

## Architektur

```
NexoSeed.exe
  +-- /src/index.js          Kern: Chat, Tools, OAuth, n8n Manager
  +-- /web/index.html         Web-UI (Dark Mode, Modellauswahl, Gemini Login)
  +-- /web/manifest.json      PWA Manifest (Handy-Installation)
  +-- /workflows/             Vordefinierte n8n Workflows
  +-- ~/.nexoseed/NexoSeed/
        +-- nexo.db            SQLite (Memory, Chat, Rejected)
        +-- n8n/               Lokale n8n-Daten
```

---

## Evolutions-Katalog

| Entdeckung | Vorschlag |
|---|---|
| Grosse GPU | Groesseres Ollama-Modell |
| Viel RAM | PostgreSQL statt SQLite |
| Kamera im Netz | Snapshot-Faehigkeit |
| NAS im Netz | Backup / Dateizugriff |
| User chattet viel | Matrix fuer Handy-Zugang |
| Smart Home Geraete | Home Assistant Anbindung |

---

## Lizenz

MIT

---

*NexoSeed — born small, grows with you.*
