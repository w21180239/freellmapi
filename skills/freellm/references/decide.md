# Decide: probabilities instead of prose

The decision model answers 1-64 questions over one `state` (about 0.5-0.8 s per question). Output lines: `yesno  yes=90.7%`, `choice  auth (confidence 68.2%)  auth=88.4% flake=6.3%`, `score  level~1.68 of 0..2 (confidence 36.4%)  low=4.4% medium=23.6% high=72.0%`.

Reading rules:
- `yes=` is the probability of yes. At or above 85% treat it as a conclusion; 60-85% mark it uncertain; below 60% add context to the state and ask again.
- `choice` and `score` follow the same thresholds on `confidence`.
- `--levels` runs lowest first; reordering changes the meaning.

Writing the question:
- `state` holds facts (log lines, diff, error text), no guesses; a guess skews the probabilities.
- One question per id. Two judgements go in two questions (`--yesno` and `--choice` combine in one call).
- Options must be mutually exclusive. For options that need a description use `--questions-file`:
  ```json
  {"kind":{"type":"choice","instructions":"Which failure?","criteria":{"auth":"credentials or permissions","flake":"intermittent","code":"build logic"}}}
  ```
- Use it for triage, classification, pre-ranking and `p > 0.9` regression assertions. It returns no reasons; ask `freellm ask` or the main model for the why.

