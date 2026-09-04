/**
 * Copyright 2025 [Your Name]
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { Database } from './db/database';
import { workflowRoutes } from './handlers/workflows';
import { executionRoutes } from './handlers/executions';
import { conversationRoutes } from './handlers/conversations';
import { modelRoutes } from './handlers/models';
import { setupSocketHandlers } from './handlers/socket';
import { setupChatHandlers } from './handlers/chat';
import { OpenRouterProvider, DEFAULT_CHAT_MODEL } from './providers/openrouter';
import { ChatService } from './chat/service';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST']
  }
});

// Initialize database
const db = new Database(process.env.DATABASE_PATH || './data/maestroai.db');

// Chat runs through OpenRouter. Without a key the workflow side is unaffected
// and the chat routes answer 503.
const openRouter = OpenRouterProvider.fromEnv();
if (!openRouter) {
  console.warn('OPENROUTER_API_KEY is not set — chat is disabled');
}
const defaultChatModel = process.env.OPENROUTER_DEFAULT_MODEL || DEFAULT_CHAT_MODEL;
const chat = new ChatService(db, openRouter, { defaultModel: defaultChatModel });

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

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`MaestroAI server running on port ${PORT}`);
});

export { db, io };
