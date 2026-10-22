#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const [command, endpoint, ...args] = process.argv.slice(2);
if (command !== 'api') {
  throw new Error('unexpected gh command');
}
const directory = process.env.RELEASE_GITHUB;
if (args.includes('POST')) {
  const body = JSON.parse(fs.readFileSync(0, 'utf8'));
  fs.appendFileSync(path.join(directory, 'posts'), body.tag_name + '\n');
  const failed = path.join(directory, 'failed-post');
  if (process.env.FAIL_RELEASE_ONCE === '1' && !fs.existsSync(failed)) {
    fs.writeFileSync(failed, 'failed');
    console.error('gh: server error (HTTP 500)');
    process.exit(1);
  }
  const file = path.join(directory, encodeURIComponent(body.tag_name) + '.json');
  if (fs.existsSync(file)) {
    console.error('gh: already exists (HTTP 422)');
    process.exit(1);
  }
  const release = { ...body, id: 1, draft: false };
  fs.writeFileSync(file, JSON.stringify(release));
  const lostResponse = path.join(directory, 'lost-response');
  if (process.env.FAIL_RELEASE_RESPONSE_ONCE === '1' && !fs.existsSync(lostResponse)) {
    fs.writeFileSync(lostResponse, 'failed');
    console.error('gh: connection lost after creating release');
    process.exit(1);
  }
  console.log(JSON.stringify(release));
} else {
  const tag = decodeURIComponent(endpoint.split('/tags/')[1]);
  const file = path.join(directory, encodeURIComponent(tag) + '.json');
  if (!fs.existsSync(file)) {
    console.error('gh: Not Found (HTTP 404)');
    process.exit(1);
  }
  console.log(fs.readFileSync(file, 'utf8'));
}
