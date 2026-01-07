// src/services/voiceflowRuntime.ts
import { env } from '../config/env';

type VFChoiceButton = {
    name?: string;
    request?: {
        payload?: any; // иногда не строка
    };
};

type VFMessage =
    | { type: 'text'; payload?: { message?: string } }
    | { type: 'speak'; payload?: { message?: string } }
    | { type: 'choice'; payload?: { buttons?: VFChoiceButton[] } }
    | { type: 'buttons'; payload?: { buttons?: VFChoiceButton[] } }
    | { type: string; payload?: any };

type VoiceflowRuntimeResponseItem = {
    type?: string;
    text?: string; // иногда VF кладёт текст сюда
    messages?: VFMessage[];
    payload?: any;
};

export type VFButton = {
    title: string;
    payload: string; // что отправляем обратно в VF при клике
};

export type VFResult = {
    text: string;
    buttons: VFButton[];
};

function normalizeText(s: string) {
    return s.replace(/\r\n/g, '\n').trim();
}

function pushUniqueText(out: string[], seen: Set<string>, value?: string) {
    if (!value) return;
    const t = normalizeText(String(value));
    if (!t) return;
    const key = t.replace(/[ \t]+/g, ' ');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
}

function payloadToString(payload: any, fallback: string) {
    if (payload == null) return fallback;
    if (typeof payload === 'string') return payload;
    if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload);

    // иногда VF кладёт объект — чтобы не ломаться, сериализуем
    try {
        return JSON.stringify(payload);
    } catch {
        return fallback;
    }
}

export async function voiceflowInteract(params: {
    userId: string;
    text?: string;
    launch?: boolean;
}): Promise<VFResult> {
    const { userId, text, launch } = params;

    const action = launch
        ? ({ type: 'launch' } as const)
        : ({ type: 'text', payload: text ?? '' } as const);

    const res = await fetch(
        `https://general-runtime.voiceflow.com/state/${env.VOICEFLOW_VERSION_ID}/user/${userId}/interact`,
        {
            method: 'POST',
            headers: {
                Authorization: env.VOICEFLOW_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ action }),
        }
    );

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Voiceflow runtime error: ${res.status} ${res.statusText} - ${errText}`);
    }

    const data = (await res.json()) as VoiceflowRuntimeResponseItem[];

    const texts: string[] = [];
    const seenTexts = new Set<string>();
    const buttons: VFButton[] = [];

    for (const item of data) {
        // ✅ ВАЖНО: VF часто кладёт текст прямо в item.text
        pushUniqueText(texts, seenTexts, item.text);

        const msgs = item.messages ?? [];
        for (const msg of msgs) {
            // ✅ текстовые сообщения VF могут быть text или speak
            if ((msg.type === 'text' || msg.type === 'speak') && msg.payload?.message) {
                pushUniqueText(texts, seenTexts, msg.payload.message);
            }

            // ✅ кнопки/choice
            if ((msg.type === 'choice' || msg.type === 'buttons') && Array.isArray(msg.payload?.buttons)) {
                for (const b of msg.payload!.buttons!) {
                    const title = (b.name ?? '').trim();
                    if (!title) continue;

                    const payloadRaw = b.request?.payload;
                    const payload = payloadToString(payloadRaw, title).trim() || title;

                    buttons.push({ title, payload });
                }
            }
        }
    }

    const mergedText = texts.join('\n\n').trim();

    // Если текста нет, но есть кнопки — подскажем пользователю
    if (!mergedText && buttons.length) {
        return { text: 'Выбери вариант:', buttons };
    }

    // Если нет вообще ничего — значит VF прислал не то, что мы ожидаем (или flow пустой на launch)
    // Но вместо "…" лучше явно показать проблему (и чтобы ты увидел, что это не "сломалось", а пусто).
    if (!mergedText && !buttons.length) {
        return { text: '…', buttons: [] };
    }

    return {
        text: mergedText,
        buttons,
    };
} 