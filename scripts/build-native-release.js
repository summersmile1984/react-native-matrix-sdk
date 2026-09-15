#!/usr/bin/env node
// Builds only the distributable native libraries. It does not install an
// example app, regenerate the JS API, or download an existing SDK release.
const fs = require('node:fs');
const { Buffer } = require('node:buffer');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { packageBinaries } = require('./package-binaries');
const root = path.resolve(__dirname, '..');
const metadata = require('../package.json');
const pins = metadata.nativeRelease;
const rust = path.join(root, 'rust_modules/matrix-rust-sdk');
const cli = path.join(
  root,
  'node_modules/uniffi-bindgen-react-native/bin/cli.cjs'
);

function output(cmd, args, cwd = root) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
}
function run(cmd, args, env = {}) {
  execFileSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}
function assertEqual(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
}
async function main() {
  if (process.platform !== 'darwin')
    throw new Error('The combined Android/iOS release requires macOS');
  assertEqual(
    output('rustc', ['--version']).split(' ')[1],
    pins.rustVersion,
    'Rust version'
  );
  assertEqual(
    output('cargo', ['ndk', '--version']).split(' ')[1],
    pins.cargoNdkVersion,
    'cargo-ndk version'
  );
  assertEqual(
    output('xcodebuild', ['-version']).split('\n')[0],
    `Xcode ${pins.xcodeVersion}`,
    'Xcode version'
  );
  const ndk =
    process.env.ANDROID_NDK_HOME ||
    path.join(process.env.ANDROID_HOME || '', 'ndk', pins.ndkVersion);
  const ndkProperties = fs.readFileSync(
    path.join(ndk, 'source.properties'),
    'utf8'
  );
  assertEqual(
    ndkProperties.match(/Pkg.Revision\s*=\s*(\S+)/)?.[1],
    pins.ndkVersion,
    'NDK version'
  );
  const sourceCommit = output('git', ['rev-parse', 'HEAD']);
  if (output('git', ['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('Commit SDK source changes before building a release');
  }
  const config = fs.readFileSync(path.join(root, 'ubrn.yaml'), 'utf8');
  assertEqual(
    config.match(/\brev:\s*([a-f0-9]{40})/)?.[1],
    pins.rustRevision,
    'Rust source pin'
  );
  if (!fs.existsSync(path.join(rust, '.git'))) {
    fs.mkdirSync(path.dirname(rust), { recursive: true });
    run('git', ['init', rust]);
    run('git', [
      '-C',
      rust,
      'remote',
      'add',
      'origin',
      'https://github.com/matrix-org/matrix-rust-sdk',
    ]);
    run('git', ['-C', rust, 'fetch', '--depth=1', 'origin', pins.rustRevision]);
    run('git', ['-C', rust, 'checkout', '--detach', 'FETCH_HEAD']);
  }
  assertEqual(
    output('git', ['rev-parse', 'HEAD'], rust),
    pins.rustRevision,
    'Checked-out Rust source'
  );
  // Refuse unknown local Rust edits; the producer itself applies the versioned patches.
  if (output('git', ['status', '--porcelain', '--untracked-files=no'], rust)) {
    throw new Error(
      'Rust checkout must be clean; use a fresh isolated release checkout'
    );
  }
  run(process.execPath, ['node_modules/patch-package/index.js']);
  run(process.execPath, ['scripts/apply-android-native-patches.js']);
  const env = {
    ANDROID_NDK_HOME: ndk,
    AWS_LC_SYS_NO_JITTER_ENTROPY: '1',
    CARGO_PROFILE_RELEASE_DEBUG: '0',
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '4',
  };
  run(
    process.execPath,
    [
      cli,
      'build',
      'android',
      '--config',
      'ubrn.yaml',
      '--release',
      '--native-bindings',
    ],
    env
  );
  run(process.execPath, ['scripts/sort-uniffi-calls.js']);
  run(
    process.execPath,
    [
      cli,
      'build',
      'ios',
      '--config',
      'ubrn.yaml',
      '--release',
      '--native-bindings',
    ],
    { ...env, CARGO_FEATURE_NO_NEON: '1' }
  );
  run(process.execPath, ['scripts/apply-ios-native-patches.js']);
  // Native bindings must still describe the API checked into this release.
  const drift = output('git', [
    'diff',
    '--name-only',
    '--',
    'android/src/main/java',
    'ios/swift',
  ]);
  if (drift)
    throw new Error(
      `Generated native bindings differ from release source:\n${drift}`
    );
  for (const [abi, machine] of Object.entries({
    'arm64-v8a': 183,
    'armeabi-v7a': 40,
    'x86': 3,
    'x86_64': 62,
  })) {
    const binary = fs.readFileSync(
      path.join(root, 'android/src/main/jniLibs', abi, 'libmatrix_sdk_ffi.so')
    );
    if (
      !binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      binary[5] !== 1 ||
      binary.readUInt16LE(18) !== machine
    ) {
      throw new Error(`Invalid Android ELF architecture: ${abi}`);
    }
  }
  const framework = path.join(root, 'build/RnMatrixRustSdk.xcframework');
  const info = JSON.parse(
    output('plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      path.join(framework, 'Info.plist'),
    ])
  );
  const slices = info.AvailableLibraries.map((library) => {
    const architectures = output('xcrun', [
      'lipo',
      '-archs',
      path.join(framework, library.LibraryIdentifier, library.LibraryPath),
    ])
      .split(/\s+/)
      .sort()
      .join(',');
    return `${library.SupportedPlatform}/${library.SupportedPlatformVariant || 'device'}/${architectures}`;
  }).sort();
  assertEqual(
    slices.join(';'),
    'ios/device/arm64;ios/simulator/arm64,x86_64',
    'XCFramework slices'
  );
  const archive = await packageBinaries();
  const digest = createHash('sha256')
    .update(fs.readFileSync(archive))
    .digest('hex');
  fs.writeFileSync(
    path.join(root, 'binaries.tar.gz.sha256'),
    `${digest}  binaries.tar.gz\n`
  );
  fs.writeFileSync(
    path.join(root, 'native-release-provenance.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        sourceCommit,
        package: metadata.name,
        version: metadata.version,
        nativeRelease: pins,
        archiveSha256: digest,
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      null,
      2
    ) + '\n'
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
