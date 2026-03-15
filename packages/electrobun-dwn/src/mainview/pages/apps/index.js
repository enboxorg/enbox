import { LitElement, html } from 'lit';
import { ContextConsumer } from '@lit/context';
import { SignalWatcher } from '@lit-labs/signals';
import { createRef, ref } from 'lit/directives/ref.js';
import { appContext } from '../../state/app-context.js';
import { getAppStore } from '../../state/app-store.js';
import { getProtocolCatalogEntry, getProtocolInstallPlan, protocolCatalog } from './protocol-catalog.js';
import './index.css';

const identityRuntimeWindowKey = '__identityRuntime';

/**
 * @typedef {{
 *   did: string;
 *   protocols: string[];
 * }} InstalledProtocolsSnapshot
 */

/**
 * @typedef {{
 *   protocol: string;
 *   [key: string]: unknown;
 * }} ProtocolDefinitionLike
 */

/**
 * @typedef {{
 *   did: string;
 *   protocol: string;
 *   alreadyInstalled: boolean;
 *   status: {
 *     code: number;
 *     detail: string;
 *     [key: string]: unknown;
 *   };
 * }} EnsureProtocolInstalledResult
 */

/**
 * @typedef {{
 *   did: string;
 *   protocol: string;
 *   listInstalledProtocols: () => Promise<InstalledProtocolsSnapshot>;
 *   ensureProtocolInstalled: (definition: ProtocolDefinitionLike) => Promise<EnsureProtocolInstalledResult>;
 * }} IdentityRuntime
 */

