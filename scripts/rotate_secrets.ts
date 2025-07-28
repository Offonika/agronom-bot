import { execSync } from 'child_process';
import crypto from 'crypto';
import vault from 'node-vault';

const VAULT_ADDR = process.env.VAULT_ADDR;
const VAULT_TOKEN = process.env.VAULT_TOKEN;

if (!VAULT_ADDR || !VAULT_TOKEN) {
  console.error('VAULT_ADDR and VAULT_TOKEN must be set');
  process.exit(1);
}

const client = vault({ endpoint: VAULT_ADDR, token: VAULT_TOKEN });
const secrets = ['DB_URL', 'BOT_TOKEN_DEV', 'S3_KEY'];

async function rotate(name: string) {
  const newValue = crypto.randomBytes(32).toString('hex');
  await client.write(`secret/data/${name}`, { data: { value: newValue } });
  console.log(`Rotated ${name}`);
}

(async () => {
  for (const name of secrets) {
    await rotate(name);
  }
  execSync('kubectl rollout restart deployment/agronom-bot', { stdio: 'inherit' });
})();
