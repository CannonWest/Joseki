// Model defaults shared by the client, the server and the example workflow.
// Kept apart from index.ts so exampleWorkflow.ts can import them without a
// runtime cycle through the package entry.

/** The model a new prompt node starts with — an OpenRouter slug, like every model id in a workflow. */
export const DEFAULT_WORKFLOW_MODEL = 'openai/gpt-4o-mini';
