// System Design Lab — renders ```sysdesign fenced blocks as interactive
// architecture diagrams. Pure DOM/SVG, no dependencies, no model calls.
// Model-authored text is only ever inserted with textContent / attributes.

const SVGNS = "http://www.w3.org/2000/svg";
const NODE_W = 136;
const NODE_H = 60;
const COL_W = 240;
const ROW_H = 104;
const PAD = 30;
const MAX_NODES = 40;
const ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;

const ICONS = {
  client: "💻", user: "👤", mobile: "📱", dns: "📇", cdn: "🌐", lb: "⚖️", gateway: "🚪",
  service: "⚙️", worker: "🛠️", cache: "⚡", db: "🗄️", replica: "🗄️", queue: "📬", stream: "🌊",
  storage: "🪣", search: "🔎", external: "🔌", scheduler: "⏱️", lock: "🔒", monitor: "📈",
};

export const SAMPLE = {
  title: "URL shortener: read path",
  rps: 4000,
  nodes: [
    { id: "client", type: "client", label: "Browser" },
    { id: "lb", type: "lb", label: "Load balancer", capacity: 50000 },
    { id: "api", type: "service", label: "Redirect API", replicas: 3, capacity: 2000, note: "Stateless; scale horizontally." },
    { id: "cache", type: "cache", label: "Redis", capacity: 100000, onFail: "Every read now hits Postgres. Watch its load bar." },
    { id: "db", type: "db", label: "Postgres", capacity: 1500, note: "Single primary. ~1.5k reads/s before latency climbs." },
  ],
  edges: [
    { from: "client", to: "lb", ms: 20 },
    { from: "lb", to: "api", ms: 1 },
    { from: "api", to: "cache", ms: 1, label: "GET code" },
    { from: "api", to: "db", ms: 5, label: "on miss" },
  ],
  flows: [
    {
      name: "Cache hit", weight: 0.9, fallback: "Cache miss",
      steps: [
        { from: "client", to: "lb", note: "GET /x7Kq9 arrives at the load balancer." },
        { from: "lb", to: "api", note: "Round-robin to one of 3 API instances." },
        { from: "api", to: "cache", note: "Look up x7Kq9 in Redis." },
        { from: "cache", to: "api", note: "Hit: the long URL comes back in ~1 ms." },
        { from: "api", to: "lb", note: "301 redirect to the long URL…" },
        { from: "lb", to: "client", note: "…back through the load balancer to the browser." },
      ],
      summary: "90% of reads never touch the database.",
    },
    {
      name: "Cache miss", weight: 0.1,
      steps: [
        { from: "client", to: "lb", note: "GET /old123 arrives." },
        { from: "lb", to: "api", note: "Routed to an API instance." },
        { from: "api", to: "cache", note: "Look up old123 in Redis.", optional: true },
        { from: "cache", to: "api", note: "Miss.", optional: true },
        { from: "api", to: "db", note: "Read from Postgres by primary key." },
        { from: "db", to: "api", note: "Row found." },
        { from: "api", to: "cache", note: "Write it back to Redis with a TTL (cache-aside).", optional: true },
        { from: "api", to: "lb", note: "301 redirect…" },
        { from: "lb", to: "client", note: "…to the browser." },
      ],
    },
  ],
};

// ---------- small DOM helpers ----------

function h(doc, tag, attrs = {}, text) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

