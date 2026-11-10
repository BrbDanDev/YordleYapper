const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const baseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'sea-config.json'), 'utf8'));
const configPath = path.join(__dirname, '.sea-config.generated.json');
const config = {
  ...baseConfig,
  executable: process.execPath,
  main: path.resolve(__dirname, baseConfig.main),
  output: path.resolve(__dirname, baseConfig.output),
};

try {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const result = spawnSync(process.execPath, ['--build-sea', configPath], {
    cwd: __dirname,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(configPath, { force: true });
}
