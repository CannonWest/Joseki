# The shipped examples

Joseki ships four workflows, in a folder called `Examples`. There is one per
shape — a branch with a loop, a straight line, a fan, a deterministic gate —
and each exists to show one thing about how a workflow reads what came before
it. This is the write-up of each: the shape, every node, what it teaches, how
to run it, and what a run costs. The README has the one-line version.

They are built in code, not stored as files: `shared/src/exampleWorkflow.ts`,
`shared/src/translationRoundTrip.ts`, `shared/src/bestOfFour.ts` and
`shared/src/ticketTriage.ts`, registered in `shared/src/examples.ts`
(`SHIPPED_EXAMPLE_IDS`, `shippedExamples()`). Their ids are stable across
versions, which is how Restore knows one is missing. Their node ids carry no
hyphen, on purpose: a hyphen is subtraction to the branch condition parser, so
an id it can read as a name is the better habit even in an example that has no
branch.

Every model id is an OpenRouter slug — there is no other provider — and the
default for a new prompt node is `DEFAULT_WORKFLOW_MODEL`, `openai/gpt-4o-mini`.

Figures below are frozen **2026-09-13** for the first three examples and
**2026-09-15** for Ticket Triage, from real runs. Prices move; shapes don't.

---

## Content Review Pipeline

`example-content-review-pipeline` · the branching example

```
        Article Text
             │
        Draft Summary ◄─────────────────┐
             │                          │ fail — with a note
        Quality Check                   │ the next draft reads
     true │       │ false               │
          │    Revision                 │
          └───┬───┘                     │
        Merge Results                   │
              │                         │
        Editor Review ──────────────────┘
              │ pass
        Final Output
```

| id | type | label | what it does |
|---|---|---|---|
| `example_input` | input | Article Text | required text — the article to summarize |
| `example_draft` | prompt | Draft Summary | `gpt-4o-mini`, temperature 0.5, 1024 tokens. Summarizes `{{input}}` in 2–3 paragraphs. Its **system** prompt reads `{{nodes.example_editor_review.decision.note}}` inside an `{{#if}}`, so on a second lap it is told what the editor said. |
| `example_quality_check` | branch | Quality Check | condition `1 == 0` — **always false, on purpose**, so every run takes the revision path and exercises the interesting half of the graph. Not a bug. |
| `example_revision` | prompt | Revision | `gpt-4o-mini`, temperature 0.3. Rewrites `{{nodes.example_draft.output}}` for clarity. |
| `example_merge` | aggregate | Merge Results | `concat`, `\n`. A join after a branch waits for exactly the path that was chosen — here, only Revision ever arrives — and carries it on. |
| `example_editor_review` | human_gate | Editor Review | `allowEdit: true`, `timeout: 3600` s, `maxRevisions: 3`. **pass** → Final Output; **fail** → back to Draft Summary. |
| `example_output` | output | Final Output | |

**What it teaches.** A branch with two arrows and a join that waits for the
chosen one and no longer. A gate that pauses the run for a person, who can
approve, approve with an edit that replaces the content, or send it back with
a note — and the back arrow is a *trigger*, not a dependency: Draft Summary
never waits on it and is not fed by it, it is simply re-run, and everything
downstream with it, up to `maxRevisions`. The note travels through the run's
context, which is why the draft can read it.

**How to run it.** From the editor only: paste an article, run, and the canvas
pauses at Editor Review with the summary in the gate panel. Chat's
`run_workflow` refuses a workflow with a gate — it needs a person, and says so.

**What a run looks like.** 10 runs on the dev database, 7 completed: **60–76 s**
wall-clock, **$0.0006–0.0011**, up to ~7,400 tokens. The time is the reviewer's,
not the model's — a run sits at the gate until someone decides; the model
calls themselves are a few seconds.

**Knobs worth turning.** Give Quality Check a condition that means something —
`length(input) > 800` routes long drafts to revision and lets short ones
through; the vocabulary is in the README. Set `allowEdit: false` to make the
editor choose rather than rewrite. Raise `maxRevisions` and send it back more
than once to watch the note change.

---

## Translation Round-Trip

`example-translation-round-trip`

```
English Text → Translate to French → Translate Back → Spot the Drift → Result
```

| id | type | label | what it does |
|---|---|---|---|
| `roundtrip_input` | input | English Text | required — a sentence or short paragraph |
| `roundtrip_to_french` | prompt | Translate to French | `gpt-4o-mini`, temperature 0.2. User prompt is `{{input}}` — **the arrow in**. |
| `roundtrip_back_to_english` | prompt | Translate Back | temperature 0.2. User prompt is `{{nodes.roundtrip_to_french.output}}` — the same text as `{{input}}` would give, said **the long way**, to show the form that reaches any node. |
| `roundtrip_drift` | prompt | Spot the Drift | temperature 0.4. Needs two things at once: the original, `{{nodes.roundtrip_input.output}}`, and the round trip, `{{input}}`. Prints the round trip under a heading, then two or three bullets on what shifted — or that it survived. |
| `roundtrip_output` | output | Result | markdown |

