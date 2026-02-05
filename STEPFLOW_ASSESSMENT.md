# MaestroAI Stepflow Integration Assessment

## Executive Summary

MaestroAI is a visual IDE for building conversational AI workflows. It integrates with the **Stepflow protocol** (by DataStax) as an interoperability layer for exporting, importing, validating, and optionally executing workflows against the Stepflow runtime. This assessment evaluates how well MaestroAI adheres to best practices in leveraging Stepflow as a backend to accomplish its UX objectives.

**Overall Rating: Moderate adherence with significant structural issues.**

MaestroAI demonstrates a genuine integration with Stepflow at the protocol/format level, but falls short of best practices in several critical areas. The integration is primarily a **serialization bridge** rather than a deep backend integration, and the codebase contains duplicated logic, a custom YAML parser, and an execution engine that operates independently of Stepflow.

---

## 1. Integration Architecture Analysis

### 1.1 How Stepflow Is Used

MaestroAI uses Stepflow in the following ways:

| Capability | Implementation | Location |
|---|---|---|
| Export to Stepflow YAML/JSON | Full | `shared/src/stepflow.ts`, `server/src/handlers/stepflow.ts` |
| Import from Stepflow YAML/JSON | Partial | `server/src/handlers/stepflow.ts:182-258` |
| Validate for Stepflow compatibility | Basic | `shared/src/stepflow.ts:696-743` |
| Execute via Stepflow CLI | Optional/shelling out | `server/src/handlers/stepflow.ts:266-375` |
| Native execution engine | Completely independent | `server/src/engine/executor.ts` |

### 1.2 Architecture Diagram (Logical)

```
User (Browser)
   |
   v
StepflowPanel.tsx (UI) -- duplicated conversion logic
   |
   v
REST API (/api/stepflow/*)   +   WebSocket (Socket.io)
   |                                    |
   v                                    v
stepflow.ts (shared)             executor.ts (engine)
   |                                    |
   v                                    v
Stepflow YAML/JSON              LLMAdapter (OpenAI SDK)
   |
   v
Stepflow CLI (optional, via child_process)
```

**Key observation:** The execution engine (`executor.ts`) and the Stepflow integration (`stepflow.ts`) are **entirely decoupled**. The application's primary execution path never passes through Stepflow. Stepflow is used solely as an export/import format.

---

## 2. Best Practices Assessment

### 2.1 VIOLATION: Duplicated Conversion Logic (Critical)

**Files affected:**
- `shared/src/stepflow.ts` (744 lines) -- canonical implementation
- `client/src/components/StepflowPanel.tsx:25-158` -- duplicated, simplified copy

The `StepflowPanel.tsx` component re-implements `convertToStepflow()`, `toStepflowYAML()`, `validateForStepflow()`, and `sanitizeId()` inline rather than importing from the shared package. The comment at line 15 says:

> "Inline Stepflow conversion utilities to avoid build issues"

**Problems:**
1. The two implementations can drift out of sync. The client-side version is already a **reduced-fidelity copy** -- it omits topological ordering, `$step` references in output nodes, `input_schema` generation, error handler support, template interpolation, and model-specific component mapping.
2. Validates differently on client vs. server. The client-side validation at `StepflowPanel.tsx:110-154` matches the server logic structurally but any future validation additions to the shared module will not propagate.
3. Exported YAML from the client (for unsaved workflows) will differ from YAML exported via the server API, creating user confusion.

**Best practice:** Fix the build configuration so the shared package can be imported directly in the client. The monorepo already has `@maestroai/shared` as a workspace dependency -- this is a tooling configuration issue, not an architectural one.

### 2.2 VIOLATION: Custom YAML Parser (Critical)

**File:** `server/src/handlers/stepflow.ts:395-444`

The import-yaml endpoint uses a hand-written YAML parser (`parseStepflowYAML`) that only handles a trivially flat subset of YAML. The code itself acknowledges this:

> "Simple YAML parser for Stepflow workflows. In production use a proper YAML library like js-yaml"

**Problems:**
1. The parser cannot handle nested objects beyond one level, arrays of objects, multi-line strings, anchors/aliases, flow sequences, or any advanced YAML features.
2. It will silently produce incorrect data structures for valid Stepflow YAML files, leading to broken imports with no clear error message.
3. The Stepflow protocol explicitly supports complex nested structures (`$from` references, error handlers, multi-branch conditionals) that this parser cannot parse.

**Best practice:** Use `js-yaml` or `yaml` npm package. The project already has a dependency on `zod` for validation -- adding a standard YAML library is consistent with the existing approach.

### 2.3 ISSUE: Stepflow as Export-Only, Not as Execution Backend (Structural)

MaestroAI's primary execution path (`server/src/engine/executor.ts`) operates entirely independently of Stepflow:
- It uses Handlebars templates (`{{nodes.X.output}}`) rather than Stepflow references (`$step`, `$input`)
- It calls OpenAI directly via `LLMAdapter` rather than delegating to Stepflow components
- The `WorkflowExecutor` class has no dependency on any Stepflow type or function
- The only way to execute through Stepflow is via CLI shelling (`spawn('stepflow', [...])` at `stepflow.ts:308`), which is optional and requires a Rust toolchain

