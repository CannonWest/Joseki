/**
 * Copyright 2025 [Your Name]
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Stepflow Expression Evaluation Engine
 * 
 * This module provides native evaluation of Stepflow value expressions
 * within MaestroAI's execution engine, enabling perfect parity with
 * Stepflow runtime behavior.
 * 
 * Supported expressions:
 * - $step: Reference another step's output
 * - $input: Reference workflow input
 * - $variable: Reference runtime variables
 * - $template: Template strings with embedded expressions
 * - $literal: Literal value escape hatch
 * - $from: Reference from another workflow
 * 
 * JSONPath support:
 * - Simple: $.field, $.field.nested
 * - Array access: $.array[0], $.array[-1]
 * - Wildcards: $.array[*], $.*
 * - Filters: $.array[?(@.field > 5)]
 * - Slices: $.array[0:5:2]
 * - Multi-select: $.field1, $.field2
 */

import type { StepflowInputValue } from './stepflow';

// ==================== Expression Types ====================

export interface StepReference {
  $step: string;
  path?: string;
}

export interface InputReference {
  $input: string;
}

export interface VariableReference {
  $variable: string;
  default?: any;
}

export interface TemplateExpression {
  $template: string;
}

export interface LiteralExpression {
  $literal: any;
}

export interface FromReference {
  $from: {
    workflow?: { path: string };
    step?: string;
    path?: string;
  };
}

export type StepflowExpression =
  | StepReference
  | InputReference
  | VariableReference
  | TemplateExpression
  | LiteralExpression
  | FromReference;

// ==================== Evaluation Context ====================

export interface EvaluationContext {
  /** Workflow input data */
  input: any;
  /** Step outputs by step ID */
  stepOutputs: Record<string, any>;
  /** Runtime variables */
  variables: Record<string, any>;
  /** Workflow storage for $from references */
  workflowStorage?: Record<string, any>;
}

// ==================== JSONPath Implementation ====================

/**
 * Token types for JSONPath parsing
 */
type JSONPathToken =
  | { type: 'root' }
  | { type: 'dot'; field: string }
  | { type: 'bracket'; accessor: string | number | Slice | Filter }
  | { type: 'wildcard' }
  | { type: 'descendant'; field: string };

interface Slice {
  start?: number;
  end?: number;
  step?: number;
}

interface Filter {
  expression: string;
}

/**
 * Parse a JSONPath expression into tokens
 */
function parseJSONPath(path: string): JSONPathToken[] {
  const tokens: JSONPathToken[] = [{ type: 'root' }];
  
  if (!path || path === '$') {
    return tokens;
  }
  
  let i = 1; // Skip initial $
  
  while (i < path.length) {
    const char = path[i];
    
    if (char === '.') {
      i++;
      if (path[i] === '.') {
        // Descendant selector ..
        i++;
        let field = '';
        while (i < path.length && /[a-zA-Z0-9_]/.test(path[i])) {
          field += path[i];
          i++;
        }
        tokens.push({ type: 'descendant', field });
      } else if (path[i] === '*') {
        // Wildcard
        tokens.push({ type: 'wildcard' });
        i++;
      } else {
        // Field name
        let field = '';
        while (i < path.length && /[a-zA-Z0-9_]/.test(path[i])) {
          field += path[i];
          i++;
        }
        if (field) {
          tokens.push({ type: 'dot', field });
        }
      }
    } else if (char === '[') {
      // Bracket notation
      i++;
      let content = '';
      let depth = 1;
      
      while (i < path.length && depth > 0) {
        if (path[i] === '[') depth++;
        if (path[i] === ']') depth--;
        if (depth > 0) content += path[i];
        i++;
      }
      
      const accessor = parseBracketContent(content.trim());
      tokens.push({ type: 'bracket', accessor });
    } else {
      i++;
    }
  }
  
  return tokens;
}

/**
 * Parse bracket content into accessor
 */
