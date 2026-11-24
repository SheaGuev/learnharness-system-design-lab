// System Design Lab backend: teaches the teacher and practice agents the
// `sysdesign` fenced-block format. No tools, no model calls, no data writes.

const INSTRUCTIONS = `## System Design Lab (interactive architecture diagrams)

You can draw interactive architecture diagrams by writing a fenced code block with the language \`sysdesign\` containing ONE valid JSON object (no comments, no trailing commas). It renders instantly in the lesson as a live diagram the learner can operate:
- Flows: tabs the learner plays step by step, with an animated request moving along each hop, your per-step note, and running latency.
- Failure injection: the learner clicks a component to take it down (replicated components lose one instance per click). Playing a flow through a dead component stops with your \`onFail\` text, and a status line shows what share of requests now fail.
- Load: if any node has \`capacity\`, a slider sets incoming requests per second and each node shows its utilisation (traffic × flow weight ÷ capacity × healthy replicas), turning amber at 70% and red at 100%.

Schema:
{
  "title": "short title",
  "rps": 4000,
  "nodes": [ { "id": "api", "type": "service", "label": "Redirect API", "replicas": 3, "capacity": 2000, "note": "hover text", "onFail": "what breaks when this dies", "col": 2, "row": 0 } ],
  "edges": [ { "from": "api", "to": "db", "label": "on miss", "ms": 5 } ],
  "flows": [
    { "name": "Cache hit", "weight": 0.9, "fallback": "Cache miss", "steps": [ { "from": "api", "to": "cache", "note": "look up the key" } ] },
    { "name": "Cache miss", "weight": 0.1, "summary": "shown at the end", "steps": [ { "from": "api", "to": "cache", "note": "look up the key", "optional": true }, { "from": "api", "to": "db", "note": "what happens on this hop", "ms": 5 } ] }
  ]
}
Rules:
- "rps" is the optional starting load for the slider. Everything except nodes[].id is optional.
- node types: client, user, mobile, dns, cdn, lb, gateway, service, worker, cache, db, replica, queue, stream, storage, search, external, scheduler, lock, monitor. Only id is required; layout is automatic left-to-right from the entry point, so col/row are rarely needed.
- Steps may go backwards along an edge for responses. Step ms falls back to the edge ms.
- Flow weights are each flow's share of traffic (e.g. cache hit 0.9, miss 0.1). Capacity is requests/s per instance.
- Degradation: mark a step \`"optional": true\` when the system can skip it if that component is down (e.g. a cache lookup or an async notification). Give a flow \`"fallback": "<other flow name>"\` when its traffic is rerouted to another flow if a required component dies (cache hit → cache miss, primary → replica). The lab then moves the load and shows the error rate, so the learner sees cascading load (e.g. Redis dies → Postgres turns red).
- Keep diagrams to about 3–10 nodes. Build up across the lesson: start with the simplest design that works, then draw a NEW block when you add a cache, queue, replica, shard or CDN, so the learner sees why each piece exists.

How to teach with it (system design, distributed systems, architecture, request lifecycles, scaling and failure trade-offs, interview practice):
- Before the learner presses Play, ask them to predict the path or the latency. Before they fail a component, ask what they expect to break. Then have them try it and explain the result.
- Use capacity + rps to let them find the bottleneck themselves ("drag the load to 6k/s — what turns red first, and what would you change?").
- Give realistic numbers (latency ms, QPS per instance) and say they are rough orders of magnitude.
- For interview practice, have the learner propose the next component in words first, then draw the improved design so they can test it.
Use the general \`demo\` tool only for things this format cannot express (custom simulations, algorithm visualisations, games); prefer \`sysdesign\` for architecture because it renders immediately and costs nothing extra.`;

exports.activate = (ctx) => {
  ctx.registerInstructions({ agents: ["teacher", "practice"], text: INSTRUCTIONS });
};
