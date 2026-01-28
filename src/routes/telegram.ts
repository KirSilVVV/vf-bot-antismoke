// src/routes/telegram.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env';
import { chatWithAI, clearSession, getApiStats } from '../services/openaiService';
import {
    getOrCreateUser,
    hasMessagesRemaining,
    getMessagesRemaining,
    consumeMessage,
    addMessages,
    getAdminStats,
    PRICING,
} from '../services/supabaseService';

/**
 * Telegram Update schema
 */
const UpdateSchema = z
    .object({
        update_id: z.number().optional(),

        message: z
            .object({
                message_id: z.number().optional(),
                text: z.string().optional(),
                chat: z.object({ id: z.number() }),
                from: z
                    .object({
                        id: z.number(),
                        username: z.string().optional(),
                        first_name: z.string().optional(),
                    })
                    .optional(),
            })
            .optional(),

        callback_query: z
            .object({
                id: z.string(),
                data: z.string().optional(),
                message: z
                    .object({
                        message_id: z.number().optional(),
                        chat: z.object({ id: z.number() }),
                    })
                    .optional(),
                from: z.object({ id: z.number() }).optional(),
            })
            .optional(),

        pre_checkout_query: z
            .object({
                id: z.string(),
                from: z.object({ id: z.number() }),
                currency: z.string(),
                total_amount: z.number(),
                invoice_payload: z.string(),
            })
            .optional(),

        successful_payment: z.any().optional(),
    })
    .passthrough();

/**
 * Anti-replay cache
 */
const seen = new Map<string, number>();
const SEEN_TTL_MS = 5 * 60 * 1000;

function markSeen(key: string) {
    const now = Date.now();

    if (seen.size > 5000) {
        for (const [k, ts] of seen) {
            if (now - ts > SEEN_TTL_MS) seen.delete(k);
        }
    }

    const prev = seen.get(key);
    if (prev && now - prev < SEEN_TTL_MS) return false;

    seen.set(key, now);
    return true;
}

/**
 * Telegram API helpers
 */
async function telegramApi(method: string, body: any) {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`Telegram API ${method} failed: ${res.status} ${res.statusText} - ${t}`);
    }

    return res.json();
}

async function sendMessage(chatId: number, text: string, options: any = {}) {
    const safeText = (text ?? '').toString().trim() || '…';

    await telegramApi('sendMessage', {
        chat_id: chatId,
        text: safeText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options,
    });
}

async function sendChatAction(chatId: number, action: string = 'typing') {
    try {
        await telegramApi('sendChatAction', { chat_id: chatId, action });
    } catch {
        // ignore
    }
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
    try {
        await telegramApi('answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            text: text,
        });
    } catch {
        // ignore
    }
}

async function sendInvoice(chatId: number, packageId: string) {
    const pkg = PRICING.PACKAGES.find((p) => p.id === packageId);
    if (!pkg) return;

    await telegramApi('sendInvoice', {
        chat_id: chatId,
        title: `${pkg.label} с коучем`,
        description: `Пакет "${pkg.label}" для общения с персональным ИИ-коучем по отказу от курения`,
        payload: `package_${pkg.id}`,
        currency: 'XTR',
        prices: [{ label: pkg.label, amount: pkg.stars }],
        provider_token: '', // Empty for Telegram Stars
    });
}

/**
 * Send payment options keyboard
 */
async function sendPaymentOptions(chatId: number, messagesRemaining: number) {
    const keyboard = {
        inline_keyboard: PRICING.PACKAGES.map((pkg) => [
            {
                text: `${pkg.label} — ${pkg.stars} ⭐`,
                callback_data: `buy_${pkg.id}`,
            },
        ]),
    };

    const text =
        messagesRemaining === 0
            ? `🚭 Твои бесплатные сообщения закончились.\n\n` +
              `Но это только начало твоего пути к свободе от сигарет! ` +
              `Продолжим вместе?\n\n` +
              `<b>Выбери пакет сообщений:</b>`
            : `💬 У тебя осталось <b>${messagesRemaining}</b> сообщений.\n\n` +
              `<b>Пополнить баланс:</b>`;

    await sendMessage(chatId, text, { reply_markup: keyboard });
}

