/**
 * Example workflow: Best of Four
 *
 * The fan shape, which neither other example has: one prompt goes out to four
 * cheap models at once, and a fifth reads all four answers and picks one.
 *
 *   Input → A · B · C · D → Pick the Best → Output
 *
 * The four candidates are identical in every respect but the model they name —
 * same system prompt, same temperature, same `{{input}}` — so the only thing
 * the comparison can be measuring is the model. They are built from one list
 * below rather than written out four times, which is what keeps that true as
 * the example is edited.
 *
 * The judge is what the shape is for, and it shows the third way a prompt
 * reads what came before it. Four arrows arrive at once, and `{{input}}` is
 * only ever the first of them — so the judge names every node it wants,
 * `{{nodes.<id>.output}}`, the input node among them: it needs the prompt the
 * four were given as much as it needs their answers.
 *
 * Two deliberate choices worth knowing before trusting a verdict:
 *
 * - The judge is told A, B, C and D and never which model wrote which. The
 *   canvas holds the key instead, in the node labels, so a verdict of "B" is
 *   readable without the judge having been told a brand to prefer.
 * - It is from a fifth house, so nothing in the field is scoring its own work.
 *   The order it reads them in is fixed, though, so a judge with a position
 *   preference has the same one every run — consistent, not absent.
 *
 * The four go out at once: the executor runs every node whose arrows are
 * resolved, so the fan takes as long as its slowest arm, not the sum of
 * the four. Four cheap answers and a verdict is still cents.
 */

import type { Workflow, WorkflowNode, WorkflowEdge, PromptConfig, OutputConfig } from './index';
import { EXAMPLES_FOLDER } from './folders';

export const BEST_OF_FOUR_ID = 'example-best-of-four';

// Stable ids, so the judge's template can name each node. None carries a
// hyphen — a hyphen is subtraction to a branch condition, and though this
// example has no branch, an id the parser can read is the better habit.
const INPUT_ID = 'bestof_input';
const JUDGE_ID = 'bestof_judge';
const OUTPUT_ID = 'bestof_output';

/**
 * The field: four cheap models from four different houses, each under a
 * dollar per million output tokens. The letter is the judge's name for it
 * and the label's prefix, so the canvas reads as the key to the verdict.
 */
const CANDIDATES: ReadonlyArray<{ letter: string; id: string; label: string; model: string }> = [
  { letter: 'A', id: 'bestof_gpt_4o_mini', label: 'A · GPT-4o mini', model: 'openai/gpt-4o-mini' },
  {
    letter: 'B',
    id: 'bestof_gemini_flash_lite',
    label: 'B · Gemini 2.5 Flash Lite',
    model: 'google/gemini-2.5-flash-lite'
  },
  {
    letter: 'C',
    id: 'bestof_llama_3_3_70b',
    label: 'C · Llama 3.3 70B',
    model: 'meta-llama/llama-3.3-70b-instruct'
  },
  {
    letter: 'D',
    id: 'bestof_mistral_small',
    label: 'D · Mistral Small 3.2',
    model: 'mistralai/mistral-small-3.2-24b-instruct'
  }
];

/** Not in the field, so it is not scoring its own work. */
const JUDGE_MODEL = 'deepseek/deepseek-chat';

/** The one instruction all four get. Neutral on purpose: the model is the variable. */
const CANDIDATE_SYSTEM_PROMPT =
  'Answer the prompt as well as you can. Be accurate and direct, and say so when ' +
  'you are unsure of something rather than guessing.';

const JUDGE_SYSTEM_PROMPT =
  'You are judging four answers to the same prompt. Each was written by a ' +
  'different model, and you are not told which.\n\n' +
  'Read the prompt first, then all four answers. Pick the single best one: the ' +
  'one that actually answers what was asked, gets it right, and says it clearly. ' +
  'Length is not quality, and neither is confidence — an answer that hedges ' +
  'where the truth is uncertain beats one that is sure and wrong.\n\n' +
  'Reply in exactly this shape, and nothing else:\n\n' +
  '## Winner: <letter>\n\n' +
  '<one or two sentences on what won it>\n\n' +
  '## The answer\n\n' +
  '<the winning answer, reprinted in full and word for word>\n\n' +
  '## The others\n\n' +
  '<one short line for each of the three, saying what held it back>';

