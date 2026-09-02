# Matrix SDK React Native example

This is a private debug smoke-test app for the SDK workspace. It verifies that
the local package links into React Native, renders a capability screen, and can
query a homeserver's advertised login methods. It is not a production client
and its release build is deliberately disabled.

Run commands from the SDK repository root:

```bash
yarn install --immutable
yarn workspace @unomed/react-native-matrix-sdk-example test
yarn workspace @unomed/react-native-matrix-sdk-example start
yarn workspace @unomed/react-native-matrix-sdk-example android
yarn workspace @unomed/react-native-matrix-sdk-example ios
```

The homeserver field accepts HTTPS URLs. Plain HTTP is limited to loopback
addresses for local development, and credentials, query strings, and fragments
are rejected.

## Native build gates

Android and iOS codegen use `yarn codegen` and fail closed if required generated
artifacts are absent. iOS installs the CocoaPods version pinned in
`Gemfile.lock` and requires `pod install --deployment`.

CI runs lint, TypeScript checks, behavior tests, binary-installer tests, both
native debug builds, and the iOS render test. Android tasks whose name contains
`release` fail intentionally; do not distribute this example.

The example remains on React Native 0.76 while the supported Gemini application
uses React Native 0.81. Passing this smoke test therefore proves the SDK's
example contract, not full compatibility with the production application.
