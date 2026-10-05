// @couli/h5: the H5 app shared by the iOS, Android and HarmonyOS shells (规划/03 §8).
// The app / landing / conformance entries live under src/entries/ and are built one at a time
// (`vite build --mode <entry>`); shared code is under src/shared/.

/** Workspace package name; the entries are HTML builds, not exports of this module. */
export const PACKAGE_NAME = '@couli/h5';
