// src/routes/telegram.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env';
import { chatWithAI, clearSession, getApiStats } from '../services/openaiService';

/**
 * Telegram Update schema (message + callback_query)
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
                id: z.string().optional(),
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
    })
    .passthrough();

/**
 * Anti-replay cache (in-memory)
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

async function telegramSendMessage(chatId: number, text: string) {
    const safeText = (text ?? '').toString().trim() || '…';

    await telegramApi('sendMessage', {
        chat_id: chatId,
        text: safeText,
        disable_web_page_preview: true,
    });
}

async function telegramSendChatAction(chatId: number, action: string = 'typing') {
    try {
        await telegramApi('sendChatAction', {
            chat_id: chatId,
            action: action,
        });
    } catch {
        // игнорим — это только UX
    }
}

/**
 * Send alert to admin about API usage
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
 * Check API usage and send alert if needed
 */
async function checkAndAlertApiUsage(tokensUsed: number) {
    const stats = getApiStats();

    // Алерт каждые 1000 запросов
    if (stats.apiCallsCount % 100 === 0) {
        await sendAdminAlert(
            `📊 <b>Статистика API (antismoke)</b>\n\n` +
            `Запросов: <b>${stats.apiCallsCount}</b>\n` +
            `Токенов использовано: <b>${stats.totalTokensUsed.toLocaleString()}</b>\n` +
            `Последний запрос: ${tokensUsed} токенов`
        );
    }
}

export async function telegramRoutes(app: FastifyInstance) {
    app.post('/api/telegram/webhook', async (req, reply) => {
        // Ответить Telegram сразу
        reply.send({ ok: true });

        const update = UpdateSchema.parse(req.body ?? {});

        // Anti-replay на update_id
        if (typeof update.update_id === 'number') {
            if (!markSeen(`u:${update.update_id}`)) return;
        }

        // Обычное сообщение
        const msg = update.message;
        if (!msg?.chat?.id) return;

        const chatId = msg.chat.id;
        const userId = String(msg.from?.id ?? chatId);
        const text = (msg.text ?? '').trim();
        if (!text) return;

        // anti-replay на message_id
        if (typeof msg.message_id === 'number') {
            if (!markSeen(`m:${chatId}:${msg.message_id}`)) return;
        }

        try {
            // /start — приветствие
            if (text === '/start') {
                clearSession(userId);
                await telegramSendChatAction(chatId);
                const result = await chatWithAI(userId, 'Привет! Я хочу бросить курить.', true);
                await telegramSendMessage(chatId, result.text);
                await checkAndAlertApiUsage(result.tokensUsed);
                return;
            }

            // /help — справка
            if (text === '/help') {
                await telegramSendMessage(
                    chatId,
                    '🚭 <b>Бот-коуч по отказу от курения</b>\n\n' +
                    'Я помогу тебе:\n' +
                    '• Составить план отказа от сигарет\n' +
                    '• Справиться с тягой к курению\n' +
                    '• Не сорваться в сложные моменты\n' +
                    '• Отслеживать прогресс\n\n' +
                    'Просто пиши мне о своих ощущениях, задавай вопросы или проси совета.\n\n' +
                    '<b>Команды:</b>\n' +
                    '/start — начать сначала\n' +
                    '/help — эта справка'
                );
                return;
            }

            // /stats — статистика API (только для админа)
            if (text === '/stats' && env.ADMIN_CHAT_ID && String(chatId) === env.ADMIN_CHAT_ID) {
                const stats = getApiStats();
                await telegramSendMessage(
                    chatId,
                    `📊 <b>Статистика API</b>\n\n` +
                    `Запросов: ${stats.apiCallsCount}\n` +
                    `Токенов: ${stats.totalTokensUsed.toLocaleString()}`
                );
                return;
            }

            // Обычное сообщение — передать в OpenAI
            await telegramSendChatAction(chatId);
            const result = await chatWithAI(userId, text);
            await telegramSendMessage(chatId, result.text);
            await checkAndAlertApiUsage(result.tokensUsed);

        } catch (e: any) {
            app.log.error({ err: e }, 'Telegram webhook error');

            // Отправить алерт админу об ошибке
            await sendAdminAlert(
                `❌ <b>Ошибка в боте antismoke</b>\n\n` +
                `User: ${userId}\n` +
                `Error: ${e.message}`
            );

            try {
                await telegramSendMessage(chatId, 'Упс, ошибка на сервере. Попробуй ещё раз через минуту.');
            } catch { }
        }
    });
}
