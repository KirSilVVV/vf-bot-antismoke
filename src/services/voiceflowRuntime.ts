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

    const vfUrl = `https://general-runtime.voiceflow.com/state/${env.VOICEFLOW_VERSION_ID}/user/${userId}/interact`;
    
    console.log('[VF] Request:', { 
        url: vfUrl, 
        action, 
        hasApiKey: !!env.VOICEFLOW_API_KEY,
        versionId: env.VOICEFLOW_VERSION_ID 
    });

    const res = await fetch(vfUrl, {
        method: 'POST',
        headers: {
            Authorization: env.VOICEFLOW_API_KEY,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action }),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const error = `Voiceflow runtime error: ${res.status} ${res.statusText} - ${errText}`;
        console.error('[VF] Error:', error);
        throw new Error(error);
    }

    const data = (await res.json()) as VoiceflowRuntimeResponseItem[];
    console.log('[VF] Response:', { itemCount: data.length, data });

    const texts: string[] = [];
    const seenTexts = new Set<string>();
    const buttons: VFButton[] = [];

    console.log('[VF] Raw data structure:', JSON.stringify(data, null, 2));

    for (const item of data) {
        console.log('[VF] Processing item:', { type: item.type, text: item.text, messagesCount: item.messages?.length });
        
        // ✅ ВАЖНО: VF часто кладёт текст прямо в item.text
        pushUniqueText(texts, seenTexts, item.text);

        // ✅ Новый формат: текст в item.payload.message (для типов text, speak)
        if ((item.type === 'text' || item.type === 'speak') && item.payload?.message) {
            pushUniqueText(texts, seenTexts, item.payload.message);
        }

        // ✅ Новый формат: кнопки прямо в item.payload.buttons (для типа choice)
        if (item.type === 'choice' && Array.isArray(item.payload?.buttons)) {
            for (const b of item.payload.buttons) {
                const title = (b.name ?? '').trim();
                if (!title) continue;

                const payloadRaw = b.request?.payload;
                const payload = payloadToString(payloadRaw, title).trim() || title;

                buttons.push({ title, payload });
            }
        }

        // ✅ Старый формат: текст в item.messages[] (обратная совместимость)
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

    console.log('[VF] Parsed result:', { 
        textCount: texts.length, 
        mergedText: mergedText.substring(0, 100), 
        buttonCount: buttons.length 
    });

    // Если текста нет, но есть кнопки — подскажем пользователю
    if (!mergedText && buttons.length) {
        return { text: 'Выбери вариант:', buttons };
    }

    // Если нет вообще ничего — значит VF прислал не то, что мы ожидаем (или flow пустой на launch)
    if (!mergedText && !buttons.length) {
        console.warn('[VF] WARNING: Empty response from Voiceflow. Check:');
        console.warn('  1. VOICEFLOW_VERSION_ID is correct and published');
        console.warn('  2. VOICEFLOW_API_KEY is valid');
        console.warn('  3. The flow has a launch state / entrypoint');
        console.warn('  4. Voiceflow API is accessible');
        return { text: '❌ Воiceflow вернул пусто. Проверьте конфигурацию (API key, version ID).', buttons: [] };
    }

    return {
        text: mergedText,
        buttons,
    };
} 