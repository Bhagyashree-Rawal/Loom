# Loom

Loom is an AI learning journal that turns your reflections into a skill graph in Neo4j, finds the capabilities that transfer between things you're learning (like chess and swimming), and suggests one small, sourced experiment to try next.

Activities are temporary. Capabilities compound.

## The problem

Adults learn several things at once: swimming, cooking, chess, photography, instruments. Progress is slow and nonlinear, notes get scattered, and nothing connects what you learned in one area to another. Loom keeps the history, shows the capabilities you're building, and points out where they might apply somewhere else.

## What it does

1. **Capture.** Write a reflection, or load a transcript exported from a Plaud recording.
2. **Extract.** A fast model pulls out the activity and the transferable capabilities (for example "rushing under pressure" or "rhythm"), reusing capability names that already exist in your graph.
3. **Search your history.** Neo4j finds past entries from other activities that share a capability. If none match exactly, Loom looks at recent notes from your other activities and lets the model judge.
4. **Coach.** A stronger model writes a one-line insight, one small experiment, and, only when the evidence supports it, a *possible* connection with a confidence level.
5. **Ground.** Brave Search finds practice resources for the experiment.
6. **Explain.** A "How Loom got here" panel lists what it read, what it found, and which model did what.

Connections are always presented as hypotheses, with the past notes they're based on.

## Tech stack

| Piece | Used for |
|---|---|
| Neo4j (Aura) | Skill graph: activities, capabilities, entries, connections |
| OpenRouter | One API for the models: a cheap one for extraction, a stronger one for reasoning |
| Brave Search API | Cited practice resources (optional) |
| Plaud | Voice capture. Transcripts are loaded as `.txt` files |
| Node.js + Express | Backend |
| d3 | Graph visualization |

## Setup

Requirements: Node.js 18 or newer (the app uses the built-in `fetch`), a Neo4j Aura instance, and an OpenRouter API key. A Brave Search API key is optional.

```
npm install
```

Copy the template and fill in your own values:

```
cp .env.example .env        # on Windows PowerShell: copy .env.example .env
```

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | Your OpenRouter key |
| `NEO4J_URI` | Your Aura address, like `neo4j+s://<id>.databases.neo4j.io` |
| `NEO4J_USER` | Usually `neo4j` (use the username from your Aura credentials file) |
| `NEO4J_PASSWORD` | Your Aura password |
| `BRAVE_API_KEY` | Optional. If blank, web search is skipped |
| `FAST_MODEL` | OpenRouter model ID for extraction |
| `SMART_MODEL` | OpenRouter model ID for the coaching step |

Never commit `.env`. It is listed in `.gitignore`.

Start the app:

```
npm start
```

Open http://localhost:3000.

## Project layout

```
server.js               Express API, Neo4j queries, model and search calls
public/
  index.html            UI
  app.js                UI logic and graph rendering
  styles.css            Styles
demo-transcripts/       Sample Plaud-style transcripts
brave_test.js           Checks that your Brave key works
.env.example            Template with blank values
```

## Try the demo

1. Click **Load demo data** (this resets the graph to a seeded example).
2. Click **Load Plaud transcript** and choose `demo-transcripts/02_chess_rushing.txt`, then click **Weave into graph**.
3. Loom should propose a possible link between chess and swimming through rushing under pressure, show the past notes it's based on, suggest an experiment, and list practice resources.
4. Try `05_guitar_tempo.txt` to see a brand-new activity, and `03_cooking_prep.txt` or `04_photography_slowdown.txt` to see the case where no strong link is found and you still get an experiment.
5. Open **How Loom got here** to see the steps in plain language.

## Verify Brave Search

```
node brave_test.js
```

`Status: 200` with a few results means the key works. In the app, links under **Practice resources** and a "Searched ... and kept N results" line in the trace confirm it ran. If the key is invalid, the panel and your terminal show the error instead of failing silently.

## Plaud integration

The working path is manual: record with Plaud, export the transcript as text, and load it with the **Load Plaud transcript** button.

The server also exposes `POST /api/plaud/webhook`, which stores the latest incoming transcript so the **Get latest Plaud recording** button can load it. This is experimental. It needs a public HTTPS URL, the payload format has not been verified against a real Plaud account, and it does not verify webhook signatures.

## Deployment

The app is a standard Node server. It reads `PORT` from the environment and needs the variables above. To run it in a container, use a `node:22-alpine` image, install dependencies, and start with `node server.js`. Keep `.env` out of the image and pass the variables through your platform's environment settings.

## Limitations

- Demo grade: no authentication, and a single shared graph.
- Reset demo data deletes everything in the connected database.
- Capability matching depends on the model reusing existing names, so results vary between runs.
- Connections are hypotheses, not findings. Confidence is the model's judgment, not a statistic.

## Roadmap

- Activity data sources such as Strava, and calendar context
- Reminders based on gaps and upcoming events
- Capability progress over time, based on evidence rather than hours
- Verified Plaud webhook delivery
