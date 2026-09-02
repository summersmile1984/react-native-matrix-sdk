/**
 * @type {import('@react-native-community/cli-types').UserConfig}
 */
module.exports = {
  // The repository root is a library, while the runnable native project lives
  // in example/. Declaring it explicitly keeps standalone codegen from
  // misclassifying the library root as an app without an Xcode project.
  project: {
    ios: {
      sourceDir: 'example/ios',
    },
    android: {
      sourceDir: 'example/android',
    },
  },
  dependency: {
    platforms: {
      android: {
        cmakeListsPath: 'generated/jni/CMakeLists.txt',
      },
    },
  },
};
