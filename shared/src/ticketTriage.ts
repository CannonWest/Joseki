/**
 * Example workflow: Ticket Triage
 *
 * The transform-and-variables example — six nodes: Input → Prompt (Classify)
 * → Transform (Priority) → Branch (Gate) → two Prompts (Escalate / Standard
 * Draft) → Aggregate → Output.
 *
 * It exists to show what a transform is for, and why it earns its place
 * beside a branch rather than duplicating one. A branch condition can
 * already reach into a model's JSON and read a declared variable — so
 * extraction alone would not need this node. What does is the *nested*
 * `if()`: three labels out of one computed value, which a single true/false
 * branch cannot produce in one step. The label becomes a normal node output,
 * read twice — once by the branch that routes on it, once by the escalation
 * prompt that prints it — and the model is asked exactly once, for the raw
 * urgency number. Everything after that is arithmetic against two declared
 * variables, `highThreshold` and `lowThreshold`: the same ticket always gets
 * the same priority, however many times the workflow runs.
 */

import type { Workflow, WorkflowNode, WorkflowEdge, PromptConfig, TransformConfig, BranchConfig, AggregateConfig, OutputConfig } from './index';
import { DEFAULT_WORKFLOW_MODEL } from './models';
import { EXAMPLES_FOLDER } from './folders';

export const TICKET_TRIAGE_ID = 'example-ticket-triage';

// Stable ids, no hyphen — a hyphen is subtraction to the condition parser,
// and the priority transform's expression and the gate's condition both
// depend on reading these back as plain names.
const INPUT_ID = 'triage_input';
const CLASSIFY_ID = 'triage_classify';
const PRIORITY_ID = 'triage_priority';
const GATE_ID = 'triage_gate';
const ESCALATE_ID = 'triage_escalate';
const STANDARD_ID = 'triage_standard';
const MERGE_ID = 'triage_merge';
const OUTPUT_ID = 'triage_output';

export function createTicketTriage(): Workflow {
  const nodes: WorkflowNode[] = [
    {
      id: INPUT_ID,
      type: 'input',
      position: { x: 375, y: 30 },
      data: {
        label: 'Support Ticket',
        config: {
          inputType: 'text',
          required: true,
          description: "Paste the customer's ticket text",
        },
      },
    },
    {
      id: CLASSIFY_ID,
      type: 'prompt',
      position: { x: 345, y: 180 },
      data: {
        label: 'Classify',
        config: {
          systemPrompt:
            'You triage incoming support tickets. Read the ticket and answer with strict JSON ' +
            'only, no prose, no markdown fences: {"urgency": <a number from 0.0 to 1.0>, ' +
            '"category": "<one or two words>", "summary": "<one line>"}. urgency 1.0 means the ' +
            'customer is blocked right now and losing money or access; 0.0 means no rush at all.',
          userPrompt: '{{input}}',
          model: DEFAULT_WORKFLOW_MODEL,
          temperature: 0.2,
          maxTokens: 200,
        } as PromptConfig,
      },
    },
    {
      id: PRIORITY_ID,
      type: 'transform',
      position: { x: 375, y: 330 },
      data: {
        label: 'Priority',
        config: {
          // Three labels from one computed value — the shape a boolean
          // branch cannot express in a single node.
          expression:
            'if(get(input, "urgency") > vars.highThreshold, "P1", ' +
            'if(get(input, "urgency") > vars.lowThreshold, "P2", "P3"))',
        } as TransformConfig,
      },
    },
    {
      id: GATE_ID,
      type: 'branch',
      position: { x: 375, y: 480 },
      data: {
        label: 'Gate',
        config: {
          condition: `nodes.${PRIORITY_ID} == "P1"`,
          branches: [
            { id: 'true', label: 'P1 (escalate)', condition: 'true' },
            { id: 'false', label: 'P2 / P3 (standard)', condition: 'false' },
          ],
        } as BranchConfig,
      },
    },
    {
      id: ESCALATE_ID,
      type: 'prompt',
      position: { x: 190, y: 645 },
      data: {
        label: 'Escalate Draft',
        config: {
          systemPrompt:
            "You alert an on-call support lead. Be terse: state the priority and why it's " +
            'urgent, in two or three sentences. No pleasantries.',
          userPrompt:
            `Priority: {{nodes.${PRIORITY_ID}.output}}\n` +
            `Classification: {{nodes.${CLASSIFY_ID}.output}}\n` +
            `Ticket: {{nodes.${INPUT_ID}.output}}`,
          model: DEFAULT_WORKFLOW_MODEL,
          temperature: 0.4,
          maxTokens: 300,
        } as PromptConfig,
      },
    },
    {
      id: STANDARD_ID,
      type: 'prompt',
      position: { x: 560, y: 645 },
      data: {
        label: 'Standard Draft',
        config: {
          systemPrompt:
            'You draft a brief, friendly acknowledgment reply to a customer whose ticket is not ' +
            'urgent. One short paragraph: thank them, restate their issue in one sentence, say a ' +
            'team member will follow up.',
          userPrompt: `Classification: {{nodes.${CLASSIFY_ID}.output}}\nTicket: {{nodes.${INPUT_ID}.output}}`,
          model: DEFAULT_WORKFLOW_MODEL,
          temperature: 0.6,
          maxTokens: 300,
        } as PromptConfig,
      },
    },
    {
      id: MERGE_ID,
      type: 'aggregate',
      position: { x: 375, y: 800 },
      data: {
        label: 'Merge',
        config: { strategy: 'concat', separator: '\n' } as AggregateConfig,
      },
    },
    {
      id: OUTPUT_ID,
      type: 'output',
      position: { x: 390, y: 940 },
      data: {
        label: 'Response Draft',
        config: { format: 'markdown' } as OutputConfig,
      },
    },
  ];

  const edges: WorkflowEdge[] = [
    { id: 'triage_input_to_classify', source: INPUT_ID, target: CLASSIFY_ID },
    { id: 'triage_classify_to_priority', source: CLASSIFY_ID, target: PRIORITY_ID },
    { id: 'triage_priority_to_gate', source: PRIORITY_ID, target: GATE_ID },
    { id: 'triage_gate_true_to_escalate', source: GATE_ID, target: ESCALATE_ID, sourceHandle: 'true' },
    { id: 'triage_gate_false_to_standard', source: GATE_ID, target: STANDARD_ID, sourceHandle: 'false' },
    { id: 'triage_escalate_to_merge', source: ESCALATE_ID, target: MERGE_ID },
    { id: 'triage_standard_to_merge', source: STANDARD_ID, target: MERGE_ID },
    { id: 'triage_merge_to_output', source: MERGE_ID, target: OUTPUT_ID },
  ];

  const now = Date.now();

  return {
    id: TICKET_TRIAGE_ID,
    name: 'Ticket Triage',
    folder: EXAMPLES_FOLDER,
    nodes,
    edges,
    variables: { highThreshold: 0.75, lowThreshold: 0.35 },
    createdAt: now,
    updatedAt: now,
  };
}
