#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');
const {
  ANDROID_ARTIFACT,
  IOS_ARTIFACT,
  MANIFEST_FILENAME,
  extractAndValidateBinaryArchive,
  validateBinaryArtifacts,
  writeBinaryManifest,
} = require('./binary-artifacts');

const PACKAGE_JSON = require('../package.json');

async function packageBinaries(options = {}) {
  const projectDir = options.projectDir || path.join(__dirname, '..');
  const packageMetadata = options.packageMetadata || PACKAGE_JSON;
  const outputFile =
    options.outputFile || path.join(projectDir, 'binaries.tar.gz');
  const logger = options.logger || console;
  const temporaryDir = await fs.promises.mkdtemp(
    path.join(options.temporaryParent || os.tmpdir(), 'rn-matrix-sdk-package-')
  );
  const stagedProjectDir = path.join(temporaryDir, 'staged');
  const validationDir = path.join(temporaryDir, 'validation');
  const temporaryOutput = path.join(
    path.dirname(outputFile),
    `.${path.basename(outputFile)}.${process.pid}.tmp`
  );

  try {
    await fs.promises.mkdir(stagedProjectDir, { recursive: true });
    for (const artifactPath of [IOS_ARTIFACT, ANDROID_ARTIFACT]) {
      await fs.promises.mkdir(
        path.dirname(path.join(stagedProjectDir, artifactPath)),
        { recursive: true }
      );
      await fs.promises.cp(
        path.join(projectDir, artifactPath),
        path.join(stagedProjectDir, artifactPath),
        {
          recursive: true,
          errorOnExist: true,
          force: false,
        }
      );
    }

    await writeBinaryManifest(stagedProjectDir, packageMetadata);
    await validateBinaryArtifacts(stagedProjectDir, packageMetadata);

    logger.log(
      `Packaging verified binaries for ${packageMetadata.name}@${packageMetadata.version}...`
    );
    await fs.promises.rm(temporaryOutput, { force: true });
    await tar.c(
      {
        gzip: true,
        file: temporaryOutput,
        cwd: stagedProjectDir,
        portable: true,
        noMtime: true,
      },
      [MANIFEST_FILENAME, 'build', ANDROID_ARTIFACT]
    );
    await extractAndValidateBinaryArchive(
      temporaryOutput,
      validationDir,
      packageMetadata
    );

    await fs.promises.rename(temporaryOutput, outputFile);
    const stats = await fs.promises.stat(outputFile);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    logger.log(`Binaries packaged successfully: ${outputFile} (${sizeMB} MB)`);
    return outputFile;
  } finally {
    await fs.promises.rm(temporaryOutput, { force: true });
    await fs.promises.rm(temporaryDir, { recursive: true, force: true });
  }
}

async function main() {
  try {
    await packageBinaries();
  } catch (error) {
    console.error(`Failed to package native binaries: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, packageBinaries };