**Assessment:** This is not necessarily wrong -- using Stepflow as an interoperability format while maintaining an independent execution engine is a valid architectural choice. However, it means:
- The fidelity of the Stepflow export is never validated by actual execution
- Workflows that execute correctly in MaestroAI may produce different results (or fail) when run through the Stepflow runtime
- The mapping between MaestroAI's template syntax and Stepflow's reference syntax (`interpolateTemplate` at `shared/src/stepflow.ts:417-438`) is a potential source of semantic drift

**Recommendation:** Consider adding integration tests that round-trip: MaestroAI workflow -> Stepflow export -> Stepflow CLI execution -> result comparison with MaestroAI native execution.

### 2.4 ISSUE: Incomplete Node-to-Component Mapping

**File:** `shared/src/stepflow.ts:92-112`

The component mapping is hardcoded and limited:

```typescript
const STEPFLOW_MODEL_COMPONENTS: Record<string, string> = {
  'gpt-4': '/builtin/openai',
  'gpt-4-turbo': '/builtin/openai',
  'gpt-3.5-turbo': '/builtin/openai',
  'claude-3-opus': '/stepflow-anthropic/anthropic',
  'claude-3-sonnet': '/stepflow-anthropic/anthropic',
  'claude-3-haiku': '/stepflow-anthropic/anthropic'
};
```

**Problems:**
1. Missing Cohere models despite the `.env.example` including `COHERE_API_KEY` and the `ModelConfig` type supporting `provider: 'cohere'`
2. Missing any `local` model support despite the type system allowing `provider: 'local'`
3. No fallback component path for unknown models -- the code defaults to `/builtin/openai` for all unrecognized models (line 256), which will fail for non-OpenAI models in the Stepflow runtime
4. Model IDs are outdated (e.g., `claude-3-opus` rather than current naming)

### 2.5 ISSUE: Import Produces Low-Quality Visual Layout

**File:** `shared/src/stepflow.ts:459-468`

When importing a Stepflow workflow, nodes are placed with a simple linear vertical layout:

```typescript
let yPosition = 50;
const xPosition = 250;
const yIncrement = 150;

for (const step of stepflowWorkflow.steps) {
  const node = convertStepToNode(step, { x: xPosition, y: yPosition });
  yPosition += yIncrement;
}
```

**Problems:**
1. All nodes are placed in a single vertical column regardless of the DAG structure
2. No consideration of branching, fan-out, or parallel paths
3. No auto-layout algorithm (e.g., Dagre, ELK) to produce readable graphs
4. Imported workflows will appear as a straight line, requiring manual repositioning of every node

**Best practice:** Use a DAG layout algorithm. React Flow has built-in support for Dagre layout via `reactflow`'s layout utilities or the `dagre` npm package.

### 2.6 ISSUE: Unsafe Condition Evaluation

**File:** `server/src/engine/executor.ts:229`

```typescript
const conditionFn = new Function('context', `return ${config.condition}`);
const result = conditionFn(context);
```

Branch node conditions are evaluated using `new Function()`, which is functionally equivalent to `eval()`. This is a code injection vulnerability. A malicious or carelessly constructed condition string can execute arbitrary JavaScript on the server.

**This is not directly a Stepflow issue** but it means workflows imported from Stepflow (which contain `condition` fields) can introduce server-side code execution. The Stepflow protocol itself uses a sandboxed expression language, but MaestroAI's import path does not enforce this boundary.

### 2.7 ISSUE: No Stepflow Schema Validation on Import

**File:** `server/src/handlers/stepflow.ts:182-218`

The JSON import endpoint only checks for the presence of `schema` and `steps` fields:

```typescript
if (!stepflowWorkflow.schema || !stepflowWorkflow.steps) {
  return res.status(400).json({
    error: 'Invalid Stepflow workflow',
    message: 'Missing required fields: schema, steps'
  });
}
```

**Problems:**
1. No validation that `schema` matches the expected URI (`https://stepflow.org/schemas/v1/flow.json`)
2. No validation of step structure (missing `id`, `component`, or `input` fields)
3. No Zod schema validation despite `zod` being a dependency
4. Malformed Stepflow workflows will be imported and stored in the database, potentially causing runtime errors later

### 2.8 POSITIVE: Clean Type System

**File:** `shared/src/index.ts`

The shared type definitions are well-structured:
- Clear separation of `Workflow`, `WorkflowNode`, `WorkflowEdge` types
- Proper union types for `NodeType`, `NodeConfig`, `ExecutionStatus`
- Consistent interface definitions for `ExecutionTrace`, `TokenUsage`, `ModelConfig`
- All Stepflow types are co-exported from the shared package

### 2.9 POSITIVE: Proper DAG Validation

**File:** `shared/src/stepflow.ts:696-743`

The `validateForStepflow()` function correctly implements cycle detection using DFS with a recursion stack. This properly enforces the DAG constraint required by Stepflow.