function s(doc, tag, attrs = {}, text) {
  const node = doc.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v, max = 400) => (typeof v === "string" ? v.slice(0, max) : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const int = (v) => (Number.isInteger(v) ? v : undefined);

function fmtNum(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

// ---------- parse + validate ----------

export function normalize(raw) {
  const errors = [];
  if (!isObj(raw)) return { errors: ["The block must be a JSON object with a `nodes` array."] };
  const spec = { title: str(raw.title, 120) || "", nodes: [], edges: [], flows: [], rps: num(raw.rps) };

  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) errors.push("`nodes` must be a non-empty array.");
  const ids = new Set();
  for (const [i, n] of (Array.isArray(raw.nodes) ? raw.nodes : []).slice(0, MAX_NODES).entries()) {
    if (!isObj(n) || typeof n.id !== "string" || !ID_RE.test(n.id)) {
      errors.push(`nodes[${i}] needs an \`id\` of letters, digits, _ . - (max 40).`);
      continue;
    }
    if (ids.has(n.id)) { errors.push(`Duplicate node id "${n.id}".`); continue; }
    ids.add(n.id);
    const replicas = int(n.replicas);
    spec.nodes.push({
      id: n.id,
      type: (str(n.type, 24) || "service").toLowerCase(),
      label: str(n.label, 40) || n.id,
      replicas: replicas && replicas > 0 ? Math.min(replicas, 99) : 1,
      capacity: num(n.capacity) > 0 ? num(n.capacity) : undefined,
      note: str(n.note),
      onFail: str(n.onFail),
      col: int(n.col) >= 0 ? int(n.col) : undefined,
      row: int(n.row) >= 0 ? int(n.row) : undefined,
    });
  }
  if (Array.isArray(raw.nodes) && raw.nodes.length > MAX_NODES) errors.push(`At most ${MAX_NODES} nodes.`);

  const pair = (v, where) => {
    const p = Array.isArray(v) ? { from: v[0], to: v[1], label: v[2] } : v;
    if (!isObj(p)) { errors.push(`${where} must be {from, to} or [from, to].`); return null; }
    const missing = [p.from, p.to].filter((id) => typeof id !== "string" || !ids.has(id));
    if (missing.length) { errors.push(`${where} references unknown node(s): ${missing.map(String).join(", ")}.`); return null; }
    return p;
  };

  for (const [i, e] of (Array.isArray(raw.edges) ? raw.edges : []).entries()) {
    const p = pair(e, `edges[${i}]`);
    if (p) spec.edges.push({ from: p.from, to: p.to, label: str(p.label, 40), ms: num(p.ms) });
  }

  for (const [i, f] of (Array.isArray(raw.flows) ? raw.flows : []).entries()) {
    if (!isObj(f) || !Array.isArray(f.steps) || f.steps.length === 0) {
      errors.push(`flows[${i}] needs a non-empty \`steps\` array.`);
      continue;
    }
    const steps = [];
    for (const [j, st] of f.steps.entries()) {
      const p = pair(st, `flows[${i}].steps[${j}]`);
      if (p) steps.push({ from: p.from, to: p.to, note: str(Array.isArray(st) ? st[2] : p.note), ms: num(p.ms), optional: !Array.isArray(st) && p.optional === true });
    }
    const w = num(f.weight);
    spec.flows.push({
      name: str(f.name, 40) || `Flow ${i + 1}`, weight: w !== undefined && w >= 0 ? w : undefined,
      steps, summary: str(f.summary), fallback: str(f.fallback, 40),
    });
  }
  for (const f of spec.flows) {
    if (f.fallback && !spec.flows.some((g) => g !== f && g.name === f.fallback)) {
      errors.push(`Flow "${f.name}" falls back to unknown flow "${f.fallback}".`);
      f.fallback = undefined;
    }
  }

  // Edges implied by flows so a flow never animates across empty space.
  const has = (a, b) => spec.edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
  for (const f of spec.flows) for (const st of f.steps) if (st.from !== st.to && !has(st.from, st.to)) spec.edges.push({ from: st.from, to: st.to, implied: true });

  spec.hasCapacity = spec.nodes.some((n) => n.capacity);
  if (spec.hasCapacity && !(spec.rps > 0)) spec.rps = 1000;
  return { spec, errors };
}

// ---------- layout ----------

function layout(spec) {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const incoming = new Map(spec.nodes.map((n) => [n.id, 0]));
  for (const e of spec.edges) if (!e.implied) incoming.set(e.to, incoming.get(e.to) + 1);
  let sources = spec.nodes.filter((n) => incoming.get(n.id) === 0).map((n) => n.id);
  if (!sources.length && spec.nodes.length) sources = [spec.nodes[0].id];

  // BFS distance from sources = column. Cycle-safe.
  const level = new Map();
  const queue = [...sources];
  for (const id of sources) level.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const e of spec.edges) {
      if (e.from === id && !level.has(e.to)) { level.set(e.to, level.get(id) + 1); queue.push(e.to); }
    }
  }
  for (const n of spec.nodes) n.c = n.col ?? level.get(n.id) ?? 0;

  const cols = new Map();
  for (const n of spec.nodes) { if (!cols.has(n.c)) cols.set(n.c, []); cols.get(n.c).push(n); }
  const maxCol = Math.max(...cols.keys());
  let maxRows = 1;
  for (const list of cols.values()) {
    list.sort((a, b) => (a.row ?? Infinity) - (b.row ?? Infinity));
    list.forEach((n, i) => { n.r = n.row ?? i; });
    maxRows = Math.max(maxRows, ...list.map((n) => n.r + 1));
  }
  for (const list of cols.values()) {
    const used = Math.max(...list.map((n) => n.r + 1));
    const offset = (maxRows - used) / 2;
    for (const n of list) {
      n.x = PAD + n.c * COL_W + NODE_W / 2;
      n.y = PAD + 14 + (n.r + offset) * ROW_H + NODE_H / 2;
    }
  }
  return {
    byId,
    width: PAD * 2 + maxCol * COL_W + NODE_W,
    height: PAD * 2 + 14 + (maxRows - 1) * ROW_H + NODE_H + 22,
  };
}

