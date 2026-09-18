import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { Database } from './db/database';
import { workflowRoutes } from './handlers/workflows';
import { folderRoutes } from './handlers/folders';
import { executionRoutes } from './handlers/executions';
import { conversationRoutes } from './handlers/conversations';
import { modelRoutes } from './handlers/models';
import { setupSocketHandlers } from './handlers/socket';
import { setupChatHandlers } from './handlers/chat';
import { OpenRouterProvider, DEFAULT_CHAT_MODEL } from './providers/openrouter';
import { ChatService } from './chat/service';
import { createDefaultRegistry } from './tools/builtins';

const app = express();
const httpServer = createServer(app);
// Dev runs the client on its own Vite origin (CLIENT_URL, default 5173)
// against this server, so the socket needs an explicit cross-origin allow.
// Production serves the built client from this same origin (see the static
// block below), so NODE_ENV is checked first — `.env`'s CLIENT_URL is a
// dev-time value that stays set in production too, and would otherwise
// always win over the production case through a plain `||` fallback.
// `true` reflects the request's own origin, which is what "no cross-origin
// case left" means here, rather than a second hardcoded origin to keep in
// sync.
const io = new Server(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? true : (process.env.CLIENT_URL || 'http://localhost:5173'),
    methods: ['GET', 'POST']
  }
});

// Initialize database
const db = new Database(process.env.DATABASE_PATH || './data/joseki.db');

// Chat runs through OpenRouter. Without a key the workflow side is unaffected
// and the chat routes answer 503.
const openRouter = OpenRouterProvider.fromEnv();
if (!openRouter) {
  console.warn('OPENROUTER_API_KEY is not set — chat is disabled');
}
const defaultChatModel = process.env.OPENROUTER_DEFAULT_MODEL || DEFAULT_CHAT_MODEL;
const chat = new ChatService(db, openRouter, {
  defaultModel: defaultChatModel,
  tools: createDefaultRegistry()
});

// Middleware
app.use(cors());
app.use(express.json());

// Attach database to requests
app.use((req, res, next) => {
  (req as any).db = db;
  next();
});

// Routes
app.use('/api/workflows', workflowRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/executions', executionRoutes);
app.use('/api/conversations', conversationRoutes(db, chat));
app.use('/api/models', modelRoutes(openRouter));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    chat: { configured: chat.isConfigured(), defaultModel: defaultChatModel }
  });
});

// Socket.io handlers
setupSocketHandlers(io, db);
setupChatHandlers(io, chat);

// Production mode serves the built client from this same origin/port,
// instead of the dev setup's separate Vite server on 5173. socket.io
// attaches its own request listener ahead of Express (see setupSocketHandlers
// above), so /socket.io/* never reaches this catch-all.
if (process.env.NODE_ENV === 'production') {
  const clientDistPath = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientDistPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Joseki server running on port ${PORT}`);
});

export { db, io };
