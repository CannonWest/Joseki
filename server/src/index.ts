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
import { stepflowRoutes } from './handlers/stepflow';
import { setupSocketHandlers } from './handlers/socket';

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
app.use('/api', stepflowRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Socket.io handlers
setupSocketHandlers(io, db);

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`MaestroAI server running on port ${PORT}`);
});

export { db, io };