function borderPoint(n, tx, ty) {
  const dx = tx - n.x, dy = ty - n.y;
  if (!dx && !dy) return { x: n.x, y: n.y };
  const sx = (NODE_W / 2 + 5) / Math.abs(dx || 1e-9);
  const sy = (NODE_H / 2 + 5) / Math.abs(dy || 1e-9);
  const k = Math.min(sx, sy);
  return { x: n.x + dx * k, y: n.y + dy * k };
}

function geometry(a, b, curved) {
  const p = borderPoint(a, b.x, b.y), q = borderPoint(b, a.x, a.y);
  if (!curved) return { d: `M${p.x},${p.y} L${q.x},${q.y}`, mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } };
  const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1;
  const cx = (p.x + q.x) / 2 - (dy / len) * 34, cy = (p.y + q.y) / 2 + (dx / len) * 34;
  return {
    d: `M${p.x},${p.y} Q${cx},${cy} ${q.x},${q.y}`,
    mid: { x: 0.25 * p.x + 0.5 * cx + 0.25 * q.x, y: 0.25 * p.y + 0.5 * cy + 0.25 * q.y },
  };
}

function shape(doc, type, x, y, w, h) {
  const cls = "sdl-shape";
  if (type === "db" || type === "replica" || type === "storage") {
    const ry = 8;
    const g = s(doc, "g");
    g.append(
      s(doc, "path", { class: cls, d: `M${x},${y + ry} a${w / 2},${ry} 0 0 1 ${w},0 v${h - 2 * ry} a${w / 2},${ry} 0 0 1 ${-w},0 z` }),
      s(doc, "path", { class: "sdl-shape-line", d: `M${x},${y + ry} a${w / 2},${ry} 0 0 0 ${w},0` }),
    );
    return g;
  }
  if (type === "lb" || type === "gateway") {
    const i = 14;
    return s(doc, "polygon", { class: cls, points: `${x + i},${y} ${x + w - i},${y} ${x + w},${y + h / 2} ${x + w - i},${y + h} ${x + i},${y + h} ${x},${y + h / 2}` });
  }
  if (type === "queue" || type === "stream") {
    const g = s(doc, "g");
    g.append(s(doc, "rect", { class: cls, x, y, width: w, height: h, rx: 6 }));
    for (let k = 0; k < 3; k++) g.append(s(doc, "line", { class: "sdl-shape-line", x1: x + w - 10 - k * 7, x2: x + w - 10 - k * 7, y1: y + 8, y2: y + h - 8 }));
    return g;
  }
  const rx = type === "cdn" ? h / 2 : type === "client" || type === "user" || type === "mobile" ? 18 : 10;
  return s(doc, "rect", { class: cls, x, y, width: w, height: h, rx });
}

