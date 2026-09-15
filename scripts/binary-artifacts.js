#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tar = require('tar');
const { isDeepStrictEqual } = require('node:util');

const MANIFEST_FILENAME = 'binary-manifest.json';
const MANIFEST_SCHEMA_VERSION = 1;
const IOS_ARTIFACT = 'build/RnMatrixRustSdk.xcframework';
const ANDROID_ARTIFACT = 'android/src/main/jniLibs';
const REQUIRED_ANDROID_LIBRARIES = [
  `${ANDROID_ARTIFACT}/arm64-v8a/libmatrix_sdk_ffi.so`,
  `${ANDROID_ARTIFACT}/armeabi-v7a/libmatrix_sdk_ffi.so`,
  `${ANDROID_ARTIFACT}/x86/libmatrix_sdk_ffi.so`,
  `${ANDROID_ARTIFACT}/x86_64/libmatrix_sdk_ffi.so`,
];

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function normalizeArchivePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) {
    throw new Error(`Unsafe binary archive path: ${String(value)}`);
  }

  const normalized = path.posix.normalize(value.replace(/^\.\//, ''));
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`Unsafe binary archive path: ${value}`);
  }
  return normalized.replace(/\/$/, '');
}

function validateArchiveEntry(entryPath, entryType) {
  const normalized = normalizeArchivePath(entryPath);
  const allowedType = entryType === 'File' || entryType === 'Directory';
  if (!allowedType) {
    throw new Error(
      `Unsupported binary archive entry type ${entryType} for ${entryPath}`
    );
  }

  if (normalized === MANIFEST_FILENAME) {
    if (entryType !== 'File') {
      throw new Error(`${MANIFEST_FILENAME} must be a regular file`);
    }
    return true;
  }

  const artifactRoots = [IOS_ARTIFACT, ANDROID_ARTIFACT];
  if (
    artifactRoots.some(
      (root) => normalized === root || normalized.startsWith(`${root}/`)
    )
  ) {
    return true;
  }

  const allowedDirectories = new Set([
    'build',
    'android',
    'android/src',
    'android/src/main',
  ]);
  if (entryType === 'Directory' && allowedDirectories.has(normalized)) {
    return true;
  }

  throw new Error(`Unexpected file in binary archive: ${entryPath}`);
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolve);
  });
  return hash.digest('hex');
}

