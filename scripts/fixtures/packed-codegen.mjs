import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { generateModuleCode } from '@enbox/module-codegen';
import { RecordValidationError } from '@enbox/api';

const coreDefinition = {
  module    : 'https://example.com/packed-codegen/core',
  published : true,
  types     : {
    notebook : { dataFormats: ['text/plain'] },
    note     : { dataFormats: ['text/plain'] },
    member   : { dataFormats: ['text/plain'] },
  },
  structure: { notebook: { note: {}, member: { $role: true } } },
};
const commentsDefinition = {
  module    : 'https://example.com/packed-codegen/comments',
  published : true,
  uses      : { core: coreDefinition.module },
  types     : {
    comment: {
      schema             : 'https://example.com/packed-codegen/schemas/comment',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
  },
  structure: {
    note: {
      $ref    : 'core:notebook/note',
      comment : { $actions: [{ role: 'core:notebook/member', can: ['create', 'read'] }] },
    },
  },
};
const dependencies = {
  core: { definition: coreDefinition, importPath: './core.generated.js', exportName: 'CoreModule' },
};

async function generateAndTypecheck() {
  await mkdir('schemas');
  await Promise.all([
    writeFile('core.json', JSON.stringify(coreDefinition)),
    writeFile('comments.json', JSON.stringify(commentsDefinition)),
    writeFile('dependencies.json', JSON.stringify(dependencies)),
    writeFile('schemas/comment.json', JSON.stringify({
      $id                  : commentsDefinition.types.comment.schema,
      type                 : 'object',
      properties           : { text: { type: 'string', minLength: 1 } },
      required             : ['text'],
      additionalProperties : false,
    })),
    writeFile('tsconfig.json', JSON.stringify({
      compilerOptions: {
        target                       : 'ES2022',
        module                       : 'NodeNext',
        moduleResolution             : 'NodeNext',
        lib                          : ['DOM', 'ES2022'],
        types                        : ['node'],
        strict                       : true,
        exactOptionalPropertyTypes   : true,
        skipLibCheck                 : false,
        esModuleInterop              : true,
        outDir                       : 'compiled',
      },
      include: ['*.generated.ts', 'packed-codegen-types.ts'],
    })),
  ]);

  const executable = join(process.cwd(), 'node_modules/.bin/module-codegen');
  for (const [name, definition, output, extra] of [
    ['Core', 'core.json', 'core.generated.ts', []],
    ['Comments', 'comments.json', 'comments.generated.ts', ['--dependencies', 'dependencies.json']],
  ]) {
    const args = ['--definition', definition, '--schemas', 'schemas', '--name', name, '--output', output, ...extra];
    execFileSync(executable, ['generate', ...args], { stdio: 'inherit' });
    execFileSync(executable, ['check', ...args], { stdio: 'inherit' });
  }

  // The published programmatic API must produce the same artifact as the installed CLI.
  const generated = await generateModuleCode(commentsDefinition, {
    schemasDir: join(process.cwd(), 'schemas'), moduleName: 'Comments', dependencies,
  });
  assert.equal(await readFile('comments.generated.ts', 'utf8'), generated.code);
  execFileSync('node', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
}

async function verifyGeneratedModules() {
  const { CoreModule } = await import('./compiled/core.generated.js');
  const { CommentsModule } = await import('./compiled/comments.generated.js');
  assert.equal(CommentsModule.dependencies.core, CoreModule);
  assert.deepEqual(Object.keys(CommentsModule.codecs), ['comment']);
  assert.equal(CommentsModule.definition.$keyAgreement, undefined);

  const attachment = CommentsModule.resolvedGraph.nodesByDeclaredPath.get('note');
  assert.equal(attachment.kind, 'ref');
  assert.equal(attachment.owningModuleUri, CoreModule.definition.module);
  assert.equal(attachment.owningModulePath, 'notebook/note');
  const comment = CommentsModule.resolvedGraph.nodesByDeclaredPath.get('note/comment');
  assert.equal(comment.kind, 'record');
  assert.equal(comment.owningModuleUri, commentsDefinition.module);
  assert.equal(comment.owningModulePath, 'note/comment');
  assert.equal(comment.physicalDepth, 3);
  assert.equal(comment.parentPhysicalDepth, 2);
  assert.equal(comment.actions[0].resolvedRole.owningModuleUri, CoreModule.definition.module);
  assert.equal(comment.actions[0].resolvedRole.owningModulePath, 'notebook/member');

  const value = { text: 'A comment from installed packages.' };
  const encoded = await CommentsModule.codecs.comment.encode(value);
  assert.equal(encoded.dataFormat, 'application/json');
  assert.deepEqual(JSON.parse(await encoded.data.text()), value);
  await assert.rejects(async () => CommentsModule.codecs.comment.encode({ text: 123 }), RecordValidationError);
  await assert.rejects(async () => CommentsModule.codecs.comment.encode({ text: '' }), RecordValidationError);
}

if (process.argv[2] !== 'verify') {
  await generateAndTypecheck();
}
await verifyGeneratedModules();
console.log('Packed codegen composition, strict types, and runtime schema validation passed.');
