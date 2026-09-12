import { Router } from 'express';
import { OpenRouterProvider, ProviderError, filterModels, isBatchOnly } from '../providers/openrouter';

const NOT_CONFIGURED = 'OpenRouter is not configured — set OPENROUTER_API_KEY';

export function modelRoutes(provider: OpenRouterProvider | null): Router {
  const router = Router();

  // The OpenRouter catalog. `q` searches id/name/description locally over the
  // cached catalog; `refresh=1` bypasses the cache.
  router.get('/', async (req, res) => {
    if (!provider) {
      return res.status(503).json({ error: NOT_CONFIGURED });
    }

    const refresh = wantsRefresh(req.query.refresh);
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    try {
      // Batch-only models are left out: this app only makes chat completions,
      // which they refuse. The provider's own catalog keeps them, so a
      // workflow stored against one is still recognised.
      const models = (await provider.listModels({}, { forceRefresh: refresh })).filter(
        (model) => !isBatchOnly(model)
      );
      res.json({ models: filterModels(models, query), total: models.length });
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  });

  // A model's provider roster — who serves it, at what price and quantization,
  // with recent latency, throughput and uptime — the data behind routing
  // preferences. Cached per model like the catalog; `refresh=1` bypasses it.
  router.get('/:author/:slug/endpoints', async (req, res) => {
    if (!provider) {
      return res.status(503).json({ error: NOT_CONFIGURED });
    }

    const modelId = `${req.params.author}/${req.params.slug}`;
    try {
      res.json(await provider.getModelEndpoints(modelId, { forceRefresh: wantsRefresh(req.query.refresh) }));
    } catch (error) {
      // 404 from the gateway means no such model; anything else is its failure.
      const status = error instanceof ProviderError && error.status === 404 ? 404 : 502;
      res.status(status).json({ error: errorMessage(error) });
    }
  });

  return router;
}

function wantsRefresh(value: unknown): boolean {
  return value === '1' || value === 'true';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
