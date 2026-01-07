// src/routes/telegram.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env';
import { voiceflowInteract, type VFButton } from '../services/voiceflowRuntime';

const UpdateSchema = z
    .object({
        message: z
            .object({
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
                id: z.string().optional(), // чтобы “снимать часики” у кнопки
                data: z.string().optional(),
                message: z
                    .object({
                        chat: z.object({ id: z.number() }),
                    })
                    .optional(),
                from: z.object({ id: z.number() }).optional(),
            })
            .optional(),
    })
    .passthrough();

async function telegramSendMessage(chatId: number, text: string, buttons?: VFButton[]) {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

    const reply_markup =
        buttons && buttons.length
            ? {
                inline_keyboard: buttons.map((b) => [
                    {
                        text: b.title,
                        // Telegram лимит 64 байта на callback_data
                        callback_data: String(b.payload ?? '').slice(0, 64),
                    },
                ]),
            }
            : undefined;

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
            reply_markup,
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Telegram sendMessage failed: ${res.status} ${res.statusText} - ${body}`);
    }
}

async function telegramAnswerCallbackQuery(callbackQueryId: string) {
    if (!callbackQueryId) return;
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;

    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId }),
    }).catch(() => { });
}

function buildReply(vf: { text?: string; buttons?: VFButton[] }) {
    const text = (vf.text ?? '').trim();
    const buttons = Array.isArray(vf.buttons) ? vf.buttons : [];

    // Если VF вернул только кнопки — в телеге надо что-то показать текстом
    if (!text && buttons.length) return { text: 'Выбери вариант:', buttons };

    // Если вообще пусто — это уже проблема VF/парсинга
    if (!text && !buttons.length) return { text: 'Не получил ответ от Voiceflow. Нажми /start ещё раз 🙂', buttons: [] };

    return { text, buttons };
}

export async function telegramRoutes(app: FastifyInstance) {
    app.post('/api/telegram/webhook', async (req, reply) => {
        // Telegram важно быстро отдать 200 OK
        reply.send({ ok: true });

        const update = UpdateSchema.parse(req.body ?? {});

        // 1) Нажатие на inline-кнопку
        if (update.callback_query?.data && update.callback_query?.message?.chat?.id) {
            const chatId = update.callback_query.message.chat.id;
            const userId = String(update.callback_query.from?.id ?? chatId);
            const payload = update.callback_query.data;
            const callbackId = update.callback_query.id ?? '';

            // “снять часики” у кнопки
            await telegramAnswerCallbackQuery(callbackId);

            try {
                const vf = await voiceflowInteract({ userId, text: payload });
                const out = buildReply(vf);
                await telegramSendMessage(chatId, out.text, out.buttons);
            } catch (e: any) {
                app.log.error({ err: e }, 'Telegram callback error');
                try {
                    await telegramSendMessage(chatId, 'Упс, ошибка на сервере. Попробуй ещё раз через минуту.');
                } catch { }
            }
            return;
        }

        // 2) Обычное сообщение
        const msg = update.message;
        if (!msg?.chat?.id) return;

        const chatId = msg.chat.id;
        const userId = String(msg.from?.id ?? chatId);
        const text = (msg.text ?? '').trim();
        if (!text) return;

        try {
            // /start — ОБЯЗАТЕЛЬНО запускаем флоу (launch)
            if (text === '/start') {
                const vf = await voiceflowInteract({ userId, launch: true });
                const out = buildReply(vf);
                await telegramSendMessage(chatId, out.text, out.buttons);
                return;
            }

            if (text === '/help') {
                await telegramSendMessage(chatId, 'Команды:\n/start — начать\n/help — помощь\n\nИли просто нажимай кнопки 🙂');
                return;
            }

            const vf = await voiceflowInteract({ userId, text });
            const out = buildReply(vf);
            await telegramSendMessage(chatId, out.text, out.buttons);
        } catch (e: any) {
            app.log.error({ err: e }, 'Telegram webhook error');
            try {
                await telegramSendMessage(chatId, 'Упс, ошибка на сервере. Попробуй ещё раз через минуту.');
            } catch { }
        }
    });
}
