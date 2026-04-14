# 05 - Extending Accepted Tasks

## Define tasks from explicit input

There are no built-in personas or default task files anymore.
Each run is driven by accepted tasks submitted from the dashboard or passed to the CLI with repeated `--task` flags.

Example CLI input:

```bash
npm run dev -- --url https://example.com \
  --task "Find the pricing page and compare the visible plans" \
  --task "Open the contact path and confirm whether support is easy to reach"
```

For game-oriented runs, write the requested behavior directly into the accepted tasks. Example: read the visible how-to-play section, reach a playable state, and play five rounds while recording wins and losses.

## Good task design

A good task is:
- concrete
- time-bounded
- observable
- easy to judge from evidence
- complementary with the other tasks in the suite

Good task sets usually split coverage into a few lanes such as:
- main journey and orientation
- discovery and information architecture
- conversion and trust
- suspicious interactions and recovery states

That gives the runner broader coverage without asking one task to explain the whole site alone.

## Bad task design

Trash tasks look like this:
- “Explore the site”
- “See if it is good”
- “Understand everything”

Those are vague, hard to score, and guaranteed to produce mush.
