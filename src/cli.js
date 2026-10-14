'use strict';

// Researcher commands. Each takes config files or folders of them (default: STUDY_CONFIG or ./study.yaml).
//   npm run validate [config ...]                 check configs, list every problem
//   npm run explain  [config ...]                 print the matching logic in plain English
//   npm run simulate [config] [people.csv]        run the matcher over fake arrivals
//   npm run qualtrics [config] -- --url URL [--out DIR]   write paste-ready Qualtrics files

const fs = require('fs');
const path = require('path');
const { loadConfig, ConfigError } = require('./config');
const { explainConfig } = require('./explain');
const { simulate, formatSimulation, parseCsv } = require('./simulate');
const { generateQualtrics } = require('./qualtrics');

const root = path.join(__dirname, '..');
const shown = (f) => (path.relative(process.cwd(), f).startsWith('..') ? f : path.relative(process.cwd(), f));

function parseArgs(argv) {
  const opts = { files: [], csv: null, url: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.split(/=(.*)/s);
    if (flag === '--url' || flag === '--out') opts[flag.slice(2)] = inline ?? argv[++i];
    else if (/\.csv$/i.test(a)) opts.csv = a;
    else opts.files.push(a);
  }
  // `npm run qualtrics --url X` (without `--`) hands the flag to npm, which exposes it as npm_config_url.
  opts.url = opts.url || process.env.npm_config_url || null;
  if (!opts.files.length) opts.files.push(process.env.STUDY_DIR || process.env.STUDY_CONFIG || path.join(root, 'study.yaml'));
  // A folder stands for every .yaml file in it.
  opts.files = opts.files.flatMap((f) => (fs.existsSync(f) && fs.statSync(f).isDirectory()
    ? fs.readdirSync(f).filter((n) => /\.ya?ml$/i.test(n)).sort().map((n) => path.join(f, n))
    : [f]));
  return opts;
}

const commands = {
  validate({ files }) {
    for (const f of files) {
      loadConfig(f);
      console.log(`OK  ${f}`);
    }
  },
  explain({ files }) {
    console.log(files.map((f) => `# ${f}\n${explainConfig(loadConfig(f))}`).join('\n\n'));
  },
  simulate({ files, csv }) {
    const config = loadConfig(files[0]);
    const csvFile = csv || path.join(root, 'examples', 'people.csv');
    const rows = parseCsv(fs.readFileSync(csvFile, 'utf8'));
    console.log(`Simulating ${files[0]} with ${csvFile} (${rows.length} rows, simulated time)\n`);
    console.log(formatSimulation(simulate(config, rows)));
  },
  qualtrics({ files, url, out }) {
    if (!url) throw new Error('needs your app URL: npm run qualtrics -- --url https://your-app.onrender.com');
    const config = loadConfig(files[0]);
    const outDir = out || path.join(root, 'qualtrics', 'generated');
    const written = generateQualtrics(config, { url, outDir });
    console.log(`Wrote Qualtrics files for study "${config.study.id}":`);
    for (const f of written) console.log(`  ${shown(f)}`);
    console.log(`Next: follow ${shown(path.join(outDir, 'CHECKLIST.md'))}`);
  },
};

function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (!commands[name]) {
    console.error(`usage: node src/cli.js <${Object.keys(commands).join('|')}> [config.yaml ...] [people.csv] [--url URL] [--out DIR]`);
    process.exit(2);
  }
  try {
    commands[name](parseArgs(rest));
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : `error: ${e.message}`);
    process.exit(1);
  }
}

main();