### 2.10 POSITIVE: Topological Execution Order

**Files:** `server/src/engine/executor.ts:33-92`, `server/src/handlers/workflows.ts:94-155`

Both the native executor and the export-plan builder implement topological sorting correctly, with the execution plan builder also detecting parallel groups for concurrent execution.

### 2.11 POSITIVE: Bidirectional Conversion

The codebase supports both `convertToStepflow()` and `convertFromStepflow()`, enabling round-trip interoperability. While the import path has quality issues (layout, parsing), the architectural decision to support both directions is correct.

---

## 3. UX Assessment

### 3.1 StepflowPanel UX Flow

The `StepflowPanel.tsx` (799 lines) provides a four-tab modal:

| Tab | UX Quality | Notes |
|---|---|---|
| **Export** | Good | Preview with copy-to-clipboard, download YAML/JSON, save-and-export flow for unsaved workflows |
| **Import** | Fair | Text area for pasting YAML, but no file upload, no drag-drop, no JSON import via UI |
| **Validate** | Good | Clear pass/fail visualization, per-error detail, re-validate button |
| **Run** | Good | Clear prerequisites display (CLI availability, validation, save state), execution result display |

**UX Issues:**
1. **No file upload for import** -- users must copy/paste YAML into a textarea rather than uploading a file
2. **No JSON import via UI** -- only YAML paste is supported in the UI, though the API supports JSON import
3. **Silent degradation** -- when the server is unreachable, the panel falls back to client-side conversion (the duplicate code discussed in 2.1) without clearly indicating reduced fidelity
4. **Unsaved workflow friction** -- the export tab shows an amber warning for unsaved workflows, but the save-and-export button is not prominently placed

### 3.2 Workflow Execution UX vs. Stepflow

The primary execution UX (Cmd+Enter) uses the native WebSocket-based executor, which provides:
- Real-time token streaming
- Per-node status updates
- Live execution visualization on the canvas

The Stepflow CLI execution (via the Run tab) provides:
- Batch output only (no streaming)
- No per-node visualization
- Result displayed as raw JSON in the panel

**Gap:** Users who export and run via Stepflow get a significantly degraded experience compared to native execution. There is no mechanism to stream Stepflow CLI output or map step completions back to the visual canvas.

---

## 4. Security Concerns

| Issue | Severity | Location |
|---|---|---|
| `new Function()` for condition evaluation | **High** | `executor.ts:229` |
| No input sanitization on Stepflow import | **Medium** | `stepflow.ts:182-218` |
| Command injection risk in CLI execution path | **Medium** | `stepflow.ts:308` (workflow names in temp file paths) |
| No rate limiting on export/import endpoints | **Low** | `stepflow.ts` handler |

---

## 5. Summary of Findings

### What MaestroAI Does Well

1. **Protocol-level compatibility**: The Stepflow v1 schema types are correctly modeled and the export produces structurally valid Stepflow workflows
2. **DAG enforcement**: Proper cycle detection and topological sorting across both native execution and Stepflow export
3. **Bidirectional conversion**: Support for both export and import enables interoperability
4. **Clean type system**: Shared types are well-defined and consistently used across client, server, and shared packages
5. **Graceful degradation**: The UI handles missing Stepflow CLI, unsaved workflows, and server errors with informative messaging
6. **Attribution and licensing**: Proper Apache 2.0 headers, NOTICE file, and Stepflow attribution throughout

### What Needs Improvement

| Priority | Issue | Impact |
|---|---|---|
| **Critical** | Duplicated conversion logic in `StepflowPanel.tsx` | Inconsistent export output, maintenance burden |
| **Critical** | Custom YAML parser instead of standard library | Broken imports for non-trivial Stepflow workflows |
| **High** | No Stepflow schema validation on import (Zod) | Corrupted data in database from malformed imports |
| **High** | `new Function()` code injection in branch nodes | Server-side arbitrary code execution |
| **Medium** | Stepflow execution completely decoupled from native engine | No guarantee of behavioral parity between formats |
| **Medium** | Linear layout on import (no DAG layout algorithm) | Poor UX for imported workflows |
| **Medium** | Incomplete model-to-component mapping | Export failures for Cohere/local models |
| **Low** | No file upload for import UI | Minor UX friction |
| **Low** | Stepflow CLI execution has no streaming | Degraded UX vs native execution |

### Recommendations (Prioritized)

1. **Fix the shared package build** so `StepflowPanel.tsx` can import from `@maestroai/shared` directly, eliminating the duplicated conversion logic
2. **Add `js-yaml` or `yaml`** as a dependency and replace the custom YAML parser
3. **Add Zod schemas** for validating imported Stepflow workflows before storing in the database
4. **Replace `new Function()` with a safe expression evaluator** (e.g., `expr-eval`, `mathjs`, or a sandboxed subset)
5. **Add integration tests** for round-trip conversion fidelity
6. **Implement DAG auto-layout** for imported workflows using Dagre or ELK
7. **Extend the model mapping** to cover all supported providers
