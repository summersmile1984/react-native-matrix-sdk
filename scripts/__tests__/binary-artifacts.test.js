const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const test = require('node:test');
const tar = require('tar');

const {
  MANIFEST_FILENAME,
  extractAndValidateBinaryArchive,
  installBinaryArtifacts,
  validateBinaryArtifacts,
  writeBinaryManifest,
} = require('../binary-artifacts');
const {
  downloadBinaries,
  downloadFile,
  main,
} = require('../download-binaries');
const { packageBinaries } = require('../package-binaries');

const PACKAGE = {
  name: '@unomed/react-native-matrix-sdk',
  version: '9.8.7-test',
};

test('native source pins must match, even when the package version matches', async () => {
  await withTemporaryDirectory(async (rootDir) => {
    const projectDir = await createFixtureProject(rootDir);
    const expected = {
      ...PACKAGE,
      nativeRelease: { rustRevision: 'a'.repeat(40), rustVersion: '1.93.0' },
    };
    await writeBinaryManifest(projectDir, expected);
    await validateBinaryArtifacts(projectDir, expected);
    await assert.rejects(
      validateBinaryArtifacts(projectDir, {
        ...expected,
        nativeRelease: {
          ...expected.nativeRelease,
          rustRevision: 'b'.repeat(40),
        },
      }),
      /native source\/toolchain mismatch/
    );
    await writeBinaryManifest(projectDir, PACKAGE);
    await assert.rejects(
      validateBinaryArtifacts(projectDir, expected),
      /native source\/toolchain mismatch/
    );
  });
});

async function createFixtureProject(rootDir) {
  const projectDir = path.join(rootDir, 'project');
  const files = new Map([
    [
      'build/RnMatrixRustSdk.xcframework/Info.plist',
      '<plist><key>AvailableLibraries</key></plist>',
    ],
    [
      'build/RnMatrixRustSdk.xcframework/ios-arm64/libmatrix_sdk_ffi.a',
      'ios-arm64-binary',
    ],
    [
      'android/src/main/jniLibs/arm64-v8a/libmatrix_sdk_ffi.so',
      'android-arm64-binary',
    ],
    [
      'android/src/main/jniLibs/armeabi-v7a/libmatrix_sdk_ffi.so',
      'android-armv7-binary',
    ],
    ['android/src/main/jniLibs/x86/libmatrix_sdk_ffi.so', 'android-x86-binary'],
    [
      'android/src/main/jniLibs/x86_64/libmatrix_sdk_ffi.so',
      'android-x86_64-binary',
    ],
  ]);

  for (const [relativePath, contents] of files) {
    const absolutePath = path.join(projectDir, relativePath);
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, contents);
  }
  return projectDir;
}

async function createPackagedFixture(rootDir) {
  const sourceDir = await createFixtureProject(rootDir);
  const archivePath = path.join(rootDir, 'binaries.tar.gz');
  await packageBinaries({
    projectDir: sourceDir,
    packageMetadata: PACKAGE,
    outputFile: archivePath,
    temporaryParent: rootDir,
    logger: { log() {} },
  });
  return { archivePath, sourceDir };
}

async function withTemporaryDirectory(callback) {
  const rootDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'binary-artifacts-test-')
  );
  try {
    return await callback(rootDir);
  } finally {
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  }
}

test('packages and validates a complete version-bound binary archive', async () => {
  await withTemporaryDirectory(async (rootDir) => {
    const { archivePath } = await createPackagedFixture(rootDir);
    const extractedDir = path.join(rootDir, 'extracted');

    await extractAndValidateBinaryArchive(archivePath, extractedDir, PACKAGE);
    const manifest = await validateBinaryArtifacts(extractedDir, PACKAGE);

    assert.equal(manifest.package.name, PACKAGE.name);
    assert.equal(manifest.package.version, PACKAGE.version);
    assert.equal(manifest.files.length, 6);
  });
});

test('rejects an archive created for a different package version', async () => {
  await withTemporaryDirectory(async (rootDir) => {
    const { archivePath } = await createPackagedFixture(rootDir);

    await assert.rejects(
      extractAndValidateBinaryArchive(
        archivePath,
        path.join(rootDir, 'extracted'),
        { ...PACKAGE, version: '9.8.8-test' }
      ),
      /version mismatch/
    );
  });
});

test('rejects a binary whose contents do not match its manifest', async () => {
  await withTemporaryDirectory(async (rootDir) => {
    const { archivePath } = await createPackagedFixture(rootDir);
    const repackDir = path.join(rootDir, 'repack');
    await fs.promises.mkdir(repackDir);
    await tar.x({ file: archivePath, cwd: repackDir });
    await fs.promises.appendFile(
      path.join(
        repackDir,
        'android/src/main/jniLibs/arm64-v8a/libmatrix_sdk_ffi.so'
      ),
      'tampered'
    );
    const tamperedArchive = path.join(rootDir, 'tampered.tar.gz');
    await tar.c({ gzip: true, file: tamperedArchive, cwd: repackDir }, [
      MANIFEST_FILENAME,
      'build',
      'android/src/main/jniLibs',
    ]);

    await assert.rejects(
      extractAndValidateBinaryArchive(
        tamperedArchive,
        path.join(rootDir, 'tampered-output'),
        PACKAGE
      ),
      /size mismatch|checksum mismatch/
    );
  });
});

