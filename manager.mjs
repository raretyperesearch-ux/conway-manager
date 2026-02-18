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
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const agents = new Map();

// ── Supabase helpers ──
async function db(method, table, data, filter) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const url = filter
    ? `${SUPABASE_URL}/rest/v1/${table}?${filter}`
    : `${SUPABASE_URL}/rest/v1/${table}`;
  try {
    await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "return=minimal",
      },
      body: data ? JSON.stringify(data) : undefined,
    });
  } catch (e) {
    console.error(`[db] ${method} ${table} failed:`, e.message);
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
  // The automaton runs: node dist/index.js --run
  // We pass config via environment variables
  const child = spawn("node", ["dist/index.js", "--run"], {
    cwd: "/app",
    env: {
      ...process.env,
      AUTOMATON_CONFIG_DIR: configDir,
      AUTOMATON_NAME: config.name,
      AUTOMATON_GENESIS: config.genesis_prompt || config.genesisPrompt || "",
      AUTOMATON_CREATOR: config.creator_address || config.creatorAddress || "",
      AUTOMATON_WALLET: wallet,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Feed the interactive wizard with answers from the launch config
  // Wizard asks: [3/6] name, [4/6] genesis prompt, [5/6] creator address
  const wizardAnswers = [
    config.name || "Agent",
    config.genesis_prompt || config.genesisPrompt || "You are an autonomous agent. Find ways to create value.",
    config.creator_address || config.creatorAddress || "0x0000000000000000000000000000000000000000",
  ];
  const wizardLabels = ["Setting agent name", "Writing genesis prompt", "Registering creator address"];
  let answerIndex = 0;

  child.stdout.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) {
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
        }
      }

      // Capture API key provisioning
      if (msg.includes("API key provisioned:")) {
        if (config.agent_id) {
          log(config.agent_id, "action", "Conway API key provisioned — agent authenticated", { sandbox_id: id });
        }
      }

      // Detect wizard prompts and feed answers
      if ((msg.includes("→") || msg.includes("?:") || msg.includes("prompt")) && answerIndex < wizardAnswers.length) {
        const answer = wizardAnswers[answerIndex];
        const label = wizardLabels[answerIndex];
        console.log(`[${id}] Wizard auto-answer [${answerIndex}]: "${answer.slice(0, 60)}..."`);

        // Log the answer to Supabase so it shows in the activity feed
        if (config.agent_id) {
          log(config.agent_id, "action", `${label}: ${answer.slice(0, 200)}`, { sandbox_id: id, wizard_step: answerIndex });
        }

        setTimeout(() => {
          if (child.stdin.writable) {
            child.stdin.write(answer + "\n");
            answerIndex++;
          }
        }, 500);
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
  console.log(`◈ ALiFe Conway Manager`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Health: /health`);
  console.log(`  Provision: POST /v1/automatons`);
  console.log(`  Supabase: ${SUPABASE_URL ? "connected" : "not configured"}`);
  console.log("");
});
