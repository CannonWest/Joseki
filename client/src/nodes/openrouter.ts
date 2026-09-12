import type { ChatParams, ChatParamsPatch, PromptConfig } from '@joseki/shared';
import { mergePatch } from '@joseki/shared';

/**
 * A prompt node's OpenRouter settings, in the shape the chat settings
 * sections read. The sections take a conversation's `params`; a node keeps
 * the same three bags flat on its config, so this is the view that lets one
 * set of sections serve both. `tools: false` is a fact about a node — it runs
 * a single completion, never a tool loop — and it is what keeps the routing
 * section's "forced on while tools are on" hint from showing where it would
 * be untrue.
 */
export function sectionParamsOf(config: Partial<PromptConfig>): ChatParams {
  const params: ChatParams = { tools: false };
  if (config.routing) params.routing = config.routing;
  if (config.sampling) params.sampling = config.sampling;
  if (config.reasoning) params.reasoning = config.reasoning;
  return params;
}

/**
 * The sections speak in merge patches — `{ routing: { zdr: true } }` sets one
 * preference, `{ routing: null }` clears the lot — because a conversation
 * sends them to the server to apply. A node has nowhere to send one; it
 * applies the patch to its own config, with the same function the server
 * uses, so a setting means the same thing on both surfaces.
 */
export function patchPromptConfig<T extends Partial<PromptConfig>>(config: T, patch: ChatParamsPatch): T {
  return mergePatch(config, patch);
}
