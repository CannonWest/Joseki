/**
 * Stepflow Integration Routes
 * 
 * Provides API endpoints for:
 * - Exporting workflows to Stepflow YAML/JSON format
 * - Exporting to FlowBuilder Python code
 * - Generating stepflow-config.yml
 * - Importing Stepflow workflows
 * - Validating workflows for Stepflow compatibility
 * - Running workflows via Stepflow runtime (if available)
 */

import { Router } from 'express';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { Database } from '../db/database';
import {
  convertToStepflow,
  convertFromStepflow,
  toStepflowYAML,
  toStepflowJSON,
  validateForStepflow,
  validateStepflowImport,
  checkCompatibility,
  generateStepflowConfig,
  toFlowBuilderPython,
  generateBatchSchema,
  StepflowWorkflow
} from '@maestroai/shared';

const router = Router();
const execAsync = promisify(exec);

// Check if Stepflow CLI is installed
let stepflowCliAvailable = false;
let stepflowVersion: string | null = null;

async function checkStepflowCLI(): Promise<void> {
  try {
    const { stdout } = await execAsync('stepflow --version');
    stepflowVersion = stdout.trim();
    stepflowCliAvailable = true;
    console.log(`[Stepflow] CLI available: ${stepflowVersion}`);
  } catch {
    stepflowCliAvailable = false;
    console.log('[Stepflow] CLI not available. Install with: cargo install stepflow');
  }
}

// Check on startup
checkStepflowCLI();

// ==================== EXPORT ENDPOINTS ====================

/**
 * GET /api/workflows/:id/stepflow/yaml
 * Export workflow as Stepflow YAML
 */
