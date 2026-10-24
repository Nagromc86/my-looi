const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

// French fork: copy whichever models scripts/download-vosk-command-models.sh
// staged (selected with VOSK_LANGUAGES), instead of requiring all of them.
function stagedModelDirs(sourceRoot) {
  if (!fs.existsSync(sourceRoot)) return [];
  return fs.readdirSync(sourceRoot).filter((name) => name.startsWith("vosk-command-"));
}

module.exports = function withVoskCommandModels(config) {
  return withDangerousMod(config, [
    "android",
    async (androidConfig) => {
      const projectRoot = androidConfig.modRequest.projectRoot;
      const androidRoot = androidConfig.modRequest.platformProjectRoot;
      const sourceRoot = path.join(projectRoot, ".build-assets", "vosk");
      const assetsRoot = path.join(androidRoot, "app", "src", "main", "assets");
      fs.mkdirSync(assetsRoot, { recursive: true });

      const modelDirs = stagedModelDirs(sourceRoot);
      if (!modelDirs.includes("vosk-command-fr")) {
        throw new Error("Missing Vosk command model vosk-command-fr. Run scripts/download-vosk-command-models.sh before expo prebuild.");
      }
      for (const modelDir of modelDirs) {
        const source = path.join(sourceRoot, modelDir);
        const destination = path.join(assetsRoot, modelDir);
        if (!fs.existsSync(source)) {
          throw new Error(
            `Missing Vosk command model ${modelDir}. Run scripts/download-vosk-command-models.sh before expo prebuild.`
          );
        }
        fs.rmSync(destination, { recursive: true, force: true });
        fs.cpSync(source, destination, { recursive: true, dereference: true });
      }

      return androidConfig;
    },
  ]);
};
