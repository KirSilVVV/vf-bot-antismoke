import { env } from '../config/env';

type VFTrace = {
    type?: string;
    text?: string;
    payload?: any;
    messages?: any[];
};

function normalizeText(s: string) {
    return (s ?? '').replace(/\r\n/g, '\n').trim();
}

function pushDedup(arr: string[], value: string) {
    const v = normalizeText(value);
    if (!v) return;

    // убираем подряд идущие дубли (самая частая проблема)
    const last = arr.length ? normalizeText(arr[arr.length - 1]) : '';
    if (last === v) return;

    arr.push(v);
}

export async function voiceflowInteract(params: {
    userId: string;
    text: string;
}): Promise<{ text: string }> {
    const { userId, text } = params;

    const url = `https://general-runtime.voiceflow.com/state/${env.VOICEFLOW_VERSION_ID}/user/${userId}/interact`;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: env.VOICEFLOW_API_KEY,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            action: { type: 'text', payload: text },
        }),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Voiceflow runtime error: ${res.status} ${res.statusText} - ${errText}`);
    }

    const data = (await res.json()) as VFTrace[];

    const texts: string[] = [];

    for (const item of data) {
        // 1) приоритетно читаем из messages (traces)
        if (Array.isArray(item.messages)) {
            for (const msg of item.messages) {
                // Voiceflow обычно шлёт text именно так
                if (msg?.type === 'text' && msg?.payload?.message) {
                    pushDedup(texts, String(msg.payload.message));
                }
            }
        }

        // 2) fallback: если messages нет, а text есть — берём text
        if ((!item.messages || item.messages.length === 0) && item.text) {
            pushDedup(texts, String(item.text));
        }
    }

    const finalText = texts.join('\n\n').trim() || '…';

    return { text: finalText };
}
