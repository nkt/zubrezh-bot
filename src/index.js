require('dotenv').config();

const _ = require('lodash');
const path = require('path');
const pino = require('pino');
const { Telegraf, Markup } = require('telegraf');
const LocalSession = require('telegraf-session-local');
const { v4: uuid } = require('uuid');

const logger = pino({
  level: 'trace',
});

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
bot.use(
  new LocalSession({
    database: path.resolve(__dirname, '../data/storage.json'),
  }).middleware()
);

async function translate(input, from, to) {
  const res = await fetch('https://api.reverso.net/translate/v1/translation', {
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9,ru;q=0.8',
      'content-type': 'application/json',
      'sec-ch-ua':
        '"Chromium";v="116", "Not)A;Brand";v="24", "Google Chrome";v="116"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'x-reverso-origin': 'translation.web',
    },
    referrer: 'https://www.reverso.net/',
    referrerPolicy: 'strict-origin-when-cross-origin',
    body: JSON.stringify({
      format: 'text',
      from,
      to,
      input,
      options: {
        sentenceSplitter: true,
        origin: 'translation.web',
        contextResults: true,
        languageDetection: true,
      },
    }),
    method: 'POST',
    mode: 'cors',
    credentials: 'omit',
  });

  if (res.ok) {
    return res.json();
  }

  throw new Error(res.statusText);
}

async function learn(ctx) {
  const sample = _.sample(ctx.session.words);
  if (!sample) {
    return ctx.reply('No words to learn');
  }

  const wrong = _.sampleSize(ctx.session.words, 3)
    .filter(({ to }) => to !== sample.to)
    .slice(0, 3);

  const { from, to } = sample;
  await ctx.reply(
    to,
    Markup.inlineKeyboard(
      _.shuffle([
        ...wrong.map(({ from }) => [Markup.button.callback(from, 'false')]),
        [Markup.button.callback(from, 'true')],
      ])
    )
  );
}

bot.command('learn', async (ctx) => {
  await learn(ctx);
});

bot.command('list', async (ctx) => {
  const words = ctx.session.words || [];
  await ctx.reply(
    `Recently added words\n` +
      words.map(({ from, to }) => `${from} ↔ ${to}`).join('\n')
  );
});

bot.on('message', async (ctx) => {
  const text = ctx.message.text?.trim();
  if (!text || text.startsWith('/')) {
    return;
  }

  const reqId = uuid();
  ctx.session.requests = Object.assign(ctx.session.requests || {}, {
    [reqId]: { term: text },
  });

  const isEnglish = /[a-z]/i.test(text);
  const translation = await translate(
    text,
    isEnglish ? 'eng' : 'rus',
    isEnglish ? 'rus' : 'eng'
  );

  console.log(translation.contextResults);

  const translations = _(translation.contextResults.results)
    .map((r) => r.translation)
    .uniq()
    .value();

  const variant = (vars, size) =>
    _(vars)
      .shuffle(vars)
      .slice(0, size)
      .sortBy((t) => t.length)
      .join(', ');

  const variants = [
    ...translations,
    variant(translations, 2),
    variant(translations, 2),
    variant(translations, 2),
    variant(translations, 2),
  ];

  ctx.session.requests = Object.assign(ctx.session.requests || {}, {
    [reqId]: {
      term: text,
      variants: Object.fromEntries(
        variants.map((v, i) => [`${reqId}:${i}`, `${v}`])
      ),
    },
  });

  const exampleHtml = (txt) =>
    txt.replaceAll('<em>', '<code>').replaceAll('</em>', '</code>');

  const examples = translation.contextResults.results
    .flatMap(({ sourceExamples, targetExamples }) =>
      sourceExamples.map((source, i) => {
        const target = targetExamples[i];

        return `– ${exampleHtml(source)}\n– ${exampleHtml(target)}`;
      })
    )
    .slice(0, 4);

  await ctx.reply(examples ? examples.join('\n\n') : translations[0], {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: variants.map((variant, index) => [
        Markup.button.callback(variant, `${reqId}:${index}`),
      ]),
    },
  });
});

bot.on('callback_query', async (ctx) => {
  if (['true', 'false'].includes(ctx.callbackQuery.data)) {
    const correct = ctx.callbackQuery.message.reply_markup.inline_keyboard
      .flatMap((t) => t)
      .find((t) => t.callback_data === 'true');
    ctx.editMessageText(
      `${JSON.parse(ctx.callbackQuery.data) ? '👍' : '👎'} ${
        ctx.callbackQuery.message.text
      } ↔ ${correct.text}`
    );

    return learn(ctx);
  }

  const [id] = ctx.callbackQuery.data.split(':');
  const request = ctx.session.requests[id];

  const from = request.term;
  const to = request.variants[ctx.callbackQuery.data];

  ctx.session.words = ctx.session.words || [];
  ctx.session.words.push({
    from,
    to,
  });

  await ctx.editMessageText(`👍 ${from} ↔ ${to}`);
});

bot.on('error', (error) => {
  logger.error('unexpected error', error);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

(async () => {
  await bot.telegram.setMyCommands([
    {
      command: 'learn',
      description: 'learn one of recently added words',
    },
    {
      command: 'list',
      description: 'list recently added words',
    },
  ]);

  await bot.launch();
})();
