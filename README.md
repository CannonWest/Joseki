# Joseki

A visual IDE for building conversational AI workflows with tree-based branching and multi-model evaluation.

## Features

- **Visual Canvas**: Drag-and-drop workflow builder with React Flow
- **Node Types**: Prompt, Branch, Aggregate, Human Gate
- **Real-time Execution**: WebSocket streaming with live token output; nodes that don't depend on each other run at once
- **Run History**: Every run recorded and reopenable on the canvas, results and all
- **Folders**: Workflows live in folders, like files; the three shipped examples come in one called Examples
- **Model Comparison**: Fan one prompt out to several models and read the answers together — Best of Four in Examples is the shape
- **Dark Mode**: Optimized for long coding sessions

## Quick Start

```bash
# Clone the repository
git clone https://github.com/CannonWest/Joseki.git
cd Joseki

# Install dependencies
npm run install:all

# Setup environment — note this goes in server/, not the repo root
cp server/.env.example server/.env
# Edit server/.env with your API keys

# Initialize database
npm run db:init

# Start development server
npm run dev
```

The app will be available at:
- Frontend: http://localhost:5173
- Backend: http://localhost:3001

The client reads `shared` as source (Vite aliases it), so an edit there needs no rebuild; the server and the tests read the built package, which is what `npm run build:shared` is for. That, and the rest of what is worth knowing before changing something, is in [docs/DEV-NOTES.md](docs/DEV-NOTES.md).

## Project Structure

```
joseki/
├── client/          # React frontend (Vite + TypeScript + Tailwind)
├── server/          # Node.js backend (Express + Socket.io)
├── shared/          # Shared types and utilities
├── docs/            # DEV-NOTES.md — the traps worth knowing about
└── README.md        # This file
```

## Usage

1. **Create Workflows**: Drag nodes from the palette onto the canvas
2. **Connect Nodes**: Connect nodes by dragging between handles
3. **Configure**: Click nodes to configure prompts and parameters
4. **Validate**: Click **Validate** to check for problems before running
5. **Execute**: Press `Cmd+Enter` to run the workflow (it is saved and validated first)
6. **Share**: **Export** downloads the workflow as JSON; **Import** loads one from a file or pasted JSON
7. **Open**: browse your workflows and folders — open, rename, move and delete them — from the toolbar

## Workflow files

**Export** saves the canvas and downloads `<name>.joseki.json`:

```json
{
  "version": "1.0.0",
  "workflow": { "id": "...", "name": "...", "nodes": [...], "edges": [...], "variables": {} },
  "executionPlan": [ { "nodeId": "...", "dependencies": [...] } ]
}
```

**Import** accepts that envelope or a bare `{ "name", "nodes", "edges" }` object. The file must be structurally sound (arrays of nodes/edges, each node with an id, type, position and data); graph problems are reported after import so you can fix them in the editor.

**Validation** flags what the executor cannot run — unknown node types, duplicate ids, edges to missing nodes, dependency cycles — and warns about things that probably won't do what you expect (disconnected nodes, prompts with no model, template references to nodes that don't exist, no input or output node). Running a workflow validates it first; a workflow with errors will not start.

### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/workflows/:id/export` | GET | Export envelope (workflow + execution plan) |
| `/api/workflows/import` | POST | Create a workflow from an export envelope or bare workflow |
| `/api/workflows/:id/validate` | POST | `{ valid, errors, warnings }` for the stored workflow |
| `/api/workflows/:id` | PUT | Update — creates the workflow if the id is new |

### What a model will read and write

A model publishes two ceilings and no floor: `context_length`, the budget input and output **share**, and `max_completion_tokens`, the most it will emit. There is no minimum — the only field in the catalog with "min" in its name is a pricing threshold, not a limit on what you may send.

The two are not proportional. 29 of 445 models cap output below 5% of their window, and `writer/palmyra-x5` will read 1,040,000 tokens while emitting 8,192. So a prompt node shows both under its model (`128k ctx · 16k out`) and says so when **Max Tokens** exceeds what the model will emit — a request the gateway refuses, which is late to learn it.

Providers serving one model need not agree on either, and the figure on the model is only the top provider's: `meta-llama/llama-3.1-8b-instruct` advertises 131k, while `novita` serves 16k of it and `cloudflare` 32k. Pinning a provider under **Routing** can therefore shrink the window under you, so every row in the roster carries its own ceilings and the short ones are called out.

