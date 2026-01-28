// src/services/openaiService.ts
import OpenAI from 'openai';
import { env } from '../config/env';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `Ты - заботливый ИИ-коуч по отказу от курения. Твоя задача - помочь человеку бросить курить, поддерживать его мотивацию и давать практичные советы.

🎯 ТВОИ ЦЕЛИ:
- Поддержать человека в решении бросить курить
- Помочь справиться с тягой к сигаретам
- Дать практичные техники и советы
- Отслеживать прогресс и праздновать победы
- Быть эмпатичным и не осуждать

📋 КАК РАБОТАТЬ:
1. При первом контакте - узнай статус курения (курит, бросает, бросил)
2. Если курит - узнай мотивацию бросить и помоги составить план
3. Если бросает - поддержи, дай техники борьбы с тягой
4. Если бросил - поздравь, помоги не сорваться

💡 ТЕХНИКИ ПРОТИВ ТЯГИ:
- Правило 4Д: Дыши, Двигайся, Делай что-то, Думай о причинах
- Отвлечение: жвачка, вода, короткая прогулка
- Напоминание о причинах бросить
- Подсчёт сэкономленных денег и дней без сигарет

⚠️ ПРАВИЛА:
- Отвечай кратко (2-4 предложения)
- Будь позитивным и поддерживающим
- Не осуждай за срывы - помоги начать снова
- Если человек в кризисе - предложи конкретное действие прямо сейчас
- Используй эмодзи умеренно

🚫 НЕЛЬЗЯ:
- Давать медицинские назначения
- Рекомендовать конкретные лекарства
- Осуждать или стыдить за курение`;

// Хранилище сессий пользователей
const userSessions = new Map<string, { messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>; lastActivity: number }>();

// Очистка старых сессий (старше 24 часов)
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function cleanOldSessions() {
    const now = Date.now();
    for (const [userId, session] of userSessions) {
        if (now - session.lastActivity > SESSION_TTL_MS) {
            userSessions.delete(userId);
        }
    }
}

// Счётчик использования API для алертов
let apiCallsCount = 0;
let totalTokensUsed = 0;

export function getApiStats() {
    return { apiCallsCount, totalTokensUsed };
}

export function resetApiStats() {
    apiCallsCount = 0;
    totalTokensUsed = 0;
}

export type ChatResult = {
    text: string;
    tokensUsed: number;
};

export async function chatWithAI(userId: string, userMessage: string, isStart: boolean = false): Promise<ChatResult> {
    // Очистка старых сессий иногда
    if (userSessions.size > 1000) {
        cleanOldSessions();
    }

    // Получить или создать сессию
    let session = userSessions.get(userId);

    if (!session || isStart) {
        session = {
            messages: [],
            lastActivity: Date.now()
        };
        userSessions.set(userId, session);
    }

    session.lastActivity = Date.now();

    // Добавить сообщение пользователя
    session.messages.push({ role: 'user', content: userMessage });

    // Ограничить историю последними 20 сообщениями
    if (session.messages.length > 20) {
        session.messages = session.messages.slice(-20);
    }

    // Подготовить сообщения для API
    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...session.messages
    ];

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: messages,
            temperature: 0.7,
            max_tokens: 300,
        });

        const aiReply = response.choices[0]?.message?.content || 'Извини, не смог ответить. Попробуй ещё раз.';
        const tokensUsed = response.usage?.total_tokens || 0;

        // Обновить статистику
        apiCallsCount++;
        totalTokensUsed += tokensUsed;

        // Добавить ответ в историю
        session.messages.push({ role: 'assistant', content: aiReply });

        console.log(`[OpenAI] User ${userId}: ${userMessage.substring(0, 50)}... -> ${aiReply.substring(0, 50)}... (${tokensUsed} tokens)`);

        return { text: aiReply, tokensUsed };
    } catch (error: any) {
        console.error('[OpenAI] Error:', error.message);

        // Если ошибка квоты - вернуть специальное сообщение
        if (error.code === 'insufficient_quota' || error.status === 429) {
            return {
                text: '⚠️ Извини, сервис временно недоступен. Попробуй позже.',
                tokensUsed: 0
            };
        }

        throw error;
    }
}

export function clearSession(userId: string) {
    userSessions.delete(userId);
}
