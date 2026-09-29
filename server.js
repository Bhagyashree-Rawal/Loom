import "dotenv/config";
import express from "express";
import neo4j from "neo4j-driver";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.on("unhandledRejection", e => console.error("Unhandled:", e?.message || e));

const E = process.env;
const driver = neo4j.driver(E.NEO4J_URI, neo4j.auth.basic(E.NEO4J_USER, E.NEO4J_PASSWORD));
const run = async (q, p = {}) => {
  const s = driver.session();
  try { return (await s.run(q, p)).records; } finally { await s.close(); }
};

async function llm(model, system, user) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${E.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  const j = await r.json();
  if (!j.choices) throw new Error("OpenRouter: " + JSON.stringify(j));
  return JSON.parse(j.choices[0].message.content.replace(/```json|```/g, ""));
}

async function search(q) {
  if (!E.BRAVE_API_KEY) return { sources: [] };
  try {
    const r = await fetch("https://api.search.brave.com/res/v1/web/search?count=4&q=" + encodeURIComponent(q),
      { headers: { "X-Subscription-Token": E.BRAVE_API_KEY, Accept: "application/json" } });
    const j = await r.json();
    if (!r.ok) {
      const error = `Brave returned ${r.status}. Check BRAVE_API_KEY.`;
      console.error(error, JSON.stringify(j).slice(0, 200));
      return { sources: [], error };
    }
    return { sources: (j.web?.results || []).slice(0, 3).map(x => ({ title: x.title, url: x.url, snippet: x.description })) };
  } catch (e) {
    console.error("Brave error:", e.message);
    return { sources: [], error: e.message };
  }
}

const SEED = [
  ["swimming", "Breathing feels rushed when I get tired; I gulp air and lose my stroke.", ["rushing under pressure", "breath control"]],
  ["swimming", "Coach says I lift my head to breathe. Relaxed exhale helps a lot.", ["breath control", "body awareness"]],
  ["swimming", "Did 100m without stopping. Kick rhythm finally felt steady.", ["rhythm", "endurance"]],
  ["chess", "Kept missing threats because I moved fast when unsure.", ["rushing under pressure", "pattern recognition"]],
  ["chess", "Spotted a fork early; the position looked like one I studied.", ["pattern recognition"]],
  ["cooking", "Prepping everything first made dinner calm. Timing sides is still hard.", ["sequencing", "planning"]],
  ["photography", "Shot too quickly at the pier and got nothing I like.", ["patience", "observation"]],
  ["photography", "Noticed leading lines only after slowing down.", ["observation", "pattern recognition"]],
  ["piano", "Metronome practice made my left hand steady.", ["rhythm"]],
];

const WRITE = `
MERGE (a:Activity {name:$activity})
CREATE (e:Entry {id:$id, text:$text, ts:datetime()})
CREATE (e)-[:ABOUT]->(a)
WITH e, a UNWIND $caps AS c
MERGE (cap:Capability {name:c})
MERGE (e)-[:SHOWS]->(cap)
MERGE (a)-[:DEVELOPS]->(cap)`;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
const safe = fn => async (req, res) => {
  try { await fn(req, res); } catch (e) { console.error(e.message); res.status(500).json({ error: String(e.message || e) }); }
};

app.post("/api/seed", safe(async (_, res) => {
  await run("MATCH (n) DETACH DELETE n");
  for (const [activity, text, caps] of SEED) await run(WRITE, { activity, text, caps, id: randomUUID() });
  res.json({ ok: true });
}));

app.get("/api/graph", safe(async (_, res) => {
  const n = await run("MATCH (n) WHERE n:Activity OR n:Capability RETURN n.name AS id, labels(n)[0] AS type");
  const l = await run("MATCH (a:Activity)-[:DEVELOPS]->(c:Capability) RETURN a.name AS s, c.name AS t");
  const k = await run("MATCH (x:Connection)-[:LINKS]->(a:Activity) WITH x, collect(a.name) AS ns WHERE size(ns)=2 RETURN ns[0] AS s, ns[1] AS t");
  res.json({
    nodes: n.map(r => ({ id: r.get("id"), type: r.get("type") })),
    links: [...l.map(r => ({ source: r.get("s"), target: r.get("t"), kind: "develops" })),
            ...k.map(r => ({ source: r.get("s"), target: r.get("t"), kind: "connection" }))],
  });
}));

// Plaud: webhook receiver (needs a public HTTPS URL) + a hand-off to the UI
let pendingPlaud = null;
const longest = v => typeof v === "string" ? v
  : v && typeof v === "object" ? Object.values(v).map(longest).sort((a, b) => b.length - a.length)[0] || "" : "";
app.post("/api/plaud/webhook", (req, res) => {
  console.log("Plaud webhook:", JSON.stringify(req.body).slice(0, 500));
  const text = longest(req.body).trim();
  if (text.length > 20) pendingPlaud = text.slice(0, 6000);
  res.json({ ok: true });
});
app.get("/api/plaud/pending", (_, res) => { res.json({ text: pendingPlaud }); pendingPlaud = null; });

