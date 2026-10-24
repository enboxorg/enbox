#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const [command, spec, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.PUBLISH_CALLS, [command, spec, ...args].join(' ') + '\n');
if (command === 'view') {
  const separator = spec.lastIndexOf('@');
  const name = spec.slice(0, separator);
  const version = spec.slice(separator + 1);
  const file = path.join(process.env.RELEASE_REGISTRY, encodeURIComponent(name) + '.json');
  const delayed = path.join(process.env.RELEASE_REGISTRY, 'metadata-delay-' + encodeURIComponent(name));
  if (args.includes('--json') && spec === process.env.METADATA_DELAY_PACKAGE && !fs.existsSync(delayed)) {
    fs.writeFileSync(delayed, 'observed');
    const code = process.env.METADATA_DELAY_CODE || 'E404';
    console.log(JSON.stringify({ error: { code } }));
    console.error('npm error ' + code);
    process.exit(1);
  }
  let metadata;
  if (fs.existsSync(file)) {
    metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else if (process.env.ALREADY_PUBLISHED === '1') {
    metadata = { name, version };
  } else {
    if (args.includes('--json')) {
      console.log(JSON.stringify({ error: { code: 'E404' } }));
    }
    console.error('npm error E404');
    process.exit(1);
  }
  console.log(args.includes('--json') ? JSON.stringify(metadata) : metadata.version);
} else if (command === 'publish') {
  const name = path.basename(path.dirname(spec));
  if (name === process.env.FAIL_PACKAGE) {
    process.exit(1);
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(process.env.RELEASE_MANIFESTS, name + '.json'), 'utf8'));
  fs.writeFileSync(path.join(process.env.RELEASE_REGISTRY, encodeURIComponent(metadata.name) + '.json'), JSON.stringify(metadata));
} else {
  throw new Error('unexpected npm command');
}