// ---------- the interactive lab ----------

function renderLab(container, spec, signal) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const reduceMotion = !!win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const { byId, width, height } = layout(spec);
  const state = { flow: 0, step: -1, playing: false, failed: false, lost: new Map(), rps: spec.rps || 0, total: 0 };
  let raf = 0, timer = 0, runId = 0;

  const root = h(doc, "div", { class: "sdl" });
  if (spec.title) root.append(h(doc, "div", { class: "sdl-title" }, spec.title));

  // Toolbar: flow tabs + transport.
  const bar = h(doc, "div", { class: "sdl-bar" });
  const tabs = [];
  if (spec.flows.length) {
    const tabWrap = h(doc, "div", { class: "sdl-tabs", role: "tablist", "aria-label": "Request flows" });
    spec.flows.forEach((f, i) => {
      const label = f.weight !== undefined && spec.flows.length > 1 ? `${f.name} · ${Math.round(f.weight * 100)}%` : f.name;
      const t = h(doc, "button", { type: "button", class: "sdl-tab", role: "tab" }, label);
      t.addEventListener("click", () => { stop(); state.flow = i; reset(); }, { signal });
      tabs.push(t);
      tabWrap.append(t);
    });
    const play = h(doc, "button", { type: "button", class: "sdl-btn sdl-primary" }, "▶ Play");
    const step = h(doc, "button", { type: "button", class: "sdl-btn" }, "Step ⏭");
    const rst = h(doc, "button", { type: "button", class: "sdl-btn" }, "↺ Reset");
    play.addEventListener("click", () => (state.playing ? stop() : playAll()), { signal });
    step.addEventListener("click", () => { stop(); next(); }, { signal });
    rst.addEventListener("click", () => { stop(); reset(); }, { signal });
    bar.append(tabWrap, h(doc, "div", { class: "sdl-transport" }));
    bar.lastChild.append(play, step, rst);
    root.append(bar);
    state.playBtn = play;
  }

  // Diagram.
  const svgEl = s(doc, "svg", { class: "sdl-svg", viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": spec.title || "System diagram" });
  svgEl.style.maxWidth = `${width}px`;
  const defs = s(doc, "defs");
  const markerId = `sdl-arrow-${Math.random().toString(36).slice(2, 8)}`;
  const marker = s(doc, "marker", { id: markerId, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
  marker.append(s(doc, "path", { d: "M0,0 L10,5 L0,10 z", class: "sdl-arrowhead" }));
  defs.append(marker);
  svgEl.append(defs);

  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const directed = new Set(spec.edges.map((e) => `${e.from}>${e.to}`));
  const curvedFor = (a, b) => byId.get(a).c === byId.get(b).c || (directed.has(`${a}>${b}`) && directed.has(`${b}>${a}`));
  const edgeEls = new Map();
  const edgeLayer = s(doc, "g");
  const labelLayer = s(doc, "g");
  for (const e of spec.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    const g = geometry(a, b, curvedFor(e.from, e.to));
    const path = s(doc, "path", { d: g.d, class: `sdl-edge${e.implied ? " sdl-implied" : ""}`, "marker-end": `url(#${markerId})` });
    edgeLayer.append(path);
    const key = pairKey(e.from, e.to);
    if (!edgeEls.has(key)) edgeEls.set(key, []);
    edgeEls.get(key).push(path);
    const text = [e.label, e.ms !== undefined ? `${e.ms} ms` : ""].filter(Boolean).join(" · ");
    if (text) {
      const t = s(doc, "text", { x: g.mid.x, y: g.mid.y - 5, class: "sdl-edge-label", "text-anchor": "middle" }, text);
      labelLayer.append(t);
    }
  }
  svgEl.append(edgeLayer, labelLayer);

  const nodeEls = new Map();
  const nodeLayer = s(doc, "g");
  for (const n of spec.nodes) {
    const g = s(doc, "g", { class: "sdl-node", tabindex: 0, role: "button" });
    const x = n.x - NODE_W / 2, y = n.y - NODE_H / 2;
    g.append(shape(doc, n.type, x, y, NODE_W, NODE_H));
    g.append(s(doc, "text", { x: n.x, y: n.y - 7, class: "sdl-type", "text-anchor": "middle" }, `${ICONS[n.type] || "▫️"} ${n.type}`));
    g.append(s(doc, "text", { x: n.x, y: n.y + 13, class: "sdl-label", "text-anchor": "middle" }, n.label));
    const badge = s(doc, "text", { x: x + NODE_W - 2, y: y - 6, class: "sdl-badge", "text-anchor": "end" });
    const load = s(doc, "text", { x: n.x, y: y + NODE_H + 17, class: "sdl-load", "text-anchor": "middle" });
    const loadBg = s(doc, "rect", { x: x + 8, y: y + NODE_H - 7, width: NODE_W - 16, height: 3, rx: 1.5, class: "sdl-loadbar-bg" });
    const loadBar = s(doc, "rect", { x: x + 8, y: y + NODE_H - 7, width: 0, height: 3, rx: 1.5, class: "sdl-loadbar" });
    g.append(badge, load);
    if (n.capacity) g.append(loadBg, loadBar);
    const tip = s(doc, "title");
    g.append(tip);
    const toggle = () => {
      const lost = state.lost.get(n.id) || 0;
      state.lost.set(n.id, lost >= n.replicas ? 0 : lost + 1);
      paint();
      if (state.step >= 0) { stop(); reset(); }
    };
    g.addEventListener("click", toggle, { signal });
    g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } }, { signal });
    nodeLayer.append(g);
    nodeEls.set(n.id, { g, badge, load, loadBar, tip });
  }
  svgEl.append(nodeLayer);
  const packet = s(doc, "circle", { r: 7, class: "sdl-packet", visibility: "hidden" });
  svgEl.append(packet);
  const scroller = h(doc, "div", { class: "sdl-scroll" });
  scroller.append(svgEl);
  root.append(scroller);

  // Narration + controls below.
  const status = h(doc, "div", { class: "sdl-status", "aria-live": "polite" });
  const narration = h(doc, "div", { class: "sdl-narration", "aria-live": "polite" });
  root.append(status, narration);

  if (spec.hasCapacity) {
    const maxRps = Math.max(spec.rps * 4, 100);
    const row = h(doc, "label", { class: "sdl-slider" });
    const readout = h(doc, "span", { class: "sdl-readout" });
    const input = h(doc, "input", { type: "range", min: 0, max: maxRps, step: Math.max(1, Math.round(maxRps / 200)), value: state.rps });
    input.addEventListener("input", () => { state.rps = Number(input.value); paint(); }, { signal });
    row.append(h(doc, "span", {}, "Incoming load"), input, readout);
    root.append(row);
    state.readout = readout;
  }
  root.append(h(doc, "div", { class: "sdl-hint" }, spec.nodes.some((n) => n.replicas > 1)
    ? "Click a component to fail it. Replicated components lose one instance per click."
    : "Click a component to take it down. Click again to bring it back."));

  // ---------- state → view ----------

  const upCount = (n) => n.replicas - (state.lost.get(n.id) || 0);
  const isDown = (id) => upCount(byId.get(id)) <= 0;
  const touchesDown = (st) => isDown(st.from) || isDown(st.to);
  const flowShare = (f) => (f.weight !== undefined ? f.weight : 1 / spec.flows.length);
  const broken = (f) => f.steps.some((st) => !st.optional && touchesDown(st));
  const flowByName = (name) => spec.flows.find((g) => g.name === name);

  // Share of traffic each flow actually carries, after broken flows hand their
  // traffic to a healthy fallback. Whatever cannot be rerouted becomes errors.
  function effective() {
    const share = new Map(spec.flows.map((f) => [f, 0]));
    let errors = 0;
    for (const f of spec.flows) {
      let target = f;
      for (let hops = 0; target && broken(target) && hops < spec.flows.length; hops++) target = target.fallback ? flowByName(target.fallback) : undefined;
      if (target && !broken(target)) share.set(target, share.get(target) + flowShare(f));
      else errors += flowShare(f);
    }
    return { share, errors };
  }
  function traffic(n, eff = effective()) {
    if (!spec.flows.length) return state.rps;
    let share = 0;
    for (const f of spec.flows) {
      const uses = f.steps.some((st) => (st.from === n.id || st.to === n.id) && !(st.optional && touchesDown(st)));
      if (uses) share += eff.share.get(f);
    }
    return state.rps * share;
  }

  function paint() {
    const flow = spec.flows[state.flow];
    const active = new Set();
    const activeEdges = new Set();
    if (flow && state.step >= 0) {
      const st = flow.steps[state.step];
      active.add(st.from); active.add(st.to);
      activeEdges.add(pairKey(st.from, st.to));
    }
    const inFlow = new Set(flow ? flow.steps.flatMap((st) => [st.from, st.to]) : []);
    const eff = effective();
    for (const n of spec.nodes) {
      const v = nodeEls.get(n.id);
      const up = upCount(n);
      const down = up <= 0;
      const load = traffic(n, eff);
      let util = 0;
      if (n.capacity) util = down ? Infinity : load / (n.capacity * up);
      const level = down ? "down" : util >= 1 ? "hot" : util >= 0.7 ? "warm" : "ok";
      v.g.setAttribute("class", [
        "sdl-node", `sdl-${level}`,
        active.has(n.id) ? "sdl-active" : "",
        flow && state.step >= 0 && !inFlow.has(n.id) ? "sdl-dim" : "",
        state.failed && active.has(n.id) && down ? "sdl-failing" : "",
      ].join(" "));
      v.badge.textContent = down ? "✕ DOWN" : n.replicas > 1 ? `${up}/${n.replicas} up` : "";
      if (n.capacity) {
        const pct = Number.isFinite(util) ? Math.round(util * 100) : 0;
        v.load.textContent = down ? "" : `${fmtNum(load)}/s · ${pct}%`;
        v.loadBar.setAttribute("width", String(Math.min(1, Number.isFinite(util) ? util : 0) * (NODE_W - 16)));
      } else v.load.textContent = "";
      v.g.setAttribute("aria-label", `${n.label} (${n.type})${down ? ", down" : ""}${n.note ? `. ${n.note}` : ""}`);
      v.tip.textContent = [n.label, n.note, n.capacity ? `Capacity: ${fmtNum(n.capacity)}/s per instance` : ""].filter(Boolean).join("\n");
    }
    for (const [key, paths] of edgeEls) for (const p of paths) p.classList.toggle("sdl-edge-active", activeEdges.has(key));
    tabs.forEach((t, i) => { t.classList.toggle("sdl-tab-on", i === state.flow); t.setAttribute("aria-selected", String(i === state.flow)); });
    if (state.playBtn) state.playBtn.textContent = state.playing ? "⏸ Pause" : "▶ Play";
    if (state.readout) state.readout.textContent = `${fmtNum(state.rps)} req/s`;
    if (spec.flows.length && (spec.hasCapacity || state.lost.size)) {
      const hot = spec.nodes.filter((n) => n.capacity && upCount(n) > 0 && traffic(n, eff) / (n.capacity * upCount(n)) >= 1);
      const errPct = Math.round(eff.errors * 100);
      status.className = `sdl-status ${errPct ? "sdl-status-bad" : hot.length ? "sdl-status-warn" : "sdl-status-ok"}`;
      status.textContent = [
        errPct ? `${errPct}% of requests fail (${fmtNum(state.rps * eff.errors)}/s)` : "All requests have a working path",
        hot.length ? `Overloaded: ${hot.map((n) => n.label).join(", ")}` : "",
      ].filter(Boolean).join(" · ");
    } else status.textContent = "";
  }

  function say(lines) {
    narration.replaceChildren(...lines.map(([cls, text]) => h(doc, "div", { class: cls }, text)));
  }

  function stepMs(st) {
    if (st.ms !== undefined) return st.ms;
    const e = spec.edges.find((x) => (x.from === st.from && x.to === st.to) || (x.from === st.to && x.to === st.from));
    return e?.ms ?? 0;
  }

  function reset() {
    cancel();
    state.step = -1; state.failed = false; state.total = 0;
    packet.setAttribute("visibility", "hidden");
    const flow = spec.flows[state.flow];
    if (flow) say([["sdl-muted", `${flow.name}: ${flow.steps.length} hops. Predict the path, then press Play or Step.`]]);
    else say([]);
    paint();
  }

  function cancel() { runId++; if (raf) win.cancelAnimationFrame(raf); if (timer) win.clearTimeout(timer); raf = 0; timer = 0; }
  function stop() { state.playing = false; cancel(); paint(); }

  function animate(st, done) {
    const a = byId.get(st.from), b = byId.get(st.to);
    if (st.from === st.to || reduceMotion) { packet.setAttribute("visibility", "hidden"); done(); return; }
    const g = geometry(a, b, curvedFor(st.from, st.to));
    const probe = s(doc, "path", { d: g.d });
    const len = probe.getTotalLength ? (svgEl.append(probe), probe.getTotalLength()) : 0;
    const dur = 650;
    const start = win.performance.now();
    const id = runId;
    packet.setAttribute("visibility", "visible");
    const frame = (now) => {
      if (id !== runId || signal.aborted) { probe.remove(); return; }
      const t = Math.min(1, (now - start) / dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      if (len) {
        const pt = probe.getPointAtLength(e * len);
        packet.setAttribute("cx", pt.x); packet.setAttribute("cy", pt.y);
      }
      if (t < 1) raf = win.requestAnimationFrame(frame);
      else { probe.remove(); raf = 0; done(); }
    };
    raf = win.requestAnimationFrame(frame);
  }

  function next(onDone) {
    const flow = spec.flows[state.flow];
    if (!flow || state.failed) return;
    if (state.step >= flow.steps.length - 1) { reset(); return; }
    state.step++;
    const st = flow.steps[state.step];
    const target = byId.get(st.to), origin = byId.get(st.from);
    const deadNode = upCount(origin) <= 0 ? origin : upCount(target) <= 0 ? target : null;
    paint();
    if (deadNode && st.optional) {
      packet.setAttribute("visibility", "hidden");
      const last = state.step === flow.steps.length - 1;
      say([
        ["sdl-skip", `↷ Step ${state.step + 1}/${flow.steps.length} skipped: ${deadNode.label} is down.`],
        ...(deadNode.onFail ? [["sdl-note", deadNode.onFail]] : []),
        ["sdl-muted", `Elapsed so far: ~${Math.round(state.total)} ms`],
        ...(last ? [["sdl-done", `Done (degraded): ~${Math.round(state.total)} ms end to end.`]] : []),
      ]);
      if (last) state.playing = false;
      paint();
      const id = runId;
      timer = win.setTimeout(() => { if (id === runId) onDone?.(last); }, reduceMotion ? 300 : 500);
      return;
    }
    if (deadNode) {
      state.failed = true; state.playing = false;
      packet.setAttribute("visibility", "hidden");
      paint();
      const fb = flow.fallback ? flowByName(flow.fallback) : undefined;
      say([
        ["sdl-fail", `✕ Step ${state.step + 1}: ${deadNode.label} is down. The request fails here.`],
        ...(deadNode.onFail ? [["sdl-note", deadNode.onFail]] : []),
        fb ? ["sdl-note", `This traffic falls back to “${fb.name}”${broken(fb) ? ", but that path is broken too." : ". Open that tab and play it."}`]
          : ["sdl-muted", "What would make this path survive the failure?"],
      ]);
      return;
    }
    const id = runId;
    animate(st, () => {
      if (id !== runId) return;
      state.total += stepMs(st);
      const last = state.step === flow.steps.length - 1;
      const lines = [
        ["sdl-step", `Step ${state.step + 1}/${flow.steps.length}: ${origin.label} → ${target.label}`],
        ...(st.note ? [["sdl-note", st.note]] : []),
        ["sdl-muted", `Elapsed so far: ~${Math.round(state.total)} ms`],
      ];
      if (last) {
        packet.setAttribute("visibility", "hidden");
        lines.push(["sdl-done", `Done: ~${Math.round(state.total)} ms end to end.${flow.summary ? ` ${flow.summary}` : ""}`]);
        state.playing = false;
      }
      say(lines);
      paint();
      onDone?.(last);
    });
  }

  function playAll() {
    const flow = spec.flows[state.flow];
    if (!flow) return;
    if (state.failed || state.step >= flow.steps.length - 1) reset();
    state.playing = true;
    paint();
    const id = runId;
    const loop = () => {
      if (id !== runId || !state.playing) return;
      next((last) => {
        if (last || !state.playing || id !== runId) return;
        timer = win.setTimeout(loop, reduceMotion ? 900 : 380);
      });
    };
    loop();
  }

  reset();
  container.append(root);
  return () => { cancel(); root.remove(); };
}

// ---------- mounting a fenced block ----------

// Models occasionally add // comments or trailing commas; strip both outside strings.
function lenientJson(source) {
  try { return JSON.parse(source); } catch (first) {
    let out = "", inStr = false, esc = false;
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (inStr) { out += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
      if (c === "\"") { inStr = true; out += c; continue; }
      if (c === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") i++; out += "\n"; continue; }
      if (c === "/" && source[i + 1] === "*") { i += 2; while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++; i++; continue; }
      out += c;
    }
    out = out.replace(/,(\s*[}\]])/g, "$1");
    try { return JSON.parse(out); } catch { throw first; }
  }
}

