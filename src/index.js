#!/usr/bin/env node
/**
 * NexoSeed v0.3 — Self-evolving AI OS
 * Multi-Model: Ollama (local) + Gemini (Google OAuth)
 * n8n integration, tool-calling, persistent memory.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const fs = require("fs");
const { execSync, spawn } = require("child_process");
const express = require("express");
const Database = require("better-sqlite3");
const os = require("os");
const crypto = require("crypto");
const http = require("http");

// --- Config ---
const DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), ".nexoseed"), "NexoSeed");
const DB_PATH = path.join(DATA_DIR, "nexo.db");
const N8N_DATA_DIR = path.join(DATA_DIR, "n8n");
const PORT = process.env.NEXO_PORT || 3000;
const N8N_PORT = process.env.N8N_PORT || 5679;
const N8N_URL = `http://localhost:${N8N_PORT}`;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const IS_WIN = process.platform === "win32";

// Google OAuth Config — loaded from env or defaults (Gemini CLI public client)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const OAUTH_REDIRECT_PORT = parseInt(process.env.OAUTH_REDIRECT_PORT) || 39587;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_REDIRECT_PORT}/oauth/callback`;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";

// --- Init ---
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(N8N_DATA_DIR, { recursive: true });

// --- Database ---
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mem ON memory(type, key);

  CREATE TABLE IF NOT EXISTS chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_name TEXT,
    tool_args TEXT,
    model TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rejected (
    id TEXT PRIMARY KEY, rejected_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Add model column if missing (upgrade from v0.2)
try { db.exec("ALTER TABLE chat ADD COLUMN model TEXT"); } catch {}

const mem = {
  set: db.prepare("INSERT INTO memory(type,key,value) VALUES(?,?,?) ON CONFLICT(type,key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP"),
  get: db.prepare("SELECT value FROM memory WHERE type=? AND key=?").pluck(),
  all: db.prepare("SELECT type,key,value FROM memory ORDER BY type,key"),
  allByType: db.prepare("SELECT key,value FROM memory WHERE type=? ORDER BY key"),
  count: db.prepare("SELECT COUNT(*) FROM memory").pluck(),
  search: db.prepare("SELECT type,key,value FROM memory WHERE value LIKE ?"),
  del: db.prepare("DELETE FROM memory WHERE type=? AND key=?"),
};
const chatDb = {
  add: db.prepare("INSERT INTO chat(role,content,tool_name,tool_args,model) VALUES(?,?,?,?,?)"),
  recent: db.prepare("SELECT role,content,tool_name,tool_args,model FROM chat ORDER BY id DESC LIMIT ?"),
  count: db.prepare("SELECT COUNT(*) FROM chat").pluck(),
  all: db.prepare("SELECT id,role,content,tool_name,tool_args,model,created_at FROM chat ORDER BY id"),
  since: db.prepare("SELECT id,role,content,model,created_at FROM chat WHERE id > ? ORDER BY id"),
};
const rej = {
  check: db.prepare("SELECT 1 FROM rejected WHERE id=?").pluck(),
  add: db.prepare("INSERT OR IGNORE INTO rejected(id) VALUES(?)"),
};

// --- Shell helpers ---
function run(cmd) {
  try { return execSync(cmd, { encoding: "utf8", timeout: 15000, windowsHide: true, shell: true }).trim(); }
  catch { return null; }
}
function ps(cmd) { return IS_WIN ? run(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`) : null; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================
// Gemini OAuth Manager
// ============================
class GeminiAuth {
  constructor() {
    this.accessToken = null;
    this.refreshToken = null;
    this.expiryDate = 0;
    this.email = null;
    this._oauthServer = null;
    this._pendingAuth = null;
    this.load();
  }

  load() {
    const saved = mem.get.run("gemini", "oauth_creds");
    if (saved) {
      try {
        const creds = JSON.parse(saved);
        this.accessToken = creds.access_token;
        this.refreshToken = creds.refresh_token;
        this.expiryDate = creds.expiry_date || 0;
        this.email = creds.email || null;
        return true;
      } catch {}
    }
    return false;
  }

  save() {
    mem.set.run("gemini", "oauth_creds", JSON.stringify({
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      expiry_date: this.expiryDate,
      email: this.email,
    }));
  }

  get isLoggedIn() {
    return !!this.refreshToken;
  }

  get isExpired() {
    return Date.now() > (this.expiryDate - 60000);
  }

  async getValidToken() {
    if (!this.refreshToken) return null;
    if (this.isExpired) {
      const ok = await this.refresh();
      if (!ok) return null;
    }
    return this.accessToken;
  }

  async refresh() {
    if (!this.refreshToken) return false;
    try {
      const body = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      });
      const r = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        console.log("[gemini] Token-Refresh fehlgeschlagen:", r.status);
        return false;
      }
      const data = await r.json();
      this.accessToken = data.access_token;
      this.expiryDate = Date.now() + (data.expires_in || 3600) * 1000;
      this.save();
      console.log("[gemini] Token refreshed");
      return true;
    } catch (e) {
      console.log("[gemini] Refresh-Fehler:", e.message);
      return false;
    }
  }

  // Start OAuth callback server — waits for Google redirect
  startLogin() {
    return new Promise((resolve, reject) => {
      if (this._oauthServer) {
        try { this._oauthServer.close(); } catch {}
      }

      this._oauthServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${OAUTH_REDIRECT_PORT}`);
        if (url.pathname !== "/oauth/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const savedState = mem.get.run("gemini", "oauth_state");

        if (returnedState !== savedState) {
          res.writeHead(400);
          res.end("State mismatch — Login abgebrochen.");
          return;
        }

        // Exchange code for tokens
        try {
          const tokenBody = new URLSearchParams({
            code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: OAUTH_REDIRECT_URI,
            grant_type: "authorization_code",
          });
          const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenBody.toString(),
          });
          const tokenData = await tokenRes.json();

          if (tokenData.error) {
            res.writeHead(400);
            res.end(`Login-Fehler: ${tokenData.error_description || tokenData.error}`);
            reject(new Error(tokenData.error));
            return;
          }

          this.accessToken = tokenData.access_token;
          this.refreshToken = tokenData.refresh_token;
          this.expiryDate = Date.now() + (tokenData.expires_in || 3600) * 1000;

          // Get user email
          try {
            const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
              headers: { Authorization: `Bearer ${this.accessToken}` },
            });
            const userData = await userRes.json();
            this.email = userData.email || null;
          } catch {}

          this.save();
          mem.del.run("gemini", "oauth_state");

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!DOCTYPE html><html><body style="background:#0a0a0f;color:#4ade80;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
            <div style="text-align:center"><h1>NexoSeed</h1><p>Gemini Login erfolgreich!${this.email ? ` (${this.email})` : ""}</p><p>Du kannst dieses Fenster schliessen.</p></div>
          </body></html>`);

          console.log(`[gemini] OAuth Login erfolgreich${this.email ? ` (${this.email})` : ""}`);
          resolve(true);
        } catch (e) {
          res.writeHead(500);
          res.end("Server-Fehler: " + e.message);
          reject(e);
        } finally {
          setTimeout(() => {
            try { this._oauthServer.close(); } catch {}
            this._oauthServer = null;
          }, 2000);
        }
      });

      this._oauthServer.listen(OAUTH_REDIRECT_PORT, () => {
        console.log(`[gemini] OAuth-Callback wartet auf Port ${OAUTH_REDIRECT_PORT}`);
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this._oauthServer) {
          try { this._oauthServer.close(); } catch {}
          this._oauthServer = null;
          reject(new Error("OAuth Timeout"));
        }
      }, 300000);
    });

    // Return URL separately — the Promise is stored
  }

  getLoginUrl() {
    const state = crypto.randomBytes(16).toString("hex");
    mem.set.run("gemini", "oauth_state", state);

    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      response_type: "code",
      scope: "openid email profile https://www.googleapis.com/auth/cloud-platform",
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  logout() {
    this.accessToken = null;
    this.refreshToken = null;
    this.expiryDate = 0;
    this.email = null;
    mem.del.run("gemini", "oauth_creds");
    mem.del.run("gemini", "oauth_state");
    console.log("[gemini] Ausgeloggt");
  }
}

// ============================
// Gemini Chat API
// ============================
async function geminiChat(messages, model, token) {
  // Convert messages to Gemini format
  const geminiModel = model || "gemini-2.0-flash";
  const systemParts = [];
  const contents = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push({ text: msg.content });
    } else if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text: msg.content }] });
    } else if (msg.role === "assistant" || msg.role === "model") {
      contents.push({ role: "model", parts: [{ text: msg.content }] });
    } else if (msg.role === "tool") {
      contents.push({ role: "user", parts: [{ text: `[Tool Result]: ${msg.content}` }] });
    }
  }

  const body = {
    contents,
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 4096,
    },
  };

  if (systemParts.length > 0) {
    body.systemInstruction = { parts: systemParts };
  }

  const url = `${GEMINI_API_URL}/models/${geminiModel}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`Gemini API ${r.status}: ${errText.substring(0, 200)}`);
  }

  const data = await r.json();
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error("Keine Antwort von Gemini");

  return candidate.content?.parts?.map(p => p.text).join("") || "(keine Antwort)";
}

// ============================
// n8n Manager
// ============================
class N8nManager {
  constructor() {
    this.proc = null;
    this.apiKey = null;
    this.ready = false;
  }

  async start() {
    if (await this.healthCheck()) {
      console.log("[n8n] Bereits aktiv");
      this.ready = true;
      await this.loadApiKey();
      return true;
    }

    const n8nCmd = this.findN8n();
    if (!n8nCmd) {
      console.log("[n8n] Nicht gefunden — installiere mit: npm install -g n8n");
      return false;
    }

    console.log("[n8n] Starte...");
    const env = {
      ...process.env,
      N8N_PORT: String(N8N_PORT),
      N8N_USER_FOLDER: N8N_DATA_DIR,
      N8N_RUNNERS_DISABLED: "true",
      N8N_DIAGNOSTICS_ENABLED: "false",
      N8N_PERSONALIZATION_ENABLED: "false",
    };

    if (n8nCmd === "npx") {
      this.proc = spawn("npx", ["n8n", "start"], { env, stdio: "pipe", shell: true, windowsHide: true });
    } else {
      this.proc = spawn(n8nCmd, ["start"], { env, stdio: "pipe", shell: true, windowsHide: true });
    }

    this.proc.stdout.on("data", d => {
      const line = d.toString().trim();
      if (line) console.log(`[n8n] ${line}`);
    });
    this.proc.stderr.on("data", d => {
      const line = d.toString().trim();
      if (line && !line.includes("ExperimentalWarning") && !line.includes("DEP0"))
        console.log(`[n8n:err] ${line}`);
    });
    this.proc.on("exit", code => {
      console.log(`[n8n] Beendet (Code: ${code})`);
      this.ready = false;
    });

    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      if (await this.healthCheck()) {
        this.ready = true;
        console.log(`[n8n] Bereit auf Port ${N8N_PORT}`);
        await this.loadApiKey();
        await this.importPredefinedWorkflows();
        return true;
      }
    }
    console.log("[n8n] Timeout — konnte nicht starten");
    return false;
  }

  findN8n() {
    try {
      const cmd = IS_WIN ? "where n8n 2>nul" : "which n8n 2>/dev/null";
      const p = execSync(cmd, { encoding: "utf8", timeout: 5000 }).trim().split("\n")[0];
      if (p) return p;
    } catch {}
    try {
      execSync("npx n8n --version", { encoding: "utf8", timeout: 30000, stdio: "pipe" });
      return "npx";
    } catch {}
    return null;
  }

  async healthCheck() {
    try {
      const r = await fetch(`${N8N_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch { return false; }
  }

  async loadApiKey() {
    const cached = mem.get.run("n8n", "api_key");
    if (cached) { this.apiKey = cached; return; }

    const dbPaths = [
      path.join(N8N_DATA_DIR, ".n8n", "database.sqlite"),
      path.join(N8N_DATA_DIR, "database.sqlite"),
    ];
    for (const dbPath of dbPaths) {
      if (!fs.existsSync(dbPath)) continue;
      try {
        const n8nDb = new Database(dbPath, { readonly: true });
        const row = n8nDb.prepare('SELECT "apiKey" FROM user_api_keys LIMIT 1').get();
        n8nDb.close();
        if (row && row.apiKey) {
          this.apiKey = row.apiKey;
          mem.set.run("n8n", "api_key", this.apiKey);
          console.log("[n8n] API-Key geladen");
          return;
        }
      } catch {}
    }
    console.log("[n8n] Kein API-Key — erstelle einen in n8n unter Settings > API");
  }

  async api(endpoint, method = "GET", body = null) {
    if (!this.apiKey) return { ok: false, error: "Kein n8n API-Key" };
    try {
      const opts = {
        method,
        headers: { "X-N8N-API-KEY": this.apiKey, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
      };
      if (body && method !== "GET") opts.body = JSON.stringify(body);
      const r = await fetch(`${N8N_URL}${endpoint}`, opts);
      const data = await r.json();
      return { ok: r.ok, data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async webhook(webhookPath, data = {}, method = "POST") {
    try {
      const url = `${N8N_URL}/webhook/${webhookPath}`;
      const opts = {
        method,
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30000),
      };
      if (method !== "GET") opts.body = JSON.stringify(data);
      const r = await fetch(url, opts);
      return await r.json();
    } catch (e) {
      return { error: e.message };
    }
  }

  async importPredefinedWorkflows() {
    if (!this.apiKey) return;
    if (mem.get.run("n8n", "workflows_imported")) return;

    const wfDir = path.join(__dirname, "..", "workflows");
    if (!fs.existsSync(wfDir)) return;

    const files = fs.readdirSync(wfDir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      try {
        const wf = JSON.parse(fs.readFileSync(path.join(wfDir, file), "utf8"));
        const res = await this.api("/api/v1/workflows", "POST", wf);
        if (res.ok) {
          console.log(`[n8n] Workflow importiert: ${wf.name}`);
          await this.api(`/api/v1/workflows/${res.data.id}/activate`, "POST");
        }
      } catch (e) {
        console.log(`[n8n] Import-Fehler: ${file} — ${e.message}`);
      }
    }
    mem.set.run("n8n", "workflows_imported", "true");
  }

  stop() {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.ready = false;
  }
}

// ============================
// Hardware + Network Scan
// ============================
function scanHardware() {
  console.log("[seed] Scanne Hardware...");
  const hw = {};
  if (IS_WIN) {
    hw.hostname = ps("$env:COMPUTERNAME") || os.hostname();
    hw.os = ps("(Get-CimInstance Win32_OperatingSystem).Caption") || "Windows";
    hw.cpu = ps("(Get-CimInstance Win32_Processor).Name") || "?";
    hw.cores = ps("(Get-CimInstance Win32_Processor).NumberOfLogicalProcessors") || String(os.cpus().length);
    hw.ram_gb = ps("[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1)") || String(Math.round(os.totalmem() / 1073741824));
    hw.gpu = ps("(Get-CimInstance Win32_VideoController).Name") || "?";
    hw.vram_gb = ps("[math]::Round((Get-CimInstance Win32_VideoController).AdapterRAM/1GB,1)") || "?";
    hw.disk_free_gb = ps("[math]::Round((Get-PSDrive C).Free/1GB,1)") || "?";
  } else {
    hw.hostname = os.hostname();
    hw.os = run("cat /etc/os-release 2>/dev/null|grep PRETTY_NAME|cut -d= -f2|tr -d '\"'") || "Linux";
    hw.cpu = run("grep 'model name' /proc/cpuinfo|head -1|cut -d: -f2") || "?";
    hw.cores = String(os.cpus().length);
    hw.ram_gb = String(Math.round(os.totalmem() / 1073741824));
    hw.gpu = run("lspci 2>/dev/null|grep -i vga|cut -d: -f3") || run("nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null") || "?";
    hw.vram_gb = run("nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null") || "?";
    hw.disk_free_gb = run("df -BG / 2>/dev/null|awk 'NR==2{print $4}'|tr -d G") || "?";
  }
  for (const [k, v] of Object.entries(hw)) mem.set.run("hardware", k, String(v).trim());
  return hw;
}

function scanNetwork() {
  console.log("[seed] Scanne Netzwerk...");
  const out = run("arp -a") || "";
  const devices = [];
  for (const line of out.split("\n")) {
    const m = line.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (m && !m[1].endsWith(".255") && !m[1].endsWith(".1") && m[1] !== "255.255.255.255")
      devices.push(m[1]);
  }
  const unique = [...new Set(devices)];
  mem.set.run("network", "devices", JSON.stringify(unique));
  mem.set.run("network", "count", String(unique.length));
  return unique;
}

// ============================
// Ollama
// ============================
async function ollamaStatus() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { ok: false, models: [] };
    const d = await r.json();
    const models = (d.models || []).map(m => ({ name: m.name, size: m.size, modified: m.modified_at }));
    mem.set.run("ollama", "status", "online");
    mem.set.run("ollama", "models", models.map(m => m.name).join(", "));
    return { ok: true, models };
  } catch {
    mem.set.run("ollama", "status", "offline");
    return { ok: false, models: [] };
  }
}

// ============================
// Tool Definitions
// ============================
const TOOLS = [
  {
    type: "function",
    function: {
      name: "scan_hardware",
      description: "Scannt die komplette Hardware des PCs — CPU, GPU, RAM, Disk, OS.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "scan_network",
      description: "Scannt das lokale Netzwerk nach Geraeten via ARP.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "get_memory",
      description: "Liest Eintraege aus dem Langzeitgedaechtnis.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "Kategorie (hardware, network, ollama, n8n, user, system)" },
          key: { type: "string", description: "Spezifischer Schluessel" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Speichert einen Eintrag im Langzeitgedaechtnis.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "Kategorie (user, system, preference, note)" },
          key: { type: "string", description: "Schluessel" },
          value: { type: "string", description: "Wert" }
        },
        required: ["type", "key", "value"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "n8n_list_workflows",
      description: "Listet alle n8n-Workflows auf.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "n8n_execute_webhook",
      description: "Fuehrt einen n8n-Workflow ueber seinen Webhook-Pfad aus.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Webhook-Pfad" },
          data: { type: "object", description: "Daten" },
          method: { type: "string", enum: ["GET", "POST"] }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "n8n_create_workflow",
      description: "Erstellt einen neuen n8n-Workflow.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          nodes: { type: "array" },
          connections: { type: "object" }
        },
        required: ["name", "nodes", "connections"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "n8n_run_workflow",
      description: "Fuehrt einen n8n-Workflow ueber seine ID aus.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          data: { type: "object" }
        },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Fuehrt einen Systembefehl aus.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell-Befehl" }
        },
        required: ["command"]
      }
    }
  }
];

// ============================
// Tool Execution
// ============================
async function executeTool(name, args, n8nMgr) {
  console.log(`[tool] ${name}(${JSON.stringify(args)})`);
  chatDb.add.run("tool_call", name, name, JSON.stringify(args), null);

  let result;
  switch (name) {
    case "scan_hardware":
      result = scanHardware();
      break;
    case "scan_network":
      result = { devices: scanNetwork() };
      break;
    case "get_memory":
      if (args.type && args.key) {
        result = { value: mem.get.run(args.type, args.key) };
      } else if (args.type) {
        result = { entries: mem.allByType.all(args.type) };
      } else {
        result = { entries: mem.all.all() };
      }
      break;
    case "save_memory":
      mem.set.run(args.type, args.key, args.value);
      result = { ok: true, saved: `${args.type}/${args.key}` };
      break;
    case "n8n_list_workflows":
      if (!n8nMgr.ready) { result = { error: "n8n ist nicht gestartet" }; break; }
      const wfRes = await n8nMgr.api("/api/v1/workflows?limit=100");
      result = wfRes.ok ? (wfRes.data.data || []).map(w => ({ id: w.id, name: w.name, active: w.active })) : { error: wfRes.error || "API-Fehler" };
      break;
    case "n8n_execute_webhook":
      if (!n8nMgr.ready) { result = { error: "n8n ist nicht gestartet" }; break; }
      result = await n8nMgr.webhook(args.path, args.data || {}, args.method || "POST");
      break;
    case "n8n_create_workflow":
      if (!n8nMgr.ready) { result = { error: "n8n ist nicht gestartet" }; break; }
      const createRes = await n8nMgr.api("/api/v1/workflows", "POST", { name: args.name, nodes: args.nodes, connections: args.connections });
      result = createRes.ok ? { id: createRes.data.id, name: createRes.data.name } : { error: createRes.error };
      break;
    case "n8n_run_workflow":
      if (!n8nMgr.ready) { result = { error: "n8n ist nicht gestartet" }; break; }
      const runRes = await n8nMgr.api(`/api/v1/workflows/${args.id}/run`, "POST", { data: args.data || {} });
      result = runRes.ok ? runRes.data : { error: runRes.error };
      break;
    case "run_command":
      result = { output: run(args.command) || "(kein Output)" };
      break;
    default:
      result = { error: `Unbekanntes Tool: ${name}` };
  }

  chatDb.add.run("tool_result", JSON.stringify(result), name, null, null);
  return result;
}

// ============================
// System Prompt Builder
// ============================
function buildSystemPrompt(n8nMgr, ollamaInfo, geminiAuth, selectedModel) {
  const memories = mem.all.all();
  const memCtx = memories.length > 0
    ? memories.filter(m => m.type !== "gemini").map(m => `[${m.type}] ${m.key}: ${m.value}`).join("\n")
    : "(noch leer)";

  return `Du bist NexoSeed — ein selbstlernendes AI-Betriebssystem das auf diesem Computer lebt.
Du sprichst Deutsch, locker und direkt. Du gehoerst nur dem User.

Aktuelles Modell: ${selectedModel}

Dein Gedaechtnis (SQLite):
${memCtx}

n8n Workflow-Engine: ${n8nMgr.ready ? "ONLINE (Port " + N8N_PORT + ")" : "OFFLINE"}
Ollama: ${ollamaInfo.ok ? ollamaInfo.models.map(m => m.name).join(", ") : "offline"}
Gemini: ${geminiAuth.isLoggedIn ? "verbunden (" + (geminiAuth.email || "eingeloggt") + ")" : "nicht angemeldet"}

Regeln:
- Beim ersten Kontakt: stelle dich vor, scanne Hardware
- Merke dir ALLES was der User erzaehlt (save_memory)
- Erkenne Verbesserungsmoeglichkeiten und schlage sie vor
- Frage IMMER bevor du etwas aenderst
- Wenn der User nein sagt: akzeptieren und nie wieder vorschlagen
- Nutze n8n fuer wiederkehrende Aufgaben
- Halte Antworten kurz und praegnant`;
}

// ============================
// Chat Router (Ollama or Gemini)
// ============================
async function chat(userMsg, selectedModel, n8nMgr, geminiAuth) {
  chatDb.add.run("user", userMsg, null, null, selectedModel);

  const olInfo = await ollamaStatus();
  const isGemini = selectedModel.startsWith("gemini");

  // Build messages
  const history = chatDb.recent.all(20).reverse().filter(c => c.role === "user" || c.role === "assistant");
  const sysPrompt = buildSystemPrompt(n8nMgr, olInfo, geminiAuth, selectedModel);

  const messages = [
    { role: "system", content: sysPrompt },
    ...history.map(c => ({ role: c.role, content: c.content })),
    { role: "user", content: userMsg },
  ];

  try {
    let reply;

    if (isGemini) {
      // --- Gemini Path ---
      const token = await geminiAuth.getValidToken();
      if (!token) throw new Error("Gemini nicht angemeldet — bitte erst einloggen.");

      // Gemini doesn't have native tool-calling in the same way,
      // so we inject tool descriptions into the system prompt and parse
      reply = await geminiChat(messages, selectedModel, token);

    } else {
      // --- Ollama Path (with tool-calling) ---
      if (!olInfo.ok) throw new Error("Ollama laeuft nicht. Starte es mit: ollama serve");
      if (!olInfo.models.length) throw new Error("Kein Ollama-Modell geladen. Lade eins mit: ollama pull qwen3:8b");

      const modelName = selectedModel || olInfo.models[0].name;
      const availableTools = n8nMgr.ready ? TOOLS : TOOLS.filter(t => !t.function.name.startsWith("n8n_"));

      let response = await ollamaRequest(modelName, messages, availableTools);

      let rounds = 0;
      while (response.message?.tool_calls?.length > 0 && rounds < 5) {
        rounds++;
        messages.push(response.message);
        for (const tc of response.message.tool_calls) {
          const result = await executeTool(tc.function.name, tc.function.arguments || {}, n8nMgr);
          messages.push({ role: "tool", content: JSON.stringify(result) });
        }
        response = await ollamaRequest(modelName, messages, availableTools);
      }

      reply = response.message?.content || "(keine Antwort)";
    }

    chatDb.add.run("assistant", reply, null, null, selectedModel);
    return reply;
  } catch (e) {
    console.error("[chat] Fehler:", e.message);
    return `Fehler: ${e.message}`;
  }
}

async function ollamaRequest(model, messages, tools) {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools, stream: false }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
  return await r.json();
}

// ============================
// Evolution Engine
// ============================
function localEvolutionCheck() {
  const hw = {};
  for (const row of mem.all.all()) { if (row.type === "hardware") hw[row.key] = row.value; }
  const proposals = [];
  const vram = parseFloat(hw.vram_gb) || 0;
  const ram = parseFloat(hw.ram_gb) || 0;
  const memCount = mem.count.get();

  if (vram >= 8 && !rej.check.get("model_upgrade")) {
    proposals.push({ id: "model_upgrade", text: `Du hast ${vram}GB VRAM — soll ich ein groesseres Modell laden?`, category: "model" });
  }
  if (ram >= 16 && memCount > 500 && !rej.check.get("db_upgrade")) {
    proposals.push({ id: "db_upgrade", text: `${memCount} Eintraege bei ${ram}GB RAM — PostgreSQL Upgrade?`, category: "database" });
  }
  return proposals;
}

// ============================
// Web Server
// ============================
function createServer(n8nMgr, geminiAuth) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "..", "web")));

  // --- Models endpoint ---
  app.get("/api/models", async (req, res) => {
    const models = [];

    // Ollama models
    const ol = await ollamaStatus();
    if (ol.ok) {
      for (const m of ol.models) {
        models.push({
          id: m.name,
          name: m.name,
          provider: "ollama",
          status: "ready",
          size: m.size,
        });
      }
    }

    // Gemini models
    const geminiModels = [
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", description: "Schnell, guenstig" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Neuestes Flash-Modell" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Staerkstes Modell" },
    ];
    for (const gm of geminiModels) {
      models.push({
        id: gm.id,
        name: gm.name,
        provider: "gemini",
        description: gm.description,
        status: geminiAuth.isLoggedIn ? "ready" : "login_required",
      });
    }

    res.json({
      models,
      selected: mem.get.run("config", "selected_model") || (ol.ok && ol.models.length > 0 ? ol.models[0].name : "gemini-2.0-flash"),
      gemini: {
        loggedIn: geminiAuth.isLoggedIn,
        email: geminiAuth.email,
      },
      ollama: { online: ol.ok, count: ol.models.length },
    });
  });

  // --- Select model ---
  app.post("/api/models/select", (req, res) => {
    const { model } = req.body;
    if (!model) return res.status(400).json({ error: "model fehlt" });
    mem.set.run("config", "selected_model", model);
    console.log(`[seed] Modell gewechselt: ${model}`);
    res.json({ ok: true, selected: model });
  });

  // --- Gemini Auth endpoints ---
  app.get("/api/gemini/status", (req, res) => {
    res.json({
      loggedIn: geminiAuth.isLoggedIn,
      email: geminiAuth.email,
      expired: geminiAuth.isExpired,
    });
  });

  app.post("/api/gemini/login", async (req, res) => {
    try {
      const loginUrl = geminiAuth.getLoginUrl();

      // Start callback server in background
      geminiAuth.startLogin().then(() => {
        console.log("[gemini] Login abgeschlossen");
      }).catch(e => {
        console.log("[gemini] Login-Fehler:", e.message);
      });

      res.json({ ok: true, loginUrl });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/gemini/logout", (req, res) => {
    geminiAuth.logout();
    res.json({ ok: true });
  });

  // --- Chat endpoint ---
  app.post("/api/chat", async (req, res) => {
    const { message, model } = req.body;
    if (!message) return res.status(400).json({ error: "message fehlt" });

    const selectedModel = model || mem.get.run("config", "selected_model") || "qwen3:8b";

    try {
      const reply = await chat(message, selectedModel, n8nMgr, geminiAuth);
      res.json({ reply, model: selectedModel });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Status ---
  app.get("/api/status", async (req, res) => {
    const ol = await ollamaStatus();
    const hw = {};
    for (const row of mem.all.all()) { if (row.type === "hardware") hw[row.key] = row.value; }
    res.json({
      ollama: { ok: ol.ok, models: ol.models },
      hardware: hw,
      n8n: { ready: n8nMgr.ready, port: N8N_PORT, hasApiKey: !!n8nMgr.apiKey },
      gemini: { loggedIn: geminiAuth.isLoggedIn, email: geminiAuth.email },
      memory_entries: mem.count.get(),
      chat_messages: chatDb.count.get(),
      selected_model: mem.get.run("config", "selected_model") || null,
    });
  });

  // --- Memory ---
  app.get("/api/memory", (_, res) => res.json(mem.all.all()));

  // --- Chat history ---
  app.get("/api/history", (req, res) => {
    const since = parseInt(req.query.since) || 0;
    res.json(since > 0 ? chatDb.since.all(since) : chatDb.all.all());
  });

  // --- Evolution ---
  app.get("/api/evolution", async (_, res) => {
    const proposals = localEvolutionCheck();
    res.json(proposals.filter(p => !rej.check.get(p.id)));
  });

  app.post("/api/evolution/:id/accept", async (req, res) => {
    res.json({ ok: true, message: "Verstanden, ich bereite das vor!" });
  });

  app.post("/api/evolution/:id/reject", (req, res) => {
    rej.add.run(req.params.id);
    res.json({ ok: true, message: "Ok, nerve nicht mehr damit." });
  });

  // --- Manual scan ---
  app.post("/api/scan", async (_, res) => {
    res.json({ hardware: scanHardware(), network: scanNetwork() });
  });

  // --- n8n proxy ---
  app.get("/api/n8n/workflows", async (_, res) => {
    if (!n8nMgr.ready) return res.json({ error: "n8n offline" });
    const r = await n8nMgr.api("/api/v1/workflows?limit=100");
    res.json(r.ok ? r.data : { error: r.error });
  });

  return app;
}

// ============================
// Boot
// ============================
async function boot() {
  console.log("");
  console.log("  _  _                ___             _");
  console.log(" | \\| | _____ _____  / __| ___  ___ _| |");
  console.log(" | .` |/ -_) \\ / _ \\ \\__ \\/ -_)/ -_) _` |");
  console.log(" |_|\\_|\\___/_\\_\\___/ |___/\\___|\\___\\__,_|");
  console.log("                              v0.3");
  console.log("");
  console.log(`[seed] Daten: ${DATA_DIR}`);

  // 1. Scans
  scanHardware();
  scanNetwork();

  // 2. Ollama
  const ol = await ollamaStatus();
  if (ol.ok) console.log(`[seed] Ollama: ${ol.models.map(m => m.name).join(", ") || "keine Modelle"}`);
  else console.log("[seed] Ollama offline");

  // 3. Gemini Auth
  const geminiAuth = new GeminiAuth();
  if (geminiAuth.isLoggedIn) {
    console.log(`[seed] Gemini: ${geminiAuth.email || "eingeloggt"}`);
    if (geminiAuth.isExpired) {
      await geminiAuth.refresh();
    }
  } else {
    console.log("[seed] Gemini: nicht angemeldet");
  }

  // 4. n8n
  const n8nMgr = new N8nManager();
  n8nMgr.start().catch(e => console.error("[n8n] Start-Fehler:", e.message));

  // 5. Web Server
  const app = createServer(n8nMgr, geminiAuth);
  app.listen(PORT, () => {
    console.log(`[seed] Web-UI: http://localhost:${PORT}`);
    console.log("[seed] Bereit!\n");
    try {
      const cmd = IS_WIN ? `start http://localhost:${PORT}` : `xdg-open http://localhost:${PORT} 2>/dev/null`;
      require("child_process").exec(cmd);
    } catch {}
  });

  process.on("SIGINT", () => {
    console.log("\n[seed] Fahre herunter...");
    n8nMgr.stop();
    db.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    n8nMgr.stop();
    db.close();
    process.exit(0);
  });
}

boot().catch(console.error);
