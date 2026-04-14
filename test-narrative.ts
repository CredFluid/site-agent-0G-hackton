import fs from 'fs';
import { renderMarkdownReport } from './dist/reporting/markdown.js';

const report = JSON.parse(fs.readFileSync('/Users/Noah/Downloads/site-agent-prod/runs/2026-04-02T13-12-51-964Z-ramphub-io/report.json', 'utf-8'));

const markdown = renderMarkdownReport({
  website: 'https://ramphub.io/',
  persona: 'first-time visitor',
  report
});

console.log(markdown);