export function mountSysdesign(container, source, signal) {
  const doc = container.ownerDocument;
  let raw;
  try {
    raw = lenientJson(source);
  } catch (err) {
    return showError(container, [`Could not parse the diagram JSON: ${err instanceof Error ? err.message : String(err)}`], source);
  }
  const { spec, errors } = normalize(raw);
  if (!spec || !spec.nodes.length) return showError(container, errors, source);
  const cleanup = renderLab(container, spec, signal);
  if (errors.length) {
    const warn = h(doc, "details", { class: "sdl-warn" });
    warn.append(h(doc, "summary", {}, `${errors.length} part(s) of this diagram were skipped`));
    for (const e of errors) warn.append(h(doc, "div", {}, e));
    container.append(warn);
  }
  return cleanup;
}

function showError(container, errors, source) {
  const doc = container.ownerDocument;
  const box = h(doc, "div", { class: "sdl sdl-error" });
  box.append(h(doc, "strong", {}, "System diagram could not be drawn"));
  for (const e of errors) box.append(h(doc, "div", {}, e));
  const pre = h(doc, "pre", { class: "sdl-source" }, source);
  box.append(pre);
  container.append(box);
  return () => box.remove();
}

export function activate(ctx) {
  ctx.registerCodeBlock({
    language: "sysdesign",
    mount(container, block) {
      if (block.incomplete) {
        const doc = container.ownerDocument;
        const p = h(doc, "div", { class: "sdl sdl-pending" }, "Drawing system diagram…");
        container.append(p);
        return () => p.remove();
      }
      return mountSysdesign(container, block.source, block.signal);
    },
  });

  ctx.registerSettings((container, signal) => {
    const doc = container.ownerDocument;
    const intro = h(doc, "p", { class: "sdl-settings-intro" },
      "In a teaching or practice session, ask for a system design topic (for example: \"teach me how a URL shortener scales\"). " +
      "The teacher draws `sysdesign` diagrams like the one below. Play a flow, click components to fail them, and drag the load slider to find the bottleneck.");
    container.append(intro);
    const holder = h(doc, "div");
    container.append(holder);
    const cleanup = mountSysdesign(holder, JSON.stringify(SAMPLE), signal);
    return () => { cleanup?.(); container.replaceChildren(); };
  });
}
