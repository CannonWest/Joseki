/**
 * Stepflow Import Validation Schema
 *
 * Zod schema for validating imported Stepflow workflows.
 * Covers $step, $input, $variable, $template, $literal, $from value expressions,
 * on_error handlers, must_execute, and the overall workflow structure.
 */

import { z } from 'zod';

// ============================================
// Value Expressions
// ============================================

/**
 * Recursive value expression type covering all Stepflow reference types:
 * - $step: Reference another step's output
 * - $input: Reference workflow input
 * - $variable: Reference a runtime variable
 * - $template: Template string with embedded references
 * - $literal: Escape hatch to prevent expression expansion
 * - $from: Reference from another workflow or step
 */
const stepflowValueExpr: z.ZodType<any> = z.lazy(() =>
  z.union([
    // Primitive types
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    
    // Step reference: { $step: "step_id", path: "$.field" }
    z.object({ 
      $step: z.string().min(1, 'Step reference cannot be empty'),
      path: z.string().optional()
    }),
    
    // Input reference: { $input: "$" } or { $input: "fieldName" }
    z.object({ 
      $input: z.string().min(1, 'Input reference cannot be empty')
    }),
    
    // Variable reference: { $variable: "varName", default: "fallback" }
    z.object({ 
      $variable: z.string().min(1, 'Variable name cannot be empty'),
      default: z.any().optional()
    }),
    
    // Template: { $template: "Hello {{$step.step1}}" }
    z.object({ 
      $template: z.string().min(1, 'Template cannot be empty')
    }),
    
    // Literal escape: { $literal: { "$input": "not_a_reference" } }
    z.object({ 
      $literal: z.any()
    }),
    
    // From reference: { $from: { workflow: { path: "..." }, step: "..." } }
    z.object({
      $from: z.object({
        workflow: z.object({ path: z.string() }).optional(),
        step: z.string().optional(),
        path: z.string().optional()
      })
    }),
    
    // Recursive types
    z.array(stepflowValueExpr),
    z.record(stepflowValueExpr)
  ])
);

// ============================================
// Error Handler
// ============================================

const stepflowErrorHandler = z.object({
  // Stepflow native format
  type: z.enum(['retry', 'default', 'fail']).optional(),
  max_attempts: z.number().int().positive().optional()
    .describe('Maximum retry attempts (for type: retry)'),
  value: z.any().optional()
    .describe('Default value (for type: default)'),
  
  // Legacy MaestroAI export format (for backward compatibility)
  action: z.enum(['retry', 'skip', 'fail']).optional(),
  max_retries: z.number().int().positive().optional()
});

// ============================================
// Step
// ============================================

const stepflowStep = z.object({
  id: z.string()
    .min(1, 'Step id cannot be empty')
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 
      'Step id must start with letter or underscore, contain only alphanumeric and underscores'),
  
  component: z.string()
    .min(1, 'Step component cannot be empty')
    .regex(/^\/[a-zA-Z0-9_\-\/]+$/, 
      'Component must be a valid path starting with /'),
  
  input: z.record(stepflowValueExpr)
    .optional()
    .default({})
    .describe('Input parameters for the component'),
  
  on_error: stepflowErrorHandler.optional()
    .describe('Error handling configuration'),
  
  must_execute: z.boolean().optional()
    .describe('If true, step must execute even if not referenced by output'),
  
  metadata: z.record(z.any()).optional()
    .describe('Optional metadata for the step')
});

// ============================================
// Schema Properties
// ============================================

const stepflowSchemaProperty = z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object']),
  description: z.string().optional(),
  default: z.any().optional()
});

// ============================================
// Input Schema
// ============================================

const stepflowInputSchema = z.object({
  type: z.literal('object'),
  properties: z.record(stepflowSchemaProperty).optional(),
  required: z.array(z.string()).optional()
});

// ============================================
// Batch Schema (for batch execution)
// ============================================

