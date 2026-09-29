import "dotenv/config";
const key = process.env.BRAVE_API_KEY;
if (!key) { console.log("BRAVE_API_KEY is empty in .env"); process.exit(1); }
const r = await fetch("https://api.search.brave.com/res/v1/web/search?count=3&q=" + encodeURIComponent("chess candidate moves practice"),
  { headers: { "X-Subscription-Token": key, Accept: "application/json" } });
console.log("Status:", r.status);
const j = await r.json();
if (!r.ok) console.log(JSON.stringify(j).slice(0, 300));
else (j.web?.results || []).slice(0, 3).forEach(x => console.log("-", x.title, x.url));
