import { env } from '../config/env';

type VoiceflowRuntimeResponseItem = {
    type?: string;
    text?: string;
    payload?: any;
    messages?: Array<{ type: string; payload?: any }>;
};

function extractTextFromRuntime(items: VoiceflowRuntimeResponseItem[]): string {
    const texts: string[] = [];

    for (const item of items) {
        // Иногда runtime кладёт текст прямо в item.text
        if (typeof item.text === 'string' && item.text.trim()) {
            texts.push(item.text.trim());
        }

        // Иногда в item.messages[]
        if (Array.isArray(item.messages)) {
            for (const msg of item.messages) {
                if (msg?.type === 'text') {
                    const m = msg.payload?.message;
                    if (typeof m === 'string' && m.trim()) texts.push(m.trim());
                }
            }
        }

        // Иногда текст приходит как item.payload.message (на всякий)
        const pm = item?.payload?.message;
        if (typeof pm === 'string' && pm.trim()) {
            texts.push(pm.trim());
        }
    }

    // Уберём дубли строк (частая причина “повторов”)
    const uniq: string[] = [];
    const seen = new Set<string>();
    for (const t of texts) {
        const key = t.trim();
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        uniq.push(key);
    }

    return uniq.join('\n');
}

export async function voiceflowInteract(params: {
    userId: string;
    text?: string;
    launch?: boolean;
}): Promise<{ text: string }> {
    const { userId, text = '', launch = false } = params;

    const url = `https://general-runtime.voiceflow.com/state/${env.VOICEFLOW_VERSION_ID}/user/${userId}/interact`;

    const body = launch
        ? { action: { type: 'launch' } }
        : {
            action: {
                type: 'text',
                payload: text,
            },
        };

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: env.VOICEFLOW_API_KEY,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Voiceflow runtime error: ${res.status} ${res.statusText} - ${errText}`);
    }

    const data = (await res.json()) as VoiceflowRuntimeResponseItem[];

    const out = extractTextFromRuntime(data).trim();

    return { text: out || '…' };
}
