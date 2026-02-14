/**
 * Example workflow: Content Review Pipeline
 *
 * Demonstrates a realistic AI orchestration with 6 node types:
 * Input → Prompt (Draft) → Branch (Quality) → Prompt (Revision) → Aggregate → Human Gate → Output
 *
 * Users can load this from the welcome screen to explore MaestroAI's capabilities.
 */

import type {
  Workflow,
  WorkflowNode,
  WorkflowEdge,
  PromptConfig,
  BranchConfig,
  AggregateConfig,
  HumanGateConfig,
} from './index';

// Stable IDs for deterministic Handlebars template references
const INPUT_ID = 'example_input';
const DRAFT_ID = 'example_draft';
const BRANCH_ID = 'example_quality_check';
const REVISION_ID = 'example_revision';
const AGGREGATE_ID = 'example_merge';
const GATE_ID = 'example_editor_review';
const OUTPUT_ID = 'example_output';

export function createExampleWorkflow(): Workflow {
  const nodes: WorkflowNode[] = [
    {
      id: INPUT_ID,
      type: 'input',
      position: { x: 375, y: 30 },
      data: {
        label: 'Article Text',
        config: {
          inputType: 'text',
          required: true,
          description: 'Paste an article or document to summarize and review',
        },
      },
    },
    {
      id: DRAFT_ID,
      type: 'prompt',
      position: { x: 345, y: 180 },
      data: {
        label: 'Draft Summary',
        config: {
          systemPrompt:
            'You are a skilled editor. Summarize the provided article in 2-3 concise paragraphs. ' +
            'Focus on the key points and maintain an objective tone.',
          userPrompt: '{{input}}',
          model: 'gpt-4',
          temperature: 0.5,
          maxTokens: 1024,
        } as PromptConfig,
      },
    },
    {
      id: BRANCH_ID,
      type: 'branch',
      position: { x: 375, y: 375 },
      data: {
        label: 'Quality Check',
        config: {
          condition: '1 == 0',
          branches: [
            { id: 'true', label: 'High Quality (skip revision)', condition: 'true' },
            { id: 'false', label: 'Needs Revision', condition: 'false' },
          ],
        } as BranchConfig,
      },
    },
    {
      id: REVISION_ID,
      type: 'prompt',
      position: { x: 570, y: 540 },
      data: {
        label: 'Revision',
        config: {
          systemPrompt:
            'You are a senior editor. The following draft summary needs improvement. ' +
            'Rewrite it to be clearer, more concise, and more accurate. ' +
            'Preserve all key facts while improving readability.',
          userPrompt: '{{nodes.' + DRAFT_ID + '.output}}',
          model: 'gpt-4-turbo',
          temperature: 0.3,
          maxTokens: 1024,
        } as PromptConfig,
      },
    },
    {
      id: AGGREGATE_ID,
      type: 'aggregate',
      position: { x: 375, y: 705 },
      data: {
        label: 'Merge Results',
        config: {
          strategy: 'concat',
          separator: '\n',
        } as AggregateConfig,
      },
    },
    {
      id: GATE_ID,
      type: 'human_gate',
      position: { x: 375, y: 855 },
      data: {
        label: 'Editor Review',
        config: {
          instructions:
            'Review the summarized content. Edit if needed, then approve to publish.',
          allowEdit: true,
          timeout: 3600,
        } as HumanGateConfig,
      },
    },
    {
      id: OUTPUT_ID,
      type: 'output',
      position: { x: 390, y: 1005 },
      data: {
        label: 'Final Output',
        config: {},
      },
    },
  ];

  const edges: WorkflowEdge[] = [
    {
      id: 'edge_input_to_draft',
      source: INPUT_ID,
      target: DRAFT_ID,
      sourceHandle: 'output',
    },
    {
      id: 'edge_draft_to_branch',
      source: DRAFT_ID,
      target: BRANCH_ID,
    },
    {
      id: 'edge_branch_true_to_aggregate',
      source: BRANCH_ID,
      target: AGGREGATE_ID,
      sourceHandle: 'true',
    },
    {
      id: 'edge_branch_false_to_revision',
      source: BRANCH_ID,
      target: REVISION_ID,
      sourceHandle: 'false',
    },
    {
      id: 'edge_revision_to_aggregate',
      source: REVISION_ID,
      target: AGGREGATE_ID,
    },
    {
      id: 'edge_aggregate_to_gate',
      source: AGGREGATE_ID,
      target: GATE_ID,
    },
    {
      id: 'edge_gate_to_output',
      source: GATE_ID,
      target: OUTPUT_ID,
    },
  ];

  const now = Date.now();

  return {
    id: 'example-content-review-pipeline',
    name: 'Content Review Pipeline',
    nodes,
    edges,
    variables: {},
    createdAt: now,
    updatedAt: now,
  };
}
