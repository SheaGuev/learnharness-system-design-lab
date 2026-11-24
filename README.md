# System Design Lab (LearnHarness plugin)

Interactive architecture diagrams for system design lessons. The teacher writes a
`sysdesign` fenced block containing JSON; the plugin renders it instantly as a live
diagram. No build step, no dependencies, no extra model calls.

## What the learner can do

- **Play flows**: animated request hops with per-step notes and running latency.
- **Fail components**: click a node to take it down; replicated nodes lose one
  instance per click. Flows stop at dead components, skip `optional` steps, and
  reroute traffic to a `fallback` flow.
- **Load slider**: when nodes have `capacity`, drag incoming req/s and watch
  utilisation bars turn amber (70%) and red (100%). A status line shows the error
  rate and overloaded components.

## Files

- `dist/manifest.json`: plugin manifest (id `system-design-lab`, min app 0.7.0)
- `dist/main.js`: renderer (`registerCodeBlock("sysdesign")`) and settings preview
- `dist/backend.cjs`: teaches the teacher and practice agents the format (`registerInstructions`)
- `dist/styles.css`: styles using the app theme tokens

## Spec

```json
{
  "title": "URL shortener: read path",
  "rps": 4000,
  "nodes": [
    { "id": "api", "type": "service", "label": "Redirect API", "replicas": 3, "capacity": 2000,
      "note": "hover text", "onFail": "shown when a flow hits this node while it is down" }
  ],
  "edges": [ { "from": "api", "to": "db", "label": "on miss", "ms": 5 } ],
  "flows": [
    { "name": "Cache hit", "weight": 0.9, "fallback": "Cache miss",
      "steps": [ { "from": "api", "to": "cache", "note": "look up the key" } ] },
    { "name": "Cache miss", "weight": 0.1, "summary": "shown at the end",
      "steps": [ { "from": "api", "to": "cache", "optional": true }, { "from": "api", "to": "db", "ms": 5 } ] }
  ]
}
```

Node types: client, user, mobile, dns, cdn, lb, gateway, service, worker, cache, db,
replica, queue, stream, storage, search, external, scheduler, lock, monitor.
Layout is automatic (left to right from entry points); `col`/`row` override it.
The parser tolerates `//` comments and trailing commas.

## Install and update

Plain JS, no build step. The repo's `dist/` is exactly what LearnHarness loads.

1. Edit files in `dist/` in this repo.
2. Run `scripts/install.sh`.
3. Restart LearnHarness (loaded plugin code does not hot-reload).

The installer copies `dist/` to
`~/Library/Application Support/LearnHarness/data/plugins/system-design-lab/dist/`.
It replaces only that `dist/` folder, never touches the sibling `data/` folder
(the app's per-plugin storage), and refuses to run if the target `dist` is a
symlink. Set `LEARNHARNESS_PLUGINS_DIR` to install into a different plugins folder.

First install on a new machine: clone this repo, run `scripts/install.sh`, restart
LearnHarness, then enable the plugin in the app's plugin settings.

## License

[MIT](LICENSE). LearnHarness itself is AGPL-3.0; this plugin uses only its public plugin API and contains no LearnHarness code.
