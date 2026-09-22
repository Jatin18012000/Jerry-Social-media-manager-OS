/**
 * Removes demo and test data from a development database.
 *
 * Run with: npm run db:clean        (keeps the brand configuration)
 *           npm run db:clean -- --brand   (also removes it)
 *
 * Keeps the §10 pillars and the §14 source list. See src/db/clean.ts for why
 * each thing is kept or dropped.
 */

import { clean } from '@/db/clean';

const brand = process.argv.includes('--brand');
const url = process.env['DATABASE_URL'] ?? './data/os.db';

const report = clean(url, { brand });

console.log(`Cleaning ${url}\n`);

if (report.total === 0) {
  console.log('Nothing to remove — no demo data found.');
} else {
  for (const [table, count] of Object.entries(report.deleted).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${String(count).padStart(5)}  ${table}`);
  }
  console.log(`\n  ${report.total} row(s) removed.`);
}

console.log(
  `\nKept ${report.pillarsKept} content pillar(s) and ${report.sourcesKept} ` +
    `source(s) — §10 and §14 configuration, not demo data.`,
);

if (report.brandConfigDeleted) {
  console.log(
    '\nRemoved the brand configuration. Briefs will carry the "brand voice ' +
      'not yet defined" warning again until one is written at ' +
      '/settings/brand (§4).',
  );
} else if (report.brandConfigKept) {
  // Loud, because a brand voice nobody wrote is worse than none: it silently
  // suppresses the warning that says output is generic (§57 Risk 1), and §4
  // puts this deliverable with Jatin and ChatGPT, not with engineering.
  console.log(
    `\n!! A brand configuration is set and was KEPT: "${report.brandConfigKept}"` +
      `\n   It is not the placeholder, so something saved it deliberately.` +
      `\n   If you did not write it, it is test data claiming to be your` +
      `\n   brand voice — every brief is using it and none of them are` +
      `\n   warning you. Remove it with:  npm run db:clean -- --brand`,
  );
}
