require('dotenv').config();
const Fastify = require('fastify');
const fastifyMultipart = require('@fastify/multipart');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');
const path = require('path');

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
  } catch (err) {
    app.log.error('S3/DB error', err);
  }

  return {
    crop: 'apple',
    disease: 'powdery mildew',
    confidence: 0.87,
  };
});

const start = async () => {
  try {
    await app.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
