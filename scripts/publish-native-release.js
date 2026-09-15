#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { downloadBinaries } = require('./download-binaries');
const metadata = require('../package.json');
const root = path.resolve(__dirname, '..');
const repository = 'summersmile1984/react-native-matrix-sdk';
async function main() {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const evidence = JSON.parse(
    fs.readFileSync(path.join(root, 'native-release-provenance.json'))
  );
  const archive = path.join(root, 'binaries.tar.gz');
  const digest = createHash('sha256')
    .update(fs.readFileSync(archive))
    .digest('hex');
  if (
    evidence.sourceCommit !== sourceCommit ||
    evidence.version !== metadata.version ||
    evidence.archiveSha256 !== digest
  ) {
    throw new Error(
      'Native release provenance does not match current source and archive'
    );
  }
  if (
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
  ) {
    throw new Error('Cannot publish uncommitted SDK source');
  }
  // Never reuse an inherited tag or replace an existing release.
  const existingTag = execFileSync(
    'git',
    [
      'ls-remote',
      `https://github.com/${repository}.git`,
      `refs/tags/${metadata.version}`,
    ],
    { encoding: 'utf8' }
  ).trim();
  if (existingTag)
    throw new Error('Release tag already exists; use a new package version');
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'matrix-native-publish-')
  );
  try {
    const notes = path.join(temporary, 'notes.md');
    fs.writeFileSync(
      notes,
      `Native libraries for ${metadata.name}@${metadata.version}.\n\nSDK source: ${sourceCommit}\nRust source: ${metadata.nativeRelease.rustRevision}\nSHA-256: ${digest}\n\nAndroid arm64-v8a/armeabi-v7a and iOS device/simulator XCFramework.\n`
    );
    execFileSync(
      'gh',
      [
        'release',
        'create',
        metadata.version,
        '--repo',
        repository,
        '--target',
        sourceCommit,
        '--title',
        `TurningFlow native SDK ${metadata.version}`,
        '--notes-file',
        notes,
        archive,
        path.join(root, 'binaries.tar.gz.sha256'),
        path.join(root, 'native-release-provenance.json'),
      ],
      { stdio: 'inherit' }
    );
    const consumer = path.join(temporary, 'consumer');
    fs.mkdirSync(consumer);
    await downloadBinaries({ projectDir: consumer, packageMetadata: metadata });
    console.log(
      'Published release verified through a clean consumer download.'
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