async function walkRegularFiles(rootDir, projectDir) {
  const files = [];

  async function walk(currentDir) {
    const entries = await fs.promises.readdir(currentDir, {
      withFileTypes: true,
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        files.push(toPosixPath(path.relative(projectDir, absolutePath)));
      } else {
        throw new Error(
          `Binary artifacts may not contain links or special files: ${absolutePath}`
        );
      }
    }
  }

  let rootStats;
  try {
    rootStats = await fs.promises.lstat(rootDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Missing binary artifact directory: ${rootDir}`);
    }
    throw error;
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`Binary artifact path is not a directory: ${rootDir}`);
  }

  await walk(rootDir);
  return files;
}

async function collectBinaryFiles(projectDir) {
  const files = [];
  for (const artifactPath of [IOS_ARTIFACT, ANDROID_ARTIFACT]) {
    files.push(
      ...(await walkRegularFiles(
        path.join(projectDir, artifactPath),
        projectDir
      ))
    );
  }
  files.sort();

  const requiredFiles = [
    `${IOS_ARTIFACT}/Info.plist`,
    ...REQUIRED_ANDROID_LIBRARIES,
  ];
  for (const requiredFile of requiredFiles) {
    if (!files.includes(requiredFile)) {
      throw new Error(`Missing required binary artifact: ${requiredFile}`);
    }
  }

  if (
    !files.some(
      (file) => file.startsWith(`${IOS_ARTIFACT}/`) && file.endsWith('.a')
    )
  ) {
    throw new Error(`Missing static library in ${IOS_ARTIFACT}`);
  }

  return files;
}

function validatePackageMetadata(packageMetadata) {
  if (
    !packageMetadata ||
    typeof packageMetadata.name !== 'string' ||
    packageMetadata.name.length === 0 ||
    typeof packageMetadata.version !== 'string' ||
    packageMetadata.version.length === 0
  ) {
    throw new Error('Binary manifest requires a package name and version');
  }
}

async function createBinaryManifest(projectDir, packageMetadata) {
  validatePackageMetadata(packageMetadata);
  const files = await collectBinaryFiles(projectDir);
  const entries = [];

  for (const relativePath of files) {
    const absolutePath = path.join(projectDir, relativePath);
    const stats = await fs.promises.stat(absolutePath);
    entries.push({
      path: relativePath,
      size: stats.size,
      sha256: await sha256File(absolutePath),
    });
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    package: {
      name: packageMetadata.name,
      version: packageMetadata.version,
    },
    ...(packageMetadata.nativeRelease
      ? { nativeRelease: packageMetadata.nativeRelease }
      : {}),
    files: entries,
  };
}

async function writeBinaryManifest(projectDir, packageMetadata) {
  const manifest = await createBinaryManifest(projectDir, packageMetadata);
  const manifestPath = path.join(projectDir, MANIFEST_FILENAME);
  await fs.promises.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
  return manifest;
}

function validateManifestShape(manifest, expectedPackage) {
  validatePackageMetadata(expectedPackage);
  if (!manifest || manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported binary manifest schema: ${String(
        manifest && manifest.schemaVersion
      )}`
    );
  }
  const manifestPackage = manifest.package || {};
  if (
    expectedPackage.nativeRelease &&
    !isDeepStrictEqual(manifest.nativeRelease, expectedPackage.nativeRelease)
  ) {
    throw new Error('Binary native source/toolchain mismatch');
  }
  if (
    manifestPackage.name !== expectedPackage.name ||
    manifestPackage.version !== expectedPackage.version
  ) {
    throw new Error(
      `Binary artifact version mismatch: expected ${expectedPackage.name}@${expectedPackage.version}, ` +
        `received ${String(manifestPackage.name)}@${String(
          manifestPackage.version
        )}`
    );
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Binary manifest does not contain any files');
  }

  const seenPaths = new Set();
  for (const entry of manifest.files) {
    const normalized = normalizeArchivePath(entry && entry.path);
    if (
      !normalized.startsWith(`${IOS_ARTIFACT}/`) &&
      !normalized.startsWith(`${ANDROID_ARTIFACT}/`)
    ) {
      throw new Error(`Unexpected path in binary manifest: ${normalized}`);
    }
    if (seenPaths.has(normalized)) {
      throw new Error(`Duplicate path in binary manifest: ${normalized}`);
    }
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error(`Invalid metadata for binary artifact: ${normalized}`);
    }
    seenPaths.add(normalized);
  }
}

async function readBinaryManifest(projectDir) {
  const manifestPath = path.join(projectDir, MANIFEST_FILENAME);
  let source;
  try {
    source = await fs.promises.readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Missing ${MANIFEST_FILENAME}`);
    }
    throw error;
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid ${MANIFEST_FILENAME}: ${error.message}`);
  }
}

async function validateBinaryArtifacts(projectDir, expectedPackage) {
  const manifest = await readBinaryManifest(projectDir);
  validateManifestShape(manifest, expectedPackage);

  const actualFiles = await collectBinaryFiles(projectDir);
  const manifestFiles = manifest.files.map((entry) =>
    normalizeArchivePath(entry.path)
  );
  const sortedManifestFiles = [...manifestFiles].sort();
  if (
    actualFiles.length !== sortedManifestFiles.length ||
    actualFiles.some((file, index) => file !== sortedManifestFiles[index])
  ) {
    throw new Error('Binary artifact files do not match the manifest');
  }

  for (const entry of manifest.files) {
    const relativePath = normalizeArchivePath(entry.path);
    const absolutePath = path.join(projectDir, relativePath);
    const stats = await fs.promises.stat(absolutePath);
    if (stats.size !== entry.size) {
      throw new Error(`Binary artifact size mismatch: ${relativePath}`);
    }
    const actualSha256 = await sha256File(absolutePath);
    if (actualSha256 !== entry.sha256) {
      throw new Error(`Binary artifact checksum mismatch: ${relativePath}`);
    }
  }

  return manifest;
}

