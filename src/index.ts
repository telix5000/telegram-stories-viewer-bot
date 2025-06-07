// src/index.ts

// Global error handlers must be at the absolute top.
process.on('unhandledRejection', (reason, promise) => { console.error('CRITICAL_ERROR: Unhandled Rejection at:', promise, 'reason:', reason); });
process.on('uncaughtException', (error, origin) => { console.error('CRITICAL_ERROR: Uncaught Exception:', error, 'origin:', origin); });
console.log("Global error handlers have been attached.");

import { IContextBot } from 'config/context-interface';
import { BOT_ADMIN_ID, BOT_TOKEN } from 'config/env-config';
import { initUserbot } from 'config/userbot';
import { session, Telegraf } from 'telegraf';
import { db, resetStuckJobs } from './db';
import { processQueue, handleNewTask } from './services/queue-manager';
import { saveUser } from './repositories/user-repository';
import { isUserPremium, addPremiumUser, removePremiumUser } from './services/premium-service';
import { UserInfo } from 'types';

export const bot = new Telegraf<IContextBot>(BOT_TOKEN!);
const RESTART_COMMAND = 'restart';
const extraOptions: any = { link_preview_options: { is_disabled: true } };

bot.use(session());
bot.catch((error, ctx) => {
  console.error(`A global error occurred for chat ${ctx.chat?.id}:`, error);
  ctx.reply('Sorry, an unexpected error occurred. Please try again later.').catch(() => {});
});

function isActivated(userId: number): boolean {
  try {
    const user = db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(String(userId));
    return !!user;
  } catch (error) {
    console.error(`[isActivated] Database check failed for user ${userId}:`, error);
    return false;
  }
}

// =========================================================================
//  COMMAND & EVENT HANDLERS
// =========================================================================

bot.start(async (ctx) => {
  await saveUser(ctx.from);
  await ctx.reply(
    "🔗 Please send one of the following:\n\n" +
      "*Username with '@' symbol:*\n`@durov`\n\n" +
      "*Phone number with '+' symbol:*\n`+15551234567`\n\n" +
      '*Direct link to a story:*\n`https://t.me/durov/s/1`',
    { ...extraOptions, parse_mode: 'Markdown' }
  );
});

bot.command('help', async (ctx) => {
  let finalHelpText = '*Ghost Stories Bot Help*\\n\\n' +
    '*General Commands:*\\n' +
    '`/start` \\- Show usage instructions\\n' +
    '`/help` \\- Show this help message\\n' +
    '`/premium` \\- Info about premium features\\n';

  // FINAL FIX: Compare string to string for the admin check.
  if (ctx.from.id.toString() === BOT_ADMIN_ID) {
    finalHelpText += '\\n*Admin Commands:*\\n' +
      '`/setpremium <ID or @username>` \\- Mark user as premium\\n' +
      '`/unsetpremium <ID or @username>` \\- Remove premium status\\n' +
      '`/ispremium <ID or @username>` \\- Check if user is premium\\n' +
      '`/listpremium` \\- List all premium users\\n' +
      '`/users` \\- List all users\\n' +
      '`/restart` \\- Shows the restart confirmation button\\n';
  }
  await ctx.reply(finalHelpText, { parse_mode: 'MarkdownV2' });
});

bot.command('premium', async (ctx) => {
    await ctx.reply(
        '🌟 *Premium Access*\\n\\n' +
        'Premium users get:\\n' +
        '✅ Unlimited story downloads\\n' +
        '✅ No cooldowns or waiting in queues\\n\\n' +
        'Payments and subscriptions are coming soon\\!',
        { parse_mode: 'MarkdownV2' }
    );
});

// --- Admin Commands ---

bot.command('restart', async (ctx) => {
  // FINAL FIX: Compare string to string.
  if (ctx.from.id.toString() !== BOT_ADMIN_ID) return;
  await ctx.reply('Are you sure you want to restart?', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Yes, Restart', callback_data: RESTART_COMMAND }]],
    },
  });
});

bot.command('setpremium', async (ctx) => {
  // FINAL FIX: Compare string to string.
  if (ctx.from.id.toString() !== BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please use /start before using admin commands.');
  // ... your logic
});

bot.command('unsetpremium', async (ctx) => {
  // FINAL FIX: Compare string to string.
  if (ctx.from.id.toString() !== BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please use /start before using admin commands.');
  // ... your logic
});

bot.command('ispremium', async (ctx) => {
  // FINAL FIX: Compare string to string.
  if (ctx.from.id.toString() !== BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please use /start before using admin commands.');
  // ... your logic
});

bot.command('listpremium', async (ctx) => {
  // FINAL FIX: Compare string to string.
  if (ctx.from.id.toString() !== BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please use /start before using admin commands.');
  // ... your logic
});

bot.command('users', async (ctx) => {
  // FINAL FIX: Compare string to string.
  if (ctx.from.id.toString() !== BOT_ADMIN_ID) return;
  if (!isActivated(ctx.from.id)) return ctx.reply('Please type /start first.');
  // ... your logic
});


// --- Handle button presses ---
bot.on('callback_query', async (ctx) => {
  if (!('data' in ctx.callbackQuery)) return;
  const data = ctx.callbackQuery.data;

  // FINAL FIX: Compare string to string.
  if (data === RESTART_COMMAND && ctx.from.id.toString() === BOT_ADMIN_ID) {
    await ctx.answerCbQuery('⏳ Restarting server...');
    process.exit();
  }

  if (data.includes('&')) {
    const isPremium = isUserPremium(String(ctx.from.id));
    if (!isPremium) {
      return ctx.answerCbQuery('This feature requires Premium access.', { show_alert: true });
    }
    const [username, nextStoriesIds] = data.split('&');
    const user = ctx.from;
    const task: UserInfo = {
      chatId: String(user.id),
      link: username,
      linkType: 'username',
      nextStoriesIds: nextStoriesIds ? JSON.parse(nextStoriesIds) : undefined,
      locale: user.language_code || '',
      user: user,
      initTime: Date.now(),
      isPremium: isPremium,
    };
    handleNewTask(task);
    await ctx.answerCbQuery();
  }
});


// --- Handle all other text messages ---
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;

  if (!isActivated(userId)) {
    return ctx.reply('👋 Please type /start to begin using the bot.');
  }

  // FINAL FIX: Compare string to string.
  if (userId.toString() === BOT_ADMIN_ID && text === RESTART_COMMAND) {
    return ctx.reply('Are you sure you want to restart?', {
        reply_markup: { inline_keyboard: [[{ text: 'Yes, Restart', callback_data: RESTART_COMMAND }]] },
    });
  }

  const isStoryLink = text.startsWith('https') || text.startsWith('t.me/');
  const isUsername = text.startsWith('@') || text.startsWith('+');

  if (isUsername || isStoryLink) {
    const isPremium = isUserPremium(String(userId));
    const user = ctx.from;
    const task: UserInfo = {
      chatId: String(ctx.chat.id),
      link: text,
      linkType: isStoryLink ? 'link' : 'username',
      locale: user.language_code || '',
      user: user,
      initTime: Date.now(),
      isPremium: isPremium,
    };
    handleNewTask(task);
    return;
  }

  await ctx.reply('🚫 Invalid input. Send a username like `@durov` or a story link. Type /help for more info.');
});

// =============================
// BOT LAUNCH & QUEUE STARTUP
// =============================
async function startApp() {
  console.log('[App] Initializing...');
  resetStuckJobs();
  await initUserbot();
  console.log('[App] Starting queue processor...');
  processQueue();
  bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log('✅ Telegram bot started successfully and is ready for commands.');
  });
}

startApp();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
