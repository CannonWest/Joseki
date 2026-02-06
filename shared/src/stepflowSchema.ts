/**
 * Stepflow Import Validation Schema
 *
 * Zod schema for validating imported Stepflow workflows.
 * Covers $step, $input, $variable, $template, $from value expressions,
 * on_error handlers, and the overall workflow structure.
 */

import { z } from 'zod';

// Value expression — recursive, covers $step, $input, $variable, $template, $from
const stepflowValueExpr: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.object({ $step: z.string(), path: z.string().optional() }),
    z.object({ $input: z.string() }),
    z.object({ $variable: z.string(), default: z.any().optional() }),
    z.object({ $template: z.string() }),
    z.object({
      $from: z.object({
        workflow: z.object({ path: z.string() }).optional(),
        step: z.string().optional(),
        path: z.string().optional()
      })
    }),
    z.array(stepflowValueExpr),
    z.record(stepflowValueExpr)
  ])
);

const stepflowErrorHandler = z.object({
  // Stepflow native format
  type: z.enum(['retry', 'default', 'fail']).optional(),
  // Legacy MaestroAI export format
  action: z.enum(['retry', 'skip', 'fail']).optional(),
  max_retries: z.number().int().positive().optional(),
  max_attempts: z.number().int().positive().optional(),
  value: z.any().optional()
});

const stepflowStep = z.object({
  id: z.string().min(1, 'Step id cannot be empty'),
  component: z.string().min(1, 'Step component cannot be empty'),
  input: z.record(stepflowValueExpr).optional().default({}),
  on_error: stepflowErrorHandler.optional(),
  must_execute: z.boolean().optional(),
  metadata: z.record(z.any()).optional()
});

const stepflowSchemaProperty = z.object({
  type: z.string(),
  description: z.string().optional(),
  default: z.any().optional()
});

export const stepflowWorkflowSchema = z.object({
  schema: z.string().optional(),  // Not all producers include the schema URI
  name: z.string().min(1, 'Workflow name is required'),
  description: z.string().optional(),
  // Stepflow canonical format
  schemas: z.object({
    input: z.object({
      type: z.literal('object').optional(),
      properties: z.record(stepflowSchemaProperty).optional(),
      required: z.array(z.string()).optional()
    }).optional()
  }).optional(),
  // Legacy MaestroAI export format
  input_schema: z.object({
    type: z.literal('object').optional(),
    properties: z.record(stepflowSchemaProperty).optional(),
    required: z.array(z.string()).optional()
  }).optional(),
  steps: z.array(stepflowStep).min(1, 'Workflow must have at least one step'),
  output: z.any().optional()
});

export type ValidatedStepflowWorkflow = z.infer<typeof stepflowWorkflowSchema>;

/**
 * Validate a parsed object against the Stepflow workflow schema.
 * Returns structured errors if invalid.
 */
export function validateStepflowImport(
  data: unknown
): { valid: true; data: ValidatedStepflowWorkflow; errors?: undefined } | { valid: false; errors: string[]; data?: undefined } {
  const result = stepflowWorkflowSchema.safeParse(data);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`
  );
  return { valid: false, errors };
}
