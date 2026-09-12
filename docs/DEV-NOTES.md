# Development notes

Things that cost someone an hour once. The README says what Joseki does; this
says what working on it is like.

## A `shared` runtime change needs the client's dep cache cleared

Vite pre-bundles `@joseki/shared` **once**, at dev-server startup, and caches
the result in `client/node_modules/.vite`. Add a runtime export to `shared` —
a `const`, a function, anything with a value — and a client started before
that change keeps serving the old bundle. The page renders blank with
`does not provide an export named …`, while `tsc` passes happily against the
freshly rebuilt `shared/dist`. It has bitten twice.

So after a runtime change to `shared`: rebuild it, then restart the client
with the cache dropped.

```bash
npm run build:shared
cd client && npx vite --force     # --force re-bundles; rm -rf node_modules/.vite does the same
```

`--force` is the supported flag. (`--cacheDir` is **not** a Vite CLI flag,
despite reading like one.) A **type-only** addition — an interface, a type
alias, a new field on an existing interface — needs none of this.

Related: editing a component and its callers in one pass while that view is
open in the browser produces a transient crash in the console — HMR swaps
the modules one at a time, so for a moment a new callee runs against an old
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
- **No default `React` import** in a component — the JSX transform does not
  need it and the client build fails on the unused binding.
- **`ReactFlowProvider` stays inside `CanvasView`.** Hoisting it above the
  lazy boundary breaks the canvas.
- **Schema changes go in `server/src/db/migrations.ts`**, never into a
  `CREATE TABLE` in `database.ts` — see *Schema changes* in the README.
- **Runs start over socket.io only** (`execution:start`). There is no REST
  starter, deliberately: it is the path that streams node events and pauses at
  human gates.
