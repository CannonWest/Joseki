import { Router } from 'express';
import type { ChatParams } from '@maestroai/shared';
import { ChatService } from '../chat/service';
import { Database, ConversationPatch } from '../db/database';

export function conversationRoutes(db: Database, chat: ChatService): Router {
  const router = Router();

  // List conversations, most recently active first
  router.get('/', (req, res) => {
    res.json(db.getAllConversations());
  });

  // Create a conversation
  router.post('/', (req, res) => {
    const body = req.body ?? {};
    const conversation = chat.createConversation({
      title: optionalString(body.title),
      model: optionalString(body.model),
      systemPrompt: optionalString(body.systemPrompt),
      params: isRecord(body.params) ? (body.params as ChatParams) : undefined
    });
    res.status(201).json(conversation);
  });

  // A conversation with its whole message tree
  router.get('/:id', (req, res) => {
    const conversation = db.getConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    res.json({
      ...conversation,
      messages: db.getMessages(conversation.id),
      generating: chat.isGenerating(conversation.id)
    });
  });

  // Update title / model / system prompt / params, or move the active leaf
  router.patch('/:id', (req, res) => {
    const conversation = db.getConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const body = req.body ?? {};
    const patch: ConversationPatch = {};
    if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim();
    if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim();
    if (body.systemPrompt === null || typeof body.systemPrompt === 'string') {
      patch.systemPrompt = typeof body.systemPrompt === 'string' && body.systemPrompt.trim()
        ? body.systemPrompt
        : null;
    }
    if (isRecord(body.params)) patch.params = { ...conversation.params, ...body.params };
    if (body.activeLeafId === null) {
      patch.activeLeafId = null;
    } else if (typeof body.activeLeafId === 'string') {
      const leaf = db.getMessage(body.activeLeafId);
      if (!leaf || leaf.conversationId !== conversation.id) {
        return res.status(400).json({ error: 'activeLeafId does not belong to this conversation' });
      }
      patch.activeLeafId = leaf.id;
    }

    res.json(db.updateConversation(conversation.id, patch));
  });

  // Delete a conversation and its messages
  router.delete('/:id', (req, res) => {
    if (chat.isGenerating(req.params.id)) {
      return res.status(409).json({ error: 'A reply is being generated — cancel it first' });
    }
    db.deleteConversation(req.params.id);
    res.status(204).send();
  });

  return router;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
