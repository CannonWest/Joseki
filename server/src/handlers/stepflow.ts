/**
 * Stepflow Integration Routes
 * 
 * Provides API endpoints for:
 * - Exporting workflows to Stepflow YAML/JSON format
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
import { Database } from '../db/database';
import {
  convertToStepflow,
  convertFromStepflow,
  toStepflowYAML,
  toStepflowJSON,
  validateForStepflow,
  StepflowWorkflow
} from '@convchain/shared';

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
    
    res.json({
      workflow: stepflow,
      yaml,
      validation: {
        valid: validation.valid,
        errors: validation.errors
      },
      canRunWithStepflow: stepflowCliAvailable
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
  
  res.json({
    valid: validation.valid,
    errors: validation.errors,
    canRunWithStepflow: stepflowCliAvailable && validation.valid
  });
});

// ==================== IMPORT ENDPOINTS ====================

/**
 * POST /api/stepflow/import
 * Import a Stepflow workflow into ConvChain Studio
 */
router.post('/stepflow/import', async (req, res) => {
  try {
    const stepflowWorkflow: StepflowWorkflow = req.body;
    
    // Validate required fields
    if (!stepflowWorkflow.schema || !stepflowWorkflow.steps) {
      return res.status(400).json({
        error: 'Invalid Stepflow workflow',
        message: 'Missing required fields: schema, steps'
      });
    }
    
    // Convert to ConvChain format
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
    
    res.status(201).json(workflow);
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
    
    // Parse YAML (simple parser - in production use a proper YAML library)
    const workflow = parseStepflowYAML(yamlContent);
    
    // Convert to ConvChain format
    const partialWorkflow = convertFromStepflow(workflow);
    
    const now = Date.now();
    const fullWorkflow = {
      id: `wf-${now}`,
      name: workflow.name || 'Imported Workflow',
      ...partialWorkflow,
      createdAt: now,
      updatedAt: now
    };
    
    // Save to database
    const db = (req as any).db as Database;
    db.createWorkflow(fullWorkflow);
    
    res.status(201).json(fullWorkflow);
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
  const tempDir = join(tmpdir(), 'convchain-stepflow');
  const workflowPath = join(tempDir, `${executionId}.yaml`);
  const inputPath = join(tempDir, `${executionId}-input.json`);
  
  try {
    // Create temp directory
    await mkdir(tempDir, { recursive: true });
    
    // Export workflow to temp file
    const yaml = toStepflowYAML(workflow);
    await writeFile(workflowPath, yaml, 'utf-8');
    
    // Write input if provided
    const input = req.body.input || {};
    await writeFile(inputPath, JSON.stringify(input, null, 2), 'utf-8');
    
    // Run with Stepflow
    const stepflowProcess = spawn('stepflow', [
      'run',
      `--flow=${workflowPath}`,
      `--input=${inputPath}`
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
    installCommand: 'cargo install stepflow'
  });
});

// ==================== HELPER FUNCTIONS ====================

/**
 * Simple YAML parser for Stepflow workflows
 * In production, use a proper YAML library like js-yaml
 */
function parseStepflowYAML(yaml: string): StepflowWorkflow {
  const lines = yaml.split('\n');
  const workflow: Partial<StepflowWorkflow> = {
    steps: []
  };
  
  let currentStep: any = null;
  let currentSection: string | null = null;
  let indentStack: { indent: number; obj: any }[] = [];
  
  for (const line of lines) {
    if (line.trim().startsWith('#') || line.trim() === '') continue;
    
    const indent = line.search(/\S/);
    const trimmed = line.trim();
    const [key, ...valueParts] = trimmed.split(':');
    const value = valueParts.join(':').trim();
    
    if (indent === 0) {
      // Root level
      if (key === 'steps') {
        currentSection = 'steps';
      } else {
        (workflow as any)[key] = value.replace(/^["']|["']$/g, '');
      }
    } else if (currentSection === 'steps' && indent === 2 && trimmed.startsWith('-')) {
      // New step
      currentStep = {};
      workflow.steps!.push(currentStep);
      indentStack = [{ indent: 2, obj: currentStep }];
    } else if (currentStep && indent > 2) {
      // Step properties
      // Simple parsing - in production, use proper YAML parser
      const cleanKey = key.replace(/^- /, '');
      
      if (value) {
        // Try to parse as JSON, fallback to string
        let parsedValue: any = value.replace(/^["']|["']$/g, '');
        try {
          parsedValue = JSON.parse(value);
        } catch {
          // Keep as string
        }
        currentStep[cleanKey] = parsedValue;
      }
    }
  }
  
  return workflow as StepflowWorkflow;
}

export { router as stepflowRoutes };