class AppsPage extends SignalWatcher(LitElement) {
  static properties = {
    installedProtocols     : { state: true },
    installingProtocols    : { state: true },
    isProtocolStateLoading : { state: true },
    protocolLoadError      : { state: true },
    protocolSearch         : { state: true },
    protocolStatusDid      : { state: true },
  };

  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
    this.appStore = null;
    this.installedProtocols = new Set();
    this.installingProtocols = new Set();
    this.isProtocolStateLoading = false;
    this.protocolLoadError = '';
    this.protocolSearch = '';
    this.protocolStatusDid = '';
    this._observedProtocolDid = '';
    this._protocolStatusRequestId = 0;
    this.protocolDialogRef = createRef();
    this.protocolSearchInputRef = createRef();
    this.appStoreConsumer = new ContextConsumer(this, {
      context   : appContext,
      subscribe : true,
      callback  : (value) => {
        this.appStore = value;
      },
    });
  }

  updated() {
    const currentDid = this.currentDid;
    if (currentDid === this._observedProtocolDid) {
      return;
    }

    this._observedProtocolDid = currentDid;
    this.installedProtocols = new Set();
    this.installingProtocols = new Set();
    this.isProtocolStateLoading = false;
    this.protocolLoadError = '';
    this.protocolSearch = '';
    this.protocolStatusDid = '';

    if (!currentDid) {
      return;
    }

    void this.loadInstalledProtocols(currentDid);
  }

  get connections() {
    return this.appStore?.apps.connections.get() ?? [];
  }

  get accordionItems() {
    return this.connections.map((app) => toAccordionItem(app));
  }

  get identitySnapshot() {
    return this.appStore?.identity.walletSnapshot.get() ?? null;
  }

  get currentDid() {
    const snapshot = this.identitySnapshot;
    if (!snapshot || typeof snapshot !== 'object') {
      return '';
    }

    const activeDid = typeof snapshot.activeDid === 'string'
      ? snapshot.activeDid.trim()
      : '';
    if (activeDid) {
      return activeDid;
    }

    const activeManagedDidUri = typeof snapshot.activeManagedDidUri === 'string'
      ? snapshot.activeManagedDidUri.trim()
      : '';
    return activeManagedDidUri;
  }

  get hasActiveDid() {
    return this.currentDid.length > 0;
  }

  get filteredProtocols() {
    const normalizedQuery = this.protocolSearch.trim().toLowerCase();

    return [...protocolCatalog]
      .filter((entry) => normalizedQuery.length === 0 || entry.searchText.includes(normalizedQuery))
      .sort((left, right) => {
        const leftInstalled = this.isProtocolInstalled(left.protocol) ? 1 : 0;
        const rightInstalled = this.isProtocolInstalled(right.protocol) ? 1 : 0;

        if (leftInstalled !== rightInstalled) {
          return rightInstalled - leftInstalled;
        }

        return left.name.localeCompare(right.name);
      });
  }

  render() {
    return html`
      <div class="wa-stack wa-gap-xl dashboard page-block apps-page">
        <section class="wa-stack wa-gap-s">
          <div class="wa-flank:end">
            <h1>Apps</h1>
            <div class="wa-cluster wa-gap-xs apps-header-actions">
              <wa-button appearance="outlined" variant="brand">
                <wa-icon slot="start" name="plus" variant="solid"></wa-icon>
                Install App
              </wa-button>

              <wa-button
                appearance="outlined"
                ?disabled=${!this.hasActiveDid}
                @click=${this.onOpenInstallProtocolDialog}
              >
                <wa-icon slot="start" name="plus" variant="solid"></wa-icon>
                Install Protocol
              </wa-button>
            </div>
          </div>

          <wa-divider style="padding-bottom: var(--spacing)"></wa-divider>

          <div class="wa-caption-m apps-connections-intro">
            Applications with active connections to your DWN identity.
          </div>
        </section>

        <x-accordion
          class="apps-connections-list"
          aria-live="polite"
          aria-label="Connected applications"
          empty-text="No app connections found."
          .items=${this.accordionItems}
        ></x-accordion>

        ${this.renderProtocolDialog()}
      </div>
    `;
  }

  renderProtocolDialog() {
    return html`
      <wa-dialog
        ${ref(this.protocolDialogRef)}
        id="apps-install-protocol-dialog"
        light-dismiss
        @wa-after-hide=${this.onProtocolDialogAfterHide}
      >
        <div slot="label" class="wa-cluster wa-gap-xs">
          <wa-icon name="circle-plus" variant="solid"></wa-icon>
          Install Protocol
        </div>

        <div class="wa-stack wa-gap-s apps-protocol-dialog-body">
          <div class="wa-stack wa-gap-s apps-protocol-dialog-controls">
            <wa-input
              ${ref(this.protocolSearchInputRef)}
              class="apps-protocol-search"
              placeholder="Search protocols"
              pill
              autocapitalize="none"
              autocorrect="off"
              autocomplete="off"
              spellcheck="false"
              .value=${this.protocolSearch}
              @input=${this.onProtocolSearchInput}
            >
              <wa-icon slot="start" name="magnifying-glass"></wa-icon>
            </wa-input>

            ${this.protocolLoadError
              ? html`<wa-callout variant="danger">${this.protocolLoadError}</wa-callout>`
              : ''}
          </div>

          <div class="apps-protocol-list" role="list" aria-label="Available protocols">
            ${this.renderProtocolList()}
          </div>
        </div>
      </wa-dialog>
    `;
  }

  renderProtocolList() {
    if (!this.hasActiveDid) {
      return html`
        <wa-callout variant="warning">
          Select or unlock a DID before installing protocols.
        </wa-callout>
      `;
    }

    if (this.isProtocolStateLoading && this.protocolStatusDid !== this.currentDid) {
      return html`
        <div class="wa-stack wa-align-items-center wa-gap-s apps-protocol-loading">
          <wa-spinner style="font-size: 1.75rem"></wa-spinner>
          <div class="wa-caption-m">Loading installed protocols</div>
        </div>
      `;
    }

    if (this.filteredProtocols.length === 0) {
      return html`
        <div class="wa-caption-m apps-protocol-empty">
          No protocols match your search.
        </div>
      `;
    }

    return this.filteredProtocols.map((entry) => this.renderProtocolListItem(entry));
  }

  /**
   * @param {{
   *   name: string;
   *   protocol: string;
   *   protocolUrl: string;
   *   publisher: string;
   * }} entry
   * @returns {import('lit').TemplateResult}
   */
  renderProtocolListItem(entry) {
    const isInstalled = this.isProtocolInstalled(entry.protocol);
    const isInstalling = this.isProtocolInstalling(entry.protocol);
    const faviconUrl = googleFaviconUrl(entry.protocolUrl);
    const actionLabel = isInstalling
      ? 'Installing'
      : isInstalled
        ? 'Installed'
        : 'Install';
    const actionVariant = isInstalled ? 'brand' : 'success';

    return html`
        <div role="listitem" class="apps-protocol-list-row">
          <div class="apps-protocol-list-item ${isInstalled ? 'is-installed' : ''}">
            <wa-avatar
              class="apps-protocol-avatar"
            image=${faviconUrl || ''}
            initials=${protocolInitials(entry.name)}
            label=${`${entry.name} icon`}
            shape="rounded"
          ></wa-avatar>

          <div class="apps-protocol-list-main">
            <div class="apps-protocol-list-topline">
              <div class="wa-stack wa-gap-3xs">
                <div class="apps-protocol-list-title">${entry.name}</div>
                <div class="wa-caption-s apps-protocol-list-publisher">${entry.publisher}</div>
              </div>
            </div>
          </div>

          <div class="apps-protocol-list-action">
            <wa-button
              size="small"
              variant=${actionVariant}
              ?loading=${isInstalling}
              ?disabled=${isInstalling || !this.hasActiveDid}
              @click=${() => {
                void this.onProtocolSelect(entry.protocol);
              }}
            >
              ${actionLabel}
            </wa-button>
          </div>
        </div>
      </div>
    `;
  }

  onOpenInstallProtocolDialog = () => {
    if (!this.hasActiveDid) {
      this.notify('warning', 'Select or unlock a DID before installing protocols.');
      return;
    }

    this.protocolSearch = '';

    if (this.protocolStatusDid !== this.currentDid && !this.isProtocolStateLoading) {
      void this.loadInstalledProtocols(this.currentDid);
    }

    const dialog = this.protocolDialogRef.value;
    if (!(dialog instanceof HTMLElement)) {
      return;
    }

    const focusWhenReady = () => {
      const input = this.protocolSearchInputRef.value;
      if (input instanceof HTMLElement && typeof input.focus === 'function') {
        input.focus();
      }
    };

    dialog.addEventListener('wa-after-show', focusWhenReady, { once: true });
    dialog.addEventListener('wa-show', focusWhenReady, { once: true });
    this.openDialog(dialog);
  };

  onProtocolDialogAfterHide = () => {
    this.protocolSearch = '';
  };

  /**
   * @param {Event} event
   */
  onProtocolSearchInput = (event) => {
    this.protocolSearch = readFieldValue(event.target);
  };

  /**
   * @param {string} expectedDid
   * @returns {Promise<void>}
   */
  async loadInstalledProtocols(expectedDid = this.currentDid) {
    const runtime = getIdentityRuntime();
    if (!runtime || !expectedDid) {
      return;
    }

    const requestId = this._protocolStatusRequestId + 1;
    this._protocolStatusRequestId = requestId;
    this.isProtocolStateLoading = true;
    this.protocolLoadError = '';

    try {
      const snapshot = await runtime.listInstalledProtocols();
      if (requestId !== this._protocolStatusRequestId || expectedDid !== this.currentDid) {
        return;
      }

      this.installedProtocols = new Set(snapshot.protocols);
      this.protocolStatusDid = expectedDid;
    } catch (error) {
      if (requestId !== this._protocolStatusRequestId || expectedDid !== this.currentDid) {
        return;
      }

      this.installedProtocols = new Set();
      this.protocolStatusDid = '';
      this.protocolLoadError = error instanceof Error
        ? error.message
        : String(error ?? 'Failed to load installed protocols.');
    } finally {
      if (requestId === this._protocolStatusRequestId && expectedDid === this.currentDid) {
        this.isProtocolStateLoading = false;
      }
    }
  }

  /**
   * @param {string} protocolUri
   * @returns {Promise<void>}
   */
  async onProtocolSelect(protocolUri) {
    const runtime = getIdentityRuntime();
    if (!runtime) {
      this.notify('danger', 'Identity runtime is unavailable.');
      return;
    }

    const currentDid = this.currentDid;
    if (!currentDid) {
      this.notify('warning', 'Select or unlock a DID before installing protocols.');
      return;
    }

    const selectedEntry = getProtocolCatalogEntry(protocolUri);
    if (!selectedEntry) {
      this.notify('danger', 'The selected protocol is not available in this build.');
      return;
    }

    const { plan, missingDependencies } = getProtocolInstallPlan(protocolUri);
    if (missingDependencies.length > 0) {
      this.notify(
        'danger',
        `Cannot install ${selectedEntry.name}: missing dependency definitions for ${missingDependencies.join(', ')}.`,
      );
      return;
    }

    const planUris = plan.map((entry) => entry.protocol);
    this.setInstallingProtocols(planUris, true);

    try {
      const newlyInstalled = [];

      for (const entry of plan) {
        const result = await runtime.ensureProtocolInstalled(entry.definition);

        if (currentDid !== this.currentDid) {
          return;
        }

        if (!result.alreadyInstalled) {
          newlyInstalled.push(entry.name);
        }

        this.markProtocolsInstalled([entry.protocol]);
      }

      this.protocolStatusDid = currentDid;

      if (newlyInstalled.length === 0) {
        this.notify('neutral', `${selectedEntry.name} is already installed on ${currentDid}.`);
        return;
      }

      this.notify('success', `Installed ${formatNameList(newlyInstalled)} on ${currentDid}.`);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : String(error ?? 'Unknown protocol install error.');
      this.notify('danger', `Failed to install ${selectedEntry.name}: ${message}`);
      void this.loadInstalledProtocols(currentDid);
    } finally {
      if (currentDid === this.currentDid) {
        this.setInstallingProtocols(planUris, false);
      }
    }
  }

  /**
   * @param {'neutral' | 'brand' | 'success' | 'warning' | 'danger'} tone
   * @param {string} message
   */
  notify(tone, message) {
    const toastStore = this.appStore?.toast ?? getAppStore().toast;
    toastStore.notify({
      tone,
      message,
      dedupeWindowMs : 1200,
      allowDuplicate : false,
    });
  }

  /**
   * @param {string[]} protocolUris
   */
  markProtocolsInstalled(protocolUris) {
    const nextInstalledProtocols = new Set(this.installedProtocols);
    for (const protocolUri of protocolUris) {
      const normalizedProtocolUri = String(protocolUri ?? '').trim();
      if (normalizedProtocolUri) {
        nextInstalledProtocols.add(normalizedProtocolUri);
      }
    }

    this.installedProtocols = nextInstalledProtocols;
  }

  /**
   * @param {string[]} protocolUris
   * @param {boolean} isInstalling
   */
  setInstallingProtocols(protocolUris, isInstalling) {
    const nextInstallingProtocols = new Set(this.installingProtocols);

    for (const protocolUri of protocolUris) {
      const normalizedProtocolUri = String(protocolUri ?? '').trim();
      if (!normalizedProtocolUri) {
        continue;
      }

      if (isInstalling) {
        nextInstallingProtocols.add(normalizedProtocolUri);
      } else {
        nextInstallingProtocols.delete(normalizedProtocolUri);
      }
    }

    this.installingProtocols = nextInstallingProtocols;
  }

  /**
   * @param {string} protocolUri
   * @returns {boolean}
   */
  isProtocolInstalled(protocolUri) {
    return this.installedProtocols.has(String(protocolUri ?? '').trim());
  }

  /**
   * @param {string} protocolUri
   * @returns {boolean}
   */
  isProtocolInstalling(protocolUri) {
    return this.installingProtocols.has(String(protocolUri ?? '').trim());
  }

  /**
   * @param {HTMLElement | null | undefined} dialog
   */
  openDialog(dialog) {
    if (!(dialog instanceof HTMLElement)) {
      return;
    }

    const open = /** @type {{ show?: () => Promise<void> | void }} */ (dialog).show;
    if (typeof open === 'function') {
      void open.call(dialog);
      return;
    }

    dialog.setAttribute('open', '');
  }

}

