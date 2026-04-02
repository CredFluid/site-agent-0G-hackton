# 06 - Hardening for Production

## 1. Add retries carefully

Retrying every failed action blindly is lazy and dangerous.
Add retries only for:
- network hiccups
- delayed rendering
- slow client-side routing

## 2. Improve task completion checks

The current completion logic is conservative but still heuristic.
Production systems should add explicit validators per task.

Examples:
- pricing check should detect real price patterns
- contact check should verify actual support/contact details
- signup check should verify the next-step form is real and usable

## 3. Improve event-aware evaluation

Right now the evaluator relies on interaction logs, task outcomes, and accessibility findings.
If you want better judgment later, enrich the structured events instead of adding guesswork.

## 4. Add category-specific personas

Use different task sets for:
- SaaS marketing sites
- ecommerce stores
- docs portals
- recruiting pages
- local business websites

## 5. Add CI only after manual trust is earned

Do not turn this into a pipeline gate until you have manually reviewed enough runs to understand its failure modes.

## 6. Respect legal and ethical limits

Do not use this to bypass anti-bot controls, paywalls, or account security.
That is not clever. It is reckless.