### A model served at more than one speed

A service tier is an **endpoint**, not a property of a model. OpenRouter lists `openai/flex` and `google-ai-studio/priority` in a model's provider roster beside the plain ones, at their own prices, and a model whose providers offer neither cannot be served at one — asking anyway is quietly ignored rather than refused. In a sample of 60 models across 58 authors, **52 had neither**; only openai, google, anthropic, x-ai and moonshotai offered any.

So the speeds are not a control of their own. A prompt node's **Model** menu lists them beside the model itself — `GPT-6 Astra`, `GPT-6 Astra · flex`, `GPT-6 Astra · priority` — derived from that roster, so a model with one speed simply has one entry and nothing offers a choice that would have done nothing. They go by the gateway's names for them, which are also the values `service_tier` takes and the names the roster tags endpoints with, so both surfaces say the same word; what each one means is said under the menu. It is also how OpenRouter says it: `:floor` and `:nitro` are model suffixes. The prices shown are the chosen endpoint's own, not an estimate: `$10 / $50` standard against `$5.0 / $25` flex for the same model.

Stored separately from the model id, as `serviceTier`, so the id stays one the catalog can resolve for context, output cap and pricing.

### Models this app does not offer

OpenRouter publishes a `:batch` variant of many models — around half price, served only through its asynchronous Batch API (`POST /api/beta/batches`, results inside a 24-hour window). A chat completion to one is refused:

```
404 This model is only available through the Batch API.
    Use the /api/beta/batches endpoint instead.
```

Joseki only makes chat completions, so `/api/models` leaves them out rather than offering a choice that could not have worked — 77 of 445 at the time of writing, every one of them with a plain sibling in the catalog. The provider's own catalog keeps them, so a workflow stored against one is still recognised. For a discount that *does* work here, set **Speed / price** to `flex`.

## Folders

Workflows live in folders, the way files do. **Open** in the editor toolbar is the way in: folders to walk into, workflows to open, a breadcrumb back up, and on each row **Rename**, **Move** and **Delete**, done in the row rather than in a second dialog. **New folder** makes one where you are. **+ New workflow** starts one where you are, and that is the only way a workflow starts anywhere but the top level — the app opens on a fresh workflow in the root, and **Import** also saves to the root.

A folder is named by its path — `Examples`, `Clients/Acme` — and the root is the empty path. A folder is a row of its own, so an empty one stays until it is deleted; a workflow names the folder it is in, and a folder a workflow is saved into is made if it is not there yet. A name cannot contain a slash, and two folders in one place cannot differ only by case.

Renaming or moving a folder carries everything under it. Renaming or moving a workflow is not an edit — the listing orders workflows by when they were last edited, and a file moved is not a file changed. Deleting a folder that holds anything asks first and says what goes: every folder under it, every workflow in any of them and, as always when a workflow is deleted, their runs.

Opening another workflow from the editor saves the one on the canvas first, the way Run and Export do — unless it was never saved and has nothing on it, which would only leave an empty *New Workflow* behind.

### Examples

The `Examples` folder holds the three workflows Joseki ships, one per shape. Each is written up in [docs/EXAMPLES.md](docs/EXAMPLES.md) — the shape, every node, what it teaches, how to run it, and what a run costs.

- **Content Review Pipeline** — the branching one: draft → quality branch → revision → merge → an editor gate that can send the work back with a note the next draft reads.
- **Translation Round-Trip** — the straight line: English → French → English → what drifted. Shows the two ways a prompt reads what came before it, `{{input}}` and `{{nodes.<id>.output}}`; runs from chat too.
- **Best of Four** — the fan: one prompt to four cheap models at once, and a blind judge that reprints the best answer in full. Shows the third way — naming every node when several arrows arrive; runs from chat too.

They are files like any other: edit one and the edit is kept; delete one and it stays deleted. They are put there once, when the database is created, not on every start — so an example added to a later version reaches an existing database through **Restore** in the Open dialog's footer, which puts back whichever are missing. Neither touches an example that is there.

### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/folders?path=` | GET | One level of the tree: the folders directly inside, each with what it holds all the way down, and the workflows directly in it, most recently edited first. The root when `path` is empty; `404` for a folder that is not there |
| `/api/folders/all` | GET | Every folder, in path order |
| `/api/folders` | POST | `{ path }` — makes the folder and any missing folder above it. `201` when new, `200` when it was there; `409` for a name that differs only by case from a folder already there |
| `/api/folders` | PATCH | `{ path, newPath }` — rename or move, with everything under it. `400` for a move into itself, `404` for a folder that is not there, `409` for a path already taken |
| `/api/folders?path=&recursive=` | DELETE | Removes an empty folder; with `recursive=true`, a full one and everything in it. Without it a full folder answers `409` with `contents: { workflows, folders }` |
| `/api/workflows/:id` | PATCH | `{ name?, folder? }` — rename or move a workflow without sending its graph. `404` for an unknown id; unlike `PUT`, never a create |
| `/api/workflows/import?folder=` | POST | Import into a folder. The file's own `folder` is ignored — that was a folder on the machine it came from |
| `/api/workflows/examples/restore` | POST | Puts back the shipped examples that are missing, in `Examples`; `{ restored }` names them |

A workflow carries `folder` wherever it goes — `GET`, `PUT`, export. `POST /api/workflows` and a creating `PUT` take one, the root when it is left out; `PUT` on an existing workflow leaves the folder alone unless the body names one. The chat tools see folders too: `list_workflows` says which folder each workflow is in, and `run_workflow` takes `Folder/Name` as well as a name or an id.

## Branching

A branch node decides **true** or **false**, and the arrow on that handle fires while the other path is skipped. Its **Condition** is an expression, not JavaScript — nothing in it can call out of itself, so a condition is data the same way a prompt is.

Three names are in scope, the same three a prompt template sees:

| Name | What it holds |
|------|---------------|
| `input` | What arrived on the first arrow into the branch, as text |
| `inputs` | Every arrow into the branch, keyed by the node it came from |
| `nodes` | Every node that has run so far, keyed by id |

Past arithmetic, comparison, `and` / `or` / `not` and `if(…)`, the vocabulary is:

| | |
|---|---|
| `length(x)` | How much text — `length(input) > 500` |
| `words(x)` | Whitespace-separated words |
| `contains(x, s)`, `startsWith(x, s)`, `endsWith(x, s)` | What the text says |
| `lower(x)`, `upper(x)`, `trim(x)` | Fold it before comparing |
| `number(x)` | Text as a number; blank text is not zero but NaN, so a threshold is never crossed by an empty answer |
| `isEmpty(x)` | Nothing, blank, or a field that was not there |
| `json(x)` | Text parsed as JSON |
| `get(x, "a.b")` | Walk a path, parsing JSON on the way down |

`get` is the one that does the work. A prompt node's output is always a string, so a field the model reported is behind a parse — and a call's result cannot be dotted into, because member access attaches to names. One call reaches it either way:

```
length(input) > 500                      how much came back
contains(lower(input), "approved")       what it says
get(input, "score") > 0.5                a field, through the JSON around it
get(nodes, "prompt-1757.score") > 0.5    an earlier node's field
```

**A node id with a hyphen has to go through `get`.** The canvas mints every id as `${type}-${Date.now()}`, and a hyphen is subtraction to the parser — `prompt-1757 == "x"` reads as `prompt` minus `1757`. Written as `get(nodes, "prompt-1757")` it works. An id the parser can read as a name — the example workflow's `example_draft` — is also in scope flat, which is how conditions were written before there was a `nodes` object.

Nothing compares as nothing, never as zero: a field that was not there fails `> 0.5` *and* `< 1`, rather than clearing a threshold it never reached. Ask `isEmpty(x)` to test for it on purpose; there is no `null` keyword.

**Validate** reads conditions at edit time — a condition that does not parse, one that reads a name nothing will supply, a branch missing its true or false arrow, and an arrow on a handle a branch can never choose. At run time a condition that decides something other than true or false stops the run and says so, rather than quietly killing every path out of the node.

## When a node fails

A prompt node can say what should happen when the model refuses, times out or errors — **On Error** in its config panel:

| Strategy | What happens |
|----------|--------------|
| **Fail** | The node fails and the run stops there. What a node with no strategy does, and what every node did before there were strategies |
| **Retry** | Run it again, up to **Max Attempts** tries in all — counting the first, capped at 10 — waiting half a second, then a second, then two between them. If the last try still fails the run stops, as **Fail** would |
| **Default** | The node carries its **Fallback Value** instead of failing, and the run goes on |

Every attempt is recorded, so a node that retried shows its failures as well as the try that worked: the log reads the sequence, and the runs list counts the extra attempts the same way it counts a gate's rework.

A node salvaged by **Default** ends as a success — that is what lets the run carry on — but its trace keeps the error, so the log says `draft carried on with its fallback after: …` rather than reporting a clean success the run did not have. **Validate** warns about a node set to fall back with nothing to fall back to, since it would carry nothing into everything downstream.

## Run history

Every run is recorded as it happens: one row for the run, one trace per node — its input, its output, tokens, cost, latency and outcome. **Runs** in the toolbar lists the past runs of the workflow on the canvas, newest first, with what each one touched and what it cost.

Picking a run puts it back on the canvas: every node that ran shows the status and output it ended with, output nodes show their result again, and the log reads the run back node by node. A banner says which run you are looking at, **Clear** takes it off, and running the workflow replaces it. So a result outlives the reload that used to lose it.

A node a human gate sent back ran more than once, and the history keeps every attempt rather than collapsing them — that is why a run can list more attempts than nodes. On the canvas each node shows its **last** attempt, which is the state the run ended in; the log shows the sequence.

### What the log says

A node that decided something says what it decided, rather than only that it finished:

```
Draft Summary — success · 20.6s
Quality Check → true · length(input) > 500
Revision skipped — Quality Check went the other way
Editor Review approved, with edits — "trimmed the intro" · 39.1s
```

Nodes read by their **labels**, looked up on the canvas as it is now — so a node renamed since still matches what you see, and one deleted since keeps its id, the only name left for it. What each node *decided*, though, is recorded with the run: a branch's condition is stored as it was written when the run happened, so editing the branch afterwards never rewrites what an old run says it decided on.

A run recorded before this shipped reads back without the branch and skip detail, which was never written down for it — the gate decisions and the labels still show, because those come from elsewhere.

Runs start over socket.io (`execution:start`), which is the only way to start one — it is the path that streams node events and pauses at human gates.

### Moving the panels out of the way

A gate's panel opens over the top-right of the canvas, which is often over the very thing it is asking you about. **Drag it by its header** to look behind it; it stays where you left it for the rest of the session, so a gate that sends work back and comes round again comes round where you put it. It cannot be pushed fully off screen — a strip stays in the window, and it never goes above the top edge, since the header is the only thing to grab it by.

The execution log's **left edge is a resize handle**: pull it left to widen the panel, between 280px and 900px. That width is remembered in the browser, so a panel widened to read a long condition or a streamed reply opens that wide next time.

### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/executions` | GET | Past runs, newest first, each with its trace count, distinct nodes, total cost and tokens. `?workflowId=` narrows to one workflow; `?limit=` caps the list (default 50, max 200) |
| `/api/executions/:id` | GET | One run with `traces`, the whole sequence in the order it happened; `404` for a run that does not exist |

## Chat