/** The prompt the four were given, then their four answers, each under its letter. */
function judgeUserPrompt(): string {
  const answers = CANDIDATES.map(
    (candidate) => `--- Answer ${candidate.letter} ---\n{{nodes.${candidate.id}.output}}`
  ).join('\n\n');
  // The prompt came in on an arrow into the candidates, not into this node, so
  // it has to be named; `{{input}}` here would be answer A and nothing else.
  return `The prompt all four were given:\n{{nodes.${INPUT_ID}.output}}\n\n${answers}`;
}

// Widths as the browser measures them: a prompt node is 256px, and an input
// or output node 150. 300 between columns leaves the four a clear gap.
const COLUMN_PITCH = 300;
const PROMPT_WIDTH = 256;
const NARROW_WIDTH = 150;
/** The middle of the fan — what the single-file nodes are centred on. */
const FAN_CENTER_X = ((CANDIDATES.length - 1) * COLUMN_PITCH + PROMPT_WIDTH) / 2;

export function createBestOfFour(): Workflow {
  const nodes: WorkflowNode[] = [
    {
      id: INPUT_ID,
      type: 'input',
      position: { x: FAN_CENTER_X - NARROW_WIDTH / 2, y: 30 },
      data: {
        label: 'Prompt',
        config: {
          inputType: 'text',
          required: true,
          description: 'A question or task. All four answer it cold, with nothing else to go on.'
        }
      }
    },
    ...CANDIDATES.map((candidate, column): WorkflowNode => ({
      id: candidate.id,
      type: 'prompt',
      position: { x: column * COLUMN_PITCH, y: 200 },
      data: {
        label: candidate.label,
        config: {
          systemPrompt: CANDIDATE_SYSTEM_PROMPT,
          // The arrow in: the prompt the run was given.
          userPrompt: '{{input}}',
          model: candidate.model,
          temperature: 0.7,
          maxTokens: 1024
        } as PromptConfig
      }
    })),
    {
      id: JUDGE_ID,
      type: 'prompt',
      position: { x: FAN_CENTER_X - PROMPT_WIDTH / 2, y: 430 },
      data: {
        label: 'Pick the Best',
        config: {
          systemPrompt: JUDGE_SYSTEM_PROMPT,
          userPrompt: judgeUserPrompt(),
          model: JUDGE_MODEL,
          // Low: the verdict should be the same one twice.
          temperature: 0.2,
          // Room to reprint the winning answer in full, not just name it.
          maxTokens: 2048
        } as PromptConfig
      }
    },
    {
      id: OUTPUT_ID,
      type: 'output',
      position: { x: FAN_CENTER_X - NARROW_WIDTH / 2, y: 650 },
      data: {
        label: 'Best Answer',
        config: { format: 'markdown' } as OutputConfig
      }
    }
  ];

  const edges: WorkflowEdge[] = [
    ...CANDIDATES.flatMap((candidate): WorkflowEdge[] => [
      {
        id: `bestof_input_to_${candidate.letter.toLowerCase()}`,
        source: INPUT_ID,
        target: candidate.id,
        sourceHandle: 'output'
      },
      {
        id: `bestof_${candidate.letter.toLowerCase()}_to_judge`,
        source: candidate.id,
        target: JUDGE_ID
      }
    ]),
    { id: 'bestof_judge_to_output', source: JUDGE_ID, target: OUTPUT_ID }
  ];

  const now = Date.now();

  return {
    id: BEST_OF_FOUR_ID,
    name: 'Best of Four',
    folder: EXAMPLES_FOLDER,
    nodes,
    edges,
    variables: {},
    createdAt: now,
    updatedAt: now
  };
}
