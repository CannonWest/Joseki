# MaestroAI Stepflow Integration: Project Status Update

## Current State

MaestroAI is progressing from treating Stepflow as a serialization format toward a genuine Stepflow-native UX. The following integration improvements have been completed, directly addressing the critical and high-priority findings from the initial assessment.

---

## Completed Work

### 1. Unified Conversion Logic (Critical - Resolved)

**Problem:** `StepflowPanel.tsx` contained ~130 lines of duplicated, simplified Stepflow conversion logic that drifted from the canonical implementation in `shared/src/stepflow.ts`.

**Resolution:**
- Updated `client/vite.config.ts` to resolve `@maestroai/shared` to its TypeScript source via a path alias
- Added `optimizeDeps.include` for the shared package
- Stripped all inline conversion functions from `StepflowPanel.tsx` and replaced with direct imports from `@maestroai/shared`
- Result: one implementation, two consumers, zero drift risk

### 2. Real YAML Parser (Critical - Resolved)

**Problem:** `server/src/handlers/stepflow.ts` contained a hand-written YAML parser (~50 lines) that only handled trivially flat structures, silently producing incorrect results for valid Stepflow YAML.

**Resolution:**
- Added `js-yaml` dependency to the server package
- Replaced `parseStepflowYAML()` with `yaml.load()` using `JSON_SCHEMA` mode
- Proper error handling for YAML syntax errors with descriptive messages
- Now handles: nested objects, arrays, multi-line strings, anchors/aliases, flow sequences, and all YAML features that Stepflow workflows may use

### 3. Zod Schema Validation on Import (High - Resolved)

**Problem:** The JSON import endpoint only checked for the presence of `schema` and `steps` fields, letting malformed data into the database.

**Resolution:**
- Created `shared/src/stepflowSchema.ts` with comprehensive Zod schemas covering:
  - Recursive `StepflowInputValue` expressions (`$step`, `$input`, `$variable`, `$template`, `$from`)
  - `on_error` handlers (both Stepflow-native and legacy MaestroAI formats)
  - Step validation (id, component, input)
  - Workflow-level validation (name, steps, schemas)
- Added `zod` as a dependency to the shared package
- Both JSON and YAML import endpoints now validate against the schema before database insertion
- Structured error messages returned to the client with field paths

### 4. Safe Expression Evaluator (High/Security - Resolved)

**Problem:** `server/src/engine/executor.ts:229` evaluated branch conditions using `new Function()`, equivalent to `eval()` -- a code injection vulnerability.

**Resolution:**
- Added `expr-eval` dependency to the server package
- Replaced `new Function('context', ...)` with a sandboxed `ExprParser` instance
- Branch conditions now evaluate against a flat scope built from the execution context
- Available variables: upstream node IDs, `input`, and `<nodeId>_output` helpers
- Invalid expressions produce clear error messages with syntax examples
- Updated the Branch node UI to reflect safe expression syntax (changed from "Condition (JavaScript)" to "Condition Expression" with examples)

### 5. Extended Model-to-Component Mapping (Medium - Resolved)

**Problem:** Hardcoded `STEPFLOW_MODEL_COMPONENTS` map was missing Cohere, local models, and used stale Claude model IDs.

**Resolution:**
- Replaced the static `Record<string, string>` map with a prefix-based `MODEL_PROVIDER_PREFIXES` array
- New model variants resolve automatically without explicit entries
- Coverage: OpenAI (`gpt-*`, `o1-*`, `o3-*`), Anthropic (`claude-*`), Cohere (`command-*`, `c4ai-*`), Local (`local/*`, `ollama/*`)
- Exported `resolveModelComponent()` function for use across the codebase
- Graceful fallback to `/builtin/openai` with a console warning for unknown models

### 6. on_error Support in Export Path (Medium - Resolved)

**Problem:** MaestroAI exported no error handling metadata, despite Stepflow supporting `on_error` with retry, default, and fail strategies per step.

**Resolution:**
- Added `ErrorHandlerConfig` interface to `shared/src/index.ts` with `strategy`, `maxAttempts`, and `fallbackValue` fields
- Extended `PromptConfig` with an optional `onError` property
- Added `buildOnError()` helper to convert MaestroAI config to Stepflow's `on_error` shape
- `convertPromptNode` now emits `on_error` when configured
- Updated `StepflowErrorHandler` type to support both Stepflow-native (`type`/`max_attempts`) and legacy (`action`/`max_retries`) formats
- YAML serializer emits all `on_error` fields
- Added UI controls in `NodeConfigPanel.tsx`: strategy selector + conditional retry attempts input