The server holds multi-turn conversations against any model on [OpenRouter](https://openrouter.ai), streaming replies over socket.io and storing every message in SQLite. Set `OPENROUTER_API_KEY` to enable it; without a key the workflow editor works as before and the chat routes answer `503`.

The client's **Chat** view (the Chat button in the editor toolbar) is the front end for it: a conversation list, a streaming markdown thread with reasoning traces and a per-reply line of model, the provider that served it, tokens (thinking tokens named), cost and latency, a searchable model picker over the catalog, and per-conversation settings — model, system prompt, temperature, max tokens, plus **Routing** (the model's provider roster with an order / only / skip pick per provider, and the gateway's routing preferences), **Sampling** and **Reasoning** sections that show only the controls the chosen model supports. A reply the gateway reported no cost for shows an estimate from catalog pricing, marked `~`; the header carries the conversation's spend across every branch.

Messages form a tree: each message records its parent, so a conversation can branch (alternative replies, edits) while `activeLeafId` marks the branch in view. The path from the root to the active leaf is the history sent to the model. In the client, **Retry** on a reply and **Edit** on a message each send the user message again under the same parent — a new branch with its own reply — and a message with alternatives shows a **‹ 2/3 ›** switch that moves `activeLeafId` to that branch's newest leaf.

### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/conversations` | GET | List conversations, most recently active first |
| `/api/conversations` | POST | Create — `{ title?, model?, systemPrompt?, params? }` |
| `/api/conversations/:id` | GET | The conversation with its whole message tree; `generating: true` while a reply is streaming |
| `/api/conversations/:id` | PATCH | Update title / model / system prompt / params (a JSON Merge Patch — see below), or move `activeLeafId` |
| `/api/conversations/:id` | DELETE | Delete the conversation and its messages |
| `/api/models` | GET | The OpenRouter catalog (`?q=` searches it, `?refresh=1` bypasses the 5-minute cache); each model carries `supportedParameters` and, for thinking models, `reasoning` (`mandatory`, `defaultEnabled`, `supportedEfforts`, `defaultEffort`, `supportsMaxTokens`). **Batch-only models are left out** — see below |
| `/api/models/:author/:slug/endpoints` | GET | A model's provider roster — provider slug, pricing, quantization, recent latency / throughput / uptime per endpoint — cached like the catalog (`?refresh=1` bypasses it); `404` for a model the gateway does not know |
| `/health` | GET | Includes `chat: { configured, defaultModel }` |

`params` are the generation settings for the conversation: `temperature`, `maxTokens`, `topP`, `frequencyPenalty`, `presencePenalty`, `stop`, and `tools` (default on; `false` makes the conversation plain chat) — plus OpenRouter's extensions, forwarded as the gateway expects them:

- `routing` becomes the request's `provider` object: `order` / `only` / `ignore` (provider slugs, as the endpoints route lists them), `allowFallbacks`, `requireParameters`, `dataCollection`, `zdr`, `quantizations`, `sort`, `maxPrice`, `preferredMinThroughput`, `preferredMaxLatency`; `fallbackModels` becomes the top-level `models` list. With tools on, `requireParameters` is forced on unless set, so the gateway never routes to a provider that would drop them.
- `sampling` becomes top-level `top_k`, `min_p`, `top_a`, `repetition_penalty` and `seed`; the gateway ignores any the provider cannot honour.
- `serviceTier` becomes `service_tier`, choosing which class of endpoint serves the turn: `flex` is cheaper and slower, and is **refused rather than falling back** to a standard endpoint; `priority` is faster at a premium. Unset takes the standard tier. It is deliberately not gated on `supported_parameters` — no model lists it, because it selects an endpoint rather than asking the model for anything. What gates it instead is the model's own provider roster; see below.
- `reasoning` becomes the `reasoning` object: `effort` or `maxTokens` (a budget wins, is clamped to 1024–128000, and `max_tokens` is raised to leave room for it), `exclude`, `enabled`. A model whose catalog record advertises a `defaultEffort` reasons at it whenever the conversation sets nothing under `reasoning`; `{ "enabled": false }` turns that off.

A PATCH applies `params` as a [JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7386): nested objects merge field by field and `null` clears a field, so `{ "params": { "routing": { "zdr": true } } }` sets one preference and leaves the rest, and `{ "params": { "reasoning": null } }` removes the reasoning settings. The per-turn `params` on `chat:send` merge over the conversation's the same way.

### Socket events

Send `chat:send` with `{ conversationId, content, parentId?, model?, params? }` — `parentId` defaults to the active leaf; a message id branches under that message, and `null` starts a new branch at the root. The reply streams back to everyone in the conversation's room (join with `chat:join`):

| Event | Payload |
|-------|---------|
| `chat:message` | `{ conversationId, message }` — a stored message: the user's, an assistant turn that called tools, or a tool result |
| `chat:start` | `{ conversationId, messageId, parentId, model }` |
| `chat:token` | `{ conversationId, messageId, token }` |
| `chat:reasoning` | `{ conversationId, messageId, text }` — thinking-model traces |
| `chat:tool_start` | `{ conversationId, messageId, callId, name, args, iteration }` — a tool call is running |
| `chat:tool_end` | `{ conversationId, messageId, callId, name, isError, durationMs, iteration }` |
| `chat:complete` | `{ conversationId, message }` — the stored assistant message, with token usage, cost and latency |
| `chat:error` | `{ conversationId, error, messageId?, message? }` |

`chat:cancel` with `{ conversationId }` stops a reply in progress; what streamed so far is kept.

Try it end to end with a running server: `npm run smoke:chat --prefix server`. To see the reasoning default at work, `npm run probe:reasoning --prefix server -- --model <id>` runs one turn each with nothing set, with `reasoning.enabled = false`, and with an explicit effort, and reports the reasoning tokens for each.

### Tools

The model can call tools during a turn. The loop runs up to 8 provider calls, executing every requested tool in between and feeding the results back; the 9th call is forced to answer in text. Tool calls, their results and the final reply are stored as messages in the conversation tree, so the next turn sees them.

| Tool | What it does |
|------|--------------|
| `list_workflows` | The stored workflows with their folders, ids, node counts and input-node names |
| `run_workflow` | Runs a stored workflow by name, `Folder/Name` or id — `inputs` is an object keyed by input-node name — and returns its output plus a per-node roll-call |
| `calculate` | Evaluates an arithmetic expression |
| `current_time` | The current time in UTC and, optionally, an IANA time zone |

A tool never throws at the model: unknown tools, bad arguments and failures come back as error results it can act on. Results are capped at 120K characters in the loop and 16K characters in storage. Prompt nodes inside a workflow go through the same gateway and key as chat.

Live smoke: `npm run smoke:tools --prefix server` (creates a small workflow, has the model run it, then cleans up).

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Space + Drag` | Pan canvas |
| `Ctrl + Drag` | Multi-select |
| `Delete` | Remove selected |
| `Cmd+Enter` | Run workflow |

## Environment Variables

The server and the client read **different files**, and neither reads a `.env` at the repo root:

- **`server/.env`** — everything below except `VITE_WS_URL`. The server loads it with `import 'dotenv/config'`, which resolves against the working directory, and every script that starts the server does `cd server` first. Start from `server/.env.example`.
- **`client/.env`** — the `VITE_*` variables only. Vite reads its own root; no `envDir` is configured. Not needed in development, where the dev server proxies `/api`, `/health` and `/socket.io` to port 3001.

| Variable | File | Description |
|----------|------|-------------|
| `OPENROUTER_API_KEY` | `server/.env` | OpenRouter API key — chat **and** workflow prompt nodes; it is the only model provider. Without it the chat routes answer `503` and a run fails before its first prompt node |
| `OPENROUTER_DEFAULT_MODEL` | `server/.env` | Model for new conversations (default: `openai/gpt-4o-mini`) |
| `DATABASE_PATH` | `server/.env` | SQLite database path. Relative paths resolve against `server/` (default: `./data/joseki.db`) |
| `PORT` | `server/.env` | Server port (default: 3001) |
| `CLIENT_URL` | `server/.env` | Frontend origin for CORS (default: `http://localhost:5173`) |
| `VITE_WS_URL` | `client/.env` | Socket.io origin, if not the default `ws://localhost:3001` |

## Schema changes

A database carries its own version in SQLite's `user_version`, and opening it brings it forward — the server, `db:init` and the tests all migrate on connect, so no database is ever a schema behind the code that opens it. `npm run db:migrate` is that same step run on its own, and it says what it did:

```
Migrating database at: .../server/data/joseki.db
  1. messages: the columns the table grew after it first shipped
  2. execution_traces: index by run, in the order a run reads them
Schema version 0 -> 2.
```

To change the schema, append a migration to `server/src/db/migrations.ts` — never edit a `CREATE TABLE` in `database.ts`, because an edit there reaches only databases that do not exist yet. Version 0 is that frozen baseline. Each migration and the version stamp recording it commit together, so a step that throws rolls back and the version still names the last step that finished; fix the step and run again and it picks up where it stopped.

## Architecture

Joseki consists of three main components:

1. **Visual Editor** (`client/`): React-based node editor built with React Flow
2. **Execution Engine** (`server/`): Node.js backend for workflow execution
3. **Shared Types** (`shared/`): Workflow/node/execution types shared by client and server

## Acknowledgments

- [React Flow](https://reactflow.dev) - For the node-based UI components
