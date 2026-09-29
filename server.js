import express from "express";
import neo4j from "neo4j-driver";
import { randomUUID } from "crypto";

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
  if (!E.BRAVE_API_KEY) return [];
  const r = await fetch("https://api.search.brave.com/res/v1/web/search?count=4&q=" + encodeURIComponent(q),
    { headers: { "X-Subscription-Token": E.BRAVE_API_KEY, Accept: "application/json" } });
  const j = await r.json();
  return (j.web?.results || []).slice(0, 3).map(x => ({ title: x.title, url: x.url, snippet: x.description }));
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
app.use(express.static("public"));

app.post("/api/seed", async (_, res) => {
  await run("MATCH (n) DETACH DELETE n");
  for (const [activity, text, caps] of SEED) await run(WRITE, { activity, text, caps, id: randomUUID() });
  res.json({ ok: true });
});

app.get("/api/graph", async (_, res) => {
  const n = await run("MATCH (n) WHERE n:Activity OR n:Capability RETURN n.name AS id, labels(n)[0] AS type");
  const l = await run("MATCH (a:Activity)-[:DEVELOPS]->(c:Capability) RETURN a.name AS s, c.name AS t");
  const k = await run("MATCH (x:Connection)-[:LINKS]->(a:Activity) WITH x, collect(a.name) AS ns WHERE size(ns)=2 RETURN ns[0] AS s, ns[1] AS t");
  res.json({
    nodes: n.map(r => ({ id: r.get("id"), type: r.get("type") })),
    links: [...l.map(r => ({ source: r.get("s"), target: r.get("t"), kind: "develops" })),
            ...k.map(r => ({ source: r.get("s"), target: r.get("t"), kind: "connection" }))],
  });
});

app.post("/api/capture", async (req, res) => {
  try {
    const trace = [];
    const text = req.body.text;
    const known = (await run("MATCH (c:Capability) RETURN c.name AS n")).map(r => r.get("n"));
    const acts = (await run("MATCH (a:Activity) RETURN a.name AS n")).map(r => r.get("n"));

    // 1. Extract (fast model)
    const ex = await llm(E.FAST_MODEL,
      `Extract from a learning reflection. Return JSON: {"activity": string, "capabilities": string[1-3]}.
Capabilities are transferable abilities (e.g. rhythm, planning), lowercase. Reuse these names when they fit: ${known.join(", ")}.
Reuse an existing activity name when it fits: ${acts.join(", ")}.`, text);
    const id = randomUUID();
    await run(WRITE, { activity: ex.activity.toLowerCase(), text, caps: ex.capabilities.map(c => c.toLowerCase()), id });
    trace.push({ step: "Extract", model: E.FAST_MODEL, output: ex });

    // 2. Retrieve cross-activity evidence (graph)
    const cypher = `MATCH (e1:Entry {id:$id})-[:SHOWS]->(c:Capability)<-[:SHOWS]-(e2:Entry)-[:ABOUT]->(a2:Activity),
      (e1)-[:ABOUT]->(a1:Activity) WHERE a1 <> a2
      RETURN c.name AS cap, a1.name AS from, a2.name AS other, collect(e2.text)[..3] AS evidence
      ORDER BY size(evidence) DESC LIMIT 3`;
    const rows = (await run(cypher, { id })).map(r => ({
      cap: r.get("cap"), from: r.get("from"), other: r.get("other"), evidence: r.get("evidence") }));
    trace.push({ step: "Graph query", model: "Neo4j", output: rows });
    if (!rows.length) return res.json({ extracted: ex, connection: null, trace });

    // 3. Hypothesis (strong model)
    const hy = await llm(E.SMART_MODEL,
      `You find possible skill transfer between a person's learning areas. Use ONLY the evidence given.
Say "possible connection", never claim certainty. Return JSON:
{"capability": string, "other_activity": string, "connection": "2 sentences", "confidence": "low|medium|high",
 "experiment": "one small experiment for the next session", "search_query": "web search query to find a practice resource"}`,
      JSON.stringify({ new_reflection: text, candidates: rows }));
    trace.push({ step: "Hypothesis", model: E.SMART_MODEL, output: hy });

    // 4. Ground with web sources
    const sources = await search(hy.search_query);
    trace.push({ step: "Search", model: "Brave", output: sources.map(s => s.url) });

    const from = ex.activity.toLowerCase();
    await run(`MATCH (a:Activity {name:$from}), (b:Activity {name:$other})
      CREATE (k:Connection {id:$id, capability:$cap, text:$text, confidence:$conf, experiment:$exp})
      CREATE (k)-[:LINKS]->(a), (k)-[:LINKS]->(b)`,
      { from, other: hy.other_activity.toLowerCase(), id, cap: hy.capability, text: hy.connection, conf: hy.confidence, exp: hy.experiment });

    res.json({ extracted: ex, connection: { ...hy, from, evidence: rows.find(r => r.other === hy.other_activity.toLowerCase())?.evidence || rows[0].evidence }, sources, trace });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.listen(3000, () => console.log("Loom on http://localhost:3000"));
