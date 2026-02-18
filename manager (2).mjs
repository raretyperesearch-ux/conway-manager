/**
 * ALiFe Conway Manager
 * 
 * HTTP API that sits alongside the Conway automaton runtime.
 * Receives provisioning requests from ALiFe, spawns automaton
 * child processes, and manages their lifecycles.
 * 
 * Railway ENV VARS:
 *   CONWAY_API_KEY       - Auth for ALiFe requests
 *   SUPABASE_URL         - For logging agent activity
 *   SUPABASE_SERVICE_KEY  - Service role key
 *   PORT                 - Railway sets automatically
 */

import http from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.CONWAY_API_KEY || "alife-dev-key";
const CONWAY_CLOUD_KEY = process.env.CONWAY_CLOUD_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const CONWAY_API_URL = "https://api.conway.tech";
const LAUNCH_FUNDING_CENTS = 100; // $1.00 per agent (Conway minimum is $1.00)

// ── Fund agent with Conway credits ──
async function fundAgent(walletAddress, agentId, sandboxId) {
  if (!CONWAY_CLOUD_KEY) {
    console.error(`[fundAgent] No Conway Cloud key — cannot fund`);
    return false;
  }
  
  const payload = {
    to_address: walletAddress,
    amount_cents: LAUNCH_FUNDING_CENTS,
    note: `Alive Agents v2 launch funding - ${sandboxId}`,
  };

  // Try both endpoint shapes
  const endpoints = ["/v1/credits/transfer", "/v1/credits/transfers"];
  
  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(`${CONWAY_API_URL}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": CONWAY_CLOUD_KEY,
          "X-API-Key": CONWAY_CLOUD_KEY,
        },
        body: JSON.stringify(payload),
      });

      if (resp.status === 404) continue;

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`[fundAgent] ${endpoint} ${resp.status}: ${errText}`);
        continue;
      }

      const data = await resp.json().catch(() => ({}));
      console.log(`[fundAgent] ✅ Funded ${walletAddress} with $${(LAUNCH_FUNDING_CENTS / 100).toFixed(2)} — transfer: ${data.transfer_id || data.id || "ok"}`);
      
      if (agentId) {
        log(agentId, "action", `Agent funded with $${(LAUNCH_FUNDING_CENTS / 100).toFixed(2)} Conway credits`, { 
          wallet: walletAddress, 
          amount_cents: LAUNCH_FUNDING_CENTS,
          transfer_id: data.transfer_id || data.id,
        });
      }
      return true;
    } catch (err) {
      console.error(`[fundAgent] ${endpoint} error: ${err.message}`);
    }
  }
  
  console.error(`[fundAgent] ❌ Failed to fund ${walletAddress}`);
  if (agentId) {
    log(agentId, "warn", `Auto-funding failed — agent may need manual funding`, { wallet: walletAddress });
  }
  return false;
}

const agents = new Map();

// ── Supabase helpers ──
async function db(method, table, data, filter) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error(`[db] No Supabase config - URL: ${!!SUPABASE_URL}, KEY: ${!!SUPABASE_KEY}`);
    return null;
  }
  const url = filter
    ? `${SUPABASE_URL}/rest/v1/${table}?${filter}`
    : `${SUPABASE_URL}/rest/v1/${table}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "return=minimal",
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[db] ${method} ${table} ${res.status}: ${errText}`);
    }
    return res.ok;
  } catch (e) {
    console.error(`[db] ${method} ${table} failed:`, e.message);
    return false;
  }
}

async function log(agentId, level, msg, meta) {
  await db("POST", "agent_logs", { agent_id: agentId, level, message: msg, metadata: meta || null });
}

// ── Provision a Conway automaton ──
async function provision(config) {
  const id = `alife-${(config.ticker || "agent").replace("$", "").toLowerCase()}-${Date.now()}`;
  const wallet = "0x" + crypto.randomBytes(20).toString("hex");

  console.log(`[+] ${config.name} → ${id}`);
  console.log(`[+] agent_id: ${config.agent_id || "NOT PROVIDED"}`);
  console.log(`[+] Supabase: ${SUPABASE_URL ? "yes" : "no"}`);

  // Create config directory for this agent
  const configDir = `/tmp/automaton-${id}`;
  fs.mkdirSync(configDir, { recursive: true });

  // Write agent config that Conway's setup wizard would normally create
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    name: config.name,
    ticker: config.ticker,
    genesis_prompt: config.genesis_prompt || config.genesisPrompt,
    creator_address: config.creator_address || config.creatorAddress,
    token_address: config.token_address || config.tokenAddress || "pending",
    model: config.model || "claude-sonnet-4-20250514",
    wallet_address: wallet,
  }, null, 2));

  // Update Supabase
  if (config.agent_id) {
    await db("PATCH", "agents", {
      conway_sandbox_id: id,
      agent_wallet_address: wallet,
      status: "alive",
    }, `id=eq.${config.agent_id}`);
    await log(config.agent_id, "action", `Conway automaton provisioned: ${id}`, { sandbox_id: id, wallet });
  }

  // Spawn the Conway automaton as a child process
  const child = spawn("node", ["dist/index.js", "--run"], {
    cwd: "/app",
    env: {
      ...process.env,
      AUTOMATON_CONFIG_DIR: configDir,
      AUTOMATON_NAME: config.name,
      AUTOMATON_GENESIS: config.genesis_prompt || config.genesisPrompt || "",
      AUTOMATON_CREATOR: config.creator_address || config.creatorAddress || "",
      AUTOMATON_WALLET: wallet,
      CONWAY_API_KEY: CONWAY_CLOUD_KEY,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Feed the interactive wizard with answers from the launch config
  // From reading Conway source code (src/setup/prompts.ts):
  //
  // promptRequired("name") → readline.question("  → What do you want to name...: ")
  //   needs: name + \n
  //
  // promptMultiline("genesis") → readline.question("  ") in a loop:
  //   line 1: actual text → needs: text + \n
  //   line 2: empty → needs: \n  (sets lastWasEmpty = true)  
  //   line 3: empty → needs: \n  (breaks the loop)
  //
  // promptAddress("address") → readline.question("  → Your Ethereum wallet...: ")
  //   needs: address + \n
  //
  // Total stdin sequence: name\n  text\n  \n  \n  address\n

  const agentName = config.name || "Agent";
  const genesis = config.genesis_prompt || config.genesisPrompt || "You are an autonomous agent. Find ways to create value.";
  const creator = config.creator_address || config.creatorAddress || "0x0000000000000000000000000000000000000000";
  let wizardDone = false;

  // Pre-schedule all wizard answers with generous delays
  // Wallet + SIWE takes ~2-4 seconds, then wizard questions start

  // Answer 1: Name (at 8s)
  setTimeout(() => {
    if (child.stdin.writable && !wizardDone) {
      console.log(`[${id}] Sending name: "${agentName}"`);
      child.stdin.write(agentName + "\n");
      if (config.agent_id) log(config.agent_id, "action", `Setting agent name: ${agentName}`, { sandbox_id: id });
    }
  }, 8000);

  // Answer 2: Genesis prompt text (at 10s)
  setTimeout(() => {
    if (child.stdin.writable && !wizardDone) {
      console.log(`[${id}] Sending genesis prompt text: "${genesis.slice(0, 50)}..."`);
      child.stdin.write(genesis + "\n");
      if (config.agent_id) log(config.agent_id, "action", `Writing genesis prompt: ${genesis.slice(0, 200)}`, { sandbox_id: id });
    }
  }, 10000);

  // Answer 3: First empty line for genesis multiline (at 11.5s)
  setTimeout(() => {
    if (child.stdin.writable && !wizardDone) {
      console.log(`[${id}] Sending first empty line for genesis`);
      child.stdin.write("\n");
    }
  }, 11500);

  // Answer 4: Second empty line to break genesis loop (at 13s)
  setTimeout(() => {
    if (child.stdin.writable && !wizardDone) {
      console.log(`[${id}] Sending second empty line to finish genesis`);
      child.stdin.write("\n");
    }
  }, 13000);

  // Answer 5: Creator address (at 15s)
  setTimeout(() => {
    if (child.stdin.writable && !wizardDone) {
      console.log(`[${id}] Sending creator address: "${creator.slice(0, 20)}..."`);
      child.stdin.write(creator + "\n");
      if (config.agent_id) log(config.agent_id, "action", `Registering creator: ${creator}`, { sandbox_id: id });
    }
  }, 15000);

  // Status check at 25s
  setTimeout(() => {
    console.log(`[${id}] Status check at 25s: alive=${!child.killed}, writable=${child.stdin.writable}, done=${wizardDone}`);
  }, 25000);

  child.stdout.on("data", (d) => {
    const raw = d.toString();
    const lines = raw.split("\n");
    
    for (const line of lines) {
      const msg = line.trim();
      if (!msg) continue;
      
      console.log(`[${id}] ${msg}`);
      if (config.agent_id) log(config.agent_id, "info", msg, { sandbox_id: id });

      // Capture the real wallet Conway generates
      if (msg.includes("Wallet created:")) {
        const walletMatch = msg.match(/0x[a-fA-F0-9]{40}/);
        if (walletMatch) {
          const realWallet = walletMatch[0];
          const agent = agents.get(id);
          if (agent) agent.wallet = realWallet;
          console.log(`[${id}] Real wallet captured: ${realWallet}`);
          if (config.agent_id) {
            db("PATCH", "agents", { agent_wallet_address: realWallet }, `id=eq.${config.agent_id}`);
            log(config.agent_id, "action", `Wallet generated: ${realWallet}`, { sandbox_id: id, wallet: realWallet });
          }
          // Auto-fund the agent with Conway credits
          fundAgent(realWallet, config.agent_id, id);
        }
      }

      // Capture API key provisioning
      if (msg.includes("API key provisioned:")) {
        if (config.agent_id) {
          log(config.agent_id, "action", "Conway API key provisioned — agent authenticated", { sandbox_id: id });
        }
      }

      // Handle SIWE failure — feed the Conway Cloud API key or press Enter to skip
      if (msg.includes("press Enter to skip") || msg.includes("enter a key manually") || msg.includes("Conway API key (cnwy_k_")) {
        if (CONWAY_CLOUD_KEY) {
          console.log(`[${id}] Feeding Conway Cloud API key`);
          setTimeout(() => {
            if (child.stdin.writable) child.stdin.write(CONWAY_CLOUD_KEY + "\n");
          }, 500);
        } else {
          console.log(`[${id}] No Conway Cloud key — pressing Enter to skip`);
          setTimeout(() => {
            if (child.stdin.writable) child.stdin.write("\n");
          }, 500);
        }
      }

      // Detect when wizard is complete
      if (msg.includes("[6/6]") || msg.includes("Setup complete") || msg.includes("Think") || msg.includes("loop")) {
        wizardDone = true;
        console.log(`[${id}] Wizard appears complete`);
        if (config.agent_id) log(config.agent_id, "action", "Conway setup complete — agent loop starting", { sandbox_id: id });
      }
    }
  });

  child.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) {
      console.error(`[${id}] ERR: ${msg}`);
      if (config.agent_id) log(config.agent_id, "warn", msg, { sandbox_id: id });
    }
  });

  child.on("exit", async (code) => {
    console.log(`[${id}] Process exited with code ${code}`);
    const agent = agents.get(id);
    if (agent) agent.status = "dead";
    if (config.agent_id) {
      await db("PATCH", "agents", { status: "dead" }, `id=eq.${config.agent_id}`);
      await log(config.agent_id, "error", `Automaton process exited (code ${code})`, { sandbox_id: id });
    }
  });

  // Heartbeat interval
  const hb = setInterval(async () => {
    const a = agents.get(id);
    if (!a || a.status === "dead") { clearInterval(hb); return; }
    if (config.agent_id) {
      await db("PATCH", "agents", { last_heartbeat: new Date().toISOString() }, `id=eq.${config.agent_id}`);
    }
  }, 60000);

  agents.set(id, { config, wallet, status: "alive", child, hb, started: Date.now() });

  // Auto-fund immediately after provisioning (don't wait for wallet detection)
  // Use a delay to let the wallet get captured first, but fund regardless
  setTimeout(async () => {
    const agent = agents.get(id);
    const fundWallet = agent?.wallet || wallet;
    console.log(`[${id}] Auto-funding wallet: ${fundWallet}`);
    await fundAgent(fundWallet, config.agent_id, id);
  }, 3000);

  // Boot activity (in case Conway runtime takes time to start)
  if (config.agent_id) {
    const acts = [
      [2000, "action", "Think→Act→Observe loop initializing..."],
      [5000, "info", "Reading genesis prompt..."],
      [10000, "action", "Automaton booting — scanning environment"],
    ];
    for (const [delay, lvl, msg] of acts) {
      setTimeout(async () => {
        const a = agents.get(id);
        if (a && a.status !== "dead") await log(config.agent_id, lvl, msg, { sandbox_id: id });
      }, delay);
    }
  }

  return { sandbox_id: id, wallet_address: wallet, status: "alive" };
}

function kill(id) {
  const a = agents.get(id);
  if (!a) return false;
  a.status = "dead";
  if (a.child) a.child.kill("SIGTERM");
  if (a.hb) clearInterval(a.hb);
  agents.delete(id);
  console.log(`[-] Killed: ${id}`);
  return true;
}

// ── HTTP Server ──
async function body(req) {
  let b = "";
  for await (const c of req) b += c;
  return b;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  const json = (code, data) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health (no auth)
  if (url.pathname === "/health") {
    return json(200, { status: "ok", agents: agents.size, uptime: Math.floor(process.uptime()) });
  }

  // Auth
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    return json(401, { error: "Unauthorized" });
  }

  try {
    // POST /v1/automatons — provision
    if (req.method === "POST" && url.pathname === "/v1/automatons") {
      const config = JSON.parse(await body(req));
      const result = await provision(config);
      return json(200, result);
    }

    // GET /v1/automatons — list
    if (req.method === "GET" && url.pathname === "/v1/automatons") {
      const list = [];
      for (const [id, a] of agents) {
        list.push({ sandbox_id: id, name: a.config.name, status: a.status, wallet: a.wallet });
      }
      return json(200, list);
    }

    // GET /v1/automatons/:id/heartbeat
    const hbMatch = url.pathname.match(/^\/v1\/automatons\/(.+)\/heartbeat$/);
    if (req.method === "GET" && hbMatch) {
      const a = agents.get(hbMatch[1]);
      if (!a) return json(404, { error: "Not found" });
      return json(200, { alive: a.status === "alive", wallet: a.wallet });
    }

    // POST /v1/automatons/:id/messages
    const msgMatch = url.pathname.match(/^\/v1\/automatons\/(.+)\/messages$/);
    if (req.method === "POST" && msgMatch) {
      const a = agents.get(msgMatch[1]);
      if (!a) return json(404, { error: "Not found" });
      const { message } = JSON.parse(await body(req));
      // Write directive to the agent's stdin
      if (a.child && a.child.stdin.writable) {
        a.child.stdin.write(JSON.stringify({ type: "directive", message }) + "\n");
      }
      if (a.config.agent_id) {
        await log(a.config.agent_id, "info", `Processing directive: "${(message || "").slice(0, 100)}"`, { sandbox_id: msgMatch[1] });
      }
      return json(200, { status: "processing", message: "Directive sent to automaton" });
    }

    // DELETE /v1/automatons/:id
    const delMatch = url.pathname.match(/^\/v1\/automatons\/(.+)$/);
    if (req.method === "DELETE" && delMatch) {
      return json(kill(delMatch[1]) ? 200 : 404, { killed: kill(delMatch[1]) });
    }

    json(404, { error: "Not found" });
  } catch (e) {
    console.error("Request error:", e);
    json(500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`◈ ALiFe Conway Manager v3`);
  console.log(`  Host: default (no 0.0.0.0)`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Health: /health`);
  console.log(`  Provision: POST /v1/automatons`);
  console.log(`  Supabase: ${SUPABASE_URL ? "connected" : "not configured"}`);
  console.log("");
});
