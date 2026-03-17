import { LitElement, html } from 'lit';
import { ContextConsumer } from '@lit/context';
import { SignalWatcher } from '@lit-labs/signals';
import { appContext } from '../../state/app-context.js';

class ConnectionBadge extends SignalWatcher(LitElement) {
  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
    this.appStore = null;
    this.appStoreConsumer = new ContextConsumer(this, {
      context   : appContext,
      subscribe : true,
      callback  : (value) => {
        this.appStore = value;
      },
    });
  }

  render() {
    const badgeVariant = this.appStore?.connection.badgeVariant.get() ?? 'warning';
    const badgeLabel = this.appStore?.connection.badgeLabel.get() ?? 'Connecting...';

    return html`
      <wa-badge variant=${badgeVariant} pill>${badgeLabel}</wa-badge>
    `;
  }
}

if (!customElements.get('connection-badge')) {
  customElements.define('connection-badge', ConnectionBadge);
}