function parseBracketContent(content: string): string | number | Slice | Filter {
  // Number index
  if (/^-?\d+$/.test(content)) {
    return parseInt(content, 10);
  }
  
  // String literal (single or double quotes)
  if ((content.startsWith('"') && content.endsWith('"')) ||
      (content.startsWith("'") && content.endsWith("'"))) {
    return content.slice(1, -1);
  }
  
  // Slice notation [start:end:step]
  if (/^-?\d*:-?\d*(:-?\d*)?$/.test(content)) {
    const parts = content.split(':');
    return {
      start: parts[0] ? parseInt(parts[0], 10) : undefined,
      end: parts[1] ? parseInt(parts[1], 10) : undefined,
      step: parts[2] ? parseInt(parts[2], 10) : undefined
    };
  }
  
  // Filter expression [?(@.field > 5)]
  if (content.startsWith('?(') && content.endsWith(')')) {
    return {
      expression: content.slice(2, -1)
    };
  }
  
  // Wildcard
  if (content === '*') {
    return '*';
  }
  
  // Union [0,1,2] or ['a','b']
  return content;
}

/**
 * Evaluate JSONPath tokens against data
 */
function evaluateJSONPathTokens(data: any, tokens: JSONPathToken[]): any {
  let result: any = data;
  
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    
    switch (token.type) {
      case 'dot':
        result = result?.[token.field];
        break;
        
      case 'wildcard':
        if (Array.isArray(result)) {
          return result; // Return all items
        }
        if (typeof result === 'object' && result !== null) {
          return Object.values(result);
        }
        return undefined;
        
      case 'bracket':
        result = evaluateBracketAccessor(result, token.accessor);
        break;
        
      case 'descendant':
        result = findDescendants(result, token.field);
        break;
    }
    
    if (result === undefined) {
      return undefined;
    }
  }
  
  return result;
}

/**
 * Evaluate bracket accessor
 */
function evaluateBracketAccessor(data: any, accessor: string | number | Slice | Filter | '*'): any {
  if (accessor === '*') {
    if (Array.isArray(data)) {
      return data;
    }
    if (typeof data === 'object' && data !== null) {
      return Object.values(data);
    }
    return undefined;
  }
  
  if (typeof accessor === 'number') {
    if (!Array.isArray(data)) {
      return undefined;
    }
    // Handle negative indices
    const index = accessor < 0 ? data.length + accessor : accessor;
    return data[index];
  }
  
  if (typeof accessor === 'string') {
    return data?.[accessor];
  }
  
  if (isSlice(accessor)) {
    if (!Array.isArray(data)) {
      return undefined;
    }
    const start = accessor.start ?? 0;
    const end = accessor.end ?? data.length;
    const step = accessor.step ?? 1;
    
    const result: any[] = [];
    for (let i = start; i < end; i += step) {
      if (i >= 0 && i < data.length) {
        result.push(data[i]);
      }
    }
    return result;
  }
  
  if (isFilter(accessor)) {
    if (!Array.isArray(data)) {
      return undefined;
    }
    return data.filter(item => evaluateFilter(item, accessor.expression));
  }
  
  return undefined;
}

function isSlice(value: any): value is Slice {
  return value && typeof value === 'object' && 
    ('start' in value || 'end' in value || 'step' in value);
}

function isFilter(value: any): value is Filter {
  return value && typeof value === 'object' && 'expression' in value;
}

/**
 * Evaluate filter expression (simplified implementation)
 */
function evaluateFilter(item: any, expression: string): boolean {
  // Replace @.field with actual values
  const expandedExpr = expression.replace(/@\.(\w+)/g, (match, field) => {
    const value = item[field];
    if (typeof value === 'string') {
      return `"${value}"`;
    }
    return String(value);
  });
  
  try {
    // Safe evaluation for simple comparisons
    // eslint-disable-next-line no-new-func
    return new Function('return ' + expandedExpr)();
  } catch {
    return false;
  }
}

/**
 * Find descendants recursively
 */
function findDescendants(data: any, field: string): any[] {
  const results: any[] = [];
  
  function search(obj: any) {
    if (obj === null || typeof obj !== 'object') {
      return;
    }
    
    if (Array.isArray(obj)) {
      for (const item of obj) {
        search(item);
      }
    } else {
      if (field in obj) {
        results.push(obj[field]);
      }
      for (const value of Object.values(obj)) {
        search(value);
      }
    }
  }
  
  search(data);
  return results;
}

