#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectDir = path.resolve(__dirname, '..');
const packageMetadata = require(path.join(projectDir, 'package.json'));
const codegenConfig = packageMetadata.codegenConfig;

function requiredConfig(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing package.json ${label}`);
  }
  return value;
}

function resolveOutputDir(value, label) {
  const configuredPath = requiredConfig(value, label);
  if (path.isAbsolute(configuredPath)) {
    throw new Error(`${label} must be relative to the SDK root`);
  }
  const resolvedPath = path.resolve(projectDir, configuredPath);
  if (
    resolvedPath === projectDir ||
    !resolvedPath.startsWith(`${projectDir}${path.sep}`)
  ) {
    throw new Error(`${label} must stay inside the SDK root`);
  }
  return resolvedPath;
}

function patchAndroidJavaPackage() {
  const androidOutput = resolveOutputDir(
    codegenConfig?.outputDir?.android,
    'codegenConfig.outputDir.android'
  );
  const javaPackage = requiredConfig(
    codegenConfig?.android?.javaPackageName,
    'codegenConfig.android.javaPackageName'
  );
  const generatedPackageDir = path.join(
    androidOutput,
    'java/com/facebook/fbreact/specs'
  );
  if (!fs.existsSync(generatedPackageDir)) {
    throw new Error(
      `React Native codegen did not create ${generatedPackageDir}`
    );
  }

  const destinationDir = path.join(
    androidOutput,
    'java',
    ...javaPackage.split('.')
  );
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const fileName of fs.readdirSync(generatedPackageDir)) {
    const sourcePath = path.join(generatedPackageDir, fileName);
    const destinationPath = path.join(destinationDir, fileName);
    const source = fs
      .readFileSync(sourcePath, 'utf8')
      .replace('package com.facebook.fbreact.specs', `package ${javaPackage}`);
    fs.writeFileSync(destinationPath, source);
  }
  fs.rmSync(path.join(androidOutput, 'java/com/facebook'), {
    recursive: true,
    force: true,
  });
}

function assertGeneratedArtifacts() {
  const iosOutput = resolveOutputDir(
    codegenConfig?.outputDir?.ios,
    'codegenConfig.outputDir.ios'
  );
  const androidOutput = resolveOutputDir(
    codegenConfig?.outputDir?.android,
    'codegenConfig.outputDir.android'
  );
  const requiredArtifacts = [
    path.join(iosOutput, codegenConfig.name, `${codegenConfig.name}.h`),
    path.join(androidOutput, 'jni', `${codegenConfig.name}.h`),
  ];
  for (const artifact of requiredArtifacts) {
    if (!fs.existsSync(artifact)) {
      throw new Error(`Codegen did not create required artifact: ${artifact}`);
    }
  }
}

function main() {
  for (const outputDir of [
    codegenConfig?.outputDir?.android,
    codegenConfig?.outputDir?.ios,
  ]) {
    fs.rmSync(resolveOutputDir(outputDir, 'codegen output'), {
      recursive: true,
      force: true,
    });
  }

  const cliPackage = require.resolve(
    '@react-native-community/cli/package.json',
    { paths: [projectDir] }
  );
  const cli = path.join(path.dirname(cliPackage), 'build/bin.js');
  const result = spawnSync(
    process.execPath,
    [cli, 'codegen', '--platform', 'all', '--path', projectDir],
    {
      cwd: projectDir,
      stdio: 'inherit',
    }
  );
  if (result.error) throw result.error;
  // React Native 0.81 can exit non-zero while generating app-level provider
  // files for a standalone library, after the library artifacts themselves
  // have been written. Validate the artifacts we actually ship before
  // deciding whether that late provider-generation error is fatal.
  patchAndroidJavaPackage();
  assertGeneratedArtifacts();
  if (result.status !== 0) {
    console.warn(
      `React Native codegen exited ${result.status} after producing all required library artifacts.`
    );
  }
  console.log('Generated and validated Matrix SDK native code.');
}

try {
  main();
} catch (error) {
  console.error(
    `Matrix SDK codegen failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exitCode = 1;
}
