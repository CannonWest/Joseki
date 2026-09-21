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
import { allowedOrigin } from './origin';

const app = express();
const httpServer = createServer(app);
const production = process.env.NODE_ENV === 'production';

// The pages allowed to talk to this server besides its own. Dev runs the
// client on its own Vite origin (CLIENT_URL, default 5173) against this
// server, so that one origin is let in. Production serves the built client
// from this same origin (see the static block below) and has no other page
// to let in — NODE_ENV is checked first because `.env`'s CLIENT_URL is a
// dev-time value that stays set in production too.
const otherOrigins = production ? [] : [process.env.CLIENT_URL || 'http://localhost:5173'];

// CORS only says what a page may read; a WebSocket handshake ignores it, so
// the socket checks the origin itself — see allowedOrigin. Production used
// to reflect any origin here, which let any page open a socket and start runs.
const io = new Server(httpServer, {
  cors: production ? undefined : { origin: otherOrigins, methods: ['GET', 'POST'] },
  allowRequest: (req, callback) => {
    callback(null, allowedOrigin(req.headers.origin, req.headers.host, otherOrigins));
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

// Middleware. The client reaches /api through the Vite proxy in development
// and from its own origin in production, so no other page needs to read the
// API; `cors()` with no options told every page it could.
app.use(cors({ origin: otherOrigins }));
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

// Loopback unless told otherwise. Everything that talks to this process — the
// Vite dev proxy, a tunnel, a health probe — runs on the same machine, and the
// API has no authentication of its own: listening on every interface hands
// all of it, the model key's spending included, to anyone on the local
// network. HOST=0.0.0.0 opts back in, for a container or a trusted LAN.
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '127.0.0.1';
httpServer.listen(PORT, HOST, () => {
  console.log(`Joseki server running on http://${HOST}:${PORT}`);
});

export { db, io };
