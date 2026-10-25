/**
 * Prompts that gate git writes (confirmations, pickers, inputs). In test mode the integration suite
 * queues answers here, because a modal dialog would block the extension host.
 */
import * as vscode from 'vscode';

const answers: (string | undefined)[] = [];
let testMode = false;
/** Prompts shown in test mode, for assertions. */
export const shownPrompts: string[] = [];

export function enableTestAnswers(): void {
  testMode = true;
}

/** Test mode: the answers the next prompts return, in order (undefined = dismissed). */
export function queueAnswers(...a: (string | undefined)[]): void {
  answers.push(...a);
}

function answer(prompt: string): string | undefined {
  shownPrompts.push(prompt);
  if (!answers.length) throw new Error(`No queued answer for prompt: ${prompt}`);
  return answers.shift();
}

/** A modal confirmation; resolves true only for `action`. */
export async function confirm(message: string, detail: string, action: string): Promise<boolean> {
  if (testMode) return answer(message) === action;
  return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
}

export async function pick<T extends vscode.QuickPickItem>(items: T[], placeHolder: string): Promise<T | undefined> {
  if (testMode) {
    const label = answer(placeHolder);
    return items.find((i) => i.label === label);
  }
  return vscode.window.showQuickPick(items, { placeHolder });
}

export async function input(prompt: string, opts: { value?: string; validate?: (v: string) => string | undefined } = {}): Promise<string | undefined> {
  if (testMode) {
    const v = answer(prompt);
    return v !== undefined && !opts.validate?.(v) ? v : undefined;
  }
  return vscode.window.showInputBox({ prompt, value: opts.value, validateInput: opts.validate });
}