async function extractAndValidateBinaryArchive(
  archivePath,
  destinationDir,
  expectedPackage
) {
  let invalidEntry;
  await tar.t({
    file: archivePath,
    strict: true,
    onentry: (entry) => {
      if (invalidEntry) {
        return;
      }
      try {
        validateArchiveEntry(entry.path, entry.type);
      } catch (error) {
        invalidEntry = error;
      }
    },
  });
  if (invalidEntry) {
    throw invalidEntry;
  }

  await fs.promises.mkdir(destinationDir, { recursive: true });
  await tar.x({
    file: archivePath,
    cwd: destinationDir,
    strict: true,
    preservePaths: false,
  });
  return validateBinaryArtifacts(destinationDir, expectedPackage);
}

async function copyArtifact(source, destination) {
  const stats = await fs.promises.lstat(source);
  if (stats.isDirectory()) {
    await fs.promises.cp(source, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } else if (stats.isFile()) {
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  } else {
    throw new Error(`Cannot install special binary artifact: ${source}`);
  }
}

async function installBinaryArtifacts(
  stagedProjectDir,
  projectDir,
  expectedPackage,
  options = {}
) {
  await validateBinaryArtifacts(stagedProjectDir, expectedPackage);
  const cleanupBackup =
    options.cleanupBackup ||
    ((backupPath) =>
      fs.promises.rm(backupPath, {
        recursive: true,
        force: true,
      }));
  const onCleanupError = options.onCleanupError || (() => {});

  const nonce = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const targets = [
    {
      source: path.join(stagedProjectDir, IOS_ARTIFACT),
      destination: path.join(projectDir, IOS_ARTIFACT),
    },
    {
      source: path.join(stagedProjectDir, ANDROID_ARTIFACT),
      destination: path.join(projectDir, ANDROID_ARTIFACT),
    },
    {
      source: path.join(stagedProjectDir, MANIFEST_FILENAME),
      destination: path.join(projectDir, MANIFEST_FILENAME),
    },
  ].map((target) => ({
    ...target,
    incoming: path.join(
      path.dirname(target.destination),
      `.${path.basename(target.destination)}.incoming-${nonce}`
    ),
    backup: path.join(
      path.dirname(target.destination),
      `.${path.basename(target.destination)}.backup-${nonce}`
    ),
    hadDestination: false,
    installed: false,
  }));

  try {
    for (const target of targets) {
      await fs.promises.mkdir(path.dirname(target.destination), {
        recursive: true,
      });
      await copyArtifact(target.source, target.incoming);
    }

    try {
      for (const target of targets) {
        try {
          await fs.promises.rename(target.destination, target.backup);
          target.hadDestination = true;
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        }
        await fs.promises.rename(target.incoming, target.destination);
        target.installed = true;
      }

      await validateBinaryArtifacts(projectDir, expectedPackage);
    } catch (error) {
      const rollbackErrors = [];
      for (const target of [...targets].reverse()) {
        try {
          if (target.installed) {
            await fs.promises.rm(target.destination, {
              recursive: true,
              force: true,
            });
          }
          if (target.hadDestination) {
            await fs.promises.rename(target.backup, target.destination);
            target.hadDestination = false;
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        const combinedError = new Error(
          `Binary installation failed and rollback was incomplete: ${error.message}`
        );
        combinedError.cause = error;
        combinedError.rollbackErrors = rollbackErrors;
        throw combinedError;
      }
      throw error;
    }
  } finally {
    for (const target of targets) {
      try {
        await fs.promises.rm(target.incoming, {
          recursive: true,
          force: true,
        });
      } catch (_error) {
        // Incoming files are never active. Leave cleanup to the next install or
        // package-manager removal rather than masking the transaction result.
      }
    }
  }

  const cleanupErrors = [];
  for (const target of targets) {
    if (!target.hadDestination) {
      continue;
    }
    try {
      await cleanupBackup(target.backup);
      target.hadDestination = false;
    } catch (error) {
      cleanupErrors.push(error);
      onCleanupError(error, target.backup);
    }
  }
  return { cleanupErrors };
}

module.exports = {
  ANDROID_ARTIFACT,
  IOS_ARTIFACT,
  MANIFEST_FILENAME,
  createBinaryManifest,
  extractAndValidateBinaryArchive,
  installBinaryArtifacts,
  validateArchiveEntry,
  validateBinaryArtifacts,
  writeBinaryManifest,
};
