import { LitElement, html } from 'lit';
import { ContextConsumer } from '@lit/context';
import { SignalWatcher } from '@lit-labs/signals';
import { appContext } from '../../state/app-context.js';

const toastHostId = 'global-toast-host';

class ToastRegion extends SignalWatcher(LitElement) {
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
    this._waitingForDefinition = false;
    this._loaderNudged = false;
  }

  render() {
    return html`
      <wa-toast id=${toastHostId} placement="bottom-end"></wa-toast>
    `;
  }

  updated() {
    this.flushPendingToasts();
  }

  flushPendingToasts() {
    const pendingToasts = this.appStore?.toast.entries.get() ?? [];
    if (pendingToasts.length === 0) {
      return;
    }

    const host = this.querySelector(`#${toastHostId}`);
    if (!(host instanceof HTMLElement)) {
      return;
    }

    if (typeof host.create !== 'function') {
      this.waitForToastDefinition();
      return;
    }

    for (const entry of pendingToasts) {
      host.create(entry.message, {
        variant  : entry.tone,
        duration : entry.duration,
      });

      window.setTimeout(() => {
        this.appStore?.toast.consume(entry.id);
      }, 0);
    }
  }

  waitForToastDefinition() {
    if (customElements.get('wa-toast')) {
      this.flushPendingToasts();
      return;
    }

    if (this._waitingForDefinition || typeof customElements.whenDefined !== 'function') {
      return;
    }

    this.nudgeAutoLoader();
    this._waitingForDefinition = true;
    void customElements.whenDefined('wa-toast').then(() => {
      this._waitingForDefinition = false;
      this.flushPendingToasts();
    }).catch(() => {
      this._waitingForDefinition = false;
      console.warn('app toast region: wa-toast definition did not resolve');
    });
  }

  nudgeAutoLoader() {
    if (this._loaderNudged || !(document.body instanceof HTMLElement)) {
      return;
    }

    this._loaderNudged = true;
    const probe = document.createElement('wa-toast');
    probe.setAttribute('hidden', '');
    probe.setAttribute('aria-hidden', 'true');
    probe.setAttribute('data-toast-probe', '');
    document.body.appendChild(probe);

    queueMicrotask(() => {
      probe.remove();
    });
  }
}

if (!customElements.get('toast-region')) {
  customElements.define('toast-region', ToastRegion);
}
