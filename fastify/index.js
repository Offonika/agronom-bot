require('dotenv').config();
const Fastify = require('fastify');
const fastifyMultipart = require('@fastify/multipart');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');

const app = Fastify({ logger: true });
app.register(fastifyMultipart);

const s3 = new S3Client({
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  credentials: process.env.S3_ACCESS_KEY
    ? {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
      }
    : undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT,
});

const bucket = process.env.S3_BUCKET || 'agronom';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function saveToS3(key, buffer) {
  const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer });
  await s3.send(cmd);
}

async function logToDb(key) {
  try {
    await pool.query(
      'INSERT INTO photos (user_id, file_id, status) VALUES ($1, $2, $3)',
      [1, key, 'processed']
    );
  } catch (err) {
    app.log.error('DB error', err);
  }
}

app.post('/v1/ai/diagnose', async function (request, reply) {
  let buffer;
  let filename;

  if (request.isMultipart()) {
    const data = await request.file();
    filename = Date.now() + '-' + (data.filename || 'upload');
    buffer = await data.toBuffer();
  } else {
    const body = request.body;
    if (!body || !body.image_base64) {
      return reply.code(400).send({ code: 'BAD_REQUEST', message: 'No image' });
    }
    buffer = Buffer.from(body.image_base64, 'base64');
    filename = Date.now() + '-base64.jpg';
  }

  try {
    await saveToS3(filename, buffer);
    await logToDb(filename);
    return {
      crop: 'apple',
      disease: 'powdery mildew',
      confidence: 0.87,
    };
  } catch (err) {
    app.log.error('S3/DB error', err);
    return reply
      .code(500)
      .send({ code: 'SERVICE_UNAVAILABLE', message: 'Failed to process image' });
  }
});

app.get('/v1/photos/history', async function (request) {
  const limitParam = parseInt(request.query.limit ?? '10', 10);
  const parsedOffset = parseInt(request.query.offset ?? '0', 10);
  const offset = Math.max(0, parsedOffset);
  const limit = Math.min(Number.isNaN(limitParam) ? 10 : limitParam, 50);

  let userId = 1;
  if (request.headers['x-user-id']) {
    const parsed = parseInt(request.headers['x-user-id'], 10);
    if (!Number.isNaN(parsed)) {
      userId = parsed;
    }
  }

  const res = await pool.query(
    `SELECT id AS photo_id, ts, crop, disease, status, confidence, file_id
     FROM photos
     WHERE user_id = $1
     ORDER BY ts DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const baseUrl = process.env.S3_PUBLIC_URL ||
    (process.env.S3_ENDPOINT
      ? `${process.env.S3_ENDPOINT.replace(/\/$/, '')}/${bucket}`
      : `https://${bucket}.s3.amazonaws.com`);

  return res.rows.map((r) => ({
    photo_id: r.photo_id,
    ts: r.ts,
    crop: r.crop,
    disease: r.disease,
    status: r.status,
    confidence: parseFloat(r.confidence),
    thumb_url: `${baseUrl}/${r.file_id}`,
  }));
});

const start = async () => {
  try {
    await app.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

module.exports = { app, pool };
