# MaestroAI

A visual IDE for building conversational AI workflows with tree-based branching and multi-model evaluation.

## Features

- **Visual Canvas**: Drag-and-drop workflow builder with React Flow
- **Node Types**: Prompt, Branch, Aggregate, Human Gate, Model Compare
- **Real-time Execution**: WebSocket streaming with live token output
- **Time-travel Debugging**: Branch from any point in execution history
- **Model Comparison**: Compare outputs from multiple LLMs side-by-side
- **Dark Mode**: Optimized for long coding sessions

## Quick Start

```bash
# Clone the repository
git clone https://github.com/CannonWest/MaestroAI.git
cd MaestroAI

# Install dependencies
npm run install:all

# Setup environment
cp .env.example .env
# Edit .env with your API keys

# Initialize database
npm run db:init

# Start development server
npm run dev
```

The app will be available at:
- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## Project Structure

```
maestroai/
├── client/          # React frontend (Vite + TypeScript + Tailwind)
├── server/          # Node.js backend (Express + Socket.io)
├── shared/          # Shared types and utilities
├── LICENSE          # Apache 2.0 License
├── NOTICE           # Attribution notices
└── README.md        # This file
```

## Usage

1. **Create Workflows**: Drag nodes from the palette onto the canvas
2. **Connect Nodes**: Connect nodes by dragging between handles
3. **Configure**: Click nodes to configure prompts and parameters
4. **Validate**: Click **Validate** to check for problems before running
5. **Execute**: Press `Cmd+Enter` to run the workflow (it is saved and validated first)
6. **Share**: **Export** downloads the workflow as JSON; **Import** loads one from a file or pasted JSON

## Workflow files

**Export** saves the canvas and downloads `<name>.maestro.json`:

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

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Space + Drag` | Pan canvas |
| `Ctrl + Drag` | Multi-select |
| `Delete` | Remove selected |
| `Cmd+Enter` | Run workflow |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key (optional) |
| `DATABASE_PATH` | SQLite database path |
| `PORT` | Server port (default: 3001) |
| `CLIENT_URL` | Frontend URL for CORS |

## Architecture

MaestroAI consists of three main components:

1. **Visual Editor** (`client/`): React-based node editor built with React Flow
2. **Execution Engine** (`server/`): Node.js backend for workflow execution
3. **Shared Types** (`shared/`): Workflow/node/execution types shared by client and server

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

See [NOTICE](NOTICE) file for third-party attribution.

## Acknowledgments

- [React Flow](https://reactflow.dev) - For the node-based UI components
