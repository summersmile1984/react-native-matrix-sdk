#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const sdkRoot = path.join(__dirname, '..');
const frameworkRoot = path.join(
  sdkRoot,
  'build',
  'RnMatrixRustSdk.xcframework'
);
const openMarker = '/* BEGIN UNIFFI C LINKAGE */';
const closeMarker = '/* END UNIFFI C LINKAGE */';

function patchHeader(headerPath) {
  const source = fs.readFileSync(headerPath, 'utf8');
  if (source.includes(openMarker)) {
    return false;
  }

  const includeAnchor = '#include <stdint.h>\n';
  if (!source.includes(includeAnchor)) {
    throw new Error(`Unexpected UniFFI header layout: ${headerPath}`);
  }

  const patched =
    source.replace(
      includeAnchor,
      `${includeAnchor}\n${openMarker}\n#ifdef __cplusplus\nextern "C" {\n#endif\n`
    ) + `\n#ifdef __cplusplus\n}\n#endif\n${closeMarker}\n`;

  fs.writeFileSync(headerPath, patched, 'utf8');
  return true;
}

if (!fs.existsSync(frameworkRoot)) {
  throw new Error(`Missing generated iOS framework: ${frameworkRoot}`);
}

let patchedCount = 0;
for (const slice of fs.readdirSync(frameworkRoot, { withFileTypes: true })) {
  if (!slice.isDirectory()) {
    continue;
  }

  const headersDir = path.join(frameworkRoot, slice.name, 'Headers');
  if (!fs.existsSync(headersDir)) {
    continue;
  }

  for (const entry of fs.readdirSync(headersDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('FFI.h')) {
      patchedCount += Number(patchHeader(path.join(headersDir, entry.name)));
    }
  }
}

console.log(
  patchedCount === 0
    ? 'iOS UniFFI headers already expose C linkage.'
    : `Patched C linkage in ${patchedCount} iOS UniFFI headers.`
);
