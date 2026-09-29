import "dotenv/config";
import neo4j from "neo4j-driver";
console.log(JSON.stringify(process.env.NEO4J_URI), JSON.stringify(process.env.NEO4J_USER));
const d = neo4j.driver(process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
try { await d.verifyConnectivity(); console.log("Connected to", process.env.NEO4J_URI); }
catch (e) { console.log("Failed:", e.message); }
await d.close();