const stepflowBatchSchema = z.object({
  type: z.literal('array'),
  items: z.object({
    type: z.literal('object'),
    properties: z.record(stepflowSchemaProperty).optional(),
    required: z.array(z.string()).optional()
  })
});

// ============================================
// Workflow
// ============================================

export const stepflowWorkflowSchema = z.object({
  // Schema URI - recommended but not strictly required
  schema: z.literal('https://stepflow.org/schemas/v1/flow.json')
    .optional()
    .describe('Stepflow schema URI (recommended for validation)'),
  
  name: z.string()
    .min(1, 'Workflow name is required')
    .max(256, 'Workflow name too long (max 256 characters)')
    .describe('Human-readable workflow name'),
  
  description: z.string()
    .max(4096, 'Description too long (max 4096 characters)')
    .optional()
    .describe('Optional workflow description'),
  
  // Stepflow canonical format - schemas.input
  schemas: z.object({
    input: stepflowInputSchema.optional()
      .describe('Input schema for workflow validation'),
    batch: stepflowBatchSchema.optional()
      .describe('Batch execution schema for parallel processing')
  }).optional(),
  
  // Legacy MaestroAI export format (for backward compatibility on import)
  input_schema: stepflowInputSchema.optional()
    .describe('Legacy input schema format (deprecated, use schemas.input)'),
  
  steps: z.array(stepflowStep)
    .min(1, 'Workflow must have at least one step')
    .refine(
      steps => {
        // Check for duplicate step IDs
        const ids = steps.map(s => s.id);
        return new Set(ids).size === ids.length;
      },
      { message: 'Duplicate step IDs found' }
    )
    .describe('Ordered list of workflow steps'),
  
  output: stepflowValueExpr.optional()
    .describe('Flow-level output expression')
});

// ============================================
// Configuration Schema
// ============================================

export const stepflowConfigSchema = z.object({
  plugins: z.record(z.object({
    type: z.enum(['builtin', 'stepflow', 'mcp']),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    url: z.string().url().optional()
  })),
  
  routes: z.record(z.array(z.object({
    plugin: z.string()
  }))),
  
  stateStore: z.object({
    type: z.enum(['sqlite', 'postgres', 'memory']),
    databaseUrl: z.string().optional(),
    autoMigrate: z.boolean().optional()
  }).optional()
});

// ============================================
// Type Exports
// ============================================

export type ValidatedStepflowWorkflow = z.infer<typeof stepflowWorkflowSchema>;
export type ValidatedStepflowConfig = z.infer<typeof stepflowConfigSchema>;
export type ValidatedStepflowStep = z.infer<typeof stepflowStep>;
export type ValidatedStepflowErrorHandler = z.infer<typeof stepflowErrorHandler>;

// ============================================
// Validation Functions
// ============================================

/**
 * Validation result type
 */
