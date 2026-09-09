const fs = require('node:fs');

const FIXTURE_CLIENT_ID = 'tidl-ci-fixture-not-for-publication';
function buildEnv(env = process.env, cwd = process.cwd()) {
  const values = {};
  const file = require('node:path').join(cwd, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return {
    clientId: String(env.TIDAL_CLIENT_ID ?? values.TIDAL_CLIENT_ID ?? '').trim(),
    devServer: String(env.TIDL_DEV_SERVER_URL ?? '').trim(),
  };
}
function releaseEnv(env = process.env, cwd = process.cwd(), allowFixture = false) {
  const config = buildEnv(env, cwd);
  if (!config.clientId) throw new Error('Release packaging requires TIDAL_CLIENT_ID.');
  if (config.devServer) throw new Error('Release packaging rejects TIDL_DEV_SERVER_URL. Stop the development build.');
  if (!allowFixture && config.clientId === FIXTURE_CLIENT_ID) throw new Error('CI fixture artifacts cannot be published.');
  return config;
}
module.exports = { buildEnv, releaseEnv, FIXTURE_CLIENT_ID };
