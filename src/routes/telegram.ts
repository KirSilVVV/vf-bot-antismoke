import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env';
import { voiceflowInteract } from '../services/voiceflowRuntime';

const UpdateSchema = z
    .object({
        update_id: z.number().optional(),
        message: z
            .object({
                message_id: z.number().optional(),
                text: z.string().optional(),
                chat: z.object({
                    id: z.number(),
                }),
                from: z
                    .object({
                        id: z.number(),
                        username: z.string().optional(),
                        first_name: z.string().optional(),
                    })
                    .optional(),
            })
            .optional(),
        // Иногда Telegram присылает edited_message — мы его просто игнорируем
        edited_message: z.any().optional(),
    })
    .passthrough();

async function telegramSendMessage(chatId: number, text: string) {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Telegram sendMessage failed: ${res.status} ${res.statusText} - ${body}`);
    }
}

// Небольшой анти-дедуп на случай повторных апдейтов (иногда Telegram/прокси/ретраи)
// Держим в памяти последнее сообщение на чат (достаточно для MVP)
const lastProcessedByChat = new Map<number, { messageId?: number; text?: string; ts: number }>();

function isDuplicate(chatId: number, messageId?: number, text?: string): boolean {
    const now = Date.now();
    const prev = lastProcessedByChat.get(chatId);

    // чистим старьё
    if (prev && now - prev.ts > 60_000) lastProcessedByChat.delete(chatId);

    if (!prev) {
        lastProcessedByChat.set(chatId, { messageId, text, ts: now });
        return false;
    }

    const sameId = messageId != null && prev.messageId === messageId;
    const sameText = text != null && prev.text === text;

    if (sameId || sameText) return true;

    lastProcessedByChat.set(chatId, { messageId, text, ts: now });
    return false;
}

/**
 * Telegram -> наш сервер -> Voiceflow -> Telegram
 */
export async function telegramRoutes(app: FastifyInstance) {
    app.post('/api/telegram/webhook', async (req, reply) => {
        // Telegram важно быстро отдать 200 OK
        reply.send({ ok: true });

        const update = UpdateSchema.parse(req.body ?? {});

        // Игнорируем edited_message (частая причина дублей)
        if (update.edited_message) return;

        const msg = update.message;
        if (!msg?.chat?.id) return;

        const chatId = msg.chat.id;
        const messageId = msg.message_id;
        const text = (msg.text ?? '').trim();

        // отвечаем только на текстовые сообщения
        if (!text) return;

        // анти-дубли
        if (isDuplicate(chatId, messageId, text)) return;

        const userId = String(msg.from?.id ?? chatId);

        try {
            // /start — запускаем флоу в Voiceflow
            if (text === '/start') {
                const vf = await voiceflowInteract({ userId, launch: true });
                const answer = (vf.text ?? '').trim() || 'Привет! Давай начнём 🙂';
                await telegramSendMessage(chatId, answer);
                return;
            }

            // /help — подсказка (можно тоже отправить в VF, но обычно лучше локально)
            if (text === '/help') {
                await telegramSendMessage(
                    chatId,
                    'Команды:\n/start — начать\n/help — помощь\n\nИли просто пиши текстом — я отвечу.'
                );
                return;
            }

            // Обычный текст — идём в Voiceflow
            const vf = await voiceflowInteract({ userId, text });
            const answer = (vf.text ?? '').trim() || 'Ок. Расскажи подробнее, что сейчас происходит?';

            await telegramSendMessage(chatId, answer);
        } catch (e: any) {
            app.log.error({ err: e }, 'Telegram webhook error');
            try {
                await telegramSendMessage(chatId, 'Упс, ошибка на сервере. Попробуй ещё раз через минуту.');
            } catch {
                // молча
            }
        }
    });
}
