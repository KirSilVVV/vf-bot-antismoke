import { env } from '../config/env';

type VoiceflowRuntimeResponse = {
    text?: string;
    messages?: Array<{ type: string; payload?: any }>;
};

export async function voiceflowInteract(params: {
    userId: string;
    text: string;
}): Promise<{ text: string }> {
    const { userId, text } = params;

    const res = await fetch(
        `https://general-runtime.voiceflow.com/state/${env.VOICEFLOW_VERSION_ID}/user/${userId}/interact`,
        {
            method: 'POST',
            headers: {
                Authorization: env.VOICEFLOW_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                action: {
                    type: 'text',
                    payload: text,
                },
            }),
        }
    );

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Voiceflow runtime error: ${errText}`);
    }

    const data = (await res.json()) as VoiceflowRuntimeResponse[];

    // Собираем весь текст, который вернул Voiceflow
    const texts: string[] = [];

    for (const item of data) {
        if (item.text) texts.push(item.text);

        if (item.messages) {
            for (const msg of item.messages) {
                if (msg.type === 'text' && msg.payload?.message) {
                    texts.push(msg.payload.message);
                }
            }
        }
    }

    return {
        text: texts.join('\n') || '…',
    };
}