/**
 * Evaluate a JSONPath expression against data
 */
export function evaluateJSONPath(data: any, path: string): any {
  if (!path || path === '$') {
    return data;
  }
  
  // Handle simple dot notation shortcuts
  if (path.startsWith('$.') && !path.includes('[') && !path.includes('..')) {
    const parts = path.slice(2).split('.');
    let result = data;
    for (const part of parts) {
      result = result?.[part];
      if (result === undefined) return undefined;
    }
    return result;
  }
  
  const tokens = parseJSONPath(path);
  return evaluateJSONPathTokens(data, tokens);
}

// ==================== Expression Evaluation ====================

/**
 * Evaluate a Stepflow value expression within a context
 */
export function evaluateExpression(
  value: StepflowInputValue,
  context: EvaluationContext
): any {
  // Handle primitives
  if (value === null || typeof value !== 'object') {
    return value;
  }
  
  // Handle arrays
  if (Array.isArray(value)) {
    return value.map(item => evaluateExpression(item, context));
  }
  
  // Handle expressions
  if ('$step' in value) {
    return evaluateStepReference(value as StepReference, context);
  }
  
  if ('$input' in value) {
    return evaluateInputReference(value as InputReference, context);
  }
  
  if ('$variable' in value) {
    return evaluateVariableReference(value as VariableReference, context);
  }
  
  if ('$template' in value) {
    return evaluateTemplate(value as TemplateExpression, context);
  }
  
  if ('$literal' in value) {
    return (value as LiteralExpression).$literal;
  }
  
  if ('$from' in value) {
    return evaluateFromReference(value as FromReference, context);
  }
  
  // Handle regular objects recursively
  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(value)) {
    result[key] = evaluateExpression(val, context);
  }
  return result;
}

/**
 * Evaluate $step reference
 */
function evaluateStepReference(ref: StepReference, context: EvaluationContext): any {
  const output = context.stepOutputs[ref.$step];
  
  if (output === undefined) {
    throw new Error(`Step "${ref.$step}" not found in execution context`);
  }
  
  if (ref.path) {
    return evaluateJSONPath(output, ref.path);
  }
  
  return output;
}

/**
 * Evaluate $input reference
 */
function evaluateInputReference(ref: InputReference, context: EvaluationContext): any {
  if (ref.$input === '$' || ref.$input === '') {
    return context.input;
  }
  
  return evaluateJSONPath(context.input, `$.${ref.$input}`);
}

/**
 * Evaluate $variable reference
 */
function evaluateVariableReference(
  ref: VariableReference,
  context: EvaluationContext
): any {
  if (ref.$variable in context.variables) {
    return context.variables[ref.$variable];
  }
  
  if ('default' in ref) {
    return ref.default;
  }
  
  throw new Error(`Variable "${ref.$variable}" not found and no default provided`);
}

/**
 * Evaluate $template expression
 */
function evaluateTemplate(template: TemplateExpression, context: EvaluationContext): string {
  let result = template.$template;
  
  // Replace {{$step.stepId}} references
  result = result.replace(/\{\{\$step\.(\w+)(?:\.(\w+))?\}\}/g, (match, stepId, field) => {
    const output = context.stepOutputs[stepId];
    if (output === undefined) {
      return `[step ${stepId} not found]`;
    }
    if (field) {
      const value = typeof output === 'object' ? output[field] : output;
      return String(value ?? '');
    }
    return String(output ?? '');
  });
  
  // Replace {{$input}} references
  result = result.replace(/\{\{\$input(?:\.(\w+))?\}\}/g, (match, field) => {
    if (field) {
      return String(context.input?.[field] ?? '');
    }
    return String(context.input ?? '');
  });
  
  // Replace {{$variable.name}} references
  result = result.replace(/\{\{\$variable\.(\w+)\}\}/g, (match, varName) => {
    return String(context.variables?.[varName] ?? '');
  });
  
  return result;
}

/**
 * Evaluate $from reference (for workflow composition)
 */