export interface ValidationResult {
  valid: boolean;
  data?: ValidatedStepflowWorkflow;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a parsed object against the Stepflow workflow schema.
 * Returns structured errors if invalid, warnings for non-critical issues.
 */
export function validateStepflowImport(data: unknown): ValidationResult {
  const warnings: string[] = [];
  
  // Check for missing schema (warning, not error)
  if (typeof data === 'object' && data !== null && !('schema' in data)) {
    warnings.push('Missing schema URI (https://stepflow.org/schemas/v1/flow.json). ' +
      'Validation may not catch all compatibility issues.');
  }
  
  // Check for legacy input_schema (warning)
  if (typeof data === 'object' && data !== null && ('input_schema' in data)) {
    warnings.push('Using deprecated input_schema. Consider migrating to schemas.input.');
  }
  
  const result = stepflowWorkflowSchema.safeParse(data);
  
  if (result.success) {
    const validatedData = result.data;
    
    // Additional semantic validation
    // Check that $step references point to existing steps
    const stepIds = new Set(validatedData.steps.map(s => s.id));
    const missingRefs: string[] = [];
    
    function findMissingRefs(obj: any, path: string = '') {
      if (typeof obj !== 'object' || obj === null) return;
      
      if ('$step' in obj && typeof obj.$step === 'string') {
        if (!stepIds.has(obj.$step)) {
          missingRefs.push(`$step: "${obj.$step}" at ${path || 'output'}`);
        }
      }
      
      for (const [key, value] of Object.entries(obj)) {
        findMissingRefs(value, path ? `${path}.${key}` : key);
      }
    }
    
    // Check step inputs
    for (const step of validatedData.steps) {
      findMissingRefs(step.input, `step.${step.id}.input`);
    }
    
    // Check output
    if (validatedData.output) {
      findMissingRefs(validatedData.output, 'output');
    }
    
    if (missingRefs.length > 0) {
      return {
        valid: false,
        errors: [`Missing step references: ${missingRefs.join(', ')}`],
        warnings
      };
    }
    
    return {
      valid: true,
      data: validatedData,
      errors: [],
      warnings
    };
  }
  
  const errors = result.error.issues.map(
    (issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
      return `${path}: ${issue.message}`;
    }
  );
  
  return {
    valid: false,
    errors,
    warnings
  };
}

/**
 * Validate Stepflow configuration file
 */
export function validateStepflowConfig(data: unknown): { 
  valid: boolean; 
  data?: ValidatedStepflowConfig; 
  errors: string[] 
} {
  const result = stepflowConfigSchema.safeParse(data);
  
  if (result.success) {
    return {
      valid: true,
      data: result.data,
      errors: []
    };
  }
  
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`
  );
  
  return {
    valid: false,
    errors
  };
}

/**
 * Check workflow compatibility with specific Stepflow features
 */
export function checkCompatibility(workflow: ValidatedStepflowWorkflow): {
  supportedFeatures: string[];
  unsupportedFeatures: string[];
  recommendations: string[];
} {
  const supportedFeatures: string[] = [];
  const unsupportedFeatures: string[] = [];
  const recommendations: string[] = [];
  
  // Check for $literal usage
  const hasLiteral = workflow.steps.some(s => 
    JSON.stringify(s.input).includes('"$literal"')
  );
  if (hasLiteral) {
    supportedFeatures.push('$literal expressions');
  }
  
  // Check for must_execute
  const hasMustExecute = workflow.steps.some(s => s.must_execute);
  if (hasMustExecute) {
    supportedFeatures.push('must_execute flag');
  }
  
  // Check for batch schema
  if (workflow.schemas?.batch) {
    supportedFeatures.push('batch execution');
    recommendations.push('Use stepflow run --batch=batch.json for parallel execution');
  }
  
  // Check for templates
  const hasTemplates = workflow.steps.some(s => 
    JSON.stringify(s.input).includes('"$template"')
  );
  if (hasTemplates) {
    supportedFeatures.push('$template expressions');
  }
  
  // Check for error handlers
  const hasErrorHandlers = workflow.steps.some(s => s.on_error);
  if (hasErrorHandlers) {
    supportedFeatures.push('Error handling (retry/default/fail)');
  }
  
  // Check for external plugins
  const builtinOnly = workflow.steps.every(s => 
    s.component.startsWith('/builtin/')
  );
  if (!builtinOnly) {
    const externalPlugins = new Set(
      workflow.steps
        .map(s => s.component.split('/')[1])
        .filter(p => p && p !== 'builtin')
    );
    supportedFeatures.push(`External plugins: ${Array.from(externalPlugins).join(', ')}`);
    recommendations.push('Ensure stepflow-config.yml includes plugin configurations');
  }
  
  // Flow-level output
  if (workflow.output) {
    supportedFeatures.push('Flow-level output');
  }
  
  return {
    supportedFeatures,
    unsupportedFeatures,
    recommendations
  };
}
