const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const statusEl = $("#status");
const form = $("#captureForm");
const reflectionEl = $("#reflection");
const charCount = $("#charCount");
const submitBtn = $("#submitBtn");
const seedBtn = $("#seedBtn");
const refreshGraph = $("#refreshGraph");
const shuffleGraph = $("#shuffleGraph");
const resetZoom = $("#resetZoom");
const graphEmpty = $("#graphEmpty");
const graphWrap = $("#graphWrap");
const insightPlaceholder = $("#insightPlaceholder");
const insightCard = $("#insightCard");
const loadingSteps = $("#loadingSteps");
const loadingMsg = $("#loadingMsg");
const nodeTooltip = $("#nodeTooltip");
const confettiRoot = $("#confettiRoot");
const copyExperiment = $("#copyExperiment");

const LOADING_LINES = [
  "Unspooling your words…",
  "Tagging transferable skills…",
  "Querying the skill graph…",
  "Looking for cross-activity threads…",
  "Grounding with live sources…",
];

let simulation = null;
let zoomBehavior = null;
let svgRoot = null;
let graphGroup = null;
let lastGraph = { nodes: [], links: [] };
let loadingTimer = null;
let threadAnim = null;

function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
}

function startLoadingUI() {
  loadingSteps.classList.remove("hidden");
  loadingSteps.setAttribute("aria-hidden", "false");
  graphWrap.classList.add("is-busy");
  let i = 0;
  loadingMsg.textContent = LOADING_LINES[0];
  loadingTimer = setInterval(() => {
    i = (i + 1) % LOADING_LINES.length;
    loadingMsg.textContent = LOADING_LINES[i];
  }, 2200);
}

function stopLoadingUI() {
  loadingSteps.classList.add("hidden");
  loadingSteps.setAttribute("aria-hidden", "true");
  graphWrap.classList.remove("is-busy");
  if (loadingTimer) {
    clearInterval(loadingTimer);
    loadingTimer = null;
  }
}

async function api(path, options = {}) {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText || "Request failed");
  return data;
}

function burstConfetti(x, y) {
  const colors = ["#6b5ce0", "#3d9b7a", "#e85d4c", "#ffd166", "#5b4d8a"];
  const n = 28;
  for (let i = 0; i < n; i++) {
    const el = document.createElement("span");
    el.className = "confetti-piece";
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.background = colors[i % colors.length];
    const angle = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const dist = 60 + Math.random() * 100;
    el.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    el.style.setProperty("--dy", `${Math.sin(angle) * dist + 40}px`);
    confettiRoot.append(el);
    setTimeout(() => el.remove(), 1300);
  }
}

