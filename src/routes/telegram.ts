// src/routes/telegram.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env';
import { chatWithAI, clearSession, getApiStats } from '../services/openaiService';
import {
    getOrCreateUser,
    canSendMessage,
    recordMessage,
    activatePremium,
    getUserProgress,
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
        throw new Error(`Telegram API ${method} failed: ${res.status} - ${t}`);
    }
    return res.json();
}

async function sendMessage(chatId: number, text: string, options: any = {}) {
    await telegramApi('sendMessage', {
        chat_id: chatId,
        text: (text ?? '').trim() || '…',
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options,
    });
}

async function sendChatAction(chatId: number) {
    try {
        await telegramApi('sendChatAction', { chat_id: chatId, action: 'typing' });
    } catch {}
}

async function answerCallbackQuery(id: string, text?: string) {
    try {
        await telegramApi('answerCallbackQuery', { callback_query_id: id, text });
    } catch {}
}

/**
 * Send premium subscription invoice
 */
async function sendPremiumInvoice(chatId: number) {
    await telegramApi('sendInvoice', {
        chat_id: chatId,
        title: 'Premium подписка на 30 дней',
        description: 'Безлимитные сообщения, экстренная помощь /sos, трекер прогресса',
        payload: 'premium_30days',
        currency: 'XTR',
        prices: [{ label: 'Premium 30 дней', amount: PRICING.PREMIUM_PRICE_STARS }],
        provider_token: '',
    });
}

/**
 * Show premium benefits and buy button
 */
async function sendPremiumOffer(chatId: number, reason: string) {
    const keyboard = {
        inline_keyboard: [
            [{ text: `Получить Premium — ${PRICING.PREMIUM_PRICE_STARS} ⭐/мес`, callback_data: 'buy_premium' }],
        ],
    };

    await sendMessage(
        chatId,
        `${reason}\n\n` +
            `🌟 <b>Premium подписка</b> даёт:\n\n` +
            `✅ <b>Безлимитные сообщения</b> — общайся сколько нужно\n` +
            `✅ <b>Экстренная помощь /sos</b> — мгновенная поддержка при тяге\n` +
            `✅ <b>Трекер прогресса /progress</b> — дни без сигарет и экономия\n\n` +
            `Всего <b>${PRICING.PREMIUM_PRICE_STARS} ⭐</b> в месяц — дешевле одной пачки сигарет!`,
        { reply_markup: keyboard }
    );
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
    } catch {}
}

