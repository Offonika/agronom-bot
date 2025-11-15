require('dotenv').config();
const { Queue, Worker } = require('bullmq');
const { Pool } = require('pg');
const { S3Client, CopyObjectCommand } = require('@aws-sdk/client-s3');

const connection = { url: process.env.REDIS_URL || 'redis://localhost:6379' };
const queueName = 'ml-dataset-export';

const s3Config = {
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: !!process.env.S3_ENDPOINT,
  credentials: process.env.S3_ACCESS_KEY
    ? { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY }
    : undefined,
};
const bucket = process.env.S3_BUCKET || 'agronom';

async function copyOldPhotos(pool, s3Client) {
  const client = await pool.connect();
  let copied = 0;
  try {
    const { rows } = await client.query(
      "SELECT photos.id, photos.file_id FROM photos JOIN users ON users.id = photos.user_id WHERE photos.status='ok' AND photos.deleted=false AND users.opt_in=true AND photos.ts < (now() - interval '90 day')"
    );
    for (const row of rows) {
      const key = `ml-dataset/${row.id}.jpg`;
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${row.file_id}`,
          Key: key,
          MetadataDirective: 'COPY',
        })
      );
      await client.query('UPDATE photos SET deleted=true WHERE id=$1', [row.id]);
      copied += 1;
    }
    console.log(`ML export: copied=${copied}`);
  } finally {
    client.release();
  }
}

module.exports = { copyOldPhotos };

if (require.main === module) {
  const queue = new Queue(queueName, { connection });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const s3 = new S3Client(s3Config);

  async function schedule() {
    const jobs = await queue.getRepeatableJobs();
    const alreadyScheduled = jobs.some((job) => job.id === 'export');
    if (!alreadyScheduled) {
      await queue.add('export', {}, {
        jobId: 'export',
        repeat: { cron: '0 3 * * *', tz: 'Europe/Moscow' },
        removeOnComplete: true,
      });
    }
  }
  schedule();
  new Worker(queueName, () => copyOldPhotos(pool, s3), { connection });
}
