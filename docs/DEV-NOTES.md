# Development notes

Things that cost someone an hour once. The README says what Joseki does; this
says what working on it is like.

## `shared` is source to the client, and that is deliberate

`client/vite.config.ts` aliases `@joseki/shared` to `../shared/src/index.ts`,
so the client reads shared's **TypeScript source** and transforms it like any
file in the app. Edit shared, and the page has it — no rebuild, no restart.
(The *server* is different: it imports the built package, so `npm run
build:shared` is still what it reads, and the tests read it too.)

The config also says `optimizeDeps: { exclude: ['@joseki/shared'] }`, and that
line is load-bearing. It used to say `include`, which fought the alias and
won: Vite pre-bundled shared into `node_modules/.vite/deps`, and it
invalidates a linked package on its manifest, never its contents — so the
snapshot froze at whatever shared exported when the cache was built. Add an
export, and the view went **blank** with

```
The requested module '/node_modules/.vite/deps/@joseki_shared.js'
does not provide an export named 'DEFAULT_MAX_ATTEMPTS'
```

while `tsc` passed happily against the rebuilt `shared/dist`. It bit three
times before the cause was found, because clearing the cache by hand makes it
go away for a while — which reads like a fix and is not one. Do not put
`include` back.

## A crash right after an edit may be HMR, not the code

Editing a component and its callers in one pass while that view is open in
the browser produces a transient crash in the console — HMR swaps the
modules one at a time, so for a moment a new callee runs against an old
caller (or the reverse). It looks like a real TypeError with a real component
stack. Reload before believing it; if it survives the reload, it is real.

## `tsx watch` does not reliably pick up edits

The server dev script is `tsx watch src/index.ts`, and it misses edits. Worse,
when it does restart, the restart is invisible in the preview logs — there is
no line saying it happened. A live check against a server someone else started,
or one that has been up across several edits, can quietly be testing stale
code. When a result contradicts the source you just read, restart the server
before believing either.

## Running two copies at once

Two sessions in one checkout collide on 3001 and 5173. To stand up your own
pair, point every port and path at something else — and give the server a
**copy** of the database, not the shared one:

```bash
# server
PORT=3011 DATABASE_PATH=./data/scratch.db CLIENT_URL=http://localhost:5183 npm run dev --prefix server

# client — the dev proxy target is env-driven
JOSEKI_SERVER_URL=http://localhost:3011 npx vite --port 5183
```

## Testing through the Browser pane

- Use the **desktop** viewport preset. An emulated viewport puts screenshot
  pixels and click coordinates in different frames, and `ref`-based clicks
  drift.
- Do not batch clicks **across a lazy view mount**. `CanvasView` and
  `ChatView` both load on demand (see `App.tsx`), so refs taken before the
  mount do not survive it — click, then read the page again, then click.
- Reading the log panel's text out of the DOM is steadier than scrolling it:
  it auto-scrolls to the bottom on every new line.
- A view that fails to load renders `This view did not load` with the error,
  not a black screen — `ViewBoundary` wraps both lazy views. A black screen
  means something failed *outside* them, which is worth knowing.
- A click on a canvas node sometimes only selects it and sometimes opens its
  config panel. In a batch, probe for the `Node Configuration` heading
  between clicks rather than assuming which one you got.

## Smoke scripts

Against a running server, from `server/`:

| Script | What it needs |
|---|---|
| `npm run smoke:gate` | **No model.** Drives reject → rework → approve over socket.io and deletes the workflow afterwards — the cheapest end-to-end check there is |
| `npm run smoke:chat` | `OPENROUTER_API_KEY` |
| `npm run smoke:tools` | `OPENROUTER_API_KEY`. Creates a small workflow, has the model run it, cleans up |
| `npm run probe:reasoning` | `OPENROUTER_API_KEY`, and `-- --model <id>` |

To make a prompt node fail on purpose — testing error strategies, say — point
it at a model id that does not exist. The gateway refuses with a 400 and
nothing is billed.

## Odds and ends

- **The example workflow's `Quality Check` keeps a `1 == 0` condition on
  purpose.** It sends every run down the revision path, which is what makes
  the example exercise the interesting half of the graph. It is not a bug.
- **A branch condition cannot dot into a call's result.** `json(input).score`
  does not parse — member access attaches to names, not to calls, and the
  error is a bare `Expected EOF`. That is why the accessor takes a path,
  `get(input, "score")`, and why `get` parses JSON as it descends rather than
  handing back an object to walk.
- **`expr-eval`'s own `length` stringifies first**, so `length(x)` on a node
  that produced nothing answers 4 — the width of the word `null`.
  `conditions.ts` overrides the operator to coerce through `asText` first. Any
  other borrowed operator deserves the same suspicion.
- **Nothing in a condition is `undefined`, never `null`.** `null > -1` is true
  in JavaScript, because null counts as zero, so a missing field would clear a
  threshold it never reached; `undefined` compares as NaN and every comparison
  against it reads false. There is deliberately no `null` keyword either — a
  parser constant holding `undefined` evaluates to `0`, and one holding `null`
  matches neither a missing field nor unparsed JSON.
- **`expr-eval` refuses some member names at parse time** — `constructor` and
  `length` among them — so `nodes.draft.length` is a parse error; ask
  `length(nodes.draft)`. `get` takes its path as a string and so slips past
  that check, which is why it re-states the guard itself.
- **`shared` has exactly one runtime dependency, `expr-eval`,** because the
  condition language is part of the workflow contract: the executor evaluates
  conditions and the validator parses them, and both sides have to agree.
  Anything else added to `shared` ships to the client bundle too.
- **No default `React` import** in a component — the JSX transform does not
  need it and the client build fails on the unused binding.
- **A new file added while `dev:client` is running can leave HMR serving a
  module that references it before it is registered.** It reads exactly like a
  code bug — `ReferenceError: X is not defined` thrown from a component, caught
  by `ViewBoundary`, while `tsc --noEmit` and `npm run build` are both clean.
  The tell is the module timestamp in the stack (`CanvasView.tsx?t=…`) pointing
  at a load from before the file existed. Restart the dev server; do not go
  looking for the import, which is fine.
- **`ReactFlowProvider` stays inside `CanvasView`.** Hoisting it above the
  lazy boundary breaks the canvas.
- **Schema changes go in `server/src/db/migrations.ts`**, never into a
  `CREATE TABLE` in `database.ts` — see *Schema changes* in the README.
- **A field on `ExecutionTrace` is not a field in the database.** `model` sat
  on the type and streamed live for months while the insert never wrote it and
  the read never looked for it, so every reopened run had lost which model ran
  each node. When adding to the trace, follow it through
  `createExecutionTrace` *and* `parseExecutionTrace`, and add a migration —
  three places, and the type checker flags none of them.
- **What the log says about a run has to be recorded with the run.** The log is
  rebuilt from traces, so a branch's condition is stored in `detail` when it
  runs. Reading it off the canvas instead would make an old run report the
  condition the branch has *now* — a decision it never took. Labels are the
  deliberate exception: they are looked up live so a renamed node stays
  findable.
- **Runs start over socket.io only** (`execution:start`). There is no REST
  starter, deliberately: it is the path that streams node events and pauses at
  human gates.
