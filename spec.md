# Working-Memory Context Management Specification

## 1. Goal
- Introduce a structured working-memory system that tracks short-term context for the active task.
- Replace the current aggressive summarization loop with a single unified prompt that updates all memory sections using a minimal plain-text DSL.

## 2. Memory Model
- Memory is represented as three independent sections:
	1. **Current Progress**: Rewritten each iteration.
	2. **Key Learnings**: Persistent list of short insights.
	3. **Verbatim Context**: Persistent list of labelled snippets.
- New entries in persistent sections receive system-generated IDs (`KL-#`, `VC-#`).

## 3. Update Workflow Overview
1. Capture current memory state and generate a single prompt payload containing all sections.
2. Query the model with unified instructions for all memory sections.
3. Parse the response using the plain-text DSL described in §4.
4. Validate operations (ID existence, non-empty reasons).
5. Apply updates to the memory state, generating new IDs and timestamps for added items.
6. Persist the updated state and emit a human-readable diff/log entry.

## 4. Plain-Text DSL Definition

### 4.1 Section Layout
```
CURRENT_PROGRESS:
	Completed:
		- <optional bullet>
	In Progress:
		- <required bullet(s)>
	Remaining:
		- <optional bullet>

KEY_LEARNINGS:
	ADD:
		- because <reason>: <one-line insight>
	ARCHIVE:
		- KL-<id> because <reason>

VERBATIM_CONTEXT:
	ADD:
		- because <reason>: <label> => <verbatim snippet>
	ARCHIVE:
		- VC-<id> because <reason>
```
- Indentation is two spaces; empty sections may be omitted entirely.
- `Completed` and `Remaining` blocks inside `CURRENT_PROGRESS` are optional. `In Progress` is mandatory with at least one bullet.
- `ADD` and `ARCHIVE` lists may be omitted when no changes are needed but section headers must still appear.
- Reasons are plain text (one sentence). Verbatim snippets may span multiple lines after the `=>` delimiter until the next bullet.

### 4.2 Validation Rules
- `ARCHIVE` must reference existing IDs; ignore unknown IDs
- Every `ADD` or `ARCHIVE` bullet must include a `because <reason>` prefix.
- Insights in `Key Learnings` must remain single-line
- `Verbatim Context` snippets allow newline content but must retain original indentation and whitespace.

## 5. Prompt Specification

### 5.1 Unified Memory Update Prompt
- **Input**:
	- Previous `Current Progress` bullets and latest task description.
	- Current `KL-*` entries (with IDs).
	- Existing `VC-*` entries (label + snippet).
	- Full DSL example covering all sections.
- **Instructions**:
	- **Current Progress**: Rewrite the section fully each iteration. Include `In Progress` (mandatory) and optionally `Completed` / `Remaining` if useful. Keep bullets concise (<100 chars suggested) and action-oriented.
	- **Key Learnings**: Add at most 1–3 high-value insights per iteration; prefer no additions if unsure. Archives require explicit IDs and reasons. Insights must remain single-line with no filler text.
	- **Verbatim Context**: Only add snippets when required for upcoming steps. Archive requests must cite a reason (e.g., "outdated config"). Use short labels that describe the snippet purpose (file path, config key, etc.).
- **Output**: Complete DSL block containing all three sections (`CURRENT_PROGRESS`, `KEY_LEARNINGS`, `VERBATIM_CONTEXT`) formatted as specified in §4.1. Empty `ADD` or `ARCHIVE` lists may appear as `ADD:` followed by `(none)` or be omitted entirely—implementation must support both forms.



## 6. Parsing & Merge Logic
- Implement parsers for each section using deterministic finite state machines or robust regex with validation.
- Steps:
	1. Normalize whitespace (convert tabs to spaces, trim trailing whitespace, ensure newline at EOF).
	2. Extract each section by header name; default to “no change” for missing sections.
	3. For `ADD` lists, collect `(reason, content)` pairs; reason is text after `because` up to first `:`, content is rest of line (plus multi-line block for verbatim context).
	4. For `ARCHIVE`, collect `(id, reason)` pairs.
	5. Validate data invariants (non-empty reasons, known IDs, required bullets present).
- Apply updates in order: rewrite `Current Progress`, process key learning operations, process verbatim context operations. Unknown IDs trigger re-prompt or user intervention.

