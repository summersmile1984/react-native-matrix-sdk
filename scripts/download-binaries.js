#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { pipeline } = require('stream/promises');

const PACKAGE_JSON = require('../package.json');
const REPO = 'summersmile1984/react-native-matrix-sdk';
const {
  extractAndValidateBinaryArchive,
  installBinaryArtifacts,
  validateBinaryArtifacts,
} = require('./binary-artifacts');

async function downloadFile(url, destination, options = {}) {
  const get = options.get || https.get;
  const maxRedirects =
    options.maxRedirects === undefined ? 5 : options.maxRedirects;
  const partialDestination = `${destination}.part`;

  async function request(currentUrl, redirectsRemaining) {
    await new Promise((resolve, reject) => {
      const requestHandle = get(currentUrl, (response) => {
        const statusCode =
          response.statusCode === undefined ? 0 : response.statusCode;
        if ([301, 302, 303, 307, 308].includes(statusCode)) {
          response.resume();
          if (redirectsRemaining === 0) {
            reject(new Error('Too many redirects while downloading binaries'));
            return;
          }
          if (!response.headers.location) {
            reject(new Error('Binary download redirect is missing a location'));
            return;
          }

          const redirectUrl = new URL(response.headers.location, currentUrl);
          if (redirectUrl.protocol !== 'https:') {
            reject(
              new Error(
                `Refusing non-HTTPS binary download redirect: ${redirectUrl.protocol}`
              )
            );
            return;
          }
          resolve(request(redirectUrl.toString(), redirectsRemaining - 1));
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`Binary download failed with HTTP ${statusCode}`));
          return;
        }

        const output = fs.createWriteStream(partialDestination, {
          flags: 'wx',
        });
        resolve(pipeline(response, output));
      });
      requestHandle.on('error', reject);
    });
  }

  await fs.promises.rm(partialDestination, { force: true });
  try {
    await request(url, maxRedirects);
    await fs.promises.rename(partialDestination, destination);
  } catch (error) {
    await fs.promises.rm(partialDestination, { force: true });
    await fs.promises.rm(destination, { force: true });
    throw error;
  }
}

async function downloadBinaries(options = {}) {
  const projectDir = options.projectDir || path.join(__dirname, '..');
  const packageMetadata = options.packageMetadata || PACKAGE_JSON;
  const logger = options.logger || console;
  const download = options.downloadFile || downloadFile;
  const releaseUrl =
    options.releaseUrl ||
    `https://github.com/${REPO}/releases/download/${encodeURIComponent(
      packageMetadata.version
    )}/binaries.tar.gz`;

  try {
    await validateBinaryArtifacts(projectDir, packageMetadata);
    logger.log(
      `Verified native binaries for ${packageMetadata.name}@${packageMetadata.version}; skipping download.`
    );
    return { status: 'existing' };
  } catch (error) {
    logger.log(`Native binaries require download: ${error.message}`);
  }

  const temporaryDir = await fs.promises.mkdtemp(
    path.join(options.temporaryParent || os.tmpdir(), 'rn-matrix-sdk-binaries-')
  );
  const archivePath = path.join(temporaryDir, 'binaries.tar.gz');
  const extractedDir = path.join(temporaryDir, 'extracted');

  try {
    logger.log(
      `Downloading native binaries for ${packageMetadata.name}@${packageMetadata.version}...`
    );
    await download(releaseUrl, archivePath);
    await extractAndValidateBinaryArchive(
      archivePath,
      extractedDir,
      packageMetadata
    );
    await installBinaryArtifacts(extractedDir, projectDir, packageMetadata);
    logger.log('Native binaries downloaded and verified successfully.');
    return { status: 'installed' };
  } finally {
    await fs.promises.rm(temporaryDir, { recursive: true, force: true });
  }
}

async function main(download = downloadBinaries, logger = console) {
  try {
    await download();
  } catch (error) {
    logger.error(`Failed to install native binaries: ${error.message}`);
    logger.error('Build matching binaries locally with: yarn generate:release');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { downloadBinaries, downloadFile, main };
