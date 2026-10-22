/** GitLens coexistence: both extensions drawing current-line blame would show two ghost texts. */
import * as vscode from 'vscode';

const ASKED_KEY = 'gitvision.gitlensCoexistenceAsked';

export async function offerGitLensCoexistence(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): Promise<void> {
  if (!vscode.extensions.getExtension('eamodio.gitlens')) return;
  if (context.globalState.get<boolean>(ASKED_KEY)) return;
  const gl = vscode.workspace.getConfiguration('gitlens.currentLine');
  if (gl.get<boolean>('enabled') === false) return;
  await context.globalState.update(ASKED_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    'GitLens also shows blame on the current line, so you will see it twice. Turn off GitLens current-line blame?',
    'Turn Off in GitLens',
    'Keep Both',
  );
  if (choice === 'Turn Off in GitLens') {
    await gl.update('enabled', false, vscode.ConfigurationTarget.Global);
    log.info('Turned off gitlens.currentLine.enabled');
  }
}
