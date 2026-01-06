import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env';
import { voiceflowInteract } from '../services/voiceflowRuntime';

const UpdateSchema = z
    .object({
        update_id: z.number().optional(),
        message: z
            .object({
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

/**
 * Telegram -> наш сервер -> Voiceflow -> Telegram
 */
export async function telegramRoutes(app: FastifyInstance) {
    app.post('/api/telegram/webhook', async (req, reply) => {
        // Telegram важно быстро отдать 200 OK
        reply.send({ ok: true });

        const update = UpdateSchema.parse(req.body ?? {});
        const msg = update.message;

        if (!msg?.chat?.id) return;

        const chatId = msg.chat.id;
        const userId = String(msg.from?.id ?? chatId);
        const text = (msg.text ?? '').trim();

        if (!text) return;

        try {
            // /start — запускаем Voiceflow флоу через launch
            if (text === '/start') {
                const vf = await voiceflowInteract({ userId, launch: true });

                const answer =
                    (vf.text ?? '').trim() ||
                    'Привет! Сколько времени ты не куришь? (например: 3 дня / 2 недели / 1 месяц)';

                await telegramSendMessage(chatId, answer);
                return;
            }

            // /help — подсказка
            if (text === '/help') {
                await telegramSendMessage(
                    chatId,
                    'Команды:\n/start — начать\n/help — помощь\n\nИли просто пиши обычным текстом — я отвечу.'
                );
                return;
            }

            // Основной сценарий: отправляем текст в Voiceflow
            const vf = await voiceflowInteract({ userId, text });

            // Если Voiceflow вернул пусто — подстрахуемся
            const answer = (vf.text ?? '').trim() || 'Ок. Сколько времени ты не куришь?';

            await telegramSendMessage(chatId, answer);
        } catch (e: any) {
            app.log.error({ err: e }, 'Telegram webhook error');

            try {
                await telegramSendMessage(chatId, 'Упс, ошибка на сервере. Попробуй ещё раз через минуту.');
            } catch {
                // если даже sendMessage упал — молча, чтобы не зациклиться
            }
        }
    });
}
