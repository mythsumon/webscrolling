#!/usr/bin/env node
/**
 * CLI:
 *   node src/cli.js --url https://example.com --labels "Hotel Name,Phone Number,Gallery Images"
 *   node src/cli.js --url https://example.com --labels-file labels.txt --csv --out result.csv
 */

import { writeFile, readFile } from 'node:fs/promises';
import { scrape, DEFAULT_OPTIONS } from './core/pipeline.js';
import { toJson, toCsv } from './output/exporters.js';

const USAGE = `
Label-driven web scraper

Usage:
  node src/cli.js --url <url> --labels "Label A,Label B" [options]

Required:
  --url <url>                 Page to extract from
  --labels <a,b,c>            Comma-separated labels
  --labels-file <path>        ...or one label per line from a file

Options:
  --mode <auto|list|single>   What is on the page (default ${DEFAULT_OPTIONS.mode}):
                                list   = a directory / results page -> one record per item
                                single = one subject -> one record for the page
                                auto   = detect, falling back to single
  --max-records <n>           Cap on records in list mode (default ${DEFAULT_OPTIONS.maxRecords})

 Getting ALL the data off a paginated list:
  --pagination                Follow "next page" links (${DEFAULT_OPTIONS.maxPaginationPages} extra pages)
  --all-pages                 Follow pagination until it runs out (bounded by --max-records)
  --max-pagination-pages <n>  Extra list pages to walk, or "all"
  --scroll-all                Infinite scroll: scroll a rendered page until it
                              stops growing, clicking "load more" as it appears
  --max-load-more <n>         Cap on "load more" clicks (default ${DEFAULT_OPTIONS.maxLoadMoreClicks})
  --scroll-budget <ms>        Time budget for scrolling one page (default ${DEFAULT_OPTIONS.scrollBudgetMs})
  --out <path>                Write output to a file instead of stdout
  --csv                       CSV output (default: JSON)
  --data-only                 JSON with just { url, status, data, missing_fields }
  --max-pages <n>             Page budget, including the first page (default ${DEFAULT_OPTIONS.maxPages})
  --no-follow                 Do not follow internal links
  --pagination                Allow following one or two "next page" links for list fields
  --render <auto|always|never> Browser rendering policy (default ${DEFAULT_OPTIONS.render})
  --load-more                 Click bounded "load more" buttons while rendering
  --llm                       Enable the Claude fallback for unresolved labels
  --llm-model <id>            Model for the fallback (default claude-opus-5)
  --min-confidence <0..1>     Confidence floor below which a field is null (default ${DEFAULT_OPTIONS.minConfidence})
  --delay <ms>                Minimum delay between requests to one host (default ${DEFAULT_OPTIONS.minDelayMs})
  --timeout <ms>              Per-request timeout (default ${DEFAULT_OPTIONS.requestTimeoutMs})
  --ignore-robots             Do NOT consult robots.txt (you accept responsibility for this)
  --verbose                   Progress logging on stderr
  -h, --help                  This message

Exit codes: 0 = all labels found, 2 = partial, 1 = error.
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--') && !arg.startsWith('-')) {
      args._.push(arg);
      continue;
    }
    const key = arg.replace(/^--?/, '');
    const next = argv[i + 1];
    const takesValue = [
      'url', 'labels', 'labels-file', 'out', 'max-pages', 'render', 'llm-model',
      'min-confidence', 'delay', 'timeout', 'mode', 'max-records',
      'max-pagination-pages', 'max-load-more', 'scroll-budget',
    ].includes(key);
    if (takesValue) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h || (!args.url && !args._.length)) {
    process.stdout.write(USAGE);
    process.exit(args.help || args.h ? 0 : 1);
  }

  const url = args.url ?? args._[0];

  let labels = [];
  if (args['labels-file']) {
    const raw = await readFile(args['labels-file'], 'utf8');
    labels = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } else if (args.labels) {
    labels = String(args.labels).split(',').map((l) => l.trim()).filter(Boolean);
  }

  if (!labels.length) {
    process.stderr.write('Error: no labels given. Use --labels or --labels-file.\n');
    process.exit(1);
  }

  if (args.mode && !['auto', 'list', 'single'].includes(args.mode)) {
    process.stderr.write(`Error: --mode must be auto, list or single (got "${args.mode}").\n`);
    process.exit(1);
  }

  const options = {
    mode: args.mode ?? DEFAULT_OPTIONS.mode,
    maxRecords: args['max-records'] ? Number(args['max-records']) : DEFAULT_OPTIONS.maxRecords,
    maxPages: args['max-pages'] ? Number(args['max-pages']) : DEFAULT_OPTIONS.maxPages,
    followInternalLinks: !args['no-follow'],
    // --all-pages is the "just get everything" switch; the granular flags stay
    // available for when a budget matters.
    allowPagination: !!args.pagination || !!args['all-pages'],
    maxPaginationPages: args['max-pagination-pages']
      ? (args['max-pagination-pages'] === 'all' ? 'all' : Number(args['max-pagination-pages']))
      : args['all-pages'] ? 'all' : DEFAULT_OPTIONS.maxPaginationPages,
    exhaustScroll: !!args['scroll-all'],
    maxLoadMoreClicks: args['max-load-more'] ? Number(args['max-load-more']) : DEFAULT_OPTIONS.maxLoadMoreClicks,
    scrollBudgetMs: args['scroll-budget'] ? Number(args['scroll-budget']) : DEFAULT_OPTIONS.scrollBudgetMs,
    render: args.render ?? DEFAULT_OPTIONS.render,
    clickLoadMore: !!args['load-more'],
    useLlm: !!args.llm,
    llmModel: args['llm-model'],
    minConfidence: args['min-confidence'] ? Number(args['min-confidence']) : DEFAULT_OPTIONS.minConfidence,
    minDelayMs: args.delay ? Number(args.delay) : DEFAULT_OPTIONS.minDelayMs,
    requestTimeoutMs: args.timeout ? Number(args.timeout) : DEFAULT_OPTIONS.requestTimeoutMs,
    obeyRobots: !args['ignore-robots'],
    logLevel: args.verbose ? 'info' : 'silent',
  };

  const result = await scrape({ url, labels, options });

  const output = args.csv
    ? toCsv(result)
    : toJson(result, { includeProvenance: !args['data-only'] });

  if (args.out) {
    await writeFile(args.out, output, 'utf8');
    const found =
      result.mode === 'list'
        ? `${result.stats.records_found} record(s)`
        : `${result.stats.labels_found}/${result.stats.labels_requested} labels found`;
    process.stderr.write(`Wrote ${args.out} (status: ${result.status}, ${found})\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }

  process.exit(result.status === 'ok' ? 0 : result.status === 'partial' ? 2 : 1);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