function renderInsight(data) {
  insightPlaceholder.classList.add("hidden");
  insightCard.classList.remove("hidden");
  insightCard.hidden = false;

  $$(".pop-in", insightCard).forEach((el) => {
    el.classList.remove("pop-in", "pop-in-delay");
    void el.offsetWidth;
    el.classList.add(el.closest("#connectionBlock") ? "pop-in pop-in-delay" : "pop-in");
  });

  const ex = data.extracted || {};
  $("#extActivity").textContent = ex.activity || "—";

  const capsEl = $("#extCaps");
  capsEl.innerHTML = "";
  (ex.capabilities || []).forEach((c, idx) => {
    const span = document.createElement("span");
    span.className = "cap-chip";
    span.textContent = c;
    span.style.animationDelay = `${idx * 0.08}s`;
    capsEl.append(span);
  });
  if (!ex.capabilities?.length) capsEl.textContent = "—";

  const connBlock = $("#connectionBlock");
  const hy = data.connection;
  const badge = $("#confidenceBadge");
  badge.textContent = "";
  badge.className = "confidence-badge";

  if (!hy) {
    connBlock.classList.add("hidden");
    $("#tracePre").textContent = JSON.stringify(data.trace || [], null, 2);
    return;
  }

  connBlock.classList.remove("hidden");
  $("#connectionText").textContent = hy.connection || hy.text || "";
  $("#connectionMeta").textContent = [
    hy.capability,
    hy.from && hy.other_activity ? `${hy.from} ↔ ${hy.other_activity}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  if (hy.confidence) {
    badge.textContent = hy.confidence;
    badge.classList.add(hy.confidence.toLowerCase());
  }

  $("#experimentText").textContent = hy.experiment || "—";

  const sourcesBlock = $("#sourcesBlock");
  const list = $("#sourcesList");
  list.innerHTML = "";
  const sources = data.sources || [];
  if (!sources.length) {
    sourcesBlock.classList.add("hidden");
  } else {
    sourcesBlock.classList.remove("hidden");
    for (const s of sources) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = s.title || s.url;
      li.append(a);
      list.append(li);
    }
  }

  $("#tracePre").textContent = JSON.stringify(data.trace || [], null, 2);
}

function getNeighborIds(nodeId, links) {
  const set = new Set([nodeId]);
  for (const l of links) {
    const s = typeof l.source === "object" ? l.source.id : l.source;
    const t = typeof l.target === "object" ? l.target.id : l.target;
    if (s === nodeId) set.add(t);
    if (t === nodeId) set.add(s);
  }
  return set;
}

function showTooltip(d, event) {
  const rect = graphWrap.getBoundingClientRect();
  nodeTooltip.classList.remove("hidden");
  nodeTooltip.innerHTML = `<strong>${d.id}</strong>${d.type}${d.pinned ? " · pinned" : ""}`;
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  nodeTooltip.style.left = `${x}px`;
  nodeTooltip.style.top = `${y}px`;
}

function hideTooltip() {
  nodeTooltip.classList.add("hidden");
}

function renderGraph({ nodes, links }, { reheat = true, highlightIds = null } = {}) {
  lastGraph = { nodes: [...(nodes || [])], links: [...(links || [])] };

  const svg = d3.select("#graph");
  svg.selectAll("*").remove();
  hideTooltip();

  if (!nodes?.length) {
    graphEmpty.classList.remove("hidden");
    graphWrap.classList.add("hidden");
    return;
  }
  graphEmpty.classList.add("hidden");
  graphWrap.classList.remove("hidden");

  const wrap = graphWrap.getBoundingClientRect();
  const width = Math.max(wrap.width, 320);
  const height = Math.max(wrap.height, 340);

  svg.attr("viewBox", [0, 0, width, height]);
  svgRoot = svg;

  const g = svg.append("g");
  graphGroup = g;

  zoomBehavior = d3
    .zoom()
    .scaleExtent([0.35, 3.5])
    .on("zoom", (event) => g.attr("transform", event.transform));
  svg.call(zoomBehavior);

  const nodeById = new Map(nodes.map((n) => [n.id, { ...n, pinned: n.pinned || false }]));
  nodes.forEach((n) => {
    const stored = nodeById.get(n.id);
    if (stored) Object.assign(n, stored);
  });

  const graphLinks = links
    .map((l) => ({
      source: typeof l.source === "object" ? l.source.id : l.source,
      target: typeof l.target === "object" ? l.target.id : l.target,
      kind: l.kind,
    }))
    .filter((l) => nodeById.has(l.source) && nodeById.has(l.target));

  if (simulation) simulation.stop();
  simulation = d3
    .forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink(graphLinks)
        .id((d) => d.id)
        .distance((d) => (d.kind === "connection" ? 150 : 68))
    )
    .force("charge", d3.forceManyBody().strength(-380))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collide", d3.forceCollide(32));

  const link = g
    .append("g")
    .attr("class", "links")
    .selectAll("line")
    .data(graphLinks)
    .join("line")
    .attr("class", (d) => (d.kind === "connection" ? "link-flow" : ""))
    .attr("stroke", (d) => (d.kind === "connection" ? "#3d9b7a" : "#8a7f6e"))
    .attr("stroke-width", (d) => (d.kind === "connection" ? 2.5 : 1.2))
    .attr("stroke-opacity", 0.7);

  const node = g
    .append("g")
    .attr("class", "nodes")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .attr("class", (d) => {
      let c = "graph-node";
      if (d.pinned) c += " node-pinned";
      if (highlightIds?.has(d.id)) c += " node-lit";
      return c;
    })
    .attr("cursor", "grab")
    .on("mouseenter", function (event, d) {
      const neighbors = getNeighborIds(d.id, graphLinks);
      node.classed("node-dim", (n) => !neighbors.has(n.id));
      node.classed("node-lit", (n) => neighbors.has(n.id));
      link.attr("stroke-opacity", (l) => {
        const s = l.source.id ?? l.source;
        const t = l.target.id ?? l.target;
        return neighbors.has(s) && neighbors.has(t) ? 1 : 0.12;
      });
      showTooltip(d, event);
    })
    .on("mousemove", (event, d) => showTooltip(d, event))
    .on("mouseleave", () => {
      node.classed("node-dim", false);
      node.classed("node-lit", false);
      link.attr("stroke-opacity", 0.7);
      hideTooltip();
    })
    .on("dblclick", (event, d) => {
      event.stopPropagation();
      d.pinned = !d.pinned;
      if (d.pinned) {
        d.fx = d.x;
        d.fy = d.y;
      } else {
        d.fx = null;
        d.fy = null;
      }
      d3.select(event.currentTarget).classed("node-pinned", d.pinned);
      simulation.alpha(0.4).restart();
    })
    .call(
      d3
        .drag()
        .on("start", (event, d) => {
          if (!event.active) simulation.alphaTarget(0.35).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on("drag", (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on("end", (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          if (!d.pinned) {
            d.fx = null;
            d.fy = null;
          }
        })
    );

  const circles = node
    .append("circle")
    .attr("r", 0)
    .attr("fill", (d) => (d.type === "Activity" ? "#e85d4c" : "#6b5ce0"))
    .attr("stroke", "#fff")
    .attr("stroke-width", 2);

  circles
    .transition()
    .duration(600)
    .delay((_, i) => i * 30)
    .attr("r", (d) => (d.type === "Activity" ? 16 : 11));

  node
    .append("text")
    .text((d) => d.id)
    .attr("x", 0)
    .attr("y", (d) => (d.type === "Activity" ? 28 : 24))
    .attr("text-anchor", "middle")
    .attr("font-size", "10px")
    .attr("font-weight", (d) => (d.type === "Activity" ? "600" : "500"))
    .attr("fill", "#1c1a17")
    .attr("pointer-events", "none")
    .attr("opacity", 0)
    .transition()
    .duration(400)
    .delay(400)
    .attr("opacity", 1);

  simulation.on("tick", () => {
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  if (reheat) simulation.alpha(1).restart();
}

async function loadGraph(opts) {
  try {
    const data = await api("/api/graph");
    renderGraph(data, opts);
  } catch (e) {
    setStatus(e.message, "error");
  }
}

function shuffleLayout() {
  if (!lastGraph.nodes.length) return;
  const nodes = lastGraph.nodes.map((n) => ({
    ...n,
    x: Math.random() * 400,
    y: Math.random() * 400,
    vx: 0,
    vy: 0,
  }));
  renderGraph({ nodes, links: lastGraph.links }, { reheat: true });
  simulation?.alpha(1).restart();
}

function resetGraphZoom() {
  if (!svgRoot || !zoomBehavior) return;
  svgRoot.transition().duration(400).call(zoomBehavior.transform, d3.zoomIdentity);
}

function initThreadCanvas() {
  const canvas = $("#threadCanvas");
  if (!canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const ctx = canvas.getContext("2d");
  let w = 0;
  let h = 0;
  let mouse = { x: 0.5, y: 0.5 };
  const points = [];

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    if (points.length < 40) {
      points.length = 0;
      for (let i = 0; i < 48; i++) {
        points.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
        });
      }
    }
  }

  window.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX / w;
    mouse.y = e.clientY / h;
  });

  function frame() {
    ctx.clearRect(0, 0, w, h);
    const mx = mouse.x * w;
    const my = mouse.y * h;

    for (const p of points) {
      p.x += p.vx + (mx - p.x) * 0.00008;
      p.y += p.vy + (my - p.y) * 0.00008;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
    }

    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i];
        const b = points[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist < 140) {
          ctx.strokeStyle = `rgba(107, 92, 224, ${0.15 * (1 - dist / 140)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    threadAnim = requestAnimationFrame(frame);
  }

  resize();
  frame();
  window.addEventListener("resize", resize);
}

reflectionEl.addEventListener("input", () => {
  const n = reflectionEl.value.length;
  charCount.textContent = `${n} char${n === 1 ? "" : "s"}`;
  charCount.classList.toggle("warm", n > 120);
});

$$(".chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    reflectionEl.value = btn.dataset.prompt || "";
    reflectionEl.focus();
    reflectionEl.dispatchEvent(new Event("input"));
    btn.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.08)" }, { transform: "scale(1)" }],
      { duration: 280 }
    );
  });
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = reflectionEl.value.trim();
  if (!text) return;

  submitBtn.disabled = true;
  setStatus("");
  startLoadingUI();

  try {
    const data = await api("/api/capture", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    stopLoadingUI();
    renderInsight(data);
    await loadGraph({ reheat: true });
    setStatus("Reflection woven into your graph.", "success");
    const rect = submitBtn.getBoundingClientRect();
    burstConfetti(rect.left + rect.width / 2, rect.top);
    reflectionEl.value = "";
    reflectionEl.dispatchEvent(new Event("input"));
  } catch (err) {
    stopLoadingUI();
    setStatus(err.message, "error");
  } finally {
    submitBtn.disabled = false;
  }
});

