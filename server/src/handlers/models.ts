import { Router } from 'express';
import { OpenRouterProvider, filterModels } from '../providers/openrouter';

export function modelRoutes(provider: OpenRouterProvider | null): Router {
  const router = Router();

  // The OpenRouter catalog. `q` searches id/name/description locally over the
  // cached catalog; `refresh=1` bypasses the cache.
  router.get('/', async (req, res) => {
    if (!provider) {
      return res.status(503).json({ error: 'OpenRouter is not configured — set OPENROUTER_API_KEY' });
    }

    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    try {
      const models = await provider.listModels({}, { forceRefresh: refresh });
      res.json({ models: filterModels(models, query), total: models.length });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