if (!customElements.get('apps-page')) {
  customElements.define('apps-page', AppsPage);
}

/**
 * @returns {IdentityRuntime | null}
 */
function getIdentityRuntime() {
  const runtime = window[identityRuntimeWindowKey];
  if (!runtime || typeof runtime !== 'object') {
    return null;
  }

  const requiredMethods = [
    'listInstalledProtocols',
    'ensureProtocolInstalled',
  ];

  for (const methodName of requiredMethods) {
    if (typeof runtime[methodName] !== 'function') {
      return null;
    }
  }

  return /** @type {IdentityRuntime} */ (runtime);
}

/**
 * @param {string} value
 * @returns {string}
 */
function protocolInitials(value) {
  const words = String(value ?? '')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);

  if (words.length === 0) {
    return 'PR';
  }

  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * @param {string[]} names
 * @returns {string}
 */
function formatNameList(names) {
  if (names.length <= 1) {
    return names[0] ?? '';
  }

  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }

  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

/**
 * @param {EventTarget | null} target
 * @returns {string}
 */
function readFieldValue(target) {
  if (!target || typeof target !== 'object' || !('value' in target)) {
    return '';
  }

  return String(target.value ?? '');
}

/**
 * @param {string} url
 * @returns {string}
 */
function appOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * @param {string} url
 * @returns {string | null}
 */