export async function telegramRoutes(app: FastifyInstance) {
    app.post('/api/telegram/webhook', async (req, reply) => {
        reply.send({ ok: true });

        const update = UpdateSchema.parse(req.body ?? {});

        if (typeof update.update_id === 'number') {
            if (!markSeen(`u:${update.update_id}`)) return;
        }

        // Handle pre_checkout_query
        if (update.pre_checkout_query) {
            try {
                await telegramApi('answerPreCheckoutQuery', {
                    pre_checkout_query_id: update.pre_checkout_query.id,
                    ok: true,
                });
            } catch (e: any) {
                app.log.error({ err: e }, 'Pre-checkout error');
            }
            return;
        }

        // Handle callback_query
        if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message?.chat?.id;
            if (!chatId) return;

            await answerCallbackQuery(cb.id);

            if (cb.data === 'buy_premium') {
                await sendPremiumInvoice(chatId);
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

        // Handle successful payment
        const payment = (msg as any).successful_payment;
        if (payment) {
            if (payment.invoice_payload === 'premium_30days') {
                const { premiumUntil } = await activatePremium(userId, PRICING.PREMIUM_PRICE_STARS);
                const untilStr = premiumUntil.toLocaleDateString('ru-RU');

                await sendMessage(
                    chatId,
                    `🎉 <b>Добро пожаловать в Premium!</b>\n\n` +
                        `Теперь тебе доступно:\n` +
                        `✅ Безлимитные сообщения с коучем\n` +
                        `✅ Команда /sos для экстренной помощи\n` +
                        `✅ Команда /progress для отслеживания прогресса\n\n` +
                        `Подписка активна до: <b>${untilStr}</b>\n\n` +
                        `Давай вместе дойдём до цели! 💪`
                );

                await sendAdminAlert(
                    `💰 <b>Новая Premium подписка!</b>\n\n` +
                        `User: ${firstName || username || userId}\n` +
                        `Звёзд: ${PRICING.PREMIUM_PRICE_STARS} ⭐`
                );
            }
            return;
        }

        if (!text) return;

        if (typeof msg.message_id === 'number') {
            if (!markSeen(`m:${chatId}:${msg.message_id}`)) return;
        }

        try {
            await getOrCreateUser(userId, username, firstName);
            const status = await canSendMessage(userId);

            // /start
            if (text === '/start') {
                clearSession(userId);
                await sendChatAction(chatId);
                const result = await chatWithAI(userId, 'Привет! Я хочу бросить курить. Расскажи как ты можешь мне помочь?', true);
                await recordMessage(userId);

                const newStatus = await canSendMessage(userId);
                let footer = '';
                if (!newStatus.isPremium) {
                    footer = `\n\n<i>💬 Сегодня: ${newStatus.messagesUsedToday}/${newStatus.dailyLimit} сообщений</i>`;
                }

                await sendMessage(chatId, result.text + footer);
                return;
            }

            // /help
            if (text === '/help') {
                const premiumBadge = status.isPremium ? ' ⭐' : '';
                await sendMessage(
                    chatId,
                    `🚭 <b>Бот-коуч по отказу от курения</b>${premiumBadge}\n\n` +
                        `Я помогу тебе бросить курить раз и навсегда!\n\n` +
                        `<b>Команды:</b>\n` +
                        `/start — начать сначала\n` +
                        `/progress — твой прогресс ${status.isPremium ? '✅' : '🔒'}\n` +
                        `/sos — экстренная помощь при тяге ${status.isPremium ? '✅' : '🔒'}\n` +
                        `/premium — подписка Premium\n` +
                        `/help — эта справка\n\n` +
                        (status.isPremium
                            ? `⭐ <b>Premium активен</b> — безлимитные сообщения`
                            : `💬 Сегодня: <b>${status.messagesUsedToday}/${status.dailyLimit}</b> сообщений\n` +
                              `Лимит обновляется каждый день в полночь`)
                );
                return;
            }

            // /premium
            if (text === '/premium') {
                if (status.isPremium) {
                    const user = await getOrCreateUser(userId);
                    const until = user.premium_until
                        ? new Date(user.premium_until).toLocaleDateString('ru-RU')
                        : '—';
                    await sendMessage(
                        chatId,
                        `⭐ <b>У тебя активен Premium!</b>\n\n` +
                            `Подписка до: <b>${until}</b>\n\n` +
                            `Тебе доступно:\n` +
                            `✅ Безлимитные сообщения\n` +
                            `✅ /sos — экстренная помощь\n` +
                            `✅ /progress — трекер прогресса`
                    );
                } else {
                    await sendPremiumOffer(chatId, '');
                }
                return;
            }

            // /progress (Premium feature)
            if (text === '/progress') {
                if (!status.isPremium) {
                    await sendPremiumOffer(chatId, '🔒 <b>Трекер прогресса</b> — Premium функция');
                    return;
                }

                const progress = await getUserProgress(userId);
                if (!progress || !progress.quitDate) {
                    await sendMessage(
                        chatId,
                        `📊 <b>Твой прогресс</b>\n\n` +
                            `Ты ещё не указал дату отказа от курения.\n\n` +
                            `Напиши мне когда ты бросил (или планируешь бросить), ` +
                            `и я буду отслеживать твой прогресс!`
                    );
                    return;
                }

                const dateStr = progress.quitDate.toLocaleDateString('ru-RU');
                await sendMessage(
                    chatId,
                    `📊 <b>Твой прогресс</b>\n\n` +
                        `📅 Дата отказа: <b>${dateStr}</b>\n` +
                        `🚭 Дней без сигарет: <b>${progress.smokFreeDays}</b>\n` +
                        `🚬 Сигарет не выкурено: <b>${progress.cigarettesAvoided}</b>\n` +
                        `💰 Сэкономлено: <b>${progress.moneySaved} ₽</b>\n\n` +
                        `Так держать! Каждый день — победа! 💪`
                );
                return;
            }

            // /sos (Premium feature)
            if (text === '/sos') {
                if (!status.isPremium) {
                    await sendPremiumOffer(chatId, '🔒 <b>Экстренная помощь /sos</b> — Premium функция');
                    return;
                }

                await sendChatAction(chatId);
                const result = await chatWithAI(
                    userId,
                    'ЭКСТРЕННО! Очень хочу закурить прямо сейчас! Помоги срочно!',
                    false
                );
                await recordMessage(userId);
                await sendMessage(chatId, `🆘 <b>Экстренная помощь</b>\n\n${result.text}`);
                return;
            }

            // /stats (admin)
            if (text === '/stats' && env.ADMIN_CHAT_ID && String(chatId) === env.ADMIN_CHAT_ID) {
                const apiStats = getApiStats();
                const dbStats = await getAdminStats();
                await sendMessage(
                    chatId,
                    `📊 <b>Статистика бота</b>\n\n` +
                        `<b>Пользователи:</b>\n` +
                        `• Всего: ${dbStats.totalUsers}\n` +
                        `• Premium: ${dbStats.premiumUsers}\n` +
                        `• Сообщений: ${dbStats.totalMessages}\n` +
                        `• Заработано: ${dbStats.totalStarsEarned} ⭐\n\n` +
                        `<b>OpenAI:</b>\n` +
                        `• Запросов: ${apiStats.apiCallsCount}\n` +
                        `• Токенов: ${apiStats.totalTokensUsed.toLocaleString()}`
                );
                return;
            }

            // Regular message - check limits
            if (!status.canSend) {
                await sendPremiumOffer(
                    chatId,
                    `⏰ <b>Дневной лимит исчерпан</b>\n\n` +
                        `Ты использовал все ${PRICING.FREE_DAILY_LIMIT} бесплатных сообщений на сегодня.\n` +
                        `Лимит обновится завтра в полночь.\n\n` +
                        `Или получи безлимит прямо сейчас:`
                );
                return;
            }

            // Process with AI
            await sendChatAction(chatId);
            const result = await chatWithAI(userId, text);
            const msgStatus = await recordMessage(userId);

            let response = result.text;

            // Add footer for free users
            if (!msgStatus.isPremium) {
                if (msgStatus.remainingToday === 0) {
                    response += `\n\n<i>💬 Это последнее сообщение на сегодня</i>`;
                } else if (msgStatus.remainingToday <= 2) {
                    response += `\n\n<i>💬 Осталось на сегодня: ${msgStatus.remainingToday}</i>`;
                }
            }

            await sendMessage(chatId, response);

            // Offer premium when running low
            if (!msgStatus.isPremium && msgStatus.remainingToday === 0) {
                setTimeout(async () => {
                    await sendPremiumOffer(
                        chatId,
                        `💡 Хочешь продолжить разговор прямо сейчас?`
                    );
                }, 3000);
            }

        } catch (e: any) {
            app.log.error({ err: e }, 'Webhook error');
            await sendAdminAlert(`❌ <b>Ошибка</b>\n\nUser: ${userId}\nError: ${e.message}`);
            try {
                await sendMessage(chatId, 'Упс, ошибка. Попробуй ещё раз через минуту.');
            } catch {}
        }
    });
}
