/**
 * ask_user - Ask user for confirmation with inline buttons
 * Agent can use this to get user approval before actions
 */

// Callback for asking user (set from bot)
let askCallback: ((
  sessionId: string,
  question: string,
  options: string[]
) => Promise<string>) | null = null;

/**
 * Set the ask callback (called from bot)
 */
export function setAskCallback(
  callback: (sessionId: string, question: string, options: string[]) => Promise<string>
) {
  askCallback = callback;
}

export const definition = {
  type: "function" as const,
  function: {
    name: "ask_user",
    description: "Задать пользователю вопрос с кнопками. Используй, когда нужен выбор или подтверждение. Возвращает выбранный вариант.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Вопрос пользователю"
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Варианты ответов на кнопках (2-4 варианта)"
        },
      },
      required: ["question", "options"],
    },
  },
};

export async function execute(
  args: { question: string; options: string[] },
  sessionId: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  if (!askCallback) {
    return {
      success: false,
      error: 'Не настроен ask callback',
    };
  }
  
  // Validate options
  if (!args.options || args.options.length < 2) {
    return {
      success: false,
      error: 'Нужно минимум 2 варианта',
    };
  }
  
  if (args.options.length > 4) {
    args.options = args.options.slice(0, 4);
  }
  
  try {
    const answer = await askCallback(sessionId, args.question, args.options);
    return {
      success: true,
      output: `Пользователь выбрал: ${answer}`,
    };
  } catch (e: any) {
    return {
      success: false,
      error: `Не удалось получить ответ пользователя: ${e.message}`,
    };
  }
}