function googleFaviconUrl(url) {
  try {
    const parsed = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.hostname)}`;
  } catch {
    return null;
  }
}

/**
 * @param {string | undefined} isoDate
 * @returns {string}
 */
function formatDateTime(isoDate) {
  if (typeof isoDate !== 'string' || isoDate.trim().length === 0) {
    return 'Unknown';
  }

  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return 'Unknown';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle : 'medium',
    timeStyle : 'short',
  }).format(parsed);
}

/**
 * @param {import('../../state/app-store.js').AppConnection} app
 * @returns {Record<string, unknown>}
 */
function toAccordionItem(app) {
  return {
    id             : app.id,
    title          : app.name,
    subtitle       : `(${appOrigin(app.url)})`,
    avatarSrc      : app.iconUrl ?? googleFaviconUrl(app.url),
    avatarFallback : app.name,
    description    : app.description ?? 'No description available.',
    meta           : [
      { label: 'Connected', value: formatDateTime(app.connectedAt) },
      { label: 'Status', value: app.status ?? 'Unknown' },
      { label: 'Last activity', value: formatDateTime(app.lastActivityAt) },
    ],
    tagsLabel : 'Scopes',
    tags      : Array.isArray(app.scopes) && app.scopes.length > 0 ? app.scopes : ['No scopes listed'],
  };
}
