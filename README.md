# ConvChain Studio

A visual IDE for building conversational AI workflows with tree-based branching and multi-model evaluation.

<p align="center">
  <strong>Powered by <a href="https://stepflow.org">Stepflow</a></strong> — 
  An open protocol for GenAI workflows
</p>

## Features

- **Visual Canvas**: Drag-and-drop workflow builder with React Flow
- **Node Types**: Prompt, Branch, Aggregate, Human Gate, Model Compare
- **Real-time Execution**: WebSocket streaming with live token output
- **Time-travel Debugging**: Branch from any point in execution history
- **Model Comparison**: Compare outputs from multiple LLMs side-by-side
- **Stepflow Integration**: Export/import workflows in Stepflow format
- **Dark Mode**: Optimized for long coding sessions

## Quick Start

```bash
# Clone the repository
git clone https://github.com/[your-username]/convchain-studio.git
cd convchain-studio

# Install dependencies
npm install

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
convchain-studio/
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
4. **Execute**: Press `Cmd+Enter` to run the workflow
5. **Export**: Click "⚡ Stepflow" to export to Stepflow format

## Stepflow Integration

ConvChain Studio generates workflows compatible with the [Stepflow](https://stepflow.org) protocol.

### Export to Stepflow

Any workflow can be exported as Stepflow YAML or JSON:

```bash
# Download YAML
curl http://localhost:3001/api/workflows/:id/stepflow/yaml

# Download JSON
curl http://localhost:3001/api/workflows/:id/stepflow/json
```

### Import from Stepflow

Import existing Stepflow workflows into the visual editor:

```bash
POST /api/stepflow/import
Content-Type: application/json

{
  "schema": "https://stepflow.org/schemas/v1/flow.json",
  "name": "My Workflow",
  "steps": [...]
}
```

### Run with Stepflow CLI

If you have the Stepflow CLI installed, you can run workflows directly:

```bash
# Install Stepflow CLI
cargo install stepflow

# Run via API
POST /api/workflows/:id/stepflow/run
```

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

ConvChain Studio consists of three main components:

1. **Visual Editor** (`client/`): React-based node editor built with React Flow
2. **Execution Engine** (`server/`): Node.js backend for workflow execution
3. **Stepflow Bridge** (`shared/`): Converts between visual graphs and Stepflow YAML

The Stepflow protocol enables:
- Portable workflow definitions
- Execution on Stepflow's Rust runtime
- Integration with Stepflow's component ecosystem

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

### Attribution

This project generates workflow configurations compatible with [Stepflow](https://stepflow.org), 
an open-source protocol and runtime for GenAI workflows by DataStax Inc., also licensed under 
Apache License 2.0.

See [NOTICE](NOTICE) file for complete attribution.

## Acknowledgments

- [Stepflow](https://stepflow.org) - For the open workflow protocol
- [React Flow](https://reactflow.dev) - For the node-based UI components
- [DataStax](https://datastax.com) - For developing and open-sourcing Stepflow

## Links

- **ConvChain Studio**: [GitHub Repository](https://github.com/[your-username]/convchain-studio)
- **Stepflow**: [Website](https://stepflow.org) | [GitHub](https://github.com/stepflow-ai/stepflow)
- **Documentation**: [Stepflow Docs](https://stepflow.org/docs)

---

<p align="center">
  Built with ❤️ for the AI workflow community
</p>
