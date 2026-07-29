#!/usr/bin/env node

/**
 * Applies Android-only build workarounds to generated/checked-out sources.
 *
 * `rust_modules/matrix-rust-sdk` is intentionally ignored and is reset by
 * `ubrn:checkout`, so fixes that must survive regeneration live here.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function replaceRequired(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(
      `Cannot apply ${label}: expected source anchor was not found`
    );
  }
  return source.replace(before, after);
}

function patchFile(file, marker, apply) {
  if (!fs.existsSync(file)) {
    throw new Error(`Cannot apply Android native patches: missing ${file}`);
  }

  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(marker)) {
    return false;
  }

  const patched = apply(source);
  fs.writeFileSync(file, patched);
  return true;
}

const ffiDir = path.join(
  root,
  'rust_modules',
  'matrix-rust-sdk',
  'bindings',
  'matrix-sdk-ffi'
);

const libPatched = patchFile(
  path.join(ffiDir, 'src', 'lib.rs'),
  'ANDROID_SDALLOCX_WORKAROUND',
  (source) =>
    replaceRequired(
      source,
      `use self::{
    error::ClientError,
    ruma::{Mentions, RoomMessageEventContentWithoutRelationExt},
    task_handle::TaskHandle,
};

uniffi::include_scaffolding!("api");`,
      `use self::{
    error::ClientError,
    ruma::{Mentions, RoomMessageEventContentWithoutRelationExt},
    task_handle::TaskHandle,
};

// ANDROID_SDALLOCX_WORKAROUND
// AWS-LC declares sdallocx as a weak function on Android. React Native/Folly
// exports a data symbol with the same name on platforms without ELF weak
// symbols, so the dynamic linker can otherwise resolve AWS-LC's function call
// to Folly's data pointer and jump into non-executable memory.
//
// Keep the correctly typed fallback in this shared object. The Android linker
// flag emitted from build.rs binds references to this local function.
#[cfg(target_os = "android")]
unsafe extern "C" {
    fn free(ptr: *mut std::ffi::c_void);
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sdallocx(
    ptr: *mut std::ffi::c_void,
    _size: usize,
    _flags: std::ffi::c_int,
) {
    // SAFETY: AWS-LC only calls sdallocx for allocations made through the
    // platform malloc family. Ignoring the size hint and delegating to free is
    // the fallback AWS-LC already uses when sdallocx is unavailable.
    unsafe { free(ptr) };
}

uniffi::include_scaffolding!("api");`,
      'Matrix SDK sdallocx fallback'
    )
);

const buildPatched = patchFile(
  path.join(ffiDir, 'build.rs'),
  'setup_android_allocator_symbol_workaround',
  (source) => {
    let next = replaceRequired(
      source,
      `/// Run the clang binary at \`clang_path\`, and return its major version number
fn get_clang_major_version`,
      `/// Bind function references inside the Android cdylib to functions defined by
/// the same library. This prevents React Native/Folly's data symbol named
/// \`sdallocx\` from interposing the correctly typed fallback in \`lib.rs\`.
fn setup_android_allocator_symbol_workaround() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").expect("CARGO_CFG_TARGET_OS not set");
    if target_os == "android" {
        println!("cargo:rustc-link-arg=-Wl,-Bsymbolic-functions");
    }
}

/// Run the clang binary at \`clang_path\`, and return its major version number
fn get_clang_major_version`,
      'Matrix SDK Android linker workaround'
    );
    next = replaceRequired(
      next,
      `    setup_watchos_simulator_workaround();
    uniffi::generate_scaffolding`,
      `    setup_watchos_simulator_workaround();
    setup_android_allocator_symbol_workaround();
    uniffi::generate_scaffolding`,
      'Matrix SDK Android linker setup call'
    );
    return next;
  }
);

// uniffi-bindgen-react-native 0.31 invokes cargo metadata from the SDK package
// root during --and-generate. Run it from the checked-out Rust crate instead.
const ubrnCommands = path.join(
  root,
  'node_modules',
  'uniffi-bindgen-react-native',
  'crates',
  'ubrn_cli',
  'src',
  'jsi',
  'android',
  'commands.rs'
);
const ubrnPatched = patchFile(
  ubrnCommands,
  'let pwd = ubrn_common::pwd()?;',
  (source) =>
    replaceRequired(
      source,
      `        generate_native_kotlin_bindings(GenerateOptions {
            source: library_path.clone(),
            languages: vec![TargetLanguage::Kotlin],
            out_dir: out_dir.clone(),
            format: false,
            ..Default::default()
        })?;
        Ok(())`,
      `        let pwd = ubrn_common::pwd()?;
        ubrn_common::cd(&config.crate_.crate_dir()?)?;
        let result = generate_native_kotlin_bindings(GenerateOptions {
            source: library_path.clone(),
            languages: vec![TargetLanguage::Kotlin],
            out_dir: out_dir.clone(),
            format: false,
            ..Default::default()
        });
        ubrn_common::cd(&pwd)?;
        result?;
        Ok(())`,
      'uniffi Android bindings working directory'
    )
);

// Node 24 enforces package exports. The generated CMake previously resolved
// an unexported package.json subpath and then failed to find
// UniffiCallInvoker.h when this SDK was consumed through a workspace symlink.
const ubrnCmakeTemplate = path.join(
  root,
  'node_modules',
  'uniffi-bindgen-react-native',
  'crates',
  'ubrn_cli',
  'templates',
  'jsi',
  'android',
  'CMakeLists.txt'
);
const cmakeTemplatePatched = patchFile(
  ubrnCmakeTemplate,
  "const p = require.resolve('uniffi-bindgen-react-native')",
  (source) =>
    replaceRequired(
      source,
      `# Resolve the path to the uniffi-bindgen-react-native package
execute_process(
    COMMAND node -p "require.resolve('uniffi-bindgen-react-native/package.json')"
    OUTPUT_VARIABLE UNIFFI_BINDGEN_PATH
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
# Get the directory; get_filename_component and cmake_path will normalize
# paths with Windows path separators.
get_filename_component(UNIFFI_BINDGEN_PATH "\${UNIFFI_BINDGEN_PATH}" DIRECTORY)`,
      `# Resolve the path to the uniffi-bindgen-react-native package.
# Node >= 24 enforces package exports, and package.json is not exported.
# Resolve the public entry point and trim its path back to the package root.
execute_process(
    COMMAND node -e "const p = require.resolve('uniffi-bindgen-react-native'); const m = 'uniffi-bindgen-react-native'; console.log(p.slice(0, p.indexOf(m) + m.length))"
    OUTPUT_VARIABLE UNIFFI_BINDGEN_PATH
    OUTPUT_STRIP_TRAILING_WHITESPACE
)`,
      'uniffi Android CMake Node 24 package resolution'
    )
);

const changed = [
  libPatched && 'matrix-sdk-ffi/src/lib.rs',
  buildPatched && 'matrix-sdk-ffi/build.rs',
  ubrnPatched && 'uniffi Android generator',
  cmakeTemplatePatched && 'uniffi Android CMake template',
].filter(Boolean);

console.log(
  changed.length > 0
    ? `Applied Android native patches: ${changed.join(', ')}`
    : 'Android native patches already applied'
);