app.post("/api/capture", async (req, res) => {
  try {
    const trace = [];
    const text = String(req.body?.text || "").trim().slice(0, 6000);
    if (!text) return res.status(400).json({ error: "Write a reflection first." });
    const known = (await run("MATCH (c:Capability) RETURN c.name AS n")).map(r => r.get("n"));
    const acts = (await run("MATCH (a:Activity) RETURN a.name AS n")).map(r => r.get("n"));

    // 1. Extract (fast model)
    const ex = await llm(E.FAST_MODEL,
      `Extract from a learning reflection. Return JSON: {"activity": string, "capabilities": string[1-3]}.
Capabilities are transferable abilities (e.g. rhythm, planning), lowercase, 2-3 per reflection.
Strongly prefer an existing capability name when the meaning is close (e.g. "rushing when unsure" -> "rushing under pressure"); only invent a new name if none fit. Existing names: ${known.join(", ")}.
Reuse an existing activity name when it fits: ${acts.join(", ")}.`, text);
    const id = randomUUID();
    ex.activity = String(ex.activity || "").trim().toLowerCase();
    ex.capabilities = (Array.isArray(ex.capabilities) ? ex.capabilities : []).map(c => String(c).trim().toLowerCase()).filter(Boolean);
    if (!ex.activity || !ex.capabilities.length) throw new Error("Could not extract an activity from that reflection. Try adding more detail.");
    await run(WRITE, { activity: ex.activity, text, caps: ex.capabilities, id });
    trace.push({ step: "Extract", model: E.FAST_MODEL, output: ex });

    // 2. Retrieve evidence from other activities (graph)
    const sharedQ = `MATCH (e1:Entry {id:$id})-[:SHOWS]->(c:Capability)<-[:SHOWS]-(e2:Entry)-[:ABOUT]->(a2:Activity),
      (e1)-[:ABOUT]->(a1:Activity) WHERE a1 <> a2
      RETURN c.name AS cap, a1.name AS from, a2.name AS other, collect(e2.text)[..3] AS evidence
      ORDER BY size(evidence) DESC LIMIT 3`;
    let rows = (await run(sharedQ, { id })).map(r => ({
      cap: r.get("cap"), from: r.get("from"), other: r.get("other"), evidence: r.get("evidence") }));
    let mode = "shared capability";
    if (!rows.length) {
      mode = "recent entries";
      rows = (await run(`MATCH (e:Entry)-[:ABOUT]->(a:Activity) WHERE a.name <> $from
        RETURN a.name AS other, collect(e.text)[..3] AS evidence LIMIT 4`, { from: ex.activity }))
        .map(r => ({ cap: null, from: ex.activity, other: r.get("other"), evidence: r.get("evidence") }));
    }
    trace.push({ step: "Graph query", model: "Neo4j", mode, output: rows });

    // 3. Coach + possible connection (strong model)
    const hy = await llm(E.SMART_MODEL,
      `You are a careful learning coach. You get a new reflection and evidence from the person's other activities.
Use ONLY the evidence given and never claim certainty. Return JSON:
{"insight": "one sentence on what this reflection shows",
 "experiment": "one small experiment for the next session",
 "search_query": "web search query for a practice resource",
 "connection": null or {"capability": string, "other_activity": "one of the candidate activities",
   "text": "2 sentences, phrased as a possible connection", "confidence": "low|medium|high"}}
Set connection to null unless the evidence shows a real shared theme.`,
      JSON.stringify({ new_reflection: text, candidates: rows }));
    trace.push({ step: "Coach", model: E.SMART_MODEL, output: hy });

    // 4. Ground with web sources
    const { sources, error: searchError } = await search(hy.search_query);
    trace.push({ step: "Search", model: "Brave", output: { query: hy.search_query, enabled: !!E.BRAVE_API_KEY, error: searchError, urls: sources.map(x => x.url) } });

    let connection = null;
    const k = hy.connection;
    if (k && rows.length) {
      const row = rows.find(r => r.other === String(k.other_activity || "").toLowerCase()) || rows[0];
      connection = {
        capability: String(k.capability || row.cap || "shared theme").toLowerCase(),
        from: ex.activity, other_activity: row.other,
        connection: k.text || k.connection || "",
        confidence: ["low", "medium", "high"].find(x => String(k.confidence).toLowerCase().includes(x)) || "low",
        evidence: row.evidence,
      };
      if (mode !== "shared capability" && connection.confidence === "high") connection.confidence = "medium";
      await run(`MATCH (a:Activity {name:$from}), (b:Activity {name:$other})
        CREATE (k:Connection {id:$id, capability:$cap, text:$text, confidence:$conf, experiment:$exp})
        CREATE (k)-[:LINKS]->(a), (k)-[:LINKS]->(b)`,
        { from: ex.activity, other: row.other, id, cap: connection.capability, text: connection.connection, conf: connection.confidence, exp: hy.experiment || "" });
    }

    res.json({ extracted: ex, connection, coach: { insight: hy.insight, experiment: hy.experiment },
      sources, braveEnabled: !!E.BRAVE_API_KEY, searchError, trace });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.listen(process.env.PORT || 3000, () => console.log("Loom is running"));
