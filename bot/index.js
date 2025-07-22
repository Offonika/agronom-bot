require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');
const { photoHandler, messageHandler, startHandler } = require('./handlers');

const token = process.env.BOT_TOKEN_DEV;
if (!token) {
  throw new Error('BOT_TOKEN_DEV not set');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const bot = new Telegraf(token);

bot.start(startHandler);

bot.on('photo', (ctx) => photoHandler(pool, ctx));

bot.on('message', messageHandler);

bot.launch().then(() => console.log('Bot started'));