seedBtn.addEventListener("click", async () => {
  seedBtn.disabled = true;
  startLoadingUI();
  setStatus("");
  try {
    await api("/api/seed", { method: "POST" });
    insightPlaceholder.classList.remove("hidden");
    insightCard.classList.add("hidden");
    insightCard.hidden = true;
    await loadGraph({ reheat: true });
    stopLoadingUI();
    setStatus("Demo data loaded — poke the graph!", "success");
    const rect = graphWrap.getBoundingClientRect();
    burstConfetti(rect.left + rect.width / 2, rect.top + 40);
  } catch (e) {
    stopLoadingUI();
    setStatus(e.message, "error");
  } finally {
    seedBtn.disabled = false;
  }
});

copyExperiment.addEventListener("click", async () => {
  const text = $("#experimentText").textContent;
  if (!text || text === "—") return;
  try {
    await navigator.clipboard.writeText(text);
    copyExperiment.textContent = "Copied!";
    copyExperiment.classList.add("copied");
    setTimeout(() => {
      copyExperiment.textContent = "Copy experiment";
      copyExperiment.classList.remove("copied");
    }, 1600);
  } catch {
    setStatus("Could not copy to clipboard", "error");
  }
});

refreshGraph.addEventListener("click", () => loadGraph({ reheat: false }));
shuffleGraph.addEventListener("click", shuffleLayout);
resetZoom.addEventListener("click", resetGraphZoom);

let resizeT;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => loadGraph({ reheat: false }), 200);
});

initThreadCanvas();
loadGraph();
reflectionEl.dispatchEvent(new Event("input"));
