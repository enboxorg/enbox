import { css, html, LitElement } from 'lit';
import { ContextProvider } from '@lit/context';
import { appContext } from '../../state/app-context.js';
import { getAppStore } from '../../state/app-store.js';

class AppShell extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
  `;

  constructor() {
    super();
    this.appStore = getAppStore();
    this.appStoreProvider = new ContextProvider(this, {
      context      : appContext,
      initialValue : this.appStore,
    });
  }

  render() {
    return html`<slot></slot>`;
  }
}

if (!customElements.get('app-shell')) {
  customElements.define('app-shell', AppShell);
}
