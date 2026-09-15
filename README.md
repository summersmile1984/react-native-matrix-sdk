# react-native-matrix-sdk

⚡️ FFI bindings for [matrix-rust-sdk] in a React Native Turbo Module ⚡️

[![lint](https://github.com/unomed-dev/react-native-matrix-sdk/actions/workflows/lint.yml/badge.svg)](https://github.com/unomed-dev/react-native-matrix-sdk/actions/workflows/lint.yml)
[![library](https://github.com/unomed-dev/react-native-matrix-sdk/actions/workflows/library.yml/badge.svg)](https://github.com/unomed-dev/react-native-matrix-sdk/actions/workflows/library.yml)
[![android](https://github.com/unomed-dev/react-native-matrix-sdk/actions/workflows/build-android.yml/badge.svg)](https://github.com/unomed-dev/react-native-matrix-sdk/actions/workflows/build-android.yml)
[![ios](https://github.com/unomed-dev/react-native-matrix-sdk/actions/workflows/build-ios.yml/badge.svg)](https://github.com/unomed-dev/react-native-matrix-sdk/actions/workflows/build-ios.yml)
[![android](https://github.com/unomed-dev/react-native-matrix-sdk/actions/workflows/build-release.yml/badge.svg)](https://github.com/unomed-dev/react-native-matrix-sdk/actions/workflows/build-release.yml)
[![NPM install](https://github.com/unomed-dev/react-native-matrix-sdk/actions/workflows/install.yml/badge.svg)](https://github.com/unomed-dev/react-native-matrix-sdk/actions/workflows/install.yml)

Powered by [uniffi-bindgen-react-native] and [create-react-native-library].

## Installation

### Installation into your own project

This package is available in the [npm registry].

```sh
npm i @unomed/react-native-matrix-sdk
yarn add @unomed/react-native-matrix-sdk
```

### Installation from local checkout

Clone the repository into a sibling folder of your app and then install the package using
a relative path.

```sh
npm add ../react-native-matrix-sdk
```

You might have to run `yarn prepare` in case it's not executed by default. Additionally you
need to change `metro.config.js` to find and watch the module's source code.

```js
const config = {
  resolver: {
    extraNodeModules: {
      'react-native-matrix-sdk': path.resolve(__dirname, '../react-native-matrix-sdk'),
    }, ...
  },
  watchFolders: [
    path.resolve(__dirname, '../react-native-matrix-sdk'), ...
  ]
};
```

On the first build or any time you update the version of matrix-rust-sdk, you'll have
to rebuild the Rust code and regenerate the module with

```sh
yarn generate
```

For Android-only regeneration, use:

```sh
yarn generate:android
```

The Android build runs `scripts/apply-android-native-patches.js` after
`ubrn checkout`. The script patches generated or ignored native dependencies,
so the fixes survive a clean regeneration:

- Node 24-compatible package-root and working-directory handling for UBRN;
- an AWS-LC/Folly `sdallocx` symbol collision fix that keeps the allocator
  helper local and links the static library symbolically;
- `AWS_LC_SYS_NO_JITTER_ENTROPY=1`, which selects the supported system-entropy
  path on Android.

Generated `android/CMakeLists.txt` output is expected to change after
regeneration. Do not move these compatibility fixes into hand-edits of
generated files; update the patch script and re-run `yarn generate:android`.

Published native archives contain `binary-manifest.json`, which binds every
iOS and Android binary to this package's exact name and version with file sizes
and SHA-256 checksums. `postinstall` downloads into a temporary directory,
validates the complete archive, and only then replaces installed binaries. A
missing manifest, version mismatch, truncated download, unexpected archive
entry, or checksum failure makes installation fail rather than leaving partial
or unverified native files behind.

## Usage

See [src/index.tsx] for the module's full API. You may also find a usage example
in [example/src/App.tsx].

## Contributing

See the [contributing guide] to learn about the development and contribution workflow.

## License

Apache-2.0

[contributing guide]: CONTRIBUTING.md
[create-react-native-library]: https://github.com/callstack/react-native-builder-bob
[example/src/App.tsx]: example/src/App.tsx
[matrix-rust-sdk]: https://github.com/matrix-org/matrix-rust-sdk
[npm registry]: https://www.npmjs.com/package/@unomed/react-native-matrix-sdk
[src/index.tsx]: src/index.tsx
[uniffi-bindgen-react-native]: https://github.com/jhugman/uniffi-bindgen-react-native

## TurningFlow native releases

The fork uses its own package version and GitHub Release; upstream `0.9.1`
contains older Rust bindings and is not compatible with the current source.
Native source and toolchain pins are in `package.json.nativeRelease`.

On a clean isolated macOS checkout with the pinned Rust, cargo-ndk, NDK and
Xcode installed:

```sh
node .yarn/releases/yarn-3.6.1.cjs install --immutable --mode=skip-build
node scripts/build-native-release.js
```

Skipping install lifecycle hooks breaks the bootstrap dependency on a previously
published native archive. The producer applies the checked-in generator patches,
builds release libraries without rebuilding the example app, verifies generated
Kotlin/Swift bindings against source, and packages both platforms. The consumer
still requires a complete, checksum-verified archive; normal installation never
silently skips native validation.

The manual **Build (Release)** workflow runs the same producer. Set `publish`
to true on main to create the versioned Release containing `binaries.tar.gz`,
its SHA-256 and `native-release-provenance.json`. Publishing refuses existing
tags and then verifies a fresh download. It does not publish to npm, upload
Actions artifacts or push container images. Bump the fork version for the next
native release; do not move an existing version tag.
