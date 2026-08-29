# Rocky — Design Notes

Running log of architecture decisions, tradeoffs, and things I'd do differently.
Updated as each milestone lands.

## Status

| Milestone | State |
|---|---|
| 1. Minimal working agent | **done** — validated live |
| 2. Permissions and safety | **done** — validated live |
| 3. Context management | **done** |
| 4. TUI | **done** — validated live: streaming markdown, syntax highlighting, collapsible tool output, Esc-to-interrupt, `/expand` `/model`. Second pass: Tab completion, persistent history, type-ahead queueing. Third pass: OpenTUI split-footer app (`src/tui/app/`) — Solid editor/status/spinner/permission-dialog over inline scrollback; legacy behind `ROCKY_LEGACY_TUI=1` |
| 5. Power features | **done** — validated live: sub-agents, plan mode, project memory. Hooks, MCP, and `/undo` cut by user decision |
| 6. Reliability and evals | **mostly done** — retry wrapper and `bench/` shipped in the coding-performance pass; resumable streaming and `--resume` deferred |
| 7. Coding-performance pass | **done** — todo_write, post-edit checks, multi-edit, token-aware compaction, honest sub-agent stop reasons, provider retries, `bench/`. Background bash and `--resume` deferred by user decision |

783 tests, typecheck clean.

### Live validation

Run against a real local model (`qwen3.5:4b` via Ollama) on a scratch git repo
containing a genuinely broken function:

| Provider | Result |
|---|---|
| `ollama` (native `/api/chat`) | ✅ ran the failing check → read the file → `edit_file` → re-ran → PASS, exit 0 |
| `openai-compatible` (Ollama's `/v1`) | ✅ same task, same outcome |
| `anthropic` | ⚠️ unverified — no credentials in this environment |

Verified independently of the agent's own transcript: `git diff` showed a
one-line change, an untouched neighbouring function, and `bun run verify.ts`
exiting 0. A separate read-only task ("which files reference `add`? change
nothing") left `git status` clean.

**Permissions** were validated across all five modes against the same model:
`ask` with no TTY refused every write and stopped cleanly; `--yolo` ran and
fixed the bug; `auto-edit` allowed the edit and refused bash; `auto-edit
--allow "bun run" --allow cd` completed with zero prompts and zero denials; and
`--yolo --deny "bun run"` was refused with the rule and matching segment named.

**Compaction** was validated by driving `compactSession` against the live model
with a realistic single-prompt agentic history: 11 messages → 4, eight
summarized, zero orphaned `tool_result`s, the tail byte-identical, the recap a
valid plain user turn. The recap even preserved a rejected approach ("tried
4-space indent first; the file uses 2"), which is exactly what stops a compacted
agent from repeating failed work.

**Capability discovery** was validated against the live server. Before
`prepare()` the provider reports `DEFAULT_CONTEXT_WINDOW` (126,000); after, it
reports the advertised `qwen35.context_length = 262144` capped by
`AUTO_CONTEXT_CAP` — 32,768 at the time; the cap has since been raised to the
126k default. An end-to-end `-p` run then showed the meter reading `6% of 33k`
(re-verified as `of 126k` after the raise), proving the discovered number
reaches the session's accounting and not just the provider. `think: true` was sent (the model lists
the `thinking` capability) and 987 characters of reasoning came back. An
explicit `contextWindow` in config still beat the probe, and `prepare()` against
an unreachable port returned quietly, leaving the default in place.

**The TUI** was validated in a real pty, because everything it does is gated on
`isTTY` and a piped run exercises none of it. `script -qfec "bun run src/cli.ts
…" /dev/null` allocates a pseudo-terminal, so the markdown renderer, colour, and
raw-mode key handling all run for real. Three pty runs: the first found three
bugs (below), the second confirmed the fixes with headings, bold, bullets and
inline code rendering and `--no-thinking` honoured, and the third (against
`nemotron-3-nano:30b-cloud`) forced a TypeScript fence and showed every token
class painted correctly — keyword, type, number, string, comment, function,
punctuation — with the closing fence consumed rather than printed. Streamed
gray thinking from the reasoning model rendered cleanly alongside.

**Milestone 5** was validated live against `nemotron-3-nano:30b-cloud`, one
feature per run. *Memory:* a scratch `ROCKY.md` saying "end every answer with
AMAZE" produced `4\nAMAZE` from a `-p` run. *Plan mode:* asked to create a
file under `--permission-mode plan`, the model's write was refused, no file
appeared, and it recovered from the denial into a numbered plan ending with
"respond with /plan to leave plan mode" — the denial text steering the model
exactly as designed. *Sub-agents:* told to delegate with `readOnly: true`, the
parent called `task(count .txt files)`, the child explored invisibly, and the
correct report (`2 — a.txt, b.txt`) came back as the tool result, with the
child's spend absorbed into the parent's cost line.

**The input pass** was validated in a pty with paced input: `/cl<Tab>` completed
to `/clear` and ran; `/cmpact` was caught as an unknown command instead of being
sent to the model; a second prompt typed *while a bash tool call was running*
appeared exactly once in the raw capture — echoed with the `›` glyph after the
turn and executed as its own turn ("POLO" came back); the history file held both
sessions' prompts in order; and a permission prompt still read its `y` cleanly
with the watcher paused. Two duplicate-echo bugs were found and fixed along the
way (below).

**The coding-performance pass** was validated live feature by feature.
*Todo:* a three-part task showed the checklist evolving in the TUI — `☐ ☐ ☐`,
then `✓ ✓ →` mid-task, then `✓ ✓ ✓` — with a failed edit self-corrected along
the way. *Checks:* with `check: "bunx tsc --noEmit"` in a scratch project, an
edit that broke a caller in another file drew `⏺ check … ⎿ main.ts(2,20):
error TS2345`, and the model fixed the caller unprompted before its second
check passed. *Retries:* a dead endpoint burned ~6s of jittered attempts and
then produced the same actionable error as before, instead of failing on the
first connection refused. *Sub-agents:* a child denied its write reported the
denial honestly through the task result. Two things resisted live validation
and are covered deterministically instead: forcing a live model to stonewall
into the cap/denied-streak paths (mock-provider tests pin both), and getting
nemotron to emit the nested `edits` array — it either flaked JSON-as-prose or
fell back to `write_file` (its instruction-following ceiling, not a tool
defect; seven unit tests pin the `edits` semantics including atomicity).

The Anthropic path shares the loop, tools, TUI, and session code with the two
that are verified; what remains unexercised is `provider/anthropic.ts` — the SDK
call, thinking-block round-trip, and cache breakpoints (which have unit tests).

## The shape

```
cli.ts ──▶ Session ──▶ runTurn() ──▶ Provider ──▶ Anthropic Messages API
                          │
                          ├──▶ ToolRegistry ──▶ Tool.run(input, ctx)
                          └──▶ LoopEvent stream ──▶ Renderer ──▶ stdout (scrollback)
                                                                     ▲
                        src/tui/app (Solid) ──▶ OpenTUI split-footer ┘
                        editor · status · spinner · permission dialog
```

Three rules the code enforces:

1. **The loop is tiny and pure.** `runTurn` is one file, one function, no I/O of
   its own. It never writes to stdout, never reads a global, never throws for a
   tool failure. It yields `LoopEvent`s; the TUI, the `-p` runner, and the tests
   all consume the same stream. That is what makes the agent observable.
2. **Complexity lives in the tools.** Truncation, path resolution, diffing,
   process-group management — all inside tool handlers, which are pure functions
   of `(input, ctx)` and unit-tested including their failure paths.
3. **Errors are data.** A tool that fails returns a `tool_result` with
   `is_error: true` and a diagnostic aimed at the model. Nothing crashes the
   session. A tool handler that *throws* is caught and converted, because a bug
   in a tool should not lose the user's conversation.

## Decisions

### Our own message types, not the SDK's

`src/core/types.ts` defines `Message`/`ContentBlock` independently of
`@anthropic-ai/sdk`. The provider adapts at its boundary. This costs ~60 lines of
mapping and buys: an OpenAI-compatible provider that doesn't leak Anthropic
shapes upward, a `MockProvider` that tests can drive without SDK types, and a
single place where `unknown` narrowing happens.

### Type erasure at the registry, not `any`

Tools have different input types, so a `Tool<I>[]` can't be homogeneous.
Rather than `Tool<any>`, `erase()` wraps each tool so `run(input: unknown)`
validates with zod first. Validation lands exactly where untrusted model input
enters the system, and `any` never appears.

### Cache breakpoints are spaced, not just trailing

A breakpoint only searches back **20 content blocks** for a prior cache entry.
An agentic turn emits thinking + text + N tool_use, then N tool_results — easily
past 20. A single breakpoint at the end of the messages therefore *stops hitting*
once turns get fat, silently, with no error. `applyCacheBreakpoints` places up to
3 breakpoints ~12 blocks apart (the 4th of the API's limit goes on the system
prompt). Verified by unit test, not by hoping.

Corollary: `builtinTools` is a frozen, ordered array. Sorting or filtering it
per-request would move bytes in the cached prefix and invalidate everything.

### Compaction: one invariant, two policies

A cut at index `i` keeps `messages[i..]` and drops the rest. It is safe **exactly
when `messages[i]` carries no `tool_result`** — a result's matching `tool_use`
always lives in the message immediately before it, so anything kept after a safe
cut keeps its call too. Cutting *onto* a `tool_result` orphans a block and earns
a 400 from the API. That single predicate (`isSafeCut`) is the whole safety
story; everything else is policy.

Policy 1 cuts at a plain user turn, keeping the last `keepTurns` of them —
whole exchanges in, whole exchanges out, which makes the best recap.

Policy 2 exists because Policy 1 alone is useless where it matters most. A
`rocky -p "fix the bug"` run is **one** user message followed by fifty tool
calls: no user boundaries, so compaction could never fire on precisely the runs
that exhaust the window. The fallback keeps the last `keepMessages` messages and
snaps the cut *forward* to the nearest safe index. I only noticed this while
writing the live test; the unit tests were all green and all wrong about what
mattered.

The policies do not chain, with one amendment from the coding-performance
pass. Message counts lie — six messages can be six lines or six 30KB tool
results — so the cut is now also governed by `keepTokens`, a cheap estimate
(utf8 bytes / 4) that `compactSession` defaults to 20% of the model's window.
If enough user boundaries exist, Policy 1 still owns the decision — including
the decision to decline — **unless its kept tail is over the token budget**,
in which case it falls through to Policy 2, which picks the largest tail that
fits and snaps forward to a safe cut. The original no-chaining rule protected
short conversations from the aggressive policy; keeping that promise when the
tail alone still crowds the window would defeat the point of compacting. With
no budget set, behaviour is byte-for-byte the old one, which the tests pin.

Other decisions:

- **The in-flight tail is never summarized.** It is copied byte-for-byte, so the
  tool results the model is currently reasoning about survive untouched.
- **The recap enters as a tagged user turn** (`<conversation_summary>`), not as a
  system segment. A system-prompt edit would move bytes in the cached prefix and
  invalidate every breakpoint behind it.
- **Summarization runs with no tools, no thinking, and `effort: low`.** It is a
  reading task. Thinking blocks would be generated and immediately discarded.
- **Compaction bills to the session** and increments `compactions`, so `/cost`
  tells the truth about what the feature costs.
- **The meter resets after compacting.** No request has run to measure the new
  prompt, so reporting the *old* size would immediately re-trigger compaction.
  Zero reads as "unknown until the next turn", which is honest.
- **An empty or aborted recap is a failure, not a summary.** Better to run over
  budget than to silently replace the conversation with nothing.
- **At most one compaction per user turn.** `compactedThisTurn` is set on a
  successful pass; a no-op ("nothing safe to drop") leaves it open, since that
  pass cost nothing and a later iteration may have a safe cut. A tail that is
  still over threshold rides out the turn rather than buying a second
  summarization and cutting into the work in progress.

### Tool-result hygiene lives in one place

`capToolResult` runs in the loop, on every tool's output, rather than inside
each tool. `bash` and `grep` used to truncate themselves; a seventh tool would
have forgotten to. Over the cap, the result keeps its head and tail, states how
many bytes went missing, and points at the full copy under
`.rocky/session/<id>/outputs/` so the model can go read it. `meta` is never
capped — it doesn't reach the model.

The archive counter now hangs off the `Session` (`createArchiver`) rather than
module scope, which was a latent collision the moment two sessions share a
process — exactly what Milestone 5's sub-agents will do.

### Permissions: structural matching, and one asymmetry

Rules are matched against a **parsed** command, never a regex over the raw
string. `rm -rf /`, `echo hi && rm -rf /`, `/bin/rm -r -f /`, and
`sudo -u root rm -rf /` all reach the same verdict; `echo "rm -rf /"` does not.

A rule (`git push --force`) matches when the executable matches by basename, its
positionals are a **prefix** of the command's (`bun test` allows `bun test src/x`
but not `bun run x`), and its flags are **present anywhere** (flag order is free,
and `-rf` decomposes to `-r -f` so `rm -r -f` cannot dodge a `rm -rf` rule).
`--force` deliberately does not match `--force-with-lease`.

Precedence, highest first: **deny** (builtin + configured) → read-only tools →
**yolo** → allow rules → auto-edit → ask the user.

Four decisions worth defending:

- **Deny beats yolo.** Yolo means "stop asking", not "disable the brakes". The
  builtin list is deliberately tiny — `rm -rf /`, `mkfs`, `shutdown` — a
  backstop against catastrophe, not a policy engine.
- **Deny is generous, allow is strict.** For deny matching, wrapper executables
  (`sudo`, `env`, `timeout`, `xargs`, …) are peeled by testing *every suffix* of
  their argv, because `sudo -u root rm -rf /` defeats any skip-the-flags
  heuristic — `root` is a value, not a flag. Allow matching uses the raw
  segment, so a rule for `bun test` never blesses `sudo bun test`. Only wrappers
  get suffix treatment, so `echo rm -rf /` is not mistaken for a deletion.
- **A file-writing redirect is a separate capability.** `bun test` grants
  running tests, not `bun test > /etc/passwd`. Segments with `>`, `>>`, or `&>`
  always prompt. Descriptor duplication (`2>&1`) and input redirection (`< f`)
  do not.
- **Anything the shell could rewrite is never auto-allowed.** `$(...)`,
  backticks, process substitution, `eval`, `exec`, `source` force a prompt even
  when the allowlist covers the visible text.

"Always allow" grants narrowly: `git status --short` grants `git status`, not
`git`. A compound or dynamic line grants **nothing** — the user approved a
pipeline, not a blanket capability — so the next identical call asks again.
Persisted grants go to `.rocky/settings.json`, with bash rules and whole-tool
grants (`edit_file`) in separate buckets, because a tool name can never match a
bash segment.

With no TTY, `ask` **denies** rather than hangs, and the denial tells the
operator exactly how to unblock: `--yolo`, `--permission-mode auto-edit`, or the
precise rule to add. Read-only tools never prompt, so `rocky -p "which files
reference X?"` works with no configuration at all.

**Testing note.** The deny paths are exercised by unit tests that *decide*
without executing. I do not run `rm -rf /` against a real filesystem to check
that the deny list catches it; a passing test that depended on the deny list
working would be worthless if it didn't.

### Bugs the live runs found (context management)

- **Compaction could never fire in `-p` mode.** `findCutIndex` only cut at plain
  user turns, and a one-shot run has exactly one. Every unit test passed and all
  of them were testing the wrong shape. Fixed with the fallback policy above.
- **Rocky never told Ollama its context size.** Ollama defaults `num_ctx` to
  ~4096 and *silently truncates* longer prompts — the model loses the head of
  its prompt, usually the system prompt, and starts behaving oddly, while
  Rocky's meter cheerfully reports headroom. See *Asking the model what it can
  do* below for the fix.
- **`-p` printed an empty line and exited 0** when the model ended its turn with
  no text, which reads as a successful empty answer. It now warns on stderr —
  but still exits 0, because exit codes report errors, not chattiness. Failing a
  CI run because the agent did the work without narrating it would be worse.

### Bugs the live runs found (permissions)

- **`2>&1` was parsed as a background `&`**, splitting `bun run verify.ts 2>&1`
  into two segments and defeating an otherwise-correct allow rule. Redirections
  are now matched before operators.
- **`>` was an ordinary token**, so a `bun test` rule would have permitted
  `bun test > /etc/passwd`. Output redirection is now its own capability.
- **`sudo rm -rf /` bypassed the deny list**, because the executable was `sudo`.
- **A denied turn hammered the wall.** The model retried refused calls until the
  100-iteration cap — two minutes of nothing. The loop now stops after 2
  consecutive iterations in which *every* call was refused, while still
  appending the tool_results that keep the transcript valid.
- **The denial line showed the model's `description`, not the command.** A
  security message that says "run the verification script" instead of
  `cd /tmp && bun run verify.ts 2>&1` is worse than useless, so `bash.summarize`
  now always returns the command and the `description` field is gone.

### Asking the model what it can do

`Provider.prepare(model)` is an optional one-time discovery hook, called once at
session start. Anthropic doesn't implement it — it knows its own models. Ollama
does: `POST /api/show` reports the model's trained context length and its
capability list.

Two numbers, and the discipline is that they are the same number: **what Rocky
accounts against and what Rocky requests must never drift.** The meter, the
compaction threshold, and `options.num_ctx` all read `contextWindow()`.

The catch is that models advertise what they were *trained* for, not what your
machine can hold. `qwen3.5:4b` reports **262144** tokens; that KV cache runs to
tens of gigabytes. Ollama's own answer is to default to 4096 and truncate
silently — safe, but dishonest. Rocky uses the model's real window, capped at
`AUTO_CONTEXT_CAP`, with `provider.contextWindow` overriding in either
direction. A model whose real window is smaller (an 8k Llama) is used as-is,
never padded up to the cap — Ollama would happily allocate a window the model
was never trained to fill.

The cap started at 32k on a local-hardware argument, and the user overruled it:
Rocky in practice drives *cloud-hosted* Ollama models, where the caution only
wasted context. The cap is now `DEFAULT_CONTEXT_WINDOW` (126k) — so every
capable model simply runs at the full default, verified live with the meter
reading `of 126k`.

The capability list also settles the `think` flag, which was previously an
opt-in config knob because Ollama *errors* when a non-thinking model is told to
think. Now `prepare()` reads `capabilities: [..., "thinking"]` and decides;
`provider.think` still forces it either way.

`prepare()` never throws. A server that is down, a model that is not pulled, a
404, a payload with no `context_length` — all leave the defaults in place and
let the failure surface on the first real request, where the error message is
far more useful than "probe failed".

**Precedence, in one line:** explicit config → discovered → `DEFAULT_CONTEXT_WINDOW`
(126k, deliberately just under a real 128k window so compaction fires before the
edge rather than on it).

### Three providers behind one interface

`Provider` is nine lines: `stream()`, `contextWindow()`, `pricing()`. Three
implementations:

| Kind | Transport | Notes |
|---|---|---|
| `anthropic` | SDK, SSE | thinking + signatures, `effort`, prompt-cache breakpoints |
| `openai` / `openai-compatible` | `fetch`, SSE | OpenAI, llama.cpp, vLLM, LM Studio, OpenRouter |
| `ollama` | `fetch`, NDJSON | native `/api/chat`: streams `thinking`, real token counts |

Ollama gets a native provider rather than being pointed at its own `/v1` shim,
because the native endpoint exposes the `thinking` field and true
`prompt_eval_count` / `eval_count`. Both paths are tested; the `/v1` shim works
if you prefer it.

Three things the non-Anthropic providers must get right, all of which have tests:

- **Tool-call assembly.** OpenAI streams `arguments` as string fragments keyed by
  array index, with `id`/`name` only on the first fragment.
  `ToolCallAccumulator` reassembles them. Ollama instead delivers arguments
  pre-parsed and supplies **no call id at all**, so we synthesize stable ids and
  resolve them back to tool *names* when replaying history — Ollama matches tool
  results by `tool_name`, not by id.
- **Usage arithmetic.** OpenAI's `prompt_tokens` *includes* cached tokens;
  Anthropic's `input_tokens` *excludes* them. We subtract on the OpenAI side so
  `promptTokens()` is a true total on every provider, and the context meter
  means the same thing everywhere.
- **Reasoning is display-only.** Neither OpenAI nor Ollama can round-trip a
  reasoning signature, so thinking is streamed as `thinking_delta` events for
  the TUI and deliberately **never written into the message history**. Faking it
  would corrupt the next request.

Capabilities that don't exist are not emulated: `reasoning_effort` (OpenAI) and
`think` (Ollama) are **opt-in config flags**, because sending either to a model
that doesn't support it is a hard request error. Defaults work with any model.

A malformed tool-argument JSON string becomes
`{__malformed_arguments__: "..."}` rather than an exception, so a weak model's
bad output arrives as a validation error it can fix, not a crash.

### The abort bug the tests caught twice

`postStream` was awaited *outside* the try/catch. Bun (and some real servers)
withhold response headers until the first body chunk, so an abort during that
window rejects `fetch` itself — the error escaped the generator instead of
becoming a clean `stopReason: "aborted"`. Also, `fetch` rejects with a
`DOMException`, which is not an `instanceof Error` in every runtime, so the
abort check tests `err.name` structurally.

### `detached: true` on bash — the bug that mattered

Signalling `bash -c` does **not** kill its children. Bash defers SIGTERM while
waiting on a foreground command, so `sleep 5` survives. Worse: the orphan
inherits the stdout pipe, so `new Response(proc.stdout).text()` blocks until the
orphan exits anyway — the timeout appears to do nothing.

Fix: spawn into a new process group (`detached: true`) and signal `-pid`, with a
SIGKILL escalation after 2s. Before the fix, three timeout tests each hung the
full 5 seconds; the suite ran in 15s. After: 0.4s. This is the kind of bug that
looks like "the timeout works" in a demo and wedges an agent in production.

A side effect worth having: the child is in its own process group, so a Ctrl-C
delivered to Rocky's foreground group doesn't reach it. Interruption goes through
the `AbortSignal` we control, not through terminal signal semantics.

### `edit_file` diagnostics are the reliability story

Most agent failures on file edits are one of: wrong indentation, stale content,
non-unique target, or line-number prefixes copied from `read_file`. Each gets a
distinct message:

- **0 matches** → LCS-based fuzzy search for the closest same-height block,
  reported with its line number, a similarity score, and a unified diff between
  what the model sent and what the file actually says.
- **N matches** → the count and every line number, plus the two ways out
  (extend `old_str`, or pass `replace_all`).
- **`old_str` contains `1\t…`** → called out explicitly.

The integration test asserts the model can go from a botched edit to a correct
one in a single following call, with no re-read.

### Read-only tools run in parallel; anything else serializes

`glob`/`grep`/`read_file` in one assistant turn execute concurrently. The moment
a batch contains a mutating tool, the whole batch serializes — two `edit_file`
calls against one file must not interleave. All results land in **one** user
message: splitting them across messages both breaks the API contract and trains
the model out of parallel tool calls.

### Abort keeps the transcript valid

On interrupt the provider salvages completed text blocks only. A dangling
`tool_use` with no `tool_result`, or a `thinking` block whose `signature` never
arrived, would make the *next* request a 400. A test asserts the tool_use ids and
tool_result ids match as multisets after an abort.

### `.rocky/` ignores itself

The live run surfaced Rocky polluting the user's `git status` with `?? .rocky/`.
Rather than editing the user's `.gitignore`, the session writes
`.rocky/.gitignore` containing `*` on creation. Session logs, archived tool
output, and (later) undo pre-images stay invisible to git without touching
anything the user owns. `.rocky` is also excluded from the directory snapshot in
the system prompt — it's our bookkeeping, not context.

### Cost accounting prices cache tiers separately

Cache writes bill at 1.25×, reads at 0.1×. The context meter uses
`input + cache_creation + cache_read`, not `input_tokens` alone — after a few
cached turns `input_tokens` is a tiny fraction of the real prompt, and a meter
built on it would read ~2% while the window fills.

### Markdown renders character by character, not line by line

The obvious streaming-markdown implementation buffers each line and renders it
on `\n`. Simple, and wrong for this product: models emit prose as long lines,
so the user would watch a spinner and then get a paragraph in one jolt.
Perceived speed is the axis we compete on, so `MarkdownStream` buffers only as
far as it must to decide what it is looking at:

- **At line start** it holds characters while the prefix could still be a block
  construct (`#`, `- `, `> `, ` ``` `, `1. `, `---`) and commits the moment it
  can't be — at most ~3 characters of latency, and only on lines that look
  structural. `decide()` returns `"more"` only while genuinely ambiguous.
- **Inline**, it opens the ANSI style when it sees `**` and closes it at the
  match, streaming the bolded text live. Lookahead is one character, to tell
  `*` from `**`. An unclosed `**` or `` ` `` is closed at end of line rather
  than bleeding colour into the rest of the transcript.
- **Code fences are the one place it buffers a full line**, because a syntax
  highlighter cannot classify half a token. Code lines are short; prose lines
  are not.

The invariant that makes this safe is **chunk invariance**: network deltas may
split any construct at any character, so output must not depend on where the
cuts fall. The test suite renders a corpus at chunk sizes 1, 2, 3, 5 and 7 and
asserts each matches the whole-string render byte for byte.

Two deliberate omissions: `_` never means emphasis, because models write
`snake_case` far more often than `_emphasis_` and corrupting an identifier is
worse than under-styling a word; and links render as literal `[text](url)`,
because a terminal cannot hide a URL the user may want to copy.

### The syntax highlighter is a lexer, not a pile of regexes

Regex-replace highlighting has a classic failure family: keywords matched
inside strings, comment markers matched inside strings, quotes matched inside
comments. `highlight.ts` instead lexes left to right, so a string consumes its
own contents before a keyword pattern ever sees them. Multi-line constructs
(`/* */`, backtick templates, Python docstrings) carry a `pending` state across
lines — per fence, not per stream, so one unterminated comment can't poison the
next code block. The whole thing is held to a round-trip invariant: the tokens
of any line must rejoin to exactly that line, which makes "the highlighter ate
my code" structurally impossible. Six language specs (~30 lines each) cover
what models actually emit; an unknown language renders unstyled rather than
failing.

### "Collapsible" tool output, in a medium that can't fold

A line-oriented terminal cannot un-print, so a folding widget is off the table.
Collapsible here means: output over 10 lines prints its first 6 plus
`… N more lines · /expand 3`, while the full text is kept in a `ToolLog` shared
across turns. `/expand <n>` (default: the most recent) reprints the whole thing
on demand. Nothing is ever lost, and the transcript stays scannable. `-v`
disables collapsing entirely.

### Esc-to-interrupt, and why the key watcher must handle Ctrl-C itself

Reading Esc requires raw mode, and raw mode stops the terminal from turning
Ctrl-C into SIGINT — take stdin and you silently break the user's most
instinctive abort. So `watchKeys` classifies `0x03` itself and forwards it to
the SIGINT handler. A lone `0x1b` is Esc; arrow keys arrive as `\x1b[A` in the
same read, so buffer length distinguishes them without a timeout heuristic. Two
sharing rules keep the keyboard sane: the watcher pauses for the duration of a
permission prompt (which reads its own keypress — otherwise they race for the
byte), and it is inert when stdin is not a TTY so pipes behave.

This is the legacy path, kept behind `ROCKY_LEGACY_TUI=1` for one release. The
footer app below replaces it: OpenTUI owns stdin for the whole session, so the
three-way contention it describes simply stops existing.

### The footer app: OpenTUI without giving up scrollback

The conversation is Rocky's transcript, and the transcript belongs in the
terminal's own scrollback — scroll it, search it, copy it, keep it after exit.
That is the Claude Code idiom and the one thing a full-screen alternate-buffer
TUI framework gives up. OpenTUI's `screenMode: "split-footer"` is the way to
have both: OpenTUI pins a fixed region at the bottom of the *main* screen and
lets scrollback flow above it, and `externalOutputMode: "capture-stdout"`
replays ordinary `process.stdout.write` calls into that scrollback as
line-oriented commits. So the entire streaming renderer (`render.ts`,
`markdown.ts`, `highlight.ts`) is untouched — it still writes SGR-styled text to
stdout — and only the footer is rebuilt in Solid (`src/tui/app/`): the editor, a
status row, the wait spinner, and the permission dialog.

What this buys, beyond looks: OpenTUI holds raw mode continuously, so there is
one keyboard handler (`app.tsx`) that routes by what is on screen — dialog open
→ dialog; a turn running → Esc interrupts; otherwise the editor. The editor is a
real `<textarea>` (history, multi-line, bracketed paste, kitty Shift+Enter) in
place of 400 lines of hand-decoded escape sequences, and type-ahead needs no
code at all: the editor stays mounted during a turn, Enter pushes onto an
`AsyncQueue` the REPL drains next, unfinished text just stays put. The
permission prompt stops being a raw single-key read racing the spinner and
becomes a promise the tool loop awaits while a dialog component owns the footer;
because the dialog vanishes when answered, the decision is echoed one line into
scrollback so the transcript still records it.

Two seams took care. Bun's `console.log` writes to fd 1 directly, bypassing the
`process.stdout.write` hook that capture-stdout replays — so `boot.ts` rebinds
the console through the intercepted stream for the renderer's lifetime, or every
logged line would land raw *inside* the footer and be overpainted. And
capture-stdout commits scrollback per line, but `MarkdownStream` flushes
partial lines mid-paragraph with no trailing `\n`; OpenTUI's upstream build
snapshots each captured chunk as a plain string, dropping all the ANSI styling
Rocky's whole renderer emits. A vendored patch (`patches/@opentui%2Fcore…`)
teaches the capture path to parse SGR sequences into styled spans, so colour
survives the trip into scrollback. Both are load-bearing; the `--tui-smoke`
harness exists to hammer exactly the partial-line-with-colour case.

### The face, and the mascot

Rocky's namesake is the Eridian from *Project Hail Mary*, and the welcome box
leans into it where it costs nothing: an ASCII mascot with a rock carapace,
five radial legs and **no eyes** (Eridians perceive by sound — hence the ♫),
"Amaze!" in the banner, and `♫ fist my bump` on a clean exit. Personality lives
entirely at the edges — banner, idle verbs, sign-off — never in the transcript,
which stays strictly informational.

The structural pieces, all in the Claude Code idiom:

- **The welcome box** (`banner.ts`) is a pure function of its inputs, so the
  alignment math is unit-testable: every row the same visible width
  (`stripAnsi` before measuring), lines truncated with `…` rather than
  breaking the frame, a plain-line fallback under 44 columns, and `~` for the
  home directory.
- **Tool calls draw as `⏺ name(args)` with results hanging off a `⎿` elbow**,
  continuation lines aligned beneath it. The header is always one line —
  multi-line summaries flatten, overlong ones truncate to the terminal.
- **Silence now has a face.** The two stretches where nothing streams — model
  latency at turn start and after each tool result — show a spinner with a
  rotating Eridian verb, a live elapsed clock, and the escape hint:
  `⠹ Resonating… 4s · esc to interrupt`. The clock counts the current wait,
  not the turn, because "how long has nothing happened" is the question the
  user is actually asking. The spinner paints its first frame immediately; one
  that appears 80ms late looks laggy.
- **The spinner yields to permission prompts.** The wait spinner can now be
  running when an approval question appears, and a line repainting every 80ms
  erases the question as fast as it is asked. The `approve` wrapper already
  paused the key watcher; it now calls `renderer.quiet()` too. Same seam, same
  reason: one keyboard, one status line.
- **The summary line styles itself part by part** instead of being wrapped in
  `gray()` by its caller — which fixes the colour bleed where the meter's inner
  reset cancelled the outer gray for the rest of the line.

One bug found live, once again by `script(1)`: a pty whose size was never set
reports **0 columns**, which slipped past `?? 80` and demoted the banner to its
narrow-terminal fallback. Zero means "unknown", not "too narrow"; the fallback
is now reserved for real narrow terminals.

### Bugs the live runs found (TUI)

All three were invisible to a green 585-test suite, because each test encoded
the shape I imagined rather than the shape a model and a terminal produce:

- **The closing fence printed as a line of code** whenever a message *ended* on
  ` ``` ` with no trailing newline — which models do routinely. Every unit test
  had politely put a `\n` after the fence. `flush()` now recognises a pending
  close.
- **`ERR_USE_AFTER_CLOSE` crash on `/exit`.** The raw-mode watcher consumed
  stdin during the turn; when it handed the terminal back, readline saw EOF and
  closed, and the next `rl.question` threw. Fixed with a close flag and a
  `readLine` helper that catches exactly that error code and rethrows anything
  else.
- **`--no-thinking` was silently ignored.** The provider only ever sent
  `think: true`, and a reasoning model reasons *by default* — omission does not
  mean off. Two existing tests had encoded the bug (asserting `think` absent
  when thinking is off); the fix sends an explicit `false` to any model that
  understands the field.

### The input line: completion, history, type-ahead

The second UI pass took aim at what Claude Code and OpenCode get right about
the *prompt itself*, inside the readline architecture rather than replacing it.
All the logic lives in `input.ts` as pure functions over strings; `cli.ts`
wires them to readline and the filesystem.

- **One command table.** `SLASH_COMMANDS` feeds `/help`, Tab completion, and
  the unknown-command check. A command added there is everywhere; the old
  hand-copied `/help` list could drift.
- **Tab completes commands, never arguments** — arguments are paths, model ids
  and numbers we cannot guess, and a wrong guess is worse than no completion.
- **A lone `/word` that isn't a command is refused locally.** `/cmpact` sent to
  the model wastes a round-trip that can only shrug. Paths pass through:
  `/etc/hosts` has a second slash and never matches the command shape.
- **History persists to `~/.rocky/history`**, shell-style: oldest-first on
  disk (a tail reads like a session log), newest-first for readline, capped at
  1000. History is a convenience, never a reason to fail — a missing file is
  the first run; an unreadable one costs recall, not the session.
- **Type-ahead queues instead of vanishing.** The raw-mode key watcher already
  owned the keyboard mid-turn; now it keeps what it hears. After the turn,
  completed lines become queued prompts (echoed with the `›` glyph so the
  transcript reads as if typed at the prompt), and the unfinished tail is
  written back into the editor via `rl.write`. Decoding honours the user's own
  corrections: backspace deletes, arrow-key escape sequences vanish, control
  bytes drop.

The pass also found two duplicate-echo bugs in the readline/raw-mode handoff —
the seam I had earlier deferred type-ahead over, and it bit exactly as
predicted, both times invisible to unit tests and caught only in a pty:

- **Dispose left the tty cooked.** Readline sets raw mode once when it takes a
  terminal and assumes it keeps it; the key watcher's dispose handed back
  *cooked* mode, so from the second prompt on the kernel's echo printed on top
  of readline's and every typed line appeared twice. Dispose now restores the
  raw state it found.
- **Readline still heard mid-turn keys.** `rl.pause()` pauses the shared
  stream, but the watcher's own `stdin.resume()` restarts flow for *every*
  listener — readline's keypress pump echoed mid-turn typing into the spinner
  line even with no question pending. The watcher now detaches the stream's
  other `data` listeners for its whole lifetime (including during permission
  prompts, which read their own key) and reattaches them at dispose.

One smaller fix from the same runs: bash's permission prompt printed the
command twice, because the tool's preview *is* the command and the prompt
showed both the headline and the preview. A preview that repeats the headline
is now skipped.

### Project memory: one file, loudly or not at all

`ROCKY.md` wins over `AGENTS.md`, and exactly one is loaded — merging two
overlapping instruction sets invites contradictions no model resolves well.
The segment rides in `extraSystem` between the two cached system segments, so
the trailing environment breakpoint still covers it. Two sharp edges chosen
deliberately: a memory file that exists but cannot be read **throws** instead
of being skipped, because silently ignoring instructions the user wrote down
is the failure nobody notices until the agent misbehaves; and the content is
capped at 24KB, because memory taxes every request — anything longer belongs
in the repo as docs the agent reads on demand. Memory flows down into
sub-agents; they work in the same project.

### Plan mode refuses; it does not negotiate

Plan mode is a fourth permission mode, slotted between "read-only always
allowed" and "yolo" in the engine's precedence. Its promise is that *nothing
can change*, so mutating calls are refused outright rather than prompted — a
prompt would be an offer to break the promise. The denial text is written for
the model, not the user: it says finish investigating, present the plan, and
ask the user to run `/plan`. The live run showed exactly that recovery. Two
details: `bash` is refused wholesale because a shell command cannot prove
itself read-only, and `/plan` toggling goes through `engine.setMode()` so
session grants and deny rules survive the switch. The plan-mode system segment
tells the model *why* writes fail; the engine enforces it regardless — belt
and braces, in that order of trust.

### Sub-agents: one level of delegation is the feature

The `task` tool runs a fresh `Session` against the same provider, model, and —
critically — the same `approve` gate: in ask mode a sub-agent's write still
prompts the user, and deny rules hold. The child gets the parent's toolset
minus `task` (or only the read-only tools when `readOnly: true`), so
delegation goes one level deep; nesting multiplies cost without adding
capability. Isolation is the point: only the child's collected prose returns
as the tool result, its exploration never lands in the parent's transcript,
and its spend is absorbed into the parent's totals in a `finally` — the money
was spent even if the child died mid-flight. The `readOnly` flag restricts the
*child's tools*, but the `task` tool itself is never marked read-only: that
flag is model-supplied input, and permission tiers must not be decidable by
the model.

### The coding-performance pass

A gap analysis against Claude Code / OpenCode / Codex CLI, scoped by the user
to the **core performance set** — everything that moves task completion and
wasted-turn counts, deferring background bash and `--resume`. Seven items, in
the order built:

- **Honest sub-agent stop reasons.** `StopReason` gained `max_iterations` and
  `denied` (loop-originated; no provider adapter touches them). A capped or
  permission-stalled child now reports `incomplete`, and `task` returns an
  error carrying the partial report instead of dressing it up as the answer.
- **Retries for the fetch providers** live inside `postStream`, giving both
  callers the same policy for free: 5 attempts on 408/429/5xx/529 and network
  errors, full-jitter exponential backoff, `Retry-After` honored as a floor
  (capped 30s), and a 60s **first-byte** timeout via a per-attempt controller —
  never a whole-request timeout, which would kill long generations mid-stream.
  The classification trap: both providers treat `AbortError` as "user
  interrupted", so a timeout must surface as `ProviderTimeoutError` (name
  deliberately not `"AbortError"`) or it would silently end the turn.
- **`bench/` — the yardstick before the features.** In-process harness reusing
  the integration-test shape: real loop, real tools, a temp repo, a live model
  from env, LoopEvent stream as the metrics feed. Scoring is external truth: a
  task's own verify command runs *after* the agent finishes, with `hidden/`
  acceptance files overlaid post-run so the agent can neither read the judge
  nor edit it. Out of `bun test` by construction; `bun bench/run.ts`.
- **`todo_write`** — whole-list replacement, no ids; "at most one in_progress"
  enforced by a zod refine so violations come back as fixable validation
  errors. `readOnly: true` on purpose: zero system effect, no prompt, legal in
  plan mode, and an exploring sub-agent may keep a plan. The model sees a
  one-line confirmation (the list already sits in the tool_use input; echoing
  would double its cost); the full list rides in `meta` for the TUI checklist.
- **Post-edit checks** hook the *batch* seam in the loop: any batch containing
  a successful `edit_file`/`write_file` runs the configured `check.command`
  once from the project root — per-batch is the debounce. Failures append a
  `<post_edit_check>` text block to the same user message as the tool results;
  the edit's own result is never marked failed (it landed — the check is
  information). A check that cannot run (127/126/spawn failure) disables
  itself for the session after one notice: a broken config must not tax every
  batch or send the model fixing the wrong thing.
- **Multi-edit** extends `edit_file` with an `edits` array rather than adding
  a tool — smaller cached prefix, no model choice-point, and the fuzzy
  diagnostics apply per hunk. Semantics: sequential in memory against the
  already-edited text, one write, all-or-nothing; a mid-list failure names the
  hunk (`edit 2 of 3 failed; NOTHING was applied`) and demands the corrected
  full list. The schema stays flat (`old_str`/`new_str` optional + optional
  `edits`, exclusivity via superRefine) because `jsonSchemaOf` forces a closed
  root object and weak local models handle flat optionals far better than
  `anyOf`.
- **Token-aware compaction** — see the amendment in the compaction section.

Bench, before → after, `nemotron-3-nano:30b-cloud`, 3 trials/task: overall
**4/9 → 7/9** (fix-failing-test 1/3 → 2/3, cross-file-rename 1/3 → 2/3,
add-feature-with-test 2/3 → 3/3). Two honesty notes the harness itself
surfaced: a first post-change run scored 5/9 because it shared the endpoint
with interactive runs and the model degraded into its "answer instantly, call
no tools" mode — bench runs need a quiet endpoint; and every remaining failure
is that same do-nothing mode (1 turn, 0 tools, ~1s), a model limitation the
metrics now make unmistakable rather than something a transcript could hide.

## Tradeoffs taken

- **No path jail.** `resolvePath` doesn't confine tools to the project root. A
  coding agent legitimately reads `~/.gitconfig` and sibling repos, and `bash`
  could escape a jail in one line regardless. Containment is the permission
  engine's job. What the shared resolver *does* guarantee is that the path shown
  in a permission prompt is the path that gets used.
- **The permission engine is not a sandbox.** It gates *tool calls*, and it
  reasons about shell syntax, not shell semantics. A sufficiently creative
  command that the allowlist covers can still do damage (`bun test` could run a
  malicious test). Real isolation is a container's job. What the engine buys is
  that nothing surprising happens without the user seeing the exact command
  first — which is the property that actually matters day to day.
- **`bash` re-`cd`s per call** instead of holding a long-lived shell. Persistent
  cwd is recovered by writing `pwd` to a temp file after the command. Simpler and
  crash-proof; the cost is that `export FOO=1` doesn't persist across calls.
- **Fuzzy match is O(lines × needle)** with an anchor prefilter above 5k lines,
  and switches from exact Levenshtein to trigram Jaccard on large blocks. Good
  enough for a diagnostic; it is not a merge algorithm.
- **SDK retries for Anthropic, our own for the fetch providers.** The shared
  wrapper lives inside `postStream`, so its scope is automatically "before the
  first byte"; resumable mid-stream recovery remains future work that neither
  path does.
- **Non-Anthropic `contextWindow` and `pricing` come from config.** Rocky cannot
  know the limits of `some-org/some-model` on OpenRouter, and guessing would
  make the context meter lie. Unset means a conservative 128k and $0.

## What I'd do differently

- `Session` is a mutable class that `runTurn` writes to. It works and it's
  legible, but it means the loop isn't *quite* pure — it appends messages as a
  side effect. A `(state, event) => state` reducer with the loop yielding
  intentions would make replay and `/undo` fall out for free. Worth revisiting
  before Milestone 5's undo journal, because that feature wants exactly this.
- ~~`archiveOutput` uses a module-level counter.~~ Fixed in Milestone 3:
  `createArchiver` hangs off the `Session`.
- ~~Compaction has no token-aware sizing.~~ Done in the coding-performance
  pass: `keepTokens` (bytes/4 estimate, default 20% of the window) governs the
  cut; `keepMessages` remains the unbudgeted fallback.
- ~~**Compaction can run twice in one turn**~~ if the kept tail is itself over
  threshold. It terminates (each pass drops at least `minDropped`), but it costs
  a summarization call each time. A `compactedThisTurn` guard would be one line;
  I left it out because the observable behaviour is correct and I would rather
  see it happen once in the wild than guess at the right policy. **Now in**: the
  flag is local to `runTurn`, set only on a *successful* pass, so the next user
  turn compacts again but the same turn never pays twice.
- ~~The renderer's markdown handling is currently "print the text".~~ Done in
  Milestone 4: streaming markdown, a real lexer, collapsible tool output.
- ~~Type-ahead during a turn is discarded.~~ Done in the input pass: the
  watcher buffers what it hears, completed lines queue as prompts, the tail
  prefills the editor. The deferral note called the readline/raw-mode handoff
  "the most fragile seam in the CLI"; it duly produced two echo bugs, both
  caught live and now pinned by tests.
- ~~The summary line's gray bleeds off early.~~ Fixed in the face-lift: the
  line styles itself segment by segment, so no outer wrap exists to cancel.
- `grep` shells out to `rg` and reports a clear error when it's absent. A
  bundled fallback would remove the dependency, but ripgrep's speed on large
  repos is most of the tool's value, so the dependency is deliberate.
- **A running sub-agent is a black box.** The user sees `⏺ task(…)` and a
  spinner until the child finishes; its tool calls stream nowhere. The loop
  could forward child events tagged with a depth for the renderer to indent —
  the event stream already supports it. Worth doing the first time a
  sub-agent runs for three silent minutes. **Half in**: `LoopEvent` carries an
  optional `depth`, and `runSubAgent` tees every child event to the parent's
  stream tagged `depth: 1`, emitted between the task call's `tool_start` and
  `tool_end`. Batched, not live — the sink drains after `tool.run` resolves,
  because streaming through a tool would make `Tool.run` a generator. The
  renderer does not indent yet; the tag is there for it.
- ~~A sub-agent that exhausts its 30 iterations reports as complete.~~ Fixed
  in the coding-performance pass: the loop yields `max_iterations` (and the
  denied-streak stop yields `denied`), and `runSubAgent` marks both incomplete,
  so the `task` tool returns an error carrying the partial report. The
  hesitation about widening `StopReason` was settled by it biting.

## TrueForge orchestration backend

The hackathon path adds a backend boundary below the renderer. `LocalBackend`
keeps Rocky's original provider loop intact; `TrueForgeBackend` is the default
and delegates ownership of the root loop, durable sessions, compaction,
dynamic subagents, MCP, Daytona, and tool approvals to TrueForge. SDK events
normalize into the same `LoopEvent` stream, so both backends retain the normal
scrollback renderer and footer. The TrueForge session ID, active turn, snapshot
attachment state, and SSE sequence cursor persist under `.rocky/trueforge/`;
disconnects resume with `subscribeToTurn`, while interruption cancels the
server session.

The localhost worker broker is intentionally a separate security boundary. It
accepts bearer-authenticated MCP calls, records runs in SQLite, and launches
Codex, Claude Code, or OpenCode against independent snapshot extractions in
hardened containers. Worker output is only a candidate patch. TrueForge applies
that patch to a fresh Daytona copy and validates it before the destructive MCP
tool can enter the human approval flow.

The real checkout is never mounted into a worker. Snapshot manifests anchor
conflict detection; apply rejects unsafe paths, symlink crossings, binaries,
stale hashes, and patch conflicts, then records pre-images before an atomic
apply. Undo is equally approval-gated and refuses to overwrite later edits.
Generated tools remain session-scoped inside Daytona, and Rocky self-repair is
validated as a candidate patch that requires approval plus restart—neither is
loaded into the running host process.