**What it teaches.** The two ways a prompt reads what came before it.
`{{input}}` is only ever the arrow in. `{{nodes.<id>.output}}` reaches any node
that has run. The third prompt is the reason the long way exists: the original
is two nodes back, and no arrow carries it.

**How to run it.** From the editor, or from chat — it is a straight line with
no gate, so `run_workflow` with `"Examples/Translation Round-Trip"` and an
`English Text` input runs it end to end and returns the result. The tool finds
a workflow by folder and name, and inputs by their label.

**What a run looks like.** **7.2 s**, **$0.0010**, 1,489 tokens for a short
paragraph. Three calls in a line, so about a third of that each.

**Knobs worth turning.** Change the language in either translator's system
prompt. Raise the translators' temperature to see more drift. Put a different
model on each leg — the drift report is partly a report on the models.

---

## Best of Four

`example-best-of-four`

```
                        Prompt
        ┌───────────┬─────┴──────┬────────────┐
   A · GPT-4o mini  B · Gemini   C · Llama    D · Mistral
        └───────────┴─────┬──────┴────────────┘
                     Pick the Best
                          │
                     Best Answer
```

| id | type | label | what it does |
|---|---|---|---|
| `bestof_input` | input | Prompt | required — a question or task; all four answer it cold |
| `bestof_gpt_4o_mini` | prompt | A · GPT-4o mini | `openai/gpt-4o-mini` |
| `bestof_gemini_flash_lite` | prompt | B · Gemini 2.5 Flash Lite | `google/gemini-2.5-flash-lite` |
| `bestof_llama_3_3_70b` | prompt | C · Llama 3.3 70B | `meta-llama/llama-3.3-70b-instruct` |
| `bestof_mistral_small` | prompt | D · Mistral Small 3.2 | `mistralai/mistral-small-3.2-24b-instruct` |
| `bestof_judge` | prompt | Pick the Best | `deepseek/deepseek-chat`, temperature 0.2, 2048 tokens — room to reprint the winner in full |
| `bestof_output` | output | Best Answer | markdown |

The four candidates are **identical but for the model**: the same neutral
system prompt, the same temperature (0.7), the same 1024 tokens, the same user
prompt, `{{input}}`. They are built from one list in the source rather than
written out four times, which is what keeps that true as the example is edited.
The model is the only thing the comparison can be measuring.

