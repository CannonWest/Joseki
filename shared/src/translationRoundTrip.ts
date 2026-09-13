/**
 * Example workflow: Translation Round-Trip
 *
 * The simpler of the two shipped examples — a straight line of five nodes:
 * Input → Prompt (to French) → Prompt (back to English) → Prompt (spot the
 * drift) → Output. No branch, no gate, so it also runs from chat through the
 * run_workflow tool, which the Content Review Pipeline cannot.
 *
 * It exists to show how a prompt reads what came before it. The first
 * translation reads `{{input}}` — whatever arrived on the arrow in. The
 * second names the node it wants, `{{nodes.roundtrip_to_french.output}}`,
 * which here is the same text said the long way. The third needs both the
 * original and the round trip at once, and that is what the long way is
 * for: `{{input}}` is only ever the arrow in, and the original is two
 * nodes back.
 */

import type { Workflow, WorkflowNode, WorkflowEdge, PromptConfig, OutputConfig } from './index';
import { DEFAULT_WORKFLOW_MODEL } from './models';
import { EXAMPLES_FOLDER } from './folders';

export const TRANSLATION_ROUND_TRIP_ID = 'example-translation-round-trip';

// Stable ids, so the templates below can name their nodes. None carries a
// hyphen — a hyphen is subtraction to a branch condition, and though this
// example has no branch, an id the parser can read is the better habit.
const INPUT_ID = 'roundtrip_input';
const TO_FRENCH_ID = 'roundtrip_to_french';
const BACK_TO_ENGLISH_ID = 'roundtrip_back_to_english';
const DRIFT_ID = 'roundtrip_drift';
const OUTPUT_ID = 'roundtrip_output';

const TRANSLATOR = (language: string) =>
  `You are a professional translator. Translate the text into ${language}. ` +
  'Reply with the translation only — no preamble, no notes, no quotation marks.';

export function createTranslationRoundTrip(): Workflow {
  const nodes: WorkflowNode[] = [
    {
      id: INPUT_ID,
      type: 'input',
      position: { x: 375, y: 30 },
      data: {
        label: 'English Text',
        config: {
          inputType: 'text',
          required: true,
          description: 'A sentence or short paragraph in English',
        },
      },
    },
    {
      id: TO_FRENCH_ID,
      type: 'prompt',
      position: { x: 345, y: 180 },
      data: {
        label: 'Translate to French',
        config: {
          systemPrompt: TRANSLATOR('French'),
          // The arrow in: the text the run was given.
          userPrompt: '{{input}}',
          model: DEFAULT_WORKFLOW_MODEL,
          temperature: 0.2,
          maxTokens: 1024,
        } as PromptConfig,
      },
    },
    {
      id: BACK_TO_ENGLISH_ID,
      type: 'prompt',
      position: { x: 345, y: 345 },
      data: {
        label: 'Translate Back',
        config: {
          systemPrompt: TRANSLATOR('English'),
          // The same text as {{input}} would give — named, to show the form
          // that can reach any node, not only the arrow in.
          userPrompt: '{{nodes.' + TO_FRENCH_ID + '.output}}',
          model: DEFAULT_WORKFLOW_MODEL,
          temperature: 0.2,
          maxTokens: 1024,
        } as PromptConfig,
      },
    },
    {
      id: DRIFT_ID,
      type: 'prompt',
      position: { x: 345, y: 510 },
      data: {
        label: 'Spot the Drift',
        config: {
          systemPrompt:
            'You compare two versions of a passage. Under the heading "Round trip", ' +
            'print the second passage exactly as given. Then under the heading ' +
            '"What changed", list in two or three short bullets what shifted in ' +
            'meaning, tone or word choice between the original and the round trip — ' +
            'or say that it survived the trip intact.',
          // Two nodes' worth of text at once: the original from the input node,
          // and the round trip from the arrow in.
          userPrompt:
            'Original:\n{{nodes.' + INPUT_ID + '.output}}\n\n' +
            'After a round trip through French:\n{{input}}',
          model: DEFAULT_WORKFLOW_MODEL,
          temperature: 0.4,
          maxTokens: 1024,
        } as PromptConfig,
      },
    },
    {
      id: OUTPUT_ID,
      type: 'output',
      position: { x: 390, y: 690 },
      data: {
        label: 'Result',
        config: { format: 'markdown' } as OutputConfig,
      },
    },
  ];

  const edges: WorkflowEdge[] = [
    { id: 'roundtrip_input_to_french', source: INPUT_ID, target: TO_FRENCH_ID, sourceHandle: 'output' },
    { id: 'roundtrip_french_to_english', source: TO_FRENCH_ID, target: BACK_TO_ENGLISH_ID },
    { id: 'roundtrip_english_to_drift', source: BACK_TO_ENGLISH_ID, target: DRIFT_ID },
    { id: 'roundtrip_drift_to_output', source: DRIFT_ID, target: OUTPUT_ID },
  ];

  const now = Date.now();

  return {
    id: TRANSLATION_ROUND_TRIP_ID,
    name: 'Translation Round-Trip',
    folder: EXAMPLES_FOLDER,
    nodes,
    edges,
    variables: {},
    createdAt: now,
    updatedAt: now,
  };
}
