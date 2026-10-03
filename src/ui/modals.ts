// ── ui/modals.ts ──────────────────────────────────────────────────────────
// The dialogs: creating a vault, unlocking an encrypted one, approving a
// large deletion, the sync log, the list of conflict copies, and a generic
// confirmation. Each takes its labels and callbacks; none touches the sync
// directly, so main.ts stays the one place that drives it.
// ─────────────────────────────────────────────────────────────────────────────

import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile } from 'obsidian';
import { LogEntry } from '../core/sync-log';
import { DeleteSummary } from '../core/planner';
import { Labels } from '../localization/labels';

function applyDirection(el: HTMLElement, labels: Labels): void {
  el.setAttr('dir', labels.dir);
}

export interface CreateVaultInput {
  name: string;
  passphrase: string | null;
  remember: boolean;
}

export class CreateVaultModal extends Modal {
  private name = '';
  private encrypt = false;
  private passphrase = '';
  private again = '';
  private remember = true;

  constructor(
    app: App,
    private readonly labels: Labels,
    private readonly onSubmit: (input: CreateVaultInput) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const l = this.labels;
    applyDirection(this.modalEl, l);
    this.titleEl.setText(l.createTitle);
    this.render();
  }

  private render(): void {
    const l = this.labels;
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(l.createName).addText((text) => {
      text.setValue(this.name).onChange((value) => (this.name = value));
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    new Setting(contentEl)
      .setName(l.createEncrypt)
      .setDesc(l.createEncryptDesc)
      .addToggle((toggle) =>
        toggle.setValue(this.encrypt).onChange((value) => {
          this.encrypt = value;
          this.render();
        })
      );
    if (this.encrypt) {
      new Setting(contentEl).setName(l.passphrase).addText((text) => {
        text.inputEl.type = 'password';
        text.setValue(this.passphrase).onChange((value) => (this.passphrase = value));
      });
      new Setting(contentEl).setName(l.passphraseAgain).addText((text) => {
        text.inputEl.type = 'password';
        text.setValue(this.again).onChange((value) => (this.again = value));
      });
      new Setting(contentEl).setName(l.rememberKey).setDesc(l.rememberKeyDesc).addToggle((toggle) => toggle.setValue(this.remember).onChange((value) => (this.remember = value)));
      contentEl.createEl('p', { cls: 'vault-sync-warning', text: l.passphraseWarning });
    }
    new Setting(contentEl)
      .addButton((button) => button.setButtonText(l.btnCancel).onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(l.btnCreate)
          .setCta()
          .onClick(async () => {
            const name = this.name.trim();
            if (!name) return;
            if (this.encrypt && this.passphrase.length < 8) return void new Notice(l.passphraseTooShort);
            if (this.encrypt && this.passphrase !== this.again) return void new Notice(l.passphraseMismatch);
            button.setDisabled(true);
            try {
              await this.onSubmit({ name, passphrase: this.encrypt ? this.passphrase : null, remember: this.remember });
              this.close();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error));
              button.setDisabled(false);
            }
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class PassphraseModal extends Modal {
  private passphrase = '';
  private remember = true;

  constructor(
    app: App,
    private readonly labels: Labels,
    private readonly vaultName: string,
    private readonly onSubmit: (passphrase: string, remember: boolean) => Promise<boolean>
  ) {
    super(app);
  }

  onOpen(): void {
    const l = this.labels;
    applyDirection(this.modalEl, l);
    this.titleEl.setText(l.unlockTitle(this.vaultName));
    const submit = async () => {
      if (await this.onSubmit(this.passphrase, this.remember)) this.close();
    };
    new Setting(this.contentEl).setName(l.passphrase).addText((text) => {
      text.inputEl.type = 'password';
      text.onChange((value) => (this.passphrase = value));
      text.inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void submit();
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).setName(l.rememberKey).setDesc(l.rememberKeyDesc).addToggle((toggle) => toggle.setValue(true).onChange((value) => (this.remember = value)));
    new Setting(this.contentEl).addButton((button) => button.setButtonText(l.btnUnlock).setCta().onClick(submit));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export type DeleteChoice = 'delete' | 'keep' | 'pause';

export class MassDeleteModal extends Modal {
  private chosen = false;

  constructor(
    app: App,
    private readonly labels: Labels,
    private readonly deletes: DeleteSummary,
    private readonly onChoice: (choice: DeleteChoice | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const l = this.labels;
    applyDirection(this.modalEl, l);
    this.titleEl.setText(l.massTitle);
    const { contentEl } = this;
    const section = (intro: string, paths: string[]) => {
      if (!paths.length) return;
      contentEl.createEl('p', { text: intro });
      const details = contentEl.createEl('details');
      details.createEl('summary', { text: paths.slice(0, 3).join(', ') + (paths.length > 3 ? '…' : '') });
      const list = details.createEl('ul', { cls: 'vault-sync-paths' });
      for (const path of paths) list.createEl('li', { text: path });
    };
    section(l.massIntroLocal(this.deletes.local.length), this.deletes.local);
    section(l.massIntroRemote(this.deletes.remote.length), this.deletes.remote);
    contentEl.createEl('p', { cls: 'setting-item-description', text: l.massExplain });
    const choose = (choice: DeleteChoice) => {
      this.chosen = true;
      this.close();
      this.onChoice(choice);
    };
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(l.btnPause).onClick(() => choose('pause')))
      .addButton((b) => b.setButtonText(l.btnKeep).setCta().onClick(() => choose('keep')))
      .addButton((b) => b.setButtonText(l.btnDelete).setWarning().onClick(() => choose('delete')));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.chosen) this.onChoice(null);
  }
}

export class SyncLogModal extends Modal {
  constructor(
    app: App,
    private readonly labels: Labels,
    private readonly entries: () => LogEntry[]
  ) {
    super(app);
  }

  onOpen(): void {
    const l = this.labels;
    applyDirection(this.modalEl, l);
    this.titleEl.setText(l.logTitle);
    this.modalEl.addClass('vault-sync-log-modal');
    const entries = this.entries();
    const format = (e: LogEntry) =>
      `${new Date(e.at).toLocaleString()}  ${l.logKinds[e.kind] ?? e.kind}${e.path ? `  ${e.path}` : ''}${e.detail ? `  — ${e.detail}` : ''}`;
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText(l.btnCopy).onClick(() => void navigator.clipboard.writeText(entries.map(format).join('\n')))
    );
    if (!entries.length) {
      this.contentEl.createEl('p', { text: l.logEmpty });
      return;
    }
    const list = this.contentEl.createDiv({ cls: 'vault-sync-log' });
    for (const entry of entries) {
      const row = list.createDiv({ cls: `vault-sync-log__row vault-sync-log__row--${entry.kind}` });
      row.createSpan({ cls: 'vault-sync-log__time', text: new Date(entry.at).toLocaleString() });
      row.createSpan({ cls: 'vault-sync-log__kind', text: l.logKinds[entry.kind] ?? entry.kind });
      if (entry.path) row.createSpan({ cls: 'vault-sync-log__path', text: entry.path });
      if (entry.detail) row.createSpan({ cls: 'vault-sync-log__detail', text: entry.detail });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class ConflictListModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    labels: Labels,
    private readonly files: TFile[]
  ) {
    super(app);
    this.setPlaceholder(labels.conflictsPlaceholder);
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    void this.app.workspace.getLeaf(false).openFile(file);
  }
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly labels: Labels,
    private readonly title: string,
    private readonly body: string,
    private readonly confirmText: string,
    private readonly onConfirm: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    applyDirection(this.modalEl, this.labels);
    this.titleEl.setText(this.title);
    this.contentEl.createEl('p', { text: this.body });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(this.labels.btnCancel).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.confirmText)
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
