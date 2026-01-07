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
                        callback_data: b.payload.slice(0, 64), // Telegram лимит 64 байта
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
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId }),
    }).catch(() => { });
}

export async function telegramRoutes(app: FastifyInstance) {
    app.post('/api/telegram/webhook', async (req, reply) => {
        reply.send({ ok: true });

        const update = UpdateSchema.parse(req.body ?? {});

        // 1) Нажатие на inline-кнопку
        if (update.callback_query?.data && update.callback_query?.message?.chat?.id) {
            const chatId = update.callback_query.message.chat.id;
            const userId = String(update.callback_query.from?.id ?? chatId);
            const payload = update.callback_query.data;

            try {
                // (опционально) “снять часики” у кнопки
                // если хочешь — добавь callback_query_id в схему и дергай answerCallbackQuery
                const vf = await voiceflowInteract({ userId, text: payload });
                await telegramSendMessage(chatId, vf.text, vf.buttons);
            } catch (e: any) {
                app.log.error({ err: e }, 'Telegram callback error');
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
            if (text === '/start') {
                const vf = await voiceflowInteract({ userId, launch: true });
                await telegramSendMessage(chatId, vf.text, vf.buttons);
                return;
            }

            if (text === '/help') {
                await telegramSendMessage(chatId, 'Команды:\n/start — начать\n/help — помощь\n\nИли просто нажимай кнопки 🙂');
                return;
            }

            const vf = await voiceflowInteract({ userId, text });
            await telegramSendMessage(chatId, vf.text, vf.buttons);
        } catch (e: any) {
            app.log.error({ err: e }, 'Telegram webhook error');
            try {
                await telegramSendMessage(chatId, 'Упс, ошибка на сервере. Попробуй ещё раз через минуту.');
            } catch { }
        }
    });
}
