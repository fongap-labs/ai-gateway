import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDeployTarget } from './wrangler-deploy-guards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const localWrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const hasLocalWrangler = fs.existsSync(localWrangler);
const npxCliCandidates = [
  process.env.npm_execpath ? path.join(path.dirname(process.env.npm_execpath), 'npx-cli.js') : null,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
].filter(Boolean);
const npxCli = isWindows ? npxCliCandidates.find((candidate) => fs.existsSync(candidate)) : null;
const command = hasLocalWrangler ? process.execPath : npxCli ? process.execPath : isWindows ? 'npx.cmd' : 'npx';
const commandPrefix = hasLocalWrangler ? [localWrangler] : npxCli ? [npxCli] : [];
const passthrough = process.argv.slice(2);
const wranglerVersion = 'wrangler@4.114.0';
const args = hasLocalWrangler ? [...passthrough] : ['--yes', wranglerVersion, ...passthrough];

const operatorConfig = path.join(root, 'wrangler.user.jsonc');
const explicitConfigIndex = passthrough.findIndex((a) => a === '-c' || a === '--config');
const explicitConfigEquals = passthrough.find((a) => a.startsWith('--config='));
const hasExplicitConfig = explicitConfigIndex >= 0 || Boolean(explicitConfigEquals);
if (fs.existsSync(operatorConfig) && !hasExplicitConfig) {
  args.push('-c', 'wrangler.user.jsonc');
}

function runWrangler(wranglerArgs) {
  const result = spawnSync(command, [...commandPrefix, ...wranglerArgs], {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows && !npxCli,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function selectedConfigPath() {
  if (explicitConfigIndex >= 0) return passthrough[explicitConfigIndex + 1] || null;
  if (explicitConfigEquals) return explicitConfigEquals.slice('--config='.length) || null;
  if (fs.existsSync(operatorConfig)) return 'wrangler.user.jsonc';
  return 'wrangler.jsonc';
}

function databaseNameForBinding(configSource, binding) {
  if (!configSource) return null;
  try {
    const config = JSON.parse(configSource);
    const entry = (config?.d1_databases || []).find((d) => d && d.binding === binding && d.database_name);
    return entry?.database_name || null;
  } catch {
    return null;
  }
}

if (passthrough[0] === 'deploy' && !passthrough.includes('--dry-run')) {
  const configPath = selectedConfigPath();
  const resolvedConfig = configPath && path.resolve(root, configPath);
  const configSource = resolvedConfig && fs.existsSync(resolvedConfig) ? fs.readFileSync(resolvedConfig, 'utf8') : '';
  // Production deployment identities include the Gateway (TIER1_AFFINITY) and approved private centers.
  let config = null;
  try {
    config = JSON.parse(configSource);
  } catch {}
  const target = classifyDeployTarget(config, root);
  if (!target) {
    console.error('Refusing deploy: unapproved Worker identity, private bindings, or Operations cron state.');
    process.exitCode = 1;
    process.exit();
  }
  const dbName = databaseNameForBinding(configSource, 'TOKEN_STATS_DB');
  if (dbName && target !== 'operations') {
    const migrationArgs = ['--yes', wranglerVersion, 'd1', 'migrations', 'apply', dbName, '--remote', '-c', configPath];
    const migrationStatus = runWrangler(migrationArgs);
    if (migrationStatus !== 0) {
      process.exitCode = migrationStatus;
      process.exit();
    }
  }
}

const resultStatus = runWrangler(args);
process.exitCode = resultStatus;