/**
 * Admin alert
 */
async function sendAdminAlert(message: string) {
    if (!env.ADMIN_CHAT_ID) return;

    try {
        await telegramApi('sendMessage', {
            chat_id: env.ADMIN_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
        });
    } catch (error) {
        console.error('[Admin Alert] Failed to send:', error);
    }
}

/**
 * Check API usage and send alert
 */
async function checkAndAlertApiUsage(tokensUsed: number) {
    const stats = getApiStats();

    if (stats.apiCallsCount % 100 === 0) {
        const dbStats = await getAdminStats();
        await sendAdminAlert(
            `📊 <b>Статистика бота antismoke</b>\n\n` +
                `<b>OpenAI:</b>\n` +
                `• Запросов: ${stats.apiCallsCount}\n` +
                `• Токенов: ${stats.totalTokensUsed.toLocaleString()}\n\n` +
                `<b>Пользователи:</b>\n` +
                `• Всего: ${dbStats.totalUsers}\n` +
                `• Куплено сообщений: ${dbStats.totalMessagesBought}\n` +
                `• Заработано звёзд: ${dbStats.totalStarsEarned} ⭐`
        );
    }
}

export async function telegramRoutes(app: FastifyInstance) {
    app.post('/api/telegram/webhook', async (req, reply) => {
        reply.send({ ok: true });

        const update = UpdateSchema.parse(req.body ?? {});

        // Anti-replay
        if (typeof update.update_id === 'number') {
            if (!markSeen(`u:${update.update_id}`)) return;
        }

        // Handle pre_checkout_query (payment confirmation)
        if (update.pre_checkout_query) {
            const query = update.pre_checkout_query;
            try {
                await telegramApi('answerPreCheckoutQuery', {
                    pre_checkout_query_id: query.id,
                    ok: true,
                });
            } catch (e: any) {
                app.log.error({ err: e }, 'Pre-checkout query error');
            }
            return;
        }

        // Handle callback_query (button clicks)
        if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message?.chat?.id;
            const data = cb.data;

            if (!chatId || !data) return;

            await answerCallbackQuery(cb.id);

            // Handle buy button
            if (data.startsWith('buy_')) {
                const packageId = data.replace('buy_', '');
                await sendInvoice(chatId, packageId);
            }

            return;
        }

        // Handle message
        const msg = update.message;
        if (!msg?.chat?.id) return;

        const chatId = msg.chat.id;
        const userId = String(msg.from?.id ?? chatId);
        const username = msg.from?.username;
        const firstName = msg.from?.first_name;
        const text = (msg.text ?? '').trim();

        // Handle successful payment (comes as a message)
        const payment = (msg as any).successful_payment;
        if (payment) {
            const payload = payment.invoice_payload as string;
            const packageId = payload.replace('package_', '');
            const pkg = PRICING.PACKAGES.find((p) => p.id === packageId);

            if (pkg) {
                const newBalance = await addMessages(userId, pkg.messages, pkg.stars);

                await sendMessage(
                    chatId,
                    `✅ Оплата прошла успешно!\n\n` +
                        `Тебе начислено <b>${pkg.messages} сообщений</b>.\n` +
                        `Текущий баланс: <b>${newBalance}</b> сообщений.\n\n` +
                        `Продолжаем путь к свободе от сигарет! 💪`
                );

                await sendAdminAlert(
                    `💰 <b>Новая оплата antismoke!</b>\n\n` +
                        `User: ${firstName || username || userId}\n` +
                        `Пакет: ${pkg.label}\n` +
                        `Звёзд: ${pkg.stars} ⭐`
                );
            }
            return;
        }

        if (!text) return;

        // Anti-replay on message_id
        if (typeof msg.message_id === 'number') {
            if (!markSeen(`m:${chatId}:${msg.message_id}`)) return;
        }

        try {
            // Ensure user exists
            await getOrCreateUser(userId, username, firstName);

            // /start
            if (text === '/start') {
                clearSession(userId);
                const remaining = await getMessagesRemaining(userId);

                await sendChatAction(chatId);
                const result = await chatWithAI(userId, 'Привет! Расскажи как ты можешь помочь мне бросить курить?', true);

                if (remaining > 0) {
                    await consumeMessage(userId);
                }

                const newRemaining = await getMessagesRemaining(userId);
                await sendMessage(
                    chatId,
                    result.text + `\n\n<i>💬 Осталось сообщений: ${newRemaining}</i>`
                );

                await checkAndAlertApiUsage(result.tokensUsed);
                return;
            }

            // /help
            if (text === '/help') {
                const remaining = await getMessagesRemaining(userId);
                await sendMessage(
                    chatId,
                    `🚭 <b>Бот-коуч по отказу от курения</b>\n\n` +
                        `Я — твой персональный ИИ-коуч, который поможет:\n` +
                        `• Составить план отказа от сигарет\n` +
                        `• Справиться с тягой в сложные моменты\n` +
                        `• Не сорваться и дойти до цели\n` +
                        `• Отслеживать прогресс и праздновать победы\n\n` +
                        `<b>Команды:</b>\n` +
                        `/start — начать сначала\n` +
                        `/balance — проверить баланс сообщений\n` +
                        `/buy — купить сообщения\n` +
                        `/help — эта справка\n\n` +
                        `💬 У тебя <b>${remaining}</b> сообщений`
                );
                return;
            }

            // /balance
            if (text === '/balance') {
                const remaining = await getMessagesRemaining(userId);
                await sendPaymentOptions(chatId, remaining);
                return;
            }

            // /buy
            if (text === '/buy') {
                const remaining = await getMessagesRemaining(userId);
                await sendPaymentOptions(chatId, remaining);
                return;
            }

            // /stats (admin only)
            if (text === '/stats' && env.ADMIN_CHAT_ID && String(chatId) === env.ADMIN_CHAT_ID) {
                const apiStats = getApiStats();
                const dbStats = await getAdminStats();
                await sendMessage(
                    chatId,
                    `📊 <b>Статистика бота</b>\n\n` +
                        `<b>OpenAI:</b>\n` +
                        `• Запросов: ${apiStats.apiCallsCount}\n` +
                        `• Токенов: ${apiStats.totalTokensUsed.toLocaleString()}\n\n` +
                        `<b>Пользователи:</b>\n` +
                        `• Всего: ${dbStats.totalUsers}\n` +
                        `• Куплено сообщений: ${dbStats.totalMessagesBought}\n` +
                        `• Заработано звёзд: ${dbStats.totalStarsEarned} ⭐`
                );
                return;
            }

            // Check if user has messages
            const hasMessages = await hasMessagesRemaining(userId);

            if (!hasMessages) {
                await sendPaymentOptions(chatId, 0);
                return;
            }

            // Process message with AI
            await sendChatAction(chatId);
            const result = await chatWithAI(userId, text);

            // Consume message credit
            const remaining = await consumeMessage(userId);

            // Send response with remaining count
            let response = result.text;
            if (remaining <= 3 && remaining > 0) {
                response += `\n\n<i>⚠️ Осталось сообщений: ${remaining}</i>`;
            } else if (remaining === 0) {
                response += `\n\n<i>💬 Это было последнее бесплатное сообщение</i>`;
            }

            await sendMessage(chatId, response);
            await checkAndAlertApiUsage(result.tokensUsed);

            // If messages are running low, suggest buying
            if (remaining === 0) {
                setTimeout(async () => {
                    await sendPaymentOptions(chatId, 0);
                }, 2000);
            }
        } catch (e: any) {
            app.log.error({ err: e }, 'Telegram webhook error');

            await sendAdminAlert(
                `❌ <b>Ошибка в боте antismoke</b>\n\n` +
                    `User: ${userId}\n` +
                    `Error: ${e.message}`
            );

            try {
                await sendMessage(chatId, 'Упс, ошибка на сервере. Попробуй ещё раз через минуту.');
            } catch {}
        }
    });
}
