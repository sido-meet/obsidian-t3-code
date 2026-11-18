import { ItemView } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';

export const VIEW_TYPE_T3_CODIAN = 't3-codian-chat-view';

export default class T3CodianView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_T3_CODIAN;
  }

  getDisplayText(): string {
    return 'T3-Codian';
  }
}