### 7. Native Stepflow Value Expressions (Medium - Resolved)

**Problem:** `interpolateTemplate()` wrapped all references in `{ $template: "..." }`, which is lossy and requires template expansion support in the runtime.

**Resolution:**
- Pure references like `{{nodes.step1.output}}` now emit `{ $step: "step1" }` (native Stepflow value expression)
- Pure input references like `{{input}}` now emit `{ $input: "$" }`
- Path-qualified references like `{{nodes.step1.output.field}}` emit `{ $step: "step1", path: "$.field" }`
- Mixed text + references still emit `{ $template: "..." }` with Stepflow reference syntax
- The Stepflow Rust runtime resolves `$step` and `$input` natively -- no string interpolation overhead, and the runtime can validate that referenced steps exist before execution

### 8. Canonical schemas.input and output Fields (Medium - Resolved)

**Problem:** MaestroAI exported `input_schema` (non-standard) and omitted the flow-level `output` entirely, making exported workflows not immediately runnable via `stepflow run`.

**Resolution:**
- `convertToStepflow()` now emits `schemas.input` (Stepflow canonical format) instead of `input_schema`
- Added flow-level `output` field referencing terminal step(s):
  - Single output node: `{ $step: "step_id" }`
  - Multiple output nodes: named object with `$step` references
- `StepflowWorkflow` type updated to support both `schemas.input` and legacy `input_schema` (for backward-compatible imports)
- YAML serializer emits the `output` block after steps

---

## What This Does NOT Address (Deferred)

These items are valid but larger in scope and are planned for a separate effort:

| Item | Rationale for Deferral |
|------|----------------------|
| **DAG auto-layout on import** | Requires adding `dagre` or `elkjs` and wiring into the React Flow layout pipeline. Orthogonal to protocol fidelity. |
| **Stepflow API client integration** | Replacing CLI shelling with `StepflowClient.local()` requires either bundling the Rust binary or adding a Python sidecar -- a significant architecture decision. |
| **Round-trip integration tests** | Critical for confidence but a testing infrastructure effort. No test framework is currently configured. |
| **Streaming Stepflow execution results** | Mapping step completions back to the visual canvas during Stepflow CLI execution would require a protocol bridge. |
| **File upload for import UI** | Minor UX improvement -- users currently paste YAML into a textarea. |

---

## Architecture After Changes

```
Browser (React + Vite)
  |
  |-- StepflowPanel.tsx
  |     imports from @maestroai/shared (via Vite alias)
  |     No duplicated logic
  |
  |-- NodeConfigPanel.tsx
  |     on_error UI controls
  |     Safe expression hints for branch nodes
  |
  v
REST API (Express)
  |
  |-- stepflow.ts handlers
  |     js-yaml for YAML parsing
  |     Zod schema validation on all imports
  |
  |-- executor.ts engine
  |     expr-eval for safe branch evaluation
  |     No new Function() / eval()
  |
  v
Shared Package (@maestroai/shared)
  |
  |-- stepflow.ts        Canonical conversion logic
  |     resolveModelComponent()  Prefix-based model routing
  |     interpolateTemplate()    Native $step/$input expressions
  |     buildOnError()           Stepflow on_error support
  |     convertToStepflow()      schemas.input + output fields
  |
  |-- stepflowSchema.ts  Zod validation schemas
  |-- index.ts            ErrorHandlerConfig type
```

## Dependencies Added

| Package | Location | Purpose |
|---------|----------|---------|
| `js-yaml` | server | Standard YAML parsing |
| `@types/js-yaml` | server (dev) | TypeScript types for js-yaml |
| `expr-eval` | server | Safe mathematical/logical expression evaluation |
| `zod` | shared | Schema validation for Stepflow imports |

---

## Next Steps (Recommended Priority)

1. **Integration test suite** -- Round-trip tests: MaestroAI workflow -> Stepflow export -> Stepflow CLI execution -> result comparison
2. **DAG auto-layout** -- Use `dagre` to lay out imported Stepflow workflows as readable graphs instead of vertical stacks
3. **Stepflow API client** -- Evaluate replacing `spawn('stepflow', ...)` with the Python SDK's `StepflowClient` for tighter runtime integration
4. **File upload import** -- Add drag-and-drop file upload to the Import tab alongside the existing paste interface
5. **Streaming execution bridge** -- Map Stepflow step completion events back to the visual canvas for real-time feedback
