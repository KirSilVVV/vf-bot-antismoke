import { env } from '../config/env';

type VoiceflowRuntimeItem = {
    type?: string;
    text?: string;
    payload?: any;
    messages?: Array<{ type: string; payload?: any }>;
};

type VoiceflowInteractParams =
    | { userId: string; text: string; launch?: false }
    | { userId: string; launch: true; text?: string };

function extractTextFromVoiceflow(data: unknown): string {
    const texts: string[] = [];

    const pushMaybe = (v: any) => {
        if (typeof v === 'string' && v.trim()) texts.push(v.trim());
    };

    const scanItem = (item: any) => {
        if (!item || typeof item !== 'object') return;

        // 1) Иногда бывает item.text
        pushMaybe(item.text);

        // 2) Иногда бывает массив item.messages
        if (Array.isArray(item.messages)) {
            for (const msg of item.messages) {
                if (!msg) continue;
                if (msg.type === 'text') {
                    pushMaybe(msg.payload?.message);
                    pushMaybe(msg.payload?.text);
                    pushMaybe(msg.payload); // если payload вдруг строка
                }
            }
        }

        // 3) Иногда это "trace" элементы, где текст лежит в payload.message / payload.text
        if (item.type === 'text') {
            pushMaybe(item.payload?.message);
            pushMaybe(item.payload?.text);
            pushMaybe(item.payload);
        }

        // 4) Иногда Voiceflow кладёт message глубже
        pushMaybe(item.payload?.message);
        pushMaybe(item.payload?.text);
    };

    if (Array.isArray(data)) {
        for (const item of data) scanItem(item);
    } else if (data && typeof data === 'object') {
        // На всякий случай, если формат вдруг не массив
        scanItem(data);
    }

    return texts.join('\n').trim();
}

export async function voiceflowInteract(
    params: VoiceflowInteractParams
): Promise<{ text: string; raw: unknown }> {
    const { userId } = params;

    const body =
        'launch' in params && params.launch
            ? { action: { type: 'launch' } }
            : { action: { type: 'text', payload: params.text } };

    const res = await fetch(
        `https://general-runtime.voiceflow.com/state/${env.VOICEFLOW_VERSION_ID}/user/${userId}/interact`,
        {
            method: 'POST',
            headers: {
                Authorization: env.VOICEFLOW_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        }
    );

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Voiceflow runtime error: ${res.status} ${res.statusText} - ${errText}`);
    }

    const data = (await res.json()) as unknown;

    const text = extractTextFromVoiceflow(data) || '…';

    return { text, raw: data };
}
