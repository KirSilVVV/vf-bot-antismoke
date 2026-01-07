// src/services/voiceflowRuntime.ts
import { env } from '../config/env';

type VFMessage =
  | { type: 'text'; payload?: { message?: string } }
  | { type: 'choice'; payload?: { buttons?: Array<{ name?: string; request?: { payload?: string } }> } }
  | { type: 'buttons'; payload?: { buttons?: Array<{ name?: string; request?: { payload?: string } }> } }
  | { type: string; payload?: any };

type VoiceflowRuntimeResponseItem = {
  type?: string;
  text?: string; // часто дублирует messages — поэтому ниже мы в основном читаем messages
  messages?: VFMessage[];
  payload?: any;
};

export type VFButton = {
  title: string;
  payload: string; // то, что отправим обратно в VF при клике
};

export type VFResult = {
  text: string;
  buttons: VFButton[];
};

// ---- helpers ----
function normalizeText(s: string) {
  return s.replace(/\r\n/g, '\n').trim();
}

function pushUniqueText(out: string[], seen: Set<string>, value: string) {
  const t = normalizeText(value);
  if (!t) return;

  // ключ для дедупа: сжимаем пробелы/табы
  const key = t.replace(/[ \t]+/g, ' ');
  if (seen.has(key)) return;

  seen.add(key);
  out.push(t);
}

function pushButton(out: VFButton[], titleRaw: unknown, payloadRaw: unknown) {
  const title = String(titleRaw ?? '').trim();
  if (!title) return;

  const payload = String(payloadRaw ?? '').trim() || title;
  out.push({ title, payload });
}

type VFAction =
  | { type: 'launch' }
  | { type: 'text'; payload: string }
  | { type: string; payload?: any };

// ---- main ----
export async function voiceflowInteract(
  params:
    | { userId: string; launch: true }
    | { userId: string; action: VFAction }
    | { userId: string; text: string }
): Promise<VFResult> {
  const userId = (params as any).userId as string;

  let action: VFAction;

  // ✅ ВАЖНО: корректное сужение union-типа (иначе TS ругается на params.text)
  if ('launch' in params && params.launch) {
    action = { type: 'launch' };
  } else if ('action' in params) {
    action = params.action;
  } else if ('text' in params) {
    action = { type: 'text', payload: params.text };
  } else {
    throw new Error('Invalid voiceflowInteract params');
  }

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
    const msgs = item.messages ?? [];

    // Берём текст в приоритете из messages, потому что item.text часто дублит
    for (const msg of msgs) {
      // 1) текстовые сообщения
      if (msg.type === 'text' && msg.payload?.message) {
        pushUniqueText(texts, seenTexts, String(msg.payload.message));
      }

      // 2) выбор/кнопки (choice)
      if (msg.type === 'choice' && Array.isArray(msg.payload?.buttons)) {
        for (const b of msg.payload!.buttons!) {
          const title = (b.name ?? '').trim();
          if (!title) continue;

          // Что отправлять обратно в VF при клике:
          // чаще всего VF ожидает request.payload, если он задан;
          // иначе можно отправить title
          const payload = (b.request?.payload ?? title).trim();
          pushButton(buttons, title, payload);
        }
      }

      // 3) buttons (некоторые проекты/блоки VF отдают именно так)
      if (msg.type === 'buttons' && Array.isArray((msg as any).payload?.buttons)) {
        const arr = (msg as any).payload.buttons as Array<{ name?: string; request?: { payload?: string } }>;
        for (const b of arr) {
          const title = (b.name ?? '').trim();
          if (!title) continue;
          const payload = (b.request?.payload ?? title).trim();
          pushButton(buttons, title, payload);
        }
      }
    }

    // Если вдруг VF не положил текст в messages, можно подстраховаться item.text
    if (item.text) {
      pushUniqueText(texts, seenTexts, String(item.text));
    }
  }

  const mergedText = texts.join('\n\n').trim();

  return {
    text: mergedText || (buttons.length ? 'Выбери вариант:' : '…'),
    buttons,
  };
}
 