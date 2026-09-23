const packageJson = require("../package.json");

// Temporary builds inherit the production resource/file layout but deliberately
// omit the formal pideck:// protocol registration. Installing a test build must
// never steal the protocol association from the release client.
const { publish: _publish, ...productionBuild } = packageJson.build;

module.exports = {
  ...productionBuild,
  // Keep every temporary artifact visibly and mechanically separate from release.
  productName: "PiDeck-Dev",
  appId: "com.ayuayue.pi-desktop-dev",
  protocols: [],
  artifactName: "PiDeck-Dev-${version}-temporary.${ext}",
  win: {
    ...productionBuild.win,
    artifactName: "PiDeck-Dev-${version}-temporary.${ext}",
  },
  nsis: {
    ...productionBuild.nsis,
    artifactName: "PiDeck-Dev-${version}-temporary-setup.${ext}",
  },
  portable: {
    ...productionBuild.portable,
    artifactName: "PiDeck-Dev-${version}-temporary-portable.${ext}",
  },
  directories: {
    ...productionBuild.directories,
    output: "release-dev",
  },
};