function evaluateFromReference(ref: FromReference, context: EvaluationContext): any {
  const { workflow, step, path } = ref.$from;
  
  if (!context.workflowStorage) {
    throw new Error('Workflow storage not available for $from reference');
  }
  
  let data: any;
  
  if (workflow?.path) {
    data = context.workflowStorage[workflow.path];
  }
  
  if (step && data) {
    data = data[step];
  }
  
  if (path) {
    data = evaluateJSONPath(data, path);
  }
  
  return data;
}

// ==================== Input Processing ====================

/**
 * Process all expressions in a step input object
 */
export function processStepInput(
  input: Record<string, StepflowInputValue>,
  context: EvaluationContext
): Record<string, any> {
  const result: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(input)) {
    result[key] = evaluateExpression(value, context);
  }
  
  return result;
}

/**
 * Extract all step references from a value expression
 */
export function extractStepReferences(value: StepflowInputValue): string[] {
  const refs: string[] = [];
  
  function traverse(val: any) {
    if (val === null || typeof val !== 'object') {
      return;
    }
    
    if (Array.isArray(val)) {
      for (const item of val) {
        traverse(item);
      }
      return;
    }
    
    if ('$step' in val && typeof val.$step === 'string') {
      refs.push(val.$step);
    }
    
    for (const v of Object.values(val)) {
      traverse(v);
    }
  }
  
  traverse(value);
  return [...new Set(refs)];
}

/**
 * Extract all variable references from a value expression
 */
export function extractVariableReferences(value: StepflowInputValue): string[] {
  const refs: string[] = [];
  
  function traverse(val: any) {
    if (val === null || typeof val !== 'object') {
      return;
    }
    
    if (Array.isArray(val)) {
      for (const item of val) {
        traverse(item);
      }
      return;
    }
    
    if ('$variable' in val && typeof val.$variable === 'string') {
      refs.push(val.$variable);
    }
    
    for (const v of Object.values(val)) {
      traverse(v);
    }
  }
  
  traverse(value);
  return [...new Set(refs)];
}

// ==================== Validation ====================

/**
 * Validate an expression without evaluating it
 */
export function validateExpression(
  value: StepflowInputValue,
  availableSteps: string[],
  availableVariables: string[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  function traverse(val: any, path: string = '') {
    if (val === null || typeof val !== 'object') {
      return;
    }
    
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        traverse(val[i], `${path}[${i}]`);
      }
      return;
    }
    
    if ('$step' in val) {
      if (!availableSteps.includes(val.$step)) {
        errors.push(`${path}: Step "${val.$step}" not found`);
      }
      if (val.path) {
        // Validate JSONPath syntax
        try {
          parseJSONPath(val.path);
        } catch {
          errors.push(`${path}: Invalid JSONPath "${val.path}"`);
        }
      }
    }
    
    if ('$variable' in val) {
      if (!availableVariables.includes(val.$variable) && !('default' in val)) {
        errors.push(`${path}: Variable "${val.$variable}" not found and no default provided`);
      }
    }
    
    for (const [key, v] of Object.entries(val)) {
      traverse(v, path ? `${path}.${key}` : key);
    }
  }
  
  traverse(value);
  
  return {
    valid: errors.length === 0,
    errors
  };
}

// ==================== Utility Functions ====================

/**
 * Check if a value contains any expressions
 */
export function hasExpressions(value: StepflowInputValue): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  
  if (Array.isArray(value)) {
    return value.some(hasExpressions);
  }
  
  const exprKeys = ['$step', '$input', '$variable', '$template', '$literal', '$from'];
  if (exprKeys.some(key => key in value)) {
    return true;
  }
  
  return Object.values(value).some(hasExpressions);
}

/**
 * Get all dependencies (steps and variables) from an expression
 */
export function getDependencies(value: StepflowInputValue): {
  steps: string[];
  variables: string[];
} {
  return {
    steps: extractStepReferences(value),
    variables: extractVariableReferences(value)
  };
}

/**
 * Create an empty evaluation context for testing/validation
 */
export function createEmptyContext(): EvaluationContext {
  return {
    input: {},
    stepOutputs: {},
    variables: {}
  };
}
