# 04 - How the Agent Thinks

## The execution loop

For each task, the system does this:

1. capture visible page state
2. ask the model for the next realistic user action
3. execute the action with guarded locators
4. log what happened
5. repeat until the task ends or the step limit is hit

## Why the planner and evaluator are separate

If one model both acts and judges, it will flatter itself and invent success.
That is weak design.

This project separates:
- **planner**: chooses the next action
- **evaluator**: reviews the evidence afterward

## What the planner sees

The planner gets:
- page title and URL
- visible body text excerpt
- visible interactive elements
- headings
- modal hints
- previous action history

## What the planner does not get

It does not get:
- hidden DOM content
- fake claims that something succeeded

## Why this matters

You wanted a system that behaves like a regular user.
Regular users do not inspect invisible elements or parse the entire DOM perfectly.