router.get('/workflows/:id/stepflow/yaml', (req, res) => {
  const db = (req as any).db as Database;
  const workflow = db.getWorkflow(req.params.id);
  
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  
  // Validate workflow
  const validation = validateForStepflow(workflow);
  if (!validation.valid) {
    return res.status(400).json({
      error: 'Workflow validation failed',
      details: validation.errors
    });
  }
  
  try {
    const yaml = toStepflowYAML(workflow);
    
    res.setHeader('Content-Type', 'text/yaml');
    res.setHeader('Content-Disposition', `attachment; filename="${workflow.name.replace(/\s+/g, '_')}.yaml"`);
    res.send(yaml);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to export workflow',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * GET /api/workflows/:id/stepflow/json
 * Export workflow as Stepflow JSON
 */
router.get('/workflows/:id/stepflow/json', (req, res) => {
  const db = (req as any).db as Database;
  const workflow = db.getWorkflow(req.params.id);
  
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  
  // Validate workflow
  const validation = validateForStepflow(workflow);
  if (!validation.valid) {
    return res.status(400).json({
      error: 'Workflow validation failed',
      details: validation.errors
    });
  }
  
  try {
    const json = toStepflowJSON(workflow);
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${workflow.name.replace(/\s+/g, '_')}.json"`);
    res.send(json);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to export workflow',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * GET /api/workflows/:id/stepflow/python
 * Export workflow as FlowBuilder Python code
 */
router.get('/workflows/:id/stepflow/python', (req, res) => {
  const db = (req as any).db as Database;
  const workflow = db.getWorkflow(req.params.id);
  
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  
  // Validate workflow (warnings are OK for Python export)
  const validation = validateForStepflow(workflow);
  if (!validation.valid) {
    return res.status(400).json({
      error: 'Workflow validation failed',
      details: validation.errors
    });
  }
  
  try {
    const python = toFlowBuilderPython(workflow);
    
    res.setHeader('Content-Type', 'text/x-python');
    res.setHeader('Content-Disposition', `attachment; filename="${workflow.name.replace(/\s+/g, '_')}_flow.py"`);
    res.send(python);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to generate Python code',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * GET /api/workflows/:id/stepflow/config
 * Generate stepflow-config.yml for the workflow
 */
router.get('/workflows/:id/stepflow/config', (req, res) => {
  const db = (req as any).db as Database;
  const workflow = db.getWorkflow(req.params.id);
  
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  
  try {
    const config = generateStepflowConfig(workflow);
    
    res.setHeader('Content-Type', 'text/yaml');
    res.setHeader('Content-Disposition', `attachment; filename="stepflow-config.yaml"`);
    res.send(config);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to generate configuration',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * GET /api/workflows/:id/stepflow/batch-schema
 * Get batch execution schema for the workflow
 */
router.get('/workflows/:id/stepflow/batch-schema', (req, res) => {
  const db = (req as any).db as Database;
  const workflow = db.getWorkflow(req.params.id);
  
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  
  try {
    const batchSchema = generateBatchSchema(workflow);
    
    res.json({
      schema: batchSchema,
      example: [
        {
          // Example batch item based on input nodes
          ...Object.fromEntries(
            workflow.nodes
              .filter(n => n.type === 'input')
              .map(n => [n.id, 'example_value'])
          )
        }
      ]
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to generate batch schema',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * GET /api/workflows/:id/stepflow/preview
 * Preview Stepflow format without downloading
 */
router.get('/workflows/:id/stepflow/preview', (req, res) => {
  const db = (req as any).db as Database;
  const workflow = db.getWorkflow(req.params.id);
  
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  
  try {
    const stepflow = convertToStepflow(workflow);
    const yaml = toStepflowYAML(workflow);
    const validation = validateForStepflow(workflow);
    const compatibility = checkCompatibility(stepflow);
    
    res.json({
      workflow: stepflow,
      yaml,
      validation: {
        valid: validation.valid,
        errors: validation.errors,
        warnings: validation.warnings
      },
      compatibility,
      canRunWithStepflow: stepflowCliAvailable && validation.valid
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to preview workflow',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * POST /api/workflows/:id/stepflow/validate
 * Validate workflow for Stepflow compatibility
 */
router.post('/workflows/:id/stepflow/validate', (req, res) => {
  const db = (req as any).db as Database;
  const workflow = db.getWorkflow(req.params.id);
  
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  
  const validation = validateForStepflow(workflow);
  const stepflow = convertToStepflow(workflow);
  const compatibility = checkCompatibility(stepflow);
  
  res.json({
    valid: validation.valid,
    errors: validation.errors,
    warnings: validation.warnings,
    compatibility,
    canRunWithStepflow: stepflowCliAvailable && validation.valid
  });
});

// ==================== IMPORT ENDPOINTS ====================

/**
 * POST /api/stepflow/import
 * Import a Stepflow workflow into MaestroAI
 */
router.post('/stepflow/import', async (req, res) => {
  try {
    // Validate against Zod schema
    const validation = validateStepflowImport(req.body);

    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid Stepflow workflow',
        details: validation.errors,
        warnings: validation.warnings
      });
    }

    const stepflowWorkflow = validation.data as StepflowWorkflow;

    // Convert to MaestroAI format
    const partialWorkflow = convertFromStepflow(stepflowWorkflow);

    // Create full workflow with generated ID
    const now = Date.now();
    const workflow = {
      id: `wf-${now}`,
      name: stepflowWorkflow.name || 'Imported Workflow',
      ...partialWorkflow,
      createdAt: now,
      updatedAt: now
    };

    // Save to database
    const db = (req as any).db as Database;
    db.createWorkflow(workflow);

    res.status(201).json({
      workflow,
      warnings: validation.warnings,
      compatibility: checkCompatibility(stepflowWorkflow)
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to import workflow',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * POST /api/stepflow/import-yaml
 * Import a Stepflow YAML workflow
 */
router.post('/stepflow/import-yaml', async (req, res) => {
  try {
    const yamlContent: string = req.body.yaml;

    if (!yamlContent) {
      return res.status(400).json({ error: 'YAML content is required' });
    }

    // Parse with js-yaml — handles nested objects, arrays, multi-line strings,
    // anchors/aliases, flow sequences, etc.
    let parsed: any;
    try {
      parsed = yaml.load(yamlContent, { schema: yaml.JSON_SCHEMA });
    } catch (parseErr) {
      return res.status(400).json({
        error: 'Invalid YAML syntax',
        message: parseErr instanceof Error ? parseErr.message : String(parseErr)
      });
    }

    // Validate the parsed structure against the Stepflow Zod schema
    const validationResult = validateStepflowImport(parsed);
    if (!validationResult.valid) {
      return res.status(400).json({
        error: 'Invalid Stepflow workflow',
        details: validationResult.errors,
        warnings: validationResult.warnings
      });
    }

    const stepflowWorkflow = validationResult.data as StepflowWorkflow;

    // Convert to MaestroAI format
    const partialWorkflow = convertFromStepflow(stepflowWorkflow);

    const now = Date.now();
    const fullWorkflow = {
      id: `wf-${now}`,
      name: stepflowWorkflow.name || 'Imported Workflow',
      ...partialWorkflow,
      createdAt: now,
      updatedAt: now
    };

    // Save to database
    const db = (req as any).db as Database;
    db.createWorkflow(fullWorkflow);

    res.status(201).json({
      workflow: fullWorkflow,
      warnings: validationResult.warnings,
      compatibility: checkCompatibility(stepflowWorkflow)
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to import YAML',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

// ==================== EXECUTION ENDPOINTS ====================

/**
 * POST /api/workflows/:id/stepflow/run
 * Run workflow using Stepflow CLI (if available)
 */
router.post('/workflows/:id/stepflow/run', async (req, res) => {
  if (!stepflowCliAvailable) {
    return res.status(503).json({
      error: 'Stepflow CLI not available',
      message: 'Install Stepflow CLI to run workflows: cargo install stepflow'
    });
  }
  
  const db = (req as any).db as Database;
  const workflow = db.getWorkflow(req.params.id);
  
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  
  // Validate workflow
  const validation = validateForStepflow(workflow);
  if (!validation.valid) {
    return res.status(400).json({
      error: 'Workflow validation failed',
      details: validation.errors
    });
  }
  
  const executionId = `exec-${Date.now()}`;
  const tempDir = join(tmpdir(), 'maestroai-stepflow');
  const workflowPath = join(tempDir, `${executionId}.yaml`);
  const inputPath = join(tempDir, `${executionId}-input.json`);
  const configPath = join(tempDir, `${executionId}-config.yaml`);
  
  try {
    // Create temp directory
    await mkdir(tempDir, { recursive: true });
    
    // Export workflow to temp file
    const yaml = toStepflowYAML(workflow);
    await writeFile(workflowPath, yaml, 'utf-8');
    
    // Generate and write config
    const config = generateStepflowConfig(workflow);
    await writeFile(configPath, config, 'utf-8');
    
    // Write input if provided
    const input = req.body.input || {};
    await writeFile(inputPath, JSON.stringify(input, null, 2), 'utf-8');
    
    // Run with Stepflow
    const stepflowProcess = spawn('stepflow', [
      'run',
      `--flow=${workflowPath}`,
      `--input=${inputPath}`,
      `--config=${configPath}`
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    stepflowProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    stepflowProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    stepflowProcess.on('close', async (code) => {
      // Clean up temp files
      try {
        await unlink(workflowPath);
        await unlink(inputPath);
        await unlink(configPath);
      } catch {
        // Ignore cleanup errors
      }
      
      if (code === 0) {
        try {
          const result = JSON.parse(stdout);
          res.json({
            executionId,
            status: 'success',
            result
          });
        } catch {
          res.json({
            executionId,
            status: 'success',
            output: stdout
          });
        }
      } else {
        res.status(500).json({
          executionId,
          status: 'error',
          exitCode: code,
          error: stderr || 'Stepflow execution failed'
        });
      }
    });
    
  } catch (error) {
    // Clean up on error
    try {
      await unlink(workflowPath);
      await unlink(inputPath);
      await unlink(configPath);
    } catch {
      // Ignore cleanup errors
    }
    
    res.status(500).json({
      error: 'Failed to run workflow',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * GET /api/stepflow/status
 * Check Stepflow CLI availability
 */
router.get('/stepflow/status', (req, res) => {
  res.json({
    available: stepflowCliAvailable,
    version: stepflowVersion,
    installCommand: 'cargo install stepflow',
    documentation: 'https://stepflow.org/docs'
  });
});

export { router as stepflowRoutes };
