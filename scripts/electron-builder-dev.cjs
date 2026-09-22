const packageJson = require("../package.json");

// Temporary builds inherit the production resource/file layout but deliberately
// omit the formal pideck:// protocol registration. Installing a test build must
// never steal the protocol association from the release client.
const { publish: _publish, ...productionBuild } = packageJson.build;

module.exports = {
  ...productionBuild,
  productName: "PiDeck-Dev",
  appId: "com.ayuayue.pi-desktop-dev",
  protocols: [],
  directories: {
    ...productionBuild.directories,
    output: "release-dev",
  },
};
