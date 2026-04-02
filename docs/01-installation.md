# 01 - Installation

## 1. Prerequisites

Install these first:
- Node.js 20.10 or newer
- npm 10 or newer
- Git

Check your versions:

```bash
node -v
npm -v
```

## 2. Unzip the project

```bash
unzip site-agent-prod.zip
cd site-agent-prod
```

## 3. Install dependencies

```bash
npm install
```

## 4. Install the Playwright browser

```bash
npx playwright install chromium
```

## 5. Create your environment file

```bash
cp .env.example .env
```

## 6. Add your OpenAI API key

Open `.env` and set:

```bash
OPENAI_API_KEY=your_real_key_here
```

## 7. Confirm TypeScript builds cleanly

```bash
npm run check
```

If this fails, do not keep going and pretend everything is fine. Fix the error first.