**What it teaches.** The fan — and the third way a prompt reads what came
before it. Four arrows arrive at the judge at once, and `{{input}}` is only the
first of them. So the judge names every node it reads:
`{{nodes.bestof_input.output}}` for the prompt the four were given — which
arrived on no arrow into the judge at all — and `{{nodes.<candidate>.output}}`
for each answer, under `--- Answer A ---` through `D`. (There is also
`{{#each inputs}}`, which walks every arrow's output keyed by source id, for
when the names don't matter.)

**Two choices, made on purpose.**

- **The judge is blind.** It is told A, B, C and D and never which model wrote
  which. The node labels carry the key, so a verdict of "B" reads off the
  canvas without the judge having been handed a brand to prefer.
- **The judge is from a fifth house**, so nothing in the field scores its own
  work. The order it reads them in is fixed, so a position preference, if it
  has one, is at least the same one every run — consistent, not absent.

The judge's system prompt fixes the output shape: `## Winner: <letter>`, a
sentence on why, `## The answer` reprinted in full and word for word, and
`## The others` with a line on each. The workflow's product is the best
answer, not a verdict about it.

**How to run it.** From the editor, or from chat: no gate, so `run_workflow`
with `"Examples/Best of Four"` and a `Prompt` input.

**What a run looks like.** The four go out at once — the executor runs every
node whose arrows are resolved — so the fan takes as long as its slowest
answer plus the judge, not the sum. One prompt, measured both ways:

| executor | whole run | cost |
|---|---|---|
| one node at a time (before #35) | 15.0 s | $0.00098 |
| ready nodes at once (#35) | **6.2 s** | $0.00096 |

The timeline from the concurrent run's own traces:

```
node                        start@ms  latency   end@ms
bestof_input                      12        0       12
bestof_gpt_4o_mini                24      925      949
bestof_gemini_flash_lite          35      752      787
bestof_llama_3_3_70b              37     2493     2530
bestof_mistral_small              38     2428     2466
bestof_judge                    2538     3606     6144
bestof_output                   6154        0     6154
```

All four started within 14 ms of each other; the judge started 8 ms after the
slowest of them finished.

**Knobs worth turning.** Swap any candidate's model — any slug the catalog
lists — and keep its letter. Swap the judge; watch whether a judge from inside
the field favours its own house. Add a fifth: one prompt node, two edges, and
an `--- Answer E ---` block in the judge's user prompt. Change the output shape
in the judge's system prompt to get a ranking instead of a winner.

---

## Ticket Triage

`example-ticket-triage` · the deterministic-gate example

```
        Support Ticket
             │
          Classify
             │
          Priority (transform)
             │
           Gate (branch)
      true │       │ false
     Escalate    Standard
      Draft       Draft
          └───┬───┘
            Merge
              │
        Response Draft
```

| id | type | label | what it does |
|---|---|---|---|
| `triage_input` | input | Support Ticket | required text — the customer's ticket |
| `triage_classify` | prompt | Classify | `gpt-4o-mini`, temperature 0.2. Reads the ticket and answers strict JSON: `{"urgency": 0.0–1.0, "category": "...", "summary": "..."}`. The only model call in the workflow. |
| `triage_priority` | transform | Priority | `if(get(input, "urgency") > vars.highThreshold, "P1", if(get(input, "urgency") > vars.lowThreshold, "P2", "P3"))`. Pulls the number out of the classifier's JSON and buckets it into three labels off two declared variables. |
| `triage_gate` | branch | Gate | condition `nodes.triage_priority == "P1"`. Routes P1 to the escalation draft; P2 and P3 both take the standard one. |
| `triage_escalate` | prompt | Escalate Draft | temperature 0.4. Reads `{{nodes.triage_priority.output}}`, `{{nodes.triage_classify.output}}` and `{{nodes.triage_input.output}}` — never `{{input}}`, which downstream of a branch would be the branch's own `"true"`/`"false"`, not the ticket. |
| `triage_standard` | prompt | Standard Draft | temperature 0.6. Same reasoning, minus the priority label — a routine reply doesn't need to say "P3" to the customer. |
| `triage_merge` | aggregate | Merge | `concat`, `\n`. Waits for whichever draft the gate chose. |
| `triage_output` | output | Response Draft | markdown |

Two declared variables: `highThreshold: 0.75`, `lowThreshold: 0.35`.

**What it teaches.** What a transform is for, and why it earns its place
beside a branch rather than duplicating one. A branch condition can already
reach into a model's JSON and read a declared variable — `get(input,
"urgency") > vars.highThreshold` would parse and run fine as a branch
condition on its own — so extraction alone is not the reason to reach for
this node. The reason is the **nested `if()`**: three labels out of one
computed value, which a single true/false branch cannot produce in one step.
The label it computes is a normal node output like any other, read twice —
once by the branch that routes on it, once by the escalation prompt that
prints it back — and the model is asked exactly once, for the raw urgency
number. Everything after that is arithmetic against `highThreshold` and
`lowThreshold`: the same ticket, run any number of times, always lands on the
same priority and takes the same path. Nudge a threshold and it flips,
predictably, without ever asking the model to re-judge urgency.

**How to run it.** From the editor, or from chat: no gate, so `run_workflow`
with `"Examples/Ticket Triage"` and a `Support Ticket` input runs it end to
end and returns whichever draft the gate chose.

**What a run looks like.** Two real runs, one urgent and one routine:

| ticket | urgency (model) | priority (transform) | path | wall-clock | cost |
|---|---|---|---|---|---|
| "production payment API returning 500s, losing live transactions" | 1.0 | P1 | Escalate Draft | 4.4 s | $0.00015, 302 tokens |
| "any plans for dark mode? no rush at all" | 0.0 | P3 | Standard Draft | 3.3 s | $0.00015, 297 tokens |

Two model calls either way — Classify plus whichever single draft the gate
picked — and that pair is the entire cost of the run: the transform and the
branch between them show `cost: 0` in the trace, not an estimate rounded down.

**Knobs worth turning.** Lower `lowThreshold` or raise `highThreshold` in
**Variables** and rerun the same ticket to watch P2 show up, or to watch a
borderline ticket flip from P1 to P2 without the classifier being asked
anything twice. Feed `{{nodes.triage_priority.output}}` into a third prompt
that picks a cheaper model for P3 traffic and a stronger one for P1 — the
label is there to be read by anything downstream, not only the gate. Try "any
plans for dark mode? no rush at all" as the ticket text to see the P3 path
directly.

---

## How the examples are kept

They are put in place **once** — by the migration that introduced folders,
which runs on a fresh database and an old one alike — not on every start, so a
folder cleared on purpose does not fill back up. An example added in a later
version therefore reaches an existing database only through **Restore** in the
Open dialog's footer, which puts back whichever are missing and touches
nothing that is there. Edit one and the edit is kept. Delete one and it stays
deleted.

Each example is pinned by tests. `shared/test/examples.test.cjs` checks that
every shipped example validates with no errors and no warnings and lives in
`Examples`, and pins the round trip's and Best of Four's shapes and template
references; `server/test/executor.test.ts` runs each of the three end to end
against a stub model and checks what every node was actually sent.

**To add one:** a `create<Name>()` in `shared/src/<name>.ts` returning a
`Workflow` with a stable id and `folder: EXAMPLES_FOLDER`; register it in
`shared/src/examples.ts`; a test that it validates clean and one for what it
teaches; an executor test; a section here; a line in the README. The folders
tests count `SHIPPED_EXAMPLE_IDS.length`, so they need no editing.
