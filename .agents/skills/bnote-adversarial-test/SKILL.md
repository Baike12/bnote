---
name: bnote-adversarial-test
description: Institutionalized adversarial testing — dispatch 2–4 independent role-persona agents (domain user, quant/engineer, QA) to operate the real app UI-only and try to break it. Use when the user asks to 验收 / 盲测 / 对抗性测试 / 找茬 a feature, before calling a large change done, or periodically for a domain that has never had a round. This is the AI-driven testing form with the highest yield in this repo: two rounds produced 30 findings (18 fixed, 3 tool artifacts, 9 by-design) that none of the 3,300 automated tests could reach.
---

# Adversarial testing with role-persona agents

## Why

Humans and single-persona reviewers probe their own assumptions. Independent
agents with different roles and a mandate to break the build find cross-cutting
breakage the author cannot see — and every finding is triaged into the
defect-class registry (docs/TESTING.md), so each round also grows the test
system. Grounding: LLM-generated artifacts fail mostly on oracle correctness;
here the *humans interacting with the app* are the oracle, and the agents are
the input generators.

## Protocol

1. **Freeze the surface.** Agents share one running app (`pnpm tauri dev` in
   browser mode, `localhost:1430` + devbridge `1439`) and one browser tab
   group. While any agent is testing, **change no code**: a Rust edit triggers
   a dev rebuild, a front-end edit triggers HMR — both kill the agent's
   session and pollute findings.
2. **Cast 2–4 roles** with disjoint mandates, e.g.:
   - a domain user who knows the subject (invest mode: a HK investor, a US
     quant) but not the app;
   - a picky engineer who audits numbers, units, and consistency across
     screens;
   - a QA analyst who attacks flows: empty states, double-clicks, keyboard
     paths, cross-market mixing.
   Each gets: UI-only (no source reading), a P0/P1/P2 rubric, a requirement to
   reproduce every finding, and a time budget.
3. **Collect and triage.** Every finding lands in one of exactly three buckets:
   - *fixed* — real defect, fixed in the same change cycle;
   - *tool artifact* — re-measured with real gestures/CDP evidence and
     dismissed with the measurement recorded (e.g. CDP `press()` double-firing
     chars, canvas pixel-scan miscounts);
   - *by-design* — recorded with the rationale in the round's report.
4. **Feed the registry.** For every *fixed* finding, answer "why did no
   existing layer alarm?" and land the lock (docs/TESTING.md first principle):
   a seam function, a fixture, an E2E spec, or a registry row.
5. **Report.** One table per round: finding, source role, bucket, lock landed.

## Findings hygiene

- Re-verify every P0 yourself in the browser before fixing; agents misread
  rendering as broken (the equity-curve "invisible" report was a healthy SVG).
- Synthetic input artifacts are the top false-positive source: CDP `press()`
  fires keydown+char independently (real keyboards do not), pixel scans
  miscount overlapped bars. Prefer `Input.dispatchMouseEvent` sequences and
  DOM geometry (`getBoundingClientRect`, `getBBox`) over screenshots.
- Never let an agent edit code, even "trivially" — their edits bypass review
  and their sessions share the app state.

## Commands

```bash
pnpm tauri dev          # the shared surface (browser mode: localhost:1430)
pnpm gate               # after fixes land
```