test('rejects unexpected archive entries before installation', async () => {
  await withTemporaryDirectory(async (rootDir) => {
    const { archivePath } = await createPackagedFixture(rootDir);
    const repackDir = path.join(rootDir, 'repack');
    await fs.promises.mkdir(repackDir);
    await tar.x({ file: archivePath, cwd: repackDir });
    await fs.promises.writeFile(
      path.join(repackDir, 'unexpected.txt'),
      'not a native artifact'
    );
    const unexpectedArchive = path.join(rootDir, 'unexpected.tar.gz');
    await tar.c({ gzip: true, file: unexpectedArchive, cwd: repackDir }, [
      MANIFEST_FILENAME,
      'build',
      'android/src/main/jniLibs',
      'unexpected.txt',
    ]);

    await assert.rejects(
      extractAndValidateBinaryArchive(
        unexpectedArchive,
        path.join(rootDir, 'unexpected-output'),
        PACKAGE
      ),
      /Unexpected file in binary archive/
    );
  });
});

test('stream failure removes both partial and final download files', async () => {
  await withTemporaryDirectory(async (rootDir) => {
    const destination = path.join(rootDir, 'binaries.tar.gz');
    const get = (_url, callback) => {
      const request = new EventEmitter();
      const response = new Readable({
        read() {
          this.push('partial archive');
          this.destroy(new Error('simulated truncated response'));
        },
      });
      response.statusCode = 200;
      response.headers = {};
      callback(response);
      return request;
    };

    await assert.rejects(
      downloadFile('https://offline.test/binaries.tar.gz', destination, {
        get,
      }),
      /simulated truncated response/
    );
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(`${destination}.part`), false);
  });
});

test('installs only after the entire downloaded archive is verified', async () => {
  await withTemporaryDirectory(async (rootDir) => {
    const { archivePath } = await createPackagedFixture(rootDir);
    const installDir = path.join(rootDir, 'installed');
    const temporaryParent = path.join(rootDir, 'downloads');
    await fs.promises.mkdir(temporaryParent);

    const result = await downloadBinaries({
      projectDir: installDir,
      packageMetadata: PACKAGE,
      temporaryParent,
      releaseUrl: 'https://offline.test/binaries.tar.gz',
      downloadFile: async (_url, destination) => {
        await fs.promises.copyFile(archivePath, destination);
      },
      logger: { log() {} },
    });

    assert.equal(result.status, 'installed');
    await validateBinaryArtifacts(installDir, PACKAGE);
    assert.deepEqual(await fs.promises.readdir(temporaryParent), []);
  });
});

test('backup cleanup failure does not roll back a verified installation', async () => {
  await withTemporaryDirectory(async (rootDir) => {
    const installedDir = await createFixtureProject(
      path.join(rootDir, 'installed-fixture')
    );
    await writeBinaryManifest(installedDir, PACKAGE);

    const stagedDir = await createFixtureProject(
      path.join(rootDir, 'staged-fixture')
    );
    const stagedArm64 = path.join(
      stagedDir,
      'android/src/main/jniLibs/arm64-v8a/libmatrix_sdk_ffi.so'
    );
    await fs.promises.appendFile(stagedArm64, '-new-release');
    await writeBinaryManifest(stagedDir, PACKAGE);

    const cleanupFailures = [];
    const result = await installBinaryArtifacts(
      stagedDir,
      installedDir,
      PACKAGE,
      {
        cleanupBackup: async () => {
          throw new Error('simulated backup cleanup failure');
        },
        onCleanupError: (error, backupPath) => {
          cleanupFailures.push({ error, backupPath });
        },
      }
    );

    assert.equal(result.cleanupErrors.length, 3);
    assert.equal(cleanupFailures.length, 3);
    assert.match(
      await fs.promises.readFile(stagedArm64, 'utf8'),
      /new-release/
    );
    assert.match(
      await fs.promises.readFile(
        path.join(
          installedDir,
          'android/src/main/jniLibs/arm64-v8a/libmatrix_sdk_ffi.so'
        ),
        'utf8'
      ),
      /new-release/
    );
    await validateBinaryArtifacts(installedDir, PACKAGE);
    for (const failure of cleanupFailures) {
      assert.equal(fs.existsSync(failure.backupPath), true);
    }
  });
});

test('download failure is non-zero and leaves no partial installation', async () => {
  await withTemporaryDirectory(async (rootDir) => {
    const installDir = path.join(rootDir, 'installed');
    const staleFile = path.join(
      installDir,
      'android/src/main/jniLibs/arm64-v8a/stale.so'
    );
    await fs.promises.mkdir(path.dirname(staleFile), { recursive: true });
    await fs.promises.writeFile(staleFile, 'keep-existing-files');
    const temporaryParent = path.join(rootDir, 'downloads');
    await fs.promises.mkdir(temporaryParent);

    await assert.rejects(
      downloadBinaries({
        projectDir: installDir,
        packageMetadata: PACKAGE,
        temporaryParent,
        releaseUrl: 'https://offline.test/binaries.tar.gz',
        downloadFile: async (_url, destination) => {
          await fs.promises.writeFile(destination, 'partial-download');
          throw new Error('simulated network failure');
        },
        logger: { log() {} },
      }),
      /simulated network failure/
    );

    assert.equal(
      await fs.promises.readFile(staleFile, 'utf8'),
      'keep-existing-files'
    );
    assert.equal(
      fs.existsSync(path.join(installDir, 'build/RnMatrixRustSdk.xcframework')),
      false
    );
    assert.deepEqual(await fs.promises.readdir(temporaryParent), []);

    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    await main(
      async () => {
        throw new Error('simulated CLI failure');
      },
      { error() {} }
    );
    assert.equal(process.exitCode, 1);
    process.exitCode = previousExitCode;
  });
});
