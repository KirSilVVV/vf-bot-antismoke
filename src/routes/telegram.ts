// src/routes/telegram.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env';
import { voiceflowInteract, type VFButton } from '../services/voiceflowRuntime';

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
                id: z.string().optional(), // callback_query_id
                data: z.string().optional(), // callback_data
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
 * Храним ключи 5 минут, чтобы не обрабатывать один и тот же апдейт/сообщение/клик повторно.
 */
const seen = new Map<string, number>();
const SEEN_TTL_MS = 5 * 60 * 1000;

function markSeen(key: string) {
    const now = Date.now();

    // лёгкая уборка иногда
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
 * Callback payload store:
 * Telegram callback_data ограничен 64 байтами.
 * Если VF отдаёт длинный payload (часто так и бывает), мы кладём его в Map и в callback_data шлём короткий token.
 */
const cbStore = new Map<string, { payload: string; exp: number }>();
const CB_TTL_MS = 10 * 60 * 1000;

function makeToken() {
    // достаточно короткий токен под Telegram 64 bytes
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function putCallbackPayload(payload: string) {
    const token = makeToken();
    cbStore.set(token, { payload, exp: Date.now() + CB_TTL_MS });

    // периодическая уборка
    if (cbStore.size > 5000) {
        const now = Date.now();
        for (const [k, v] of cbStore) if (v.exp < now) cbStore.delete(k);
    }

    return token;
}

function getCallbackPayload(tokenOrPayload: string) {
    const v = cbStore.get(tokenOrPayload);
    if (!v) return tokenOrPayload; // если это не токен — значит там уже payload (или токен истёк)
    if (v.exp < Date.now()) {
        cbStore.delete(tokenOrPayload);
        return tokenOrPayload;
    }
    return v.payload;
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
}

async function telegramSendMessage(chatId: number, text: string, buttons?: VFButton[]) {
    const safeText = (text ?? '').toString().trim() || '…';

    const reply_markup =
        buttons && buttons.length
            ? {
                inline_keyboard: buttons.map((b) => {
                    // если payload длинный — превращаем в token
                    const payload = String(b.payload ?? '').trim() || String(b.title ?? '').trim();
                    const callback_data =
                        Buffer.byteLength(payload, 'utf8') <= 60 ? payload : putCallbackPayload(payload);

                    return [
                        {
                            text: b.title,
                            callback_data,
                        },
                    ];
                }),
            }
            : undefined;

    await telegramApi('sendMessage', {
        chat_id: chatId,
        text: safeText,
        disable_web_page_preview: true,
        reply_markup,
    });
}

async function telegramAnswerCallbackQuery(callbackQueryId?: string) {
    if (!callbackQueryId) return;
    try {
        await telegramApi('answerCallbackQuery', { callback_query_id: callbackQueryId });
    } catch {
        // игнорим — это только UX, на логику не влияет
    }
}

function buildReply(vf: { text?: string; buttons?: VFButton[] }) {
    const text = (vf.text ?? '').trim();
    const buttons = Array.isArray(vf.buttons) ? vf.buttons : [];
    if (!text && buttons.length) return { text: 'Выбери вариант:', buttons };
    if (!text && !buttons.length) return { text: '…', buttons: [] };
    return { text, buttons };
}

export async function telegramRoutes(app: FastifyInstance) {
    app.post('/api/telegram/webhook', async (req, reply) => {
        // Важно: ответить Telegram сразу, иначе он ретраит вебхук и получаются дубли
        reply.send({ ok: true });

        const update = UpdateSchema.parse(req.body ?? {});

        // 0) Anti-replay на update_id (главный предохранитель от повторов)
        if (typeof update.update_id === 'number') {
            if (!markSeen(`u:${update.update_id}`)) return;
        }

        // 1) Нажатие на inline-кнопку
        if (update.callback_query?.data && update.callback_query?.message?.chat?.id) {
            const chatId = update.callback_query.message.chat.id;
            const userId = String(update.callback_query.from?.id ?? chatId);
            const callbackId = update.callback_query.id;

            // отдельный anti-replay на callback id
            if (callbackId && !markSeen(`c:${callbackId}`)) return;

            // “снять часики” у Telegram кнопки
            await telegramAnswerCallbackQuery(callbackId);

            const tokenOrPayload = update.callback_query.data;
            const payload = getCallbackPayload(tokenOrPayload); // <-- вот это обычно и чинит "Sorry, I didn’t get that"
            app.log.info({ tokenOrPayload, payload }, '[CALLBACK] Button clicked');
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

        // anti-replay на message_id (доп. страховка)
        if (typeof msg.message_id === 'number') {
            if (!markSeen(`m:${chatId}:${msg.message_id}`)) return;
        }

        try {
            // /start — запускаем флоу (как ты хотел)
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
