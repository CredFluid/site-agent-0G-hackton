# 05 - Extending Personas and Tasks

## Create a new task file

Add a new JSON file in `src/tasks/`.

Example skeleton:

```json
{
  "persona": {
    "name": "support-seeking customer",
    "intent": "Find help fast and judge whether support is trustworthy.",
    "constraints": [
      "Use only visible page information",
      "Behave like a frustrated customer",
      "Do not use hidden DOM details"
    ]
  },
  "tasks": [
    {
      "name": "Find support",
      "goal": "Locate help or contact options quickly",
      "success_condition": "Support page or support channel is clearly reachable",
      "failure_signals": [
        "no contact path",
        "help is buried",
        "support labels are unclear"
      ]
    }
  ]
}
```

## Good task design

A good task is:
- concrete
- time-bounded
- observable
- easy to judge from evidence

## Bad task design

Trash tasks look like this:
- “Explore the site”
- “See if it is good”
- “Understand everything”

Those are vague, hard to score, and guaranteed to produce mush.
