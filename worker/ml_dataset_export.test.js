const assert = require('node:assert/strict');
const { test } = require('node:test');
const { copyOldPhotos } = require('./ml_dataset_export');

test('copies consented photos older than 90 days', async () => {
  const updated = [];
  const executed = [];
  const client = {
    query: async (sql, params) => {
      executed.push(sql);
      if (sql.startsWith('SELECT')) {
        return { rows: [{ id: 1, file_id: 'a.jpg' }, { id: 2, file_id: 'b.jpg' }] };
      }
      if (sql.startsWith('UPDATE')) {
        updated.push(params[0]);
      }
      return {};
    },
    release: () => {},
  };
  const pool = { connect: async () => client };
  const copied = [];
  const s3 = {
    send: async (cmd) => {
      copied.push(cmd.input.Key);
    },
  };
  await copyOldPhotos(pool, s3);
  assert.deepEqual(copied, ['ml-dataset/1.jpg', 'ml-dataset/2.jpg']);
  assert.deepEqual(updated, [1, 2]);
  assert.ok(executed[0].includes('users.opt_in=true'));
});
