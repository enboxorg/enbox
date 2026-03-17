import { LitElement, html } from 'lit';
import { ContextConsumer } from '@lit/context';
import { SignalWatcher } from '@lit-labs/signals';
import { appContext } from '../../state/app-context.js';
import { identityRuntimeWindowKey } from '../../identity-runtime.js';
import { switchDidWithToast } from '../../utils/identity-switch.js';
import '../hash-avatar/index.js';

/**
 * @typedef {import('../../identity-runtime.js').IdentityRuntime} IdentityRuntime
 * @typedef {import('../../identity-runtime.js').ManagedIdentitySnapshot} ManagedIdentitySnapshot
 */

function getIdentityRuntime() {
  const runtime = window[identityRuntimeWindowKey];
  if (!runtime || typeof runtime !== 'object' || typeof runtime.switchDid !== 'function') {
    return null;
  }

  return /** @type {IdentityRuntime} */ (runtime);
}

/**
 * @param {ManagedIdentitySnapshot[]} identities
 * @param {string} activeDidUri
 * @returns {ManagedIdentitySnapshot[]}
 */
function sortWithActiveFirst(identities, activeDidUri) {
  if (!activeDidUri) {
    return identities;
  }

  const activeIdentity = identities.find((identity) => identity.didUri === activeDidUri);
  if (!activeIdentity) {
    return identities;
  }

  return [activeIdentity, ...identities.filter((identity) => identity.didUri !== activeDidUri)];
}

class IdentitySwitcher extends SignalWatcher(LitElement) {
  static properties = {
    isSwitchingDid: { state: true },
  };

  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
    this.appStore = null;
    this.isSwitchingDid = false;
    this.appStoreConsumer = new ContextConsumer(this, {
      context   : appContext,
      subscribe : true,
      callback  : (value) => {
        this.appStore = value;
      },
    });
  }

  get walletSnapshot() {
    return this.appStore?.identity.walletSnapshot.get() ?? null;
  }

  get identities() {
    return this.walletSnapshot?.identities ?? [];
  }

  get activeDidUri() {
    return this.appStore?.identity.activeManagedDidUri.get() ?? '';
  }

  get activeIdentity() {
    const activeDidUri = this.activeDidUri;
    if (!activeDidUri) {
      return null;
    }

    return this.identities.find((identity) => identity.didUri === activeDidUri) ?? null;
  }

  get showIdentityPopover() {
    const snapshot = this.walletSnapshot;
    if (!snapshot || snapshot.isLocked) {
      return false;
    }

    return Boolean(this.activeIdentity);
  }

  get tooltipText() {
    if (this.showIdentityPopover) {
      const activeIdentity = this.activeIdentity;
      if (activeIdentity?.name?.trim()) {
        return activeIdentity.name.trim();
      }

      return activeIdentity?.didUri ?? 'Identity';
    }

    return 'Identity';
  }

  get orderedIdentities() {
    return sortWithActiveFirst(this.identities, this.activeDidUri);
  }

  get otherIdentities() {
    const activeDidUri = this.activeDidUri;
    if (!activeDidUri) {
      return this.orderedIdentities;
    }

    return this.orderedIdentities.filter((identity) => identity.didUri !== activeDidUri);
  }

  onTriggerClick = () => {
    if (this.showIdentityPopover) {
      return;
    }

    this.appStore?.navigate('identity');
  };

  onIdentityViewClick = () => {
    this.appStore?.navigate('identity');
  };

  /**
   * @param {MouseEvent} event
   */
  onIdentitySelected = async (event) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (this.isSwitchingDid) {
      return;
    }

    const didUri = (target.dataset.didUri ?? '').trim();
    if (!didUri || didUri === this.activeDidUri) {
      return;
    }

    const runtime = getIdentityRuntime();

    this.isSwitchingDid = true;
    try {
      await switchDidWithToast({
        runtime,
        didUri,
        previousActiveDid : this.activeDidUri,
        toastStore : this.appStore?.toast,
      });
    } finally {
      this.isSwitchingDid = false;
    }
  };

  /**
   * @param {ManagedIdentitySnapshot} identity
   */
  renderIdentityOption(identity) {
    return html`
      <button
        type="button"
        class="identity-switcher-option"
        data-did-uri=${identity.didUri}
        data-popover="close"
        ?disabled=${this.isSwitchingDid}
        @click=${this.onIdentitySelected}
      >
        <hash-avatar
          class="identity-switcher-option-avatar"
          hash=${identity.didUri}
          initials=${identity.name || identity.didUri}
          label=${identity.name || identity.didUri}
        ></hash-avatar>
        <span class="identity-switcher-option-copy">
          <span class="identity-switcher-option-name">${identity.name || identity.didUri}</span>
        </span>
      </button>
    `;
  }

  render() {
    const showIdentityPopover = this.showIdentityPopover;
    const activeIdentity = this.activeIdentity;
    const hasOtherIdentities = this.otherIdentities.length > 0;

    return html`
      <wa-tooltip for="main-header-identity-trigger" without-arrow>${this.tooltipText}</wa-tooltip>
      <wa-button
        id="main-header-identity-trigger"
        class="main-header-identity-trigger"
        appearance="plain"
        pill
        ?disabled=${this.isSwitchingDid}
        @click=${this.onTriggerClick}
      >
        ${showIdentityPopover
          ? html`
              <hash-avatar
                class="main-header-identity-avatar"
                hash=${activeIdentity?.didUri ?? ''}
                initials=${activeIdentity?.name || activeIdentity?.didUri || ''}
                label=${activeIdentity?.name || activeIdentity?.didUri || 'Identity'}
              ></hash-avatar>
            `
          : html`<wa-icon name="user" label="Open identity view" variant="solid" class="wa-font-size-l"></wa-icon>`}
      </wa-button>

      ${showIdentityPopover
        ? html`
            <wa-popover id="main-header-identity-popover" for="main-header-identity-trigger" placement="bottom-end">
              <div class="identity-switcher-popover-body">
                ${activeIdentity
                  ? html`
                      <div class="identity-switcher-active-card" role="status" aria-label="Active DID">
                        <hash-avatar
                          class="identity-switcher-active-avatar"
                          hash=${activeIdentity.didUri}
                          initials=${activeIdentity.name || activeIdentity.didUri}
                          label=${activeIdentity.name || activeIdentity.didUri}
                          size="64"
                        ></hash-avatar>
                        <div class="identity-switcher-active-name">${activeIdentity.name || activeIdentity.didUri}</div>
                        <div class="identity-switcher-active-status">Active</div>
                      </div>
                    `
                  : ''}
                ${hasOtherIdentities
                  ? html`
                      <div class="identity-switcher-popover-subtitle">Other Identifiers</div>
                      <div class="identity-switcher-popover-list" role="listbox" aria-label="Other available DIDs">
                        ${this.otherIdentities.map((identity) => this.renderIdentityOption(identity))}
                      </div>
                    `
                  : ''}
                <wa-button
                  class="identity-switcher-view-button"
                  appearance="outlined"
                  data-popover="close"
                  @click=${this.onIdentityViewClick}
                >
                  Identity View
                  <wa-icon slot="end" name="arrow-right" variant="solid"></wa-icon>
                </wa-button>
              </div>
            </wa-popover>
          `
        : ''}
    `;
  }
}

if (!customElements.get('identity-switcher')) {
  customElements.define('identity-switcher', IdentitySwitcher);
}
