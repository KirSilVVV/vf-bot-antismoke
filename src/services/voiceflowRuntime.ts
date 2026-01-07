import { env } from '../config/env';

type VFMessage =
    | { type: 'text'; payload?: { message?: string } }
    | { type: 'choice'; payload?: { buttons?: Array<{ name?: string; request?: { payload?: string } }> } }
    | { type: string; payload?: any };

type VoiceflowRuntimeResponseItem = {
    type?: string;
    text?: string;
    messages?: VFMessage[];
    payload?: any;
};

export type VFButton = {
    title: string;
    payload: string; // что отправим обратно в VF при клике
};

export type VFResult = {
    text: string;
    buttons: VFButton[];
};

export async function voiceflowInteract(params: {
    userId: string;
    text?: string;
    launch?: boolean;
}): Promise<VFResult> {
    const { userId, text, launch } = params;

    const action = launch
        ? { type: 'launch' as const }
        : { type: 'text' as const, payload: text ?? '' };

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
    const buttons: VFButton[] = [];

    for (const item of data) {
        if (item.text) texts.push(item.text);

        const msgs = item.messages ?? [];
        for (const msg of msgs) {
            // обычный текст
            if (msg.type === 'text' && msg.payload?.message) {
                texts.push(String(msg.payload.message));
            }

            // кнопки/выбор
            if (msg.type === 'choice' && Array.isArray(msg.payload?.buttons)) {
                for (const b of msg.payload!.buttons!) {
                    const title = (b.name ?? '').trim();
                    if (!title) continue;

                    // payload: лучше отправлять в VF то, что он ожидает.
                    // Часто достаточно отправить текст кнопки.
                    const payload = (b.request?.payload ?? title).trim();

                    buttons.push({ title, payload });
                }
            }
        }
    }

    const mergedText = texts.map(t => t.trim()).filter(Boolean).join('\n').trim();

    return {
        text: mergedText || 'Ок 🙂',
        buttons,
    };
}
